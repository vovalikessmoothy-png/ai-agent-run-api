# E2E acceptance loop (issue #2) — цикл приёмки владельца

Замкнутый прогон сценариев приёмки из [issue #2](https://github.com/trained-assist/ai-agent-runner/issues/2): submit → events → faults → restart/reboot → security-пробы → артефакт → креды. Каждый шаг даёт явный **PASS/FAIL с reproduction**, результат — JSON-отчёт; каждый провал оформляется issue в [репозитории продукта](https://github.com/trained-assist/ai-agent-runner/issues) с reproduction из цикла (шаг 8 цикла).

Драйвер живёт в этой репе: `scripts/e2e-loop.mjs` (+ обёртка `scripts/e2e-loop.sh`). Продуктовый код `src/` цикл **не меняет и не копирует** — продукт чекаутится отдельным шагом (`AGENT_RUNNER_DIR`, дефолт `./product`), цикл работает только через его публичный API (`src/api`: submit/status/events/cancel/result) и реестр faults slice-1.

## Как запустить

```bash
git clone https://github.com/trained-assist/ai-agent-runner.git product
npm ci                 # этой репы: драйверы — чистый node, npm-зависимостей нет
(cd product && npm ci) # devDependencies продукта: typescript для сборки src/
./scripts/e2e-loop.sh  # либо: node scripts/e2e-loop.mjs --help
```

Драйвер сам собирает `src/` продукта в `product/.e2e-dist/` (tsc по tsconfig самого продукта; gitignore обеих реп, `package.json` не трогается), поднимает дочерний процесс API-сервера, прогоняет шаги и пишет отчёт. Node 20+, без платных моделей: по умолчанию работают только fake-движки и локальные engine-скрипты.

Цикл работает **только в LOCAL-режиме**: если заданы оба `RUNNER_API_URL` + `RUNNER_API_KEY` (REMOTE), драйвер выходит с кодом 2 и объясняет — циклу нужны kill/restart/reboot и control-эндпоинты собственного эфемерного сервера (см. README, «Режимы джоб»).

Полезные опции:

| Опция | Что делает |
|---|---|
| `--report <path>` | путь JSON-отчёта (дефолт `./e2e-loop-report.json`) |
| `--root <dir>` | каталог данных прогона (дефолт — временный) |
| `--only <ids>` / `--skip <ids>` | выбрать/пропустить шаги (перепрогон одного провала) |
| `--keep-data` | не удалять каталог данных (автоматически остаётся при FAIL) |
| `--foreign-profile <path>` | цель пробы «чужой профиль» (на VM: напр. `/home/vova`) |
| `--sudo-policy deny\|report` | `deny` (дефолт): passwordless sudo = FAIL; `report`: зафиксировать без провала — только для CI-хостов |
| `--with-opencode` | добавить прогон security-проб настоящим `opencode` (может звать модели!) |
| `--with-reboot` | полный `systemctl reboot` VM — **только под root, явно**; шаг идёт последним |
| `--dry-run` | печатает режим (LOCAL/REMOTE), пути к продукту/сборке и список шагов, без запуска |

Exit codes: `0` — все шаги зелёные, `1` — есть FAIL, `2` — ошибка запуска/guard.

## Шаги цикла

| Шаг | id | Что проверяет |
|---|---|---|
| 1 | `step-1-submit-idempotency` | submit → receipt; дубль с тем же ключом = 200/тот же runId/`deduplicated=true` и **один** engine start; другой payload с тем же ключом = 409 `IDEMPOTENCY_CONFLICT` |
| 2 | `step-2-events-stream-replay` | SSE-поток с snapshot, обрыв соединения, reconnect по `Last-Event-ID` без повторов; JSON cursor-реплей полной цепочки `claimed→materialized→started→…→succeeded` (sequence без дыр, один claimed); reconnect ≠ rerun |
| 3 | `step-3-fault-injection` | nonzero exit / startup failure / timeout / crash (fake-сценарии) **и** точки реестра faults (`spawn`, `preflight`, once): каждый кейс = `failed` + ожидаемый `exitReason` + `failure.code`, тот же код в терминальном событии; после очистки реестра обычный run снова `succeeded` |
| 4 | `step-4-recovery-restart` | run висит → процесс runner убит `SIGKILL` и перезапущен: status/events читаются, `connectionLost=true` при `state=running` (**потеря связи ≠ failed**), `state.json`/`events.jsonl` пережили рестарт, реплей с диска, повторный submit = dedup без второго start, cancel гасит осиротевший процесс до терминала |
| 4b | `step-4b-reboot` (только `--with-reboot`, root) | полный `systemctl reboot` посреди run'а: после загрузки systemd resume-юнит дочитывает status/events/result (`failed/WORKER_CRASH` — без скрытого rerun), повторный submit = тот же receipt, store содержит один run. В дефолтном прогоне **не выполняется** |
| 5 | `step-5-security-probes` | изнутри рана: чтение чужого профиля, `sudo -n`, metadata `169.254.169.254`, `secrets.env` → ожидается **DENIED**; каждая попытка видна в scoped events (`E2E_PROBE …`) и в `events.jsonl` на диске; env рана содержит только allowlist; `LEAKED` = FAIL |
| 6 | `step-6-artifact` | агент создаёт файл в workspace → клиент забирает через `GET /v1/runs/{id}/download` и сверяет sha256/размер с объявленным и с диском; файл `0600`, workspace `0700`; traversal `../` = 400, без ключа = 401, нет файла = 404 |
| 7 | `step-7-credential-scopes` | синтетические креды: scope `read` → gateway пишет 403 (зафиксирован в попытках), scope `write` → 200; в ран передаются только allowlist-переменные; значения кредов отсутствуют в receipt/status/result/events, в `events.jsonl`, в server log, в `admissions.json`/`operations.json`/`state.json` и в workspace после run |

## Отчёт

`./e2e-loop-report.json` (атомарная запись после каждого шага):

```jsonc
{
  "schemaVersion": 1,
  "issue": "#2",
  "startedAt": "...", "finishedAt": "...",
  "env": { "node": "...", "rootDir": "...", "port": 43123, "flags": [] },
  "steps": [
    {
      "id": "step-5-security-probes",
      "status": "PASS" | "FAIL",
      "durationMs": 1813,
      "checks": [{ "name": "...", "ok": true, "detail": "..." }],
      "reproduction": "node scripts/e2e-loop.mjs --root ... --only step-5-...",
      "issueDraft": { "title": "e2e-loop: FAIL ...", "body": "..." }   // только при FAIL
    }
  ],
  "summary": { "total": 7, "passed": 7, "failed": 0, "skipped": 0, "ok": true, "finalized": true }
}
```

При FAIL драйвер печатает упавшие проверки, reproduction и черновик issue, оставляет каталог данных (`--root` из reproduction) и выходит с кодом 1. Дальше — `gh issue create` с этим телом, фикс, перепрогон `--only <id>` (шаг 8 цикла).

## Прогоны: где и с какими ожиданиями

- **Локально / инженерно** — `./scripts/e2e-loop.sh`, все 7 шагов, детерминированно, free-only.
- **Песочная VM (`/opt/sb`, пользователь `sandbox`)** — прогон по явной команде; пробы идут с дефолтным `--sudo-policy deny`. `--foreign-profile` можно указать на реальный чужой профиль. `--with-reboot` — только из-под root (записывает systemd resume-юнит, делает reboot последним шагом, сам чистит юнит после resume).
- **CI (ubuntu-latest раннер)** — workflow `capability-probe.yml` **этой репы** запускает драйвер с `--sudo-policy report`: у раннера GitHub штатно есть NOPASSWD sudo, это инфраструктура CI, а не продуктовый хост. На продуктовых хостах оставляйте `deny`.
- **`--with-opencode`** — отдельная опция: одна security-проба настоящим `opencode` (инструкция — выполнить probe-скрипт и показать вывод); ожидания: run терминален, канарейки чужого профиля/secrets не утекли в логи, `verdict=LEAKED` отсутствует. Вне дефолтного прогона, т.к. может обращаться к моделям.

## Границы: что здесь harness, а не продукт

Чтобы не трогать `src/api`/`src/storage` (параллельная сессия) и не выдавать заготовки за готовый функционал:

- **`GET /v1/runs/{id}/download`** и **credential gateway** (`/_e2e/cred/{read,write}`) живут в `scripts/e2e-loop/server.mjs` — e2e-стенд-ины под P07 (artifact transfer) и Credential Broker (architecture #30). Продуктовый контракт появится в своих срезах; цикл проверяет уже сейчас поведение «клиент получает байты через API» и «scope read не пишет».
- **Синтетические креды** генерируются на каждый прогон в `<root>/e2e-credentials.json` (mode 0600), значения попадают только в env дочернего сервера и в этот файл; в репозиторий ничего не пишется.
- **Security-пробы идут от того же UID**, что и runner: deny обеспечивается правами файлов (каталог/файл mode 000), пустым env рана и сетевыми отказами. Межпользовательская изоляция (другой UID, namespaces/cgroups) — slice 3, ARCHITECTURE §6; эти атаки цикл сегодня не покрывает и не притворяется, что покрывает.
- **`__CF_USER_TEXT_ENCODING`** (macOS) Node инжектит в child env сам — он исключён из проверки «env рана = allowlist», это платформенная переменная, а не утечка host-окружения.

## Приёмка issue #2

- [x] `scripts/e2e-loop.sh` (эквивалент `npm run e2e-loop`; у драйверов нет npm-зависимостей) проходит шаги 1–7 с ожидаемыми отказами, детерминированно, free-only.
- [x] Reboot-кейс: один run, один receipt, никакого rerun (`--with-reboot` под root; в дефолтном прогоне guard отклоняет флаг без root).
- [x] Security-пробы: 0 успешных выходов за scope; попытки видны в structured logs.
- [x] Артефакт байт-в-байт у клиента; креды не в логах/events/receipt/workspace.
- [x] Каждый исторический провал = issue с reproduction (дрейвер формирует черновик; см. открытые issue репо).

## Структура

```
scripts/e2e-loop.sh          обёртка
scripts/e2e-loop.mjs         драйвер: аргументы, дист-сборка, отчёт, reboot-режим, --dry-run
scripts/stress-probe.mjs     замеры лимитов CI (timeline/recovery/memory/cpu), LOCAL/REMOTE
scripts/driver-mode-and-product-paths.mjs
                             выбор режима (env > LOCAL) и путей к продукту/сборке (AGENT_RUNNER_DIR)
scripts/e2e-loop/
  checks.mjs (+.d.mts)       проверки цепочек событий, секреты, Step/отчёт
  client.mjs                 HTTP + SSE (cursor/Last-Event-ID) + control-клиент — общий для LOCAL и REMOTE
  server.mjs                 дочерний API-сервер: product/.e2e-dist + engine-реестр + download/gateway/_e2e
  steps.mjs                  шаги 1–7
  engine-scripts/            probe.mjs, artifact.mjs, cred.mjs, slow.mjs
  tsconfig.build.json        фоллбэк сборки продуктового src/ (приоритет — tsconfig в самом продукте)
```

Тесты цикла (`test/e2e-loop.test.ts`, `test/e2e-loop-checks.test.ts`) остаются в trained-assist/ai-agent-runner до отдельного шага переноса/удаления копий джоб из продукта.
