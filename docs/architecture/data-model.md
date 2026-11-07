# Модель данных

> Статус: черновик v0.1 · Обновлено: 2026-11-07 · Владелец: Claude · Утверждает: Лида
> SQLite + SQLModel ([ADR-004](../decisions/ADR-004-storage-sqlite-json.md)). Стабильные поля — колонки, изменчивые — JSON. Миграций нет: схема поменялась → `scripts/reset_db.py` → реимпорт → перезапуск оценки.

## Схема

```
dataset_import 1─* conversation 1─* evaluation *─1 checklist_version
                                     │  └─* criterion_result 1─* appeal
                                     ├─* llm_call
evaluation_run 1─* evaluation
```

## Таблицы

### `conversation`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | суррогатный |
| `group_id` | str | `DEV`, контрольный; индекс |
| `conversation_id` | str | из набора; уникален вместе с `group_id` |
| `channel`, `language` | str | как в наборе |
| `audio_url` | str? | у звонков |
| `transcript` | JSON | исходный массив без изменений |
| `normalized` | JSON | `msg_id`, `t_sec`, `internal`, сегменты (пересчитывается из `transcript`) |
| `audio_offset_fix_sec` | float | ручная поправка смещения записи, по умолчанию 0 |
| `imported_at` | datetime | |

### `checklist_version`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `checklist_key` | str | `default` или имя нового чек-листа |
| `version` | int | растёт в пределах `checklist_key` |
| `name`, `note` | str | заметка «что изменили» |
| `body` | JSON | весь чек-лист по `CONTRACTS.md` §1 |
| `body_hash` | str | чтобы не плодить одинаковые версии |
| `is_active` | bool | одна активная на `checklist_key` |
| `parent_id` | int? | от какой версии сделана |
| `created_at` | datetime | |

Версия неизменяема. «Редактирование» в UI = новая версия с `parent_id`.

### `evaluation_run`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `group_id`, `checklist_version_id` | | |
| `provider`, `model`, `strategy`, `prompt_version` | str | параметры запуска |
| `status` | str | `queued / running / done / failed / partial` |
| `total`, `done`, `failed` | int | для прогресса |
| `cost_usd`, `started_at`, `finished_at` | | сводка |

### `evaluation`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `conversation_pk`, `checklist_version_id`, `run_id?` | FK | |
| `provider`, `model`, `strategy`, `prompt_version` | str | для честности процесса (FR-EVAL-06) |
| `status` | str | `done / partial / failed` |
| `facts` | JSON | что код передал модели |
| `ai_score` | JSON | `ScoreResult` по ответам AI: итог, секции, применимый вес, флаги |
| `final_score` | JSON | то же с решениями по апелляциям; сначала копия `ai_score` |
| `ai_total`, `final_total` | float? | дублируем из JSON для сортировки в списке |
| `critical` | bool | есть ли флаг грубой ошибки (по финальным ответам) |
| `needs_review` | bool | есть предупреждения валидатора |
| `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms` | | сумма по вызовам |
| `created_at` | datetime | |

Новая оценка того же диалога (другая версия или модель) — новая строка. Список показывает последнюю по выбранной версии чек-листа.

### `criterion_result`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `evaluation_id` | FK | |
| `criterion_key` | str | код из версии чек-листа |
| `ai_answer` | str | `yes / no / na / <ступень>` |
| `ai_points` | float? | баллы до перераспределения |
| `reasoning`, `na_reason` | str? | |
| `evidence` | JSON | `[{msg_id, quote, quote_ok}]` |
| `checked_range` | JSON? | `{from, to}` |
| `issues` | JSON | предупреждения валидатора и страховок |
| `final_answer`, `final_points` | | меняются только решением по апелляции |
| `overridden` | bool | |

### `llm_call`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `evaluation_id` | FK | |
| `criteria_keys` | JSON | какие критерии в этом вызове |
| `attempt` | int | 1 или 2 (ретрай) |
| `provider`, `model` | str | фактическая модель из ответа |
| `request` | JSON | сообщения и параметры (без ключей) |
| `response_raw` | text | сырой ответ |
| `finish_reason`, `error` | str? | |
| `tokens_in`, `tokens_out`, `cached_tokens`, `cost_usd`, `latency_ms` | | |
| `created_at` | datetime | |

### `appeal`
| Поле | Тип | Заметка |
|---|---|---|
| `id` | int PK | |
| `evaluation_id`, `criterion_key` | | одна открытая апелляция на критерий |
| `comment` | str | от аналитика |
| `status` | str | `open / confirmed / changed` |
| `ai_answer_snapshot` | str | что оспаривали |
| `decision_answer`, `decision_reason` | str? | от проверяющего; причина обязательна |
| `created_at`, `decided_at` | datetime | |

Решение по апелляции: записываем решение → обновляем `criterion_result.final_*` → пересчитываем `evaluation.final_score` через `scoring` (FR-APL-04). AI-поля не трогаем (FR-APL-05).

## Что не храним в git

`data/cqa.db`, `data/raw/*.json` (в DEV реальные звонки и подписанные ссылки), `eval/runs/`.

## Журнал изменений

- 2026-11-07 — v0.1, первая версия.
