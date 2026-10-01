// repo-push.mjs — движок кейса C4 (эпик issue #1): коммит в репо + push с имитацией обрыва.
// Ожидаемый inlinePrompt: { remote, marker, failFirstPush?, git? }
// Лог-сигналы: REPO_PUSH_FAILED (первый push упал — структурированный сбой),
//              REPO_PUSH_OK (ретрай прошёл), REPO_COMMIT <sha> (коммит создан ровно один раз).
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

let prompt = {};
try {
  const meta = JSON.parse(process.argv[2] ?? '{}');
  prompt = typeof meta.inlinePrompt === 'string' ? JSON.parse(meta.inlinePrompt) : {};
} catch {
  prompt = {};
}

const gitBin = typeof prompt.git === 'string' && prompt.git ? prompt.git : 'git';
const remote = typeof prompt.remote === 'string' ? prompt.remote : null;
const marker = typeof prompt.marker === 'string' && prompt.marker ? prompt.marker : `epic-${Date.now()}`;
const failFirstPush = prompt.failFirstPush !== false;

if (!remote) {
  console.error('repo-push: prompt.remote (путь к bare-репозиторию) обязателен');
  process.exit(1);
}

function git(args, options = {}) {
  const result = spawnSync(gitBin, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin', HOME: process.env.HOME ?? '/tmp', GIT_TERMINAL_PROMPT: '0' },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

const author = ['-c', 'user.name=epic-stress', '-c', 'user.email=epic-stress@local'];

if (!existsSync('.git')) {
  const init = git(['init', '-q', '-b', 'main']);
  if (init.status !== 0) {
    console.error(`REPO_PUSH_FAILED reason=init ${init.stderr.slice(0, 200)}`);
    process.exit(1);
  }
}

writeFileSync('trace.txt', `marker=${marker}\nat=${new Date().toISOString()}\n`);
git(['add', 'trace.txt']);
const commit = git([...author, 'commit', '-q', '-m', `epic C4 ${marker}`]);
if (commit.status !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
  console.error(`REPO_PUSH_FAILED reason=commit ${commit.stderr.slice(0, 200)}`);
  process.exit(1);
}
const sha = git(['rev-parse', 'HEAD']).stdout.trim();
console.log(`REPO_COMMIT ${sha}`);

// имитация потери сети до GitHub: первый push уходит в несуществующий remote
if (failFirstPush) {
  git(['remote', 'remove', 'origin']);
  git(['remote', 'add', 'origin', `${remote}.unreachable`]);
  const broken = git(['push', '-q', 'origin', 'main']);
  if (broken.status === 0) {
    console.log('REPO_PUSH_OK attempt=1 (сбой не воспроизвёлся — remote оказался доступен)');
  } else {
    console.log(`REPO_PUSH_FAILED attempt=1 transport=${(broken.stderr || broken.error?.code || 'unknown').toString().slice(0, 160)}`);
  }
}

// ретрай против рабочего remote — тот же коммит, второй commit не создаётся
git(['remote', 'set-url', 'origin', remote]);
const retry = git(['push', '-q', 'origin', 'main']);
if (retry.status !== 0) {
  console.log(`REPO_PUSH_FAILED attempt=2 ${retry.stderr.slice(0, 200)}`);
  process.exit(1);
}
console.log(`REPO_PUSH_OK attempt=${failFirstPush ? 2 : 1} sha=${sha}`);
process.exit(0);
