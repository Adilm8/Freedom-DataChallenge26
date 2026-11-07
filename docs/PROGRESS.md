# PROGRESS

Память между сессиями. Обновляется после каждого шага (см. CLAUDE.md).

## Готово
- 2026-11-07 — среда: CLAUDE.md, `.claude/agents/`, скелет `backend/` (FastAPI, `/api/health`), `frontend/index.html`, `scripts/fetch_dataset.py`, `docs/checklist.md`, `.env.example`, pytest зелёный.
- Снапшот DEV: `data/raw/DEV.json` (65 записей; в git не коммитится).

## Сломано / ограничения
- Облачный контейнер Claude Code не видит хост API организаторов (`*.powerplatform.com`, прокси 403). В облаке работать от снапшота, живые запросы — с ноутбука или после добавления домена в allowlist окружения.

## Дальше (Час 0–2)
- [ ] `docs/CONTRACTS.md` — заполнить схемы.
- [ ] `data/checklist_default.json` из `docs/checklist.md`.
- [ ] `backend/app/services/scoring.py` + тесты (пример 94.38 из `docs/checklist.md`).
- [ ] Быстрый тест моделей на KZ-диалогах (`llm-eval-engineer`).
- [ ] Команда: начать gold-разметку `data/gold_labels.json`.
