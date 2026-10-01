// Блок D — контракт location (Ф1 + Ф3, issue #1).
// D1: location=""     → путь в наш пул (receiver подтверждён).
// D2: location=ru     → событие location_reserved, запуск НЕ выполняется, задача видима.
// D3: location=xxx    → 400/ошибка валидации с именем поля location.
// D4: поле отсутствует → эквивалентно пустому (путь в наш пул).
// Контракт реализован в llm-ladder POST /pool/trigger и receiver-джобе ai-agent-runs-pool.
import { poolTrigger, waitForReceiverRun, receiverLog, receiverRunDetail, receiverArtifacts, parseReceiverLog, LOCATION_VALUES } from '../pool.mjs';

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail: String(detail).slice(0, 400) } : {}) };
}

function taskFor(id) {
  return `epic-${id} ${new Date().toISOString()}: контракт location, доменной логики нет.`;
}

/**
 * D1/D4 проверяют РУТИНГ location (receiver подтверждён, резервации нет).
 * Полный submit в Serverless API — это уже A1 (requires api-remote): если в репе пула
 * не заданы RUNNER_API_URL/KEY, receiver честно пишет «принято» и выходит 0.
 * Падать на отсутствии API нельзя — иначе тест меряет конфиг, а не контракт.
 */
function receiverPipelineChecks(logText, parsed) {
  const fallback = /RUNNER_API настроен не будет/.test(logText);
  return [
    {
      name: 'receiver-run-or-honest-fallback',
      ok: Boolean(parsed.runId) || fallback,
      detail: parsed.runId ? `runId=${parsed.runId}` : fallback ? 'fallback: RUNNER_API в репе пула не настроен — принято без run' : 'ни runId, ни fallback-сообщения',
    },
  ];
}

