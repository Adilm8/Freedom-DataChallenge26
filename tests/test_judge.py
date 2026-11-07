"""Промпт, проверка ответа и судья с ретраем — без сети (FR-EVAL-03, 04, 16, 18, 19; V1–V11)."""

import json
from pathlib import Path

from backend.app.domain import Checklist
from backend.app.providers.base import LLMResult
from backend.app.services import judge, prompt_builder, validator
from backend.app.services.normalize import normalize

ROOT = Path(__file__).resolve().parents[1]
CL = Checklist.model_validate(json.loads((ROOT / "data/checklists/default.json").read_text(encoding="utf-8")))
SECTIONS = {s.id: s.title for s in CL.sections}

CHAT = normalize({
    "conversation_id": "s-ru-002", "channel": "agent chat", "language": "RU",
    "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Как пополнить счёт?"},
        {"timestamp": "00:05", "speaker": "bot", "text": "Перевожу на оператора."},
        {"timestamp": "00:20", "speaker": "system", "text": "Эскалация на оператора."},
        {"timestamp": "00:50", "speaker": "operator", "text": "Здравствуйте! Меня зовут Дина. Пополнить счёт можно в приложении."},
        {"timestamp": "01:10", "speaker": "client", "text": "Спасибо"},
        {"timestamp": "01:20", "speaker": "system", "text": "Оператор закрыл чат."},
    ],
})
A_GROUP = [c for c in CL.criteria if c.group == "A"]


def ok_item(answer="yes", **kw):
    item = {"reasoning": "ок", "answer": answer, "confidence": "high",
            "evidence": [{"msg_id": "m3", "quote": "Меня зовут Дина"}], "checked_range": None, "na_reason": None, "advice": None}
    item.update(kw)
    return item


def good_output():
    res = {c.key: ok_item() for c in A_GROUP}
    res["02"] = ok_item("na", na_reason="всё было ясно", evidence=[])
    res["03"] = ok_item("na", na_reason="общий вопрос", evidence=[])
    res["07"] = ok_item("no", evidence=[], checked_range={"from": "m4", "to": "m5"}, advice="Попрощаться с клиентом.")
    return {"results": res, "overview": {"summary": "s", "topic": "Пополнение", "resolved": "yes"}}


class FakeProvider:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def complete(self, messages, **kw):
        self.calls.append((messages, kw))
        out = self.outputs.pop(0)
        text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
        finish = "length" if text.startswith("{\"trunc") else "stop"
        return LLMResult(text=text, parsed=None if not text.startswith("{") else json.loads(text), finish_reason=finish,
                         provider="fake", model="fake/model")


def test_prompt_has_rules_facts_transcript_and_only_given_criteria():
    msgs, schema = prompt_builder.build(CHAT, "- escalation_at: m2", A_GROUP, CL.settings, SECTIONS, include_overview=True)
    system, user = msgs[0]["content"], msgs[1]["content"]
    assert "Оценивается только оператор" in system and "русский" in system
    assert "расшифровка устной речи" not in system                     # правила звонка только для звонков
    assert "[m3 | 00:50 | operator] Здравствуйте!" in user
    assert "[m2 | 00:20 | system:escalation]" in user
    assert "Критерий 01" in user and "Критерий 04" not in user
    assert "N/A разрешён, только если" in user
    assert set(schema["properties"]["results"]["required"]) == {c.key for c in A_GROUP}
    assert schema["properties"]["results"]["properties"]["01"]["properties"]["answer"]["enum"] == ["yes", "no"]
    assert "overview" in schema["required"]
    # порядок полей: reasoning раньше answer
    assert list(schema["properties"]["results"]["properties"]["01"]["properties"])[:2] == ["reasoning", "answer"]


def test_scale_enum_and_context_ref_and_voice_rules():
    c04 = CL.criterion("04")
    msgs, schema = prompt_builder.build(CHAT, "", [c04], CL.settings, SECTIONS)
    assert schema["properties"]["results"]["properties"]["04"]["properties"]["answer"]["enum"] == ["20", "15", "10", "5", "0", "na"]
    assert "overview" not in schema["properties"]
    assert "подсказка о продуктах, а не эталон" in msgs[1]["content"]
    call = CHAT.model_copy(update={"channel": "voice call"})
    assert "расшифровка устной речи" in prompt_builder.build(call, "", [c04], CL.settings, SECTIONS)[0][0]["content"]


