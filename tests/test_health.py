from fastapi.testclient import TestClient

from backend.app.main import app


def test_health():
    r = TestClient(app).get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_health_organizer_api_flag_without_url(monkeypatch):
    from backend.app.config import settings
    monkeypatch.setattr(settings, "organizer_api_url", "")
    assert TestClient(app).get("/api/health").json()["organizer_api"] is False
    monkeypatch.setattr(settings, "organizer_api_url", "https://api.test/x?sig=TOPSECRET123&group_id=DEV")
    r = TestClient(app).get("/api/health")
    assert r.json()["organizer_api"] is True
    assert "TOPSECRET123" not in r.text and "api.test" not in r.text
