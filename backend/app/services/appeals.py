"""Апелляции (FR-APL-01…05, data-model.md «appeal»).

- AI-оценка (`ai_*`, `ai_score`, `ai_total`) не меняется никогда.
- «change» пишет `final_answer`/`final_points`/`overridden` критерия и пересчитывает `final_score`,
  `final_total`, `critical` оценки через `scoring.compute` по финальным ответам.
- «confirm» закрывает апелляцию без изменений. Причина решения обязательна.
- По критерию оценки — не больше одной открытой апелляции; после решения можно подать новую (FR-APL-07).
- Подача и решение идут под общей блокировкой: два одновременных запроса не создадут двух открытых
  апелляций и не решат одну дважды (второй получит 409). Приложение работает одним процессом.
"""
from __future__ import annotations

import functools
import threading

from sqlmodel import Session, select

from ..domain import Checklist, Criterion
from ..models import Appeal, ChecklistVersion, Conversation, CriterionResult, Evaluation, utcnow
from . import latest, scoring
from .evaluations import _ans_api, _ans_str

ACTIONS = ("confirm", "change")
STATUSES = ("open", "confirmed", "changed")
CONTEXT = 2          # реплик до и после доказательства во фрагменте (FR-APL-02)
RANGE_MAX = 10       # участок без доказательств короче этого — целиком, длиннее — начало и конец
RANGE_EDGE = 4
COMMENT_MAX = 4000
_LOCK = threading.Lock()
_FRAG_KEYS = ("msg_id", "idx", "speaker", "text", "timestamp", "t_sec", "audio_offset_sec", "internal", "event")


class AppealError(Exception):
    status = 400

    def __init__(self, detail: str, errors: list[dict] | None = None):
        super().__init__(detail)
        self.detail = detail
        self.errors = errors or []


class NotFound(AppealError):
    status = 404


class Conflict(AppealError):
    status = 409


class Invalid(AppealError):
    status = 422


def _invalid(path: str, message: str) -> Invalid:
    return Invalid(message, [{"path": path, "message": message}])


def to_api(a: Appeal) -> dict:
    return {
        "id": a.id, "evaluation_id": a.evaluation_id, "criterion_key": a.criterion_key, "comment": a.comment,
        "status": a.status, "ai_answer_snapshot": _ans_api(a.ai_answer_snapshot),
        "decision_answer": _ans_api(a.decision_answer), "decision_reason": a.decision_reason,
        "created_at": a.created_at.isoformat(), "decided_at": a.decided_at.isoformat() if a.decided_at else None,
    }


def _row(session: Session, evaluation_id: int, key: str) -> CriterionResult | None:
    return session.exec(select(CriterionResult).where(
        CriterionResult.evaluation_id == evaluation_id, CriterionResult.criterion_key == key)).first()


def open_appeal(session: Session, evaluation_id: int, key: str) -> Appeal | None:
    return session.exec(select(Appeal).where(
        Appeal.evaluation_id == evaluation_id, Appeal.criterion_key == key, Appeal.status == "open")).first()


def _serialized(fn):
    @functools.wraps(fn)
    def wrapper(session: Session, *args, **kwargs):
        with _LOCK:
            session.expire_all()  # читаем состояние после чужого коммита, а не из кэша сессии
            return fn(session, *args, **kwargs)
    return wrapper


@_serialized
def create(session: Session, evaluation_id: int, criterion_key: str, comment: str) -> Appeal:
    ev = session.get(Evaluation, evaluation_id)
    if not ev:
        raise NotFound("оценка не найдена")
    key = (criterion_key or "").strip()
    row = _row(session, ev.id, key)
    if not row:
        raise NotFound(f"в оценке нет результата по критерию «{key}»")
    text = (comment or "").strip()
    if not text:
        raise _invalid("comment", "напишите комментарий: что не так с оценкой")
    if len(text) > COMMENT_MAX:
        raise _invalid("comment", f"комментарий длиннее {COMMENT_MAX} символов")
    if (dup := open_appeal(session, ev.id, key)):
        raise Conflict(f"по критерию {key} уже есть открытая апелляция №{dup.id}")
    a = Appeal(evaluation_id=ev.id, criterion_key=key, comment=text, status="open",
               ai_answer_snapshot=row.ai_answer or "")
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


