"""Экран проверки gold-разметки (FR-GOLD-01…05). Только группа DEV."""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..db import get_session
from ..domain import Checklist
from ..models import Conversation
from ..services import checklists as checklists_svc
from ..services import gold as svc

router = APIRouter(prefix="/gold", tags=["gold"])
GROUP = "DEV"


class AnswerIn(BaseModel):
    answer: Any


class PutBody(BaseModel):
    criteria: dict[str, AnswerIn] = Field(default_factory=dict)
    uncertain: list[str] = Field(default_factory=list)
    notes: str = ""
    reviewed: bool | None = None  # true — «всё ок» (Enter); None — только автосохранение


def _checklist(session: Session) -> Checklist:
    v = checklists_svc.get_active(session)
    if not v:
        raise HTTPException(409, "нет активного чек-листа")
    return Checklist.model_validate(v.body)


def _dev_pk(session: Session, cid: str) -> int | None:
    c = session.exec(select(Conversation).where(Conversation.group_id == GROUP, Conversation.conversation_id == cid)).first()
    return c.id if c else None


@router.get("")
def list_gold(session: Session = Depends(get_session)) -> list[dict]:
    pks = {c.conversation_id: c.id for c in session.exec(select(Conversation).where(Conversation.group_id == GROUP))}
    return svc.list_rows(pks)


@router.get("/{conversation_id}")
def get_gold(conversation_id: str, session: Session = Depends(get_session)) -> dict:
    try:
        d = svc.draft(conversation_id)
    except svc.GoldError as e:
        raise HTTPException(422, str(e))
    pk = _dev_pk(session, conversation_id)
    if pk is None:
        raise HTTPException(404, "диалог не найден в группе DEV")
    return {
        "conversation_id": conversation_id,
        "conversation_pk": pk,
        "draft": d,
        "second_opinion": svc.second_opinion(conversation_id),
        "label": svc.label(conversation_id),
        "criteria": svc.criteria_info(_checklist(session)),
    }


@router.put("/{conversation_id}")
def put_gold(conversation_id: str, body: PutBody, session: Session = Depends(get_session)) -> dict:
    if _dev_pk(session, conversation_id) is None:
        raise HTTPException(404, "диалог не найден в группе DEV: gold размечаем только для DEV")
    try:
        return svc.save_label(conversation_id, _checklist(session), {k: v.answer for k, v in body.criteria.items()},
                              body.uncertain, body.notes, body.reviewed)
    except svc.GoldError as e:
        raise HTTPException(422, str(e))
