"""Прогоны оценки через API: фоновый запуск, запись в БД, контракт. Без сети, провайдер и факты подменены."""
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.app import db
from backend.app.main import app
from backend.app.providers.base import LLMResult, ProviderError, ProviderPolicyError
from backend.app.services import checklists, evaluations, evaluator
from tests.test_api_datasets import payload, upload


class FakeProvider:
    name = "fake"

    def complete(self, messages, *, json_schema=None, **kw):
        res = {}
        for key, spec in json_schema["properties"]["results"]["properties"].items():
            ans = spec["properties"]["answer"]["enum"][0]
            res[key] = {"reasoning": "ок", "answer": ans, "confidence": "high", "evidence": [],
                        "checked_range": None, "na_reason": "нет повода" if ans == "na" else None, "advice": None}
        out = {"results": res}
        if "overview" in json_schema["properties"]:
            out["overview"] = {"summary": "s", "topic": "t", "resolved": "yes"}
        return LLMResult(text=json.dumps(out), parsed=out, finish_reason="stop", provider="fake", model="fake/m",
                         tokens_in=100, tokens_out=10, cost_usd=0.001, latency_ms=5)


class BrokenProvider:
    name = "broken"

    def complete(self, messages, **kw):
        raise ProviderPolicyError("звонки нельзя")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    eng = db.make_engine(f"sqlite:///{tmp_path / 'r.db'}")
    db.init_db(eng)
    with Session(eng) as s:
        checklists.seed_default(s)
    monkeypatch.setattr(db, "engine", eng)

    def _session():
        with Session(eng) as s:
            yield s

    app.dependency_overrides[db.get_session] = _session
    monkeypatch.setattr(evaluator, "_facts", lambda conv, cl: ({}, "нет", {}))
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: FakeProvider())
    yield TestClient(app)
    app.dependency_overrides.clear()
    eng.dispose()


def wait(client, run_id, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/runs/{run_id}").json()
        if r["status"] in ("done", "partial", "failed"):
            return r
        time.sleep(0.05)
    raise AssertionError("прогон не завершился")


def start(client, **body):
    body = {"group_id": "T", "provider": "openrouter", "model": "fake/m", **body}
    return client.post("/api/runs", json=body)


def test_run_group_end_to_end(env):
    c = env
    upload(c, payload())
    r = start(c)
    assert r.status_code == 202
    run = wait(c, r.json()["run_id"])
    assert run["status"] == "done" and run["done"] == run["total"] == 2 and run["failed"] == 0
    assert run["cost_usd"] > 0 and run["finished_at"]

    rows = c.get("/api/conversations?group_id=T").json()
    assert all(x["latest"] and x["latest"]["ai_total"] is not None for x in rows)
    # фейк отвечает первым вариантом enum: флаг 08 = "yes" -> critical
    assert len(c.get("/api/conversations?group_id=T&critical=true").json()) == 2
    assert c.get("/api/conversations?group_id=T&critical=false").json() == []
    detail = c.get(f"/api/conversations/{rows[0]['id']}").json()
    assert len(detail["evaluations"]) == 1 and detail["latest"]["evaluation_id"] == detail["evaluations"][0]["id"]

    eid = rows[0]["latest"]["evaluation_id"]
    ev = c.get(f"/api/evaluations/{eid}").json()
    assert ev["status"] == "done"
    assert ev["ai_score"]["total"] is not None and ev["final_score"] == ev["ai_score"]
    assert ev["params"] == {"temperature": None, "seed": None, "reuse": "none"}  # фейк не сообщает параметры запроса
    assert ev["overview"]["topic"] == "t"
    assert len(ev["criteria"]) == 8
    first = ev["criteria"][0]
    assert {"title", "section", "type", "weight", "scale_max", "ai_answer", "final_points"} <= set(first)
    assert first["ai_answer"] in ("yes", "no", "na") or isinstance(first["ai_answer"], int)

    calls = c.get(f"/api/evaluations/{eid}/calls").json()
    assert calls and calls[0]["response_raw"].startswith("{") and calls[0]["error"] is None
    assert c.get("/api/evaluations/9999").status_code == 404


def test_provider_error_marks_failed(env, monkeypatch):
    c = env
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: BrokenProvider())
    upload(c, payload())
    run = wait(c, start(c).json()["run_id"])
    assert run["status"] == "failed" and run["failed"] == 2
    eid = c.get("/api/conversations?group_id=T").json()[0]["latest"]["evaluation_id"]
    assert c.get(f"/api/evaluations/{eid}").json()["status"] == "failed"
    calls = c.get(f"/api/evaluations/{eid}/calls").json()
    assert "звонки нельзя" in calls[0]["error"]


def test_get_provider_error_is_handled(env, monkeypatch):
    def boom(name=None):
        raise ProviderError("нет провайдера")

    monkeypatch.setattr(evaluations, "get_provider", boom)
    upload(c := env, payload())
    run = wait(c, start(c, conversation_ids=[1]).json()["run_id"])
    assert run["failed"] == 1 and run["total"] == 1


def test_validation_errors(env):
    c = env
    upload(c, payload())
    assert start(c, strategy="nope").status_code == 400
    assert start(c, group_id="EMPTY").status_code == 400
    assert start(c, provider="nope").status_code == 400
    assert start(c, model="", provider="gemini").status_code in (202, 400)
    assert c.get("/api/runs/999").status_code == 404


def test_meta_models(env):
    m = env.get("/api/meta/models").json()
    assert m["models"] and "grouped" in m["strategies"] and m["default_strategy"]
