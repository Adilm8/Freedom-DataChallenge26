"""Черновик критерия с ИИ (POST /checklists/draft-criterion). Без сети: провайдер подменён."""
import json

from backend.app.api import checklists as api_checklists
from backend.app.providers.base import LLMResult, ProviderError
from backend.app.services import checklists as svc
from backend.app.services import criterion_draft

BINARY = {"title": "Предупреждение о рисках", "definition": "Оператор предупредил клиента о рисках инвестиций.",
          "yes_when": "Оператор прямо сказал, что вложения могут принести убыток.",
          "no_when": "Клиент спрашивал о вложениях, а о рисках оператор не сказал.",
          "na_allowed": True, "na_when": "Разговор не касался инвестиций.",
          "guidance": "Ищи упоминание убытков или рисков в репликах оператора.", "voice_guidance": None}
SCALE = {"title": "Полнота предупреждения", "definition": "Насколько полно оператор описал риски.",
         "scale": [{"value": 0, "label": "О рисках ни слова."}, {"value": 10, "label": "Риски названы и объяснены."},
                   {"value": 5, "label": "Риски упомянуты вскользь."}],
         "na_allowed": False, "na_when": None, "guidance": None, "voice_guidance": "Устное «может уйти в минус» тоже считается."}


class Scripted:
    """Отдаёт заранее заданные ответы по очереди и запоминает запросы."""
    name = "fake"

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def complete(self, messages, *, json_schema=None, max_tokens=0, **kw):
        self.calls.append({"messages": messages, "schema": json_schema, "max_tokens": max_tokens})
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        body, finish = a if isinstance(a, tuple) else (a, "stop")
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        return LLMResult(text=text, parsed=None if isinstance(body, str) else body, finish_reason=finish,
                         provider="fake", model="fake/m", tokens_in=300, tokens_out=120, cost_usd=0.002, latency_ms=7,
                         request={"messages": messages})


def _post(client, monkeypatch, prov, **body):
    monkeypatch.setattr(api_checklists, "get_provider", lambda name=None: prov)
    return client.post("/api/checklists/draft-criterion", json={"model": "fake/m", **body})


def _active_body(client):
    ver = next(v for v in client.get("/api/checklists").json() if v["is_active"])
    return client.get(f"/api/checklists/{ver['id']}").json()["body"]


def test_draft_binary_fits_checklist_after_human_fields(client, monkeypatch):
    prov = Scripted(BINARY)
    r = _post(client, monkeypatch, prov, description="оператор предупредил клиента о рисках инвестиций", type="binary")
    assert r.status_code == 200, r.text
    out = r.json()
    c = out["criterion"]
    assert c["title"] == BINARY["title"] and c["type"] == "binary" and c["na_when"] == BINARY["na_when"]
    # вес, секцию и коды модель не выбирает
    assert c["key"] is None and c["section"] is None and c["weight"] is None and c["export_id"] is None
    assert out["model"] == "fake/m" and out["cost_usd"] == 0.002 and out["tokens"] == {"in": 300, "out": 120}
    assert out["attempts"] == 1 and out["calls"][0]["response_raw"]
    # образцы стиля — из активного чек-листа в БД, описание — в сообщении пользователя
    sys_msg, user_msg = prov.calls[0]["messages"]
    body = _active_body(client)
    assert any(x["title"] in sys_msg["content"] for x in body["criteria"])
    assert "рисках инвестиций" in user_msg["content"]
    assert prov.calls[0]["schema"]["additionalProperties"] is False and "scale" not in prov.calls[0]["schema"]["properties"]
    # человек задаёт код, секцию и вес — версия проходит проверку
    body["criteria"].append({**c, "key": "09", "section": body["sections"][0]["id"], "weight": 5})
    svc.validate(body)


def test_draft_scale_sorted_and_valid(client, monkeypatch):
    r = _post(client, monkeypatch, Scripted(SCALE), description="насколько полно описаны риски", type="scale")
    assert r.status_code == 200, r.text
    c = r.json()["criterion"]
    assert [s["value"] for s in c["scale"]] == [10, 5, 0] and c["yes_when"] is None
    body = _active_body(client)
    body["criteria"].append({**c, "key": "10", "section": body["sections"][1]["id"], "weight": 10})
    svc.validate(body)


def test_truncated_answer_is_retried_with_more_tokens(client, monkeypatch):
    prov = Scripted(('{"title": "Пред', "length"), BINARY)
    r = _post(client, monkeypatch, prov, description="риски", type="binary")
    assert r.status_code == 200, r.text
    assert r.json()["attempts"] == 2 and r.json()["cost_usd"] == 0.004
    assert prov.calls[1]["max_tokens"] == 2 * prov.calls[0]["max_tokens"]
    assert "обрезан" in prov.calls[1]["messages"][-1]["content"]


def test_truncated_twice_is_an_error(client, monkeypatch):
    prov = Scripted(('{"title"', "length"), ('{"title": "x"', "length"))
    r = _post(client, monkeypatch, prov, description="риски", type="binary")
    assert r.status_code == 502 and "обрезан" in r.json()["detail"] and len(r.json()["calls"]) == 2


def test_invalid_draft_retried_with_errors(client, monkeypatch):
    bad = {**BINARY, "na_allowed": True, "na_when": None}
    prov = Scripted(bad, BINARY)
    r = _post(client, monkeypatch, prov, description="риски", type="binary")
    assert r.status_code == 200 and r.json()["attempts"] == 2
    assert "na_when" in prov.calls[1]["messages"][-1]["content"]


def test_flag_drops_na_and_provider_error_is_502(client, monkeypatch):
    flag = {k: v for k, v in BINARY.items() if k not in ("na_allowed", "na_when")}
    r = _post(client, monkeypatch, Scripted(flag), description="оператор нагрубил", type="flag")
    assert r.status_code == 200 and r.json()["criterion"]["na_allowed"] is False
    r = _post(client, monkeypatch, Scripted(ProviderError("нет сети")), description="риски", type="binary")
    assert r.status_code == 502 and "нет сети" in r.json()["detail"]


def test_bad_input_is_400(client, monkeypatch):
    prov = Scripted()
    assert _post(client, monkeypatch, prov, description="   ", type="binary").status_code == 400
    assert _post(client, monkeypatch, prov, description="риски", type="stars").status_code == 400
    assert _post(client, monkeypatch, prov, description="риски", type="binary", provider="nope").status_code == 400
    assert prov.calls == []


def test_examples_prefer_same_type():
    cl = svc.validate(json.loads(svc.DEFAULT_PATH.read_text(encoding="utf-8")))
    ex = criterion_draft.pick_examples(cl, "scale")
    assert len(ex) == 2 and ex[0]["type"] == "scale" and ex[1]["type"] != "scale"
    assert all("weight" not in e and "key" not in e and "export_id" not in e for e in ex)
