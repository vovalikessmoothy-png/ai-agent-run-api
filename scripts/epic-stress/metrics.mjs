// metrics.mjs — извлечение метрик прогона (Ф3): тайминги по событиям, sha256,
// скан на секреты в логах/коммите (E2/C1), разбор лога receiver-джобы.
// Никогда не принимает и не возвращает значения токенов — только факт их наличия.
import { createHash } from 'node:crypto';

/** Отметки времени из событий относительно submit: старт→running→succeeded→result. */
export function eventTimeline(events, submitAtMs) {
  const byType = {};
  for (const event of events ?? []) {
    if (byType[event.type] === undefined) {
      byType[event.type] = { sequence: event.sequence, timestamp: event.timestamp, at: null };
    }
  }
  const seen = new Map();
  for (const event of events ?? []) {
    if (seen.has(event.type)) continue;
    const clientAt = Date.now();
    seen.set(event.type, {
      type: event.type,
      sequence: event.sequence,
      serverAt: event.timestamp,
      recvOffMs: Number.isFinite(submitAtMs) ? clientAt - submitAtMs : null,
    });
  }
  return { byType, firstSeen: [...seen.values()].sort((a, b) => a.sequence - b.sequence) };
}

/** Тайминги из событий: submit→running, running→terminal (по серверным таймстопам). */
export function timingsFromEvents(events, submitAtMs) {
  const list = [...(events ?? [])].sort((a, b) => a.sequence - b.sequence);
  const first = (type) => list.find((e) => e.type === type);
  const started = first('started');
  const terminal = list.find((e) => ['succeeded', 'failed', 'cancelled'].includes(e.type));
  const out = { submitToRunningMs: null, runningToTerminalMs: null, submitToTerminalMs: null };
  if (started && Number.isFinite(submitAtMs)) out.submitToRunningMs = Date.parse(started.timestamp) - submitAtMs;
  if (started && terminal) out.runningToTerminalMs = Date.parse(terminal.timestamp) - Date.parse(started.timestamp);
  if (terminal && Number.isFinite(submitAtMs)) out.submitToTerminalMs = Date.parse(terminal.timestamp) - submitAtMs;
  return out;
}

/** Все фиксации определённого типа события (для подсчёта ретраев/rate-limit). */
export function countEvents(events, type) {
  return (events ?? []).filter((e) => e.type === type).length;
}

/**
 * Сканирование текста (лог джобы, diff коммита) на утечки.
 * Возвращает список {pattern, where} — только названия паттернов, без совпадений.
 */
const SECRET_PATTERNS = [
  { name: 'github-pat', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'bearer-inline', re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'env-secret-assignment', re: /(POOL_TRIGGER_TOKEN|RUNNER_API_KEY|LLM_LADDER_TOKEN|GITHUB_AI_AGENT_RUNS_POOL)\s*[=:]\s*[^\s"']{8,}/g },
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'presigned-signature', re: /([?&](X-Goog-Signature|Signature|X-Amz-Signature)=)[A-Za-z0-9%+/=]{16,}/g },
];

export function scanForSecrets(text, where = 'text') {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(text);
    if (match) findings.push({ pattern: name, where, length: match[0].length });
  }
  return findings;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Разбор лога receiver-джобы ai-agent-runs-pool:
 *   - runId поданного в Serverless API (`runId=... (submit HTTP 202)`)
 *   - фиксация location_reserved
 *   - факт отсутствия submit (для зарезервированных регионов)
 */
export function parseReceiverLog(logText) {
  const text = String(logText ?? '');
  const runId = /runId=([A-Za-z0-9._:-]+)/.exec(text)?.[1] ?? null;
  const submitHttp = /submit HTTP (\d{3})/.exec(text)?.[1] ?? null;
  const finalState = /final state: (\w+)/.exec(text)?.[1] ?? null;
  const locationReserved = /location_reserved/.test(text);
  const locationValue = /location=([a-z]*)/.exec(text)?.[1] ?? null;
  const taskLine = /task \((\d+) chars\):/.exec(text);
  const taskDeclaredLen = taskLine ? Number(taskLine[1]) : null;
  const taskLoggedLen = taskLine ? text.slice(taskLine.index).split('\n')[0].length : null;
  return {
    runId,
    submitHttp,
    finalState,
    locationReserved,
    locationValue,
    taskDeclaredLen,
    taskLoggedLen,
    submitted: runId !== null,
    locationReservedWithoutSubmit: locationReserved && runId === null,
  };
}

/** Агрегация по массиву прогонов: доля успехов, ретраи, rate-limit. */
export function aggregateRuns(runRecords) {
  const runs = Array.isArray(runRecords) ? runRecords : [];
  const succeeded = runs.filter((r) => r.outcome === 'succeeded').length;
  const failed = runs.filter((r) => r.outcome === 'failed').length;
  const deduplicated = runs.filter((r) => r.deduplicated === true).length;
  const rateLimitEvents = runs.filter((r) => /rate.?limit|429|too many requests/i.test(String(r.rateLimitHint ?? ''))).length;
  return {
    submitted: runs.length,
    succeeded,
    failed,
    deduplicated,
    rateLimitEvents,
    retries: runs.reduce((sum, r) => sum + (Number(r.retries) || 0), 0),
  };
}
