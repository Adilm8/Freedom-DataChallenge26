"""Прокси записи звонка: Range, типы, ошибки источника, подписанная ссылка не уходит наружу. Без сети."""
import json
import struct

import httpx
import pytest

from backend.app.api import audio

SECRET = "SIG-SECRET-123"
SRC = f"https://rec.test/flow/invoke?api-version=1&sp=read&sig={SECRET}"


def wav(n_samples: int = 4000) -> bytes:
    data = bytes((i * 7) % 256 for i in range(n_samples))
    fmt = struct.pack("<HHIIHH", 1, 1, 8000, 8000, 1, 8)
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(data)) + data


WAV = wav()


def dataset(audio_url=SRC):
    recs = [
        {"conversation_id": "t-call-a", "channel": "Voice Call", "language": "RU", "audio_url": audio_url,
         "transcript": [{"timestamp": "2026-01-01T10:00:00Z", "speaker": "operator", "text": "Алло"},
                        {"timestamp": "2026-01-01T10:00:05Z", "speaker": "client", "text": "Здравствуйте"}]},
        {"conversation_id": "t-chat-a", "channel": "Chat", "language": "RU", "audio_url": None,
         "transcript": [{"timestamp": "00:00", "speaker": "operator", "text": "Добрый день"}]},
    ]
    return {"isSuccess": True, "error": "", "data": {"dataset_group_id": "T", "total_records": 2, "records": recs}}


@pytest.fixture(autouse=True)
def _clean_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(audio.settings, "audio_dir", tmp_path / "audio")
    audio.cache.clear()
    audio._types.clear()
    yield
    audio.cache.clear()
    audio._types.clear()


def ids(client, audio_url=SRC):
    r = client.post("/api/datasets/upload", files={"file": ("d.json", json.dumps(dataset(audio_url)), "application/json")})
    assert r.status_code == 200
    rows = {x["conversation_id"]: x["id"] for x in client.get("/api/conversations?group_id=T").json()}
    return rows["t-call-a"], rows["t-chat-a"]


