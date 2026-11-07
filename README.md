# Freedom-DataChallenge26 — CQA (Conversation Quality Analytics)

Прототип оценки качества диалогов операторов Freedom Broker по настраиваемому чек-листу: баллы с обоснованием и репликой-доказательством, апелляция и пересмотр оценки.

> Статус: подготовлена среда и скелет проекта. Ход работы — `docs/PROGRESS.md`.

## Запуск

Нужны Python 3.11 и [uv](https://docs.astral.sh/uv/) (или обычный `venv` + `pip`).

```bash
uv venv -p 3.11 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env              # вписать ORGANIZER_API_URL и ANTHROPIC_API_KEY
python scripts/fetch_dataset.py   # снапшот DEV → data/raw/DEV.json
uvicorn backend.app.main:app --reload
```

Открыть http://localhost:8000. Проверка: `curl localhost:8000/api/health`, тесты — `pytest -q`.

Локальная модель (опционально): установить [Ollama](https://ollama.com), `ollama pull qwen3:8b`, в `.env` указать `LLM_PROVIDER=local`.

## Структура

```
backend/app/     FastAPI: config, api/, services/ (scoring, evaluator), providers/ (Claude API, Ollama)
frontend/        чистый HTML/CSS/JS, компоненты монтируются в <div> (задел под Dynamics 365)
data/            чек-листы, gold-разметка; data/raw/ — снапшоты наборов (не в git)
eval/            run_eval.py — сравнение с gold-разметкой
docs/            чек-лист (PDF + docs/checklist.md), CONTRACTS, DECISIONS, PROGRESS
scripts/         fetch_dataset.py — загрузка набора по group_id
.claude/agents/  подагенты Claude Code для команды
```
