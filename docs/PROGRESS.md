# PROGRESS

Статус работы. Подключён в `CLAUDE.md`, обновляется после каждого шага.

## Сейчас
Фаза 0 закрыта (M0): ТЗ, архитектура, контракты v0.1, ADR-001…013, пошаговый план и ответы Лиды (`docs/README.md` — карта). Сдаём репозиторий, презентацию и описание. Следующее — этап 1 по `docs/PLAN.md`, по сигналу Лиды.

## Готово
- 2026-11-07 — среда: CLAUDE.md (работа вдвоём, OpenRouter + Gemini), `docs/MEMORY.md`, подагенты, скелет FastAPI (`/api/health`), `scripts/fetch_dataset.py`, `scripts/render_dataset.py`, `docs/checklist.md`, `docs/task/`, pytest зелёный.
- 2026-11-07 — облачная среда `Freedom-DataChallenge26` (OpenRouter + API организаторов, установка зависимостей при старте).
- 2026-11-07 — черновик исследования данных: `docs/research/01-data-overview.md`.
- 2026-11-07 — учтено уточнение организаторов: ТЗ v0.3 (FR-EVAL-16…20, FR-CHK-10, раздел 5.10 ANL/UX, NFR-13, 14), контракты v0.2, план v0.3 (35 шагов, около половины — интерфейс и доп. функции).
- 2026-11-07 — ТЗ `docs/spec/requirements.md` (FR/NFR с ID), архитектура `docs/architecture/*`, `docs/CONTRACTS.md` v0.1, ADR-001…012, `docs/PLAN.md` (вехи M0–M6), сценарий демо, открытые вопросы.

## Ждёт Лиду
- Q-07: информация от организаторов о формате результатов (если появится).
- Ключи: в `.env` на ноутбуке есть; в облачной среде `Freedom-DataChallenge26` — network secrets для openrouter.ai и generativelanguage.googleapis.com (Bearer). Ключи, засвеченные в чате, Лиде нужно заменить.


## Сломано / ограничения
- В Default-среде закрыты `openrouter.ai`, API организаторов и Gemini. Gemini (`generativelanguage.googleapis.com`) ещё не добавлен и в среду `Freedom-DataChallenge26`.

## Дальше
См. `docs/PLAN.md`. Ближайшее: этап 1 (шаги 1–5).

- [x] Обсудить 01 → решения в `docs/DECISIONS.md`.
- [x] `docs/architecture/` + `docs/CONTRACTS.md` v0.1.
- [x] Ответы Лиды: Q-01, 03, 05, 08, 11, 12, 13, 16. Открыт только Q-07 (ждём информацию от организаторов).
- [ ] Смоук моделей (после ключей) → bake-off на M2 (`docs/architecture/llm-and-models.md`).
- [ ] Этап 1: фундамент (бэкенд, `scoring`, провайдеры, факты, фронт на фикстурах, черновик gold на 24).
