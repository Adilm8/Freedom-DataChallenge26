"""Слой фактов (evaluation-pipeline.md §2). Диалоги выдуманные; DEV проверяется, только если снапшот есть."""

import json
from pathlib import Path

import pytest

from backend.app.domain import ChecklistSettings
from backend.app.services import facts as F
from backend.app.services.facts import Fact, boolean_facts, extract, render_for_prompt
from backend.app.services.facts.language import detect_language
from backend.app.services.facts.lexicon import find
from backend.app.services.normalize import normalize

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "data/raw/DEV.json"
SYNTH = ROOT / "tests/fixtures/synthetic"
CHECKLIST = ROOT / "data/checklists/default.json"

BOT_RU = [("00:00", "client", "Не пришли деньги на счёт."), ("00:02", "bot", "Здравствуйте! Я виртуальный помощник."),
          ("00:20", "client", "Позовите человека."), ("00:30", "system", "Эскалация на оператора.")]


def rec(cid, lang, rows, channel="agent chat"):
    return {"conversation_id": cid, "channel": channel, "language": lang, "audio_url": None,
            "transcript": [{"timestamp": t, "speaker": s, "text": x} for t, s, x in rows]}


def facts_of(record, **settings):
    return extract(normalize(record), ChecklistSettings(**settings))


def v(f, name):
    return f[name].value


# --------------------------------------------------------------------------- начало диалога


def test_ru_chat_typical_flow():
    f = facts_of(rec("t-ru-1", "RU", BOT_RU + [
        ("01:10", "operator", "Добрый вечер! Меня зовут Карина. Чтобы посмотреть платёж, подтвердим личность."),
        ("01:20", "client", "Хорошо."),
        ("01:40", "system", "Личность клиента подтверждена."),
        ("02:05", "operator", "Спасибо. Платёж в обработке, зачислим сегодня. Остались ещё вопросы?"),
        ("02:20", "client", "Нет, спасибо."),
        ("02:30", "operator", "Спасибо за обращение, хорошего вечера!"),
    ]))
    assert v(f, "has_operator") is True and v(f, "is_voice") is False
    assert (v(f, "operator_turns"), v(f, "client_turns"), v(f, "bot_turns")) == (3, 4, 1)
    assert v(f, "escalation_at")["msg_id"] == "m3" and v(f, "escalation_at")["source"] == "escalation_event"
    assert v(f, "first_operator_msg")["msg_id"] == "m4"
    assert v(f, "first_response_delay_sec") == 40 and v(f, "first_response_slow") is False
    assert v(f, "greeting_in_first_msg") is True and v(f, "intro_in_first_msg") is True
    assert "Карина" in f["intro_in_first_msg"].note
    assert v(f, "client_language") == "ru" and v(f, "operator_first_msg_language") == "ru"
    assert v(f, "first_msg_language_matches_client") is True
    assert v(f, "identity_verified") is True and v(f, "identity_verified_at")["msg_id"] == "m6"
    assert [e["type"] for e in v(f, "system_events")] == ["escalation", "identity_verified"]
    assert v(f, "last_operator_msg")["msg_id"] == "m9"
    assert v(f, "farewell_in_last_msg") is True and v(f, "help_offer_in_closing") is True
    assert v(f, "ended_by") == "normal" and v(f, "ended_abruptly") is False
    assert v(f, "long_gaps") == [] and v(f, "risk_terms") == []


def test_intro_only_in_second_reply_is_not_in_first_msg():
    f = facts_of(rec("t-ru-2", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте! Уточните, пожалуйста, номер поручения."),
        ("01:00", "operator", "Меня зовут Олжас, я специалист поддержки."),  # отдельное второе сообщение
        ("01:30", "client", "Номер 4471."),
        ("02:00", "operator", "Нашёл, оно исполнено. До свидания!"),
    ]))
    assert v(f, "greeting_in_first_msg") is True
    assert v(f, "intro_in_first_msg") is False
    assert v(f, "first_intro_msg")["msg_id"] == "m5"
    assert "m5" in f["intro_in_first_msg"].msg_ids and "m5" in f["intro_in_first_msg"].note
    assert boolean_facts(f)["intro_in_first_msg"] is False


def test_no_greeting_no_intro():
    f = facts_of(rec("t-ru-3", "RU", BOT_RU + [("01:00", "operator", "Деньги зачислят до конца дня.")]))
    assert v(f, "greeting_in_first_msg") is False and v(f, "intro_in_first_msg") is False
    assert v(f, "first_greeting_msg") is None and v(f, "first_intro_msg") is None


