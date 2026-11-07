# Архитектура: обзор

> Статус: черновик v0.1 · Обновлено: 2026-11-07 · Владелец: команда · Утверждает: Лида
> Требования — [`../spec/requirements.md`](../spec/requirements.md). Схемы и API — [`../CONTRACTS.md`](../CONTRACTS.md). Решения — [`../DECISIONS.md`](../DECISIONS.md).

## 1. В одном абзаце

Монолит на FastAPI: импортирует диалоги, хранит всё в SQLite, раздаёт статический фронт. Оценка диалога — конвейер из пяти шагов: **нормализация → факты (код) → судья (LLM) → проверка (код) → баллы (код)**. LLM только выбирает ответ из разрешённых вариантов и цитирует реплики. Всё, что может поменяться за час (критерии, промпт, модель, стратегия вызовов, словари фраз), лежит в данных или конфиге, а не в коде.

## 2. Компоненты

```
 Браузер (HTML/CSS/JS, ES-модули, без сборки)
 ┌──────────────────────────────────────────────────────────────────┐
 │ Список │ Карточка (транскрипт, результат, плеер) │ Апелляции │ Чек-лист │ Качество │
 └───────────────────────────┬──────────────────────────────────────┘
                             │ fetch через js/api.js (base URL настраивается)
 FastAPI ────────────────────▼──────────────────────────────────────
 api/      datasets · conversations · checklists · runs · evaluations · appeals · export · meta
 services/ ingest → normalize → facts → prompt_builder → judge → validator → guards → scoring
           evaluator (оркестрация, стратегии)   appeals (решение → пересчёт)   export
 providers/ LLMProvider: openrouter · gemini · ollama (OpenAI-совместимый API, SDK openai)
 db/       SQLModel + SQLite (JSON-колонки для гибких полей)
 ────────────────────────────────────────────────────────────────────
   │ httpx                         │ HTTPS
   ▼                               ▼
 API организаторов (group_id)    OpenRouter / Gemini / Ollama
```

## 3. Модули бэкенда

Каждый модуль — одна ответственность и чистый интерфейс. Модули из `services/`, кроме `evaluator` и `appeals`, не знают о БД и HTTP: получают данные, возвращают данные. Это то, что делает их легко заменяемыми и тестируемыми.

| Модуль | Отвечает за | Вход → выход | Чистая функция |
|---|---|---|---|
| `services/ingest.py` | Загрузка из API или файла, upsert в БД | `group_id` / файл → записи `conversation` | нет |
| `services/normalize.py` | `msg_id`, `t_sec`, роли, сегменты звонка | сырой транскрипт → `NormalizedConversation` | да |
| `services/facts/` | Реестр извлекателей фактов (по файлу на тему) | `NormalizedConversation` → `Facts` | да |
| `services/prompt_builder.py` | Сборка сообщений и JSON-схемы из шаблонов и чек-листа | диалог, факты, критерии → `messages`, `schema` | да |
| `services/judge.py` | Вызов провайдера, разбор JSON, ретрай | `messages`, `schema` → `JudgeOutput` + `LLMCall` | нет (сеть) |
| `services/validator.py` | Проверка ответа, `msg_id`, цитат, N/A | `JudgeOutput`, критерий, диалог → `issues[]` | да |
| `services/guards.py` | Правила-страховки из конфига критерия (C) | ответ, факты, правила → ответ, `flags[]` | да |
| `services/scoring.py` | Баллы, N/A, секции, итог, флаги | чек-лист, ответы → `ScoreResult` | да |
| `services/evaluator.py` | Конвейер целиком, стратегии, параллельность, запись в БД | диалог, версия, модель → `evaluation` | нет |
| `services/appeals.py` | Апелляция, решение, пересчёт финального итога | решение → обновлённые `final_*` | нет |
| `services/export.py` | JSON/CSV по группе | фильтры → файл | да |
| `services/reuse.py` | Хеш критерия и план переиспользования ответов (FR-CHK-10) | критерии, прошлая оценка → переиспользуем / вызываем | да |
| `services/analytics.py` | Агрегаты для дашборда, очередь «требует проверки», оценка стоимости запуска | группа → `Analytics`, `[ReviewItem]` | нет (БД) |
| `providers/` | `LLMProvider.complete()`, цена, лимиты, запрет звонков в Gemini free | сообщения → `LLMResult` | нет (сеть) |
| `prompts/*.md` | Тексты промптов как шаблоны | — | данные |
| `data/config/*.json` | Словари: системные события, приветствия, прощания, фразы ожидания, рискованные слова (RU/KZ/EN) | — | данные |
| `data/checklists/default.json` | Чек-лист по умолчанию (seed) | — | данные |

Подробности по ядру — [`evaluation-pipeline.md`](evaluation-pipeline.md), по таблицам — [`data-model.md`](data-model.md), по фронту — [`frontend.md`](frontend.md), по моделям — [`llm-and-models.md`](llm-and-models.md), по метрикам — [`quality-eval.md`](quality-eval.md).

## 4. Структура каталогов (целевая)

