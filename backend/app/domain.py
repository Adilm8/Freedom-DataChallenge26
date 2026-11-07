"""Доменные типы ядра: диалог после нормализации, чек-лист, результат расчёта.

Чистые pydantic-модели без БД и HTTP. Их используют normalize, facts, prompt_builder,
validator, scoring и API. Формат чек-листа — docs/CONTRACTS.md §1.
"""

from __future__ import annotations

import re
from typing import Literal, Union

from pydantic import BaseModel, Field, field_validator, model_validator

# Ответ по критерию: "yes" | "no" | "na" или ступень шкалы (int).
Answer = Union[str, int]

KNOWN_SPEAKERS = {"client", "operator", "bot", "system"}
VOICE_CHANNELS = {"voice call"}


# --------------------------------------------------------------------------- диалог


class Message(BaseModel):
    idx: int
    msg_id: str                      # m<idx>, стабилен для ссылок
    speaker: str                     # как в исходных данных
    text: str
    timestamp: str                   # исходное значение без изменений (FR-DATA-03)
    t_sec: float | None = None       # секунды от начала диалога
    audio_offset_sec: float | None = None  # секунда записи звонка (с вычетом пауз записи)
    internal: bool = False           # реплика во время удержания или консультации: клиент её не слышит
    event: str | None = None         # тип системного события, если это system-сообщение


class Segment(BaseModel):
    type: Literal["hold", "consult", "recording_paused"]
    start_idx: int
    end_idx: int | None = None       # None — не закрыт до конца диалога
    start_sec: float | None = None
    end_sec: float | None = None


class SystemEvent(BaseModel):
    type: str
    idx: int
    msg_id: str
    t_sec: float | None = None
    text: str


class NormalizedConversation(BaseModel):
    conversation_id: str
    channel: str
    language: str                    # как в данных: RU / KZ / EN
    audio_url: str | None = None
    messages: list[Message]
    segments: list[Segment] = Field(default_factory=list)
    events: list[SystemEvent] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @property
    def is_voice(self) -> bool:
        return self.channel.strip().lower() in VOICE_CHANNELS

    @property
    def lang(self) -> str:
        return self.language.strip().lower()

    def message(self, msg_id: str) -> Message | None:
        if not msg_id.startswith("m") or not msg_id[1:].isdigit():
            return None
        i = int(msg_id[1:])
        return self.messages[i] if 0 <= i < len(self.messages) else None


# --------------------------------------------------------------------------- чек-лист

_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class ScaleStep(BaseModel):
    value: int
    label: str


class Guard(BaseModel):
    when: list[str]                  # булевы факты, «!» — отрицание
    expect: list[str]                # допустимые ответы
    action: Literal["flag", "override"] = "flag"
    set: str | None = None           # ответ для override

    @model_validator(mode="after")
    def _override_needs_set(self) -> "Guard":
        if self.action == "override" and not self.set:
            raise ValueError("guard с action=override требует поле set")
        return self