def test_intro_heuristic_ignores_verbs_and_sorry():
    f = facts_of(rec("t-ru-4", "RU", BOT_RU + [("01:00", "operator", "Здравствуйте, я передал ваш вопрос в отдел. Я Вам напишу.")]))
    assert v(f, "intro_in_first_msg") is False
    f = facts_of(rec("t-en-4", "EN", [("00:00", "system", "Chat transferred to an agent."),
                                      ("00:30", "operator", "Hi, I'm sorry for the wait. Click here to open the form.")]))
    assert v(f, "greeting_in_first_msg") is True and v(f, "intro_in_first_msg") is False


def test_kz_client_answered_in_russian():
    f = facts_of(rec("t-kz-1", "KZ", [
        ("00:00", "client", "Сәлеметсіз бе! Картадан шотты қалай толтырамын?"),
        ("00:05", "system", "Чат операторға жіберілді."),
        ("00:40", "operator", "Здравствуйте! Меня зовут Ерлан. Пополнить можно в разделе «Пополнить»."),
        ("01:00", "client", "Жақсы, рақмет."),
        ("01:10", "operator", "Всего доброго!"),
    ]))
    assert v(f, "client_language") == "kz" and v(f, "operator_first_msg_language") == "ru"
    assert v(f, "first_msg_language_matches_client") is False
    assert v(f, "greeting_in_first_msg") is True and "(ru)" in f["greeting_in_first_msg"].note


def test_kz_greeting_and_intro_forms():
    f = facts_of(rec("t-kz-2", "KZ", [
        ("00:00", "system", "Чат операторға жіберілді."),
        ("00:20", "operator", "Сәлеметсіз бе! Мен Ерболмын. «Есептер» бөлімін ашыңыз."),
        ("00:40", "client", "Таптым, рақмет."),
        ("00:55", "operator", "Күніңіз жақсы өтсін, сау болыңыз!"),
    ]))
    assert v(f, "greeting_in_first_msg") is True and v(f, "intro_in_first_msg") is True
    assert v(f, "operator_first_msg_language") == "kz" and v(f, "farewell_in_last_msg") is True
    assert find("intro", "Менің атым Жанар, көмектесемін.")
    assert not find("intro", "Мен сізге қазір көмектесемін.")


def test_en_chat_and_welcome_is_not_greeting():
    f = facts_of(rec("t-en-1", "EN", [
        ("00:00", "system", "Chat transferred to an agent."),
        ("00:25", "operator", "Good afternoon, I'm Kate from support. What seems to be the issue?"),
        ("00:50", "client", "Thanks, all sorted."),
        ("01:00", "operator", "You're welcome. Anything else I can do? Have a nice evening!"),
    ]))
    assert v(f, "greeting_in_first_msg") is True and v(f, "intro_in_first_msg") is True
    assert v(f, "client_language") == "en" and v(f, "first_msg_language_matches_client") is True
    assert v(f, "help_offer_in_closing") is True and v(f, "farewell_in_last_msg") is True
    assert not find("greeting", "You're welcome.")


def test_cyrillic_text_with_brand_names_is_not_mixed():
    assert detect_language("Здравствуйте! Откройте сайт Freedom Holding, раздел Investor Relations.") == "ru"
    assert detect_language("Hello! Open the «Кабинет» tab.") == "en"
    assert detect_language("ок") is None


# --------------------------------------------------------------------------- время


def test_first_response_delay_over_threshold():
    rows = BOT_RU + [("03:50", "operator", "Здравствуйте, меня зовут Аня. Проверяю платёж.")]
    f = facts_of(rec("t-ru-5", "RU", rows))
    assert v(f, "first_response_delay_sec") == 200 and v(f, "first_response_slow") is True
    assert "180" in f["first_response_slow"].note
    assert v(facts_of(rec("t-ru-5", "RU", rows), first_response_threshold_sec=300), "first_response_slow") is False


def test_long_gap_with_warning():
    f = facts_of(rec("t-ru-6", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте, меня зовут Данияр. Одну минуту, уточню у коллег."),
        ("01:00", "client", "Жду."),
        ("03:40", "operator", "Спасибо за ожидание: платёж уже зачислен."),
    ]))
    [gap] = v(f, "long_gaps")
    assert (gap["from_msg_id"], gap["to_msg_id"], gap["sec"]) == ("m5", "m6", 160)
    assert gap["warned"] is True and gap["warning_msg_id"] == "m4"
    assert v(f, "long_gap_without_warning") is False


