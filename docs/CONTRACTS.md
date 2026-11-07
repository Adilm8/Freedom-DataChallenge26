# CONTRACTS

Заполняет оркестратор до начала реализации (CLAUDE.md → «Контракты — до кода»).

## 1. `data/checklist_default.json`
TODO

## 2. JSON-схема ответа LLM (по одному критерию)
TODO — порядок полей: `reasoning` → `answer` → `evidence` (`m<idx>`) → `quote` → `checked_range`.

## 3. API
- `GET /api/health` → `{"status": "ok", "provider": str, "group_id": str}` (готово)
- `GET /api/conversations` — TODO
- `GET /api/conversations/{id}` — TODO
- `POST /api/evaluations` — TODO
- `GET/POST /api/checklists` — TODO
- `POST /api/appeals`, `POST /api/appeals/{id}/decision` — TODO

## 4. Сигнатуры
- `scoring.compute_total(...)` — TODO
- `LLMProvider.complete(...)` — TODO
