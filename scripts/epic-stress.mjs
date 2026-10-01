#!/usr/bin/env node
// epic-stress.mjs — драйвер стресс-тестов эпика (issue #1): location-роутинг + надёжность.
// Паттерн scripts/stress-probe.mjs: --dry-run печатает режим/возможности/план, прогон пишет
// JSON-отчёт (epic-stress-report.json) инкрементально после каждого кейса, --merge дописывает.
//
//   node scripts/epic-stress.mjs --dry-run
//   node scripts/epic-stress.mjs --block A
//   node scripts/epic-stress.mjs --case D3 --merge
//   node scripts/epic-stress.mjs --all --json epic-stress-report.json
//   node scripts/epic-stress.mjs --summary            # markdown для комментария в issue
//
// Блоки: A happy path/идемпотентность · B сбои бесплатного движка · C транспорт/хранение
//        D контракт location · E профиль и репо юзера · F нагрузка/массовость
import { capabilities, createContext, envPresence } from './epic-stress/context.mjs';
import { DEFAULT_REPORT_PATH, loadReport, saveReport, summaryMarkdown } from './epic-stress/report.mjs';
import blockA from './epic-stress/blocks/block-a.mjs';
import blockB from './epic-stress/blocks/block-b.mjs';
import blockC from './epic-stress/blocks/block-c.mjs';
import blockD from './epic-stress/blocks/block-d.mjs';
import blockE from './epic-stress/blocks/block-e.mjs';
import blockF from './epic-stress/blocks/block-f.mjs';

const BLOCKS = [blockA, blockB, blockC, blockD, blockE, blockF];

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function selectCases() {
  // --block принимает список через запятую (например "A,B,C"), --case — один кейс
  const blockFilter = String(argValue('--block') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const caseFilter = argValue('--case');
  const selected = [];
  for (const block of BLOCKS) {
    if (blockFilter.length > 0 && !blockFilter.includes(block.id)) continue;
    for (const kase of block.cases) {
      if (caseFilter && kase.id !== caseFilter.toUpperCase()) continue;
      selected.push({ block, kase });
    }
  }
  return selected;
}

function dryRun() {
  const caps = capabilities();
  const lines = [];
  lines.push('epic-stress — dry-run');
  lines.push(`  mode:     ${caps.runTarget.mode}${caps.runTarget.mode === 'remote' ? ' (RUNNER_API_URL + RUNNER_API_KEY заданы)' : ' (эфемерный локальный сервер)'}`);
  lines.push(`  env:      ${Object.entries(envPresence())
    .map(([name, ok]) => `${name}=${ok ? 'set' : 'missing'}`)
    .join('  ')}`);
  lines.push('  capabilities:');
  for (const [name, cap] of Object.entries(caps.has)) lines.push(`    ${name.padEnd(11)} ${cap.ok ? 'ok  ' : 'SKIP'} ${cap.ok ? '' : `— ${cap.reason}`}`);
  lines.push('  план:');
  let lastBlock = null;
  for (const { block, kase } of selectCases()) {
    if (block.id !== lastBlock) {
      lines.push(`    ${block.id}. ${block.title}`);
      lastBlock = block.id;
    }
    const missing = (kase.requires ?? []).filter((name) => !caps.has[name]?.ok);
    const status = missing.length > 0 ? `SKIP — нет: ${missing.join(', ')}` : 'run';
    lines.push(`      ${kase.id} ${kase.title}`);
    lines.push(`         requires: ${(kase.requires ?? []).join(', ') || '—'} → ${status}`);
  }
  console.log(lines.join('\n'));
}

function printList() {
  for (const block of BLOCKS) {
    console.log(`${block.id} — ${block.title}`);
    for (const kase of block.cases) console.log(`   ${kase.id}  ${kase.title}  [requires: ${(kase.requires ?? []).join(', ') || '—'}]`);
  }
}

async function main() {
  const reportPath = argValue('--json', DEFAULT_REPORT_PATH);
  const merge = process.argv.includes('--merge');
  const summaryOnly = process.argv.includes('--summary');

  if (process.argv.includes('--list')) {
    printList();
    return 0;
  }
  if (process.argv.includes('--dry-run')) {
    dryRun();
    return 0;
  }

  const selected = selectCases();
  if (selected.length === 0) {
    console.error('нет кейсов по фильтру (см. --list)');
    return 2;
  }

  if (summaryOnly) {
    const existing = loadReport(reportPath);
    if (!existing) {
      console.error(`отчёт ${reportPath} не найден`);
      return 2;
    }
    process.stdout.write(summaryMarkdown(existing));
    return 0;
  }

  const ctx = createContext({ reportPath, merge });
  console.log(`epic-stress: mode=${ctx.caps.runTarget.mode}, отчёт=${reportPath}, кейсов=${selected.length}`);

  for (const { block, kase } of selected) {
    await ctx.runCase(block, kase, () => kase.run(ctx));
    ctx.persist();
  }

  await ctx.stopServer();
  ctx.report.finishedAt = new Date().toISOString();
  saveReport(ctx.report, reportPath);

  const c = ctx.report.metrics.cases;
  console.log(`\nитог: ${c.pass} PASS / ${c.fail} FAIL / ${c.skip} SKIP (отчёт: ${reportPath})`);
  if (ctx.report.problems.length > 0) {
    console.log('проблемы:');
    for (const p of ctx.report.problems) console.log(`  - ${p.case} ${p.title}`);
  }
  return c.fail > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