class Criterion(BaseModel):
    key: str
    title: str
    section: str
    type: Literal["binary", "scale", "flag"]
    weight: float = 0
    na_allowed: bool = False
    na_when: str | None = None
    definition: str
    yes_when: str | None = None
    no_when: str | None = None
    scale: list[ScaleStep] | None = None
    guidance: str | None = None
    voice_guidance: str | None = None  # подсказка только для звонков: адаптация критерия к устной речи
    group: str | None = None
    context_refs: list[str] = Field(default_factory=list)
    guards: list[Guard] = Field(default_factory=list)
    enabled: bool = True
    export_id: str | None = None     # код в results.json организаторов (contact, discovery, …)

    @field_validator("key")
    @classmethod
    def _key_format(cls, v: str) -> str:
        if not _KEY_RE.match(v):
            raise ValueError("код критерия: только латиница, цифры, «_» и «-»")
        return v

    @field_validator("weight")
    @classmethod
    def _weight_non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("вес не может быть отрицательным")
        return v

    @model_validator(mode="after")
    def _type_rules(self) -> "Criterion":
        if self.type == "scale":
            steps = self.scale or []
            if len(steps) < 2:
                raise ValueError(f"критерий {self.key}: у шкалы должно быть не меньше 2 ступеней")
            values = [s.value for s in steps]
            if len(set(values)) != len(values):
                raise ValueError(f"критерий {self.key}: ступени шкалы повторяются")
            if max(values) <= 0:
                raise ValueError(f"критерий {self.key}: максимальная ступень шкалы должна быть больше 0")
            if min(values) < 0:
                raise ValueError(f"критерий {self.key}: ступени шкалы не могут быть отрицательными")
        if self.na_allowed and not (self.na_when or "").strip():
            raise ValueError(f"критерий {self.key}: для N/A нужно условие (na_when)")
        return self

    @property
    def max_step(self) -> int | None:
        return max(s.value for s in self.scale) if self.type == "scale" and self.scale else None

    def allowed_answers(self) -> list[Answer]:
        """Ответы, которые допускает критерий (в БД и API: "yes" / "no" / "na" / int)."""
        if self.type == "scale":
            out: list[Answer] = sorted((s.value for s in self.scale or []), reverse=True)
        else:
            out = ["yes", "no"]
        if self.na_allowed and self.type != "flag":
            out.append("na")
        return out

    def coerce_answer(self, raw: Answer) -> Answer:
        """Приводит ответ модели или UI к каноническому виду; ValueError, если ответ не разрешён."""
        if isinstance(raw, str):
            s = raw.strip().lower()
            if s in {"n/a", "н/д"}:
                s = "na"
            if self.type == "scale" and s.lstrip("-").isdigit():
                raw = int(s)
            else:
                raw = s
        if isinstance(raw, bool):  # bool — подкласс int, отсекаем явно
            raise ValueError(f"критерий {self.key}: недопустимый ответ {raw!r}")
        if raw not in self.allowed_answers():
            raise ValueError(f"критерий {self.key}: ответ {raw!r} не из разрешённых {self.allowed_answers()}")
        return raw


class Section(BaseModel):
    id: str
    title: str


class ChecklistSettings(BaseModel):
    output_language: str = "ru"
    rounding: int = 2
    critical_policy: Literal["flag", "zero_total"] = "flag"
    first_response_threshold_sec: int = 180
    long_gap_threshold_sec: int = 120
    advice: bool = True
    overview: bool = True
    quote_threshold: dict[str, float] = Field(default_factory=lambda: {"chat": 0.85, "voice": 0.75})


class Checklist(BaseModel):
    key: str
    name: str
    settings: ChecklistSettings = Field(default_factory=ChecklistSettings)
    sections: list[Section]
    criteria: list[Criterion]

    @model_validator(mode="after")
    def _consistency(self) -> "Checklist":
        keys = [c.key for c in self.criteria]
        dup = sorted({k for k in keys if keys.count(k) > 1})
        if dup:
            raise ValueError(f"коды критериев повторяются: {', '.join(dup)}")
        section_ids = {s.id for s in self.sections}
        if len(section_ids) != len(self.sections):
            raise ValueError("id секций повторяются")
        for c in self.criteria:
            if c.section not in section_ids:
                raise ValueError(f"критерий {c.key}: секции «{c.section}» нет в чек-листе")
        if not any(c.enabled for c in self.criteria):
            raise ValueError("в чек-листе нет ни одного включённого критерия")
        return self

    def enabled_criteria(self) -> list[Criterion]:
        return [c for c in self.criteria if c.enabled]

    def criterion(self, key: str) -> Criterion | None:
        return next((c for c in self.criteria if c.key == key), None)

    def warnings(self) -> list[str]:
        """Не ошибки, а предупреждения редактору (FR-CHK-05)."""
        out = []
        total = sum(c.weight for c in self.enabled_criteria() if c.type != "flag")
        if abs(total - 100) > 1e-9:
            out.append(f"сумма весов {total:g}, а не 100: итог всё равно нормируется к 100")
        return out


# --------------------------------------------------------------------------- расчёт


class CriterionScore(BaseModel):
    answer: Answer | None
    applicable: bool                 # входит ли вес в применимый
    points: float | None             # None для N/A, флага и пропущенного ответа
    weight: float
    contribution: float | None = None  # доля итога, п.п. (points / applicable_weight × 100)


class SectionScore(BaseModel):
    id: str
    title: str
    points: float
    applicable_weight: float
    pct: float | None


class ScoreResult(BaseModel):
    total: float | None
    applicable_weight: float
    points_sum: float
    sections: list[SectionScore]
    criteria: dict[str, CriterionScore]
    critical: list[str]              # ключи флагов с ответом «yes»
    missing: list[str] = Field(default_factory=list)  # включённые критерии без ответа
    critical_policy: str = "flag"
