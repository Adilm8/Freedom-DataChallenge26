from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .config import settings

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(title="CQA — Conversation Quality Analytics")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "provider": settings.llm_provider, "group_id": settings.dataset_group_id}


# Статика фронта монтируется последней, чтобы не перекрывать /api/*.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
