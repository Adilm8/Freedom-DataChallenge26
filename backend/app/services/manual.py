"""Новый диалог из интерфейса (FR-DATA-07): JSON в формате API организаторов или текст «роль: текст».

Текст: одна реплика — строка `роль: текст`, в начале можно указать время `[MM:SS]` или `MM:SS`.
Роли: client / operator / bot / system, по-русски клиент / оператор / бот / система, коротко К / О.
Строка без роли продолжает предыдущую реплику. Дальше запись идёт через тот же `normalize`, что и импорт.
"""
from __future__ import annotations

import json
import re
from typing import Any

from sqlmodel import Session, select

from ..models import Conversation, utcnow
from .normalize import normalize

DEFAULT_GROUP = "MANUAL"
MAX_MESSAGES = 1000
MAX_CHARS = 300_000

ROLE_ALIASES = {
    "client": "client", "клиент": "client", "customer": "client", "user": "client", "пользователь": "client",
    "к": "client", "k": "client",  # кириллица и латиница выглядят одинаково
    "operator": "operator", "оператор": "operator", "agent": "operator", "агент": "operator",
    "менеджер": "operator", "специалист": "operator", "о": "operator", "o": "operator",
    "bot": "bot", "бот": "bot",
    "system": "system", "система": "system", "системное": "system",
}
CHANNEL_ALIASES = {
    "agent chat": "agent chat", "chat": "agent chat", "чат": "agent chat",
    "voice call": "voice call", "call": "voice call", "voice": "voice call", "звонок": "voice call",
}
LANGUAGE_ALIASES = {"ru": "RU", "рус": "RU", "kz": "KZ", "kk": "KZ", "каз": "KZ", "қаз": "KZ", "en": "EN", "eng": "EN"}

_LINE_RE = re.compile(
    r"^\s*(?:\[?(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*)?(?P<role>[^\s:：\[\]]{1,24})\s*[:：]\s?(?P<text>.*)$")


class ManualInvalid(Exception):
    def __init__(self, errors: list[dict], detail: str = "диалог не прошёл проверку"):
        super().__init__(detail)
        self.detail = detail
        self.errors = errors


class ManualConflict(Exception):
    pass


def _role(raw: Any) -> str | None:
    return ROLE_ALIASES.get(str(raw or "").strip().lower().rstrip("."))


def parse_text(text: str) -> tuple[list[dict], list[dict], list[str]]:
    """(реплики, ошибки, предупреждения)."""
    msgs: list[dict] = []
    errors: list[dict] = []
    warnings: list[str] = []
    for n, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        m = _LINE_RE.match(line)
        role = _role(m.group("role")) if m else None
        if role:
            body = m.group("text").strip()
            if not body:
                warnings.append(f"строка {n}: пустая реплика пропущена")
                continue
            msgs.append({"timestamp": m.group("ts") or "", "speaker": role, "text": body})
        elif msgs:
            if m and not m.group("ts") and len(m.group("role")) <= 12:
                warnings.append(f"строка {n}: «{m.group('role')}» — не роль, строка добавлена к предыдущей реплике")
            msgs[-1]["text"] += "\n" + line.strip()
        else:
            errors.append({"path": "transcript", "message": (
                f"строка {n}: не указана роль — нужно «роль: текст», роли client, operator, bot, system "
                "(или клиент, оператор, бот, система, К, О)")})
    if msgs and not any(m["timestamp"] for m in msgs):
        warnings.append("в тексте нет времени реплик: задержки ответа и паузы не оцениваются")
    return msgs, errors, warnings


def parse_array(items: list) -> tuple[list[dict], list[dict]]:
    msgs: list[dict] = []
    errors: list[dict] = []
    for i, m in enumerate(items):
        if not isinstance(m, dict):
            errors.append({"path": f"transcript.{i}", "message": "реплика — объект {timestamp, speaker, text}"})
            continue
        role = _role(m.get("speaker"))
        if not role:
            errors.append({"path": f"transcript.{i}.speaker",
                           "message": f"неизвестная роль «{m.get('speaker')}»: client, operator, bot или system"})
        text = m.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append({"path": f"transcript.{i}.text", "message": "пустой текст реплики"})
        ts = m.get("timestamp")
        if role and isinstance(text, str) and text.strip():
            msgs.append({"timestamp": "" if ts is None else str(ts), "speaker": role, "text": text})
    return msgs, errors


