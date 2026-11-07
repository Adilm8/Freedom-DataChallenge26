"""Gold-разметка DEV: черновики, вторая разметка, проверка и сохранение (FR-GOLD-01…05).

Файлы лежат в `data/gold/` (каталог переопределяется через `GOLD_DIR` в тестах):
`selection.json`, `split.json`, `drafts/<id>.json`, `second_opinion/<id>.json`, `gold_labels.json`.
Gold нигде не попадает в промпт: модуль не импортируется ни из evaluator, ни из prompt_builder.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..domain import Checklist
from . import scoring

ROOT = Path(__file__).resolve().parents[3]
GOLD_DIR: Path = ROOT / "data" / "gold"
CHECKLIST_VERSION = "default-v1"
LABELED_BY = "Lida"

_lock = threading.Lock()


class GoldError(ValueError):
    pass


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _safe_id(conversation_id: str) -> str:
    if not conversation_id or "/" in conversation_id or "\\" in conversation_id or conversation_id.startswith("."):
        raise GoldError("некорректный conversation_id")
    return conversation_id


def selection() -> list[dict]:
    data = _read_json(GOLD_DIR / "selection.json", [])
    return [x for x in data if isinstance(x, dict) and x.get("conversation_id")] if isinstance(data, list) else []


def split_map() -> dict[str, str]:
    data = _read_json(GOLD_DIR / "split.json", {})
    out: dict[str, str] = {}
    if isinstance(data, dict):
        for part in ("dev", "holdout"):
            for cid in data.get(part) or []:
                out[cid] = part
    return out


def draft(conversation_id: str) -> dict | None:
    d = _read_json(GOLD_DIR / "drafts" / f"{_safe_id(conversation_id)}.json", None)
    return d if isinstance(d, dict) else None


def second_opinion(conversation_id: str) -> dict | None:
    d = _read_json(GOLD_DIR / "second_opinion" / f"{_safe_id(conversation_id)}.json", None)
    return d if isinstance(d, dict) else None


def labels_path() -> Path:
    return GOLD_DIR / "gold_labels.json"


def read_labels() -> dict:
    data = _read_json(labels_path(), None)
    if not isinstance(data, dict) or not isinstance(data.get("items"), dict):
        return {"checklist_version": CHECKLIST_VERSION, "items": {}}
    return data


def label(conversation_id: str) -> dict | None:
    return read_labels()["items"].get(conversation_id)


def _draft_answers(d: dict | None) -> dict[str, Any]:
    return {k: v.get("answer") for k, v in ((d or {}).get("criteria") or {}).items() if isinstance(v, dict)}


def count_low(d: dict | None) -> int:
    return sum(1 for v in ((d or {}).get("criteria") or {}).values()
               if isinstance(v, dict) and v.get("confidence") == "low")


def list_rows(pk_by_cid: dict[str, int]) -> list[dict]:
    split = split_map()
    labels = read_labels()["items"]
    rows = []
    for s in selection():
        cid = s["conversation_id"]
        lab = labels.get(cid)
        d = draft(cid)
        rows.append({
            "conversation_id": cid,
            "conversation_pk": pk_by_cid.get(cid),
            "language": s.get("language"),
            "channel": s.get("channel"),
            "why": s.get("why"),
            "split": split.get(cid),
            "has_draft": d is not None,
            "has_second_opinion": second_opinion(cid) is not None,
            "low_confidence": count_low(d),
            "has_label": lab is not None,
            "reviewed": bool(lab and lab.get("reviewed_at")),
            "changed": len((lab or {}).get("changed") or []),
            "uncertain": len((lab or {}).get("uncertain") or []),
            "total": (lab or {}).get("total"),
        })
    return rows


def criteria_info(checklist: Checklist) -> list[dict]:
    return [{
        "key": c.key, "title": c.title, "type": c.type, "weight": c.weight,
        "allowed_answers": c.allowed_answers(),
        "scale": [s.model_dump() for s in c.scale] if c.scale else None,
        "definition": c.definition,
    } for c in checklist.enabled_criteria()]


def save_label(conversation_id: str, checklist: Checklist, answers_in: dict[str, Any], uncertain: list[str],
               notes: str, reviewed: bool | None) -> dict:
    """Валидирует ответы, считает итог и атомарно записывает разметку. Возвращает сохранённый item."""
    _safe_id(conversation_id)
    crit = {c.key: c for c in checklist.enabled_criteria()}
    for k in list(answers_in) + list(uncertain):
        if k not in crit:
            raise GoldError(f"нет критерия {k!r} в активном чек-листе")
    d = draft(conversation_id)
    draft_ans = _draft_answers(d)

    with _lock:
        data = read_labels()
        prev = data["items"].get(conversation_id) or {}
        merged: dict[str, Any] = {}
        for k in crit:  # приоритет: запрос > прошлая разметка > черновик
            if k in answers_in:
                merged[k] = answers_in[k]
            elif k in (prev.get("criteria") or {}):
                merged[k] = prev["criteria"][k].get("answer")
            elif draft_ans.get(k) is not None:
                merged[k] = draft_ans[k]
        try:
            clean = {k: crit[k].coerce_answer(v) for k, v in merged.items() if v is not None}
        except ValueError as e:
            raise GoldError(str(e)) from e
        res = scoring.compute(checklist, clean)
        changed = sorted(k for k, v in clean.items() if k in draft_ans and draft_ans[k] != v) if d else []
        reviewed_at = prev.get("reviewed_at")
        if reviewed is True:
            reviewed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        elif reviewed is False:
            reviewed_at = None
        item = {
            "labeled_by": LABELED_BY,
            "criteria": {k: {"answer": v} for k, v in clean.items()},
            "total": res.total,
            "notes": notes or "",
            "uncertain": sorted(set(uncertain)),
            "changed": changed,
            "reviewed_at": reviewed_at,
        }
        data["checklist_version"] = data.get("checklist_version") or CHECKLIST_VERSION
        data["items"][conversation_id] = item
        _atomic_write(labels_path(), data)
    return item


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".gold_labels.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
