"""Общее для тестов этапа 4: временная БД, сценарный провайдер без сети, загрузка набора и оценка."""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend.app import db
from backend.app.main import app
from backend.app.models import ChecklistVersion, Conversation
from backend.app.providers.base import LLMResult, ProviderPolicyError
from backend.app.services import checklists, evaluations, evaluator

GROUP = "S4"

LONG_CHAT = [
    {"timestamp": "00:00", "speaker": "client", "text": "Как пополнить счёт?"},
    {"timestamp": "00:02", "speaker": "bot", "text": "Передаю вопрос специалисту."},
    {"timestamp": "00:05", "speaker": "system", "text": "Оператор подключился к чату"},
    {"timestamp": "00:20", "speaker": "operator", "text": "Добрый день, меня зовут Анна."},
    {"timestamp": "00:40", "speaker": "client", "text": "Хочу пополнить счёт картой."},
    {"timestamp": "01:00", "speaker": "operator", "text": "Откройте раздел «Пополнить» в приложении."},
    {"timestamp": "01:20", "speaker": "client", "text": "Нашёл, спасибо."},
    {"timestamp": "01:30", "speaker": "operator", "text": "Пожалуйста. Могу ещё чем-то помочь?"},
    {"timestamp": "01:40", "speaker": "client", "text": "Нет, всё."},
    {"timestamp": "01:45", "speaker": "operator", "text": "Хорошего дня!"},
]


def payload() -> dict:
    recs = [
        {"conversation_id": "s4-chat-1", "channel": "agent chat", "language": "RU", "audio_url": None,
         "transcript": LONG_CHAT},
        {"conversation_id": "s4-chat-2", "channel": "agent chat", "language": "KZ", "audio_url": None,
         "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "Сәлеметсіз бе"},
                        {"timestamp": "00:10", "speaker": "operator", "text": "Сәлеметсіз бе, менің атым Айгүл"}]},
        {"conversation_id": "s4-call-1", "channel": "voice call", "language": "RU", "audio_url": "https://x.test/a.mp3",
         "transcript": [{"timestamp": "2026-01-01T10:00:00Z", "speaker": "operator", "text": "Алло, Freedom Broker"},
                        {"timestamp": "2026-01-01T10:00:05Z", "speaker": "client", "text": "Здравствуйте"}]},
    ]
    return {"isSuccess": True, "error": "", "data": {"dataset_group_id": GROUP, "total_records": len(recs), "records": recs}}


class ScriptedProvider:
    """Отвечает по сценарию: `answers` — ответ по коду критерия (иначе «yes» или максимальная ступень),
    `confidence`, `evidence` — по коду, `omit` — критерии без ответа (оценка будет partial)."""

    name = "fake"

    def __init__(self, answers=None, confidence=None, evidence=None, omit=(), topic="Пополнение счёта",
                 resolved="yes"):
        self.answers = {"08": "no", **(answers or {})}
        self.confidence = confidence or {}
        self.evidence = evidence or {}
        self.omit = set(omit)
        self.topic, self.resolved = topic, resolved

    def complete(self, messages, *, json_schema=None, **kw):
        res = {}
        for key, spec in json_schema["properties"]["results"]["properties"].items():
            if key in self.omit:
                continue
            enum = spec["properties"]["answer"]["enum"]
            ans = self.answers.get(key) or ("yes" if "yes" in enum else max((e for e in enum if e.isdigit()), key=int))
            res[key] = {"reasoning": f"обоснование {key}", "answer": ans, "confidence": self.confidence.get(key, "high"),
                        "evidence": self.evidence.get(key, []), "checked_range": None,
                        "na_reason": "нет повода" if ans == "na" else None, "advice": None}
        out = {"results": res}
        if "overview" in json_schema["properties"]:
            out["overview"] = {"summary": "s", "topic": self.topic, "resolved": self.resolved}
        return LLMResult(text=json.dumps(out, ensure_ascii=False), parsed=out, finish_reason="stop", provider="fake",
                         model="fake/m", tokens_in=100, tokens_out=10, cost_usd=0.001, latency_ms=5)


class BrokenProvider:
    name = "broken"

    def complete(self, messages, **kw):
        raise ProviderPolicyError("провайдер недоступен")


@dataclass
class Env:
    client: TestClient
    engine: object
    state: dict = field(default_factory=dict)

    def load(self) -> dict[str, int]:
        r = self.client.post("/api/datasets/upload", files={"file": ("d.json", json.dumps(payload()), "application/json")})
        assert r.status_code == 200, r.text
        with Session(self.engine) as s:
            return {c.conversation_id: c.id for c in s.exec(select(Conversation).where(Conversation.group_id == GROUP))}

    def version_id(self) -> int:
        with Session(self.engine) as s:
            return s.exec(select(ChecklistVersion).where(ChecklistVersion.is_active == True)).first().id  # noqa: E712

    def evaluate(self, pk: int, provider=None, booleans: dict | None = None) -> int:
        self.state["provider"] = provider or ScriptedProvider()
        self.state["booleans"] = booleans or {}
        with Session(self.engine) as s:
            return evaluations.evaluate_one(s, pk, self.version_id(), provider_name="openrouter", model="fake/m",
                                            strategy="grouped")


@pytest.fixture()
def s4(tmp_path, monkeypatch):
    eng = db.make_engine(f"sqlite:///{tmp_path / 's4.db'}")
    db.init_db(eng)
    with Session(eng) as s:
        checklists.seed_default(s)
    monkeypatch.setattr(db, "engine", eng)

    def _session():
        with Session(eng) as s:
            yield s

    env = Env(TestClient(app), eng)
    app.dependency_overrides[db.get_session] = _session
    monkeypatch.setattr(evaluator, "_facts", lambda conv, cl: ({}, "нет", env.state.get("booleans", {})))
    monkeypatch.setattr(evaluations, "get_provider", lambda name=None: env.state["provider"])
    yield env
    app.dependency_overrides.clear()
    eng.dispose()
