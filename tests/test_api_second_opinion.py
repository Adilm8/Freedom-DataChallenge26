"""Второе мнение ИИ по апелляции: слепая перепроверка одного критерия, оценка AI не меняется."""
from backend.app.services import second_opinion
from tests.stage4_helpers import BrokenProvider, ScriptedProvider


class Spy(ScriptedProvider):
    """Запоминает запросы: проверяем, что модель не видит ответ AI и комментарий аналитика."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.seen = []

    def complete(self, messages, *, json_schema=None, **kw):
        self.seen.append((messages, json_schema))
        return super().complete(messages, json_schema=json_schema, **kw)


COMMENT = "Оператор проявил эмпатию УНИКАЛЬНЫЙ-МАРКЕР"


def _setup(s4):
    pks = s4.load()
    eid = s4.evaluate(pks["s4-chat-1"], ScriptedProvider(answers={"05": "no"}))
    ap = s4.client.post("/api/appeals", json={"evaluation_id": eid, "criterion_key": "05", "comment": COMMENT}).json()
    return eid, ap


def _row(c, appeal_id):
    return next(x for x in c.get("/api/appeals").json() if x["id"] == appeal_id)


def test_second_opinion_blind_saved_and_keeps_evaluation(s4, monkeypatch):
    c = s4.client
    eid, ap = _setup(s4)
    before = c.get(f"/api/evaluations/{eid}").json()
    spy = Spy(answers={"05": "yes"}, evidence={"05": [{"msg_id": "m5", "quote": "Откройте раздел"}]})
    monkeypatch.setattr(second_opinion, "get_provider", lambda name=None: spy)

    r = c.post(f"/api/appeals/{ap['id']}/second-opinion", json={"provider": "openrouter", "model": "fake/m"})
    assert r.status_code == 200, r.text
    op = r.json()
    assert op["answer"] == "yes" and op["ai_answer"] == "no" and op["agrees"] is False
    assert op["criterion_key"] == "05" and op["model"] == "fake/m" and op["status"] == "done"
    assert op["reasoning"] and op["confidence"] == "high" and op["cost_usd"] > 0 and op["tokens"][0] > 0
    assert op["evidence"][0]["msg_id"] == "m5"

    # один вызов, только спорный критерий, без ответа AI и комментария аналитика
    assert len(spy.seen) == 1
    msgs, schema = spy.seen[0]
    assert list(schema["properties"]["results"]["properties"]) == ["05"]
    text = "\n".join(str(m.get("content")) for m in msgs)
    assert "УНИКАЛЬНЫЙ-МАРКЕР" not in text and "обоснование 05" not in text

    # AI-оценка, финальный итог и апелляция не изменились
    after = c.get(f"/api/evaluations/{eid}").json()
    assert after["ai_score"] == before["ai_score"] and after["final_score"] == before["final_score"]
    assert after["criteria"] == before["criteria"]
    row = _row(c, ap["id"])
    assert row["status"] == "open"
    # сохранено и отдаётся в очереди после перезагрузки
    assert row["second_opinion"]["id"] == op["id"] and row["second_opinion"]["answer"] == "yes"

    # тело необязательно по провайдеру; совпадающий ответ → agrees, в очереди — последнее
    monkeypatch.setattr(second_opinion, "get_provider", lambda name=None: ScriptedProvider(answers={"05": "no"}))
    r2 = c.post(f"/api/appeals/{ap['id']}/second-opinion", json={"model": "fake/m"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["agrees"] is True
    assert _row(c, ap["id"])["second_opinion"]["id"] == r2.json()["id"]


def test_second_opinion_only_for_open_appeal(s4, monkeypatch):
    c = s4.client
    _, ap = _setup(s4)
    monkeypatch.setattr(second_opinion, "get_provider", lambda name=None: ScriptedProvider())
    assert c.post("/api/appeals/9999/second-opinion", json={"model": "fake/m"}).status_code == 404
    assert c.post(f"/api/appeals/{ap['id']}/second-opinion", json={"provider": "nope", "model": "m"}).status_code == 400
    c.post(f"/api/appeals/{ap['id']}/decision", json={"action": "confirm", "reason": "верно"})
    r = c.post(f"/api/appeals/{ap['id']}/second-opinion", json={"model": "fake/m"})
    assert r.status_code == 409, r.text


def test_second_opinion_provider_failure_is_502(s4, monkeypatch):
    c = s4.client
    _, ap = _setup(s4)
    monkeypatch.setattr(second_opinion, "get_provider", lambda name=None: BrokenProvider())
    r = c.post(f"/api/appeals/{ap['id']}/second-opinion", json={"model": "fake/m"})
    assert r.status_code == 502 and "провайдер недоступен" in r.json()["detail"]
    assert _row(c, ap["id"])["second_opinion"] is None
