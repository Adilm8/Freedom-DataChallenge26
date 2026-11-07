"""Репетиция контрольного часа: неполные оценки в прогрессе, прерванные прогоны, совместимость чек-листа с форматом
сдачи, причина ошибки в файле, заголовки выгрузки, предупреждения импорта, скрипты без утечки адреса API."""
import copy
import importlib.util
import json
from pathlib import Path

import httpx
import pytest
from sqlmodel import Session

from backend.app import db
from backend.app.config import settings
from backend.app.domain import Checklist
from backend.app.models import EvaluationRun
from backend.app.providers.base import LLMResult, ProviderError
from backend.app.services import checklists, evaluations, ingest, results_export, runs
from tests.test_api_datasets import payload, upload
from tests.test_api_runs import env, start, wait  # noqa: F401  (env — фикстура)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = json.loads((ROOT / "data" / "checklists" / "default.json").read_text(encoding="utf-8"))


class HalfProvider:
    """Отвечает на все вызовы, кроме того, где есть критерий 04: так оценка получается неполной (partial)."""
    name = "half"

    def complete(self, messages, *, json_schema=None, **kw):
        keys = list(json_schema["properties"]["results"]["properties"])
        if "04" in keys:
            raise ProviderError("openrouter: 503 Service Unavailable")
        res = {}
        for k in keys:
            ans = json_schema["properties"]["results"]["properties"][k]["properties"]["answer"]["enum"][0]
            res[k] = {"reasoning": "ок", "answer": ans, "confidence": "high", "evidence": [], "checked_range": None,
                      "na_reason": "нет повода" if ans == "na" else None, "advice": None}
        out = {"results": res}
        if "overview" in json_schema["properties"]:
            out["overview"] = {"summary": "s", "topic": "t", "resolved": "yes"}
        return LLMResult(text=json.dumps(out), parsed=out, finish_reason="stop", provider="half", model="fake/m",
                         tokens_in=10, tokens_out=5, cost_usd=0.001, latency_ms=1)


def _replace(body: dict, key: str, **changes) -> dict:
    """Как «Заменить» в конструкторе: старый критерий выключен, новый с тем же export_id встаёт следом."""
    body = copy.deepcopy(body)
    i = next(j for j, c in enumerate(body["criteria"]) if c["key"] == key)
    old = body["criteria"][i]
    new = {**old, "key": "x" + key, "title": "Предупреждение об ожидании", "guards": [], "context_refs": [], **changes}
    body["criteria"][i] = {**old, "enabled": False}
    body["criteria"].insert(i + 1, new)
    return body


def test_partial_evaluation_is_an_error_in_run_progress(env, monkeypatch):
    c = env
    upload(c, payload())
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: HalfProvider())
    run = wait(c, start(c).json()["run_id"])
    rows = c.get("/api/conversations?group_id=T").json()
    assert {r["latest"]["status"] for r in rows} == {"partial"}
    # раньше: status=done, done=2, failed=0 — «Готово», хотя в файл сдачи оба диалога идут как error
    assert run["status"] == "failed" and run["failed"] == 2 and run["done"] == 0
    with Session(db.engine) as s:
        doc = results_export.build(s, "T", team_name="t")
    assert {r["status"] for r in doc["results"]} == {"error"}
    assert doc["model"]["name"] == "fake/m"          # модель попытки, а не пустая строка (иначе лишняя ошибка формата)
    assert results_export.validate(doc, expected_ids=["t-call-1", "t-chat-1"]) == []


def test_interrupted_runs_are_closed_on_start(env):
    with Session(db.engine) as s:
        a = EvaluationRun(group_id="T", status="running", total=5, done=2)
        b = EvaluationRun(group_id="T", status="queued", total=3)
        d = EvaluationRun(group_id="T", status="done", total=1, done=1)
        s.add_all([a, b, d])
        s.commit()
        assert runs.close_interrupted(s) == 2
        s.refresh(a), s.refresh(b), s.refresh(d)
        assert (a.status, a.done, a.failed) == ("partial", 2, 3) and a.finished_at
        assert (b.status, b.failed) == ("failed", 3)
        assert d.status == "done" and d.failed == 0
        assert runs.close_interrupted(s) == 0


def test_format_issues_catch_replacements_that_break_the_file():
    assert results_export.format_issues(Checklist.model_validate(DEFAULT)) == []
    na = results_export.format_issues(Checklist.model_validate(_replace(DEFAULT, "05", na_allowed=True, na_when="ожидания не было")))
    assert len(na) == 1 and "empathy" in na[0] and "N/A" in na[0]
    scale = _replace(DEFAULT, "06", scale=[{"value": 10, "label": "a"}, {"value": 5, "label": "b"}, {"value": 0, "label": "c"}])
    issues = results_export.format_issues(Checklist.model_validate(scale))
    assert len(issues) == 1 and "dialogue" in issues[0] and "5" in issues[0]
    binary_ok = _replace(DEFAULT, "05", definition="Предупреждает об ожидании")   # та же форма ответа — файл валиден
    assert results_export.format_issues(Checklist.model_validate(binary_ok)) == []
    gone = copy.deepcopy(DEFAULT)
    gone["criteria"][0]["export_id"] = None
    assert any("contact" in w for w in results_export.format_issues(Checklist.model_validate(gone)))


