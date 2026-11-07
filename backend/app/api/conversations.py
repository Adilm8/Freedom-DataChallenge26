from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import Conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _row(c: Conversation) -> dict:
    return {
        "id": c.id,
        "conversation_id": c.conversation_id,
        "group_id": c.group_id,
        "channel": c.channel,
        "language": c.language,
        "latest": None,
    }


@router.get("")
def list_conversations(
    group_id: str | None = None,
    language: str | None = None,
    channel: str | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    q = select(Conversation).order_by(Conversation.conversation_id)
    if group_id:
        q = q.where(Conversation.group_id == group_id)
    if language:
        q = q.where(Conversation.language == language)
    if channel:
        q = q.where(Conversation.channel == channel)
    return [_row(c) for c in session.exec(q)]


@router.get("/{pk}")
def get_conversation(pk: int, session: Session = Depends(get_session)) -> dict:
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    n = c.normalized or {}
    keys = ("msg_id", "speaker", "text", "timestamp", "t_sec", "audio_offset_sec", "internal", "event")
    return {
        **_row(c),
        "audio_url": c.audio_url,
        "source": c.source,
        "audio_offset_fix_sec": c.audio_offset_fix_sec,
        "imported_at": c.imported_at.isoformat() if c.imported_at else None,
        "messages": [{k: m.get(k) for k in keys} for m in n.get("messages", [])],
        "segments": n.get("segments", []),
        "events": n.get("events", []),
        "warnings": n.get("warnings", []),
        "evaluations": [],
    }
