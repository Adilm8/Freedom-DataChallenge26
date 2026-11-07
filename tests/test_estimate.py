"""Оценка стоимости и времени до запуска (FR-UX-03): без LLM, по реальным промптам и истории вызовов."""
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import env, start, wait  # noqa: F401  (env — фикстура)


def test_estimate_before_and_after_history(env):
    c = env
    upload(c, payload())
    body = {"group_id": "T", "provider": "openrouter", "model": "fake/m"}
    e = c.post("/api/runs/estimate", json=body).json()
    assert e["dialogs"] == 2 and e["calls"] == 8 and e["tokens_in"] > 500 and e["tokens_out"] > 0
    wait(c, start(c).json()["run_id"])                                   # 8 вызовов фейка — история цены
    e2 = c.post("/api/runs/estimate", json=body).json()
    assert e2["cost_source"] == "history" and e2["cost_usd"] > 0 and e2["seconds"] >= 0
    again = c.post("/api/runs/estimate", json={**body, "reuse": "auto"}).json()
    assert again["calls"] == 0 and again["cost_usd"] == 0                # всё переиспользуется
    assert c.post("/api/runs/estimate", json={**body, "strategy": "nope"}).status_code == 400


def test_fact_labels(env):
    labels = env.get("/api/meta/facts").json()["labels"]
    assert labels.get("ended_abruptly") and labels.get("first_response_delay_sec")
