"""Маскирование персональных данных перед отправкой диалога во внешнюю модель.

Номера карт (с проверкой Луна), ИИН, IBAN, телефоны, email, коды из SMS и длинные номера
(счёт, договор) заменяются метками `[CARD_1]`, `[PHONE_1]` и т. п. Одно и то же значение
в диалоге получает одну и ту же метку, поэтому модель видит, что клиент назвал данные и
повторил их, но не видит сами данные. Оригинал остаётся только в нашей БД.

Включается `PII_MASKING=true` в `.env` (по умолчанию включено). Чистая функция, без БД.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..domain import NormalizedConversation

KINDS = {
    "EMAIL": "email",
    "IBAN": "IBAN",
    "CARD": "номер карты",
    "IIN": "ИИН",
    "PHONE": "телефон",
    "CODE": "код подтверждения",
    "NUMBER": "номер счёта или документа",
}

PLACEHOLDER_RE = re.compile(r"\[(?:" + "|".join(KINDS) + r")_\d+\]")

_SEP = r"[ \- ]?"
# Порядок важен: более узкие шаблоны раньше, пересечения отбрасываются.
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("EMAIL", re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b")),
    ("CARD", re.compile(r"(?<![\d])\d(?:" + _SEP + r"\d){12,18}(?![\d])")),
    ("PHONE", re.compile(r"(?<![\w+])(?:\+7|8|\+\d{1,3})[ \- ]?\(?\d{3}\)?(?:[ \- ]?\d){7}(?![\d])")),
    ("IIN", re.compile(r"(?<![\d])\d{12}(?![\d])")),
    ("CODE", re.compile(r"(?i)\b(?:код\w*|code|пароль|password|otp|sms|смс)\D{0,15}?(?<!\d)(\d{4,6})(?![\d])")),
    ("NUMBER", re.compile(r"(?<![\d\w])\d(?:[ \-]?\d){5,}(?![\d])")),
]


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


@dataclass
class Span:
    msg_id: str
    start: int
    end: int
    kind: str
    placeholder: str


def _find(text: str) -> list[tuple[int, int, str, str]]:
    """→ [(start, end, kind, value)] без пересечений."""
    found: list[tuple[int, int, str, str]] = []
    taken: list[tuple[int, int]] = []
    for kind, pat in _PATTERNS:
        for m in pat.finditer(text):
            g = 1 if pat.groups else 0
            s, e = m.span(g)
            value = m.group(g)
            digits = re.sub(r"\D", "", value)
            if kind == "CARD" and not _luhn(digits):
                kind_eff = "NUMBER"
            else:
                kind_eff = kind
            if kind == "NUMBER" and len(digits) < 6:
                continue
            if any(s < te and ts < e for ts, te in taken):
                continue
            taken.append((s, e))
            if kind == "PHONE":
                digits = digits[-10:]
            found.append((s, e, kind_eff, digits or value.lower()))
    return sorted(found)


def mask_conversation(conv: NormalizedConversation) -> tuple[NormalizedConversation, list[Span]]:
    """→ (копия диалога с метками вместо данных, найденные места в исходном тексте)."""
    labels: dict[tuple[str, str], str] = {}
    counters: dict[str, int] = {}
    spans: list[Span] = []
    messages = []
    for msg in conv.messages:
        hits = _find(msg.text)
        if not hits:
            messages.append(msg)
            continue
        out, pos = [], 0
        for s, e, kind, value in hits:
            key = (kind, value)
            if key not in labels:
                counters[kind] = counters.get(kind, 0) + 1
                labels[key] = f"[{kind}_{counters[kind]}]"
            out.append(msg.text[pos:s])
            out.append(labels[key])
            spans.append(Span(msg.msg_id, s, e, kind, labels[key]))
            pos = e
        out.append(msg.text[pos:])
        messages.append(msg.model_copy(update={"text": "".join(out)}))
    if not spans:
        return conv, []
    return conv.model_copy(update={"messages": messages}), spans


def has_placeholders(conv: NormalizedConversation) -> bool:
    return any(PLACEHOLDER_RE.search(m.text) for m in conv.messages)


def summary(spans: list[Span]) -> dict:
    """Сводка для интерфейса: сколько и чего скрыто, где."""
    by_kind: dict[str, int] = {}
    for sp in spans:
        by_kind[sp.kind] = by_kind.get(sp.kind, 0) + 1
    return {
        "masked_total": len(spans),
        "unique_values": len({sp.placeholder for sp in spans}),
        "by_kind": [{"kind": k, "label": KINDS[k], "count": n} for k, n in sorted(by_kind.items())],
        "spans": [sp.__dict__ for sp in spans],
    }