def recompute_final(session: Session, ev: Evaluation, checklist: Checklist) -> None:
    """Финальный итог по финальным ответам (тот же `scoring.compute`, что и для AI). AI-поля не трогаем."""
    rows = list(session.exec(select(CriterionResult).where(CriterionResult.evaluation_id == ev.id)))
    answers = {r.criterion_key: r.final_answer for r in rows if r.final_answer not in (None, "")}
    score = scoring.compute(checklist, answers)
    for r in rows:
        cs = score.criteria.get(r.criterion_key)
        if cs is not None:
            r.final_points = cs.points
        r.overridden = (r.final_answer or "") != (r.ai_answer or "")
        session.add(r)
    ev.final_score = score.model_dump()
    ev.final_total = score.total
    ev.critical = bool(score.critical)
    session.add(ev)


@_serialized
def decide(session: Session, appeal_id: int, action: str, answer, reason: str) -> tuple[Appeal, Evaluation]:
    a = session.get(Appeal, appeal_id)
    if not a:
        raise NotFound("апелляция не найдена")
    if a.status != "open":
        raise Conflict(f"апелляция №{a.id} уже рассмотрена")
    action = (action or "").strip().lower()
    if action not in ACTIONS:
        raise _invalid("action", "решение: confirm (подтвердить оценку) или change (изменить ответ)")
    why = (reason or "").strip()
    if not why:
        raise _invalid("reason", "укажите причину решения")
    ev = session.get(Evaluation, a.evaluation_id)
    row = _row(session, a.evaluation_id, a.criterion_key)
    if not ev or not row:
        raise NotFound("оценка или критерий апелляции не найдены")

    if action == "confirm":
        a.status, a.decision_answer = "confirmed", row.final_answer or None
    else:
        ver = session.get(ChecklistVersion, ev.checklist_version_id)
        checklist = Checklist.model_validate(ver.body)
        crit = checklist.criterion(a.criterion_key)
        if crit is None or not crit.enabled:
            raise Conflict(f"критерия {a.criterion_key} нет среди включённых в версии чек-листа оценки")
        if answer is None or answer == "":
            raise _invalid("answer", f"выберите новый ответ: {_allowed_text(crit)}")
        try:
            new = crit.coerce_answer(answer)
        except ValueError:
            raise _invalid("answer", f"ответ {answer!r} не подходит критерию {crit.key}: {_allowed_text(crit)}") from None
        if _ans_str(new) == (row.final_answer or ""):
            raise _invalid("answer", "ответ совпадает с текущим: выберите другой или подтвердите оценку")
        row.final_answer = _ans_str(new)
        session.add(row)
        recompute_final(session, ev, checklist)
        a.status, a.decision_answer = "changed", row.final_answer
    a.decision_reason, a.decided_at = why, utcnow()
    session.add(a)
    session.commit()
    session.refresh(a)
    session.refresh(ev)
    return a, ev


def _allowed_text(c: Criterion) -> str:
    return ", ".join(str(x) for x in c.allowed_answers())


# --------------------------------------------------------------------------- очередь апелляций


def fragment(messages: list[dict], evidence: list[dict] | None, checked_range: dict | None,
             ctx: int = CONTEXT) -> list[dict]:
    """Реплики-доказательства ± `ctx` соседних; без доказательств — проверенный участок.

    `gap_before` — перед репликой есть пропущенные (интерфейс рисует «…»), `quotes` — цитаты из доказательств."""
    pos = {m.get("msg_id"): i for i, m in enumerate(messages)}
    quotes: dict[str, list[str]] = {}
    for e in evidence or []:
        if e.get("msg_id") in pos:
            quotes.setdefault(e["msg_id"], []).append(e.get("quote") or "")
    picked: set[int] = set()
    for mid in quotes:
        i = pos[mid]
        picked.update(range(max(0, i - ctx), min(len(messages), i + ctx + 1)))
    if not picked and checked_range:
        a, b = pos.get(checked_range.get("from")), pos.get(checked_range.get("to"))
        if a is not None and b is not None:
            a, b = min(a, b), max(a, b)
            if b - a + 1 <= RANGE_MAX:
                picked.update(range(a, b + 1))
            else:
                picked.update(range(a, a + RANGE_EDGE))
                picked.update(range(b - RANGE_EDGE + 1, b + 1))
    out, prev = [], None
    for i in sorted(picked):
        m = messages[i]
        mid = m.get("msg_id")
        out.append({**{k: m.get(k) for k in _FRAG_KEYS}, "is_evidence": mid in quotes, "quotes": quotes.get(mid, []),
                    "gap_before": i > 0 if prev is None else i != prev + 1})
        prev = i
    return out