```
backend/app/
  main.py  config.py  db.py  models.py  schemas.py
  api/        datasets.py conversations.py checklists.py runs.py evaluations.py appeals.py export.py meta.py analytics.py
  services/   ingest.py normalize.py prompt_builder.py judge.py validator.py guards.py scoring.py
              evaluator.py appeals.py export.py reuse.py analytics.py
              facts/  __init__.py (реестр) timing.py events.py greeting.py language.py risk_terms.py
  providers/  base.py openai_compat.py pricing.py
  prompts/    system.md channel_voice.md output_rules.md VERSION (транскрипт и критерии собирает prompt_builder.py)
data/
  checklists/default.json   config/lexicons.json  config/system_events.json
  gold/gold_labels.json     raw/ (не в git)  cqa.db (не в git)
eval/         run_eval.py  runs/ (не в git)
scripts/      fetch_dataset.py render_dataset.py model_smoke.py reset_db.py
frontend/
  index.html                        оболочка с навигацией (hash-роутинг)
  pages/*.html                      по странице на компонент — заготовка под web resource D365
  js/api.js  js/app.js  js/ui.js    клиент API, роутер, мелкие утилиты
  js/components/*.js                каждый экспортирует mount(el, params)
  css/cqa.css                       переменные темы, префикс cqa-
tests/        test_scoring.py test_normalize.py test_facts.py test_validator.py test_api_*.py
```

## 5. Принципы, которые дают гибкость

1. **Контракт до кода.** API, схемы и сигнатуры — в `CONTRACTS.md` с версией. Фронт и бэк можно делать параллельно: фронт сначала работает на фикстурах `frontend/fixtures/*.json`, совпадающих с контрактом.
2. **Данные вместо кода.** Критерии, инструкции «Да, когда…», шкалы, правила-страховки, словари фраз и тексты промптов — данные. Код не ветвится по коду критерия (`if key == "07"` запрещено, [ADR-003](../decisions/ADR-003-checklist-as-data.md)).
3. **Чистое ядро.** `normalize`, `facts`, `prompt_builder`, `validator`, `guards`, `scoring` — чистые функции с тестами на фикстурах. Их можно переписать за минуты, не трогая БД и API.
4. **Стратегия — параметр.** Как разбивать критерии на вызовы LLM (`single`, `grouped`, `per_criterion`) — настройка, а не отдельная реализация ([ADR-002](../decisions/ADR-002-call-strategy.md)). Модель и провайдер — `.env` или параметр запуска.
5. **Гибкое хранение.** Стабильные поля — колонки, всё изменчивое (ответ модели, доказательства, факты, тело чек-листа) — JSON-колонки. Новое поле результата не требует миграции. Схема БД поменялась — `reset_db` + реимпорт + перезапуск оценки, это минуты ([ADR-004](../decisions/ADR-004-storage-sqlite-json.md)).
6. **Версии вместо перезаписи.** Чек-лист версионируется, AI-оценка неизменна, решения проверяющего — отдельные записи. Любое изменение можно откатить и показать жюри «до/после».
7. **Метрика решает.** Любое изменение промпта, модели или стратегии проходит `run_eval.py` до и после. Победитель фиксируется в ADR.

## 6. Карта изменений: что где менять

| Что меняется | Где меняем | Что ещё проверить | Время |
|---|---|---|---|
| Формулировка, вес, тип, шкала, N/A критерия; новый критерий | UI «Чек-лист» → новая версия → «Применить» | ничего в коде | 2–5 мин |
| Общие правила оценки («Нет» против N/A, только оператор) | `backend/app/prompts/system.md`, поднять `PROMPT_VERSION` | `run_eval` до/после | 10 мин |
| Правила для звонков (устная речь) | `backend/app/prompts/channel_voice.md`, поднять `PROMPT_VERSION` | `run_eval` по звонкам | 10 мин |
| Модель или провайдер | `.env`: `LLM_PROVIDER`, `*_MODEL` или выбор при запуске | `run_eval`, цена в `pricing.py` если провайдер не вернул | 2 мин |
| Стратегия вызовов | `.env` `EVAL_STRATEGY` или параметр запуска | `run_eval` | 1 мин |
| Новая фраза системного события или приветствия | `data/config/system_events.json`, `lexicons.json` | `pytest tests/test_facts.py` | 5 мин |
| Новый факт | файл в `services/facts/` + регистрация | тест на фикстуре | 20–30 мин |
| Правила расчёта (округление, политика флага, секции) | `scoring.py` + `checklist.settings` | `pytest tests/test_scoring.py` | 15 мин |
| Новый формат входных данных | адаптер в `ingest.py` → тот же `conversation` | импорт DEV и контроль | 20 мин |
| Новое поле в результате критерия | `schemas.py` + JSON-колонка + рендер в `result-panel.js` | контракт | 15 мин |
| Новый экран | `js/components/x.js` + `pages/x.html` + маршрут | — | 30–60 мин |
| Схема таблиц | `models.py` → `scripts/reset_db.py` → реимпорт | ADR | 10 мин |

## 7. Поток данных одного запуска

1. `POST /api/runs` с `conversation_ids` или `group_id`, `checklist_version_id`, необязательно `model` и `strategy` → создаётся `evaluation_run`, ответ сразу.
2. Фоновая задача берёт диалоги параллельно (семафор, по умолчанию 4) и для каждого вызывает `evaluator.evaluate()`.
3. `evaluate`: нормализация → факты → разбиение критериев по стратегии → вызовы судьи параллельно → проверка (с одним ретраем) → страховки → баллы → запись `evaluation`, `criterion_result`, `llm_call`.
4. Фронт опрашивает `GET /api/runs/{id}` раз в 1–2 с и обновляет список.
5. Апелляция и решение меняют только `final_*` и пересчитывают финальный итог тем же `scoring`.

Очередей и воркеров нет: 75 диалогов за хакатон, хватает задач внутри процесса ([ADR-008](../decisions/ADR-008-background-runs.md)).

## Журнал изменений

- 2026-11-07 — v0.2: модули `reuse` и `analytics`, шаблон `channel_voice.md`.
- 2026-11-07 — v0.1, первая версия.
