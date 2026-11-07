import json
from pathlib import Path

import pytest


def payload(extra=None):
    recs = [
        {
            "conversation_id": "t-chat-1", "channel": "Chat", "language": "RU", "audio_url": None,
            "transcript": [
                {"timestamp": "00:00", "speaker": "bot", "text": "Здравствуйте"},
                {"timestamp": "00:10", "speaker": "operator", "text": "Добрый день, меня зовут Анна"},
            ],
        },
        {
            "conversation_id": "t-call-1", "channel": "Voice Call", "language": "RU", "audio_url": "https://x.test/a.mp3",
            "transcript": [
                {"timestamp": "2026-01-01T10:00:00Z", "speaker": "operator", "text": "Алло"},
                {"timestamp": "2026-01-01T10:00:05Z", "speaker": "client", "text": "Здравствуйте"},
            ],
        },
    ] + (extra or [])
    return {"isSuccess": True, "error": "", "data": {"dataset_group_id": "T", "total_records": len(recs), "records": recs}}


def upload(client, p):
    return client.post("/api/datasets/upload", files={"file": ("d.json", json.dumps(p), "application/json")})


def test_upload_and_reupload(client):
    r = upload(client, payload())
    assert r.status_code == 200
    assert r.json()["imported"] == 2 and r.json()["updated"] == 0 and r.json()["group_id"] == "T"
    r = upload(client, payload())
    assert r.json()["imported"] == 0 and r.json()["updated"] == 2


def test_warnings_unknown_channel_and_missing_id(client):
    extra = [
        {"conversation_id": "t-x", "channel": "Telegram", "language": "RU", "transcript": []},
        {"channel": "Chat", "language": "RU", "transcript": []},
    ]
    r = upload(client, payload(extra)).json()
    assert r["imported"] == 3
    assert any("Telegram" in w for w in r["warnings"])
    assert any("conversation_id" in w for w in r["warnings"])


def test_list_and_detail(client):
    upload(client, payload())
    rows = client.get("/api/conversations?group_id=T").json()
    assert [r["conversation_id"] for r in rows] == ["t-call-1", "t-chat-1"]
    assert rows[0]["latest"] is None
    assert len(client.get("/api/conversations?group_id=T&channel=Chat").json()) == 1
    assert client.get("/api/conversations?group_id=NOPE").json() == []
    d = client.get(f"/api/conversations/{rows[0]['id']}").json()
    assert d["messages"][0]["msg_id"] == "m0"
    assert "audio_offset_sec" in d["messages"][0] and "internal" in d["messages"][0]
    assert d["evaluations"] == [] and d["has_audio"] is True
    assert d["audio_url"] == f"/api/conversations/{d['id']}/audio"  # подписанная ссылка не уходит в браузер


def test_detail_404(client):
    assert client.get("/api/conversations/9999").status_code == 404


def test_upload_bad_file(client):
    r = client.post("/api/datasets/upload", files={"file": ("d.json", b"not json", "application/json")})
    assert r.status_code == 400
    assert upload(client, {"data": {}}).status_code == 400


def test_import_without_url(client, monkeypatch):
    from backend.app.config import settings
    monkeypatch.setattr(settings, "organizer_api_url", "")
    r = client.post("/api/datasets/import", json={"group_id": "DEV"})
    assert r.status_code == 400 and "ORGANIZER_API_URL" in r.json()["detail"]


def test_import_from_api_mocked(client, monkeypatch):
    from backend.app.config import settings
    from backend.app.services import ingest
    monkeypatch.setattr(settings, "organizer_api_url", "https://api.test/x?sig=SECRET&group_id=DEV")
    seen = {}

    class R:
        def raise_for_status(self): pass
        def json(self): return payload()

    def fake_get(url, timeout):
        seen["url"] = url
        return R()

    monkeypatch.setattr(ingest.httpx, "get", fake_get)
    r = client.post("/api/datasets/import", json={"group_id": "CTRL"})
    assert r.status_code == 200 and "group_id=CTRL" in seen["url"] and "DEV" not in seen["url"].split("group_id=")[1]
    assert "SECRET" not in r.text


DEV = Path(__file__).resolve().parents[1] / "data" / "raw" / "DEV.json"


@pytest.mark.skipif(not DEV.exists(), reason="нет снапшота DEV")
def test_dev_snapshot(client):
    r = client.post("/api/datasets/upload", files={"file": ("DEV.json", DEV.read_bytes(), "application/json")})
    assert r.json()["imported"] == 65
    rows = client.get("/api/conversations?group_id=DEV").json()
    assert len(rows) == 65
    call = next(x for x in rows if x["conversation_id"].startswith("p4-ru"))
    d = client.get(f"/api/conversations/{call['id']}").json()
    assert any(m["audio_offset_sec"] is not None for m in d["messages"])
