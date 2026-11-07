#!/usr/bin/env python3
"""Независимая проверка results.json по приложению к гайду CQA (JSON 1.0).

Отдельная реализация правил формата, не зависит от кода проекта: веса, коды и допустимые значения
записаны прямо здесь, итог пересчитывается заново. Дополняет `scripts/export_results.py --check`.
Использование: python scripts/validate_results.py results/prod/results.json prod   (или dev)
"""
import json
import sys
from decimal import ROUND_HALF_UP, Decimal

SPEC = {  # id: (допустимые значения, вес, N/A разрешён)
    "contact": ({True, False}, 10, False),
    "discovery": ({True, False}, 15, True),
    "identification": ({True, False}, 20, True),
    "consultation": ({0, 5, 10, 15, 20}, 20, True),
    "empathy": ({True, False}, 15, False),
    "dialogue": ({0, 4, 7, 10}, 15, False),
    "closure": ({True, False}, 5, True),
    "critical": ({True, False}, 0, False),
}
SCALE_MAX = {"consultation": 20, "dialogue": 10}


def expected_score(crit):
    got = applicable = Decimal(0)
    for cid, (_, w, _) in SPEC.items():
        if cid == "critical" or crit[cid] is None:
            continue
        v = crit[cid]
        frac = Decimal(v) / SCALE_MAX[cid] if cid in SCALE_MAX else Decimal(1 if v else 0)
        got += frac * w
        applicable += w
    if applicable == 0:
        return None
    return float((got / applicable * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def main(path, kind):
    errs, warns = [], []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != "1.0": errs.append("schema_version должен быть '1.0'")
    if not data.get("team_name"): errs.append("пустой team_name")
    m = data.get("model") or {}
    if m.get("mode") not in ("local", "external_api", "hybrid"): errs.append("model.mode: local/external_api/hybrid")
    if not m.get("name"): errs.append("пустой model.name")
    res = data.get("results")
    if not isinstance(res, list): sys.exit("results должен быть массивом")
    need = {"dev": 65, "prod": 10}.get(kind)
    if need and len(res) != need: errs.append(f"записей {len(res)}, ожидается {need}")
    ids = [r.get("conversation_id") for r in res]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup: errs.append(f"повторяющиеся ID: {dup}")
    for r in res:
        cid = r.get("conversation_id")
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                errs.append(f"{cid}: для error нужно criteria=[], score=null и текст error")
            continue
        if r.get("status") != "ok": errs.append(f"{cid}: status должен быть ok/error"); continue
        crit = {}
        for c in r.get("criteria", []):
            k = c.get("criterion_id")
            if k in crit: errs.append(f"{cid}: критерий {k} повторяется")
            crit[k] = c.get("value")
            if not c.get("rationale"): warns.append(f"{cid}/{k}: пустой rationale")
            et = c.get("evidence_turns")
            if not isinstance(et, list) or not all(isinstance(x, int) and x >= 1 for x in et):
                errs.append(f"{cid}/{k}: evidence_turns — список целых >= 1")
        if set(crit) != set(SPEC):
            errs.append(f"{cid}: нужны ровно 8 критериев, есть {sorted(crit)}"); continue
        bad = False
        for k, (allowed, _, na) in SPEC.items():
            v = crit[k]
            if v is None and na: continue
            if isinstance(v, bool) != isinstance(next(iter(allowed)), bool) or v not in allowed:
                errs.append(f"{cid}/{k}: недопустимое значение {v!r}"); bad = True
        sc = r.get("score") or {}
        if sc.get("critical_flag") != crit["critical"]:
            errs.append(f"{cid}: critical_flag != critical.value")
        if not bad:
            exp = expected_score(crit)
            if exp is not None and sc.get("final_score") != exp:
                errs.append(f"{cid}: final_score {sc.get('final_score')} != ожидаемому {exp}")
    for w in warns[:20]: print("WARN", w)
    for e in errs: print("ERROR", e)
    print("OK" if not errs else f"Ошибок: {len(errs)}")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
