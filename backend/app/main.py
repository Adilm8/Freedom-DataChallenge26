from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, func, select

from . import db
from .api import audio as audio_api
from .api import checklists as checklists_api
from .api import conversations as conversations_api
from .api import datasets as datasets_api
from .api import evaluations as evaluations_api
from .api import gold as gold_api
from .api import export as export_api
from .api import runs as runs_api
from .config import settings
from .models import Conversation
from .services import checklists as checklists_svc

FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    with Session(db.engine) as s:
        checklists_svc.seed_default(s)
    yield


app = FastAPI(title="CQA — Conversation Quality Analytics", lifespan=lifespan)

app.include_router(datasets_api.router, prefix="/api")
app.include_router(conversations_api.router, prefix="/api")
app.include_router(audio_api.router, prefix="/api")
app.include_router(checklists_api.router, prefix="/api")
app.include_router(runs_api.router, prefix="/api")
app.include_router(evaluations_api.router, prefix="/api")
app.include_router(gold_api.router, prefix="/api")
app.include_router(export_api.router, prefix="/api")


def _model_name() -> str:
    return {
        "openrouter": settings.openrouter_model,
        "gemini": settings.gemini_model,
        "ollama": settings.ollama_model,
    }.get(settings.llm_provider, "")


@app.get("/api/health")
def health(session: Session = Depends(db.get_session)) -> dict:
    try:
        n = session.exec(select(func.count()).select_from(Conversation)).one()
    except Exception:
        n = None  # БД ещё не создана (старт без lifespan)
    return {
        "status": "ok",
        "provider": settings.llm_provider,
        "model": _model_name(),
        "group_id": settings.dataset_group_id,
        "conversations": n,
    }


# Статика фронта монтируется последней, чтобы не перекрывать /api/*.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
