// report.mjs — структура JSON-отчёта стресс-тестов эпика (issue #1, Ф3).
// Паттерн тот же, что у scripts/stress-probe.mjs: инкрементальное сохранение после каждого
// кейса + --merge к уже существующему отчёту. Секреты в отчёт не попадают: значения
// токенов не сериализуются вообще, фиксируются только имена env-переменных и их наличие.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_REPORT_PATH = 'epic-stress-report.json';

export function createReport(options) {
  return {
    epic: 'location-routing-and-stress',
    issue: '#1',
    schema: 1,
    mode: options.mode,
    startedAt: new Date().toISOString(),
    blocks: {},
    metrics: {
      cases: { total: 0, pass: 0, fail: 0, skip: 0 },
      runs: { submitted: 0, succeeded: 0, failed: 0, deduplicated: 0 },
      timings: {},
      retries: 0,
      rateLimitEvents: 0,
      artifactSha256: [],
      repoCommits: [],
    },
    problems: [],
    notes: [],
    env: options.env,
  };
}

export function loadReport(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.schema === 1) return parsed;
  } catch {
    /* битый отчёт пересоздаём заново */
  }
  return null;
}

export function saveReport(report, path) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

export function ensureBlock(report, id, title) {
  if (!report.blocks[id]) report.blocks[id] = { id, title, cases: [] };
  return report.blocks[id];
}

export function recordCase(report, block, record) {
  const existing = block.cases.findIndex((c) => c.id === record.id);
  if (existing >= 0) block.cases[existing] = record;
  else block.cases.push(record);
  recount(report);
  rebuildProblems(report);
}

/** Проблемы всегда пересчитываются из текущих статусов: PASS поверх старого FAIL убирает проблему. */
export function rebuildProblems(report) {
  report.problems = Object.values(report.blocks)
    .flatMap((b) => b.cases)
    .filter((c) => c.status === 'FAIL')
    .map((c) => ({ case: c.id, title: c.title, repro: c.repro ?? '', ...(c.issue ? { issue: c.issue } : {}) }));
}

function pushNumber(target, key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  (target[key] ?? (target[key] = [])).push(Math.round(value));
}

/**
 * Полный пересчёт сводных метрик из записей кейсов — идемпотентен при --merge:
 * повторный прогон того же кейса не удваивает тайминги и счётчики ранов.
 */
export function recount(report) {
  const cases = Object.values(report.blocks).flatMap((b) => b.cases);
  report.metrics.cases = {
    total: cases.length,
    pass: cases.filter((c) => c.status === 'PASS').length,
    fail: cases.filter((c) => c.status === 'FAIL').length,
    skip: cases.filter((c) => c.status === 'SKIP').length,
  };

  const timings = {};
  const runs = { submitted: 0, succeeded: 0, failed: 0, deduplicated: 0 };
  let retries = 0;
  let rateLimitEvents = 0;
  const artifactSha256 = new Set();
  const repoCommits = new Set();

  for (const kase of cases) {
    pushNumber(timings, 'caseDurationMs', kase.ms);
    for (const [key, value] of Object.entries(kase.timings ?? {})) pushNumber(timings, key, value);
    for (const [key, value] of Object.entries(kase.metrics ?? {})) {
      if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')) {
        for (const v of value) pushNumber(timings, key, v);
      }
    }
    const rm = kase.runMetrics;
    if (!rm) continue;
    runs.submitted += rm.submitted ?? 0;
    runs.succeeded += rm.succeeded ?? 0;
    runs.failed += rm.failed ?? 0;
    runs.deduplicated += rm.deduplicated ?? 0;
    retries += rm.retries ?? 0;
    rateLimitEvents += rm.rateLimitEvents ?? 0;
    for (const sha of rm.artifactSha256 ?? []) artifactSha256.add(sha);
    for (const sha of rm.repoCommits ?? []) repoCommits.add(sha);
  }

  report.metrics.timings = timings;
  report.metrics.runs = runs;
  report.metrics.retries = retries;
  report.metrics.rateLimitEvents = rateLimitEvents;
  report.metrics.artifactSha256 = [...artifactSha256];
  report.metrics.repoCommits = [...repoCommits];
}

export function addNote(report, note) {
  if (!report.notes.includes(note)) report.notes.push(note);
}

export function successRate(report) {
  const submitted = report.metrics.runs.submitted;
  if (submitted === 0) return null;
  return report.metrics.runs.succeeded / submitted;
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function timingStats(report) {
  const out = {};
  for (const [key, values] of Object.entries(report.metrics.timings)) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    out[key] = { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
  }
  return out;
}

/** Markdown-сводка для комментария в issue #1 (итоговый отчёт метрик). */
export function summaryMarkdown(report) {
  const lines = [];
  const stats = timingStats(report);
  lines.push(`### Отчёт «${report.epic}» — ${report.mode}-режим`);
  lines.push('');
  lines.push(`Начат: ${report.startedAt}${report.finishedAt ? ` · закончен: ${report.finishedAt}` : ''}`);
  lines.push('');
  lines.push('| Кейсы | PASS | FAIL | SKIP | Успешность ранов | Ретраи | Rate-limit |');
  lines.push('|---|---|---|---|---|---|---|');
  const c = report.metrics.cases;
  lines.push(`| ${c.total} | ${c.pass} | ${c.fail} | ${c.skip} | ${pct(successRate(report))} | ${report.metrics.retries} | ${report.metrics.rateLimitEvents} |`);
  lines.push('');
  lines.push('#### Метрики (мс)');
  lines.push('| Метрика | n | p50 | max |');
  lines.push('|---|---|---|---|');
  const keys = Object.keys(stats);
  if (keys.length === 0) lines.push('| — | — | — | — |');
  for (const key of keys) lines.push(`| ${key} | ${stats[key].n} | ${stats[key].p50} | ${stats[key].max} |`);
  lines.push('');
  lines.push('#### Кейсы');
  lines.push('| ID | Статус | мс | Проверки |');
  lines.push('|---|---|---|---|');
  for (const block of Object.values(report.blocks)) {
    for (const kase of block.cases) {
      const failed = kase.checks.filter((ch) => !ch.ok).map((ch) => ch.name);
      const detail = failed.length > 0 ? `упали: ${failed.join(', ')}` : `${kase.checks.length} ок`;
      lines.push(`| ${kase.id} | ${kase.status} | ${kase.ms ?? '—'} | ${detail} |`);
    }
  }
  lines.push('');
  if (report.problems.length > 0) {
    lines.push('#### Найденные проблемы');
    for (const p of report.problems) lines.push(`- **${p.case}** ${p.title}${p.issue ? ` → ${p.issue}` : ' → issue не создан'}`);
    lines.push('');
  }
  if (report.metrics.artifactSha256.length > 0) {
    lines.push(`Артефакты (sha256): ${report.metrics.artifactSha256.slice(0, 10).join(', ')}${report.metrics.artifactSha256.length > 10 ? ' …' : ''}`);
    lines.push('');
  }
  if (report.metrics.repoCommits.length > 0) {
    lines.push(`Коммиты в репо юзера: ${report.metrics.repoCommits.slice(0, 10).join(', ')}`);
    lines.push('');
  }
  if (report.notes.length > 0) {
    lines.push('#### Заметки');
    for (const note of report.notes) lines.push(`- ${note}`);
  }
  return `${lines.join('\n')}\n`;
}
