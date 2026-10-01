// Блок B — сбои бесплатного движка (главный риск, issue #1).
// B1 — медленный/висящий движок → структурированный failure и лимит времени шага.
// B2 — серия бесплатных opencode-запросов коротким окном → порог rate-limit и реакция.
// B3 — обрыв mid-run: connection_lost ≠ failed + восстановление по durable store.
// B4 — fake-nonzero | fake-timeout | fake-crash → структурированный outcome, задача не теряется.
import { spawn } from 'node:child_process';
import { collectAllEvents, getResult, getStatus, submitRun, waitTerminal } from '../../e2e-loop/client.mjs';
import { control, startServer } from '../local.mjs';
import { timingsFromEvents } from '../metrics.mjs';

function specFor(engine, prompt, timeoutMs) {
  return {
    engine: { name: engine, adapterVersion: '1' },
    input: { inlinePrompt: prompt },
    envAllowlist: [],
    limits: { timeoutMs },
  };
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

/** Прямой (мимо runner'а) запуск бесплатного opencode: -m ladder/free-ladder, никаких платных моделей. */
function opencodeOnce(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('opencode', ['run', '--auto', '-m', 'ladder/free-ladder', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const guard = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, ms: Date.now() - started, out });
    });
  });
}

const RATE_LIMIT_RE = /429|rate.?limit|too many requests|quota|FreeTier|throttl/i;

