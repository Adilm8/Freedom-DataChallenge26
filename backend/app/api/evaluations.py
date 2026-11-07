from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..models import Evaluation, LLMCall
from ..providers import configured_models
from ..services import evaluations as svc
from ..services.evaluator import STRATEGIES

router = APIRouter(tags=["evaluations"])


@router.get("/evaluations/{eid}")
def get_evaluation(eid: int, session: Session = Depends(get_session)) -> dict:
    ev = session.get(Evaluation, eid)
    if not ev:
        raise HTTPException(404, "оценка не найдена")
    return svc.to_api(session, ev)


@router.get("/evaluations/{eid}/compare")
def compare_evaluation(eid: int, other: int | None = None, session: Session = Depends(get_session)) -> dict:
    """Что изменилось относительно `other` (по умолчанию — предыдущей неупавшей оценки диалога)."""
    from ..services import compare

    try:
        return compare.compare(session, eid, other)
    except compare.CompareError as e:
        raise HTTPException(e.status, e.detail) from None


@router.get("/evaluations/{eid}/calls")
def get_calls(eid: int, session: Session = Depends(get_session)) -> list[dict]:
    if not session.get(Evaluation, eid):
        raise HTTPException(404, "оценка не найдена")
    rows = session.exec(select(LLMCall).where(LLMCall.evaluation_id == eid).order_by(LLMCall.id))
    return [{
        "id": c.id, "criteria_keys": c.criteria_keys, "attempt": c.attempt, "provider": c.provider, "model": c.model,
        "request": c.request, "response_raw": c.response_raw, "finish_reason": c.finish_reason, "error": c.error,
        "tokens_in": c.tokens_in, "tokens_out": c.tokens_out, "cached_tokens": c.cached_tokens,
        "cost_usd": c.cost_usd, "latency_ms": c.latency_ms, "created_at": c.created_at.isoformat(),
    } for c in rows]


@router.get("/meta/facts")
def meta_facts() -> dict:
    """Русские подписи фактов для интерфейса (источник — реестр `services/facts`)."""
    from ..services import facts

    return {"labels": dict(facts.LABELS)}


@router.get("/meta/models")
def meta_models() -> dict:
    return {
        "models": configured_models(),
        "default_provider": settings.llm_provider,
        "default_strategy": settings.eval_strategy,
        "strategies": list(STRATEGIES),
    }
