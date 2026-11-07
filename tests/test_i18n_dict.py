"""Словарь интерфейса RU → EN/KZ (frontend/js/i18n-dict.js): формат и подстановки."""
import json
import re
from pathlib import Path

DICT = Path(__file__).resolve().parents[1] / "frontend" / "js" / "i18n-dict.js"


def load():
    text = DICT.read_text(encoding="utf-8")
    body = text[text.index("export default {") + len("export default ") : text.rindex("}") + 1]
    body = re.sub(r",\s*}$", "}", body.strip())
    return json.loads(body)


def test_dict_parses_and_has_both_languages():
    d = load()
    assert len(d) > 1000
    for ru, tr in d.items():
        assert isinstance(tr, list) and len(tr) == 2, ru
        assert all(isinstance(x, str) and x for x in tr), ru


def test_placeholders_match():
    for ru, tr in load().items():
        ph = sorted(re.findall(r"\{(?:\d+|n)\}", ru))
        for x in tr:
            assert sorted(re.findall(r"\{(?:\d+|n)\}", x)) == ph, (ru, x)


def test_english_has_no_cyrillic():
    for ru, (en, _kk) in load().items():
        # Допустимы только примеры ролей из подсказки нового диалога (их вводят по-русски).
        if "клиент, оператор" in ru:
            continue
        assert not re.search(r"[А-Яа-яЁё]", en), (ru, en)
