// Блок E — профиль и репо юзера (Ф2-часть, issue #1).
// E1 — 5 последовательных задач → все 5 следов в профиле, данные между запусками в storage.
// E2 — персональное репо юзера получило коммит по каждой задаче, секретов в коммитах нет.
// E3 — GitHub Actions (джобы пула и репо юзера) зелёные на этих прогонах.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { submitRun, waitTerminal } from '../../e2e-loop/client.mjs';
import { POOL_REPO } from '../pool.mjs';
import { productPaths, buildDist } from '../local.mjs';

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

function specFor(prompt, timeoutMs = 60_000) {
  return { engine: { name: 'fake', adapterVersion: '1' }, input: { inlinePrompt: prompt }, envAllowlist: [], limits: { timeoutMs } };
}

/** Есть ли в продукте путь записи следов профиля (profiles/<id>/...) — маркер E1. */
function profileWritePathPresent() {
  const { checkout } = productPaths();
  if (!checkout.ok) return { present: false, detail: checkout.detail };
  const srcDir = join(checkout.dir, 'src');
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        if (/profileKey\(/.test(text) && !full.endsWith(join('storage', 'keys.ts'))) hits.push(full.slice(srcDir.length + 1));
      }
    }
  };
  walk(srcDir);
  return { present: hits.length > 0, detail: hits.length > 0 ? hits.join(', ') : 'profileKey() нигде не вызывается кроме хранилища ключей — записи следов профиля нет' };
}

