"""Таблицы БД (docs/architecture/data-model.md)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column, Text, UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def J(default: Any = None) -> Any:
    """JSON-колонка."""
    return Field(default=default, sa_column=Column(JSON))


class DatasetImport(SQLModel, table=True):
    __tablename__ = "dataset_import"
    id: Optional[int] = Field(default=None, primary_key=True)
    group_id: str = Field(index=True)
    source: str = "api"
    imported: int = 0
    updated: int = 0
    warnings: list = J([])
    created_at: datetime = Field(default_factory=utcnow)


class Conversation(SQLModel, table=True):
    __tablename__ = "conversation"
    __table_args__ = (UniqueConstraint("group_id", "conversation_id", name="uq_conv_group_cid"),)
    id: Optional[int] = Field(default=None, primary_key=True)
    import_id: Optional[int] = Field(default=None, foreign_key="dataset_import.id")
    group_id: str = Field(index=True)
    conversation_id: str = Field(index=True)
    channel: str = ""
    language: str = ""
    audio_url: Optional[str] = None
    source: str = "api"  # api / upload / manual
    transcript: list = J([])
    normalized: dict = J({})
    audio_offset_fix_sec: float = 0.0
    imported_at: datetime = Field(default_factory=utcnow)


class ChecklistVersion(SQLModel, table=True):
    __tablename__ = "checklist_version"
    id: Optional[int] = Field(default=None, primary_key=True)
    checklist_key: str = Field(default="default", index=True)
    version: int = 1
    name: str = ""
    note: str = ""
    body: dict = J({})
    body_hash: str = ""
    is_active: bool = False
    parent_id: Optional[int] = Field(default=None, foreign_key="checklist_version.id")
    created_at: datetime = Field(default_factory=utcnow)


class EvaluationRun(SQLModel, table=True):
    __tablename__ = "evaluation_run"
    id: Optional[int] = Field(default=None, primary_key=True)
    group_id: str = ""
    checklist_version_id: Optional[int] = Field(default=None, foreign_key="checklist_version.id")
    provider: str = ""
    model: str = ""
    strategy: str = ""
    prompt_version: str = ""
    status: str = "queued"  # queued / running / done / failed / partial
    total: int = 0
    done: int = 0
    failed: int = 0
    cost_usd: float = 0.0
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class Evaluation(SQLModel, table=True):
    __tablename__ = "evaluation"
    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_pk: int = Field(foreign_key="conversation.id", index=True)
    checklist_version_id: int = Field(foreign_key="checklist_version.id", index=True)
    run_id: Optional[int] = Field(default=None, foreign_key="evaluation_run.id")
    provider: str = ""
    model: str = ""
    strategy: str = ""
    prompt_version: str = ""
    status: str = "done"  # done / partial / failed
    facts: dict = J({})
    overview: Optional[dict] = J(None)
    params: dict = J({})
    ai_score: dict = J({})
    final_score: dict = J({})
    ai_total: Optional[float] = None
    final_total: Optional[float] = None
    critical: bool = False
    needs_review: bool = False
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    created_at: datetime = Field(default_factory=utcnow)


class CriterionResult(SQLModel, table=True):
    __tablename__ = "criterion_result"
    id: Optional[int] = Field(default=None, primary_key=True)
    evaluation_id: int = Field(foreign_key="evaluation.id", index=True)
    criterion_key: str
    ai_answer: str = ""
    ai_points: Optional[float] = None
    reasoning: Optional[str] = Field(default=None, sa_column=Column(Text))
    na_reason: Optional[str] = None
    evidence: list = J([])
    checked_range: Optional[dict] = J(None)
    issues: list = J([])
    confidence: str = "medium"
    advice: Optional[str] = None
    criterion_hash: str = ""
    reused_from_evaluation_id: Optional[int] = None
    final_answer: Optional[str] = None
    final_points: Optional[float] = None
    overridden: bool = False


class LLMCall(SQLModel, table=True):
    __tablename__ = "llm_call"
    id: Optional[int] = Field(default=None, primary_key=True)
    evaluation_id: int = Field(foreign_key="evaluation.id", index=True)
    criteria_keys: list = J([])
    attempt: int = 1
    provider: str = ""
    model: str = ""
    request: dict = J({})
    response_raw: str = Field(default="", sa_column=Column(Text))
    finish_reason: Optional[str] = None
    error: Optional[str] = None
    tokens_in: int = 0
    tokens_out: int = 0
    cached_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    created_at: datetime = Field(default_factory=utcnow)


class Appeal(SQLModel, table=True):
    __tablename__ = "appeal"
    id: Optional[int] = Field(default=None, primary_key=True)
    evaluation_id: int = Field(foreign_key="evaluation.id", index=True)
    criterion_key: str
    comment: str = ""
    status: str = "open"  # open / confirmed / changed
    ai_answer_snapshot: str = ""
    decision_answer: Optional[str] = None
    decision_reason: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    decided_at: Optional[datetime] = None


class CriterionTrial(SQLModel, table=True):
    """Проверка критерия на диалогах до сохранения версии («песочница», services/trial.py).
    Оценки диалогов не меняет; вызовы модели сохраняются здесь целиком, как у обычной оценки."""
    __tablename__ = "criterion_trial"
    id: Optional[int] = Field(default=None, primary_key=True)
    conversation_pk: int = Field(foreign_key="conversation.id", index=True)
    base_version_id: Optional[int] = None
    criterion: dict = J({})
    provider: str = ""
    model: str = ""
    result: dict = J({})
    calls: list = J([])
    cost_usd: float = 0.0
    created_at: datetime = Field(default_factory=utcnow)
