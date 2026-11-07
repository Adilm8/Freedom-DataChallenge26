# PROGRESS

Статус работы. Подключён в `CLAUDE.md`, обновляется после каждого шага.

## Сейчас
Фаза 0 закрывается: ТЗ, архитектура, контракты v0.1, ADR и план готовы (`docs/README.md` — карта). Ждём ответы Лиды на открытые вопросы (`docs/spec/open-questions.md`), затем Ф1 по `docs/PLAN.md`.

## Готово
- 2026-11-07 — среда: CLAUDE.md (работа вдвоём, OpenRouter + Gemini), `docs/MEMORY.md`, подагенты, скелет FastAPI (`/api/health`), `scripts/fetch_dataset.py`, `scripts/render_dataset.py`, `docs/checklist.md`, `docs/task/`, pytest зелёный.
- 2026-11-07 — облачная среда `Freedom-DataChallenge26` (OpenRouter + API организаторов, установка зависимостей при старте).
- 2026-11-07 — черновик исследования данных: `docs/research/01-data-overview.md`.
- 2026-11-07 — ТЗ `docs/spec/requirements.md` (FR/NFR с ID), архитектура `docs/architecture/*`, `docs/CONTRACTS.md` v0.1, ADR-001…012, `docs/PLAN.md` (вехи M0–M6), сценарий демо, открытые вопросы.

## Ждёт Лиду
- Ответы на открытые вопросы — `docs/spec/open-questions.md`.
- Ключи: в `.env` на ноутбуке есть; в облачной среде `Freedom-DataChallenge26` — network secrets для openrouter.ai и generativelanguage.googleapis.com (Bearer). Ключи, засвеченные в чате, Лиде нужно заменить.


## Сломано / ограничения
- В Default-среде закрыты `openrouter.ai`, API организаторов и Gemini. Gemini (`generativelanguage.googleapis.com`) ещё не добавлен и в среду `Freedom-DataChallenge26`.

## Дальше
См. `docs/PLAN.md`. Ближайшее: M0 → Ф1.

- [x] Обсудить 01 → решения в `docs/DECISIONS.md`.
- [x] `docs/architecture/` + `docs/CONTRACTS.md` v0.1.
- [ ] Ответы Лиды: Q-01, 03, 05, 07, 08, 11, 12, 16 (`docs/spec/open-questions.md`).
- [ ] Смоук моделей (после ключей) → bake-off на M2 (`docs/architecture/llm-and-models.md`).
- [ ] Ф1: фундамент (бэкенд, `scoring`, провайдеры, факты, фронт на фикстурах, черновик gold на 24).
