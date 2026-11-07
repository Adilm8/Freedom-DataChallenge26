import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import Conversation, Evaluation
from ..services import latest as latest_svc
from ..config import settings
from ..domain import NormalizedConversation
from ..services import manual, pii

router = APIRouter(prefix="/conversations", tags=["conversations"])

APPEAL_FILTERS = ("open", "any", "none")
MAX_OFFSET_FIX_SEC = 3600


def _strip(score: dict | None) -> list[dict]:
    """Полоска критериев для списка: код, финальный ответ, доля балла (None — N/A, флаг или нет ответа)."""
    out = []
    for key, c in ((score or {}).get("criteria") or {}).items():
        if not isinstance(c, dict):
            continue
        pts, w = c.get("points"), c.get("weight")
        pct = round(100 * pts / w) if pts is not None and w else None
        out.append({"key": key, "answer": c.get("answer"), "pct": pct})
    return out


def _latest(ev: Evaluation | None, appeals: tuple[int, int] = (0, 0)) -> dict | None:
    if not ev:
        return None
    return {
        "evaluation_id": ev.id, "ai_total": ev.ai_total, "final_total": ev.final_total,
        "critical": ev.critical, "needs_review": ev.needs_review, "status": ev.status,
        "open_appeals": appeals[0], "appeals": appeals[1],
        "criteria": _strip(ev.final_score),
    }


def _row(c: Conversation, ev: Evaluation | None = None, appeals: tuple[int, int] = (0, 0)) -> dict:
    return {
        "id": c.id,
        "conversation_id": c.conversation_id,
        "group_id": c.group_id,
        "channel": c.channel,
        "language": c.language,
        "source": c.source,
        "latest": _latest(ev, appeals),
    }


def _appeal_counts(session: Session, eval_ids: list[int]) -> dict[int, tuple[int, int]]:
    """id оценки → (открытых апелляций, всего)."""
    return {eid: (sum(a.status == "open" for a in aps), len(aps))
            for eid, aps in latest_svc.appeals_by_eval(session, eval_ids).items()}