def test_long_gap_without_warning_counts_from_first_unanswered_client_msg():
    f = facts_of(rec("t-ru-7", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте, меня зовут Данияр. Какой банк отправлял перевод?"),
        ("01:10", "client", "Каспи."),
        ("02:30", "client", "Вы тут?"),
        ("03:40", "operator", "Да. Перевод из этого банка идёт до суток."),
        ("04:00", "client", "Понятно."),
        ("04:30", "operator", "Хорошего дня!"),
    ]))
    [gap] = v(f, "long_gaps")
    assert (gap["from_msg_id"], gap["sec"], gap["warned"]) == ("m5", 150, False)
    assert v(f, "long_gap_without_warning") is True and f["long_gap_without_warning"].msg_ids == ["m7"]


def test_short_pauses_are_not_long_gaps():
    f = facts_of(rec("t-ru-8", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте, меня зовут Данияр."),
        ("01:10", "client", "Где выписка?"),
        ("02:00", "operator", "В разделе «Отчёты»."),
    ]))
    assert v(f, "long_gaps") == [] and v(f, "long_gap_without_warning") is False


# --------------------------------------------------------------------------- завершение


def test_operator_closed_without_farewell():
    f = facts_of(rec("t-ru-9", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте, меня зовут Тагир. Это решает банк."),
        ("01:05", "client", "А что мне делать?"),
        ("01:20", "operator", "Звоните в банк."),
        ("01:30", "system", "Оператор закрыл чат."),
    ]))
    assert v(f, "ended_by") == "operator_closed" and f["ended_by"].msg_ids == ["m7"]
    assert v(f, "farewell_in_last_msg") is False and v(f, "ended_abruptly") is False
    assert boolean_facts(f)["ended_by=operator_closed"] is True


def test_client_left_before_farewell():
    f = facts_of(rec("t-ru-10", "RU", BOT_RU + [
        ("00:50", "operator", "Добрый день! Меня зовут Алсу. Что случилось с переводом?"),
        ("01:00", "system", "Клиент покинул чат."),
    ]))
    assert v(f, "ended_by") == "client_left" and v(f, "ended_abruptly") is True


def test_connection_lost_before_and_after_farewell():
    base = BOT_RU + [("00:50", "operator", "Здравствуйте, я Ринат. Деньги придут завтра.")]
    f = facts_of(rec("t-ru-11", "RU", base + [("01:00", "client", "Ясно, спасибо."),
                                               ("01:05", "system", "Соединение с клиентом прервано.")]))
    assert v(f, "ended_by") == "connection_lost" and v(f, "ended_abruptly") is True
    assert "поблагодарил" in f["ended_abruptly"].note
    f = facts_of(rec("t-ru-12", "RU", base + [("01:00", "client", "Ясно."), ("01:10", "operator", "Всего доброго!"),
                                               ("01:20", "system", "Соединение с клиентом прервано.")]))
    assert v(f, "ended_abruptly") is False


def test_no_terminal_event_and_client_has_last_word():
    f = facts_of(rec("t-kz-3", "KZ", [("00:00", "system", "Чат операторға жіберілді."),
                                      ("00:30", "operator", "Сәлеметсіз бе, мен Гүлнар. Қосымшаны жаңартыңыз."),
                                      ("00:50", "client", "Болды, рақмет.")]))
    assert v(f, "ended_by") == "unknown" and v(f, "ended_abruptly") is False


def test_poka_meaning_for_now_is_not_farewell():
    base = BOT_RU + [("00:50", "operator", "Здравствуйте, меня зовут Лев. Проверьте реквизиты."), ("01:10", "client", "Проверил.")]
    f = facts_of(rec("t-ru-13", "RU", base + [("01:30", "operator", "Скриншот пока присылать не нужно.")]))
    assert v(f, "farewell_in_last_msg") is False
    f = facts_of(rec("t-ru-14", "RU", base + [("01:30", "operator", "Отлично, тогда пока!")]))
    assert v(f, "farewell_in_last_msg") is True


# --------------------------------------------------------------------------- грубые нарушения


@pytest.mark.parametrize("lang,text,category", [
    ("RU", "Переведите сумму мне на карту, так выйдет дешевле, чем через брокера.", "risk_paid_bypass"),
    ("RU", "Вечером могу дать частную консультацию за отдельную плату.", "risk_paid_bypass"),
    ("KZ", "Нөміріңізді жазыңыз, кешке ақылы кеңес беремін.", "risk_paid_bypass"),
    ("EN", "Can't you read? It is written right there.", "risk_insult"),
    ("RU", "Скажу по секрету, что у другого клиента такой же баланс.", "risk_confidential"),
])
def test_risk_terms_found(lang, text, category):
    f = facts_of(rec("t-risk", lang, [("00:00", "system", "Эскалация на оператора."), ("00:20", "operator", text)]))
    hits = v(f, "risk_terms")
    assert hits and {h["category"] for h in hits} >= {category} and hits[0]["msg_id"] == "m1"
    assert boolean_facts(f)["risk_terms"] is True


