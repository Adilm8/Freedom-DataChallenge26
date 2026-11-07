"""Аналитика группы (FR-ANL-01) и очередь «требует проверки» (FR-UX-02)."""
from tests.stage4_helpers import BrokenProvider, ScriptedProvider


def _setup(env):
    pks = env.load()
    # chat-1: 05 «Нет» с низкой уверенностью → AI 85; chat-2: всё «Да», грубая ошибка 08; звонок — оценка не получена
    e1 = env.evaluate(pks["s4-chat-1"], ScriptedProvider(answers={"05": "no"}, confidence={"05": "low"},
                                                         evidence={"05": [{"msg_id": "m3", "quote": ""}]}))
    e2 = env.evaluate(pks["s4-chat-2"], ScriptedProvider(answers={"08": "yes"}, topic="пополнение счёта", resolved="no"))
    e3 = env.evaluate(pks["s4-call-1"], BrokenProvider())
    return pks, e1, e2, e3


def test_analytics_summary(s4):
    c = s4.client
    pks, e1, e2, _ = _setup(s4)
    a = c.get("/api/analytics?group_id=S4").json()
    assert a["conversations"] == 3 and a["count"] == 3 and a["not_evaluated"] == 0
    assert a["status_counts"] == {"done": 2, "failed": 1}
    assert a["avg_total"] == 92.5 and a["avg_ai_total"] == 92.5  # (85 + 100) / 2, failed без итога
    assert sum(b["count"] for b in a["histogram"]) == 2
    top = next(b for b in a["histogram"] if b["from"] == 90)
    assert top["count"] == 1 and top["to"] == 100  # 100 попадает в последнюю корзину
    assert next(b for b in a["histogram"] if b["from"] == 80)["count"] == 1

    crit = {x["key"]: x for x in a["by_criterion"]}
    assert crit["05"]["pass_rate"] == 0.5 and crit["05"]["avg_pct"] == 50.0 and crit["05"]["not_passed_ids"] == [pks["s4-chat-1"]]
    assert crit["05"]["low_confidence_count"] == 1 and crit["05"]["answers"] == {"no": 1, "yes": 1}
    assert crit["01"]["pass_rate"] == 1.0 and crit["01"]["na_rate"] == 0.0
    assert crit["08"]["pass_rate"] == 0.5 and crit["08"]["avg_pct"] is None  # флаг: «выполнен» = нарушения нет
    assert a["critical_count"] == 1 and a["critical_ids"] == [pks["s4-chat-2"]]
    assert a["by_language"]["RU"]["conversations"] == 2 and a["by_language"]["KZ"]["avg_total"] == 100.0
    assert a["by_channel"]["voice call"]["count"] == 1 and a["by_channel"]["voice call"]["avg_total"] is None
    assert a["needs_review_count"] == 2  # chat-1 (низкая уверенность) и неудачная оценка звонка
    assert a["review_queue_count"] >= 2

    # темы без учёта регистра: «Пополнение счёта» + «пополнение счёта»
    assert len(a["topics"]) == 1
    t = a["topics"][0]
    assert t["count"] == 2 and t["resolved_rate"] == 0.5 and sorted(t["ids"]) == sorted([pks["s4-chat-1"], pks["s4-chat-2"]])
    assert t["weakest"]["key"] == "05"
    assert a["resolved"] == {"yes": 1, "no": 1, "unclear": 0}
    assert a["cost"]["latest_usd"] > 0 and a["cost"]["evaluations_total"] == 3
    assert a["checklist_version"]["version"] == 1

    # апелляция меняет финальные цифры, AI остаются
    ap = c.post("/api/appeals", json={"evaluation_id": e1, "criterion_key": "05", "comment": "x"}).json()
    c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "answer": "yes", "reason": "y"})
    a = c.get("/api/analytics?group_id=S4").json()
    crit = {x["key"]: x for x in a["by_criterion"]}
    assert a["avg_total"] == 100.0 and a["avg_ai_total"] == 92.5
    assert crit["05"]["pass_rate"] == 1.0 and crit["05"]["ai_pass_rate"] == 0.5
    assert crit["05"]["overridden_count"] == 1 and crit["05"]["appeals_changed"] == 1
    assert a["appeals"] == {"open": 0, "confirmed": 0, "changed": 1}

    assert c.get("/api/analytics?group_id=S4&checklist_version_id=999").status_code == 404
    empty = c.get("/api/analytics?group_id=NOPE").json()
    assert empty["count"] == 0 and empty["avg_total"] is None and empty["topics"] == []


def test_review_queue(s4):
    c = s4.client
    pks, e1, e2, e3 = _setup(s4)
    q = c.get("/api/review-queue?group_id=S4").json()
    # первым — неудачная оценка звонка, затем низкая уверенность по 05
    assert q[0]["reason"] == "failed" and q[0]["evaluation_id"] == e3 and q[0]["criterion_key"] is None
    assert "провайдер недоступен" in q[0]["message"]
    low = next(x for x in q if x["criterion_key"] == "05")
    assert low["reason"] == "low_confidence" and low["conversation_id"] == pks["s4-chat-1"]
    assert low["conversation_code"] == "s4-chat-1" and low["evaluation_id"] == e1 and low["ai_answer"] == "no"
    assert "низкая уверенность модели" in low["issues"]
    assert [x["severity"] for x in q] == sorted((x["severity"] for x in q), reverse=True)

    # открытая апелляция поднимает критерий выше и добавляет причину
    ap = c.post("/api/appeals", json={"evaluation_id": e1, "criterion_key": "05", "comment": "спорно"}).json()
    item = next(x for x in c.get("/api/review-queue?group_id=S4").json() if x["criterion_key"] == "05")
    assert item["reason"] == "appeal" and item["reasons"] == ["appeal", "low_confidence"] and item["appeal_id"] == ap["id"]
    # после решения критерий проверен человеком — уходит из очереди
    c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "confirm", "reason": "ок"})
    assert not any(x["criterion_key"] == "05" for x in c.get("/api/review-queue?group_id=S4").json())


def test_review_queue_guard_validator_missing(s4):
    c = s4.client
    pks = s4.load()
    # страховка 01: факты говорят «нет приветствия и имени», модель ответила «Да» → guard
    # 02 «Нет» без доказательства → проверка ответа (validator); 06 не вернулся → missing
    prov = ScriptedProvider(answers={"02": "no"}, omit={"06"})
    eid = s4.evaluate(pks["s4-chat-1"], prov, booleans={"greeting_in_first_msg": False, "intro_in_first_msg": False})
    q = {x["criterion_key"]: x for x in c.get("/api/review-queue?group_id=S4").json()}
    assert q["06"]["reason"] == "missing" and q["06"]["evaluation_id"] == eid
    assert q["01"]["reason"] == "guard" and q["01"]["message"] == "Ответ модели противоречит фактам"
    assert q["02"]["reason"] == "validator" and "«Нет» без указания места" in q["02"]["message"]
    order = [x["criterion_key"] for x in c.get("/api/review-queue?group_id=S4").json()]
    assert order.index("06") < order.index("01") < order.index("02")
    assert c.get("/api/review-queue?group_id=OTHER").json() == []
