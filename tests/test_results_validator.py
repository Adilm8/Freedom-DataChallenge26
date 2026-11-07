"""Наш файл сдачи и наш итог сверяются с независимой проверкой `scripts/validate_results.py`."""
import importlib.util
import itertools
import json
import subprocess
import sys
from pathlib import Path

from sqlmodel import Session

from backend.app import db
from backend.app.domain import Checklist
from backend.app.services import results_export, scoring
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import env, start, wait  # noqa: F401  (env — фикстура)

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_results.py"
CL = Checklist.model_validate(json.loads((ROOT / "data/checklists/default.json").read_text(encoding="utf-8")))

_spec = importlib.util.spec_from_file_location("validate_results", SCRIPT)
validator = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(validator)


def _run(doc: dict, tmp_path: Path, kind: str | None = None) -> subprocess.CompletedProcess:
    f = tmp_path / "results.json"
    f.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return subprocess.run([sys.executable, str(SCRIPT), str(f)] + ([kind] if kind else []),
                          capture_output=True, text=True, encoding="utf-8", check=False)


def test_total_matches_independent_formula_for_every_answer_combination():
    crit = {c.key: c for c in CL.enabled_criteria()}
    options = {
        "01": ["yes", "no"], "02": ["yes", "no", "na"], "03": ["yes", "no", "na"],
        "04": [0, 5, 10, 15, 20, "na"], "05": ["yes", "no"], "06": [0, 4, 7, 10],
        "07": ["yes", "no", "na"], "08": ["yes", "no"],
    }
    keys = list(options)
    for combo in itertools.product(*(options[k] for k in keys)):
        ans = dict(zip(keys, combo))
        ours = scoring.compute(CL, ans).total
        values = {crit[k].export_id: results_export.export_value(crit[k], a) for k, a in ans.items()}
        assert ours == validator.expected_score(values), ans


def test_our_export_passes_independent_validator(env, tmp_path):  # noqa: F811
    c = env
    upload(c, payload())
    wait(c, start(c).json()["run_id"])
    with Session(db.engine) as s:
        doc = results_export.build(s, "T", team_name="Команда", mode="external_api")
    assert {r["status"] for r in doc["results"]} == {"ok"}
    res = _run(doc, tmp_path)
    assert res.returncode == 0, res.stdout + res.stderr

    broken = json.loads(json.dumps(doc))
    broken["results"][0]["score"]["final_score"] += 1
    res = _run(broken, tmp_path)
    assert res.returncode == 1 and "final_score" in res.stdout


def test_organizer_example_and_error_entry(tmp_path):
    vals = {"contact": True, "discovery": None, "identification": None, "consultation": 15,
            "empathy": True, "dialogue": 7, "closure": True, "critical": False}
    ok = {"conversation_id": "p1-ru-001", "status": "ok",
          "criteria": [{"criterion_id": k, "value": v, "rationale": "…", "evidence_turns": [1]} for k, v in vals.items()],
          "score": {"final_score": 85.38, "critical_flag": False}}
    err = {"conversation_id": "p1-ru-002", "status": "error", "criteria": [], "score": None, "error": "нет ответа модели"}
    doc = {"schema_version": "1.0", "team_name": "t", "model": {"mode": "external_api", "name": "m"}, "results": [ok, err]}
    assert _run(doc, tmp_path).returncode == 0
    assert _run(doc, tmp_path, "prod").returncode == 1  # в prod ровно 10 записей
