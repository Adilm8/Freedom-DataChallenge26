from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import Conversation, Evaluation

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _latest(ev: Evaluation | None) -> dict | None:
    if not ev:
        return None
    return {
        "evaluation_id": ev.id, "ai_total": ev.ai_total, "final_total": ev.final_total,
        "critical": ev.critical, "needs_review": ev.needs_review, "open_appeals": 0,
    }


def _row(c: Conversation, ev: Evaluation | None = None) -> dict:
    return {
        "id": c.id,
        "conversation_id": c.conversation_id,
        "group_id": c.group_id,
        "channel": c.channel,
        "language": c.language,
        "latest": _latest(ev),
    }


@router.get("")
def list_conversations(
    group_id: str | None = None,
    language: str | None = None,
    channel: str | None = None,
    critical: bool | None = None,
    checklist_version_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    q = select(Conversation).order_by(Conversation.conversation_id)
    if group_id:
        q = q.where(Conversation.group_id == group_id)
    if language:
        q = q.where(Conversation.language == language)
    if channel:
        q = q.where(Conversation.channel == channel)
    convs = list(session.exec(q))
    eq = select(Evaluation).order_by(Evaluation.id)
    if checklist_version_id:
        eq = eq.where(Evaluation.checklist_version_id == checklist_version_id)
    latest = {e.conversation_pk: e for e in session.exec(eq)}  # поздние перекрывают ранние
    rows = [_row(c, latest.get(c.id)) for c in convs]
    if critical is not None:
        rows = [r for r in rows if bool(r["latest"] and r["latest"]["critical"]) == critical]
    return rows


@router.get("/{pk}")
def get_conversation(pk: int, session: Session = Depends(get_session)) -> dict:
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    n = c.normalized or {}
    evs = list(session.exec(select(Evaluation).where(Evaluation.conversation_pk == pk).order_by(Evaluation.id.desc())))
    keys = ("msg_id", "speaker", "text", "timestamp", "t_sec", "audio_offset_sec", "internal", "event")
    return {
        **_row(c, evs[0] if evs else None),
        # Подписанная ссылка на запись не уходит в браузер: запись отдаётся прокси /api/conversations/{id}/audio (шаг 12).
        "has_audio": bool(c.audio_url),
        "audio_url": f"/api/conversations/{c.id}/audio" if c.audio_url else None,
        "source": c.source,
        "audio_offset_fix_sec": c.audio_offset_fix_sec,
        "imported_at": c.imported_at.isoformat() if c.imported_at else None,
        "messages": [{k: m.get(k) for k in keys} for m in n.get("messages", [])],
        "segments": n.get("segments", []),
        "events": n.get("events", []),
        "warnings": n.get("warnings", []),
        "evaluations": [
            {"id": e.id, "model": e.model, "checklist_version_id": e.checklist_version_id,
             "ai_total": e.ai_total, "final_total": e.final_total, "created_at": e.created_at.isoformat()}
            for e in evs
        ],
    }
