from backend.app.domain import Message, NormalizedConversation
from backend.app.services import pii, prompt_builder


def _conv(*texts):
    return NormalizedConversation(conversation_id="x", channel="agent chat", language="RU", messages=[
        Message(idx=i, msg_id=f"m{i}", speaker="client", text=t, timestamp="00:00") for i, t in enumerate(texts)])


def test_masks_each_kind_and_keeps_same_label_for_same_value():
    conv = _conv("Карта 4111 1111 1111 1111, ИИН 900101300123", "Звоните +7 701 123 45 67 или 87011234567",
                 "a.b@mail.kz, счёт KZ12 3456 7890 1234 5678", "Код из смс 4821", "Повторяю 4111111111111111")
    masked, spans = pii.mask_conversation(conv)
    texts = [m.text for m in masked.messages]
    assert texts[0] == "Карта [CARD_1], ИИН [IIN_1]"
    assert texts[1] == "Звоните [PHONE_1] или [PHONE_1]"
    assert texts[2] == "[EMAIL_1], счёт [IBAN_1]"
    assert texts[3] == "Код из смс [CODE_1]"
    assert texts[4] == "Повторяю [CARD_1]"
    assert conv.messages[0].text.startswith("Карта 4111")  # оригинал не тронут
    assert pii.summary(spans)["unique_values"] == 6


def test_leaves_ordinary_numbers_alone():
    conv = _conv("Форма 1042-S, в 05:00, тариф 2024 года, 15 000 тенге")
    masked, spans = pii.mask_conversation(conv)
    assert spans == [] and masked is conv


def test_prompt_mentions_labels_only_when_masked():
    from backend.app.domain import ChecklistSettings
    plain, _ = prompt_builder.build(_conv("Привет"), "", [], ChecklistSettings(), {})
    masked, _ = pii.mask_conversation(_conv("карта 4111 1111 1111 1111"))
    msgs, _ = prompt_builder.build(masked, "", [], ChecklistSettings(), {})
    assert "[CARD_1]" not in plain[1]["content"].split("## Факты")[0]
    assert "персональные данные, скрытые системой" in msgs[1]["content"]
    assert "4111" not in msgs[1]["content"]


def test_evaluator_sends_masked_text_and_restores_quotes():
    from tests.test_evaluator import FACTS, SchemaEchoProvider
    from tests.test_judge import CHAT, CL
    from backend.app.services import evaluator

    m3 = CHAT.messages[3]
    conv = CHAT.model_copy(update={"messages": [
        *CHAT.messages[:3], m3.model_copy(update={"text": m3.text + " Карта 4111 1111 1111 1111"}), *CHAT.messages[4:]]})
    seen = []

    class P(SchemaEchoProvider):
        def complete(self, messages, **kw):
            seen.append(messages[1]["content"])
            out = super().complete(messages, **kw)
            for item in out.parsed["results"].values():
                for ev in item.get("evidence") or []:
                    ev["quote"] = "Карта [CARD_1]"
            return out

    out = evaluator.evaluate_conversation(conv, CL, P(), strategy="grouped", facts_override=FACTS)
    assert seen and all("4111" not in s and "[CARD_1]" in s for s in seen)
    quotes = [e["quote"] for r in out.results.values() for e in r.evidence]
    assert quotes and all(q == "Карта 4111 1111 1111 1111" for q in quotes)
