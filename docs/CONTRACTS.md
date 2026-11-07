# CONTRACTS

> Версия: **0.5.4** · Обновлено: 2026-11-07 · Владелец: команда
> Контракт — это то, на что опираются параллельно фронт, бэк и eval. Меняем только с записью в «Журнал версий» внизу. Несовместимое изменение → поднять минорную версию.
> Связано: `architecture/evaluation-pipeline.md`, `architecture/data-model.md`, `spec/requirements.md`.

## 1. Чек-лист (`data/checklists/default.json`, `checklist_version.body`)

```json
{
  "key": "default",
  "name": "Чек-лист качества чатов",
  "settings": {
    "output_language": "ru",
    "rounding": 2,
    "critical_policy": "flag",
    "first_response_threshold_sec": 180,
    "advice": true,
    "overview": true,
    "quote_threshold": {"chat": 0.85, "voice": 0.75}
  },
  "sections": [
    {"id": "start",    "title": "Начало и понимание запроса"},
    {"id": "safety",   "title": "Безопасность и решение"},
    {"id": "dialog",   "title": "Ведение и завершение диалога"},
    {"id": "critical", "title": "Грубые нарушения"}
  ],
  "criteria": [
    {
      "key": "01",
      "title": "Установление контакта",
      "section": "start",
      "type": "binary",
      "weight": 10,
      "na_allowed": false,
      "na_when": null,
      "definition": "Оператор поздоровался на языке клиента и представился в первом ответе.",
      "yes_when": "В первой реплике оператора есть приветствие на языке клиента и имя оператора.",
      "no_when": "Нет приветствия, нет имени, приветствие не на языке клиента или представился не в первом ответе.",
      "scale": null,
      "guidance": "Первая реплика оператора и её язык есть в фактах.",
      "voice_guidance": "Первый ответ — первая реплика оператора, а не автоответчика.",
      "group": "A",
      "context_refs": [],
      "guards": [{"when": ["!greeting_in_first_msg", "!intro_in_first_msg"], "expect": ["no"], "action": "flag"}],
      "enabled": true
    },
    {
      "key": "04",
      "title": "Корректная и полная консультация",
      "section": "safety",
      "type": "scale",
      "weight": 20,
      "na_allowed": true,
      "na_when": "Чат закончился до того, как клиент сформулировал запрос.",
      "definition": "Оцените ответ или следующий шаг по шкале.",
      "yes_when": null,
      "no_when": null,
      "scale": [
        {"value": 20, "label": "Все существенные вопросы закрыты или дан корректный следующий шаг."},
        {"value": 15, "label": "Основной вопрос решён, пропущена второстепенная деталь."},
        {"value": 10, "label": "Часть запроса закрыта, существенный вопрос остался открытым."},
        {"value": 5,  "label": "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать."},
        {"value": 0,  "label": "Ответа по существу нет или ключевая рекомендация ошибочна."}
      ],
      "guidance": "Выпиши вопросы клиента и отметь, какие закрыты. Консультация — правильность и полнота, а не стиль.",
      "group": "04",
      "context_refs": ["knowledge/freedom_broker_kb.md"],
      "guards": [],
      "enabled": true
    },
    {
      "key": "08",
      "title": "Грубые ошибки",
      "section": "critical",
      "type": "flag",
      "weight": 0,
      "na_allowed": false,
      "definition": "Оскорбление клиента, предложение платной услуги в обход компании или раскрытие конфиденциальной информации.",
      "yes_when": "Есть хотя бы одно из трёх. Достаточно самого предложения, согласие клиента не нужно.",
      "no_when": "Ни одного из трёх.",
      "scale": null,
      "guidance": "Слова-подсказки есть в фактах (risk_terms), но решай по смыслу.",
      "group": "08",
      "context_refs": [],
      "guards": [],
      "enabled": true
    }
  ]
}
```

Правила:
- `key` — уникален в версии, только `[A-Za-z0-9_-]`, задаётся пользователем. Код не ветвится по `key`.
- `type`: `binary` (ответы `yes`/`no` + `na`, если разрешён), `scale` (ступени из `scale[].value` + `na`), `flag` (`yes`/`no`, без баллов, `weight` игнорируется).
- `group` — для стратегии `grouped`; пусто → свой вызов.
- `context_refs` — пути внутри `data/` к справкам, которые подставляются в блок критерия.
- `guards[].when` — список булевых фактов (`!` = отрицание), все должны выполняться; `expect` — допустимые ответы; `action`: `flag` | `override` (тогда нужен `set`).
- В файле по умолчанию все 8 критериев; здесь показаны 3 для примера.

