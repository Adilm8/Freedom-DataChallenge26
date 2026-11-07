"""Язык клиента и первой реплики оператора: алфавит, казахские буквы и частые слова.

Перед подсчётом из текста убираются фрагменты в кавычках («Меню → Пополнить» — это названия кнопок,
а не язык ответа), скрытые данные `[Имя скрыто]`, ссылки и почта. Латиница → `en`; кириллица → `kz`,
если есть казахские буквы (әғқңөұүһі) или казахские служебные слова и их больше, чем русских признаков,
иначе `ru`. Заметная доля и латиницы, и кириллицы → `mixed`. Слишком мало букв → `None`.
"""

from __future__ import annotations

import re

from . import Fact, FactContext, register
from .timing import first_response

KZ_LETTERS = set("әғқңөұүһі")
KZ_WORDS = {
    "бе", "ба", "ма", "ме", "па", "пе", "мен", "сіз", "сізге", "сізді", "сіздің", "біз", "және", "бар", "жоқ", "иә",
    "жарайды", "рақмет", "рахмет", "керек", "туралы", "бойынша", "арқылы", "немесе", "деп", "емес", "ғой", "екен",
    "осы", "сол", "бұл", "қай", "қалай", "үшін", "сау", "болыңыз", "жақсы", "қазір", "енді", "тағы",
}
RU_WORDS = {
    "и", "в", "во", "не", "на", "что", "это", "вы", "вас", "вам", "ваш", "ваше", "я", "как", "да", "нет", "здравствуйте",
    "спасибо", "пожалуйста", "меня", "зовут", "можно", "нужно", "если", "для", "по", "с", "к", "у", "от", "за", "из",
    "до", "или", "но", "же", "ли", "так", "уже", "мы", "есть", "будет", "откройте", "выберите", "добрый", "день",
}
LANG_FROM_LOCALE = {"kk": "kz", "kz": "kz", "ru": "ru", "en": "en"}
MIN_LETTERS = 4

_QUOTED = re.compile(r"«[^»]*»|“[^”]*”|„[^“”]*[“”]|\"[^\"]*\"")
_NOISE = re.compile(r"\[[^\]]*\]|https?://\S+|\S+@\S+|\b[\w.-]+\.(?:com|kz|ru|global|net|org)\b", re.IGNORECASE)
_WORD = re.compile(r"[^\W\d_]+")
_LATIN_NAME = re.compile(r"\b[A-Z][A-Za-z]*\b|\b[A-Z]{2,}\b")
_LOCALE_TO = re.compile(r"\bto\s+([a-z]{2})-[a-z]{2}\b", re.IGNORECASE)


def detect_language(text: str) -> str | None:
    t = _NOISE.sub(" ", _QUOTED.sub(" ", text or ""))
    if re.search(r"[а-яёәғқңөұүһі]", t, re.IGNORECASE):
        t = _LATIN_NAME.sub(" ", t)  # в кириллическом тексте латиница с заглавной — названия (Freedom, Investors)
    t = t.lower()
    latin = sum(1 for ch in t if "a" <= ch <= "z")
    kz_letters = sum(1 for ch in t if ch in KZ_LETTERS)
    cyr = sum(1 for ch in t if "а" <= ch <= "я" or ch == "ё") + kz_letters
    total = latin + cyr
    if total < MIN_LETTERS:
        return None
    if min(latin, cyr) / total >= 0.35:
        return "mixed"
    if latin > cyr:
        return "en"
    words = _WORD.findall(t)
    kz_signal = kz_letters + 2 * sum(w in KZ_WORDS for w in words)
    ru_signal = 2 * sum(w in RU_WORDS for w in words)
    return "kz" if kz_signal and kz_signal >= ru_signal else "ru"


def declared_language(ctx: FactContext) -> str | None:
    lang = ctx.conv.lang
    return LANG_FROM_LOCALE.get(lang, lang or None)


def line_language(ctx: FactContext) -> str | None:
    """Звонок: язык линии из системного «… language changed from kk-KZ to ru-RU»."""
    for e in ctx.conv.events:
        if e.type == "language_changed":
            m = _LOCALE_TO.search(e.text)
            if m:
                return LANG_FROM_LOCALE.get(m.group(1).lower(), m.group(1).lower())
    return None


@register({
    "client_language": "Язык клиента",
    "operator_first_msg_language": "Язык первой реплики оператора",
    "first_msg_language_matches_client": "Язык первой реплики оператора совпадает с языком клиента",
})
def languages(ctx: FactContext) -> dict[str, Fact]:
    declared = declared_language(ctx)
    client_text = " ".join(m.text for m in ctx.client_msgs)
    detected = detect_language(client_text)
    notes = []
    if detected in (None, "mixed"):
        client = declared
        notes.append("по полю language записи" + ("; реплики клиента смешанные" if detected == "mixed" else ""))
    else:
        client = detected
        if declared and declared != detected:
            notes.append(f"в данных указан {declared}, а реплики клиента — на {detected}; берём язык реплик")
    line = line_language(ctx)
    if line and line != client:
        notes.append(f"язык линии по системному событию: {line}")
    client_fact = Fact(value=client, note="; ".join(notes) or None)

    fr = first_response(ctx)
    if not fr:
        none = "оператор клиенту не отвечал"
        return {"client_language": client_fact, "operator_first_msg_language": Fact(value=None, note=none),
                "first_msg_language_matches_client": Fact(value=None, note=none)}
    op_lang = detect_language(" ".join(m.text for m in fr))
    ids = [m.msg_id for m in fr]
    op_fact = Fact(value=op_lang, msg_ids=ids,
                   note="в реплике заметны два алфавита" if op_lang == "mixed" else ("слишком мало текста" if op_lang is None else None))
    if op_lang in (None, "mixed") or client is None:
        match = Fact(value=None, msg_ids=ids, note="язык одной из сторон не определён однозначно")
    else:
        match = Fact(value=op_lang == client, msg_ids=ids, note=None if op_lang == client else f"клиент: {client}, оператор: {op_lang}")
    return {"client_language": client_fact, "operator_first_msg_language": op_fact, "first_msg_language_matches_client": match}
