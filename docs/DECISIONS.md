# DECISIONS

Формат: дата — решение — причина.

- 2026-11-07 — Снапшоты наборов (`data/raw/*.json`) не коммитятся. Причина: в DEV есть 5 реальных звонков и подписанные ссылки на записи, а репозиторий будет публичным. Загрузка: `scripts/fetch_dataset.py`.
- 2026-11-07 — URL API организаторов хранится только в `.env` (`ORGANIZER_API_URL`): в нём подпись `sig`, по сути ключ.
- 2026-11-07 — Python 3.11 (`.python-version`), окружение через `uv venv`.
- 2026-11-07 — Не передаём `temperature` в Claude API: на актуальных моделях (Opus 5.5, Sonnet 5.5, Haiku 5.5) нестандартные sampling-параметры дают 400. Валидный JSON — через structured outputs (`output_config.format`), цитаты проверяет код. Для Ollama `temperature: 0` остаётся.
