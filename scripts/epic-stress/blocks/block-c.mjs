// Блок C — транспорт и хранение (Ф3, issue #1).
// C1 — dispatch → receiver без секретов, task обрезан в логах (логи пула публичные).
// C2 — артефакт 1 МБ+ уходит мимо API (storage-direct) → ссылка → скачивание → sha256 сходится.
// C3 — обрыв до хранилища при финализации → понятный статус, повтор безопасен.
// C4 — обрыв при push в репо → структурированный failure + ретрай, commit не дублируется.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectAllEvents, getStatus, submitRun, waitTerminal } from '../../e2e-loop/client.mjs';
import { poolTrigger, waitForReceiverRun, receiverLog, parseReceiverLog } from '../pool.mjs';
import { scanForSecrets } from '../metrics.mjs';
import { control, productPaths, startServer } from '../local.mjs';

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

function specFor(engine, prompt, timeoutMs = 60_000) {
  return { engine: { name: engine, adapterVersion: '1' }, input: { inlinePrompt: prompt }, envAllowlist: [], limits: { timeoutMs } };
}

const SENTINEL = 'EPIC_C1_TAIL_SENTINEL_must_not_appear_in_public_log';

export default {
  id: 'C',
  title: 'транспорт и хранение',
  cases: [
    {
      id: 'C1',
      title: 'dispatch → receiver: payload без secrets, task обрезан в логах',
      requires: ['pool', 'gha'],
      timeoutMs: 360_000,
      async run(ctx) {
        // task из 900 символов: первые 500 печатаются, хвост с сентинелом — нет
        const head = `epic-C1 ${new Date().toISOString()} `.padEnd(600, 'a');
        const task = `${head}${SENTINEL}`;
        const t0 = Date.now();
        const trigger = await poolTrigger(ctx.caps.pool, { task, location: '' });
        const checks = [check('pool-202', trigger.status === 202, `HTTP ${trigger.status}`)];
        const receiver = await waitForReceiverRun({ sinceMs: t0, timeoutMs: 300_000 });
        checks.push(check('receiver-found', Boolean(receiver), receiver ? `run ${receiver.databaseId}` : 'не появился за 300 с'));
        let logText = '';
        let parsed = {};
        if (receiver?.databaseId) {
          logText = await receiverLog(receiver.databaseId).catch(() => '');
          parsed = parseReceiverLog(logText);
          checks.push(check('task-length-declared', parsed.taskDeclaredLen === task.length, `declared=${parsed.taskDeclaredLen} actual=${task.length}`));
          checks.push(check('task-tail-truncated', !logText.includes(SENTINEL), 'хвост task не должен попадать в публичный лог'));
          checks.push(check('task-head-present', logText.includes('task ('), 'первая часть task печатается (диагностика)'));
          const secrets = scanForSecrets(logText, 'receiver-log');
          checks.push(check('no-secrets-in-log', secrets.length === 0, secrets.map((s) => s.pattern).join(', ') || 'чисто'));
          checks.push(check('artifactref-not-full', !/X-Goog-Signature=|X-Amz-Signature=/.test(logText), 'presigned-подписи в лог не попадают'));
        }
        return {
          checks,
          metrics: { taskLen: task.length, loggedChars: parsed.taskLoggedLen ?? null, poolTriggerMs: trigger.ms },
          note: `C1: task ${task.length} символов, в логе ${parsed.taskLoggedLen ?? 'n/a'} символов строки-заголовка`,
        };
      },
    },
    {
      id: 'C2',
      title: 'артефакт 1 МБ+ мимо API → share-link → скачивание → sha256 сходится',
      requires: ['product'],
      timeoutMs: 120_000,
      async run() {
        const { checkout, buildConfig } = productPaths();
        const checks = [];
        if (!checkout.ok || !buildConfig || !existsSync(join(buildConfig.dist, 'storage', 'artifact-store.js'))) {
          return { checks: [check('product-dist', false, checkout.ok ? 'dist не собран' : checkout.detail)], metrics: {} };
        }
        const load = (rel) => import(pathToFileURL(join(buildConfig.dist, rel)).href);
        const { ArtifactStore } = await load('storage/artifact-store.js');
        const { createBlobStore } = await load('storage/create-blob-store.js');
        const { ShareTokenIssuer, createShareLink } = await load('storage/share.js');
        const { KeyRegistry } = await load('api/auth.js');
        const { handleArtifactRequest } = await load('api/artifact-route.js');

        const workDir = join(tmpdir(), `epic-c2-${randomBytes(6).toString('hex')}`);
        mkdirSync(workDir, { recursive: true });
        const blob = createBlobStore({ backend: 'local-fs', localRoot: join(workDir, 'blobs') });
        const artifacts = new ArtifactStore({ rootDir: join(workDir, 'data'), blob });
        const tokens = new ShareTokenIssuer({ ttlSeconds: 600, secret: randomBytes(32).toString('hex') });
        const keysPath = join(workDir, 'keys.json');
        const apiKey = `ak_${randomBytes(24).toString('hex')}`;
        writeFileSync(
          keysPath,
          JSON.stringify({
            schemaVersion: 1,
            principals: [{ keyHash: createHash('sha256').update(apiKey, 'utf8').digest('hex'), principalId: 'c2', profileId: 'profile-epic', scopes: ['runs:read', 'runs:write'] }],
          }),
        );
        const keys = KeyRegistry.loadFile(keysPath);

        // загрузка 1.2 МБ напрямую в storage (правило «ГБ мимо апи» — через API не ходим)
        const size = 1_200_000;
        const bytes = randomBytes(size);
        const manifest = await artifacts.put({
          runId: 'run.c2',
          userTaskId: 'epic-C2',
          profileId: 'profile-epic',
          name: 'big.bin',
          mime: 'application/octet-stream',
          bytes,
        });
        checks.push(check('stored-1mb-plus', manifest.size === size, `size=${manifest.size}`));
        checks.push(check('manifest-sha', manifest.sha256 === createHash('sha256').update(bytes).digest('hex'), manifest.sha256));

        const server = createServer((req, res) => {
          void handleArtifactRequest(req, res, { artifacts, keys, tokens, logger: () => {} })
            .then((status) => {
              if (status === null && !res.headersSent) res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
            })
            .catch((err) => {
              if (res.headersSent) return;
              const status = typeof err?.status === 'number' ? err.status : 500;
              res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(err?.body?.() ?? { error: String(err?.message ?? err) }));
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;
        const link = await createShareLink({ blob, tokens, baseUrl }, manifest);

        // скачивание по ссылке — БЕЗ заголовка Authorization (только token в URL)
        const response = await fetch(link.url);
        const downloaded = Buffer.from(await response.arrayBuffer());
        checks.push(check('share-link-token', /[?&]t=/.test(link.url), 'token в URL, не Bearer'));
        checks.push(check('download-200', response.status === 200, `HTTP ${response.status}`));
        checks.push(check('sha256-matches', createHash('sha256').update(downloaded).digest('hex') === manifest.sha256, `${downloaded.length} байт`));
        checks.push(check('size-matches', downloaded.length === size, `${downloaded.length}`));

        // без токена доступ закрыт (Bearer-ключ не подставляем — проверяем именно token-режим)
        const anonymous = await fetch(`${baseUrl}/v1/artifacts/${manifest.artifactId}`);
        checks.push(check('no-token-denied', anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status}`));

        server.close();
        rmSync(workDir, { recursive: true, force: true });
        return {
          checks,
          metrics: { artifactBytes: size, artifactSha256: manifest.sha256, backend: blob.backend },
          note: `C2: ${size} байт загружены в storage напрямую, share-link скачал ${downloaded.length} байт, sha256 совпал`,
        };
      },
    },
    {
      id: 'C3',
      title: 'обрыв до хранилища при финализации → понятный статус, повтор безопасен',
      requires: ['api-local'],
      timeoutMs: 180_000,
      async run(ctx) {
        const server = await ctx.ensureServer({ fresh: true });
        const api = { base: server.base, key: server.key };
        const ctl = control(server);
        await ctl.injectFault('finalization', { kind: 'throw', once: true });
        const submit = await submitRun(api.base, api.key, `epic-c3-${Date.now()}`, specFor('fake', 'c3 finalization fault', 60_000));
        const checks = [check('accepted', submit.status === 202, `HTTP ${submit.status}`)];

        // ждём состояние finalizing (экспорт упал, ран не терминален и не потерян)
        let stuck = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const s = await getStatus(api.base, api.key, submit.json.runId).catch(() => null);
          if (s?.status === 200 && s.json.state === 'finalizing') {
            stuck = s.json;
            break;
          }
          if (s?.status === 200 && ['succeeded', 'failed', 'cancelled'].includes(s.json.state)) {
            stuck = s.json;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        checks.push(check('status-understandable', stuck?.state === 'finalizing', `state=${stuck?.state ?? 'not readable'}`));
        checks.push(check('not-lost', Boolean(stuck), 'ран виден после сбоя финализации'));

        // повтор: рестарт сервера → recover() дочитывает finalizing (идемпотентный экспорт).
        // keepData: durable store обязан пережить рестарт — удалять rootDir нельзя.
        await server.stop({ keepData: true });
        const restarted = await startServer({ dist: server.dist, rootDir: server.rootDir });
        checks.push(check('server-restarted', !restarted.error, restarted.error ?? `port ${restarted.port}`));
        const final = await waitTerminal(restarted.base, restarted.key, submit.json.runId, 60_000).catch((err) => ({ state: null, error: err.message }));
        checks.push(check('retried-to-terminal', Boolean(final.state), `state=${final.state ?? final.error}`));
        checks.push(check('retry-succeeded', final.state === 'succeeded', `state=${final.state}`));

        const resultPath = join(restarted.rootDir, 'runs', submit.json.runId, 'result.json');
        checks.push(check('single-result-file', existsSync(resultPath), resultPath));
        const events = await collectAllEvents(restarted.base, restarted.key, submit.json.runId).catch(() => []);
        const terminalEvents = events.filter((e) => ['succeeded', 'failed', 'cancelled'].includes(e.type));
        checks.push(check('single-terminal-event', terminalEvents.length === 1, `terminal events: ${terminalEvents.length}`));

        await restarted.stop();
        return {
          checks,
          metrics: { finalState: final.state, terminalEvents: terminalEvents.length },
          runMetrics: { submitted: 1, succeeded: final.state === 'succeeded' ? 1 : 0 },
          note: `C3: финализация упала → state=finalizing, после рестарта → ${final.state}, терминальных событий ${terminalEvents.length}`,
        };
      },
    },
    {
      id: 'C4',
      title: 'обрыв при push в репо → структурированный failure + ретрай, commit не дублируется',
      requires: ['api-local', 'linux'],
      timeoutMs: 180_000,
      async run(ctx) {
        const workDir = join(tmpdir(), `epic-c4-${randomBytes(6).toString('hex')}`);
        mkdirSync(workDir, { recursive: true });
        // «GitHub» = локальный bare-репозиторий; первый push ломаем (remote временно недоступен)
        const bare = join(workDir, 'remote.git');
        const marker = `epic-C4-${Date.now()}`;
        const { spawnSync } = await import('node:child_process');
        const git = (...args) => spawnSync('git', args, { encoding: 'utf8', cwd: workDir });
        git('init', '--bare', '--initial-branch=main', bare);

        const server = await ctx.ensureServer({ fresh: true });
        const api = { base: server.base, key: server.key };
        const gitBin = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || 'git';
        const prompt = JSON.stringify({ remote: bare, marker, failFirstPush: true, git: gitBin });
        const body = {
          engine: { name: 'repo-push', adapterVersion: '1' },
          input: { inlinePrompt: prompt },
          envAllowlist: ['PATH'],
          limits: { timeoutMs: 120_000 },
        };
        const submit = await submitRun(api.base, api.key, `epic-c4-${Date.now()}`, body);
        const checks = [check('accepted', submit.status === 202, `HTTP ${submit.status}`)];
        const terminal = await waitTerminal(api.base, api.key, submit.json.runId, 120_000).catch((err) => ({ state: null, error: err.message }));
        checks.push(check('terminal', Boolean(terminal.state), `state=${terminal.state ?? terminal.error}`));
        checks.push(check('structured-failure-then-success', terminal.state === 'succeeded', `state=${terminal.state} (движок должен пережить первый сбой push)`));

        const events = await collectAllEvents(api.base, api.key, submit.json.runId).catch(() => []);
        const logs = events.filter((e) => e.type === 'log').map((e) => e.payload?.message ?? '');
        checks.push(check('push-failure-structured', logs.some((l) => /REPO_PUSH_FAILED/.test(l)), `логи: ${logs.filter((l) => /REPO_PUSH/.test(l)).slice(0, 3).join(' | ')}`));
        checks.push(check('push-retried', logs.some((l) => /REPO_PUSH_OK/.test(l)), 'успешный push после ретрая'));

        const remoteLog = spawnSync('git', ['--git-dir', bare, 'log', '--oneline', '--all'], { encoding: 'utf8' });
        const commits = (remoteLog.stdout ?? '').trim().split('\n').filter(Boolean);
        checks.push(check('commit-arrived', commits.some((line) => line.includes(marker)), `remote log: ${commits.slice(0, 5).join(' / ')}`));
        checks.push(check('commit-not-duplicated', commits.filter((line) => line.includes(marker)).length === 1, `совпадений marker: ${commits.filter((line) => line.includes(marker)).length}`));
        const secretScan = scanForSecrets(remoteLog.stdout ?? '', 'remote-git-log');
        checks.push(check('no-secrets-in-commit', secretScan.length === 0, secretScan.map((s) => s.pattern).join(', ') || 'чисто'));

        await server.stop();
        rmSync(workDir, { recursive: true, force: true });
        return {
          checks,
          metrics: { commits: commits.length, terminal: terminal.state },
          runMetrics: { submitted: 1, succeeded: terminal.state === 'succeeded' ? 1 : 0, failed: terminal.state === 'failed' ? 1 : 0 },
          note: `C4: ${commits.filter((line) => line.includes(marker)).length} коммит(ов) с marker в remote после сбоя первого push`,
        };
      },
    },
  ],
};
