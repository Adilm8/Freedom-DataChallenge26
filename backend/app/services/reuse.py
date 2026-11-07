"""Инкрементальная переоценка (FR-CHK-10, evaluation-pipeline.md §10).

Ответ критерия переиспользуется, если в одной из прошлых оценок диалога есть строка с тем же
`criterion_hash` (поля промпта + версия промпта + модель). Вес, секция и порядок в хеш не входят,
поэтому их смена не требует вызовов LLM. Страховки применяются заново, их старые пометки снимаются.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlmodel import Session, select

from ..domain import Criterion
from ..models import CriterionResult, Evaluation
from .evaluator import criterion_hash
from .guards import GUARD_PREFIXES
from .validator import CriterionOutput

LOOKBACK = 10  # сколько последних оценок диалога просматриваем


@dataclass
class ReusePlan:
    reused: dict[str, CriterionOutput] = field(default_factory=dict)
    source: dict[str, int] = field(default_factory=dict)      # ключ → id оценки, откуда взят ответ
    overview: dict | None = None

    def to_call(self, criteria: list[Criterion]) -> list[Criterion]:
        return [c for c in criteria if c.key not in self.reused]


def _output(c: Criterion, row: CriterionResult) -> CriterionOutput | None:
    try:
        answer = c.coerce_answer(row.ai_answer)
    except ValueError:
        return None
    return CriterionOutput(
        key=c.key, answer=answer, reasoning=row.reasoning or "", confidence=row.confidence or "medium",
        evidence=list(row.evidence or []), checked_range=row.checked_range, na_reason=row.na_reason,
        advice=row.advice, issues=[i for i in (row.issues or []) if not i.startswith(GUARD_PREFIXES)],
    )


def plan(session: Session, conversation_pk: int, criteria: list[Criterion], *, model: str,
         prompt_version: str) -> ReusePlan:
    """Что взять из прошлых оценок диалога, а что оценить вызовами."""
    evs = session.exec(
        select(Evaluation).where(Evaluation.conversation_pk == conversation_pk, Evaluation.status != "failed")
        .order_by(Evaluation.id.desc()).limit(LOOKBACK)
    ).all()
    out = ReusePlan()
    if not evs:
        return out
    want = {c.key: criterion_hash(c, prompt_version, model) for c in criteria}
    by_key = {c.key: c for c in criteria}
    for ev in evs:  # от новых к старым: берём самый свежий совпавший ответ
        rows = session.exec(select(CriterionResult).where(CriterionResult.evaluation_id == ev.id)).all()
        took = False
        for r in rows:
            key = r.criterion_key
            if key in out.reused or key not in want or r.criterion_hash != want[key] or not r.ai_answer:
                continue
            o = _output(by_key[key], r)
            if o is not None:
                out.reused[key] = o
                out.source[key] = r.reused_from_evaluation_id or ev.id  # ссылка на исходную оценку
                took = True
        if took and out.overview is None and ev.overview and ev.prompt_version == prompt_version:
            out.overview = ev.overview
    return out