def _unwrap(transcript: Any, body: dict) -> tuple[Any, dict]:
    """Текст, похожий на JSON, разбираем: массив реплик, запись `{transcript, ...}` или набор с одной записью."""
    if not isinstance(transcript, str) or transcript.lstrip()[:1] not in ("[", "{"):
        return transcript, body
    try:
        data = json.loads(transcript)
    except ValueError:
        return transcript, body  # обычный текст, который начинается со скобки
    if isinstance(data, dict):
        inner = data["data"] if isinstance(data.get("data"), dict) else data
        recs = inner.get("records")
        if isinstance(recs, list):
            if len(recs) != 1:
                raise ManualInvalid([{"path": "transcript", "message":
                                      f"в наборе {len(recs)} записей: вставьте одну или загрузите файл набора"}])
            data = recs[0]
        if isinstance(data, dict) and "transcript" in data:
            meta = {k: data.get(k) for k in ("conversation_id", "channel", "language", "audio_url") if data.get(k)}
            return data["transcript"], {**meta, **{k: v for k, v in body.items() if v not in (None, "")}}
    return data, body


def _channel(raw: str | None) -> str:
    s = " ".join(str(raw or "").split()).lower()
    return CHANNEL_ALIASES.get(s, s) if s else "agent chat"


def _language(raw: str | None, msgs: list[dict]) -> tuple[str, str | None]:
    s = str(raw or "").strip()
    if s:
        return LANGUAGE_ALIASES.get(s.lower(), s.upper()), None
    from .facts.language import detect_language

    client = " ".join(m["text"] for m in msgs if m["speaker"] == "client") or " ".join(m["text"] for m in msgs)
    found = detect_language(client)
    if found in ("ru", "kz", "en"):
        return found.upper(), f"язык не указан, определён по репликам клиента: {found.upper()}"
    return "RU", "язык не указан и не определился по тексту: взят RU"


def _next_id(session: Session, group: str) -> str:
    taken = set(session.exec(select(Conversation.conversation_id).where(Conversation.group_id == group)))
    n = sum(1 for t in taken if t.startswith("manual-")) + 1
    while f"manual-{n:03d}" in taken:
        n += 1
    return f"manual-{n:03d}"


def create(session: Session, body: dict) -> Conversation:
    """`body`: {group_id?, conversation_id?, channel?, language?, audio_url?, transcript: [] | str}."""
    transcript, body = _unwrap(body.get("transcript"), body)
    warnings: list[str] = []
    if isinstance(transcript, str):
        if len(transcript) > MAX_CHARS:
            raise ManualInvalid([{"path": "transcript", "message": f"текст длиннее {MAX_CHARS} символов"}])
        msgs, errors, warnings = parse_text(transcript)
    elif isinstance(transcript, list):
        msgs, errors = parse_array(transcript)
    else:
        raise ManualInvalid([{"path": "transcript", "message": "транскрипт — массив реплик или текст «роль: текст»"}])
    if not errors and not msgs:
        errors.append({"path": "transcript", "message": "в диалоге нет ни одной реплики"})
    if len(msgs) > MAX_MESSAGES:
        errors.append({"path": "transcript", "message": f"больше {MAX_MESSAGES} реплик"})
    if errors:
        raise ManualInvalid(errors)
    if not any(m["speaker"] == "operator" for m in msgs):
        warnings.append("нет ни одной реплики оператора: оценивать будет нечего")

    group = str(body.get("group_id") or "").strip() or DEFAULT_GROUP
    cid = str(body.get("conversation_id") or "").strip()
    if cid and session.exec(select(Conversation.id).where(
            Conversation.group_id == group, Conversation.conversation_id == cid)).first():
        raise ManualConflict(f"в группе {group} уже есть диалог {cid}")
    cid = cid or _next_id(session, group)
    language, lang_note = _language(body.get("language"), msgs)
    if lang_note:
        warnings.append(lang_note)
    record = {"conversation_id": cid, "channel": _channel(body.get("channel")), "language": language,
              "audio_url": body.get("audio_url") or None, "transcript": msgs}
    norm = normalize(record)
    norm.warnings.extend(warnings)
    row = Conversation(group_id=group, conversation_id=cid, channel=norm.channel, language=norm.language,
                       audio_url=record["audio_url"], source="manual", transcript=msgs,
                       normalized=norm.model_dump(), imported_at=utcnow())
    session.add(row)
    session.commit()
    session.refresh(row)
    return row
