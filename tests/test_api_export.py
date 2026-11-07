"""Экспорт результатов группы (FR-EXP-01): CSV для Excel и JSON с обоснованиями."""
import csv
import io

from tests.stage4_helpers import ScriptedProvider


def _setup(env):
    pks = env.load()
    eid = env.evaluate(pks["s4-chat-1"], ScriptedProvider(answers={"05": "no", "04": "15"},
                                                          evidence={"05": [{"msg_id": "m3", "quote": ""}]}))
    env.evaluate(pks["s4-chat-2"])
    return pks, eid


def test_csv_bom_semicolon_and_columns(s4):
    c = s4.client
    pks, eid = _setup(s4)
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "x"}).json()
    c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "answer": "yes", "reason": "y"})

    r = c.get("/api/export?group_id=S4&format=csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and ".csv" in r.headers["content-disposition"]
    raw = r.content
    assert raw.startswith("﻿".encode("utf-8")), "нужен BOM для Excel"
    text = raw.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    head = rows[0]
    assert head[:6] == ["conversation_id", "channel", "language", "checklist_version", "model", "status"]
    for k in ("01", "04", "08"):
        assert f"c{k}_answer" in head and f"c{k}_points" in head
    assert {"ai_total", "final_total", "critical", "cost_usd"} <= set(head)
    data = {r[0]: dict(zip(head, r)) for r in rows[1:]}
    assert set(data) == {"s4-chat-1", "s4-chat-2", "s4-call-1"}
    one = data["s4-chat-1"]
    # AI: 100 − 15 (05) − 5 (04: 15 из 20) = 80; финал после апелляции по 05: 95
    assert one["ai_total"] == "80" and one["final_total"] == "95"
    assert one["c05_answer"] == "yes" and one["c05_points"] == "15" and one["c04_answer"] == "15"
    assert one["c04_points"] == "15" and one["critical"] == "no" and one["overridden"] == "05"
    # 4 вызова по группам × $0.001, дробь через запятую
    assert one["cost_usd"] == "0,004" and one["status"] == "done" and one["checklist_version"] == "default v1"
    assert data["s4-call-1"]["status"] == "not_evaluated" and data["s4-call-1"]["final_total"] == ""


def test_json_has_reasoning(s4):
    c = s4.client
    _setup(s4)
    r = c.get("/api/export?group_id=S4&format=json")
    assert r.status_code == 200 and ".json" in r.headers["content-disposition"]
    rows = {x["conversation_id"]: x for x in r.json()}
    one = rows["s4-chat-1"]
    assert one["ai_total"] == 80.0 and one["final_total"] == 80.0 and one["critical"] is False
    assert one["c04_answer"] == 15 and one["c04_points"] == 15.0
    crit = {x["key"]: x for x in one["criteria"]}
    assert crit["05"]["reasoning"] == "обоснование 05" and crit["05"]["ai_answer"] == "no"
    assert one["overview"]["topic"] == "Пополнение счёта"
    assert rows["s4-call-1"]["criteria"] == [] and rows["s4-call-1"]["status"] == "not_evaluated"


def test_export_errors(s4):
    c = s4.client
    assert c.get("/api/export?format=xlsx").status_code == 400
    assert c.get("/api/export?checklist_version_id=999").status_code == 404
    r = c.get("/api/export?group_id=EMPTY")
    assert r.status_code == 200 and r.content.decode("utf-8-sig").count("\r\n") == 1  # только заголовок
