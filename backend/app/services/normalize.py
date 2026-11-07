"""Нормализация записи набора в NormalizedConversation (FR-DATA-03…05).

- `msg_id = m<idx>` по исходному порядку; `timestamp`, `speaker`, `text` не меняются.
- `t_sec`: чат `MM:SS` / `H:MM:SS` → секунды; звонок ISO 8601 → секунды от первой реплики.
- Системные сообщения классифицируются по `data/config/system_events.json`.
- Сегменты звонка: удержание, консультация с коллегой, пауза записи. Реплики внутри удержания
  или консультации помечаются `internal` (клиент их не слышит).
- `audio_offset_sec`: секунда записи = время от начала записи минус паузы записи.
Неизвестные канал, язык и роль не ломают разбор, а дают предупреждение (FR-DATA-04).
"""

from __future__ import annotations

import re
from datetime import datetime

from ..domain import KNOWN_SPEAKERS, Message, NormalizedConversation, Segment, SystemEvent
from .config_files import load_config

KNOWN_CHANNELS = {"agent chat", "voice call"}
KNOWN_LANGUAGES = {"ru", "kz", "en"}

_CLOCK_RE = re.compile(r"^\s*(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?\s*$")
_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")

SEGMENT_EVENTS = {
    "hold": ("hold_start", "hold_end"),
    "consult": ("consult_start", "consult_end"),
    "recording_paused": ("recording_paused", "recording_resumed"),
}


def _norm_text(s: str) -> str:
    return _WS_RE.sub(" ", _PUNCT_RE.sub(" ", s.lower())).strip()


def classify_system_message(text: str) -> str | None:
    """Тип события по словарю; при нескольких совпадениях берём самую длинную фразу."""
    t = _norm_text(text)
    best: tuple[int, str] | None = None
    for event_type, phrases in load_config("system_events").items():
        for p in phrases:
            np = _norm_text(p)
            if np and np in t and (best is None or len(np) > best[0]):
                best = (len(np), event_type)
    return best[1] if best else None


def parse_clock(ts: str) -> float | None:
    m = _CLOCK_RE.match(ts or "")
    if not m:
        return None
    h, mm, ss = m.groups()
    return int(h or 0) * 3600 + int(mm) * 60 + int(ss)


def parse_iso(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat((ts or "").strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize(record: dict) -> NormalizedConversation:
    conv_id = str(record.get("conversation_id") or "").strip()
    if not conv_id:
        raise ValueError("у записи нет conversation_id")
    transcript = record.get("transcript")
    if not isinstance(transcript, list):
        raise ValueError(f"{conv_id}: transcript должен быть списком")

    channel = str(record.get("channel") or "").strip()
    language = str(record.get("language") or "").strip()
    warnings: list[str] = []
    if channel.lower() not in KNOWN_CHANNELS:
        warnings.append(f"неизвестный канал «{channel}»")
    if language.lower() not in KNOWN_LANGUAGES:
        warnings.append(f"неизвестный язык «{language}»")

    # --- время
    raw = [m if isinstance(m, dict) else {} for m in transcript]
    stamps = [str(m.get("timestamp") or "") for m in raw]
    t_secs: list[float | None] = []
    iso = [parse_iso(s) for s in stamps]
    if any(iso) and not any(parse_clock(s) is not None for s in stamps):
        base = next(d for d in iso if d)
        t_secs = [(d - base).total_seconds() if d else None for d in iso]
    else:
        t_secs = [parse_clock(s) for s in stamps]
    if any(t is None for t in t_secs):
        warnings.append(f"не удалось разобрать время у {sum(t is None for t in t_secs)} реплик")

    # --- реплики и события
    messages: list[Message] = []
    events: list[SystemEvent] = []
    unknown_speakers: set[str] = set()
    for i, m in enumerate(raw):
        speaker = str(m.get("speaker") or "").strip()
        text = str(m.get("text") or "")
        if speaker not in KNOWN_SPEAKERS:
            unknown_speakers.add(speaker)
        ev = classify_system_message(text) if speaker == "system" else None
        msg = Message(idx=i, msg_id=f"m{i}", speaker=speaker, text=text, timestamp=stamps[i], t_sec=t_secs[i], event=ev)
        messages.append(msg)
        if ev:
            events.append(SystemEvent(type=ev, idx=i, msg_id=msg.msg_id, t_sec=msg.t_sec, text=text))
    if unknown_speakers:
        warnings.append("неизвестные роли: " + ", ".join(sorted(unknown_speakers)) + " (считаются контекстом)")

    # --- сегменты (удержание, консультация, пауза записи)
    segments: list[Segment] = []
    for seg_type, (start_ev, end_ev) in SEGMENT_EVENTS.items():
        open_seg: Segment | None = None
        for e in events:
            if e.type == start_ev and open_seg is None:
                open_seg = Segment(type=seg_type, start_idx=e.idx, start_sec=e.t_sec)
            elif e.type == end_ev and open_seg is not None:
                open_seg.end_idx, open_seg.end_sec = e.idx, e.t_sec
                segments.append(open_seg)
                open_seg = None
        if open_seg is not None:
            segments.append(open_seg)
    segments.sort(key=lambda s: s.start_idx)

    last = len(messages) - 1
    for s in segments:
        if s.type in ("hold", "consult"):
            for msg in messages[s.start_idx + 1 : (s.end_idx if s.end_idx is not None else last + 1)]:
                if msg.speaker != "system":
                    msg.internal = True

    conv = NormalizedConversation(
        conversation_id=conv_id,
        channel=channel,
        language=language,
        audio_url=record.get("audio_url") or None,
        messages=messages,
        segments=segments,
        events=events,
        warnings=warnings,
    )
    if conv.is_voice:
        _audio_offsets(conv)
    return conv


def _audio_offsets(conv: NormalizedConversation) -> None:
    """Секунда записи для каждой реплики звонка: от начала записи, без пауз записи."""
    rec_start = next((e.t_sec for e in conv.events if e.type == "recording_started" and e.t_sec is not None), None)
    if rec_start is None:
        rec_start = next((m.t_sec for m in conv.messages if m.t_sec is not None), None)
    if rec_start is None:
        return
    end_of_call = max((m.t_sec for m in conv.messages if m.t_sec is not None), default=rec_start)
    pauses = [
        (s.start_sec, s.end_sec if s.end_sec is not None else end_of_call)
        for s in conv.segments
        if s.type == "recording_paused" and s.start_sec is not None
    ]
    for m in conv.messages:
        if m.t_sec is None or m.t_sec < rec_start:
            continue
        paused = 0.0
        for p_start, p_end in pauses:
            if p_start >= m.t_sec:
                continue
            paused += min(p_end, m.t_sec) - max(p_start, rec_start)
        m.audio_offset_sec = round(max(0.0, m.t_sec - rec_start - paused), 2)
