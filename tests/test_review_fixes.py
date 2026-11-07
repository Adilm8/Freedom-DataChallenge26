"""Исправления по ревью этапов 3–4: ручной ввод, «последняя оценка», CSV, гонки апелляций, перенос решений,
прокси записи, оценка стоимости, файл сдачи без ручных диалогов."""
import threading

import httpx
from sqlmodel import Session, select

from backend.app.api import audio
from backend.app.models import Conversation, CriterionResult, Evaluation, EvaluationRun, LLMCall
from backend.app.services import appeals, estimate, evaluations, results_export
from backend.app.services.manual import MAX_CHARS, MAX_MESSAGE_CHARS
from backend.app.services.table_export import _cell
from tests.stage4_helpers import GROUP, BrokenProvider, ScriptedProvider
from tests.test_api_audio import _clean_cache, ids, use_upstream  # noqa: F401  (_clean_cache — autouse)


# --------------------------------------------------------------------------- ручной диалог


def test_manual_rejects_audio_url_and_dataset_group(s4):
    c = s4.client
    r = c.post("/api/conversations", json={"transcript": "оператор: Добрый день", "audio_url": "http://127.0.0.1/x"})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "audio_url"
    pasted = '{"conversation_id": "x-1", "audio_url": "http://169.254.169.254/", "transcript": ' \
             '[{"timestamp": "00:00", "speaker": "operator", "text": "Здравствуйте"}]}'
    d = c.post("/api/conversations", json={"transcript": pasted}).json()
    assert d["has_audio"] is False and d["audio_url"] is None   # ссылка из вставленного JSON не берётся
    s4.load()
    r = c.post("/api/conversations", json={"group_id": GROUP, "transcript": "оператор: Добрый день"})
    assert r.status_code == 409 and GROUP in r.json()["detail"]


def test_manual_length_limits(s4):
    c = s4.client
    r = c.post("/api/conversations", json={"transcript": "[" + "x" * MAX_CHARS})
    assert r.status_code == 422 and "длиннее" in r.json()["errors"][0]["message"]
    r = c.post("/api/conversations", json={"transcript": "оператор: " + "a" * (MAX_MESSAGE_CHARS + 1)})
    assert r.status_code == 422
    r = c.post("/api/conversations", json={"transcript": [{"speaker": "operator", "text": "a" * (MAX_MESSAGE_CHARS + 1)}]})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "transcript.0.text"


# --------------------------------------------------------------------------- последняя оценка


def test_failed_rerun_does_not_hide_done(s4):
    pks = s4.load()
    pk = pks["s4-chat-1"]
    good = s4.evaluate(pk)
    bad = s4.evaluate(pk, BrokenProvider())
    with Session(s4.engine) as s:
        assert s.get(Evaluation, bad).status == "failed"
    row = next(x for x in s4.client.get(f"/api/conversations?group_id={GROUP}").json() if x["id"] == pk)
    assert row["latest"]["evaluation_id"] == good
    # без успешных — показывается упавшая
    only_bad = s4.evaluate(pks["s4-chat-2"], BrokenProvider())
    row2 = next(x for x in s4.client.get(f"/api/conversations?group_id={GROUP}").json() if x["id"] == pks["s4-chat-2"])
    assert row2["latest"]["evaluation_id"] == only_bad


# --------------------------------------------------------------------------- CSV


def test_csv_cells_cannot_start_formulas():
    assert _cell("=HYPERLINK(\"x\")") == "'=HYPERLINK(\"x\")"
    assert _cell("+1") == "'+1" and _cell("@SUM(A1)") == "'@SUM(A1)" and _cell("-x") == "'-x"
    assert _cell(-1.5) == "-1,5" and _cell(-2) == "-2" and _cell("обычный текст") == "обычный текст"


# --------------------------------------------------------------------------- апелляции


def test_concurrent_appeals_create_only_one(s4):
    pks = s4.load()
    eid = s4.evaluate(pks["s4-chat-1"], ScriptedProvider(answers={"05": "no"}))
    results: list[str] = []
    start = threading.Barrier(4)

    def worker():
        with Session(s4.engine) as s:
            start.wait()
            try:
                appeals.create(s, eid, "05", "не согласен")
                results.append("ok")
            except appeals.Conflict:
                results.append("409")

    threads = [threading.Thread(target=worker) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["409", "409", "409", "ok"]


def test_appeal_decision_carries_over_reuse(s4):
    c = s4.client
    pks = s4.load()
    pk = pks["s4-chat-1"]
    s4.state["provider"] = ScriptedProvider(answers={"05": "no"})
    eid = s4.evaluate(pk, s4.state["provider"])
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "эмпатия была"}).json()
    c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "answer": "yes", "reason": "есть"})
    with Session(s4.engine) as s:
        new = evaluations.evaluate_one(s, pk, s4.version_id(), provider_name="openrouter", model="fake/m",
                                       strategy="grouped", reuse="auto")
        ev = s.get(Evaluation, new)
        row = next(r for r in s.exec(select(CriterionResult).where(CriterionResult.evaluation_id == new))
                   if r.criterion_key == "05")
        assert row.ai_answer == "no" and row.final_answer == "yes" and row.overridden
        assert any("перенесено" in i for i in row.issues)
        assert ev.ai_total == 85.0 and ev.final_total == 100.0
        # следующая переоценка снова переносит решение и не копит пометки
        newer = evaluations.evaluate_one(s, pk, s4.version_id(), provider_name="openrouter", model="fake/m",
                                         strategy="grouped", reuse="auto")
        row2 = next(r for r in s.exec(select(CriterionResult).where(CriterionResult.evaluation_id == newer))
                    if r.criterion_key == "05")
        assert row2.final_answer == "yes" and sum("перенесено" in i for i in row2.issues) == 1


