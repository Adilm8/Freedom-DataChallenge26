"""Апелляции (FR-APL-01…05): AI-оценка не меняется, финальный итог пересчитывается кодом."""
from tests.stage4_helpers import ScriptedProvider


def _setup(env):
    pks = env.load()
    # 05 «Нет» с доказательством в m5 и m7 → AI-итог (100 − 15) / 100 = 85
    prov = ScriptedProvider(answers={"05": "no"},
                            evidence={"05": [{"msg_id": "m5", "quote": "Откройте раздел"}, {"msg_id": "m7", "quote": ""}]})
    eid = env.evaluate(pks["s4-chat-1"], prov)
    return pks, eid


def test_change_updates_final_not_ai(s4):
    c = s4.client
    pks, eid = _setup(s4)
    ev = c.get(f"/api/evaluations/{eid}").json()
    assert ev["ai_score"]["total"] == 85.0 and ev["final_score"]["total"] == 85.0 and ev["open_appeals"] == 0

    r = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "Оператор проявил эмпатию"})
    assert r.status_code == 201, r.text
    ap = r.json()
    assert ap["status"] == "open" and ap["ai_answer_snapshot"] == "no" and ap["decision_answer"] is None

    # счётчик открытых апелляций в списке и фильтр appeal
    rows = c.get("/api/conversations?group_id=S4").json()
    row = next(x for x in rows if x["id"] == pks["s4-chat-1"])
    assert row["latest"]["open_appeals"] == 1 and row["latest"]["appeals"] == 1
    assert [x["id"] for x in c.get("/api/conversations?group_id=S4&appeal=open").json()] == [pks["s4-chat-1"]]
    assert [x["id"] for x in c.get("/api/conversations?group_id=S4&appeal=any").json()] == [pks["s4-chat-1"]]
    assert c.get("/api/conversations?appeal=nope").status_code == 400

    # карточка показывает открытую апелляцию у критерия
    crit = next(x for x in c.get(f"/api/evaluations/{eid}").json()["criteria"] if x["key"] == "05")
    assert crit["appeal"]["status"] == "open" and crit["allowed_answers"] == ["yes", "no"]

    r = c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "answer": "yes", "reason": "Есть «понимаю вас»"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["appeal"]["status"] == "changed" and out["appeal"]["decision_answer"] == "yes"
    assert out["appeal"]["decided_at"] and out["appeal"]["decision_reason"] == "Есть «понимаю вас»"
    ev = out["evaluation"]
    assert ev["ai_score"]["total"] == 85.0, "AI-оценка не должна меняться"
    assert ev["final_score"]["total"] == 100.0
    crit = next(x for x in ev["criteria"] if x["key"] == "05")
    assert crit["ai_answer"] == "no" and crit["ai_points"] == 0.0
    assert crit["final_answer"] == "yes" and crit["final_points"] == 15.0 and crit["overridden"] is True
    assert crit["appeal"]["status"] == "changed" and len(crit["appeal_history"]) == 1

    row = next(x for x in c.get("/api/conversations?group_id=S4").json() if x["id"] == pks["s4-chat-1"])
    assert row["latest"]["ai_total"] == 85.0 and row["latest"]["final_total"] == 100.0
    assert row["latest"]["open_appeals"] == 0
    assert c.get("/api/conversations?group_id=S4&appeal=open").json() == []

    # повторная апелляция после решения (FR-APL-07) — можно; вернуть ответ AI → overridden снова False
    ap2 = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "Эмпатии не было"}).json()
    ev = c.post(f"/api/appeals/{ap2['id']}/decision",
                json={"action": "change", "answer": "no", "reason": "перечитали"}).json()["evaluation"]
    crit = next(x for x in ev["criteria"] if x["key"] == "05")
    assert crit["overridden"] is False and ev["final_score"]["total"] == 85.0 and len(crit["appeal_history"]) == 2


def test_second_open_appeal_conflicts(s4):
    c = s4.client
    _, eid = _setup(s4)
    body = {"evaluation_id": eid, "criterion_key": "04", "comment": "спорно"}
    assert c.post("/api/appeals", json=body).status_code == 201
    r = c.post("/api/appeals", json=body)
    assert r.status_code == 409 and "открытая" in r.json()["detail"]
    # другой критерий той же оценки — можно
    assert c.post("/api/appeals", json={**body, "criterion_key": "01"}).status_code == 201


def test_confirm_keeps_scores(s4):
    c = s4.client
    _, eid = _setup(s4)
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "?"}).json()
    r = c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "confirm", "reason": "AI прав"})
    assert r.status_code == 200
    out = r.json()
    assert out["appeal"]["status"] == "confirmed" and out["appeal"]["decision_answer"] == "no"
    assert out["evaluation"]["final_score"]["total"] == 85.0
    # рассмотренную апелляцию второй раз не решить
    r = c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "answer": "yes", "reason": "x"})
    assert r.status_code == 409