@router.get("")
def list_conversations(
    group_id: str | None = None,
    language: str | None = None,
    channel: str | None = None,
    critical: bool | None = None,
    appeal: str | None = None,
    checklist_version_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """`appeal`: open — есть открытые апелляции по последней оценке, any — есть любые, none — нет ни одной."""
    if appeal and appeal not in APPEAL_FILTERS:
        raise HTTPException(400, f"фильтр appeal: {', '.join(APPEAL_FILTERS)}")
    q = select(Conversation).order_by(Conversation.conversation_id)
    if group_id:
        q = q.where(Conversation.group_id == group_id)
    if language:
        q = q.where(Conversation.language == language)
    if channel:
        q = q.where(Conversation.channel == channel)
    convs = list(session.exec(q))
    latest = latest_svc.latest_map(session, [c.id for c in convs], checklist_version_id)
    counts = _appeal_counts(session, [e.id for e in latest.values()])
    rows = []
    for c in convs:
        ev = latest.get(c.id)
        rows.append(_row(c, ev, counts.get(ev.id, (0, 0)) if ev else (0, 0)))
    if critical is not None:
        rows = [r for r in rows if bool(r["latest"] and r["latest"]["critical"]) == critical]
    if appeal == "open":
        rows = [r for r in rows if r["latest"] and r["latest"]["open_appeals"] > 0]
    elif appeal == "any":
        rows = [r for r in rows if r["latest"] and r["latest"]["appeals"] > 0]
    elif appeal == "none":
        rows = [r for r in rows if not (r["latest"] and r["latest"]["appeals"])]
    return rows


def detail(session: Session, c: Conversation) -> dict:
    n = c.normalized or {}
    evs = list(session.exec(select(Evaluation).where(Evaluation.conversation_pk == c.id).order_by(Evaluation.id.desc())))
    counts = _appeal_counts(session, [evs[0].id]) if evs else {}
    keys = ("msg_id", "idx", "speaker", "text", "timestamp", "t_sec", "audio_offset_sec", "internal", "event")
    return {
        **_row(c, evs[0] if evs else None, counts.get(evs[0].id, (0, 0)) if evs else (0, 0)),
        # Подписанная ссылка на запись не уходит в браузер: запись отдаётся прокси /api/conversations/{id}/audio.
        "has_audio": bool(c.audio_url),
        "audio_url": f"/api/conversations/{c.id}/audio" if c.audio_url else None,
        "audio_offset_fix_sec": c.audio_offset_fix_sec,
        "imported_at": c.imported_at.isoformat() if c.imported_at else None,
        "messages": [{k: m.get(k) for k in keys} for m in n.get("messages", [])],
        "segments": n.get("segments", []),
        "events": n.get("events", []),
        "warnings": n.get("warnings", []),
        "privacy": _privacy(n),
        "evaluations": [
            {"id": e.id, "model": e.model, "checklist_version_id": e.checklist_version_id, "status": e.status,
             "ai_total": e.ai_total, "final_total": e.final_total, "created_at": e.created_at.isoformat()}
            for e in evs
        ],
    }


def _invalid(errors: list[dict], detail_text: str = "данные не прошли проверку") -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": detail_text, "errors": errors})


class NewConversation(BaseModel):
    group_id: str | None = None
    conversation_id: str | None = None
    channel: str | None = None
    language: str | None = None
    audio_url: str | None = None
    transcript: Any = None


@router.post("", status_code=201)
def create_conversation(body: NewConversation, session: Session = Depends(get_session)):
    """Новый диалог из интерфейса (FR-DATA-07): массив реплик API организаторов или текст «роль: текст»."""
    try:
        c = manual.create(session, body.model_dump())
    except manual.ManualInvalid as e:
        return _invalid(e.errors, e.detail)
    except manual.ManualConflict as e:
        raise HTTPException(409, str(e))
    return detail(session, c)


def _privacy(n: dict) -> dict:
    """Что скрыто перед отправкой в модель (services/pii.py): сводка и текст реплик в том виде, как их видит модель."""
    if not settings.pii_masking or not n.get("messages"):
        return {"enabled": settings.pii_masking, "masked_total": 0, "unique_values": 0, "by_kind": [], "spans": [],
                "masked_messages": {}}
    try:
        conv = NormalizedConversation.model_validate(n)
    except Exception:  # noqa: BLE001 — старые записи без полной нормализации: без сводки
        return {"enabled": True, "masked_total": 0, "unique_values": 0, "by_kind": [], "spans": [], "masked_messages": {}}
    masked, spans = pii.mask_conversation(conv)
    changed = {sp.msg_id for sp in spans}
    return {"enabled": True, **pii.summary(spans),
            "masked_messages": {m.msg_id: m.text for m in masked.messages if m.msg_id in changed}}


@router.get("/{pk}")
def get_conversation(pk: int, session: Session = Depends(get_session)) -> dict:
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    return detail(session, c)


class PatchConversation(BaseModel):
    audio_offset_fix_sec: Any = None


@router.patch("/{pk}")
def patch_conversation(pk: int, body: PatchConversation, session: Session = Depends(get_session)):
    """Ручная поправка смещения записи, с: плеер ставит `audio_offset_sec + audio_offset_fix_sec`."""
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    v = body.audio_offset_fix_sec
    try:
        fix = float(v) if v is not None and not isinstance(v, bool) else None
    except (TypeError, ValueError):
        fix = None
    if fix is None or not math.isfinite(fix) or abs(fix) > MAX_OFFSET_FIX_SEC:
        return _invalid([{"path": "audio_offset_fix_sec",
                          "message": f"поправка — число секунд от −{MAX_OFFSET_FIX_SEC} до {MAX_OFFSET_FIX_SEC}"}])
    c.audio_offset_fix_sec = round(fix, 3)
    session.add(c)
    session.commit()
    session.refresh(c)
    return detail(session, c)
