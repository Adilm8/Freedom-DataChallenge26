from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..services import appeals as svc
from ..services import evaluations as evaluations_svc

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