# --------------------------------------------------------------------------- прокси записи


def test_audio_never_serves_html(client, monkeypatch):
    call, _ = ids(client)
    use_upstream(monkeypatch, lambda req: httpx.Response(200, content=b"<script>alert(1)</script>",
                                                         headers={"Content-Type": "text/html"}))
    r = client.get(f"/api/conversations/{call}/audio")
    # Страница без ссылки на аудио не отдаётся как есть: 502 с JSON-ошибкой.
    assert r.status_code == 502 and "alert" not in r.text
    assert r.headers["content-type"].startswith("application/json")


def test_audio_empty_file_and_invalid_url(client, monkeypatch):
    call, _ = ids(client)
    use_upstream(monkeypatch, lambda req: httpx.Response(200, content=b"", headers={"Content-Type": "audio/wav"}))
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=0-"})
    assert r.status_code == 200 and r.content == b""
    audio.cache.clear()
    bad, _ = ids(client, audio_url="http://[::1")
    monkeypatch.setattr(audio, "make_client", lambda: httpx.AsyncClient())
    r = client.get(f"/api/conversations/{bad}/audio")
    assert r.status_code == 502


def test_audio_full_download_is_bounded(client, monkeypatch):
    call, _ = ids(client)
    monkeypatch.setattr(audio, "MAX_CACHE_ITEM", 1000)
    use_upstream(monkeypatch, lambda req: httpx.Response(200, content=b"RIFF" + b"0" * 5000,
                                                         headers={"Content-Type": "audio/wav"}))
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=2000-2099"})
    assert r.status_code == 502 and "Range" in r.json()["detail"]


# --------------------------------------------------------------------------- оценка стоимости и сдача


def test_estimate_skips_calls_for_free_gemini(s4):
    pks = s4.load()
    with Session(s4.engine) as s:
        out = estimate.estimate(s, list(pks.values()), s4.version_id(), provider_name="gemini", model="g/m",
                                strategy="grouped")
    assert out["skipped_voice"] == 1 and out["dialogs_with_calls"] == 2 and out["cost_usd"] == 0.0


def test_estimate_history_by_requested_model(s4):
    pks = s4.load()
    for _ in range(3):  # 3 × 4 вызова grouped; провайдер отвечает моделью fake/m, прогон просил «fake/m»
        s4.evaluate(pks["s4-chat-1"])
    with Session(s4.engine) as s:
        run = EvaluationRun(group_id=GROUP, model="fake/m", provider="openrouter")
        s.add(run)
        s.flush()
        for ev in s.exec(select(Evaluation)).all():
            ev.run_id, ev.model = run.id, "fake/m-2026-01"
        for call in s.exec(select(LLMCall)).all():
            call.model = "fake/m-2026-01"  # как если бы OpenRouter вернул имя версии
        s.commit()
        out = estimate.estimate(s, [pks["s4-chat-1"]], s4.version_id(), provider_name="openrouter", model="fake/m",
                                strategy="grouped")
    assert out["cost_source"] == "history"


def test_submission_skips_manual_dialogs(s4):
    pks = s4.load()
    for pk in pks.values():
        s4.evaluate(pk)
    with Session(s4.engine) as s:
        s.add(Conversation(group_id=GROUP, conversation_id="manual-001", channel="agent chat", language="RU",
                           source="manual", transcript=[], normalized={}))
        s.commit()
        doc = results_export.build(s, GROUP, team_name="t")
    assert sorted(r["conversation_id"] for r in doc["results"]) == sorted(pks)


# --------------------------------------------------------------------------- сравнение с прошлой оценкой


def test_compare_with_previous(s4):
    c = s4.client
    pks = s4.load()
    pk = pks["s4-chat-1"]
    first = s4.evaluate(pk, ScriptedProvider(answers={"05": "no"}))
    assert c.get(f"/api/evaluations/{first}/compare").json()["b"] is None
    s4.evaluate(pk, BrokenProvider())                     # упавшая пропускается
    second = s4.evaluate(pk, ScriptedProvider())
    d = c.get(f"/api/evaluations/{second}/compare").json()
    assert d["b"]["id"] == first and d["same_config"] is True and d["config_diff"] == []
    assert d["common"] == 8 and d["changed"] == 1 and d["total_delta"] == 15.0
    row = next(x for x in d["criteria"] if x["key"] == "05")
    assert row["status"] == "changed" and row["a"]["answer"] == "yes" and row["b"]["answer"] == "no"
    assert row["points_delta"] == 15.0 and row["title"]
    other = s4.evaluate(pks["s4-chat-2"])
    assert c.get(f"/api/evaluations/{second}/compare?other={other}").status_code == 422
    assert c.get("/api/evaluations/999/compare").status_code == 404