## 2. Ответ LLM (одна схема на вызов, генерируется из чек-листа)

```json
{
  "type": "object", "additionalProperties": false, "required": ["results"],
  "properties": {"results": {
    "type": "object", "additionalProperties": false, "required": ["01", "02"],
    "properties": {
      "01": {
        "type": "object", "additionalProperties": false,
        "required": ["reasoning", "answer", "confidence", "evidence", "checked_range", "na_reason", "advice"],
        "properties": {
          "reasoning": {"type": "string"},
          "answer": {"type": "string", "enum": ["yes", "no"]},
          "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
          "evidence": {"type": "array", "items": {
            "type": "object", "additionalProperties": false, "required": ["msg_id", "quote"],
            "properties": {"msg_id": {"type": "string"}, "quote": {"type": "string"}}}},
          "checked_range": {"anyOf": [{"type": "null"}, {
            "type": "object", "additionalProperties": false, "required": ["from", "to"],
            "properties": {"from": {"type": "string"}, "to": {"type": "string"}}}]},
          "na_reason": {"anyOf": [{"type": "null"}, {"type": "string"}]},
          "advice": {"anyOf": [{"type": "null"}, {"type": "string"}]}
        }
      }
    }
  },
  "overview": {
    "type": "object", "additionalProperties": false, "required": ["summary", "topic", "resolved"],
    "properties": {
      "summary": {"type": "string"},
      "topic": {"type": "string"},
      "resolved": {"type": "string", "enum": ["yes", "no", "unclear"]}
    }
  }}
}
```

- `answer` enum: `binary` → `yes`, `no` (+ `na`); `scale` → значения ступеней строками (`"20"`, `"15"`, …) (+ `na`); `flag` → `yes`, `no`.
- В БД и API ответ хранится как `"yes" | "no" | "na" | <int>` (ступень — число), как в gold.
- `msg_id` — `m<idx>`; `quote` — дословный фрагмент реплики `msg_id`.
- `confidence` — уверенность модели; `low` ставится, когда данных для вывода не хватает (FR-EVAL-16), и даёт пометку «требует проверки».
- `advice` — подсказка оператору, только если ответ не даёт полного балла (FR-EVAL-18), иначе `null`; при `settings.advice = false` поле не входит в схему.
- `overview` (FR-EVAL-19) входит только в схему первого вызова оценки и только при `settings.overview = true`; в `required` верхнего уровня его добавляет `prompt_builder`.

## 3. API

