from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session

from ..config import settings
from ..db import get_session
from ..providers import configured_models
from ..services import appeals as svc
from ..services import evaluations as evaluations_svc
from ..services import second_opinion as opinion_svc

router = APIRouter(prefix="/appeals", tags=["appeals"])
STATUS_FILTERS = (*svc.STATUSES, "closed")


def _error(e: svc.AppealError):
    if e.status == 422:
        return JSONResponse(status_code=422, content={"detail": e.detail, "errors": e.errors})
    raise HTTPException(e.status, e.detail)


class AppealBody(BaseModel):
    evaluation_id: int
    criterion_key: str
    comment: str = ""


class DecisionBody(BaseModel):
    action: str = ""
    answer: str | int | None = None
    reason: str = ""


@router.post("", status_code=201)
def create_appeal(body: AppealBody, session: Session = Depends(get_session)):
    try:
        return svc.to_api(svc.create(session, body.evaluation_id, body.criterion_key, body.comment))
    except svc.AppealError as e:
        return _error(e)


@router.get("")
def list_appeals(status: str | None = None, group_id: str | None = None, evaluation_id: int | None = None,
                 conversation_id: int | None = None, session: Session = Depends(get_session)) -> list[dict]:
    """`status`: open / confirmed / changed / closed (= рассмотренные); без него — все. `conversation_id` — id диалога в БД."""
    if status and status not in STATUS_FILTERS:
        raise HTTPException(400, f"статус апелляции: {', '.join(STATUS_FILTERS)}")
    return svc.list_rows(session, status=status, group_id=group_id, evaluation_id=evaluation_id,
                         conversation_pk=conversation_id)


@router.post("/{appeal_id}/decision")
def decide(appeal_id: int, body: DecisionBody, session: Session = Depends(get_session)):
    try:
        a, ev = svc.decide(session, appeal_id, body.action, body.answer, body.reason)
    except svc.AppealError as e:
        return _error(e)
    return {"appeal": svc.to_api(a), "evaluation": evaluations_svc.to_api(session, ev)}


class SecondOpinionBody(BaseModel):
    provider: str | None = None
    model: str | None = None


@router.post("/{appeal_id}/second-opinion")
def second_opinion(appeal_id: int, body: SecondOpinionBody | None = None, session: Session = Depends(get_session)):
    """Второе мнение ИИ: слепая перепроверка спорного критерия одним вызовом конвейера (services/second_opinion.py).
    Оценка и апелляция не меняются. 409 — апелляция рассмотрена; 502 — модель не ответила."""
    b = body or SecondOpinionBody()
    provider = (b.provider or settings.llm_provider).strip().lower()
    known = {m["provider"]: m["model"] for m in configured_models()}
    if provider not in known:
        raise HTTPException(400, f"неизвестный провайдер «{provider}»")
    model = b.model or known[provider]
    if not model:
        raise HTTPException(400, f"у провайдера «{provider}» не задана модель")
    try:
        return opinion_svc.run(session, appeal_id, provider_name=provider, model=model)
    except svc.AppealError as e:
        return _error(e)
