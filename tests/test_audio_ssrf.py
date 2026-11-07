"""Прокси записи не ходит во внутреннюю сеть (ссылка на запись приходит из данных, в т. ч. из загруженного файла)."""
import asyncio

import httpx
import pytest

from backend.app.api import audio


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/x", "http://localhost:8000/api/conversations", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/a", "http://[::1]/a", "file:///etc/passwd", "ftp://example.com/a",
])
def test_guard_blocks_internal(url):
    req = httpx.Request("GET", url)
    with pytest.raises(httpx.HTTPError):
        asyncio.run(audio.guard_request(req))


def test_guard_allows_public_ip():
    asyncio.run(audio.guard_request(httpx.Request("GET", "https://93.184.216.34/file.mp3")))


def test_client_has_guard_hook():
    c = audio.make_client()
    try:
        assert audio.guard_request in c.event_hooks["request"]
    finally:
        asyncio.run(c.aclose())
