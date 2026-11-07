"""results.json для организаторов (формат 1.0): сборка из БД и проверка перед push."""
import json

from sqlmodel import Session

from backend.app import db
from backend.app.domain import Checklist
from backend.app.services import checklists, evaluations, results_export, scoring
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import BrokenProvider, env, start, wait  # noqa: F401  (env — фикстура)

CL = Checklist.model_validate(json.loads(open("data/checklists/default.json", encoding="utf-8").read()))


def test_codes_values_and_turns():
    assert [c.export_id for c in CL.enabled_criteria()] == [
        "contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
    c = {x.key: x for x in CL.criteria}
    assert results_export.export_value(c["01"], "yes") is True and results_export.export_value(c["02"], "na") is None
    assert results_export.export_value(c["06"], "7") == 7 and results_export.export_value(c["08"], "no") is False
    assert results_export.turns([{"msg_id": "m3"}, {"msg_id": "m0"}, {"msg_id": "m3"}, {"msg_id": "x"}]) == [1, 4]


def test_organizer_example_total():
    # пример из приложения: 02 и 03 — N/A, 04 = 15, 06 = 7 → 85.38
    ans = {"01": "yes", "02": "na", "03": "na", "04": 15, "05": "yes", "06": 7, "07": "yes", "08": "no"}
    s = scoring.compute(CL, ans)
    assert s.total == 85.38 and s.critical == []


def test_build_and_validate(env, monkeypatch):
    c = env
    upload(c, payload())
    with Session(db.engine) as s:                                                 # ещё не оценивали → error
        none = results_export.build(s, "T", team_name="Команда")
    assert {r["status"] for r in none["results"]} == {"error"} and none["results"][0]["score"] is None
    wait(c, start(c).json()["run_id"])
    with Session(db.engine) as s:
        doc = results_export.build(s, "T", team_name="Команда", mode="external_api")
        ver = checklists.get_active(s)
    assert doc["schema_version"] == "1.0" and doc["model"]["name"] == "fake/m"
    r = doc["results"][0]
    assert r["status"] == "ok" and len(r["criteria"]) == 8
    assert r["score"]["critical_flag"] is True and isinstance(r["score"]["final_score"], float)  # фейк ставит 08 = «Да»
    ids = [x["conversation_id"] for x in doc["results"]]
    cl = Checklist.model_validate(ver.body)
    assert results_export.validate(doc, cl, expected_ids=ids, expected_count=len(ids)) == []
    assert results_export.validate(doc, cl, expected_count=10)                    # в prod ровно 10
    bad = json.loads(json.dumps(doc))
    bad["results"][0]["criteria"][5]["value"] = 5                                # 06: шкала 0/4/7/10
    bad["results"].append(bad["results"][1])
    errs = results_export.validate(bad, cl, expected_ids=ids)
    assert any("dialogue" in e for e in errs) and any("повторяются" in e for e in errs)

    # провайдер упал: диалог остаётся в файле со status=error и причиной, без нулей
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: BrokenProvider())
    with Session(db.engine) as s:
        evaluations.evaluate_one(s, 1, ver.id, provider_name="openrouter", model="fake/m", strategy="grouped")
        doc2 = results_export.build(s, "T", team_name="Команда")
    assert doc2["results"][0]["status"] == "ok"                                  # берётся последняя полная оценка
    exp = c.get("/api/export/results?group_id=T&team=X")
    assert exp.status_code == 200 and exp.headers["x-validation-errors"] == "0"


def test_error_entry_format():
    doc = {"schema_version": "1.0", "team_name": "t", "model": {"mode": "external_api", "name": "m"},
           "results": [{"conversation_id": "a", "status": "error", "criteria": [], "score": None,
                        "error": "Не удалось получить ответ модели."}]}
    assert results_export.validate(doc, CL, expected_ids=["a"], expected_count=1) == []
    doc["results"][0]["score"] = {"final_score": 0}
    assert results_export.validate(doc, CL)


def test_run_sync_then_export(env):
    from backend.app.services import runs

    c = env
    upload(c, payload())
    with Session(db.engine) as s:
        pks = list(range(1, 3))
        rid = runs.run_sync(s, pks, group_id="T", provider="openrouter", model="fake/m", strategy="grouped")
        doc = results_export.build(s, "T", team_name="Команда")
    assert c.get(f"/api/runs/{rid}").json()["status"] == "done"
    assert [r["status"] for r in doc["results"]] == ["ok", "ok"]
