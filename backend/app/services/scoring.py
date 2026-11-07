"""Расчёт баллов по чек-листу (FR-SCORE-01…08, ADR-006).

Модель только классифицирует; все цифры считает этот модуль. Чистые функции, без БД.

- «Да» = вес, «Нет» = 0, шкала = вес × ступень / максимальная ступень.
- Флаг баллов не даёт и в вес не входит; ответ «yes» попадает в `critical`.
- N/A и пропущенный ответ исключают вес критерия; итог = Σ баллов / Σ применимых весов × 100.
- Округление — половина вверх (Decimal), не банковское `round()`.
- Нет применимых критериев с весом → итог `None`.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Mapping

from ..domain import Answer, Checklist, CriterionScore, ScoreResult, SectionScore


def round_half_up(value: Decimal | float, digits: int = 2) -> float:
    d = value if isinstance(value, Decimal) else Decimal(str(value))
    q = Decimal(1).scaleb(-digits)
    return float(d.quantize(q, rounding=ROUND_HALF_UP))


def _dec(x: float | int) -> Decimal:
    return Decimal(str(x))


def compute(checklist: Checklist, answers: Mapping[str, Answer | None]) -> ScoreResult:
    """Считает итог по ответам. Ответы приводятся и проверяются критерием (ValueError, если не разрешён)."""
    settings = checklist.settings
    per: dict[str, CriterionScore] = {}
    points_by_key: dict[str, Decimal] = {}
    critical: list[str] = []
    missing: list[str] = []
    applicable_weight = Decimal(0)
    points_sum = Decimal(0)

    for c in checklist.enabled_criteria():
        raw = answers.get(c.key)
        if raw is None:
            missing.append(c.key)
            per[c.key] = CriterionScore(answer=None, applicable=False, points=None, weight=c.weight)
            continue
        ans = c.coerce_answer(raw)

        if c.type == "flag":
            if ans == "yes":
                critical.append(c.key)
            per[c.key] = CriterionScore(answer=ans, applicable=False, points=None, weight=0)
            continue

        if ans == "na":
            per[c.key] = CriterionScore(answer=ans, applicable=False, points=None, weight=c.weight)
            continue

        w = _dec(c.weight)
        if c.type == "binary":
            pts = w if ans == "yes" else Decimal(0)
        else:  # scale
            pts = w * _dec(ans) / _dec(c.max_step)

        applicable_weight += w
        points_sum += pts
        points_by_key[c.key] = pts
        per[c.key] = CriterionScore(answer=ans, applicable=True, points=float(pts), weight=c.weight)

    total: float | None
    if applicable_weight > 0:
        total = round_half_up(points_sum / applicable_weight * 100, settings.rounding)
        for key, pts in points_by_key.items():
            per[key].contribution = round_half_up(pts / applicable_weight * 100, settings.rounding)
        if settings.critical_policy == "zero_total" and critical:
            total = 0.0
    else:
        total = None

    sections: list[SectionScore] = []
    for s in checklist.sections:
        crit = [c for c in checklist.enabled_criteria() if c.section == s.id and c.type != "flag"]
        if not crit and not any(c.section == s.id for c in checklist.enabled_criteria()):
            continue
        s_points = sum((points_by_key.get(c.key, Decimal(0)) for c in crit), Decimal(0))
        s_weight = sum((_dec(c.weight) for c in crit if per[c.key].applicable), Decimal(0))
        pct = round_half_up(s_points / s_weight * 100, settings.rounding) if s_weight > 0 else None
        sections.append(
            SectionScore(id=s.id, title=s.title, points=float(s_points), applicable_weight=float(s_weight), pct=pct)
        )

    return ScoreResult(
        total=total,
        applicable_weight=float(applicable_weight),
        points_sum=float(points_sum),
        sections=sections,
        criteria=per,
        critical=critical,
        missing=missing,
        critical_policy=settings.critical_policy,
    )
