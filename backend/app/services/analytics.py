"""Сводка по группе (FR-ANL-01…03): по последней оценке каждого диалога для версии чек-листа.

Цифры «итог», «выполнение критерия», «грубые ошибки» — по финальным ответам (с решениями по апелляциям);
рядом — те же цифры по ответам AI, чтобы было видно, что изменили апелляции.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from sqlmodel import Session, select

from ..domain import Criterion
from ..models import Evaluation
from . import latest, review
from .scoring import round_half_up

BUCKET = 10  # ширина корзины гистограммы итогов, п.п.


def _avg(xs: list[float]) -> float | None:
    return round_half_up(sum(xs) / len(xs), 2) if xs else None


def _rate(n: int, d: int) -> float | None:
    return round_half_up(n / d, 4) if d else None


def _pct(c: Criterion, ans: str) -> float | None:
    """Доля балла критерия, %: «Да» = 100, ступень = ступень / максимум. N/A и флаг — None."""
    if ans in ("", "na") or c.type == "flag":
        return None
    if c.type == "binary":
        return 100.0 if ans == "yes" else 0.0
    try:
        return int(ans) / c.max_step * 100
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _passed(c: Criterion, ans: str) -> bool | None:
    """Выполнен ли критерий: полный балл; у флага — «нарушения нет». N/A и пусто — None."""
    if ans in ("", "na"):
        return None
    if c.type == "flag":
        return ans == "no"
    return _pct(c, ans) == 100.0


def _histogram(values: list[float], ai_values: list[float]) -> list[dict]:
    out = []
    for lo in range(0, 100, BUCKET):
        hi = lo + BUCKET

        def inside(v: float) -> bool:
            return lo <= v < hi or (hi == 100 and v == 100)

        out.append({"from": lo, "to": hi, "count": sum(map(inside, values)), "ai_count": sum(map(inside, ai_values))})
    return out


def _slice(items: list[tuple]) -> dict:
    """Разрез: диалоги, оценено, средние итоги, грубые ошибки, «требует проверки»."""
    evs = [e for _, e in items if e]
    return {
        "conversations": len(items), "count": len(evs),
        "avg_total": _avg([e.final_total for e in evs if e.final_total is not None]),
        "avg_ai_total": _avg([e.ai_total for e in evs if e.ai_total is not None]),
        "critical_count": sum(e.critical for e in evs),
        "needs_review_count": sum(e.needs_review for e in evs),
    }


def summarize(session: Session, group_id: str | None, checklist_version_id: int | None = None) -> dict:
    ver = latest.resolve_version(session, checklist_version_id)
    vid = ver.id if ver else None
    cl = latest.ChecklistCache(session).get(vid)
    pairs = latest.group_latest(session, group_id, vid)
    evs = [e for _, e in pairs if e]
    ids = [e.id for e in evs]
    rows = latest.criterion_rows(session, ids)
    appeals = latest.appeals_by_eval(session, ids)
    conv_of = {e.id: c for c, e in pairs if e}

    finals = [e.final_total for e in evs if e.final_total is not None]
    ais = [e.ai_total for e in evs if e.ai_total is not None]

    # --- критерии
    by_criterion = []
    pct_by_key_eval: dict[str, dict[int, float]] = defaultdict(dict)
    for c in (cl.enabled_criteria() if cl else []):
        answers: Counter = Counter()
        pcts, ai_pcts, not_passed = [], [], []
        applicable = passed = ai_applicable = ai_passed = na = answered = overridden = low = 0
        for e in evs:
            r = rows[e.id].get(c.key)
            if r is None:
                continue
            fa, aa = r.final_answer or "", r.ai_answer or ""
            if fa:
                answered += 1
                answers[fa] += 1
                na += fa == "na"
            ok = _passed(c, fa)
            if ok is not None:
                applicable += 1
                passed += ok
                if not ok:
                    not_passed.append(conv_of[e.id].id)
            ai_ok = _passed(c, aa)
            if ai_ok is not None:
                ai_applicable += 1
                ai_passed += ai_ok
            if (p := _pct(c, fa)) is not None:
                pcts.append(p)
                pct_by_key_eval[c.key][e.id] = p
            if (p := _pct(c, aa)) is not None:
                ai_pcts.append(p)
            overridden += r.overridden
            low += r.confidence == "low"
        aps = [a for e in evs for a in appeals[e.id] if a.criterion_key == c.key]
        by_criterion.append({
            "key": c.key, "title": c.title, "section": c.section, "type": c.type, "weight": c.weight,
            "count": answered, "pass_rate": _rate(passed, applicable), "ai_pass_rate": _rate(ai_passed, ai_applicable),
            "avg_pct": _avg(pcts), "ai_avg_pct": _avg(ai_pcts), "na_rate": _rate(na, answered),
            "answers": dict(answers), "not_passed_ids": sorted(not_passed), "low_confidence_count": low,
            "overridden_count": overridden, "appeals_count": len(aps),
            "appeals_changed": sum(a.status == "changed" for a in aps),
        })

    # --- разрезы
    by_lang: dict[str, list] = defaultdict(list)
    by_chan: dict[str, list] = defaultdict(list)
    for c, e in pairs:
        by_lang[c.language].append((c, e))
        by_chan[c.channel].append((c, e))

    # --- темы (FR-ANL-02): тема из overview, группировка без учёта регистра
    topics: dict[str, list[Evaluation]] = defaultdict(list)
    forms: dict[str, Counter] = defaultdict(Counter)
    resolved = Counter()
    for e in evs:
        ov = e.overview or {}
        t = " ".join(str(ov.get("topic") or "").split()).rstrip(".")
        if ov.get("resolved"):
            resolved[ov["resolved"]] += 1
        if not t:
            continue
        topics[t.casefold()].append(e)
        forms[t.casefold()][t] += 1
    topic_rows = []
    for k, es in topics.items():
        rs = [(e.overview or {}).get("resolved") for e in es]
        known = [x for x in rs if x in ("yes", "no", "unclear")]
        weakest = None
        for c in (cl.enabled_criteria() if cl else []):
            ps = [pct_by_key_eval[c.key][e.id] for e in es if e.id in pct_by_key_eval[c.key]]
            if ps and (weakest is None or sum(ps) / len(ps) < weakest["avg_pct"]):
                weakest = {"key": c.key, "title": c.title, "avg_pct": _avg(ps)}
        topic_rows.append({
            "topic": forms[k].most_common(1)[0][0], "count": len(es),
            "resolved_rate": _rate(sum(x == "yes" for x in known), len(known)),
            "avg_total": _avg([e.final_total for e in es if e.final_total is not None]),
            "weakest": weakest if weakest and weakest["avg_pct"] is not None and weakest["avg_pct"] < 100 else None,
            "ids": sorted(conv_of[e.id].id for e in es),
        })
    topic_rows.sort(key=lambda t: (-t["count"], t["topic"]))

    # --- стоимость: текущие оценки и все прогоны по группе (включая повторные)
    all_q = select(Evaluation.cost_usd).where(Evaluation.conversation_pk.in_([c.id for c, _ in pairs]))
    if vid:
        all_q = all_q.where(Evaluation.checklist_version_id == vid)
    all_costs = list(session.exec(all_q))
    all_appeals = [a for e in evs for a in appeals[e.id]]

    return {
        "group_id": group_id, "checklist_version_id": vid,
        "checklist_version": {"id": ver.id, "key": ver.checklist_key, "version": ver.version, "name": ver.name} if ver else None,
        "conversations": len(pairs), "count": len(evs), "not_evaluated": len(pairs) - len(evs),
        "status_counts": dict(Counter(e.status for e in evs)),
        "avg_total": _avg(finals), "avg_ai_total": _avg(ais), "avg_final_total": _avg(finals),
        "histogram": _histogram(finals, ais),
        "by_criterion": by_criterion,
        "by_language": {k: _slice(v) for k, v in sorted(by_lang.items())},
        "by_channel": {k: _slice(v) for k, v in sorted(by_chan.items())},
        "critical_count": sum(e.critical for e in evs),
        "ai_critical_count": sum(bool((e.ai_score or {}).get("critical")) for e in evs),
        "critical_ids": sorted(conv_of[e.id].id for e in evs if e.critical),
        "needs_review_count": sum(e.needs_review for e in evs),
        "review_queue_count": len(review.queue(session, group_id, vid)),
        "appeals": {s: sum(a.status == s for a in all_appeals) for s in ("open", "confirmed", "changed")},
        "resolved": {k: resolved.get(k, 0) for k in ("yes", "no", "unclear")},
        "topics": topic_rows,
        "cost": {
            "latest_usd": round(sum(e.cost_usd or 0 for e in evs), 6),
            "total_usd": round(sum(x or 0 for x in all_costs), 6),
            "evaluations_total": len(all_costs),
            "avg_per_dialog_usd": round(sum(e.cost_usd or 0 for e in evs) / len(evs), 6) if evs else None,
            "tokens_in": sum(e.tokens_in for e in evs), "tokens_out": sum(e.tokens_out for e in evs),
            "models": [{"model": m, "count": n} for m, n in Counter(e.model for e in evs).most_common()],
        },
    }
