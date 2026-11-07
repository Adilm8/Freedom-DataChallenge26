"""Проверка ответа модели кодом (evaluation-pipeline.md §6, V1–V11).

`validate()` возвращает приведённые результаты по критериям и список проблем.
Проблемы с `retry=True` стоят повторного вызова; остальные — пометка «требует проверки» или тихая правка.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from ..domain import Answer, ChecklistSettings, Criterion, NormalizedConversation

_NORM_RE = re.compile(r"[^\w]+", re.UNICODE)


@dataclass
class Issue:
    code: str
    message: str
    criterion: str | None = None
    retry: bool = False


@dataclass
class CriterionOutput:
    key: str
    answer: Answer | None
    reasoning: str = ""
    confidence: str = "medium"
    evidence: list[dict] = field(default_factory=list)   # {msg_id, quote, quote_ok}
    checked_range: dict | None = None
    na_reason: str | None = None
    advice: str | None = None
    issues: list[str] = field(default_factory=list)

    @property
    def needs_review(self) -> bool:
        return bool(self.issues)


def _norm(s: str) -> str:
    return " ".join(_NORM_RE.sub(" ", (s or "").lower()).split())


def quote_score(quote: str, text: str) -> float:
    """1.0 — дословное вхождение (без регистра и пунктуации); иначе лучшее сходство с окном того же размера."""
    q, t = _norm(quote), _norm(text)
    if not q:
        return 0.0
    if q in t:
        return 1.0
    qw, tw = q.split(), t.split()
    n = len(qw)
    if not tw:
        return 0.0
    best = 0.0
    for size in {max(1, n - 1), n, n + 1}:
        for i in range(0, max(1, len(tw) - size + 1)):
            best = max(best, SequenceMatcher(None, q, " ".join(tw[i : i + size])).ratio())
    return best


def _is_full_score(c: Criterion, ans: Answer | None) -> bool:
    if c.type == "binary":
        return ans in ("yes", "na")
    if c.type == "scale":
        return ans == "na" or ans == c.max_step
    return ans == "no"  # флаг: «нет нарушений» — полный порядок


def validate(
    output: dict | None,
    criteria: list[Criterion],
    conv: NormalizedConversation,
    settings: ChecklistSettings,
    *,
    final: bool = False,
) -> tuple[dict[str, CriterionOutput], list[Issue]]:
    """`final=True` — после ретрая: ничего не повторяем, плохие цитаты убираем и помечаем."""
    issues: list[Issue] = []
    results: dict[str, CriterionOutput] = {}
    if not isinstance(output, dict) or not isinstance(output.get("results"), dict):
        issues.append(Issue("V1", "ответ не JSON по схеме: нет объекта results", retry=True))
        return results, issues

    threshold = settings.quote_threshold.get("voice" if conv.is_voice else "chat", 0.85)
    raw_results = output["results"]

    for c in criteria:
        raw = raw_results.get(c.key)
        if not isinstance(raw, dict):
            issues.append(Issue("V2", f"нет результата по критерию {c.key}", c.key, retry=True))
            continue
        co = CriterionOutput(
            key=c.key,
            answer=None,
            reasoning=str(raw.get("reasoning") or "").strip(),
            confidence=raw.get("confidence") if raw.get("confidence") in ("high", "medium", "low") else "medium",
            na_reason=(str(raw.get("na_reason")).strip() or None) if raw.get("na_reason") else None,
            advice=(str(raw.get("advice")).strip() or None) if raw.get("advice") else None,
        )
        results[c.key] = co

        # V3 — ответ из разрешённых
        try:
            co.answer = c.coerce_answer(raw.get("answer"))
        except (ValueError, TypeError):
            issues.append(Issue("V3", f"{c.key}: ответ {raw.get('answer')!r} не из разрешённых {c.allowed_answers()}", c.key, retry=True))
            co.issues.append("недопустимый ответ модели")
            continue

        # V4, V5 — доказательства
        for ev in raw.get("evidence") or []:
            if not isinstance(ev, dict):
                continue
            mid, quote = str(ev.get("msg_id") or "").strip(), str(ev.get("quote") or "")
            msg = conv.message(mid)
            if msg is None:
                issues.append(Issue("V4", f"{c.key}: реплики {mid!r} нет в диалоге", c.key, retry=not final))
                if final:
                    co.issues.append(f"ссылка на несуществующую реплику {mid} убрана")
                continue
            ok = quote_score(quote, msg.text) >= threshold if quote.strip() else True
            if not ok:
                issues.append(Issue("V5", f"{c.key}: цитаты «{quote[:80]}» нет в реплике {mid}", c.key, retry=not final))
                if final:
                    co.issues.append(f"цитата к {mid} не найдена в тексте")
                    co.evidence.append({"msg_id": mid, "quote": "", "quote_ok": False})
                continue
            co.evidence.append({"msg_id": mid, "quote": quote, "quote_ok": True})

        # диапазон проверки
        cr = raw.get("checked_range")
        if isinstance(cr, dict) and conv.message(str(cr.get("from"))) and conv.message(str(cr.get("to"))):
            a, b = conv.message(str(cr["from"])).idx, conv.message(str(cr["to"])).idx
            co.checked_range = {"from": f"m{min(a, b)}", "to": f"m{max(a, b)}"}
        elif cr:
            issues.append(Issue("V4", f"{c.key}: неверный checked_range {cr!r}", c.key))

        # V6 — у «Нет» есть место
        if co.answer == "no" and c.type != "flag" and not co.evidence and not co.checked_range:
            issues.append(Issue("V6", f"{c.key}: ответ «Нет» без доказательства и без участка", c.key))
            co.issues.append("«Нет» без указания места")
        # V7 — у N/A есть причина
        if co.answer == "na" and not co.na_reason:
            issues.append(Issue("V7", f"{c.key}: N/A без причины", c.key))
            co.issues.append("N/A без причины")
        if co.answer != "na":
            co.na_reason = None
        # V8 — доказательство только из реплик бота
        if co.evidence and all((conv.message(e["msg_id"]).speaker == "bot") for e in co.evidence):
            issues.append(Issue("V8", f"{c.key}: доказательства только из реплик бота", c.key))
            co.issues.append("доказательства только из реплик бота")
        # V10 — низкая уверенность
        if co.confidence == "low":
            issues.append(Issue("V10", f"{c.key}: модель не уверена", c.key))
            co.issues.append("низкая уверенность модели")
        # V11 — подсказка только там, где балл неполный
        if co.advice and _is_full_score(c, co.answer):
            co.advice = None

    return results, issues


def needs_retry(issues: list[Issue]) -> bool:
    return any(i.retry for i in issues)
