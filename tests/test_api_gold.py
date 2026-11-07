import json
import shutil
from pathlib import Path

import pytest
from sqlmodel import Session

from backend.app import db
from backend.app.main import app
from backend.app.models import Conversation
from backend.app.services import gold as gold_svc

FIX = Path(__file__).parent / "fixtures" / "gold"


@pytest.fixture()
def gold(client, tmp_path, monkeypatch):
    d = tmp_path / "gold"
    shutil.copytree(FIX, d)
    monkeypatch.setattr(gold_svc, "GOLD_DIR", d)
    gen = app.dependency_overrides[db.get_session]()
    s: Session = next(gen)
    s.add(Conversation(group_id="DEV", conversation_id="t-ru-001", channel="chat", language="RU"))
    s.add(Conversation(group_id="DEV", conversation_id="t-en-001", channel="chat", language="EN"))
    s.add(Conversation(group_id="CONTROL", conversation_id="c-ru-001", channel="chat", language="RU"))
    s.commit()
    gen.close()
    return d


def test_list(client, gold):
    rows = {r["conversation_id"]: r for r in client.get("/api/gold").json()}
    assert set(rows) == {"t-ru-001", "t-en-001", "t-kz-009"}
    r = rows["t-ru-001"]
    assert r["has_draft"] and r["has_second_opinion"] and r["split"] == "dev" and r["conversation_pk"]
    assert r["low_confidence"] == 1 and not r["reviewed"] and r["changed"] == 0
    assert rows["t-en-001"]["split"] == "holdout" and not rows["t-en-001"]["has_second_opinion"]
    assert rows["t-kz-009"]["conversation_pk"] is None and not rows["t-kz-009"]["has_draft"]


def test_list_empty_dir(client, tmp_path, monkeypatch):
    monkeypatch.setattr(gold_svc, "GOLD_DIR", tmp_path / "nothing")
    assert client.get("/api/gold").json() == []


def test_get(client, gold):
    j = client.get("/api/gold/t-ru-001").json()
    assert j["draft"]["criteria"]["03"]["confidence"] == "low"
    assert j["second_opinion"]["criteria"]["01"]["answer"] == "no" and j["label"] is None
    keys = [c["key"] for c in j["criteria"]]
    assert keys == ["01", "02", "03", "04", "05", "06", "07", "08"]
    c4 = next(c for c in j["criteria"] if c["key"] == "04")
    assert c4["allowed_answers"] == [20, 15, 10, 5, 0, "na"] and c4["scale"]
    assert next(c for c in j["criteria"] if c["key"] == "08")["allowed_answers"] == ["yes", "no"]
    assert client.get("/api/gold/c-ru-001").status_code == 404  # не DEV
    assert client.get("/api/gold/nope").status_code == 404


def test_put_changed_total_and_persist(client, gold):
    body = {"criteria": {"01": {"answer": "no"}, "04": {"answer": "10"}}, "uncertain": ["03"], "notes": "н"}
    r = client.put("/api/gold/t-ru-001", json=body)
    assert r.status_code == 200, r.text
    it = r.json()
    assert it["changed"] == ["01", "04"] and it["uncertain"] == ["03"] and it["reviewed_at"] is None
    assert it["criteria"]["04"]["answer"] == 10 and it["criteria"]["02"]["answer"] == "na"  # недостающие — из черновика
    # 01 нет 0/10; 03 да 20/20; 04 ступень 10 из 20 -> 10/20; 05 да 15/15; 06 ступень 7 из 10 -> 10.5/15; 02, 07 N/A
    assert it["total"] == 69.38  # 55.5 / 80
    saved = json.loads((gold / "gold_labels.json").read_text(encoding="utf-8"))
    assert saved["checklist_version"] == "default-v1" and "t-ru-001" in saved["items"]
    assert not list(gold.glob(".gold_labels.*"))  # временные файлы убраны
    # возврат к ответу черновика снимает changed; reviewed фиксирует время
    it = client.put("/api/gold/t-ru-001", json={"criteria": {"01": {"answer": "yes"}}, "reviewed": True}).json()
    assert it["changed"] == ["04"] and it["reviewed_at"]
    it = client.put("/api/gold/t-ru-001", json={"notes": "x"}).json()  # автосохранение не сбрасывает reviewed
    assert it["reviewed_at"] and it["criteria"]["04"]["answer"] == 10
    assert client.get("/api/gold/t-ru-001").json()["label"]["notes"] == "x"
    row = next(r for r in client.get("/api/gold").json() if r["conversation_id"] == "t-ru-001")
    assert row["reviewed"] and row["changed"] == 1


def test_put_total_value(client, gold):
    it = client.put("/api/gold/t-en-001", json={"criteria": {}}).json()
    # черновик t-en-001: 01 нет, 02 да, 03 N/A, 04 20, 05 да, 06 10, 07 да; флаг 08 вне весов
    assert it["total"] == 87.5  # 70 / 80 (03 N/A)


def test_put_validation(client, gold):
    assert client.put("/api/gold/t-ru-001", json={"criteria": {"01": {"answer": "maybe"}}}).status_code == 422
    assert client.put("/api/gold/t-ru-001", json={"criteria": {"04": {"answer": 12}}}).status_code == 422
    assert client.put("/api/gold/t-ru-001", json={"criteria": {"08": {"answer": "na"}}}).status_code == 422
    assert client.put("/api/gold/t-ru-001", json={"criteria": {"99": {"answer": "yes"}}}).status_code == 422
    assert client.put("/api/gold/t-ru-001", json={"uncertain": ["99"]}).status_code == 422
    assert not (gold / "gold_labels.json").exists()


def test_put_dev_only(client, gold):
    assert client.put("/api/gold/c-ru-001", json={"criteria": {"01": {"answer": "yes"}}}).status_code == 404
    assert client.put("/api/gold/ghost", json={}).status_code == 404
