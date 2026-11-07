# PROGRESS

Статус работы. Подключён в `CLAUDE.md`, обновляется после каждого шага.

## Сейчас
Фаза 0 — совместное исследование. Код решения не пишем, пока не утверждена архитектура.

## Готово
- 2026-11-07 — среда: CLAUDE.md (работа вдвоём, OpenRouter + Gemini), `docs/MEMORY.md`, подагенты, скелет FastAPI (`/api/health`), `scripts/fetch_dataset.py`, `scripts/render_dataset.py`, `docs/checklist.md`, `docs/task/`, pytest зелёный.
- 2026-11-07 — облачная среда `Freedom-DataChallenge26` (OpenRouter + API организаторов, установка зависимостей при старте).
- 2026-11-07 — черновик исследования данных: `docs/research/01-data-overview.md`.

## Ждёт Лиду
- Ключи `OPENROUTER_API_KEY`, `GEMINI_API_KEY` в `.env`. Облако: Network secrets среды `Freedom-DataChallenge26`.
- Ответы на вопросы в конце `docs/research/01-data-overview.md`.

## Сломано / ограничения
- В Default-среде закрыты `openrouter.ai`, API организаторов и Gemini. Gemini (`generativelanguage.googleapis.com`) ещё не добавлен и в среду `Freedom-DataChallenge26`.

## Дальше
- [ ] Обсудить 01 → решения в `docs/DECISIONS.md`.
- [ ] 02-models: короткий тест 2–3 моделей на KZ и звонке (после ключей).
- [ ] `docs/architecture/` + `docs/CONTRACTS.md`.
- [ ] План gold-разметки: какие 20–25 диалогов, черновик моделью.
