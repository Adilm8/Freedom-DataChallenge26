"""Экран качества (FR-OPS-05, NFR-12…14): метрики сохранённых прогонов `eval/run_eval.py`.

Только чтение файлов `eval/runs/*.json` (папку можно переопределить переменной `CQA_EVAL_RUNS_DIR`).
Id прогона — имя файла без `.json`; незавершённый прогон (`*.partial.json`) отдаётся с `complete: false`
и без метрик: они считаются только в конце прогона.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..db import get_session
from ..services import latest as latest_svc

router = APIRouter(prefix="/quality", tags=["quality"])

RUNS_DIR = Path(__file__).resolve().parents[3] / "eval" / "runs"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")
STAMP_RE = re.compile(r"^(\d{8})-(\d{6})")


def runs_dir() -> Path:
    env = os.environ.get("CQA_EVAL_RUNS_DIR")
    return Path(env) if env else RUNS_DIR


def _path(name: str) -> Path:
    """Файл прогона по id; всё, что выходит за папку прогонов, — 404."""
    name = name[:-5] if name.endswith(".json") else name
    if not NAME_RE.match(name) or ".." in name:
        raise HTTPException(404, "прогон не найден")
    base = runs_dir().resolve()
    path = (base / f"{name}.json").resolve()
    if path.parent != base or not path.is_file():
        raise HTTPException(404, "прогон не найден")
    return path


def _stamp_iso(stamp: str | None) -> str | None:
    m = STAMP_RE.match(stamp or "")
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def _name_parts(name: str) -> dict:
    """`<время>_<провайдер>_<модель>_<стратегия>_<split>` — так `run_eval.py` называет файлы."""
    base = name.removesuffix(".partial")
    parts = base.split("_")
    if len(parts) < 5:
        return {}
    strategy = "per_criterion" if parts[-3:-1] == ["per", "criterion"] else parts[-2]  # в имени стратегии есть «_»
    return {"stamp": parts[0], "provider": parts[1], "strategy": strategy, "split": parts[-1]}


def _quality_checks(details: list[dict]) -> dict:
    """Доля «требует проверки», ретраев и неудачных оценок по первому повтору (architecture/quality-eval.md §2)."""
    first = details[0] if details else {}
    rows = [d for d in first.values() if isinstance(d, dict)]
    n = len(rows)
    calls = sum(int(d.get("calls") or 0) for d in rows)
    retries = sum(int(d.get("retries") or 0) for d in rows)
    return {
        "dialogs": n,
        "needs_review_share": round(sum(bool(d.get("needs_review")) for d in rows) / n, 4) if n else None,
        "not_done": sum(d.get("status") not in (None, "done") for d in rows),
        "calls": calls,
        "retry_share": round(retries / calls, 4) if calls else None,
        "critical_dialogs": sum(bool(d.get("critical")) for d in rows),
    }


def _summary(name: str, data: dict, path: Path) -> dict:
    complete = not name.endswith(".partial") and isinstance(data.get("metrics"), dict)
    parts = _name_parts(name)
    m = data.get("metrics") or {}
    total = m.get("total") or {}
    cost = m.get("cost") or {}
    flag = next(({"key": k, **v} for k, v in (m.get("criteria") or {}).items() if "recall" in v), None)
    details = data.get("details") or []
    pred = data.get("pred") or []
    created = _stamp_iso(data.get("created_at") or parts.get("stamp"))
    if not created:
        created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    out = {
        "name": name,
        "file": path.name,
        "complete": complete,
        "created_at": created,
        "provider": data.get("provider") or parts.get("provider"),
        "model": data.get("model"),
        "strategy": data.get("strategy") or parts.get("strategy"),
        "split": data.get("split") or parts.get("split"),
        "approved": data.get("approved"),
        "prompt_version": data.get("prompt_version"),
        "gold_source": m.get("gold_source") or [],
        "repeat": len(pred),
        "dialogs": m.get("dialogs") if complete else len(pred[-1]) if pred else 0,
        "mean_agreement": m.get("mean_agreement"),
        "mae": total.get("mae"),
        "max_abs": total.get("max_abs"),
        "within_5": total.get("within_5"),
        "within_10": total.get("within_10"),
        "flag_key": flag["key"] if flag else None,
        "flag_recall": flag.get("recall") if flag else None,
        "flag_precision": flag.get("precision") if flag else None,
        "stability": m.get("stability"),
        "cost_total_usd": cost.get("total_usd"),
        "cost_per_dialog_usd": cost.get("per_dialog_usd"),
        "mean_seconds": cost.get("mean_seconds"),
        "checks": _quality_checks(details),
    }
    if not complete:  # стоимость уже оплаченных ответов — из деталей
        spent = sum(float(d.get("cost_usd") or 0) for ds in details for d in ds.values() if isinstance(d, dict))
        out["cost_total_usd"] = round(spent, 4)
        n = sum(len(ds) for ds in details)
        out["cost_per_dialog_usd"] = round(spent / n, 5) if n else None
    return out


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"файл прогона не читается: {type(e).__name__}") from e
    if not isinstance(data, dict):
        raise ValueError("файл прогона не читается: ожидался объект JSON")
    return data


def _titles(session: Session) -> dict[str, str]:
    """Названия критериев из активной версии чек-листа (в файле прогона только коды)."""
    try:
        ver = latest_svc.resolve_version(session, None)
        return {c["key"]: c.get("title") or c["key"] for c in (ver.body or {}).get("criteria", [])} if ver else {}
    except Exception:  # экран качества не должен падать из-за БД
        return {}


@router.get("/runs")
def list_runs() -> dict:
    """Сводка по каждому прогону, новые сверху. Битый файл — строка с `error`, а не 500."""
    base = runs_dir()
    rows: list[dict] = []
    if base.is_dir():
        for path in base.glob("*.json"):
            name = path.name[:-5]
            if not NAME_RE.match(name):
                continue
            try:
                rows.append(_summary(name, _read(path), path))
            except ValueError as e:
                rows.append({"name": name, "file": path.name, "complete": False, "error": str(e),
                             "created_at": _stamp_iso(name)})
    rows.sort(key=lambda r: (r.get("created_at") or "", r["name"]), reverse=True)
    return {"dir": str(base), "runs": rows}


@router.get("/runs/{name}")
def get_run(name: str, session: Session = Depends(get_session)) -> dict:
    """Полные метрики прогона: критерии, языки и каналы, калибровка, стабильность, цена."""
    path = _path(name)
    name = path.name[:-5]
    try:
        data = _read(path)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    out = _summary(name, data, path)
    m = data.get("metrics") or {}
    titles = _titles(session)
    meta = data.get("meta") or {}
    out.update({
        "criteria": [{"key": k, "title": titles.get(k, k), **v} for k, v in sorted((m.get("criteria") or {}).items())],
        "total": m.get("total"),
        "by_language": m.get("by_language") or {},
        "by_channel": m.get("by_channel") or {},
        "calibration": m.get("calibration") or {},
        "cost": m.get("cost") or {},
        "languages": sorted({str(v.get("language")) for v in meta.values() if isinstance(v, dict)}),
    })
    return out
