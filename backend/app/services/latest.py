"""Последняя оценка каждого диалога и связанные строки: общая выборка для списка, аналитики, экспорта и очереди.

Правило одно на всё приложение: «последняя» = оценка с наибольшим `id` для диалога (и версии чек-листа,
если она задана). Апелляции и очередь проверки считаются по этой оценке.
"""
from __future__ import annotations

from typing import Iterable

from sqlmodel import Session, select

from ..domain import Checklist
from ..models import Appeal, ChecklistVersion, Conversation, CriterionResult, Evaluation
from .checklists import get_active


def resolve_version(session: Session, version_id: int | None) -> ChecklistVersion | None:
    """Явная версия или активная (по ней прогоны и файл сдачи)."""
    return session.get(ChecklistVersion, version_id) if version_id else get_active(session)


def latest_map(session: Session, conv_pks: Iterable[int] | None = None,
               version_id: int | None = None) -> dict[int, Evaluation]:
    q = select(Evaluation).order_by(Evaluation.id)
    if version_id:
        q = q.where(Evaluation.checklist_version_id == version_id)
    if conv_pks is not None:
        q = q.where(Evaluation.conversation_pk.in_(list(conv_pks)))
    return {e.conversation_pk: e for e in session.exec(q)}  # поздние перекрывают ранние


def group_latest(session: Session, group_id: str | None,
                 version_id: int | None) -> list[tuple[Conversation, Evaluation | None]]:
    q = select(Conversation).order_by(Conversation.conversation_id)
    if group_id:
        q = q.where(Conversation.group_id == group_id)
    convs = list(session.exec(q))
    latest = latest_map(session, [c.id for c in convs], version_id)
    return [(c, latest.get(c.id)) for c in convs]


def criterion_rows(session: Session, eval_ids: Iterable[int]) -> dict[int, dict[str, CriterionResult]]:
    ids = list(eval_ids)
    out: dict[int, dict[str, CriterionResult]] = {i: {} for i in ids}
    if ids:
        for r in session.exec(select(CriterionResult).where(CriterionResult.evaluation_id.in_(ids))):
            out[r.evaluation_id][r.criterion_key] = r
    return out


def appeals_by_eval(session: Session, eval_ids: Iterable[int]) -> dict[int, list[Appeal]]:
    """Апелляции оценок, от старых к новым."""
    ids = list(eval_ids)
    out: dict[int, list[Appeal]] = {i: [] for i in ids}
    if ids:
        for a in session.exec(select(Appeal).where(Appeal.evaluation_id.in_(ids)).order_by(Appeal.id)):
            out[a.evaluation_id].append(a)
    return out


class ChecklistCache:
    """Разобранные тела версий: одна версия — один разбор на запрос."""

    def __init__(self, session: Session):
        self._s = session
        self._cache: dict[int, Checklist | None] = {}

    def get(self, version_id: int | None) -> Checklist | None:
        if version_id is None:
            return None
        if version_id not in self._cache:
            ver = self._s.get(ChecklistVersion, version_id)
            self._cache[version_id] = Checklist.model_validate(ver.body) if ver else None
        return self._cache[version_id]