def test_validator_accepts_good_output_and_cleans_advice():
    out = good_output()
    out["results"]["01"]["advice"] = "лишнее"
    res, issues = validator.validate(out, A_GROUP, CHAT, CL.settings)
    assert not validator.needs_retry(issues)
    assert res["01"].advice is None                  # полный балл → подсказка не нужна (V11)
    assert res["07"].advice and res["07"].checked_range == {"from": "m4", "to": "m5"}
    assert res["02"].answer == "na" and res["02"].na_reason


def test_validator_flags_fake_quote_bad_id_and_bad_answer():
    out = good_output()
    out["results"]["01"]["evidence"] = [{"msg_id": "m3", "quote": "Меня зовут Алина, я ваш личный менеджер"}]
    out["results"]["05"]["evidence"] = [{"msg_id": "m99", "quote": "x"}]
    out["results"]["02"]["answer"] = "maybe"
    _, issues = validator.validate(out, A_GROUP, CHAT, CL.settings)
    assert {i.code for i in issues if i.retry} == {"V3", "V4", "V5"}


def test_validator_marks_low_confidence_and_missing_reasons():
    out = good_output()
    out["results"]["05"]["confidence"] = "low"
    out["results"]["03"]["na_reason"] = None
    out["results"]["01"] = ok_item("no", evidence=[], checked_range=None)
    res, issues = validator.validate(out, A_GROUP, CHAT, CL.settings)
    codes = {i.code for i in issues}
    assert {"V6", "V7", "V10"} <= codes and not validator.needs_retry(issues)
    assert res["05"].needs_review


def test_quote_score_tolerates_punctuation_and_small_asr_noise():
    assert validator.quote_score("меня зовут дина", "Здравствуйте! Меня зовут Дина.") == 1.0
    assert validator.quote_score("пополнить счет можно в приложении", "Пополнить счёт можно в приложении.") >= 0.85
    assert validator.quote_score("совсем другой текст тут", "Пополнить счёт можно в приложении.") < 0.6


def test_judge_retries_once_with_errors_then_succeeds():
    bad = good_output()
    bad["results"]["01"]["evidence"] = [{"msg_id": "m3", "quote": "выдуманная цитата из воздуха"}]
    p = FakeProvider([bad, good_output()])
    msgs, schema = prompt_builder.build(CHAT, "", A_GROUP, CL.settings, SECTIONS, include_overview=True)
    out = judge.run(p, msgs, schema, A_GROUP, CHAT, CL.settings)
    assert len(out.calls) == 2
    retry_msgs = p.calls[1][0]
    assert retry_msgs[-2]["role"] == "assistant" and "цитаты" in retry_msgs[-1]["content"]
    assert out.results["01"].evidence[0]["quote_ok"] and out.overview["topic"] == "Пополнение"
    assert p.calls[0][1]["channel"] == "agent chat" and p.calls[0][1]["temperature"] == 0


def test_judge_keeps_best_with_flags_when_retry_also_fails():
    bad = good_output()
    bad["results"]["01"]["evidence"] = [{"msg_id": "m3", "quote": "выдуманная цитата из воздуха"}]
    p = FakeProvider([bad, bad])
    msgs, schema = prompt_builder.build(CHAT, "", A_GROUP, CL.settings, SECTIONS)
    out = judge.run(p, msgs, schema, A_GROUP, CHAT, CL.settings)
    assert len(out.calls) == 2
    assert out.results["01"].needs_review and out.results["01"].evidence[0]["quote_ok"] is False
    assert out.results["01"].answer == "yes"


def test_judge_survives_garbage():
    p = FakeProvider(["not json", "still not json"])
    msgs, schema = prompt_builder.build(CHAT, "", A_GROUP, CL.settings, SECTIONS)
    out = judge.run(p, msgs, schema, A_GROUP, CHAT, CL.settings)
    assert out.results == {} and any(i.code == "V1" for i in out.issues)


def test_judge_retry_does_not_lose_criteria_from_first_answer():
    bad = good_output()
    bad["results"]["01"]["evidence"] = [{"msg_id": "m3", "quote": "выдуманная цитата из воздуха"}]
    fixed = good_output()
    del fixed["results"]["05"]                       # повтор исправил 01, но потерял 05
    p = FakeProvider([bad, fixed])
    msgs, schema = prompt_builder.build(CHAT, "", A_GROUP, CL.settings, SECTIONS)
    out = judge.run(p, msgs, schema, A_GROUP, CHAT, CL.settings)
    assert out.results["01"].evidence[0]["quote_ok"] and out.results["05"].answer == "yes"
