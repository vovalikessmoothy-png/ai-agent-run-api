// pool.mjs — клиент «нашего пула»: POST /pool/trigger у llm-ladder → repository_dispatch
// в vovalikessmoothy-png/ai-agent-runs-pool → receiver-джоба → submit в Serverless API.
// Контракт location (Ф1): "" | ru | eu | us; кривое значение → 400 с именем поля.
// Токен передаётся только заголовком Authorization; в отчёты и логи не выводится.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// парсер лога receiver-джобы живёт в metrics.mjs (общий с прочими разборами логов)
export { parseReceiverLog } from './metrics.mjs';

export const POOL_REPO = 'vovalikessmoothy-png/ai-agent-runs-pool';
export const LOCATION_VALUES = ['', 'ru', 'eu', 'us'];

export function poolConfig(env = process.env) {
  const url = String(env.POOL_TRIGGER_URL ?? 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
  const token = String(env.POOL_TRIGGER_TOKEN ?? '').trim();
  return { url, token, configured: token.length > 0 };
}

export async function poolHealth(config) {
  const response = await fetch(`${config.url}/pool/health`, { signal: AbortSignal.timeout(10_000) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

/**
 * Триггер задачи в пул. body: { task, location?, repo?, profile?, artifactRef? }.
 * Возвращает { status, json, ms } — тело ответа не содержит секретов (контракт лестницы).
 */
export async function poolTrigger(config, body, options = {}) {
  if (!config.configured) return { status: 0, json: null, error: 'POOL_TRIGGER_TOKEN not set', ms: 0 };
  const started = Date.now();
  try {
    const response = await fetch(`${config.url}/pool/trigger`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

/** Проверка строки ошибки валидации: 400 + имя поля location. */
export function isFieldValidationError(response, field = 'location') {
  if (response.status !== 400) return false;
  const body = `${response.text ?? ''}${JSON.stringify(response.json ?? {})}`;
  return new RegExp(`\\b${field}\\b`, 'i').test(body);
}

async function gh(args, options = {}) {
  const { stdout } = await run('gh', args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
    env: process.env,
  });
  return stdout;
}

/** Список свежих receiver-джоб (repository_dispatch) начиная с timestamp. */
export async function listReceiverRuns(options = {}) {
  const sinceMs = options.sinceMs ?? Date.now() - 5_000;
  const out = await gh([
    'run',
    'list',
    '-R',
    POOL_REPO,
    '--workflow',
    options.workflow ?? 'agent-task.yml',
    '--limit',
    String(options.limit ?? 30),
    '--json',
    'databaseId,status,conclusion,event,createdAt,displayTitle,url',
  ]).catch(() => '[]');
  let runs = [];
  try {
    runs = JSON.parse(out);
  } catch {
    runs = [];
  }
  return runs.filter((r) => Date.parse(r.createdAt) >= sinceMs && r.event === 'repository_dispatch');
}

/**
 * Наблюдение за receiver-джобой: ждём запуск workflow в пуле, запущенный ПОСЛЕ timestamp.
 * Возвращает запуск workflow (или null по таймауту).
 */
export async function waitForReceiverRun(options = {}) {
  const sinceMs = options.sinceMs ?? Date.now() - 5_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const fresh = await listReceiverRuns({ sinceMs, workflow: options.workflow, limit: options.limit });
    last = fresh[0] ?? last;
    if (last && (last.status === 'completed' || options.acceptRunning)) {
      return { ...last, ageMs: Date.now() - sinceMs };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last ? { ...last, timedOut: true } : null;
}

/** Ждём, пока ПОЛУЧИТСЯ ровно count свежих receiver-джоб (для батчей Ф1/F-блока). */
export async function waitForReceiverCount(count, options = {}) {
  const sinceMs = options.sinceMs ?? Date.now() - 5_000;
  const deadline = Date.now() + (options.timeoutMs ?? 420_000);
  const pollMs = options.pollMs ?? 10_000;
  let found = [];
  while (Date.now() < deadline) {
    found = await listReceiverRuns({ sinceMs, limit: 50 });
    if (found.length >= count && found.every((r) => r.status === 'completed' || options.acceptRunning)) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return found;
}

/** Полный лог receiver-джобы (для C1: обрезка task, отсутствие секретов). */
export async function receiverLog(runId) {
  return gh(['run', 'view', String(runId), '-R', POOL_REPO, '--log'], { timeoutMs: 120_000 });
}

/** Метаданные запуска workflow (включая шаги) — для проверки summary/artifact'ов D2. */
export async function receiverRunDetail(runId) {
  const out = await gh(['run', 'view', String(runId), '-R', POOL_REPO, '--json', 'jobs,steps,status,conclusion,url']);
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Список артефактов запуска (D2: location_reserved.json должен быть). */
export async function receiverArtifacts(runId) {
  const out = await gh(['api', `repos/${POOL_REPO}/actions/runs/${runId}/artifacts`, '--jq', '.artifacts[] | {name, size_in_bytes, digest}']).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