def _criterion_block(c: Criterion | None, r: CriterionResult) -> dict:
    return {
        "key": r.criterion_key, "title": c.title if c else r.criterion_key, "type": c.type if c else None,
        "weight": c.weight if c else None, "scale_max": (c.max_step or c.weight) if c else None,
        "scale": [s.model_dump() for s in c.scale] if c and c.scale else None,
        "allowed_answers": c.allowed_answers() if c else [],
        "ai_answer": _ans_api(r.ai_answer), "ai_points": r.ai_points,
        "final_answer": _ans_api(r.final_answer), "final_points": r.final_points, "overridden": r.overridden,
        "reasoning": r.reasoning, "confidence": r.confidence, "na_reason": r.na_reason, "advice": r.advice,
        "evidence": r.evidence or [], "checked_range": r.checked_range, "issues": r.issues or [],
    }


def list_rows(session: Session, *, status: str | None = None, group_id: str | None = None,
              evaluation_id: int | None = None, conversation_pk: int | None = None) -> list[dict]:
    """`AppealRow`: апелляция + диалог + оценка + критерий + фрагмент. Новые сверху."""
    q = select(Appeal).order_by(Appeal.id.desc())
    if status == "closed":
        q = q.where(Appeal.status != "open")
    elif status:
        q = q.where(Appeal.status == status)
    if evaluation_id:
        q = q.where(Appeal.evaluation_id == evaluation_id)
    appeals = list(session.exec(q))
    evs = {e.id: e for e in session.exec(select(Evaluation).where(
        Evaluation.id.in_({a.evaluation_id for a in appeals})))} if appeals else {}
    convs = {c.id: c for c in session.exec(select(Conversation).where(
        Conversation.id.in_({e.conversation_pk for e in evs.values()})))} if evs else {}
    rows = latest.criterion_rows(session, evs.keys())
    cache = latest.ChecklistCache(session)
    from . import second_opinion  # second_opinion импортирует этот модуль
    opinions = second_opinion.latest_map(session, [a.id for a in appeals])
    out = []
    for a in appeals:
        ev = evs.get(a.evaluation_id)
        conv = convs.get(ev.conversation_pk) if ev else None
        if not ev or not conv:
            continue
        if group_id and conv.group_id != group_id:
            continue
        if conversation_pk and conv.id != conversation_pk:
            continue
        r = rows.get(ev.id, {}).get(a.criterion_key)
        cl = cache.get(ev.checklist_version_id)
        crit = cl.criterion(a.criterion_key) if cl else None
        out.append({
            **to_api(a),
            "conversation": {"id": conv.id, "conversation_id": conv.conversation_id, "group_id": conv.group_id,
                             "channel": conv.channel, "language": conv.language},
            "evaluation": {"id": ev.id, "model": ev.model, "checklist_version_id": ev.checklist_version_id,
                           "status": ev.status, "ai_total": ev.ai_total, "final_total": ev.final_total,
                           "critical": ev.critical, "created_at": ev.created_at.isoformat()},
            "criterion": _criterion_block(crit, r) if r else None,
            "fragment": fragment((conv.normalized or {}).get("messages", []), r.evidence if r else [],
                                 r.checked_range if r else None),
            "second_opinion": second_opinion.to_api(opinions.get(a.id)),
        })
    return out