Все ответы JSON, ошибки — `{"detail": str}` с кодом 4xx/5xx; у 422 проверки данных (чек-лист, новый диалог, апелляция, поправка записи) дополнительно `errors: [{path, message}]`. Префикс `/api`. Маршруты фронта и `/conversations/{id}` используют суррогатный числовой `id`.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /health` | — | `{status, provider, model, group_id, conversations, organizer_api}`; `organizer_api: bool` — задан ли `ORGANIZER_API_URL` (сам адрес с подписью `sig` не отдаётся) |
| `POST /datasets/import` | `{group_id}` (пусто — группа из `.env`) | `{group_id, imported, updated, warnings[], skipped}`; 400 — `ORGANIZER_API_URL` не задан; 502 — API организаторов недоступен или вернул ошибку (в тексте нет адреса и подписи) |
| `POST /datasets/upload` | `multipart/form-data`, поле `file`: JSON в формате API организаторов, до 25 МБ | то же; повторная загрузка той же группы обновляет диалоги (`updated`); 400 — не JSON или нет `records`; 413 — файл больше 25 МБ |
| `GET /conversations` | `?group_id&language&channel&critical&appeal=open\|any\|none&checklist_version_id` | `[ConversationRow]`; `appeal` — по последней оценке |
| `POST /conversations` | `{group_id?: "MANUAL", conversation_id?, channel?, language?, transcript: [] \| text}` | `ConversationDetail` (201, FR-DATA-07); 409 — такой `conversation_id` в группе уже есть или группа — набор организаторов; 422 с `errors` (в т. ч. `audio_url` вручную не принимается; текст ≤ 300 000 символов, реплика ≤ 20 000) |
| `GET /conversations/{id}` | — | `ConversationDetail` (транскрипт с `msg_id`, `t_sec`, `audio_offset_sec`; список оценок) |
| `PATCH /conversations/{id}` | `{audio_offset_fix_sec}` (секунды, от −3600 до 3600) | `ConversationDetail`; `messages[].audio_offset_sec` не меняется, плеер прибавляет поправку сам |
| `GET /conversations/{id}/audio` | заголовок `Range` (необязательно) | поток записи через бэкенд: 200 или 206 с `Content-Range`, `Accept-Ranges: bytes`, тип по сигнатуре файла; источник без `Range` — файл кэшируется в памяти и режется на бэкенде; 404 — записи нет; 502 — источник недоступен (без адреса источника в ответе и логах) |
| `GET /checklists` | — | `[{id, key, version, name, note, is_active, created_at}]` |
| `GET /checklists/{version_id}` | — | `{id, key, version, ..., body}` |
| `POST /checklists` | `{body, note, parent_id?, activate?: bool}` | версия; 422 с `[{path, message}]`, если невалидно |
| `POST /checklists/{version_id}/activate` | — | версия |
| `POST /checklists/draft-criterion` | `{description, type: "binary" \| "scale" \| "flag", language?, provider?, model?}` (описание ≤ 2000 символов; `language` по умолчанию — `output_language` активного чек-листа) | `{criterion, provider, model, cost_usd, tokens: {in, out}, latency_ms, attempts, calls: [{attempt, provider, model, finish_reason, tokens_in, tokens_out, cost_usd, latency_ms, request, response_raw}]}`; `criterion` — поля §1, текст пишет модель, `key`, `section`, `weight`, `export_id`, `group` — `null` (их задаёт человек). Ничего не сохраняет; строгая схема, один ретрай (обрезка по длине — с удвоенным `max_tokens`); образцы стиля — 1–2 критерия активного чек-листа. 400 — пустое описание, неизвестный тип или провайдер; 502 — `{detail, calls}`: провайдер недоступен или черновик не прошёл проверку после ретрая |
| `POST /runs` | `{conversation_ids? \| group_id, checklist_version_id?, provider?, model?, strategy?, reuse?: "auto" \| "none"}` | `{run_id}` (202); `reuse: auto` — инкрементальная переоценка (FR-CHK-10), «Оценить повторно» = те же параметры и `reuse: none` |
| `POST /runs/estimate` | то же тело, что у `POST /runs` | `{dialogs, dialogs_with_calls, calls, tokens_in, tokens_out, cost_usd \| null, seconds, cost_source: history \| pricing \| unknown}`; LLM не вызывается (FR-UX-03) |
| `GET /meta/facts` | — | `{labels: {имя факта: подпись}}` |
| `GET /runs/{run_id}` | — | `{status, total, done, failed, cost_usd, started_at, finished_at}` |
| `GET /evaluations/{id}` | — | `Evaluation` |
| `GET /evaluations/{id}/calls` | — | `[LLMCall]` с сырыми ответами |
| `GET /evaluations/{id}/compare?other=` | — | `{a, b, criteria: [{key, title, status: same\|changed\|added\|removed, a, b, points_delta}], changed, common, total_delta, same_config, config_diff}` (FR-EVAL-20, FR-CARD-06); без `other` — предыдущая неупавшая оценка диалога, `b: null`, если её нет; 422 — оценки разных диалогов |
| `POST /appeals` | `{evaluation_id, criterion_key, comment}` (комментарий обязателен) | `Appeal` (201); 404 — нет оценки или критерия; 409 — по критерию уже есть открытая; 422 с `errors` |
| `GET /appeals` | `?status=open\|confirmed\|changed\|closed&group_id&evaluation_id&conversation_id` (id диалога в БД); без `status` — все | `[AppealRow]`, новые сверху |
| `POST /appeals/{id}/decision` | `{action: "confirm" \| "change", answer?, reason}` (причина обязательна; `answer` — из `allowed_answers` критерия и не равен текущему) | `{appeal, evaluation}` с пересчитанным `final_score`; 409 — апелляция уже рассмотрена; 422 с `errors` |
| `POST /appeals/{id}/second-opinion` | `{provider?, model?}` (тело необязательно; по умолчанию активный провайдер, как у `/checklists/trial`) | `SecondOpinion`. Слепая перепроверка спорного критерия: тот же конвейер (`strategy: single`, промпт из версии чек-листа оценки, факты, проверка цитат с одним ретраем, маскирование); модель не видит ответ AI и комментарий аналитика. Оценка и апелляция не меняются, результат и вызовы LLM — в `appeal_second_opinion`. 404 — нет апелляции; 409 — апелляция рассмотрена; 400 — провайдер/модель; 502 — модель не ответила |
| `GET /export` | `?group_id&checklist_version_id&format=csv\|json` (по умолчанию группа из `.env`, активная версия, csv) | файл (`Content-Disposition: attachment`), §5 |
| `GET /analytics` | `?group_id&checklist_version_id` (по умолчанию группа из `.env` и активная версия) | `Analytics` (FR-ANL-01…03) |
| `GET /quality/runs` | — | список прогонов `eval/runs/*.json` (или `CQA_EVAL_RUNS_DIR`): `{id, created_at, provider, model, strategy, split, complete, metrics-сводка}`; битый файл — строка с ошибкой (FR-OPS-05) |
| `GET /quality/runs/{name}` | — | прогон целиком: метрики, разрезы, стабильность, калибровка, цена; 404 — нет файла или имя вне папки, 422 — файл не разбирается |
| `GET /review-queue` | `?group_id&checklist_version_id` (по умолчанию — как у аналитики) | `[ReviewItem]` (FR-UX-02), важные сверху |
| `GET /meta/models` | — | настроенные провайдеры и модели, стратегия по умолчанию |
| `GET /gold/{conversation_id}`, `PUT /gold/{conversation_id}` | разметка по формату `data/gold/README.md` | для экрана gold-разметки (только DEV) |

Основные объекты:

```text
ConversationRow  = {id, conversation_id, group_id, channel, language, source,
                    latest: {evaluation_id, status, ai_total, final_total, critical, needs_review, open_appeals, appeals} | null}   # appeals — всего по оценке
ConversationDetail = {id, conversation_id, group_id, channel, language, has_audio, audio_url (путь прокси `/api/conversations/{id}/audio`, исходная подписанная ссылка в браузер не уходит), source, audio_offset_fix_sec, imported_at,
                    messages: [{msg_id, idx, speaker, text, timestamp, t_sec, audio_offset_sec, internal, event}],
                    segments: [{type, start_idx, end_idx, start_sec, end_sec}], events: [{type, idx, msg_id, t_sec, text}], warnings: [str],
                    evaluations: [{id, model, checklist_version_id, status, ai_total, final_total, created_at}]}
Evaluation       = {id, conversation_id, checklist_version_id, provider, model, strategy, prompt_version, status, needs_review, critical, open_appeals,
                    facts, overview: {summary, topic, resolved} | null, params: {temperature, seed, reuse},
                    ai_score: ScoreResult, final_score: ScoreResult, criteria: [CriterionResult],
                    tokens_in, tokens_out, cost_usd, latency_ms, created_at}
CriterionResult  = {key, title, section, type, weight, scale_max, ai_answer, ai_points, final_answer, final_points, overridden,
                    reasoning, confidence, advice, evidence: [{msg_id, quote, quote_ok}], checked_range: {from, to} | null, na_reason, issues: [str],
                    reused_from_evaluation_id: int | null, allowed_answers: [Answer],
                    appeal: Appeal | null (последняя), appeal_history: [Appeal] (от старых к новым)}
ScoreResult      = {total: float | null, applicable_weight, points_sum, sections: [{id, title, points, applicable_weight, pct}],
                    criteria: {key: {points, contribution}}, critical: [key]}
Analytics        = {group_id, checklist_version_id, checklist_version: {id, key, version, name} | null,
                    conversations, count (с оценкой), not_evaluated, status_counts: {done, partial, failed},
                    avg_total (= avg_final_total), avg_ai_total, avg_final_total,
                    histogram: [{from, to, count, ai_count}] (корзины по 10 п.п., 100 — в последней; count — по финальному итогу),
                    by_criterion: [{key, title, section, type, weight, count, pass_rate, ai_pass_rate, avg_pct, ai_avg_pct, na_rate,
                                    answers: {ответ: n}, not_passed_ids: [id диалога], low_confidence_count,
                                    overridden_count, appeals_count, appeals_changed}],
                    by_language: {lang: Slice}, by_channel: {channel: Slice},
                    critical_count, ai_critical_count, critical_ids: [id диалога], needs_review_count, review_queue_count,
                    appeals: {open, confirmed, changed}, resolved: {yes, no, unclear},
                    topics: [{topic, count, resolved_rate, avg_total, weakest: {key, title, avg_pct} | null, ids: [id диалога]}],
                    cost: {latest_usd, total_usd (все оценки группы, с повторными), evaluations_total, avg_per_dialog_usd,
                           tokens_in, tokens_out, models: [{model, count}]}}
Slice            = {conversations, count, avg_total, avg_ai_total, critical_count, needs_review_count}
ReviewItem       = {evaluation_id, conversation_id (id диалога в БД), conversation_code, group_id, channel, language,
                    criterion_key | null (null — оценка не получена), criterion_title,
                    reason: "failed" | "missing" | "appeal" | "guard" | "validator" | "low_confidence", reasons: [..], severity,
                    message, messages: [str], issues: [str], confidence, ai_answer, final_answer, appeal_id | null}
AppealRow        = Appeal + {conversation: {id, conversation_id, group_id, channel, language},
                    evaluation: {id, model, checklist_version_id, status, ai_total, final_total, critical, created_at},
                    criterion: {key, title, type, weight, scale_max, scale, allowed_answers, ai_answer, ai_points, final_answer, final_points,
                                overridden, reasoning, confidence, na_reason, advice, evidence, checked_range, issues} | null,
                    fragment: [{msg_id, idx, speaker, text, timestamp, t_sec, audio_offset_sec, internal, event,
                                is_evidence, quotes: [str], gap_before}],
                    second_opinion: SecondOpinion | null}   # последнее удавшееся
SecondOpinion    = {id, appeal_id, evaluation_id, criterion_key, provider, model, status: "done" | "failed", error, answer, reasoning, confidence,
                    evidence, na_reason, checked_range, issues, ai_answer, agrees: bool, cost_usd, tokens: [in, out], latency_ms, created_at}
Appeal           = {id, evaluation_id, criterion_key, comment, status: "open" | "confirmed" | "changed", ai_answer_snapshot,
                    decision_answer, decision_reason, created_at, decided_at}   # ответы — как в API: "yes" | "no" | "na" | int
```

## 4. Сигнатуры ядра

```python
normalize.normalize(record: dict) -> NormalizedConversation
facts.extract(conv: NormalizedConversation, settings: ChecklistSettings) -> dict[str, Fact]   # Fact = {value, msg_ids, note}
prompt_builder.build(conv, facts, criteria: list[Criterion], settings) -> tuple[list[dict], dict]   # messages, json_schema
evaluator.partition(criteria: list[Criterion], strategy: str) -> list[list[Criterion]]
judge.run(provider: LLMProvider, messages, schema, *, model) -> tuple[JudgeOutput, list[LLMCallRecord]]
validator.validate(output: dict, criteria: list[Criterion], conv) -> list[Issue]
guards.apply(answers: dict, facts: dict, criteria: list[Criterion]) -> tuple[dict, list[Issue]]
scoring.compute(checklist: Checklist, answers: dict[str, Answer]) -> ScoreResult
reuse.criterion_hash(criterion: Criterion, prompt_version: str, model: str) -> str   # только поля, которые попадают в промпт
reuse.plan(criteria: list[Criterion], previous: Evaluation | None, *, model: str, prompt_version: str) -> tuple[dict[str, CriterionResult], list[Criterion]]   # переиспользуем, вызываем
analytics.summarize(session, group_id: str | None, checklist_version_id: int | None) -> Analytics
evaluator.evaluate(conversation_pk: int, checklist_version_id: int, *, provider: str, model: str, strategy: str) -> int   # evaluation_id
appeals.decide(session, appeal_id: int, action: str, answer: Answer | None, reason: str) -> tuple[Appeal, Evaluation]
review.queue(session, group_id: str | None, version_id: int | None) -> list[ReviewItem]
manual.create(session, body: dict) -> Conversation
LLMProvider.complete(messages, *, model, json_schema, max_tokens, temperature, timeout_s) -> LLMResult
```

## 5. Экспорт (`GET /export`)

По последней оценке каждого диалога группы для версии чек-листа (по умолчанию активной); диалог без оценки — строка со `status: not_evaluated` и пустыми ответами.

CSV, UTF-8 с BOM, `;` как разделитель, запятая в дробях, строки `\r\n` (Excel в RU-локали). Колонки: `conversation_id, channel, language, checklist_version` (`default v2`), `model, status, c<key>_answer, c<key>_points …` (включённые критерии по порядку; ответ и баллы финальные, у флага баллов нет), `ai_total, final_total, critical, needs_review` (`yes`/`no`), `overridden` (коды критериев, изменённых апелляцией, через запятую), `open_appeals, cost_usd, evaluation_id`. JSON — массив тех же объектов (числа и `true/false`) плюс `criteria: [{key, title, ai_answer, ai_points, final_answer, final_points, overridden, confidence, reasoning, na_reason, advice, evidence, issues, appeal: {id, status, comment, decision_reason} | null}]` и `overview`.

Новый диалог (`POST /conversations`, FR-DATA-07): `transcript` — массив реплик API организаторов, текст или JSON строкой (массив, запись `{conversation_id, channel, language, transcript}` или набор из одной записи). Текст — по реплике в строке: `[MM:SS] роль: текст` (время необязательно); роли `client/operator/bot/system`, `клиент/оператор/бот/система`, `К`/`О`; строка без роли продолжает предыдущую реплику. `channel` по умолчанию `agent chat` (`чат`/`звонок` тоже понимаются), `language` не указан — определяется по репликам клиента, предупреждение в `warnings`. `conversation_id` не дан — `manual-001`, `manual-002`… в группе.

### 5.1 Файл сдачи (`results/<dev|prod>/results.json`, `GET /api/export/results?group_id=`)

Формат организаторов 1.0 — [`docs/task/results-format.md`](task/results-format.md). У критерия чек-листа есть `export_id` (`contact`, `discovery`, `identification`, `consultation`, `empathy`, `dialogue`, `closure`, `critical`); заменённый на контроле критерий наследует `export_id` того, что заменил. В файл идут ответы AI последней оценки со статусом `done` по активной версии чек-листа; без неё — `status: error` с причиной. `evidence_turns = idx + 1`. CLI: `python scripts/export_results.py --group <id> --out results/<dev|prod>/results.json [--expect-count 10]`, `--check <файл>` — только проверка. Заголовки ответа: `X-Validation-Errors` (ошибок проверки формата, пустой `TEAM_NAME` — ошибка), `X-Results-Ok`, `X-Results-Error` (записей ok и error). Неполная оценка (`partial`) в файле — `error` и в прогоне (`GET /runs/{id}`) считается в `failed`. Сохранение версии предупреждает, если она не ложится в формат сдачи (`warnings` с префиксом «файл сдачи:»). Прогоны `queued`/`running` при старте сервера закрываются: необработанные диалоги — `failed`.

## 6. Gold

Формат — `data/gold/README.md`. Разбиение dev/holdout — `data/gold/split.json`: `{"dev": [...], "holdout": [...]}`.

## Журнал версий

- 0.5.4 — 2026-11-07 — `POST /checklists/draft-criterion`: черновик критерия с ИИ для конструктора.

- 0.5.3 — 2026-11-07 — «Второе мнение ИИ»: `POST /appeals/{id}/second-opinion`, `second_opinion` в `AppealRow`, таблица `appeal_second_opinion`.

- 0.5.2 — 2026-11-07 — заголовки `X-Results-Ok`/`X-Results-Error` у файла сдачи, `partial` считается ошибкой прогона, закрытие прерванных прогонов при старте, предупреждения о формате сдачи при сохранении версии.

- 0.5.1 — 2026-11-07 — импорт из интерфейса: `organizer_api` в `GET /health`, лимит 25 МБ у `POST /datasets/upload` (413), тексты ошибок импорта без адреса API.

- 0.5 — 2026-11-07 — этап 4: апелляции (`AppealRow` с фрагментом, `allowed_answers` и `appeal_history` у критерия, `open_appeals`/`appeals` в списке), `Analytics`, `ReviewItem` с причинами `failed`/`missing`/`appeal`, экспорт CSV/JSON (§5), правила вставки диалога и поправки записи.

- 0.4 — 2026-11-07 — формат сдачи организаторов: `export_id` у критерия, `results.json` 1.0, `GET /api/export/results`.

- 0.3 — 2026-11-07 — `ConversationDetail` по факту бэкенда, `scale_max` в `CriterionResult`, `needs_review` в `Evaluation`, `errors` у 422.
- 0.2 — 2026-11-07 — уточнение организаторов: `confidence`, `advice`, `overview` в ответе LLM; `quote_threshold` по каналу; вставка диалога, оценка стоимости, `reuse` в запуске, аналитика, очередь «требует проверки».
- 0.1 — 2026-11-07 — первая версия: чек-лист, схема ответа LLM, API, сигнатуры, экспорт.
