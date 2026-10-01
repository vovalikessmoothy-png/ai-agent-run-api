// Блок F — нагрузка/массовость (Ф3, issue #1).
// F1 — 10 dispatch подряд → все обработаны, очередь не теряет, дедуп не срабатывает ложно.
// F2 — рестарт песочной VM посреди F1 → принятые задачи переживают (durable), без rerun.
import { getStatus, submitRun, waitTerminal } from '../../e2e-loop/client.mjs';
import { poolTrigger, waitForReceiverCount, receiverLog, parseReceiverLog } from '../pool.mjs';

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

export default {
  id: 'F',
  title: 'нагрузка/массовость',
  cases: [
    {
      id: 'F1',
      title: '10 dispatch подряд → все обработаны, очередь не теряет, дедуп не ложный',
      requires: ['pool', 'gha', 'api-remote'],
      timeoutMs: 720_000,
      async run(ctx) {
        const count = Number(process.env.EPIC_F1_COUNT ?? 10);
        const t0 = Date.now();
        // короткое окно: все 10 уходят почти одновременно
        const triggers = await Promise.all(
          Array.from({ length: count }, (_, i) => poolTrigger(ctx.caps.pool, { task: `epic-F1 #${i + 1} ${new Date().toISOString()} — батчевая задача без доменной логики.`, location: '' })),
        );
        const accepted = triggers.filter((t) => t.status === 202);
        const checks = [check('all-accepted', accepted.length === count, `202: ${accepted.length}/${count}; статусы: ${triggers.map((t) => t.status).join(',')}`)];

        const runs = await waitForReceiverCount(count, { sinceMs: t0, timeoutMs: 600_000 });
        checks.push(check('all-receiver-runs', runs.length >= count, `receiver-джоб: ${runs.length}/${count}`));

        const runIds = [];
        const parseErrors = [];
        for (const run of runs.slice(0, count)) {
          const logText = await receiverLog(run.databaseId).catch(() => '');
          const parsed = parseReceiverLog(logText);
          if (parsed.runId) runIds.push(parsed.runId);
          else parseErrors.push({ run: run.databaseId, conclusion: run.conclusion });
        }
        checks.push(check('every-task-got-run', runIds.length >= count, `runId найден у ${runIds.length}/${count}; без run: ${JSON.stringify(parseErrors)}`));
        checks.push(check('no-false-dedup', new Set(runIds).size === runIds.length, `уникальных runId: ${new Set(runIds).size} из ${runIds.length}`));
        checks.push(check('receiver-jobs-green', runs.slice(0, count).every((r) => r.conclusion === 'success'), runs.filter((r) => r.conclusion !== 'success').map((r) => `${r.databaseId}=${r.conclusion}`).join(', ') || 'все success'));

        const api = ctx.caps.runTarget;
        const states = [];
        for (const runId of runIds) {
          const terminal = await waitTerminal(api.base, api.key, runId, 300_000).catch((err) => ({ state: null, error: err.message }));
          states.push({ runId, state: terminal.state ?? terminal.error });
        }
        const succeeded = states.filter((s) => s.state === 'succeeded').length;
        checks.push(check('all-terminal-succeeded', succeeded === states.length, `succeeded ${succeeded}/${states.length}: ${states.filter((s) => s.state !== 'succeeded').map((s) => `${s.runId}=${s.state}`).join(', ')}`));

        // очередь не теряет: статус каждого читается и после завершения батча
        let readable = 0;
        for (const runId of runIds) {
          const status = await getStatus(api.base, api.key, runId).catch(() => null);
          if (status?.status === 200) readable += 1;
        }
        checks.push(check('all-status-readable', readable === runIds.length, `${readable}/${runIds.length}`));

        return {
          checks,
          timings: { dispatchToAllAcceptedMs: Date.now() - t0 },
          metrics: { dispatchMs: Math.max(...triggers.map((t) => t.ms)), totalMs: Date.now() - t0, runIds },
          runMetrics: { submitted: runIds.length, succeeded, failed: states.length - succeeded },
          note: `F1: ${count} dispatch → ${runs.length} receiver-джоб → ${runIds.length} run, succeeded ${succeeded}/${states.length}`,
        };
      },
    },
    {
      id: 'F2',
      title: 'рестарт песочной VM посреди F1 → принятые задачи переживают, rerun не происходит',
      requires: ['pool', 'gha', 'api-remote', 'vm'],
      timeoutMs: 900_000,
      async run(ctx) {
        const count = Number(process.env.EPIC_F2_COUNT ?? 6);
        const t0 = Date.now();
        const triggers = await Promise.all(
          Array.from({ length: count }, (_, i) => poolTrigger(ctx.caps.pool, { task: `epic-F2 #${i + 1} ${new Date().toISOString()} — задача до/после рестарта VM.`, location: '' })),
        );
        const checks = [check('all-accepted', triggers.filter((t) => t.status === 202).length === count, triggers.map((t) => t.status).join(','))];
        // ждём принятия части батча, затем рестартуем VM (требует root — EPIC_VM_REBOOT=1)
        const half = await waitForReceiverCount(Math.ceil(count / 2), { sinceMs: t0, timeoutMs: 300_000, acceptRunning: true });
        checks.push(check('half-accepted-before-reboot', half.length >= Math.ceil(count / 2), `принято до рестарта: ${half.length}`));

        const { execFileSync } = await import('node:child_process');
        let reboot = { ok: false, detail: 'EPIC_VM_REBOOT не задан' };
        if (String(process.env.EPIC_VM_REBOOT ?? '') === '1') {
          try {
            execFileSync('sudo', ['-n', 'systemctl', 'reboot'], { timeout: 15_000, stdio: 'ignore' });
            reboot = { ok: true, detail: 'systemctl reboot отправлен' };
          } catch (err) {
            reboot = { ok: false, detail: err instanceof Error ? err.message : String(err) };
          }
        }
        checks.push(check('vm-rebooted', reboot.ok, reboot.detail));
        if (!reboot.ok) return { checks, metrics: { count }, note: 'F2: VM не перезагружен — кейс неполон' };

        // ждём подъёма API и дочитывания принятого
        const api = ctx.caps.runTarget;
        let upAt = null;
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          const health = await fetch(`${api.base}/healthz`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
          if (health?.ok) {
            upAt = Date.now();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        checks.push(check('vm-api-back', upAt !== null, upAt ? `через ${Math.round((upAt - t0) / 1000)} с от старта` : 'API не поднялся за 300 с'));

        const all = await waitForReceiverCount(count, { sinceMs: t0, timeoutMs: 600_000 });
        const runIds = [];
        for (const run of all.slice(0, count)) {
          const parsed = parseReceiverLog(await receiverLog(run.databaseId).catch(() => ''));
          if (parsed.runId) runIds.push(parsed.runId);
        }
        checks.push(check('accepted-tasks-survived', runIds.length >= count, `runId после рестарта: ${runIds.length}/${count}`));
        checks.push(check('no-rerun', new Set(runIds).size === runIds.length, `уникальных runId: ${new Set(runIds).size} из ${runIds.length}`));

        const states = [];
        for (const runId of runIds) {
          const terminal = await waitTerminal(api.base, api.key, runId, 300_000).catch((err) => ({ state: null, error: err.message }));
          states.push({ runId, state: terminal.state ?? terminal.error });
        }
        checks.push(check('durable-completed', states.every((s) => s.state === 'succeeded'), states.map((s) => `${s.runId}=${s.state}`).join(', ')));

        return {
          checks,
          metrics: { count, rebootToApiMs: upAt ? upAt - t0 : null, totalMs: Date.now() - t0, runIds },
          runMetrics: { submitted: runIds.length, succeeded: states.filter((s) => s.state === 'succeeded').length, failed: states.filter((s) => s.state === 'failed').length },
          note: `F2: ${count} задач, рестарт VM, после подъёма ${states.filter((s) => s.state === 'succeeded').length}/${states.length} succeeded, rerun=${new Set(runIds).size !== runIds.length}`,
        };
      },
    },
  ],
};
