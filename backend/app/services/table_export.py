"""Выгрузка результатов группы в CSV и JSON (FR-EXP-01, CONTRACTS §5).

По последней оценке каждого диалога для версии чек-листа. Ответы и баллы — финальные (с решениями по
апелляциям), рядом итог AI и финальный. CSV — для Excel в RU-локали: UTF-8 с BOM, `;`, запятая в дробях.
Файл сдачи организаторам — другой модуль (`results_export.py`).
"""
from __future__ import annotations

import csv
import io
import re

from sqlmodel import Session

from ..models import ChecklistVersion
from . import latest
from .evaluations import _ans_api

FORMATS = ("csv", "json")


def _num(x):
    return None if x is None else round(float(x), 2)


def build(session: Session, group_id: str | None, checklist_version_id: int | None = None
          ) -> tuple[ChecklistVersion | None, list[str], list[dict]]:
    """(версия, колонки, строки). Строка — плоские поля как в CSV плюс `criteria` и `overview` для JSON."""
    ver = latest.resolve_version(session, checklist_version_id)
    vid = ver.id if ver else None
    cl = latest.ChecklistCache(session).get(vid)
    crit = cl.enabled_criteria() if cl else []
    pairs = latest.group_latest(session, group_id, vid)
    ids = [e.id for _, e in pairs if e]
    rows = latest.criterion_rows(session, ids)
    appeals = latest.appeals_by_eval(session, ids)

    cols = ["conversation_id", "channel", "language", "checklist_version", "model", "status"]
    for c in crit:
        cols += [f"c{c.key}_answer", f"c{c.key}_points"]
    cols += ["ai_total", "final_total", "critical", "needs_review", "overridden", "open_appeals", "cost_usd",
             "evaluation_id"]

    label = f"{ver.checklist_key} v{ver.version}" if ver else None
    out = []
    for conv, ev in pairs:
        by_key = rows.get(ev.id, {}) if ev else {}
        rec: dict = {"conversation_id": conv.conversation_id, "channel": conv.channel, "language": conv.language,
                     "checklist_version": label, "model": ev.model if ev else None,
                     "status": ev.status if ev else "not_evaluated"}
        details = []
        for c in crit:
            r = by_key.get(c.key)
            rec[f"c{c.key}_answer"] = _ans_api(r.final_answer) if r else None
            rec[f"c{c.key}_points"] = _num(r.final_points) if r else None
            if r:
                last = next((a for a in reversed(appeals.get(ev.id, [])) if a.criterion_key == c.key), None)
                details.append({
                    "key": c.key, "title": c.title, "ai_answer": _ans_api(r.ai_answer), "ai_points": _num(r.ai_points),
                    "final_answer": _ans_api(r.final_answer), "final_points": _num(r.final_points),
                    "overridden": r.overridden, "confidence": r.confidence, "reasoning": r.reasoning,
                    "na_reason": r.na_reason, "advice": r.advice, "evidence": r.evidence or [], "issues": r.issues or [],
                    "appeal": {"id": last.id, "status": last.status, "comment": last.comment,
                               "decision_reason": last.decision_reason} if last else None,
                })
        ev_appeals = appeals.get(ev.id, []) if ev else []
        rec |= {
            "ai_total": _num(ev.ai_total) if ev else None, "final_total": _num(ev.final_total) if ev else None,
            "critical": ev.critical if ev else None, "needs_review": ev.needs_review if ev else None,
            "overridden": ",".join(k for k, r in by_key.items() if r.overridden) or None,
            "open_appeals": sum(a.status == "open" for a in ev_appeals) if ev else None,
            "cost_usd": round(ev.cost_usd or 0, 6) if ev else None, "evaluation_id": ev.id if ev else None,
            "criteria": details, "overview": ev.overview if ev else None,
        }
        out.append(rec)
    return ver, cols, out


_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return (f"{v:.6f}".rstrip("0").rstrip(".") if v else "0").replace(".", ",")
    s = str(v)
    if isinstance(v, str) and s[:1] in _FORMULA_START:  # защита от формул при открытии в Excel
        return "'" + s
    return s


def to_csv(cols: list[str], rows: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(cols)
    for r in rows:
        w.writerow([_cell(r.get(c)) for c in cols])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def filename(group_id: str | None, ver: ChecklistVersion | None, fmt: str) -> str:
    g = re.sub(r"[^A-Za-z0-9_-]+", "_", group_id or "all")
    v = f"-{re.sub(r'[^A-Za-z0-9_-]+', '_', ver.checklist_key)}-v{ver.version}" if ver else ""
    return f"cqa-{g}{v}.{fmt}"