def test_risk_terms_ignore_normal_requests():
    f = facts_of(rec("t-norisk", "RU", BOT_RU + [
        ("00:50", "operator", "Здравствуйте, меня зовут Ая. Отправьте мне скриншот ошибки."),
        ("01:10", "client", "Отправил."),
        ("01:30", "operator", "Для идентификации продиктуйте код из СМС."),
    ]))
    assert v(f, "risk_terms") == []


# --------------------------------------------------------------------------- неполные данные


def test_dialog_without_operator():
    f = facts_of(rec("t-bot", "RU", [("00:00", "client", "Привет"), ("00:01", "bot", "Здравствуйте! Чем помочь?"),
                                     ("00:30", "system", "Клиент покинул чат.")]))
    assert v(f, "has_operator") is False and v(f, "operator_turns") == 0
    for name in ("first_operator_msg", "first_response_delay_sec", "greeting_in_first_msg", "intro_in_first_msg",
                 "operator_first_msg_language", "last_operator_msg", "farewell_in_last_msg", "long_gaps", "risk_terms"):
        assert v(f, name) is None, name
    assert v(f, "escalation_at") is None
    assert v(f, "ended_by") == "client_left" and v(f, "ended_abruptly") is True
    b = boolean_facts(f)
    assert b["greeting_in_first_msg"] is None and b["ended_abruptly"] is True
    assert "нет данных" in render_for_prompt(f)


def test_dialog_without_bot_starts_with_operator():
    f = facts_of(rec("t-direct", "RU", [("00:00", "client", "Как сменить тариф?"),
                                        ("00:45", "operator", "Здравствуйте! Меня зовут Ира. В разделе «Тарифы»."),
                                        ("01:00", "client", "Спасибо."), ("01:10", "operator", "До свидания!")]))
    assert v(f, "escalation_at")["source"] == "first_operator_msg" and v(f, "escalation_at")["msg_id"] == "m1"
    assert v(f, "first_response_delay_sec") == 45  # от первой реплики клиента
    assert v(f, "ended_by") == "normal"
    f = facts_of(rec("t-direct2", "EN", [("00:00", "operator", "Hello, I am Tom. How can I help?"),
                                         ("00:10", "system", "Connection to customer lost.")]))
    assert v(f, "first_response_delay_sec") is None and v(f, "ended_abruptly") is True


# --------------------------------------------------------------------------- звонок

CALL = {
    "conversation_id": "t-call-1", "channel": "voice call", "language": "RU", "audio_url": "https://example.invalid/a.wav",
    "transcript": [{"timestamp": f"2026-11-01T09:{m:02d}:{s:02d}.0000000+05:00", "speaker": sp, "text": tx} for m, s, sp, tx in [
        (0, 0, "system", "Запись и транскрибирование запущены."),
        (0, 5, "bot", "Добро пожаловать. Соединяю со специалистом."),
        (0, 15, "system", "Клиент переведен от агента на представителя службы поддержки"),
        (0, 30, "operator", "Компания Фридом Брокер."),
        (0, 33, "operator", "Меня зовут [Имя скрыто], здравствуйте."),
        (0, 40, "client", "Здрасте, у меня приказ не исполняется, ну, второй день уже."),
        (0, 55, "operator", "Понимаю. Оставайтесь на линии, я уточню у коллег."),
        (0, 58, "system", "Клиент находится на удержании."),
        (0, 59, "system", "Началась консультация с агентом."),
        (1, 10, "operator", "Коллега, по этой бумаге торги приостановлены?"),
        (2, 40, "system", "Агент вышел из разговора."),
        (3, 50, "system", "Клиент больше не находится на удержании."),
        (3, 55, "operator", "Спасибо за ожидание. Торги по бумаге приостановлены биржей."),
        (4, 10, "client", "Ясно, спасибо."),
        (4, 15, "operator", "Остались ещё вопросы?"),
        (4, 18, "client", "Нет."),
        (4, 20, "operator", "Всего доброго,"),
        (4, 21, "operator", "до свидания."),
        (4, 25, "system", "Клиент завершил разговор."),
    ]],
}


