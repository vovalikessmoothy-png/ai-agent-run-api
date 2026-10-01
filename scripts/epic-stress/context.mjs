// context.mjs — общий контекст для кейсов Ф3: цель API (LOCAL-эфемерный сервер или REMOTE),
// доступные возможности (capabilities), пул, сохранение отчёта.
// Правило: отсутствие зависимости = SKIP с причиной, а не тихий пропуск и не падение процесса.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunTarget } from '../driver-mode-and-product-paths.mjs';
import {
  DEFAULT_REPORT_PATH,
  addNote,
  createReport,
  ensureBlock,
  loadReport,
  recordCase,
  saveReport,
} from './report.mjs';
import { poolConfig } from './pool.mjs';
import { productPaths, startServer } from './local.mjs';

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ghAvailable() {
  if (!hasBinary('gh')) return false;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function envPresence(env = process.env) {
  return {
    POOL_TRIGGER_TOKEN: Boolean(String(env.POOL_TRIGGER_TOKEN ?? '').trim()),
    POOL_TRIGGER_URL: Boolean(String(env.POOL_TRIGGER_URL ?? '').trim()),
    RUNNER_API_URL: Boolean(String(env.RUNNER_API_URL ?? '').trim()),
    RUNNER_API_KEY: Boolean(String(env.RUNNER_API_KEY ?? '').trim()),
    LLM_LADDER_TOKEN: Boolean(String(env.LLM_LADDER_TOKEN ?? '').trim()),
    ghCli: ghAvailable(),
    opencodeBinary: hasBinary('opencode'),
  };
}

/**
 * Возможности прогона. Каждая — { ok, reason }.
 *  api        — есть любая цель API (LOCAL-сервер поднимается сам, REMOTE — из env)
 *  api-local  — нужен именно эфемерный свой сервер (kill/restart/fault)
 *  api-remote — нужен удалённый API (путь, которым ходит receiver пула)
 *  pool       — /pool/trigger доступен (POOL_TRIGGER_TOKEN)
 *  gha        — gh CLI видит ai-agent-runs-pool (наблюдение за receiver-джобой)
 *  opencode   — бесплатный opencode через ladder free-ladder
 *  product    — чекаут продукта с typescript для tsc-сборки
 *  linux      — /proc и т.п. (прогоны только на Linux)
 */
export function capabilities(env = process.env) {
  const runTarget = resolveRunTarget();
  const pool = poolConfig(env);
  const ghOk = ghAvailable();
  const ladderOk = Boolean(String(env.LLM_LADDER_TOKEN ?? '').trim());
  const opencodeOk = ladderOk && hasBinary('opencode');
  const { checkout } = productPaths();
  const repoContextOk = existsSync(join(checkout.dir, 'src', 'runner', 'repository.ts'));
  const vmReboot = String(env.EPIC_VM_REBOOT ?? '') === '1';
  return {
    runTarget,
    pool,
    has: {
      'api-local': {
        ok: runTarget.mode !== 'remote',
        reason: runTarget.mode === 'remote' ? 'REMOTE-режим задан (RUNNER_API_URL + RUNNER_API_KEY)' : 'ok',
      },
      'api-remote': { ok: runTarget.mode === 'remote', reason: runTarget.mode === 'remote' ? 'ok' : 'RUNNER_API_URL / RUNNER_API_KEY не заданы' },
      api: { ok: true, reason: 'ok' },
      pool: { ok: pool.configured, reason: pool.configured ? 'ok' : 'POOL_TRIGGER_TOKEN не задан' },
      gha: { ok: ghOk, reason: ghOk ? 'ok' : 'gh CLI недоступен / не залогинен' },
      opencode: { ok: opencodeOk, reason: opencodeOk ? 'ok' : 'нужны LLM_LADDER_TOKEN и бинарь opencode' },
      product: { ok: checkout.ok, reason: checkout.ok ? 'ok' : checkout.detail },
      repo: {
        ok: repoContextOk,
        reason: repoContextOk ? 'ok' : 'в продукте нет src/runner/repository.ts (ai-agent-runner PR #22 не смержен)',
      },
      vm: {
        ok: vmReboot && process.platform === 'linux',
        reason: vmReboot ? `platform=${process.platform}` : 'рестарт VM выключен — включается EPIC_VM_REBOOT=1 (нужен root на песочной VM)',
      },
      linux: { ok: process.platform === 'linux', reason: process.platform === 'linux' ? 'ok' : `platform=${process.platform}` },
    },
  };
}

export function missingFor(requireList, caps) {
  return (requireList ?? []).filter((name) => {
    const cap = caps.has[name];
    if (!cap) throw new Error(`unknown capability: ${name}`);
    return !cap.ok;
  });
}

/** Создать контекст прогона: ленивый API-клиент, ленивый эфемерный сервер, сохранение отчёта. */
export function createContext(options = {}) {
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const caps = capabilities();
  const merged = options.merge ? loadReport(reportPath) : null;
  const report = merged ?? createReport({ mode: caps.runTarget.mode, env: envPresence() });
  report.mode = caps.runTarget.mode;

  const state = { server: null, dist: null };

  function persist() {
    saveReport(report, reportPath);
  }

  async function ensureServer(serverOptions = {}) {
    if (state.server && !serverOptions.fresh) return state.server;
    if (state.server) {
      await state.server.stop();
      state.server = null;
    }
    const started = await startServer({ dist: state.dist ?? undefined, ...serverOptions });
    if (started.error) throw new Error(started.error);
    state.server = started;
    state.dist = started.dist;
    return started;
  }

  async function stopServer() {
    if (!state.server) return;
    await state.server.stop();
    state.server = null;
  }

  /** Цель API для кейса: LOCAL → эфемерный сервер; REMOTE → RUNNER_API_URL. */
  async function apiTarget(serverOptions = {}) {
    if (caps.runTarget.mode === 'remote') {
      return { base: caps.runTarget.base, key: caps.runTarget.key, mode: 'remote', local: null };
    }
    const server = await ensureServer(serverOptions);
    return { base: server.base, key: server.key, mode: 'local', local: server };
  }

  function reproFor(kase) {
    return [
      `Кейс ${kase.id}: ${kase.title}`,
      `Повторить: \`node scripts/epic-stress.mjs --case ${kase.id}\` (добавить \`--merge\`, чтобы дописать в существующий отчёт)`,
      'Отчёт: `epic-stress-report.json` → blocks.<block>.cases[].checks / metrics',
      'Секреты не нужны: прогоны читают env (см. блок env в отчёте), значения никуда не логируются.',
    ].join('\n');
  }

  return {
    report,
    reportPath,
    caps,
    env: process.env,
    persist,
    ensureServer,
    stopServer,
    apiTarget,
    server: () => state.server,
    reproFor,
    note: (text) => addNote(report, text),
    runCase: async (block, kase, executor) => {
      const blockRecord = ensureBlock(report, block.id, block.title);
      const startedAt = new Date().toISOString();
      const started = Date.now();
      let missing = [];
      try {
        missing = missingFor(kase.requires, caps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordCase(report, blockRecord, {
          id: kase.id,
          title: kase.title,
          status: 'FAIL',
          ms: Date.now() - started,
          checks: [{ name: 'capability-known', ok: false, detail: message }],
          metrics: {},
          error: message,
          repro: reproFor(kase),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        persist();
        console.error(`FAIL ${kase.id} — ${message}`);
        return { status: 'FAIL', error: message };
      }
      if (missing.length > 0) {
        const reasons = missing.map((name) => `${name}: ${caps.has[name].reason}`).join('; ');
        recordCase(report, blockRecord, {
          id: kase.id,
          title: kase.title,
          status: 'SKIP',
          ms: null,
          checks: [],
          metrics: {},
          missing,
          error: `нет зависимостей — ${reasons}`,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        persist();
        console.log(`SKIP ${kase.id} — ${reasons}`);
        return { status: 'SKIP', reasons };
      }
      try {
        const outcome =
          (await Promise.race([
            executor(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`кейс не уложился в ${kase.timeoutMs ?? 300_000} мс`)), kase.timeoutMs ?? 300_000)),
          ])) ?? {};
        const checks = outcome.checks ?? [];
        const failed = checks.filter((c) => !c.ok);
        const record = {
          id: kase.id,
          title: kase.title,
          status: failed.length === 0 ? 'PASS' : 'FAIL',
          ms: Date.now() - started,
          checks,
          metrics: outcome.metrics ?? {},
          ...(outcome.timings ? { timings: outcome.timings } : {}),
          ...(outcome.runMetrics ? { runMetrics: outcome.runMetrics } : {}),
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(failed.length > 0 ? { repro: outcome.repro ?? reproFor(kase), ...(outcome.issue ? { issue: outcome.issue } : {}) } : {}),
        };
        recordCase(report, blockRecord, record);
        if (outcome.note) addNote(report, outcome.note);
        persist();
        console.log(`${record.status} ${kase.id} (${record.ms} мс)${failed.length ? ` — упали: ${failed.map((c) => c.name).join(', ')}` : ''}`);
        return record;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordCase(report, blockRecord, {
          id: kase.id,
          title: kase.title,
          status: 'FAIL',
          ms: Date.now() - started,
          checks: [{ name: 'no-uncaught-error', ok: false, detail: message.slice(0, 500) }],
          metrics: {},
          error: message.slice(0, 2000),
          repro: reproFor(kase),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        persist();
        console.error(`FAIL ${kase.id} — ${message}`);
        return { status: 'FAIL', error: message };
      }
    },
  };
}