export default {
  id: 'D',
  title: 'контракт location',
  cases: [
    {
      id: 'D1',
      title: 'location="" → путь в наш пул (receiver подтверждён)',
      requires: ['pool', 'gha'],
      timeoutMs: 360_000,
      async run(ctx) {
        const task = taskFor('D1');
        const t0 = Date.now();
        const trigger = await poolTrigger(ctx.caps.pool, { task, location: '' });
        const checks = [
          check('pool-202', trigger.status === 202, `HTTP ${trigger.status}`),
          check('queued', trigger.json?.queued === true, JSON.stringify(trigger.json ?? trigger.error ?? {})),
          check('response-location-empty', trigger.json?.location === undefined || trigger.json.location === '', `location=${JSON.stringify(trigger.json?.location)}`),
        ];
        const receiver = await waitForReceiverRun({ sinceMs: t0, timeoutMs: 300_000 });
        checks.push(check('receiver-started', Boolean(receiver), receiver ? `run ${receiver.databaseId}` : 'не появился за 300 с'));
        let parsed = {};
        if (receiver?.databaseId) {
          const logText = await receiverLog(receiver.databaseId).catch(() => '');
          parsed = parseReceiverLog(logText);
          checks.push(...receiverPipelineChecks(logText, parsed));
          checks.push(check('not-reserved', !parsed.locationReserved, 'location="" не должен резервироваться'));
        }
        return {
          checks,
          metrics: { poolTriggerMs: trigger.ms, receiverRun: receiver?.databaseId ?? null, runId: parsed.runId ?? null },
          note: `D1: location="" → ${parsed.runId ? `run ${parsed.runId}` : 'без run'}`,
        };
      },
    },
    {
      id: 'D2',
      title: 'location=ru → событие location_reserved, запуск не выполняется, задача видима',
      requires: ['pool', 'gha'],
      timeoutMs: 360_000,
      async run(ctx) {
        const task = taskFor('D2');
        const t0 = Date.now();
        const trigger = await poolTrigger(ctx.caps.pool, { task, location: 'ru' });
        const checks = [
          check('accepted-202', trigger.status === 202, `HTTP ${trigger.status} ${JSON.stringify(trigger.json ?? trigger.error ?? {})}`),
          check('reserved-acknowledged', trigger.json?.reserved === true || trigger.json?.location === 'ru', JSON.stringify(trigger.json ?? {})),
        ];
        const receiver = await waitForReceiverRun({ sinceMs: t0, timeoutMs: 300_000 });
        checks.push(check('receiver-visible', Boolean(receiver), receiver ? `run ${receiver.databaseId} (${receiver.status})` : 'задача не видна'));
        let parsed = {};
        if (receiver?.databaseId) {
          const logText = await receiverLog(receiver.databaseId).catch(() => '');
          parsed = parseReceiverLog(logText);
          checks.push(check('location-reserved-logged', parsed.locationReserved, 'в логе receiver-джобы нет location_reserved'));
          checks.push(check('location-value-ru', parsed.locationValue === 'ru', `location=${parsed.locationValue}`));
          checks.push(check('no-run-submitted', !parsed.submitted, `runId=${parsed.runId}`));
          const detail = await receiverRunDetail(receiver.databaseId).catch(() => null);
          checks.push(check('receiver-job-green', detail?.conclusion === 'success', `conclusion=${detail?.conclusion}`));
          const artifacts = await receiverArtifacts(receiver.databaseId).catch(() => []);
          checks.push(
            check(
              'reserved-record-persisted',
              artifacts.some((a) => /location/i.test(a.name ?? '')) || /location_reserved/.test(JSON.stringify(detail ?? {})),
              `артефакты: ${artifacts.map((a) => a.name).join(', ') || 'нет'}`,
            ),
          );
        }
        return {
          checks,
          metrics: { poolTriggerMs: trigger.ms, receiverRun: receiver?.databaseId ?? null, submittedRun: parsed.runId ?? null },
          note: `D2: location=ru → reserved=${parsed.locationReserved}, run=${parsed.runId ?? 'не создан'}`,
        };
      },
    },
    {
      id: 'D3',
      title: 'location=xxx → 400/ошибка валидации с именем поля location',
      requires: ['pool'],
      timeoutMs: 60_000,
      async run(ctx) {
        const results = {};
        const checks = [];
        for (const bad of ['xxx', 'RU', 'ru,eu', '1', 'asia']) {
          const trigger = await poolTrigger(ctx.caps.pool, { task: taskFor('D3'), location: bad });
          results[bad] = { status: trigger.status, body: trigger.text ?? JSON.stringify(trigger.json ?? trigger.error ?? {}) };
          const named = trigger.status === 400 && /\blocation\b/i.test(results[bad].body);
          checks.push(check(`reject-${bad}`, named, `HTTP ${trigger.status}: ${results[bad].body.slice(0, 160)}`));
        }
        // валидные значения не должны отклоняться этим же валидатором
        for (const good of LOCATION_VALUES) {
          const trigger = await poolTrigger(ctx.caps.pool, { task: taskFor('D3'), location: good });
          checks.push(check(`accept-${JSON.stringify(good)}`, trigger.status === 202 || trigger.status === 401, `HTTP ${trigger.status}: ${(trigger.text ?? '').slice(0, 120)}`));
        }
        return {
          checks,
          metrics: { rejected: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status])) },
          note: `D3: кривые location отклонены с именем поля; результаты ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status])))}`,
        };
      },
    },
    {
      id: 'D4',
      title: 'отсутствие поля location == пустое (путь в наш пул)',
      requires: ['pool', 'gha'],
      timeoutMs: 360_000,
      async run(ctx) {
        const task = taskFor('D4');
        const t0 = Date.now();
        const trigger = await poolTrigger(ctx.caps.pool, { task }); // поле location не передаём вовсе
        const checks = [
          check('pool-202', trigger.status === 202, `HTTP ${trigger.status}`),
          check('queued', trigger.json?.queued === true, JSON.stringify(trigger.json ?? trigger.error ?? {})),
        ];
        const receiver = await waitForReceiverRun({ sinceMs: t0, timeoutMs: 300_000 });
        checks.push(check('receiver-started', Boolean(receiver), receiver ? `run ${receiver.databaseId}` : 'не появился за 300 с'));
        let parsed = {};
        if (receiver?.databaseId) {
          const logText = await receiverLog(receiver.databaseId).catch(() => '');
          parsed = parseReceiverLog(logText);
          checks.push(...receiverPipelineChecks(logText, parsed));
          checks.push(check('not-reserved', !parsed.locationReserved, 'без поля location не должно быть резервации'));
        }
        return {
          checks,
          metrics: { poolTriggerMs: trigger.ms, receiverRun: receiver?.databaseId ?? null, runId: parsed.runId ?? null },
          note: `D4: без поля location → ${parsed.runId ? `run ${parsed.runId}` : 'без run'} (эквивалент D1)`,
        };
      },
    },
  ],
};
