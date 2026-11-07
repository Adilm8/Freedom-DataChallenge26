import copy
import json
from pathlib import Path

BODY = json.loads((Path(__file__).resolve().parents[1] / "data" / "checklists" / "default.json").read_text(encoding="utf-8"))


def test_seeded(client):
    lst = client.get("/api/checklists").json()
    assert len(lst) == 1 and lst[0]["is_active"] and lst[0]["version"] == 1 and lst[0]["key"] == "default"
    full = client.get(f"/api/checklists/{lst[0]['id']}").json()
    assert len(full["body"]["criteria"]) == 8


def test_create_version_and_dup(client):
    base = client.get("/api/checklists").json()[0]["id"]
    body = copy.deepcopy(BODY)
    body["criteria"][0]["weight"] = 11
    r = client.post("/api/checklists", json={"body": body, "note": "вес", "parent_id": base})
    assert r.status_code == 200
    v = r.json()
    assert v["version"] == 2 and not v["is_active"] and isinstance(v["warnings"], list) and v["warnings"]
    again = client.post("/api/checklists", json={"body": body, "note": "вес", "parent_id": base}).json()
    assert again["id"] == v["id"]
    assert len(client.get("/api/checklists").json()) == 2


def test_invalid_422(client):
    body = copy.deepcopy(BODY)
    body["criteria"][0]["section"] = "nope"
    r = client.post("/api/checklists", json={"body": body})
    assert r.status_code == 422
    errs = r.json()["errors"]
    assert errs and {"path", "message"} <= set(errs[0])
    r = client.post("/api/checklists", json={"body": {"key": "x"}})
    assert r.status_code == 422 and any(e["path"] == "name" for e in r.json()["errors"])
    assert len(client.get("/api/checklists").json()) == 1


def test_activate(client):
    base = client.get("/api/checklists").json()[0]["id"]
    body = copy.deepcopy(BODY)
    body["name"] = "Другой"
    v = client.post("/api/checklists", json={"body": body, "parent_id": base, "activate": True}).json()
    assert v["is_active"]
    lst = {x["id"]: x for x in client.get("/api/checklists").json()}
    assert not lst[base]["is_active"] and lst[v["id"]]["is_active"]
    assert client.post(f"/api/checklists/{base}/activate").json()["is_active"]
    assert client.post("/api/checklists/999/activate").status_code == 404
    assert client.get("/api/checklists/999").status_code == 404
