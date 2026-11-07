"""Экран качества (FR-OPS-05): чтение метрик прогонов eval/runs на временной папке."""
import json

import pytest

from backend.app.api import quality


def _run(**over):
    data = {
        "created_at": "20261107-101500", "provider": "openrouter", "model": "vendor/model-a", "strategy": "grouped",
        "split": "dev", "approved": "Лида, 10:10", "prompt_version": "p1",
        "metrics": {
            "dialogs": 2, "mean_agreement": 0.875,
            "criteria": {"01": {"n": 2, "exact": 1.0}, "04": {"n": 2, "exact": 0.5, "within_1_step": 1.0},
                         "08": {"n": 2, "exact": 1.0, "recall": 1.0, "precision": 0.5}},
            "total": {"n": 2, "mae": 3.5, "max_abs": 5.0, "within_5": 1.0, "within_10": 1.0},
            "by_language": {"RU": {"n": 1, "agreement": 1.0, "mae": 2.0}, "KZ": {"n": 1, "agreement": 0.75, "mae": 5.0}},
            "by_channel": {"agent chat": {"n": 2, "agreement": 0.875, "mae": 3.5}},
            "calibration": {"high": {"n": 10, "error_rate": 0.1}, "low": {"n": 4, "error_rate": 0.5}},
            "cost": {"total_usd": 0.02, "per_dialog_usd": 0.01, "mean_seconds": 7.5},
            "gold_source": ["gold"],
        },
        "meta": {"a": {"language": "RU", "channel": "agent chat"}, "b": {"language": "KZ", "channel": "agent chat"}},
        "pred": [{"a": {"answers": {}, "total": 90}, "b": {"answers": {}, "total": 80}}],
        "details": [{"a": {"status": "done", "cost_usd": 0.01, "calls": 4, "retries": 1, "needs_review": True},
                     "b": {"status": "done", "cost_usd": 0.01, "calls": 4, "retries": 0, "needs_review": False}}],
    }
    data.update(over)
    return data


@pytest.fixture()
def runs(tmp_path, monkeypatch):
    monkeypatch.delenv("CQA_EVAL_RUNS_DIR", raising=False)
    monkeypatch.setattr(quality, "RUNS_DIR", tmp_path)
    return tmp_path


def test_list_and_detail(client, runs):
    (runs / "20261107-101500_openrouter_vendor-model-a_grouped_dev.json").write_text(json.dumps(_run()), encoding="utf-8")
    second = _run(created_at="20261107-120000", model="vendor/model-b")
    second["metrics"]["stability"] = {"answers": 16, "changed_share": 0.0625, "mean_total_delta": 1.2}
    (runs / "20261107-120000_openrouter_vendor-model-b_grouped_dev.json").write_text(json.dumps(second), encoding="utf-8")
    partial = {"model": "vendor/model-c", "strategy": "single", "approved": "x", "meta": {},
               "pred": [{"a": {"answers": {}, "total": 70}}], "details": [{"a": {"status": "done", "cost_usd": 0.004}}]}
    (runs / "20261107-130000_openrouter_vendor-model-c_single_holdout.partial.json").write_text(json.dumps(partial), encoding="utf-8")
    (runs / "20261107-140000_gemini_broken_grouped_dev.json").write_text("{not json", encoding="utf-8")
    (runs / "notes.txt").write_text("не прогон", encoding="utf-8")

    r = client.get("/api/quality/runs")
    assert r.status_code == 200
    rows = r.json()["runs"]
    assert [x["name"] for x in rows] == [
        "20261107-140000_gemini_broken_grouped_dev",
        "20261107-130000_openrouter_vendor-model-c_single_holdout.partial",
        "20261107-120000_openrouter_vendor-model-b_grouped_dev",
        "20261107-101500_openrouter_vendor-model-a_grouped_dev",
    ]
    broken, part, b, a = rows
    assert "error" in broken and broken["complete"] is False
    assert part["complete"] is False and part["mean_agreement"] is None and part["dialogs"] == 1
    assert part["split"] == "holdout" and part["strategy"] == "single" and part["cost_total_usd"] == 0.004
    assert a["complete"] is True and a["created_at"] == "2026-11-07T10:15:00Z"
    assert a["mean_agreement"] == 0.875 and a["mae"] == 3.5 and a["within_5"] == 1.0 and a["within_10"] == 1.0
    assert a["flag_key"] == "08" and a["flag_recall"] == 1.0 and a["flag_precision"] == 0.5
    assert a["cost_per_dialog_usd"] == 0.01 and a["gold_source"] == ["gold"] and a["stability"] is None
    assert a["checks"]["needs_review_share"] == 0.5 and a["checks"]["retry_share"] == 0.125
    assert b["stability"]["changed_share"] == 0.0625

    d = client.get(f"/api/quality/runs/{a['name']}").json()
    crit = {c["key"]: c for c in d["criteria"]}
    assert crit["04"]["within_1_step"] == 1.0 and crit["01"]["title"] != "01"  # название из активного чек-листа
    assert d["by_language"]["KZ"]["agreement"] == 0.75 and d["by_channel"]["agent chat"]["mae"] == 3.5
    assert d["calibration"]["low"]["error_rate"] == 0.5 and d["languages"] == ["KZ", "RU"]
    assert client.get(f"/api/quality/runs/{a['name']}.json").json()["name"] == a["name"]
    pd = client.get(f"/api/quality/runs/{part['name']}").json()
    assert pd["complete"] is False and pd["criteria"] == []
    assert client.get(f"/api/quality/runs/{broken['name']}").status_code == 422


def test_path_guard_and_empty(client, runs, tmp_path_factory, monkeypatch):
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.json").write_text(json.dumps(_run()), encoding="utf-8")
    for bad in ("..%2Foutside%2Fsecret", "..", "%2Fetc%2Fpasswd", ".hidden", "nope"):
        assert client.get(f"/api/quality/runs/{bad}").status_code == 404, bad
    assert client.get("/api/quality/runs").json()["runs"] == []
    monkeypatch.setattr(quality, "RUNS_DIR", runs / "missing")
    assert client.get("/api/quality/runs").json()["runs"] == []


def test_env_dir(client, runs, tmp_path_factory, monkeypatch):
    other = tmp_path_factory.mktemp("envruns")
    (other / "20261107-101500_openrouter_m_grouped_dev.json").write_text(json.dumps(_run()), encoding="utf-8")
    monkeypatch.setenv("CQA_EVAL_RUNS_DIR", str(other))
    assert [x["name"] for x in client.get("/api/quality/runs").json()["runs"]] == ["20261107-101500_openrouter_m_grouped_dev"]
