# CONTRACTS

> Версия: **0.1 (черновик)** · Обновлено: 2026-11-07 · Владелец: Claude
> Контракт — это то, на что опираются параллельно фронт, бэк, eval и подагенты. Меняем только с записью в «Журнал версий» внизу. Несовместимое изменение → поднять минорную версию и предупредить в `PROGRESS.md`.
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

Все ответы JSON, ошибки — `{"detail": str}` с кодом 4xx/5xx; у 422 невалидного чек-листа дополнительно `errors: [{path, message}]`. Префикс `/api`. Маршруты фронта и `/conversations/{id}` используют суррогатный числовой `id`.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /health` | — | `{status, provider, model, group_id}` |
| `POST /datasets/import` | `{group_id}` | `{group_id, imported, updated, warnings[]}` |
| `POST /datasets/upload` | файл JSON (формат API организаторов) | то же |
| `GET /conversations` | `?group_id&language&channel&critical&appeal&checklist_version_id` | `[ConversationRow]` |
| `POST /conversations` | `{group_id?: "MANUAL", conversation_id?, channel, language, transcript: [] \| text}` (текст — строки `роль: текст`) | `ConversationDetail` (FR-DATA-07) |
| `GET /conversations/{id}` | — | `ConversationDetail` (транскрипт с `msg_id`, `t_sec`, `audio_offset_sec`; список оценок) |
| `PATCH /conversations/{id}` | `{audio_offset_fix_sec}` | `ConversationDetail` |
| `GET /conversations/{id}/audio` | — | прокси записи (если браузер не может открыть `audio_url` напрямую) |
| `GET /checklists` | — | `[{id, key, version, name, note, is_active, created_at}]` |
| `GET /checklists/{version_id}` | — | `{id, key, version, ..., body}` |
| `POST /checklists` | `{body, note, parent_id?, activate?: bool}` | версия; 422 с `[{path, message}]`, если невалидно |
| `POST /checklists/{version_id}/activate` | — | версия |
| `POST /runs` | `{conversation_ids? \| group_id, checklist_version_id?, provider?, model?, strategy?, reuse?: "auto" \| "none"}` | `{run_id}` (202); `reuse: auto` — инкрементальная переоценка (FR-CHK-10), «Оценить повторно» = те же параметры и `reuse: none` |
| `POST /runs/estimate` | то же тело, что у `POST /runs` | `{dialogs, dialogs_with_calls, calls, tokens_in, tokens_out, cost_usd \| null, seconds, cost_source: history \| pricing \| unknown}`; LLM не вызывается (FR-UX-03) |
| `GET /meta/facts` | — | `{labels: {имя факта: подпись}}` |
| `POST /runs/estimate` | то же, что `POST /runs` | `{calls, tokens_in, tokens_out, cost_usd, seconds}` (FR-UX-03) |
| `GET /runs/{run_id}` | — | `{status, total, done, failed, cost_usd, started_at, finished_at}` |
| `GET /evaluations/{id}` | — | `Evaluation` |
| `GET /evaluations/{id}/calls` | — | `[LLMCall]` с сырыми ответами |
| `POST /appeals` | `{evaluation_id, criterion_key, comment}` | `Appeal`; 409, если уже есть открытая |
| `GET /appeals` | `?status=open` | `[AppealRow]` (с фрагментом диалога) |
| `POST /appeals/{id}/decision` | `{action: "confirm" \| "change", answer?, reason}` | `{appeal, evaluation}` (с пересчитанным `final_score`) |
| `GET /export` | `?group_id&checklist_version_id&format=json\|csv` | файл |
| `GET /analytics` | `?group_id&checklist_version_id` | `Analytics` (FR-ANL-01) |
| `GET /review-queue` | `?group_id` | `[ReviewItem]` (FR-UX-02) |
| `GET /meta/models` | — | настроенные провайдеры и модели, стратегия по умолчанию |
| `GET /gold/{conversation_id}`, `PUT /gold/{conversation_id}` | разметка по формату `data/gold/README.md` | для экрана gold-разметки (только DEV) |

Основные объекты:

```text
ConversationRow  = {id, conversation_id, group_id, channel, language, latest: {evaluation_id, ai_total, final_total, critical, needs_review, open_appeals} | null}
ConversationDetail = {id, conversation_id, group_id, channel, language, has_audio, audio_url (путь прокси `/api/conversations/{id}/audio`, исходная подписанная ссылка в браузер не уходит), source, audio_offset_fix_sec, imported_at,
                    messages: [{msg_id, idx, speaker, text, timestamp, t_sec, audio_offset_sec, internal, event}],
                    segments: [{type, start_idx, end_idx, start_sec, end_sec}], events: [{type, idx, msg_id, t_sec, text}], warnings: [str],
                    evaluations: [{id, model, checklist_version_id, ai_total, final_total, created_at}]}
