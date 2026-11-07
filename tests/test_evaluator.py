"""Конвейер оценки без сети и без БД: стратегии, параллельные вызовы, страховки, баллы (ADR-001, ADR-002)."""

import json
import threading

from backend.app.providers.base import LLMResult
from backend.app.services import evaluator
from tests.test_judge import CHAT, CL, ok_item


class SchemaEchoProvider:
    """Отвечает «Да»/максимум по каждому критерию из схемы; 07 — «Нет»."""

    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()

    def complete(self, messages, *, json_schema=None, **kw):
        with self.lock:
            self.calls.append(json_schema)
        res = {}
        for key, spec in json_schema["properties"]["results"]["properties"].items():
            enum = spec["properties"]["answer"]["enum"]
            ans = "no" if key in ("07", "08") else enum[0]
            item = ok_item(ans)
            if ans == "no":
                item.update(evidence=[], checked_range={"from": "m4", "to": "m5"})
            res[key] = item
        out = {"results": res}
        if "overview" in json_schema["properties"]:
            out["overview"] = {"summary": "s", "topic": "t", "resolved": "yes"}
        text = json.dumps(out, ensure_ascii=False)
        return LLMResult(text=text, parsed=out, finish_reason="stop", provider="fake", model="fake/m",
                         tokens_in=1000, tokens_out=100, cost_usd=0.001, latency_ms=50)


FACTS = ({}, "нет", {"greeting_in_first_msg": True, "intro_in_first_msg": True, "identity_verified": False,
                     "is_voice": False, "ended_abruptly": True})


def test_partition_strategies():
    keys = lambda parts: [[c.key for c in p] for p in parts]  # noqa: E731
    crit = CL.enabled_criteria()
    assert keys(evaluator.partition(crit, "grouped")) == [["01", "02", "03", "05", "07"], ["04"], ["06"], ["08"]]
    assert len(evaluator.partition(crit, "per_criterion")) == 8
    assert len(evaluator.partition(crit, "single")) == 1


def test_grouped_evaluation_end_to_end():
    p = SchemaEchoProvider()
    out = evaluator.evaluate_conversation(CHAT, CL, p, strategy="grouped", facts_override=FACTS)
    assert len(p.calls) == 4 and out.status == "done"
    assert sum("overview" in s["properties"] for s in p.calls) == 1
    # 07 = «Нет» → 95 из 100; 08 = «Нет» → флага нет
    assert out.score.total == 95.0 and out.score.critical == []
    assert out.overview["topic"] == "t"
    assert out.cost_usd == 0.004 and out.tokens == (4000, 400)
    # страховки: 07 «Нет» при ended_abruptly → пометка; 03 «Да» без подтверждения личности в чате → пометка
    flagged = {i.criterion for i in out.issues if i.code == "G-flag"}
    assert flagged == {"03", "07"} and out.needs_review
    assert set(out.hashes) == {c.key for c in CL.enabled_criteria()}


def test_new_criterion_without_group_gets_own_call():
    cl = CL.model_copy(deep=True)
    new = cl.criterion("05").model_copy(update={"key": "09", "title": "Предупреждение об ожидании", "group": None})
    cl.criteria.append(new)
    p = SchemaEchoProvider()
    out = evaluator.evaluate_conversation(CHAT, cl, p, strategy="grouped", facts_override=FACTS)
    assert len(p.calls) == 5 and "09" in out.results
    assert out.score.applicable_weight == 115


def test_criterion_hash_ignores_weight_but_not_wording():
    c = CL.criterion("05")
    h = evaluator.criterion_hash(c, "p1", "m")
    assert evaluator.criterion_hash(c.model_copy(update={"weight": 30}), "p1", "m") == h
    assert evaluator.criterion_hash(c.model_copy(update={"definition": "иначе"}), "p1", "m") != h
    assert evaluator.criterion_hash(c, "p2", "m") != h