def test_voice_call_facts():
    f = facts_of(CALL)
    assert v(f, "is_voice") is True
    assert v(f, "internal_turns") == 1 and v(f, "operator_turns") == 7  # разговор с коллегой — не обращение к клиенту
    assert f["first_operator_msg"].msg_ids == ["m3", "m4"]  # ASR разрезал первую фразу
    assert v(f, "greeting_in_first_msg") is True and v(f, "intro_in_first_msg") is True
    assert v(f, "first_response_delay_sec") == 15
    [gap] = v(f, "long_gaps")
    # клиент ждал от предупреждения оператора («оставайтесь на линии») до возврата с удержания
    assert (gap["from_msg_id"], gap["to_msg_id"], gap["sec"], gap["waiting"]) == ("m6", "m12", 180, "operator")
    assert gap["warned"] is True and gap["on_hold"] is True
    assert v(f, "farewell_in_last_msg") is True and v(f, "help_offer_in_closing") is True
    assert v(f, "ended_by") == "client_ended" and v(f, "ended_abruptly") is False
    assert v(f, "identity_verified") is False and "голосом" in f["identity_verified"].note
    assert v(f, "risk_terms") == []


# --------------------------------------------------------------------------- рендер, булевы, устойчивость


def test_render_and_booleans_cover_checklist_guards():
    f = facts_of(CALL)
    text = render_for_prompt(f)
    assert text.startswith(F.PROMPT_PREAMBLE) and "не вердикт" in text
    assert "`long_gaps`" in text and "m12" in text and "m6→m12" in text
    assert len(text.splitlines()) == len(f) + 1
    guard_names = {w.lstrip("!") for c in json.loads(CHECKLIST.read_text(encoding="utf-8"))["criteria"]
                   for g in c.get("guards", []) for w in g["when"]}
    b = boolean_facts(f)
    assert guard_names <= set(b), guard_names - set(b)
    assert all(x is None or isinstance(x, bool) for x in b.values())
    assert set(F.available_facts()) == set(f)
    json.dumps(F.dump(f), ensure_ascii=False)


def test_broken_extractor_does_not_break_extract(monkeypatch):
    def boom(ctx):
        raise RuntimeError("x")
    monkeypatch.setattr(F, "_REGISTRY", F._REGISTRY + [(("broken_fact",), boom)])
    f = facts_of(CALL)
    assert f["broken_fact"].value is None and F.EXTRACTION_ERROR in f["broken_fact"].note
    assert v(f, "is_voice") is True


def test_fact_model_shape():
    assert Fact().model_dump() == {"value": None, "msg_ids": [], "note": None}


# --------------------------------------------------------------------------- синтетика с ожидаемыми ответами


def _synthetic():
    recs = json.loads((SYNTH / "dialogs.json").read_text(encoding="utf-8"))["data"]["records"]
    exp = json.loads((SYNTH / "expected.json").read_text(encoding="utf-8"))["items"]
    return [(r, exp[r["conversation_id"]]["criteria"]) for r in recs if r["conversation_id"] in exp]


@pytest.mark.skipif(not (SYNTH / "dialogs.json").exists(), reason="нет синтетических фикстур")
def test_synthetic_facts_agree_with_expected_labels():
    """Факты не решают за модель, но не должны противоречить очевидным меткам."""
    for r, crit in _synthetic():
        cid = r["conversation_id"]
        f = facts_of(r)
        contact = [v(f, "greeting_in_first_msg"), v(f, "intro_in_first_msg"), v(f, "first_msg_language_matches_client")]
        if crit["01"]["answer"] == "yes":
            assert all(x is True for x in contact), (cid, contact)
        else:
            assert not all(x is True for x in contact), (cid, contact)
        if crit["07"]["answer"] == "na":
            assert v(f, "ended_abruptly") is True, cid
        if crit["07"]["answer"] == "no":
            assert v(f, "ended_abruptly") is False, cid
        assert bool(v(f, "risk_terms")) == (crit["08"]["answer"] == "yes"), (cid, v(f, "risk_terms"))


# --------------------------------------------------------------------------- DEV


@pytest.mark.skipif(not DEV.exists(), reason="нет снапшота DEV")
def test_dev_snapshot_all_facts_computed():
    records = json.loads(DEV.read_text(encoding="utf-8"))["data"]["records"]
    names = set(F.available_facts())
    for r in records:
        f = facts_of(r)
        assert set(f) == names
        errors = {k: x.note for k, x in f.items() if x.note and F.EXTRACTION_ERROR in x.note}
        assert not errors, (r["conversation_id"], errors)
        assert v(f, "has_operator") is True, r["conversation_id"]
        json.dumps(F.dump(f), ensure_ascii=False)
        assert render_for_prompt(f)
        assert {"greeting_in_first_msg", "intro_in_first_msg", "identity_verified", "is_voice", "ended_abruptly"} <= set(boolean_facts(f))
