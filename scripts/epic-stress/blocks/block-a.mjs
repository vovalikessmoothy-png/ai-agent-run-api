// Блок A — happy path и идемпотентность (Ф3, issue #1).
// A1 идёт через весь конвейер пула, A2/A3 — напрямую в Serverless API.
import { collectAllEvents, getResult, getStatus, submitRun, waitTerminal } from '../../e2e-loop/client.mjs';
import { poolTrigger, waitForReceiverRun, receiverLog, parseReceiverLog } from '../pool.mjs';
import { scanForSecrets, timingsFromEvents } from '../metrics.mjs';

function specFor(prompt, options = {}) {
  return {
    engine: options.engine ?? { name: 'fake', adapterVersion: '1' },
    input: { inlinePrompt: prompt },
    envAllowlist: [],
    limits: { timeoutMs: options.timeoutMs ?? 60_000 },
  };
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

export default {
  id: 'A',
  title: 'happy path и идемпотентность',
  cases: [
    {
      id: 'A1',
      title: 'одиночный запуск location="" через весь конвейер пула',
      requires: ['pool', 'gha', 'api-remote'],
      timeoutMs: 420_000,
      async run(ctx) {
        const task = `epic-A1 ${new Date().toISOString()}: сквозной прогон без доменной логики — выполнить задачу и вернуть результат.`;
        const t0 = Date.now();
        const trigger = await poolTrigger(ctx.caps.pool, { task, location: '' });
        const checks = [
          check('pool-202', trigger.status === 202, `HTTP ${trigger.status}`),
          check('pool-queued', trigger.json?.queued === true, JSON.stringify(trigger.json ?? trigger.error ?? {})),
        ];

        const receiver = await waitForReceiverRun({ sinceMs: t0, timeoutMs: 300_000 });
        checks.push(check('receiver-found', Boolean(receiver), receiver ? `run ${receiver.databaseId} ${receiver.status}` : 'за 300 с не появился'));
        checks.push(check('receiver-completed', receiver?.status === 'completed', receiver ? `status=${receiver.status} conclusion=${receiver.conclusion}` : 'n/a'));

        let parsed = { runId: null };
        let receiverLogText = '';
        if (receiver?.databaseId) {
          receiverLogText = await receiverLog(receiver.databaseId).catch(() => '');
          parsed = parseReceiverLog(receiverLogText);
          checks.push(check('receiver-submitted-run', Boolean(parsed.runId), `runId=${parsed.runId} submitHttp=${parsed.submitHttp}`));
          const secrets = scanForSecrets(receiverLogText, 'receiver-log');
          checks.push(check('no-secrets-in-receiver-log', secrets.length === 0, secrets.map((s) => `${s.pattern}@${s.where}`).join(', ') || 'чисто'));
        }

        const api = ctx.caps.runTarget;
        const timings = {};
        if (parsed.runId) {
          const terminal = await waitTerminal(api.base, api.key, parsed.runId, 240_000).catch((err) => ({ error: err.message }));
          checks.push(check('run-terminal', Boolean(terminal?.state), `state=${terminal?.state ?? terminal?.error}`));
          checks.push(check('run-succeeded', terminal?.state === 'succeeded', `state=${terminal?.state}`));
          const events = await collectAllEvents(api.base, api.key, parsed.runId).catch(() => []);
          const marks = timingsFromEvents(events, Date.parse(receiver.createdAt));
          Object.assign(timings, marks);
          const result = await getResult(api.base, api.key, parsed.runId).catch(() => ({ status: 0 }));
          checks.push(check('result-200', result.status === 200, `HTTP ${result.status}`));
          checks.push(check('result-outcome', result.json?.outcome === 'succeeded', `outcome=${result.json?.outcome}`));
        }

        return {
          checks,
          timings,
          metrics: {
            poolTriggerMs: trigger.ms,
            receiverAgeMs: receiver?.ageMs ?? null,
            ...timings,
          },
          runMetrics: { submitted: parsed.runId ? 1 : 0, succeeded: terminalState(terminal) === 'succeeded' ? 1 : 0, failed: terminalState(terminal) === 'failed' ? 1 : 0 },
          note: parsed.runId ? `A1: pool → receiver → run ${parsed.runId} (${terminalState(terminal)})` : 'A1: конвейер не дошёл до run',
        };
      },
    },
    {
      id: 'A2',
      title: 'повторный submit с тем же idempotency-key → один запуск, второй = dedup',
      requires: ['api'],
      timeoutMs: 120_000,
      async run(ctx) {
        const api = await ctx.apiTarget();
        const key = `epic-a2-${Date.now()}`;
        const body = specFor('epic-A2: idempotency');
        const submitAtMs = Date.now();
        const first = await submitRun(api.base, api.key, key, body);
        const second = await submitRun(api.base, api.key, key, body);
        const checks = [
          check('first-202', first.status === 202, `HTTP ${first.status}`),
          check('second-200', second.status === 200, `HTTP ${second.status}`),
          check('second-deduplicated', second.json?.deduplicated === true, JSON.stringify(second.json ?? {})),
          check('same-run-id', first.json?.runId === second.json?.runId, `${first.json?.runId} vs ${second.json?.runId}`),
        ];
        let terminal = null;
        if (first.json?.runId) {
          terminal = await waitTerminal(api.base, api.key, first.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
          checks.push(check('run-succeeded', terminal.state === 'succeeded', `state=${terminal.state ?? terminal.error}`));
        }
        const events = await (first.json?.runId ? collectAllEvents(api.base, api.key, first.json.runId).catch(() => []) : []);
        const startedCount = events.filter((e) => e.type === 'started').length;
        checks.push(check('engine-started-once', startedCount === 1, `started events: ${startedCount}`));
        const eventTimings = timingsFromEvents(events, submitAtMs);
        return {
          checks,
          timings: eventTimings,
          metrics: eventTimings,
          runMetrics: { submitted: 1, succeeded: terminal?.state === 'succeeded' ? 1 : 0, deduplicated: second.json?.deduplicated ? 1 : 0 },
          note: `A2: dedup ${second.json?.deduplicated === true ? 'сработал' : 'НЕ сработал'} (key один, started=${startedCount})`,
        };
      },
    },
    {
      id: 'A3',
      title: 'две разные задачи параллельно → изолированы (артефакты/профиль)',
      requires: ['api-local'],
      timeoutMs: 120_000,
      async run(ctx) {
        const api = await ctx.apiTarget();
        const markerA = `epic-A3-alpha-${Date.now()}`;
        const markerB = `epic-A3-beta-${Date.now()}`;
        const [a, b] = await Promise.all([
          submitRun(api.base, api.key, `epic-a3-a-${Date.now()}`, specFor(markerA, { timeoutMs: 60_000 })),
          submitRun(api.base, api.key, `epic-a3-b-${Date.now()}`, specFor(markerB, { timeoutMs: 60_000 })),
        ]);
        const checks = [
          check('both-accepted', a.status === 202 && b.status === 202, `A=${a.status} B=${b.status}`),
          check('distinct-run-ids', Boolean(a.json?.runId) && Boolean(b.json?.runId) && a.json.runId !== b.json.runId, `${a.json?.runId} vs ${b.json?.runId}`),
        ];
        const [ta, tb] = await Promise.all([
          waitTerminal(api.base, api.key, a.json.runId, 60_000).catch((err) => ({ state: null, error: err.message })),
          waitTerminal(api.base, api.key, b.json.runId, 60_000).catch((err) => ({ state: null, error: err.message })),
        ]);
        checks.push(check('both-succeeded', ta.state === 'succeeded' && tb.state === 'succeeded', `A=${ta.state ?? ta.error} B=${tb.state ?? tb.error}`));

        // изоляция workspace: каждый ран живёт в workspaces/<runId>, чужие файлы не видны
        const rootDir = api.local?.rootDir;
        const { existsSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        if (rootDir) {
          const dirA = join(rootDir, 'workspaces', a.json.runId);
          const dirB = join(rootDir, 'workspaces', b.json.runId);
          checks.push(check('workspaces-distinct', dirA !== dirB && existsSync(dirA) && existsSync(dirB), `${dirA} / ${dirB}`));
          const ranA = existsSync(join(dirA, 'ran.txt')) ? readFileSync(join(dirA, 'ran.txt'), 'utf8') : null;
          const ranB = existsSync(join(dirB, 'ran.txt')) ? readFileSync(join(dirB, 'ran.txt'), 'utf8') : null;
          checks.push(check('both-wrote-own-artifact', ranA !== null && ranB !== null, `A=${ranA} B=${ranB}`));
          checks.push(check('no-cross-write', ranA === 'ok' && ranB === 'ok', `A=${ranA} B=${ranB}`));
        }

        return {
          checks,
          metrics: { runA: a.json?.runId, runB: b.json?.runId },
          runMetrics: { submitted: 2, succeeded: [ta.state, tb.state].filter((s) => s === 'succeeded').length, failed: [ta.state, tb.state].filter((s) => s === 'failed').length },
        };
      },
    },
  ],
};

function terminalState(terminal) {
  return terminal?.state ?? null;
}
