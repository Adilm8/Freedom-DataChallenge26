"""Инкрементальная переоценка (FR-CHK-10): вес — ноль вызовов, изменённый критерий — только его вызов."""
from sqlmodel import Session

from backend.app import db
from backend.app.services import checklists, evaluations
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import FakeProvider, env, start, wait  # noqa: F401  (env — фикстура)


class Counting(FakeProvider):
    def __init__(self):
        self.keys = []

    def complete(self, messages, *, json_schema=None, **kw):
        self.keys.append(sorted(json_schema["properties"]["results"]["properties"]))
        return super().complete(messages, json_schema=json_schema, **kw)


def new_version(change) -> int:
    with Session(db.engine) as s:
        body = checklists.get_active(s).body
        change(body)
        ver, _ = checklists.create_version(s, body, note="тест", activate=True)
        return ver.id


def test_reuse_auto(env, monkeypatch):
    c, p = env, Counting()
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: p)
    upload(c, payload())
    wait(c, start(c).json()["run_id"])
    assert len(p.keys) == 8                                   # 2 диалога × 4 вызова grouped

    # только вес: ни одного вызова, итог пересчитан, ответы помечены источником
    def weight(b):
        next(x for x in b["criteria"] if x["key"] == "05")["weight"] = 30
    new_version(weight)
    p.keys.clear()
    run = wait(c, start(c, reuse="auto").json()["run_id"])
    assert run["status"] == "done" and p.keys == [] and run["cost_usd"] == 0
    eid = c.get("/api/conversations?group_id=T").json()[0]["latest"]["evaluation_id"]
    ev = c.get(f"/api/evaluations/{eid}").json()
    assert ev["params"]["reuse"] == "auto" and ev["overview"]["topic"] == "t"
    assert all(x["reused_from_evaluation_id"] for x in ev["criteria"])
    assert next(x for x in ev["criteria"] if x["key"] == "05")["weight"] == 30

    # формулировка одного критерия: по одному вызову на диалог, только этот критерий
    def wording(b):
        next(x for x in b["criteria"] if x["key"] == "05")["definition"] += " Учитывай тон."
    new_version(wording)
    p.keys.clear()
    wait(c, start(c, reuse="auto").json()["run_id"])
    assert p.keys == [["05"], ["05"]]

    # «Оценить повторно» (reuse: none) — снова все вызовы
    p.keys.clear()
    wait(c, start(c).json()["run_id"])
    assert len(p.keys) == 8
    assert start(c, reuse="maybe").status_code == 400


def test_settings_change_invalidates_reuse(env, monkeypatch):
    c, p = env, Counting()
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: p)
    upload(c, payload())
    wait(c, start(c).json()["run_id"])

    def lang(b):
        b["settings"]["output_language"] = "en"         # меняет промпт → старые ответы не годятся
    new_version(lang)
    p.keys.clear()
    wait(c, start(c, reuse="auto").json()["run_id"])
    assert len(p.keys) == 8
