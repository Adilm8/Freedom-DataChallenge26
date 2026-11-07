from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..models import ChecklistVersion, Conversation, EvaluationRun
from ..providers import configured_models
from ..services import runs as runs_svc
from ..services.evaluations import REUSE_MODES
from ..services.evaluator import STRATEGIES

router = APIRouter(tags=["runs"])


class RunBody(BaseModel):
    conversation_ids: list[int] | None = None
    group_id: str | None = None
    checklist_version_id: int | None = None
    provider: str | None = None
    model: str | None = None
    strategy: str | None = None
    reuse: str = "none"


@router.post("/runs", status_code=202)
def create_run(body: RunBody, session: Session = Depends(get_session)) -> dict:
    strategy = body.strategy or settings.eval_strategy
    if strategy not in STRATEGIES:
        raise HTTPException(400, f"неизвестная стратегия «{strategy}»: {', '.join(STRATEGIES)}")
    if body.reuse not in REUSE_MODES:
        raise HTTPException(400, f"неизвестный режим reuse «{body.reuse}»: {', '.join(REUSE_MODES)}")
    provider = (body.provider or settings.llm_provider).strip().lower()
    known = {m["provider"]: m["model"] for m in configured_models()}
    if provider not in known:
        raise HTTPException(400, f"неизвестный провайдер «{provider}»")
    model = body.model or known[provider]
    if not model:
        raise HTTPException(400, f"у провайдера «{provider}» не задана модель")
    if body.checklist_version_id and not session.get(ChecklistVersion, body.checklist_version_id):
        raise HTTPException(400, "версия чек-листа не найдена")
    if body.conversation_ids:
        q = select(Conversation.id).where(Conversation.id.in_(body.conversation_ids))
        group = ""
    else:
        group = body.group_id or settings.dataset_group_id
        q = select(Conversation.id).where(Conversation.group_id == group).order_by(Conversation.conversation_id)
    pks = list(session.exec(q))
    if not pks:
        raise HTTPException(400, "нет диалогов для оценки")
    if not (body.checklist_version_id or runs_svc.active_version_id(session)):
        raise HTTPException(400, "нет активной версии чек-листа")
    run_id = runs_svc.start_run(session, pks, group_id=group, checklist_version_id=body.checklist_version_id,
                                provider=provider, model=model, strategy=strategy, reuse=body.reuse)
    return {"run_id": run_id}


@router.get("/runs/{run_id}")
def get_run(run_id: int, session: Session = Depends(get_session)) -> dict:
    r = session.get(EvaluationRun, run_id)
    if not r:
        raise HTTPException(404, "прогон не найден")
    return {
        "run_id": r.id, "status": r.status, "total": r.total, "done": r.done, "failed": r.failed,
        "cost_usd": r.cost_usd, "provider": r.provider, "model": r.model, "strategy": r.strategy,
        "checklist_version_id": r.checklist_version_id,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }
