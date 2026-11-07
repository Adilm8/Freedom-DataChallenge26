"""Прокси записи звонка: GET /api/conversations/{id}/audio (FR-CARD-04).

Подписанная ссылка на запись (`Conversation.audio_url`, с `sig`) — секрет: в браузер, в ответы и в логи
она не попадает. Браузер получает запись только через этот прокси.

Перемотка в `<audio>` требует ответов на `Range`. Если источник сам умеет `Range` (206), ответ
передаётся потоком как есть. Если источник `Range` игнорирует (200 на весь файл), прокси:
- на запрос без `Range` или с `bytes=0-` отдаёт поток сразу и попутно кладёт файл в память;
- на запрос с другого места скачивает файл целиком и отдаёт нужный кусок (206).
Кэш в памяти небольшой (LRU), на диск записи не пишутся.
"""
from __future__ import annotations

import logging
import re
from collections import OrderedDict

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from sqlmodel import Session

from ..db import get_session
from ..models import Conversation

router = APIRouter(prefix="/conversations", tags=["audio"])
log = logging.getLogger(__name__)
# httpx на уровне INFO пишет полный URL запроса, а в нём подпись: держим его логгер на WARNING.
logging.getLogger("httpx").setLevel(logging.WARNING)

MAX_CACHE_ITEM = 80 * 1024 * 1024
MAX_CACHE_TOTAL = 240 * 1024 * 1024
CACHE_CONTROL = "private, max-age=600"
_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$", re.I)


def make_client() -> httpx.AsyncClient:
    """Клиент к источнику записи. Тесты подменяют эту функцию (httpx.MockTransport)."""
    return httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True)


class _Cache:
    """LRU в памяти: ключ — (id диалога, исходная ссылка), значение — (байты, Content-Type)."""

    def __init__(self) -> None:
        self.items: OrderedDict[tuple[int, str], tuple[bytes, str]] = OrderedDict()

    def get(self, key: tuple[int, str]) -> tuple[bytes, str] | None:
        if key in self.items:
            self.items.move_to_end(key)
            return self.items[key]
        return None

    def put(self, key: tuple[int, str], data: bytes, ctype: str) -> None:
        if len(data) > MAX_CACHE_ITEM:
            return
        self.items[key] = (data, ctype)
        self.items.move_to_end(key)
        while sum(len(d) for d, _ in self.items.values()) > MAX_CACHE_TOTAL and len(self.items) > 1:
            self.items.popitem(last=False)

    def clear(self) -> None:
        self.items.clear()


cache = _Cache()
_types: dict[int, str] = {}  # тип записи, определённый по началу файла: для запросов с середины


def sniff(head: bytes) -> str | None:
    """Content-Type по сигнатуре файла."""
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    return None


def _media_type(upstream: str | None, head: bytes, pk: int) -> str:
    found = sniff(head) if head else None
    if found:
        _types[pk] = found
        return found
    up = (upstream or "").split(";")[0].strip().lower()
    if up.startswith(("audio/", "video/")):
        return up
    return _types.get(pk) or up or "application/octet-stream"


def parse_range(header: str | None, size: int | None) -> tuple[int, int | None] | None:
    """`bytes=a-b` → (start, end включительно | None). Несколько диапазонов — берём первый. Нет/мусор → None."""
    m = _RANGE_RE.match(header or "")
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return None
    a, b = m.group(1), m.group(2)
    if a == "":  # суффикс: последние b байт
        if size is None:
            return None
        n = int(b)
        return (max(0, size - n), size - 1) if n else (size, size - 1)
    start, end = int(a), int(b) if b else None
    if end is not None and end < start:
        return None
    if size is not None and end is not None:
        end = min(end, size - 1)
    return start, end


def _base_headers(ctype: str) -> dict[str, str]:
    return {"Accept-Ranges": "bytes", "Cache-Control": CACHE_CONTROL, "Content-Type": ctype}


def _from_bytes(data: bytes, ctype: str, range_header: str | None) -> Response:
    size = len(data)
    rng = parse_range(range_header, size)
    headers = _base_headers(ctype)
    if rng is None:
        return Response(content=data, status_code=200, headers=headers, media_type=ctype)
    start, end = rng
    end = size - 1 if end is None else end
    if start >= size or start > end:
        headers["Content-Range"] = f"bytes */{size}"
        return Response(status_code=416, headers=headers)
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(content=data[start : end + 1], status_code=206, headers=headers, media_type=ctype)


def _upstream_error(status: int) -> HTTPException:
    if status in (401, 403):
        return HTTPException(502, f"Источник записи отклонил запрос ({status}): ссылка могла устареть — импортируйте набор заново")
    if status == 404:
        return HTTPException(502, "Источник записи не нашёл файл (404)")
    return HTTPException(502, f"Источник записи ответил ошибкой {status}")


@router.get("/{pk}/audio")
async def conversation_audio(pk: int, request: Request, session: Session = Depends(get_session)) -> Response:
    c = session.get(Conversation, pk)
    if not c:
        raise HTTPException(404, "диалог не найден")
    if not c.audio_url:
        raise HTTPException(404, "у диалога нет записи")
    src = c.audio_url
    key = (pk, src)
    range_header = request.headers.get("range")

    hit = cache.get(key)
    if hit:
        return _from_bytes(hit[0], hit[1], range_header)

    client = make_client()
    try:
        up = await client.send(client.build_request("GET", src, headers={"Range": range_header} if range_header else {}), stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        log.warning("запись диалога %s: источник недоступен (%s)", pk, type(e).__name__)
        raise HTTPException(502, "Источник записи недоступен: не удалось получить файл. Попробуйте позже") from None

    async def close() -> None:
        await up.aclose()
        await client.aclose()

    try:
        status = up.status_code
        if status == 416:
            await close()
            headers = {"Accept-Ranges": "bytes"}
            if up.headers.get("content-range"):
                headers["Content-Range"] = up.headers["content-range"]
            return Response(status_code=416, headers=headers)
        if status not in (200, 206):
            await close()
            log.warning("запись диалога %s: источник ответил %s", pk, status)
            raise _upstream_error(status)

        encoded = up.headers.get("content-encoding", "identity").lower() not in ("", "identity")
        length = None if encoded else _int(up.headers.get("content-length"))
        rng = parse_range(range_header, length) if range_header else None

        if status == 200 and rng is not None and not (rng[0] == 0 and (rng[1] is None or (length is not None and rng[1] >= length - 1))):
            # Источник не умеет Range, а нужен кусок с середины: качаем целиком и режем.
            data = await up.aread()
            await close()
            ctype = _media_type(up.headers.get("content-type"), data[:16], pk)
            cache.put(key, data, ctype)
            return _from_bytes(data, ctype, range_header)

        it = up.aiter_bytes()
        try:
            first = await anext(it, b"")
        except httpx.HTTPError as e:
            await close()
            log.warning("запись диалога %s: обрыв при чтении (%s)", pk, type(e).__name__)
            raise HTTPException(502, "Источник записи оборвал передачу. Попробуйте позже") from None

        starts_at_zero = status == 200 or (up.headers.get("content-range", "").replace(" ", "").lower().startswith("bytes0-"))
        ctype = _media_type(up.headers.get("content-type"), first[:16] if starts_at_zero else b"", pk)
        headers = _base_headers(ctype)
        out_status = status
        if status == 206:
            if up.headers.get("content-range"):
                headers["Content-Range"] = up.headers["content-range"]
            if length is not None:
                headers["Content-Length"] = str(length)
        else:
            if length is not None:
                headers["Content-Length"] = str(length)
                if rng is not None:  # bytes=0- при источнике без Range: тот же поток, но как 206
                    out_status = 206
                    headers["Content-Range"] = f"bytes 0-{length - 1}/{length}"
        tee = status == 200  # полный файл: попутно кладём в кэш, чтобы следующая перемотка шла из памяти

        async def body():
            buf: bytearray | None = bytearray() if tee else None
            complete = False
            try:
                if first:
                    if buf is not None:
                        buf.extend(first)
                    yield first
                async for chunk in it:
                    if buf is not None:
                        buf = None if len(buf) + len(chunk) > MAX_CACHE_ITEM else buf
                        if buf is not None:
                            buf.extend(chunk)
                    yield chunk
                complete = True
            except httpx.HTTPError as e:
                log.warning("запись диалога %s: обрыв при передаче (%s)", pk, type(e).__name__)
            finally:
                await close()
                if complete and buf is not None and (length is None or len(buf) == length):
                    cache.put(key, bytes(buf), ctype)

        return StreamingResponse(body(), status_code=out_status, headers=headers, media_type=ctype)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — любая другая ошибка: закрыть соединение, без утечки URL
        await close()
        log.warning("запись диалога %s: ошибка прокси (%s)", pk, type(e).__name__)
        raise HTTPException(502, "Не удалось передать запись") from None


def _int(v: str | None) -> int | None:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None
