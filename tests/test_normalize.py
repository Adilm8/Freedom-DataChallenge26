"""Нормализация диалогов (FR-DATA-03…05). Примеры выдуманные; DEV проверяется, только если снапшот есть."""

import json
from pathlib import Path

import pytest

from backend.app.services.normalize import classify_system_message, normalize, parse_clock

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "data/raw/DEV.json"

CHAT = {
    "conversation_id": "s-ru-001",
    "channel": "agent chat",
    "language": "RU",
    "audio_url": None,
    "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Не могу найти выписку."},
        {"timestamp": "00:02", "speaker": "bot", "text": "Здравствуйте! Я виртуальный помощник."},
        {"timestamp": "00:40", "speaker": "system", "text": "Эскалация на оператора."},
        {"timestamp": "01:15", "speaker": "operator", "text": "Здравствуйте! Меня зовут Алина."},
        {"timestamp": "1:02:03", "speaker": "system", "text": "Оператор закрыл чат."},
    ],
}

CALL = {
    "conversation_id": "s-call-001",
    "channel": "voice call",
    "language": "RU",
    "audio_url": "https://example.invalid/rec.wav",
    "transcript": [
        {"timestamp": "2026-11-01T10:00:00.0000000+00:00", "speaker": "system", "text": "Запись и транскрибирование запущены."},
        {"timestamp": "2026-11-01T10:00:10.0000000+00:00", "speaker": "bot", "text": "Добро пожаловать."},
        {"timestamp": "2026-11-01T10:00:20.0000000+00:00", "speaker": "system", "text": "Запись и транскрибирование приостановлены."},
        {"timestamp": "2026-11-01T10:00:50.0000000+00:00", "speaker": "system", "text": "Запись и транскрибирование возобновлены."},
        {"timestamp": "2026-11-01T10:01:00.0000000+00:00", "speaker": "operator", "text": "Добрый день, меня зовут [Имя скрыто]."},
        {"timestamp": "2026-11-01T10:01:10.0000000+00:00", "speaker": "system", "text": "Клиент находится на удержании."},
        {"timestamp": "2026-11-01T10:01:12.0000000+00:00", "speaker": "system", "text": "Началась консультация с агентом."},
        {"timestamp": "2026-11-01T10:01:20.0000000+00:00", "speaker": "operator", "text": "Коллега, подскажи по комиссии."},
        {"timestamp": "2026-11-01T10:01:40.0000000+00:00", "speaker": "system", "text": "Агент вышел из разговора."},
        {"timestamp": "2026-11-01T10:01:50.0000000+00:00", "speaker": "system", "text": "Клиент больше не находится на удержании."},
        {"timestamp": "2026-11-01T10:02:00.0000000+00:00", "speaker": "operator", "text": "Спасибо за ожидание."},
        {"timestamp": "2026-11-01T10:02:30.5000000+00:00", "speaker": "system", "text": "Клиент завершил разговор."},
    ],
}


def test_msg_ids_and_original_fields_kept():
    conv = normalize(CHAT)
    assert [m.msg_id for m in conv.messages] == ["m0", "m1", "m2", "m3", "m4"]
    for src, m in zip(CHAT["transcript"], conv.messages):
        assert (m.timestamp, m.speaker, m.text) == (src["timestamp"], src["speaker"], src["text"])


def test_chat_clock_to_seconds():
    conv = normalize(CHAT)
    assert [m.t_sec for m in conv.messages] == [0, 2, 40, 75, 3723]
    assert parse_clock("12:05") == 725 and parse_clock("abc") is None


def test_system_events_classified():
    conv = normalize(CHAT)
    assert [(e.type, e.msg_id) for e in conv.events] == [("escalation", "m2"), ("operator_closed", "m4")]
    assert classify_system_message("Customer identity verified.") == "identity_verified"
    assert classify_system_message("Клиент больше не находится на удержании.") == "hold_end"
    assert classify_system_message("Клиент находится на удержании.") == "hold_start"
    assert classify_system_message("Что-то совсем новое") is None


def test_call_iso_time_segments_and_internal():
    conv = normalize(CALL)
    assert conv.is_voice
    assert conv.messages[0].t_sec == 0 and conv.messages[-1].t_sec == 150.5
    kinds = [(s.type, s.start_idx, s.end_idx) for s in conv.segments]
    assert kinds == [("recording_paused", 2, 3), ("hold", 5, 9), ("consult", 6, 8)]
    assert conv.messages[7].internal is True          # разговор с коллегой на удержании
    assert conv.messages[4].internal is False
    assert conv.messages[10].internal is False


def test_call_audio_offset_skips_recording_pause():
    conv = normalize(CALL)
    # запись с 0 с; пауза 20–50 с (30 с) → реплика в 60 с звучит на 30-й секунде записи
    assert conv.messages[1].audio_offset_sec == 10
    assert conv.messages[4].audio_offset_sec == 30
    assert conv.messages[10].audio_offset_sec == 90


def test_unknown_values_do_not_break():
    rec = {
        "conversation_id": "x-1", "channel": "messenger", "language": "DE",
        "transcript": [{"timestamp": "??", "speaker": "supervisor", "text": "hi"}],
    }
    conv = normalize(rec)
    assert conv.messages[0].t_sec is None
    assert len(conv.warnings) == 4


def test_missing_id_or_transcript_rejected():
    with pytest.raises(ValueError):
        normalize({"transcript": []})
    with pytest.raises(ValueError):
        normalize({"conversation_id": "a", "transcript": "oops"})


@pytest.mark.skipif(not DEV.exists(), reason="нет снапшота DEV")
def test_dev_snapshot_normalizes_cleanly():
    records = json.loads(DEV.read_text(encoding="utf-8"))["data"]["records"]
    for rec in records:
        conv = normalize(rec)
        assert not conv.warnings, (conv.conversation_id, conv.warnings)
        unknown = [m.text for m in conv.messages if m.speaker == "system" and m.event is None]
        assert not unknown, (conv.conversation_id, unknown)
        if conv.is_voice:
            assert any(m.audio_offset_sec is not None for m in conv.messages)
