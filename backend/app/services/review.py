"""Очередь «требует проверки» (FR-UX-02): что в последних оценках группы стоит посмотреть человеку.

Элемент — критерий оценки (или вся оценка, если она не получена) с главной причиной и всеми причинами.
Критерий, по которому проверяющий уже вынес решение по апелляции, из очереди уходит: человек его проверил.
"""
from __future__ import annotations

from sqlmodel import Session, select

from ..models import Conversation, Evaluation, LLMCall
from . import latest
from .evaluations import _ans_api
from .guards import FLAG_PREFIX, GUARD_PREFIXES, OVERRIDE_PREFIX

# Причина → важность (больше — выше в очереди).
SEVERITY = {"failed": 100, "missing": 90, "appeal": 80, "guard": 70, "validator": 60, "low_confidence": 50}
LOW_CONFIDENCE_ISSUE = "низкая уверенность модели"  # пометка validator.py (V10); причина low_confidence её уже покрывает


def _error(session: Session, ev: Evaluation) -> str:
    err = next((c.error for c in session.exec(select(LLMCall).where(LLMCall.evaluation_id == ev.id)
                                                .order_by(LLMCall.id)) if c.error), None)
    return err or "модель не вернула ответ"


def _item(conv: Conversation, ev: Evaluation, key: str | None, title: str | None, reasons: list[str],
          message: str, issues: list[str], **extra) -> dict:
    reason = max(reasons, key=SEVERITY.__getitem__)
    return {
        "evaluation_id": ev.id, "conversation_id": conv.id, "conversation_code": conv.conversation_id,
        "group_id": conv.group_id, "channel": conv.channel, "language": conv.language,
        "criterion_key": key, "criterion_title": title, "reason": reason,
        "reasons": sorted(set(reasons), key=SEVERITY.__getitem__, reverse=True), "severity": SEVERITY[reason],
        "message": message, "messages": [message], "issues": issues,
        "confidence": None, "ai_answer": None, "final_answer": None, "appeal_id": None, **extra,
    }


def queue(session: Session, group_id: str | None, version_id: int | None = None) -> list[dict]:
    pairs = [(c, e) for c, e in latest.group_latest(session, group_id, version_id) if e]
    ids = [e.id for _, e in pairs]
    rows = latest.criterion_rows(session, ids)
    appeals = latest.appeals_by_eval(session, ids)
    cache = latest.ChecklistCache(session)
    items: list[tuple[int, dict]] = []  # (порядок критерия, элемент)

    for conv, ev in pairs:
        if ev.status == "failed":
            items.append((-1, _item(conv, ev, None, None, ["failed"], f"Оценка не получена: {_error(session, ev)}", [])))
            continue
        cl = cache.get(ev.checklist_version_id)
        order = {c.key: i for i, c in enumerate(cl.criteria)} if cl else {}
        by_key = rows.get(ev.id, {})
        open_ap = {a.criterion_key: a for a in appeals.get(ev.id, []) if a.status == "open"}
        decided = {a.criterion_key for a in appeals.get(ev.id, []) if a.status != "open"}
        missing = set((ev.final_score or {}).get("missing") or [])
        keys = sorted(set(by_key) | missing | set(open_ap), key=lambda k: (order.get(k, len(order)), k))

        for key in keys:
            r = by_key.get(key)
            crit = cl.criterion(key) if cl else None
            title = crit.title if crit else key
            ap = open_ap.get(key)
            reasons: list[str] = []
            messages: list[str] = []
            issues = list((r.issues if r else None) or [])
            if key in missing and not (r and r.final_answer):
                reasons.append("missing")
                messages.append("Модель не вернула ответ по критерию")
            if ap:
                reasons.append("appeal")
                messages.append(f"Апелляция №{ap.id}: {ap.comment}")
            if r and key not in decided:
                guard = [i for i in issues if i.startswith(GUARD_PREFIXES)]
                other = [i for i in issues if not i.startswith(GUARD_PREFIXES) and i != LOW_CONFIDENCE_ISSUE]
                if guard:
                    reasons.append("guard")
                    replaced = any(i.startswith(OVERRIDE_PREFIX) for i in guard)
                    flagged = any(i.startswith(FLAG_PREFIX) for i in guard)
                    messages.append("Ответ заменён правилом по фактам" if replaced and not flagged
                                    else "Ответ модели противоречит фактам")
                if other:
                    reasons.append("validator")
                    messages.append("Проверка ответа: " + "; ".join(other))
                if r.confidence == "low":
                    reasons.append("low_confidence")
                    messages.append("Модель не уверена: данных для вывода мало")
            if not reasons:
                continue
            first = max(range(len(reasons)), key=lambda i: SEVERITY[reasons[i]])
            items.append((order.get(key, len(order)), _item(
                conv, ev, key, title, reasons, messages[first], issues, messages=messages,
                confidence=r.confidence if r else None, ai_answer=_ans_api(r.ai_answer) if r else None,
                final_answer=_ans_api(r.final_answer) if r else None, appeal_id=ap.id if ap else None)))

    items.sort(key=lambda t: (-t[1]["severity"], t[1]["conversation_code"], t[0]))
    return [it for _, it in items]