export default {
  id: 'B',
  title: 'сбои бесплатного движка',
  cases: [
    {
      id: 'B1',
      title: 'медленный движок → retry/structured failure, джоба не зависает',
      requires: ['api-local'],
      timeoutMs: 90_000,
      async run(ctx) {
        const api = await ctx.apiTarget();
        const timeoutMs = 3_000;
        const started = Date.now();
        const submit = await submitRun(api.base, api.key, `epic-b1-${Date.now()}`, specFor('fake-slow', JSON.stringify({ sleepMs: 120_000 }), timeoutMs));
        const checks = [check('accepted', submit.status === 202, `HTTP ${submit.status}`)];
        const terminal = await waitTerminal(api.base, api.key, submit.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
        const elapsed = Date.now() - started;
        checks.push(check('terminal-reached', Boolean(terminal.state), `state=${terminal.state ?? terminal.error}`));
        checks.push(check('structured-failure', terminal.state === 'failed', `state=${terminal.state}`));
        checks.push(check('step-time-limit', elapsed < timeoutMs + 30_000, `${elapsed} мс при timeoutMs=${timeoutMs}`));
        const result = await getResult(api.base, api.key, submit.json.runId).catch(() => ({ status: 0 }));
        checks.push(check('failure-code-present', Boolean(result.json?.failure?.code), `code=${result.json?.failure?.code}`));
        checks.push(check('failure-retryable-flagged', typeof result.json?.failure?.retryable === 'boolean', `retryable=${result.json?.failure?.retryable}`));
        checks.push(check('failure-class', Boolean(result.json?.failure?.failureClass), `class=${result.json?.failure?.failureClass}`));
        const events = await collectAllEvents(api.base, api.key, submit.json.runId).catch(() => []);
        checks.push(check('failed-event-present', events.some((e) => e.type === 'failed'), `events=${events.map((e) => e.type).join(',')}`));
        return {
          checks,
          metrics: { elapsedMs: elapsed, failureCode: result.json?.failure?.code ?? null },
          runMetrics: { submitted: 1, failed: terminal.state === 'failed' ? 1 : 0 },
        };
      },
    },
    {
      id: 'B2',
      title: 'серия 6–8 бесплатных opencode подряд → порог rate-limit и реакция',
      requires: ['opencode'],
      timeoutMs: 600_000,
      async run(ctx) {
        const burst = Number(process.env.EPIC_B2_BURST ?? 7);
        const prompt = 'Reply with exactly one word: pong';
        const results = await Promise.all(Array.from({ length: burst }, () => opencodeOnce(prompt, 180_000)));
        const rateLimited = results.filter((r) => RATE_LIMIT_RE.test(r.out ?? ''));
        const ok = results.filter((r) => r.code === 0).length;
        const checks = [
          check('burst-completed', results.length === burst, `${results.length}/${burst}`),
          check('at-least-half-succeeded', ok >= Math.ceil(burst / 2), `ok=${ok}/${burst}`),
          check('no-paid-model-used', !/deepseek-v4|gpt-5|claude-|opus/i.test(results.map((r) => r.out).join('\n')), 'модели вне free-ladder не вызывались'),
        ];
        const summary = results.map((r, i) => ({ i: i + 1, exit: r.code, ms: r.ms, rateLimit: RATE_LIMIT_RE.test(r.out ?? '') }));
        return {
          checks,
          metrics: { burst, ok, rateLimited: rateLimited.length, runs: summary.map((s) => s.ms) },
          runMetrics: { submitted: burst, succeeded: ok, failed: burst - ok, rateLimitEvents: rateLimited.length },
          note: `B2: burst=${burst}, ok=${ok}, rate-limit сигналов=${rateLimited.length}; порог фиксируется по первой серии с 429`,
        };
      },
    },
    {
      id: 'B3',
      title: 'обрыв mid-run: connection_lost ≠ failed + durable recovery (смерть → status)',
      requires: ['api-local', 'linux'],
      timeoutMs: 180_000,
      async run(ctx) {
        const checks = [];

        // ── B3a: heartbeat-обрыв → событие connection_lost, состояние НЕ failed
        const server = await ctx.ensureServer();
        const api = { base: server.base, key: server.key };
        const ctl = control(server);
        await ctl.injectFault('heartbeat', { kind: 'connection_lost' });
        const submit = await submitRun(api.base, api.key, `epic-b3a-${Date.now()}`, specFor('fake-slow', JSON.stringify({ sleepMs: 5_000 }), 60_000));
        checks.push(check('accepted', submit.status === 202, `HTTP ${submit.status}`));
        const terminal = await waitTerminal(api.base, api.key, submit.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
        const events = await collectAllEvents(api.base, api.key, submit.json.runId).catch(() => []);
        const lost = events.filter((e) => e.type === 'connection_lost');
        checks.push(check('connection-lost-event', lost.length > 0, `connection_lost events: ${lost.length}`));
        checks.push(check('not-failed-after-connection-lost', terminal.state !== 'failed', `state=${terminal.state ?? terminal.error}`));
        checks.push(check('run-still-reaches-terminal', Boolean(terminal.state), `state=${terminal.state}`));
        await ctl.clearFaults();

        // ── B3b: смерть сервера → данные читаются с durable store, сравнение с ~120–150 мс
        const hang = await submitRun(api.base, api.key, `epic-b3b-${Date.now()}`, specFor('fake-timeout', 'hang across server death', 120_000));
        const running = await new Promise((resolve) => {
          const deadline = Date.now() + 20_000;
          const tick = async () => {
            const s = await getStatus(api.base, api.key, hang.json.runId).catch(() => null);
            if (s?.status === 200 && s.json.state === 'running') return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(tick, 40);
          };
          tick();
        });
        checks.push(check('run-running-before-kill', running === true, `state poll: ${running}`));

        const tKill = Date.now();
        await server.kill();
        const tKilled = Date.now();
        const restarted = await startServer({ dist: server.dist, rootDir: server.rootDir });
        const tUp = Date.now();
        checks.push(check('server-restarted', !restarted.error, restarted.error ?? `port ${restarted.port}`));

        let tStatus = null;
        let status = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const r = await getStatus(restarted.base, restarted.key, hang.json.runId).catch(() => null);
          if (r?.status === 200) {
            status = r.json;
            tStatus = Date.now();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        checks.push(check('status-readable-after-death', tStatus !== null, tStatus ? `${tStatus - tKill} мс после смерти` : 'не читается за 10 с'));
        checks.push(check('state-not-failed-after-death', status?.state !== 'failed', `state=${status?.state}`));
        checks.push(check('connection-lost-flag-after-death', status?.connectionLost === true, `connectionLost=${status?.connectionLost}`));

        // уборка: гасим висящий ран и сервер
        const { postCancel } = await import('../../e2e-loop/client.mjs');
        await postCancel(restarted.base, restarted.key, hang.json.runId, {}).catch(() => {});
        await restarted.stop();

        const recoveryMs = tStatus ? tStatus - tKill : null;
        return {
          checks,
          timings: { killToStatusReadableMs: recoveryMs, killToServerUpMs: tUp - tKill },
          metrics: {
            killToProcessDeadMs: tKilled - tKill,
            killToServerUpMs: tUp - tKill,
            killToStatusReadableMs: recoveryMs,
            recordedBaselineMs: [120, 150],
          },
          runMetrics: { submitted: 2, succeeded: terminal.state === 'succeeded' ? 1 : 0, failed: terminal.state === 'failed' ? 1 : 0 },
          note:
            recoveryMs === null
              ? 'B3: status после смерти не прочитан'
              : `B3: смерть → status через ${recoveryMs} мс (базовый замер 120–150 мс)`,
        };
      },
    },
    {
      id: 'B4',
      title: 'fake-nonzero | fake-timeout | fake-crash → структурированный outcome, задача не теряется',
      requires: ['api'],
      timeoutMs: 180_000,
      async run(ctx) {
        const api = await ctx.apiTarget();
        const scenarios = [
          { engine: 'fake-nonzero', expectExit: 'nonzero_exit' },
          { engine: 'fake-timeout', expectExit: 'timeout' },
          { engine: 'fake-crash', expectExit: 'crash' },
        ];
        const checks = [];
        const outcomes = [];
        for (const scenario of scenarios) {
          const submit = await submitRun(api.base, api.key, `epic-b4-${scenario.engine}-${Date.now()}`, specFor(scenario.engine, 'b4', 30_000));
          checks.push(check(`${scenario.engine}-accepted`, submit.status === 202, `HTTP ${submit.status}`));
          if (submit.status !== 202) continue;
          const terminal = await waitTerminal(api.base, api.key, submit.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
          const result = await getResult(api.base, api.key, submit.json.runId).catch(() => ({ status: 0 }));
          const events = await collectAllEvents(api.base, api.key, submit.json.runId).catch(() => []);
          checks.push(check(`${scenario.engine}-terminal`, Boolean(terminal.state), `state=${terminal.state ?? terminal.error}`));
          checks.push(check(`${scenario.engine}-failed-state`, terminal.state === 'failed', `state=${terminal.state}`));
          checks.push(check(`${scenario.engine}-exit-reason`, result.json?.exitReason === scenario.expectExit, `exitReason=${result.json?.exitReason} ожидался ${scenario.expectExit}`));
          checks.push(check(`${scenario.engine}-failure-structured`, Boolean(result.json?.failure?.code && result.json?.failure?.failureClass), JSON.stringify(result.json?.failure ?? {})));
          checks.push(check(`${scenario.engine}-not-lost`, events.some((e) => ['failed', 'succeeded', 'cancelled'].includes(e.type)), `events=${events.map((e) => e.type).join(',')}`));
          outcomes.push({ engine: scenario.engine, state: terminal.state, exitReason: result.json?.exitReason, code: result.json?.failure?.code });
        }
        const timings = {};
        return {
          checks,
          metrics: { outcomes, ...timings },
          runMetrics: { submitted: scenarios.length, failed: outcomes.filter((o) => o.state === 'failed').length },
          note: `B4: ${outcomes.map((o) => `${o.engine}=${o.state}/${o.exitReason}/${o.code}`).join(', ')}`,
        };
      },
    },
  ],
};
