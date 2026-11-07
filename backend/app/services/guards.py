"""Правила-страховки из данных критерия (FR-EVAL-12, evaluation-pipeline.md §6).

Правило: «если все булевы факты из `when` верны (`!` — отрицание), ответ должен быть из `expect`».
`flag` — пометка «требует проверки», `override` — замена ответа на `set`. Код не знает кодов критериев.
"""

from __future__ import annotations

from ..domain import Criterion
from .validator import CriterionOutput, Issue


def _holds(cond: str, facts: dict[str, bool]) -> bool | None:
    neg = cond.startswith("!")
    name = cond[1:] if neg else cond
    if name not in facts or facts[name] is None:
        return None  # факта нет — правило не применяем
    return (not facts[name]) if neg else bool(facts[name])


def apply(results: dict[str, CriterionOutput], facts: dict[str, bool], criteria: list[Criterion]) -> list[Issue]:
    issues: list[Issue] = []
    for c in criteria:
        out = results.get(c.key)
        if out is None or out.answer is None:
            continue
        for g in c.guards:
            checks = [_holds(w, facts) for w in g.when]
            if not checks or any(v is not True for v in checks):
                continue
            if str(out.answer) in g.expect:
                continue
            msg = f"{c.key}: по фактам ({', '.join(g.when)}) ожидался ответ из {g.expect}, модель ответила {out.answer!r}"
            if g.action == "override" and g.set is not None:
                try:
                    new = c.coerce_answer(g.set)
                except ValueError:
                    continue
                out.issues.append(f"ответ заменён правилом: {out.answer} → {new}")
                out.answer = new
                issues.append(Issue("G-override", msg, c.key))
            else:
                out.issues.append("противоречие фактам: " + ", ".join(g.when))
                issues.append(Issue("G-flag", msg, c.key))
    return issues
