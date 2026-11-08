#!/bin/sh
# Первый запуск: если набор ещё не импортирован — скачать DEV из API организаторов и импортировать.
# Без ORGANIZER_API_URL сервер всё равно стартует (экраны на ?mock=1).
set -e
mkdir -p /app/var
if [ ! -f /app/var/.imported ]; then
  if [ -f data/raw/DEV.json ] || python scripts/fetch_dataset.py; then
    python scripts/reset_db.py --import data/raw/DEV.json && touch /app/var/.imported
  else
    echo "DEV не загружен (нет ORGANIZER_API_URL?) — сервер стартует без диалогов"
  fi
fi
exec uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
