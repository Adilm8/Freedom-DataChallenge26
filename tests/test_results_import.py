"""Файл сдачи → оценки в БД без вызовов модели (services/results_import.py)."""
import json

from sqlmodel import Session, select

from backend.app import db
from backend.app.models import Evaluation, LLMCall
from backend.app.services import results_export, results_import
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import env  # noqa: F401  (фикстура)


def _doc():
    crit = lambda **v: [{"criterion_id": k, "value": x, "rationale": f"почему {k}", "evidence_turns": [2]}  # noqa: E731
                        for k, x in v.items()]
    ok = crit(contact=True, discovery=None, identification=None, consultation=15, empathy=True,
              dialogue=7, closure=True, critical=False)
    return {"schema_version": "1.0", "team_name": "T", "model": {"mode": "external_api", "name": "x/model"},
            "results": [
                {"conversation_id": "t-chat-1", "status": "ok", "criteria": ok, "score": {"final_score": 85.38, "critical_flag": False}},
                {"conversation_id": "t-call-1", "status": "error", "criteria": [], "score": None, "error": "сбой"},
                {"conversation_id": "nope", "status": "ok", "criteria": ok, "score": None},
            ]}


def test_import_scores_and_roundtrip(env):  # noqa: F811
    upload(env, payload())
    with Session(db.engine) as s:
        r = results_import.import_results(s, _doc(), "T")
        assert (r["imported"], r["skipped_error"], r["missing"]) == (1, 1, ["nope"])
        ev = s.exec(select(Evaluation)).one()
        assert ev.provider == "file" and ev.model == "x/model" and ev.status == "done"
        assert ev.ai_total == 85.38 and ev.cost_usd == 0                    # баллы пересчитаны scoring'ом
        assert s.exec(select(LLMCall)).first() is None                        # вызовов модели нет
        again = results_import.import_results(s, _doc(), "T")                 # повтор ничего не дублирует
        assert again["imported"] == 0 and again["skipped_existing"] == 1
        back = results_export.build(s, "T", team_name="T")                    # обратно в файл — то же самое
    row = next(x for x in back["results"] if x["conversation_id"] == "t-chat-1")
    assert row["criteria"] == _doc()["results"][0]["criteria"]
    assert row["score"] == {"final_score": 85.38, "critical_flag": False}


def test_card_and_list_show_imported(env):  # noqa: F811
    upload(env, payload())
    with Session(db.engine) as s:
        results_import.import_results(s, _doc(), "T")
    rows = env.get("/api/conversations?group_id=T").json()
    rows = rows.get("items", rows) if isinstance(rows, dict) else rows
    chat = next(x for x in rows if x["conversation_id"] == "t-chat-1")
    detail = env.get(f"/api/conversations/{chat['id']}").json()
    ev_id = detail["evaluations"][0]["id"]
    ev = env.get(f"/api/evaluations/{ev_id}").json()
    assert ev["provider"] == "file" and ev["final_score"]["total"] == 85.38
    c01 = next(c for c in ev["criteria"] if c["key"] == "01")
    assert c01["ai_answer"] == "yes" and c01["evidence"][0]["msg_id"] == "m1"
    assert c01["evidence"][0]["quote"].startswith("Добрый день")


def test_api_missing_file(env, tmp_path, monkeypatch):  # noqa: F811
    from backend.app import main
    monkeypatch.setattr(main, "ROOT", tmp_path)
    assert env.post("/api/datasets/load-results", json={"target": "dev"}).status_code == 404
    assert env.post("/api/datasets/load-results", json={"target": "../x"}).status_code == 400
    (tmp_path / "results" / "dev").mkdir(parents=True)
    (tmp_path / "results" / "dev" / "results.json").write_text(json.dumps(_doc()), encoding="utf-8")
    upload(env, payload())
    r = env.post("/api/datasets/load-results", json={"target": "dev", "group_id": "T"})
    assert r.status_code == 200 and r.json()["imported"] == 1


def test_autoload(env, tmp_path):  # noqa: F811
    upload(env, payload())
    (tmp_path / "results" / "dev").mkdir(parents=True)
    (tmp_path / "results" / "dev" / "results.json").write_text(json.dumps(_doc()), encoding="utf-8")
    old = results_import.AUTOLOAD
    results_import.AUTOLOAD = {"dev": "T"}
    try:
        with Session(db.engine) as s:
            assert results_import.autoload(s, tmp_path)[0]["imported"] == 1
            assert results_import.autoload(s, tmp_path)[0]["imported"] == 0
    finally:
        results_import.AUTOLOAD = old