def test_saving_incompatible_version_warns(client):
    base = client.get("/api/checklists").json()[0]["id"]
    body = _replace(DEFAULT, "05", na_allowed=True, na_when="ожидания не было")
    v = client.post("/api/checklists", json={"body": body, "parent_id": base}).json()
    assert any(w.startswith("файл сдачи:") and "empathy" in w for w in v["warnings"])
    custom = {**DEFAULT, "key": "calls", "criteria": [{**c, "export_id": None} for c in DEFAULT["criteria"]]}
    assert not any("файл сдачи" in w for w in client.post("/api/checklists", json={"body": custom}).json()["warnings"])


def test_error_reason_names_the_version(env):
    c = env
    upload(c, payload())
    wait(c, start(c).json()["run_id"])
    with Session(db.engine) as s:
        v2, _ = checklists.create_version(s, _replace(DEFAULT, "05"), note="замена", activate=True)
        doc = results_export.build(s, "T", team_name="t")
    err = doc["results"][0]["error"]
    assert doc["results"][0]["status"] == "error" and f"v{v2.version}" in err and "v1" in err


def test_export_headers_and_missing_team(env, monkeypatch):
    c = env
    upload(c, payload())
    wait(c, start(c).json()["run_id"])
    monkeypatch.setattr(settings, "team_name", "")
    r = c.get("/api/export/results?group_id=T")
    assert r.json()["team_name"] == "" and int(r.headers["x-validation-errors"]) >= 1   # раньше «—» проходило проверку
    assert r.headers["x-results-ok"] == "2" and r.headers["x-results-error"] == "0"
    r = c.get("/api/export/results?group_id=T&team=Команда")
    assert r.headers["x-validation-errors"] == "0"


def test_import_warns_about_dialogs_without_operator(client):
    extra = [{"conversation_id": "t-empty", "channel": "agent chat", "language": "RU", "transcript": []},
             {"conversation_id": "t-noop", "channel": "agent chat", "language": "RU",
              "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "Алло?"}]}]
    w = upload(client, payload(extra)).json()["warnings"]
    assert any(x.startswith("t-empty:") and "пуст" in x for x in w)
    assert any(x.startswith("t-noop:") and "оператора" in x for x in w)
    assert not any(x.startswith(("t-chat-1:", "t-call-1:")) and ("оператора" in x or "пуст" in x) for x in w)


def _script(name):
    spec = importlib.util.spec_from_file_location(f"script_{name}", ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SIGNED = "http://organizer.test/api?sig=SECRET0042XYZ&group_id=DEV"


def _http_403(*a, **k):
    req = httpx.Request("GET", SIGNED)
    raise httpx.HTTPStatusError(f"Client error '403 Forbidden' for url '{SIGNED}'", request=req,
                                response=httpx.Response(403, request=req))


def test_fetch_dataset_error_does_not_leak_signed_url(monkeypatch):
    mod = _script("fetch_dataset")
    monkeypatch.setattr(settings, "organizer_api_url", SIGNED)
    monkeypatch.setattr(httpx, "get", _http_403)
    monkeypatch.setattr("sys.argv", ["fetch_dataset.py", "--group", "CTRL"])
    with pytest.raises(SystemExit) as e:
        mod.main()
    assert "403" in str(e.value) and "SECRET0042XYZ" not in str(e.value)


def test_control_stops_before_import_and_calls(env, monkeypatch, tmp_path):
    mod = _script("control")
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(settings, "organizer_api_url", SIGNED)
    argv = ["control.py", "--group", "CTRL", "--target", "prod", "--team", "t", "--provider", "openrouter",
            "--model", "fake/m", "--approved", "тест"]
    # набор не получен: понятная причина без подписи и без снапшота с ответом-ошибкой
    monkeypatch.setattr(ingest, "fetch_payload", lambda g: {"isSuccess": False, "error": f"group {g} not found: {SIGNED}"})
    monkeypatch.setattr("sys.argv", argv)
    with pytest.raises(SystemExit) as e:
        mod.main()
    assert "not found" in str(e.value) and "SECRET0042XYZ" not in str(e.value)
    assert not (tmp_path / "data" / "raw" / "CTRL.json").exists()
    # активная версия не ложится в формат сдачи: выход до импорта и до вызовов модели
    called = []
    monkeypatch.setattr(ingest, "fetch_payload", lambda g: called.append(g) or payload())
    with Session(db.engine) as s:
        checklists.create_version(s, _replace(DEFAULT, "05", na_allowed=True, na_when="нет"), activate=True)
    with pytest.raises(SystemExit) as e:
        mod.main()
    assert "не ложится в формат сдачи" in str(e.value) and "empathy" in str(e.value) and not called
    # та же команда по исходной версии (--version 1) проходит целиком
    monkeypatch.setattr("sys.argv", argv + ["--version", "1"])
    mod.main()
    doc = json.loads((tmp_path / "results" / "prod" / "results.json").read_text(encoding="utf-8"))
    assert [r["status"] for r in doc["results"]] == ["ok", "ok"] and called == ["CTRL"]