Evaluation       = {id, conversation_id, checklist_version_id, provider, model, strategy, prompt_version, status, needs_review,
                    facts, overview: {summary, topic, resolved} | null, params: {temperature, seed, reuse},
                    ai_score: ScoreResult, final_score: ScoreResult, criteria: [CriterionResult],
                    tokens_in, tokens_out, cost_usd, latency_ms, created_at}
CriterionResult  = {key, title, section, type, weight, scale_max, ai_answer, ai_points, final_answer, final_points, overridden,
                    reasoning, confidence, advice, evidence: [{msg_id, quote, quote_ok}], checked_range: {from, to} | null, na_reason, issues: [str],
                    reused_from_evaluation_id: int | null,
                    appeal: Appeal | null}
ScoreResult      = {total: float | null, applicable_weight, points_sum, sections: [{id, title, points, applicable_weight, pct}],
                    criteria: {key: {points, contribution}}, critical: [key]}
Analytics        = {count, avg_total, histogram: [{from, to, count}], by_criterion: [{key, title, pass_rate, avg_pct, na_rate}],
                    by_language: {lang: {count, avg_total}}, by_channel: {...}, critical_count, needs_review_count, topics: [{topic, count, resolved_rate}]}
ReviewItem       = {evaluation_id, conversation_id, criterion_key, reason: "low_confidence" | "validator" | "guard", issues: [str]}
Appeal           = {id, evaluation_id, criterion_key, comment, status, ai_answer_snapshot, decision_answer, decision_reason, created_at, decided_at}
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
analytics.summarize(group_id: str, checklist_version_id: int | None) -> Analytics
evaluator.evaluate(conversation_pk: int, checklist_version_id: int, *, provider: str, model: str, strategy: str) -> int   # evaluation_id
appeals.decide(appeal_id: int, action: str, answer: Answer | None, reason: str) -> Evaluation
LLMProvider.complete(messages, *, model, json_schema, max_tokens, temperature, timeout_s) -> LLMResult
```

## 5. Экспорт (`GET /export`)

CSV, UTF-8 с BOM, `;` как разделитель (Excel в RU-локали). Колонки: `conversation_id, channel, language, checklist_version, model, c<key>_answer, c<key>_points …, ai_total, final_total, critical, cost_usd`. JSON — массив тех же объектов плюс обоснования.

### 5.1 Файл сдачи (`results/<dev|prod>/results.json`, `GET /api/export/results?group_id=`)

Формат организаторов 1.0 — [`docs/task/results-format.md`](task/results-format.md). У критерия чек-листа есть `export_id` (`contact`, `discovery`, `identification`, `consultation`, `empathy`, `dialogue`, `closure`, `critical`); заменённый на контроле критерий наследует `export_id` того, что заменил. В файл идут ответы AI последней оценки со статусом `done` по активной версии чек-листа; без неё — `status: error` с причиной. `evidence_turns = idx + 1`. CLI: `python scripts/export_results.py --group <id> --out results/<dev|prod>/results.json [--expect-count 10]`, `--check <файл>` — только проверка.

## 6. Gold

Формат — `data/gold/README.md`. Разбиение dev/holdout — `data/gold/split.json`: `{"dev": [...], "holdout": [...]}`.

## Журнал версий

- 0.4 — 2026-11-07 — формат сдачи организаторов: `export_id` у критерия, `results.json` 1.0, `GET /api/export/results`.

- 0.3 — 2026-11-07 — `ConversationDetail` по факту бэкенда, `scale_max` в `CriterionResult`, `needs_review` в `Evaluation`, `errors` у 422.
- 0.2 — 2026-11-07 — уточнение организаторов: `confidence`, `advice`, `overview` в ответе LLM; `quote_threshold` по каналу; вставка диалога, оценка стоимости, `reuse` в запуске, аналитика, очередь «требует проверки».
- 0.1 — 2026-11-07 — первая версия: чек-лист, схема ответа LLM, API, сигнатуры, экспорт.