def test_critical_flag_follows_final_answer(s4):
    c = s4.client
    pks, eid = _setup(s4)
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "08", "comment": "грубость"}).json()
    ev = c.post(f"/api/appeals/{ap['id']}/decision",
                json={"action": "change", "answer": "yes", "reason": "оскорбление"}).json()["evaluation"]
    assert ev["critical"] is True and ev["final_score"]["critical"] == ["08"] and ev["ai_score"]["critical"] == []
    assert [x["id"] for x in c.get("/api/conversations?group_id=S4&critical=true").json()] == [pks["s4-chat-1"]]


def test_scale_change_and_validation(s4):
    c = s4.client
    _, eid = _setup(s4)
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "04", "comment": "неполно"}).json()
    url = f"/api/appeals/{ap['id']}/decision"
    r = c.post(url, json={"action": "change", "answer": 10, "reason": ""})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "reason"
    r = c.post(url, json={"action": "change", "answer": 12, "reason": "x"})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "answer"
    r = c.post(url, json={"action": "change", "reason": "x"})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "answer"
    r = c.post(url, json={"action": "change", "answer": 20, "reason": "x"})  # совпадает с текущим
    assert r.status_code == 422
    r = c.post(url, json={"action": "maybe", "reason": "x"})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "action"
    r = c.post(url, json={"action": "change", "answer": "10", "reason": "закрыта часть запроса"})
    assert r.status_code == 200
    ev = r.json()["evaluation"]
    crit = next(x for x in ev["criteria"] if x["key"] == "04")
    assert crit["final_answer"] == 10 and crit["final_points"] == 10.0 and crit["ai_answer"] == 20
    assert ev["final_score"]["total"] == 75.0 and ev["ai_score"]["total"] == 85.0


def test_create_validation(s4):
    c = s4.client
    _, eid = _setup(s4)
    assert c.post("/api/appeals", json={"evaluation_id": 999, "criterion_key": "01", "comment": "x"}).status_code == 404
    assert c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "99", "comment": "x"}).status_code == 404
    r = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "01", "comment": "  "})
    assert r.status_code == 422 and r.json()["errors"][0]["path"] == "comment"
    assert c.post("/api/appeals/999/decision", json={"action": "confirm", "reason": "x"}).status_code == 404


def test_appeal_rows_with_fragment(s4):
    c = s4.client
    pks, eid = _setup(s4)
    ap = c.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": "спорно"}).json()
    rows = c.get("/api/appeals?status=open").json()
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == ap["id"] and row["conversation"]["conversation_id"] == "s4-chat-1"
    assert row["conversation"]["id"] == pks["s4-chat-1"] and row["evaluation"]["ai_total"] == 85.0
    assert row["criterion"]["reasoning"] == "обоснование 05" and row["criterion"]["allowed_answers"] == ["yes", "no"]
    # доказательства m5 и m7 ± 2 реплики → m3…m9 одним куском
    frag = row["fragment"]
    assert [m["msg_id"] for m in frag] == ["m3", "m4", "m5", "m6", "m7", "m8", "m9"]
    assert frag[0]["gap_before"] is True and not any(m["gap_before"] for m in frag[1:])
    assert [m["msg_id"] for m in frag if m["is_evidence"]] == ["m5", "m7"]
    assert frag[2]["quotes"] == ["Откройте раздел"]

    assert c.get("/api/appeals?status=closed").json() == []
    assert len(c.get("/api/appeals").json()) == 1
    assert len(c.get("/api/appeals?group_id=S4").json()) == 1 and c.get("/api/appeals?group_id=X").json() == []
    assert len(c.get(f"/api/appeals?conversation_id={pks['s4-chat-1']}").json()) == 1
    assert c.get("/api/appeals?status=bad").status_code == 400


def test_fragment_with_gap():
    from backend.app.services.appeals import fragment

    msgs = [{"msg_id": f"m{i}", "idx": i, "speaker": "operator", "text": str(i)} for i in range(12)]
    frag = fragment(msgs, [{"msg_id": "m1", "quote": ""}, {"msg_id": "m9", "quote": ""}], None)
    assert [m["idx"] for m in frag] == [0, 1, 2, 3, 7, 8, 9, 10, 11]
    assert [m["idx"] for m in frag if m["gap_before"]] == [7]
    # без доказательств — проверенный участок; длинный — начало и конец
    frag = fragment(msgs, [], {"from": "m0", "to": "m11"})
    assert [m["idx"] for m in frag] == [0, 1, 2, 3, 8, 9, 10, 11]
    assert fragment(msgs, [], None) == []
