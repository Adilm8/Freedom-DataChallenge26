"""Новый диалог из интерфейса (FR-DATA-07) и поправка смещения записи."""
import json

TEXT = """[00:00] Клиент: Здравствуйте, как вывести деньги?
00:05 бот: Передаю специалисту
О: Добрый день, меня зовут Анна.
Откройте раздел «Вывод».
К: Спасибо
system: Оператор закрыл чат
"""


def test_text_transcript(s4):
    c = s4.client
    r = c.post("/api/conversations", json={"transcript": TEXT, "language": "ru", "channel": "чат"})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["group_id"] == "MANUAL" and d["conversation_id"] == "manual-001" and d["source"] == "manual"
    assert d["language"] == "RU" and d["channel"] == "agent chat"
    assert [m["speaker"] for m in d["messages"]] == ["client", "bot", "operator", "client", "system"]
    assert d["messages"][2]["text"] == "Добрый день, меня зовут Анна.\nОткройте раздел «Вывод»."
    assert d["messages"][0]["timestamp"] == "00:00" and d["messages"][1]["t_sec"] == 5
    assert d["messages"][2]["msg_id"] == "m2" and d["messages"][2]["idx"] == 2
    assert d["evaluations"] == [] and d["latest"] is None and d["audio_offset_fix_sec"] == 0
    # второй — следующий номер; виден в списке группы
    d2 = c.post("/api/conversations", json={"transcript": "оператор: Здравствуйте"}).json()
    assert d2["conversation_id"] == "manual-002"
    assert any("нет времени" in w for w in d2["warnings"])
    assert [x["conversation_id"] for x in c.get("/api/conversations?group_id=MANUAL").json()] == ["manual-001", "manual-002"]
    # вставленный диалог оценивается тем же конвейером
    eid = s4.evaluate(d["id"])
    ev = c.get(f"/api/evaluations/{eid}").json()
    assert ev["status"] == "done" and ev["conversation_id"] == d["id"] and len(ev["criteria"]) == 8
    assert c.get(f"/api/conversations/{d['id']}").json()["latest"]["evaluation_id"] == eid


def test_array_transcript_and_conflict(s4):
    c = s4.client
    body = {"group_id": "DEMO", "conversation_id": "demo-1", "channel": "agent chat", "language": "EN",
            "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "Hi"},
                           {"timestamp": "00:30", "speaker": "operator", "text": "Hello, I am John"}]}
    r = c.post("/api/conversations", json=body)
    assert r.status_code == 201 and r.json()["conversation_id"] == "demo-1" and r.json()["group_id"] == "DEMO"
    assert r.json()["messages"][1]["t_sec"] == 30
    r = c.post("/api/conversations", json=body)
    assert r.status_code == 409 and "demo-1" in r.json()["detail"]


def test_json_pasted_as_text(s4):
    rec = {"conversation_id": "p-x", "channel": "agent chat", "language": "KZ",
           "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "Сәлем"},
                          {"timestamp": "00:10", "speaker": "operator", "text": "Сәлеметсіз бе"}]}
    r = s4.client.post("/api/conversations", json={"transcript": json.dumps(rec, ensure_ascii=False)})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["conversation_id"] == "p-x" and d["language"] == "KZ" and len(d["messages"]) == 2
    payload = {"isSuccess": True, "data": {"records": [rec, {**rec, "conversation_id": "p-y"}]}}
    r = s4.client.post("/api/conversations", json={"transcript": json.dumps(payload)})
    assert r.status_code == 422 and "загрузите файл" in r.json()["errors"][0]["message"]


def test_language_detected_when_missing(s4):
    d = s4.client.post("/api/conversations", json={"transcript": "client: How do I withdraw money?\noperator: Hello"}).json()
    assert d["language"] == "EN" and any("определён" in w for w in d["warnings"])


def test_validation_errors(s4):
    c = s4.client
    r = c.post("/api/conversations", json={"transcript": "привет без роли\nоператор: да"})
    assert r.status_code == 422
    body = r.json()
    assert body["detail"] and body["errors"][0]["path"] == "transcript" and "строка 1" in body["errors"][0]["message"]
    r = c.post("/api/conversations", json={"transcript": [{"speaker": "manager?", "text": "x"}, {"speaker": "client", "text": ""}]})
    assert r.status_code == 422
    paths = [e["path"] for e in r.json()["errors"]]
    assert paths == ["transcript.0.speaker", "transcript.1.text"]
    assert c.post("/api/conversations", json={"transcript": ""}).status_code == 422
    assert c.post("/api/conversations", json={"transcript": 5}).status_code == 422
    assert c.post("/api/conversations", json={}).status_code == 422


def test_patch_audio_offset(s4):
    c = s4.client
    pks = s4.load()
    pk = pks["s4-call-1"]
    r = c.patch(f"/api/conversations/{pk}", json={"audio_offset_fix_sec": -1.5})
    assert r.status_code == 200 and r.json()["audio_offset_fix_sec"] == -1.5
    assert c.get(f"/api/conversations/{pk}").json()["audio_offset_fix_sec"] == -1.5
    # исходные секунды реплик не меняются: плеер прибавляет поправку сам
    assert r.json()["messages"][1]["audio_offset_sec"] == 5.0
    for bad in ("abc", None, 99999, True):
        r = c.patch(f"/api/conversations/{pk}", json={"audio_offset_fix_sec": bad})
        assert r.status_code == 422 and r.json()["errors"][0]["path"] == "audio_offset_fix_sec"
    assert c.patch("/api/conversations/9999", json={"audio_offset_fix_sec": 1}).status_code == 404