def use_upstream(monkeypatch, handler):
    """Подменяет клиента прокси на MockTransport; возвращает список увиденных запросов."""
    seen: list[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    monkeypatch.setattr(audio, "make_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(wrapped)))
    return seen


def ranged(req: httpx.Request) -> httpx.Response:
    """Источник с поддержкой Range."""
    rng = audio.parse_range(req.headers.get("range"), len(WAV))
    if rng is None:
        return httpx.Response(200, content=WAV, headers={"Content-Type": "audio/wav"})
    a, b = rng[0], len(WAV) - 1 if rng[1] is None else rng[1]
    return httpx.Response(206, content=WAV[a:b + 1], headers={"Content-Type": "audio/wav", "Content-Range": f"bytes {a}-{b}/{len(WAV)}"})


def no_ranges(req: httpx.Request) -> httpx.Response:
    """Источник без Range (как flow Power Platform): всегда весь файл, тип не указан."""
    return httpx.Response(200, content=WAV, headers={"Content-Type": "application/octet-stream"})


def assert_no_secret(r: httpx.Response):
    assert SECRET not in r.text
    assert "rec.test" not in r.text
    assert all(SECRET not in v and "rec.test" not in v for v in r.headers.values())


def test_detail_hides_signed_url(client):
    call, _ = ids(client)
    r = client.get(f"/api/conversations/{call}")
    assert r.json()["audio_url"] == f"/api/conversations/{call}/audio"
    assert_no_secret(r)


def test_404_without_recording(client):
    _, chat = ids(client)
    r = client.get(f"/api/conversations/{chat}/audio")
    assert r.status_code == 404 and "записи" in r.json()["detail"]
    assert client.get("/api/conversations/9999/audio").status_code == 404


def test_full_file_without_range(client, monkeypatch):
    call, _ = ids(client)
    seen = use_upstream(monkeypatch, ranged)
    r = client.get(f"/api/conversations/{call}/audio")
    assert r.status_code == 200 and r.content == WAV
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["content-length"] == str(len(WAV))
    assert r.headers["accept-ranges"] == "bytes"
    assert str(seen[0].url) == SRC and "range" not in seen[0].headers
    assert_no_secret(r)


def test_range_passthrough(client, monkeypatch):
    call, _ = ids(client)
    seen = use_upstream(monkeypatch, ranged)
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=100-199"})
    assert r.status_code == 206
    assert r.content == WAV[100:200]
    assert r.headers["content-range"] == f"bytes 100-199/{len(WAV)}"
    assert r.headers["content-length"] == "100"
    assert r.headers["accept-ranges"] == "bytes"
    assert seen[0].headers["range"] == "bytes=100-199"  # Range уходит источнику как есть
    assert_no_secret(r)


def test_range_when_source_ignores_it(client, monkeypatch):
    call, _ = ids(client)
    seen = use_upstream(monkeypatch, no_ranges)
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=1000-1099"})
    assert r.status_code == 206 and r.content == WAV[1000:1100]
    assert r.headers["content-range"] == f"bytes 1000-1099/{len(WAV)}"
    assert r.headers["content-type"] == "audio/wav"  # тип определён по сигнатуре RIFF/WAVE
    # Следующая перемотка — из памяти, без нового запроса к источнику.
    r2 = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=-10"})
    assert r2.status_code == 206 and r2.content == WAV[-10:]
    assert len(seen) == 1
    r3 = client.get(f"/api/conversations/{call}/audio", headers={"Range": f"bytes={len(WAV) + 5}-"})
    assert r3.status_code == 416 and r3.headers["content-range"] == f"bytes */{len(WAV)}"
    assert_no_secret(r)


def test_open_range_from_zero_streams_as_206(client, monkeypatch):
    call, _ = ids(client)
    seen = use_upstream(monkeypatch, no_ranges)
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=0-"})
    assert r.status_code == 206 and r.content == WAV
    assert r.headers["content-range"] == f"bytes 0-{len(WAV) - 1}/{len(WAV)}"
    assert r.headers["content-type"] == "audio/wav"
    # Поток целиком попал в кэш: кусок с середины без нового запроса.
    r2 = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=50-59"})
    assert r2.status_code == 206 and r2.content == WAV[50:60] and len(seen) == 1


def test_source_unreachable_is_502_without_url(client, monkeypatch, caplog):
    call, _ = ids(client)

    def down(req):
        raise httpx.ConnectError(f"connection refused to {req.url}", request=req)

    use_upstream(monkeypatch, down)
    with caplog.at_level("DEBUG"):
        r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=0-"})
    assert r.status_code == 502 and "недоступен" in r.json()["detail"]
    assert_no_secret(r)
    assert SECRET not in caplog.text and "rec.test" not in caplog.text


@pytest.mark.parametrize("code, word", [(403, "устареть"), (404, "404"), (500, "500")])
def test_source_error_is_502(client, monkeypatch, code, word):
    call, _ = ids(client)
    use_upstream(monkeypatch, lambda req: httpx.Response(code, text=f"error for {req.url}"))
    r = client.get(f"/api/conversations/{call}/audio")
    assert r.status_code == 502 and word in r.json()["detail"]
    assert_no_secret(r)


def test_parse_range():
    assert audio.parse_range("bytes=0-", 100) == (0, None)
    assert audio.parse_range("bytes=10-20", 100) == (10, 20)
    assert audio.parse_range("bytes=90-200", 100) == (90, 99)
    assert audio.parse_range("bytes=-10", 100) == (90, 99)
    assert audio.parse_range("bytes=5-1", 100) is None
    assert audio.parse_range("items=0-1", 100) is None
    assert audio.parse_range(None, 100) is None


def test_sniff():
    assert audio.sniff(WAV[:16]) == "audio/wav"
    assert audio.sniff(b"ID3\x04\x00") == "audio/mpeg"
    assert audio.sniff(b"\xff\xfb\x90\x00") == "audio/mpeg"
    assert audio.sniff(b"OggS\x00") == "audio/ogg"
    assert audio.sniff(b"hello") is None


PAGE = (
    '<!DOCTYPE html><html><body><audio id="a" controls>'
    '<source src="https://store.test/file/abc?sp=r&amp;sig=STORE-SIG&amp;rsct=audio%2Fmpeg" type="audio/mpeg">'
    '</audio></body></html>'
)


def test_html_player_page_is_resolved_and_saved_locally(client, monkeypatch):
    call, _ = ids(client)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "rec.test":
            return httpx.Response(200, text=PAGE, headers={"Content-Type": "text/html; charset=utf-8"})
        assert req.url.host == "store.test" and req.url.params["sig"] == "STORE-SIG"
        return httpx.Response(200, content=WAV, headers={"Content-Type": "application/octet-stream"})

    seen = use_upstream(monkeypatch, handler)
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=100-199"})
    assert r.status_code == 206
    assert r.content == WAV[100:200]
    assert r.headers["content-type"] == "audio/wav"
    assert "STORE-SIG" not in r.text and all("STORE-SIG" not in v for v in r.headers.values())
    assert_no_secret(r)
    assert [q.url.host for q in seen] == ["rec.test", "store.test"]
    saved = audio.settings.audio_dir / "t-call-a.wav"
    assert saved.read_bytes() == WAV

    # Ссылка истекла, сеть закрыта: запись берётся из локальной папки.
    audio.cache.clear()
    use_upstream(monkeypatch, lambda req: httpx.Response(403))
    r = client.get(f"/api/conversations/{call}/audio")
    assert r.status_code == 200 and r.content == WAV


def test_html_page_without_audio_link_is_502(client, monkeypatch):
    call, _ = ids(client)
    use_upstream(monkeypatch, lambda req: httpx.Response(200, text="<html>нет</html>", headers={"Content-Type": "text/html"}))
    r = client.get(f"/api/conversations/{call}/audio")
    assert r.status_code == 502
    assert_no_secret(r)


def test_local_file_served_with_range_without_network(client, monkeypatch):
    call, _ = ids(client)
    d = audio.settings.audio_dir
    d.mkdir(parents=True)
    (d / "t-call-a.wav").write_bytes(WAV)

    def boom(req):
        raise AssertionError("сеть не нужна")

    use_upstream(monkeypatch, boom)
    r = client.get(f"/api/conversations/{call}/audio", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.content == WAV[:10]
    assert r.headers["content-range"] == f"bytes 0-9/{len(WAV)}"
    assert r.headers["content-type"] == "audio/wav"


def test_extract_media_url():
    assert audio.extract_media_url(PAGE).startswith("https://store.test/file/abc?sp=r&sig=STORE-SIG")
    assert audio.extract_media_url('<audio src="http://plain.test/a.mp3">') is None
    assert audio.extract_media_url("") is None
