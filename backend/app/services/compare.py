"""Сравнение двух оценок одного диалога (FR-EVAL-20, FR-CARD-06): «Оценить повторно» и что изменилось.

По умолчанию оценка сравнивается с предыдущей неупавшей оценкой того же диалога. Сравниваются AI-ответы
(решения апелляций показаны отдельно, финальным ответом), баллы, уверенность и конфигурация прогона:
одинаковая конфигурация + разные ответы = нестабильность модели (NFR-14), разная — эффект изменения.
"""
from __future__ import annotations

from sqlmodel import Session, select

from ..models import Evaluation
from . import latest
from .evaluations import _ans_api

CONFIG_FIELDS = ("model", "strategy", "prompt_version", "checklist_version_id")


class CompareError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def previous(session: Session, ev: Evaluation) -> Evaluation | None:
    return session.exec(select(Evaluation).where(
        Evaluation.conversation_pk == ev.conversation_pk, Evaluation.id < ev.id, Evaluation.status != "failed")
        .order_by(Evaluation.id.desc())).first()


def _side(ev: Evaluation) -> dict:
    params = ev.params or {}
    return {"id": ev.id, "status": ev.status, "created_at": ev.created_at.isoformat(), "provider": ev.provider,
            "model": ev.model, "strategy": ev.strategy, "prompt_version": ev.prompt_version,
            "checklist_version_id": ev.checklist_version_id, "temperature": params.get("temperature"),
            "seed": params.get("seed"), "reuse": params.get("reuse"),
            "ai_total": ev.ai_total, "final_total": ev.final_total, "cost_usd": ev.cost_usd}


def _crit(r) -> dict | None:
    if r is None:
        return None
    return {"answer": _ans_api(r.ai_answer), "points": r.ai_points, "final_answer": _ans_api(r.final_answer),
            "overridden": r.overridden, "confidence": r.confidence, "reasoning": r.reasoning,
            "evidence": [e.get("msg_id") for e in (r.evidence or []) if e.get("msg_id")],
            "reused_from_evaluation_id": r.reused_from_evaluation_id}


def compare(session: Session, a_id: int, b_id: int | None = None) -> dict:
    """`a` — новая оценка, `b` — с чем сравниваем (по умолчанию предыдущая)."""
    a = session.get(Evaluation, a_id)
    if not a:
        raise CompareError(404, "оценка не найдена")
    b = session.get(Evaluation, b_id) if b_id else previous(session, a)
    if b_id and not b:
        raise CompareError(404, f"оценка №{b_id} не найдена")
    if b is None:
        return {"a": _side(a), "b": None, "criteria": [], "changed": 0, "common": 0, "total_delta": None,
                "same_config": None, "config_diff": []}
    if b.conversation_pk != a.conversation_pk:
        raise CompareError(422, "сравниваются только оценки одного диалога")
    rows = latest.criterion_rows(session, [a.id, b.id])
    cache = latest.ChecklistCache(session)
    order: list[str] = []
    titles: dict[str, str] = {}
    for ev in (a, b):
        cl = cache.get(ev.checklist_version_id)
        for c in (cl.enabled_criteria() if cl else []):
            if c.key not in titles:
                order.append(c.key)
                titles[c.key] = c.title
    for k in list(rows[a.id]) + list(rows[b.id]):  # строки без критерия в версии (на всякий случай)
        if k not in titles:
            order.append(k)
            titles[k] = k
    items, changed, common = [], 0, 0
    for k in order:
        ra, rb = rows[a.id].get(k), rows[b.id].get(k)
        if ra is None and rb is None:
            continue
        same = ra is not None and rb is not None and (ra.ai_answer or "") == (rb.ai_answer or "")
        if ra is not None and rb is not None:
            common += 1
            changed += not same
        items.append({"key": k, "title": titles[k], "a": _crit(ra), "b": _crit(rb),
                      "status": "same" if same else ("changed" if ra is not None and rb is not None
                                                     else ("added" if rb is None else "removed")),
                      "points_delta": (round((ra.ai_points or 0) - (rb.ai_points or 0), 2)
                                       if ra is not None and rb is not None else None)})
    diff = [f for f in CONFIG_FIELDS if getattr(a, f) != getattr(b, f)]
    delta = round(a.ai_total - b.ai_total, 2) if a.ai_total is not None and b.ai_total is not None else None
    return {"a": _side(a), "b": _side(b), "criteria": items, "changed": changed, "common": common,
            "total_delta": delta, "same_config": not diff, "config_diff": diff}