export default {
  id: 'E',
  title: 'профиль и репо юзера',
  cases: [
    {
      id: 'E1',
      title: '5 последовательных задач → 5 следов в профиле, между запусками в storage',
      requires: ['api-local', 'product'],
      timeoutMs: 300_000,
      async run(ctx) {
        const probe = profileWritePathPresent();
        const checks = [check('product-profile-write-path', probe.present, probe.detail)];
        if (!probe.present) {
          return {
            checks,
            metrics: { found: false },
            repro: [
              'Кейс E1: следы профильных задач не персистятся.',
              '1. В продукте trained-assist/ai-agent-runner: `grep -rn "profileKey(" src/` — вызов есть только в src/storage/keys.ts (хелпер, мёртвый код).',
              '2. RunSpec.cwd = <rootDir>/workspaces/<runId> (api/service.ts) — workspace одноразовый, между ранами не живёт.',
              '3. Ожидание эпика: каждая задача дописывает след в профильное хранилище (GCS, profiles/<profileId>/...), след доступен после следующего запуска, тела не копятся локально.',
              '4. Повтор: `node scripts/epic-stress.mjs --case E1` после реализации пути записи в продукте.',
            ].join('\n'),
            note: 'E1: блокер — в продукте нет записи следов профиля (см. issue)',
          };
        }
        // Путь записи есть — гоняем 5 задач и читаем следы из storage
        const api = await ctx.apiTarget();
        const dist = buildDist();
        if (dist.error) return { checks: [check('build', false, dist.error)], metrics: {} };
        const load = (rel) => import(pathToFileURL(join(dist.dist, rel)).href);
        const { createBlobStore } = await load('storage/create-blob-store.js');
        const { checkout } = productPaths();
        const blob = createBlobStore({ backend: 'local-fs', localRoot: join(checkout.dir, '.epic-profile-blobs') });

        const profileId = 'profile-epic';
        const marks = [];
        for (let i = 0; i < 5; i += 1) {
          const submit = await submitRun(api.base, api.key, `epic-e1-${i}-${Date.now()}`, specFor(`epic-E1 step ${i + 1}`, 60_000));
          checks.push(check(`submit-${i + 1}`, submit.status === 202, `HTTP ${submit.status}`));
          const terminal = await waitTerminal(api.base, api.key, submit.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
          checks.push(check(`succeeded-${i + 1}`, terminal.state === 'succeeded', `state=${terminal.state ?? terminal.error}`));
          marks.push({ i: i + 1, runId: submit.json.runId, state: terminal.state });
        }

        const key = `profiles/${profileId}/trace.jsonl`;
        const exists = await blob.head(key).then(() => true).catch(() => false);
        checks.push(check('profile-trace-exists', exists, key));
        let lines = [];
        if (exists) {
          const buffer = await blob.get(key);
          lines = buffer.toString('utf8').split('\n').filter(Boolean);
          checks.push(check('five-traces', lines.length >= 5, `строк: ${lines.length}`));
        }
        return {
          checks,
          metrics: { marks, traceLines: lines.length },
          runMetrics: { submitted: 5, succeeded: marks.filter((m) => m.state === 'succeeded').length, failed: marks.filter((m) => m.state === 'failed').length },
          note: `E1: ${marks.filter((m) => m.state === 'succeeded').length}/5 задач succeeded, следов в профиле: ${lines.length}`,
        };
      },
    },
    {
      id: 'E2',
      title: 'персональное репо юзера: коммит на задачу, git log читается, секретов нет',
      requires: ['api-local', 'repo', 'user-repo'],
      timeoutMs: 300_000,
      async run(ctx) {
        const fullName = String(process.env.EPIC_USER_REPO ?? '').trim();
        const checks = [];

        const api = await ctx.apiTarget();
        const marker = `epic-E2-${Date.now()}`;
        const repository = { fullName };
        const token = String(process.env.EPIC_USER_REPO_TOKEN ?? '').trim();
        if (token) repository.token = token;
        const body = {
          ...specFor(`epic-E2: зафиксировать след в репо (marker=${marker})`, 120_000),
          repository,
        };
        const submit = await submitRun(api.base, api.key, `epic-e2-${Date.now()}`, body);
        checks.push(check('accepted', submit.status === 202, `HTTP ${submit.status}: ${(submit.text ?? '').slice(0, 200)}`));
        const terminal = submit.status === 202 ? await waitTerminal(api.base, api.key, submit.json.runId, 120_000).catch((err) => ({ state: null, error: err.message })) : {};
        checks.push(check('succeeded', terminal.state === 'succeeded', `state=${terminal.state ?? terminal.error}`));

        const remote = spawnSync('git', ['ls-remote', `https://github.com/${fullName}.git`, 'refs/heads/main'], { encoding: 'utf8' });
        checks.push(check('remote-reachable', remote.status === 0, (remote.stderr ?? '').slice(0, 200)));

        const work = spawnSync('mktemp', ['-d'], { encoding: 'utf8' }).stdout.trim();
        spawnSync('git', ['clone', '--depth', '20', `https://github.com/${fullName}.git`, join(work, 'clone')], { encoding: 'utf8' });
        const log = spawnSync('git', ['log', '--oneline', '-20'], { encoding: 'utf8', cwd: join(work, 'clone') });
        const commits = (log.stdout ?? '').trim().split('\n').filter(Boolean);
        checks.push(check('commit-present', commits.some((line) => line.includes(marker)), commits.slice(0, 5).join(' / ')));
        checks.push(check('commit-not-duplicated', commits.filter((line) => line.includes(marker)).length === 1, `совпадений: ${commits.filter((line) => line.includes(marker)).length}`));
        const { scanForSecrets } = await import('../metrics.mjs');
        const diff = spawnSync('git', ['show', '--stat', '--format=%H %s', 'HEAD'], { encoding: 'utf8', cwd: join(work, 'clone') });
        const findings = scanForSecrets(`${diff.stdout ?? ''}\n${commits.join('\n')}`, 'user-repo-commit');
        checks.push(check('no-secrets-in-commits', findings.length === 0, findings.map((f) => f.pattern).join(', ') || 'чисто'));

        return {
          checks,
          metrics: { repo: fullName, commits: commits.length, marker },
          runMetrics: { submitted: 1, succeeded: terminal.state === 'succeeded' ? 1 : 0 },
          note: `E2: ${fullName} — коммит с marker ${commits.some((l) => l.includes(marker)) ? 'есть' : 'НЕТ'}, секретов ${findings.length}`,
        };
      },
    },
    {
      id: 'E3',
      title: 'GitHub Actions пула и репо юзера зелёные на этих прогонах',
      requires: ['gha'],
      timeoutMs: 120_000,
      async run() {
        const checks = [];
        const { execFileSync } = await import('node:child_process');
        const listRuns = (repo) => {
          try {
            const out = execFileSync('gh', ['run', 'list', '-R', repo, '--limit', '20', '--json', 'conclusion,status,name,event'], {
              encoding: 'utf8',
              timeout: 30_000,
            });
            return JSON.parse(out);
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        };
        const poolRuns = listRuns(POOL_REPO);
        if (Array.isArray(poolRuns)) {
          const finished = poolRuns.filter((r) => r.status === 'completed' && r.conclusion !== null);
          const green = finished.filter((r) => r.conclusion === 'success');
          checks.push(check('pool-runs-finished', finished.length > 0, `завершено: ${finished.length}`));
          checks.push(check('pool-runs-green', finished.length === 0 || green.length === finished.length, `зелёные ${green.length}/${finished.length}: ${finished.filter((r) => r.conclusion !== 'success').map((r) => `${r.name}=${r.conclusion}`).join(', ')}`));
        } else {
          checks.push(check('pool-runs-listed', false, JSON.stringify(poolRuns).slice(0, 300)));
        }
        const userRepo = String(process.env.EPIC_USER_REPO ?? '').trim();
        if (userRepo.includes('/')) {
          const userRuns = listRuns(userRepo);
          if (Array.isArray(userRuns)) {
            const finished = userRuns.filter((r) => r.status === 'completed' && r.conclusion !== null);
            const green = finished.filter((r) => r.conclusion === 'success');
            checks.push(check('user-repo-runs-green', finished.length === 0 || green.length === finished.length, `зелёные ${green.length}/${finished.length}`));
          }
        }
        return { checks, metrics: { poolRuns: Array.isArray(poolRuns) ? poolRuns.length : 0, userRepo: userRepo || null } };
      },
    },
  ],
};
