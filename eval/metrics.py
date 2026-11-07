"""Метрики близости к gold (architecture/quality-eval.md §2, NFR-01, NFR-13, NFR-14). Чистые функции."""

from __future__ import annotations

from collections import defaultdict
from statistics import mean


def _step_index(answer, scale_values: list[int]) -> int | None:
    if not isinstance(answer, int) or answer not in scale_values:
        return None
    return sorted(scale_values, reverse=True).index(answer)


def compare(
    pred: dict[str, dict],
    gold: dict[str, dict],
    meta: dict[str, dict],
    criteria: dict[str, dict],
) -> dict:
    """pred/gold: {conversation_id: {"answers": {key: answer}, "total": float | None, ...}};
    meta: {conversation_id: {"language", "channel"}}; criteria: {key: {"type", "scale": [values] | None}}."""
    ids = [cid for cid in gold if cid in pred]
    per_crit: dict[str, dict] = {}
    for key, c in criteria.items():
        pairs = [(pred[cid]["answers"].get(key), gold[cid]["answers"].get(key)) for cid in ids if key in gold[cid]["answers"]]
        pairs = [(p, g) for p, g in pairs if p is not None]
        if not pairs:
            continue
        exact = sum(1 for p, g in pairs if p == g) / len(pairs)
        row = {"n": len(pairs), "exact": round(exact, 4)}
        if c["type"] == "scale":
            vals = c.get("scale") or []
            within = []
            for p, g in pairs:
                ip, ig = _step_index(p, vals), _step_index(g, vals)
                within.append(p == g or (ip is not None and ig is not None and abs(ip - ig) <= 1))
            row["within_1_step"] = round(sum(within) / len(within), 4)
        if c["type"] == "flag":
            tp = sum(1 for p, g in pairs if p == "yes" and g == "yes")
            fn = sum(1 for p, g in pairs if p != "yes" and g == "yes")
            fp = sum(1 for p, g in pairs if p == "yes" and g != "yes")
            row["recall"] = round(tp / (tp + fn), 4) if tp + fn else None
            row["precision"] = round(tp / (tp + fp), 4) if tp + fp else None
        per_crit[key] = row

    diffs = [abs(pred[cid]["total"] - gold[cid]["total"]) for cid in ids
             if pred[cid].get("total") is not None and gold[cid].get("total") is not None]
    totals = {
        "n": len(diffs),
        "mae": round(mean(diffs), 2) if diffs else None,
        "max_abs": round(max(diffs), 2) if diffs else None,
        "within_5": round(sum(d <= 5 for d in diffs) / len(diffs), 4) if diffs else None,
        "within_10": round(sum(d <= 10 for d in diffs) / len(diffs), 4) if diffs else None,
    }

    def slice_by(field: str) -> dict:
        groups: dict[str, list[str]] = defaultdict(list)
        for cid in ids:
            groups[str(meta.get(cid, {}).get(field, "?"))].append(cid)
        out = {}
        for g, cids in groups.items():
            agree = [pred[c]["answers"].get(k) == gold[c]["answers"].get(k)
                     for c in cids for k in gold[c]["answers"] if k in criteria and pred[c]["answers"].get(k) is not None]
            d = [abs(pred[c]["total"] - gold[c]["total"]) for c in cids
                 if pred[c].get("total") is not None and gold[c].get("total") is not None]
            out[g] = {"n": len(cids), "agreement": round(sum(agree) / len(agree), 4) if agree else None,
                      "mae": round(mean(d), 2) if d else None}
        return out

    exacts = [r["exact"] for k, r in per_crit.items() if criteria[k]["type"] != "flag"]
    return {
        "dialogs": len(ids),
        "mean_agreement": round(mean(exacts), 4) if exacts else None,
        "criteria": per_crit,
        "total": totals,
        "by_language": slice_by("language"),
        "by_channel": slice_by("channel"),
    }


def calibration(pred: dict[str, dict], gold: dict[str, dict]) -> dict:
    """Доля ошибок по уровням уверенности модели: у `low` ошибок должно быть заметно больше."""
    buckets: dict[str, list[bool]] = defaultdict(list)
    for cid, p in pred.items():
        if cid not in gold:
            continue
        for key, conf in (p.get("confidence") or {}).items():
            if key in gold[cid]["answers"] and p["answers"].get(key) is not None:
                buckets[conf].append(p["answers"][key] != gold[cid]["answers"][key])
    return {k: {"n": len(v), "error_rate": round(sum(v) / len(v), 4)} for k, v in buckets.items() if v}


def stability(run_a: dict[str, dict], run_b: dict[str, dict]) -> dict:
    """Доля ответов, сменившихся между двумя одинаковыми прогонами, и среднее изменение итога (NFR-14)."""
    changed, total, dt = 0, 0, []
    for cid in run_a.keys() & run_b.keys():
        a, b = run_a[cid]["answers"], run_b[cid]["answers"]
        for k in a.keys() & b.keys():
            total += 1
            changed += a[k] != b[k]
        if run_a[cid].get("total") is not None and run_b[cid].get("total") is not None:
            dt.append(abs(run_a[cid]["total"] - run_b[cid]["total"]))
    return {"answers": total, "changed_share": round(changed / total, 4) if total else None,
            "mean_total_delta": round(mean(dt), 2) if dt else None}
