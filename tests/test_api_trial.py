"""Песочница критерия: проверка черновика на диалогах без изменения их оценок."""
import json

from backend.app.services import trial
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import FakeProvider, env, start, wait  # noqa: F401


def test_trial_runs_one_criterion_and_keeps_evaluations(env, monkeypatch):
    c = env
    monkeypatch.setattr(trial, "get_provider", lambda name=None: FakeProvider())
    upload(c, payload())
    wait(c, start(c).json()["run_id"])
    rows = c.get("/api/conversations?group_id=T").json()
    before = [r["latest"]["evaluation_id"] for r in rows]

    ver = c.get("/api/checklists").json()[0]
    body = c.get(f"/api/checklists/{ver['id']}").json()["body"]
    body["criteria"][0] = {**body["criteria"][0], "definition": "Новая формулировка критерия"}
    key = body["criteria"][0]["key"]
    r = c.post("/api/checklists/trial", json={"body": body, "criterion_key": key,
                                             "conversation_ids": [x["id"] for x in rows], "model": "fake/m"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["criterion_key"] == key and len(out["items"]) == 2 and out["cost_usd"] > 0
    it = out["items"][0]
    assert it["answer"] is not None and it["previous"]["answer"] is not None and it["trial_id"]
    # оценки диалогов не изменились
    assert [x["latest"]["evaluation_id"] for x in c.get("/api/conversations?group_id=T").json()] == before


def test_trial_validates_input(env):
    c = env
    ver = c.get("/api/checklists").json()[0]
    body = c.get(f"/api/checklists/{ver['id']}").json()["body"]
    assert c.post("/api/checklists/trial", json={"body": body, "criterion_key": "01", "conversation_ids": []}).status_code == 400
    assert c.post("/api/checklists/trial", json={"body": body, "criterion_key": "01",
                                                 "conversation_ids": [1, 2, 3, 4, 5, 6]}).status_code == 400
    bad = json.loads(json.dumps(body)); bad["criteria"][0]["weight"] = -1
    assert c.post("/api/checklists/trial", json={"body": bad, "criterion_key": "01", "conversation_ids": [1]}).status_code == 422
