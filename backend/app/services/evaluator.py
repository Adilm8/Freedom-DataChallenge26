"""Конвейер оценки одного диалога (evaluation-pipeline.md, ADR-001, ADR-002).

нормализованный диалог → факты → разбиение критериев по стратегии → вызовы судьи параллельно
→ проверка с ретраем → страховки → баллы (scoring). Чистая часть без БД — `evaluate_conversation`;
запись в БД — `services/evaluations.py`.
"""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from ..domain import Checklist, Criterion, NormalizedConversation, ScoreResult
from ..providers import LLMResult
from ..config import settings as app_settings
from . import guards, judge, pii, prompt_builder, scoring
from .validator import CriterionOutput, Issue

STRATEGIES = ("single", "grouped", "per_criterion")


def partition(criteria: list[Criterion], strategy: str) -> list[list[Criterion]]:
    """Разбиение критериев на вызовы. `grouped`: по полю `group`, критерий без группы — свой вызов."""
    if strategy == "single":
        return [list(criteria)] if criteria else []
    if strategy == "per_criterion":
        return [[c] for c in criteria]
    if strategy != "grouped":
        raise ValueError(f"неизвестная стратегия «{strategy}»: {', '.join(STRATEGIES)}")
    groups: dict[str, list[Criterion]] = {}
    for c in criteria:
        groups.setdefault(c.group or f"__{c.key}", []).append(c)
    return list(groups.values())


# Поля критерия, которые попадают в промпт: от них зависит ответ модели (FR-CHK-10).
_PROMPT_FIELDS = ("key", "title", "type", "definition", "yes_when", "no_when", "na_allowed", "na_when", "scale",
                  "guidance", "voice_guidance", "context_refs")


def criterion_hash(c: Criterion, prompt_version: str, model: str, context: str = "") -> str:
    """Хеш входа модели по критерию: поля критерия, содержимое справки, версия промпта, модель и
    `context` — отпечаток транскрипта, фактов и настроек (`prompt_builder.context_digest`)."""
    payload = {f: getattr(c, f) for f in _PROMPT_FIELDS}
    payload["scale"] = [s.model_dump() for s in c.scale] if c.scale else None
    payload |= {"prompt_version": prompt_version, "model": model, "context": context,
                "refs": prompt_builder.context_refs_digest(c) if c.context_refs else ""}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


@dataclass
class CallRecord:
    criteria_keys: list[str]
    result: LLMResult | None
    attempt: int
    error: str | None = None


@dataclass
class EvalOutcome:
    results: dict[str, CriterionOutput]
    score: ScoreResult
    facts: dict
    overview: dict | None
    calls: list[CallRecord]
    issues: list[Issue] = field(default_factory=list)
    status: str = "done"                 # done | partial | failed
    prompt_version: str = ""
    hashes: dict[str, str] = field(default_factory=dict)

    @property
    def needs_review(self) -> bool:
        return self.status != "done" or any(r.needs_review for r in self.results.values())

    @property
    def cost_usd(self) -> float:
        return sum((c.result.cost_usd or 0) for c in self.calls if c.result)

    @property
    def tokens(self) -> tuple[int, int]:
        return (sum(c.result.tokens_in for c in self.calls if c.result), sum(c.result.tokens_out for c in self.calls if c.result))

    @property
    def latency_ms(self) -> int:
        """Звонки одного диалога идут параллельно: время = самый долгий вызов (с его ретраем)."""
        per_group: dict[tuple, int] = {}
        for c in self.calls:
            if c.result:
                k = tuple(c.criteria_keys)
                per_group[k] = per_group.get(k, 0) + c.result.latency_ms
        return max(per_group.values(), default=0)


def prepare(conv: NormalizedConversation, checklist: Checklist) -> tuple[tuple[dict, str, dict], str]:
    """Факты и отпечаток контекста до вызовов: нужны плану переиспользования (services/reuse.py)."""
    conv, _ = _mask(conv)
    f = _facts(conv, checklist)
    sections = {s.id: s.title for s in checklist.sections}
    return f, prompt_builder.context_digest(conv, f[1], checklist.settings, sections)


def _mask(conv: NormalizedConversation) -> tuple[NormalizedConversation, list[pii.Span]]:
    """Модель видит диалог с метками вместо персональных данных (PII_MASKING, по умолчанию включено)."""
    return pii.mask_conversation(conv) if app_settings.pii_masking else (conv, [])


def _unmask_quotes(results: dict[str, CriterionOutput], original: NormalizedConversation,
                   spans: list[pii.Span]) -> None:
    """Цитаты в карточке — по исходному тексту, чтобы подсветка реплики работала."""
    values: dict[str, str] = {}
    for sp in spans:
        m = original.message(sp.msg_id)
        if m and sp.placeholder not in values:
            values[sp.placeholder] = m.text[sp.start:sp.end]
    for r in results.values():
        for ev in r.evidence:
            q = ev.get("quote")
            if q and pii.PLACEHOLDER_RE.search(q):
                ev["quote"] = pii.PLACEHOLDER_RE.sub(lambda mm: values.get(mm.group(0), mm.group(0)), q)


def _facts(conv: NormalizedConversation, checklist: Checklist):
    from . import facts as facts_mod  # слой фактов; импорт здесь, чтобы ядро не зависело от него при тестах

    f = facts_mod.extract(conv, checklist.settings)
    return (
        {k: (v.model_dump() if hasattr(v, "model_dump") else v) for k, v in f.items()},
        facts_mod.render_for_prompt(f),
        facts_mod.boolean_facts(f),
    )


def evaluate_conversation(
    conv: NormalizedConversation,
    checklist: Checklist,
    provider,
    *,
    model: str | None = None,
    strategy: str = "grouped",
    seed: int | None = 7,
    criteria: list[Criterion] | None = None,
    facts_override: tuple[dict, str, dict] | None = None,
    reused: dict[str, CriterionOutput] | None = None,
    reused_overview: dict | None = None,
) -> EvalOutcome:
    """Оценивает диалог по включённым критериям (или по `criteria`).

    `reused` — готовые ответы из прошлой оценки (services/reuse.py): по ним вызовов нет,
    остальные критерии идут в вызовы по стратегии; страховки и баллы считаются по всем."""
    criteria = criteria if criteria is not None else checklist.enabled_criteria()
    reused = dict(reused or {})
    original = conv
    conv, masked_spans = _mask(conv)
    facts_json, facts_block, booleans = facts_override or _facts(conv, checklist)
    sections = {s.id: s.title for s in checklist.sections}
    pv = prompt_builder.prompt_version()
    context = prompt_builder.context_digest(conv, facts_block, checklist.settings, sections)
    model_name = model or getattr(provider, "default_model", "") or ""

    batches = partition([c for c in criteria if c.key not in reused], strategy)
    want_overview = reused_overview is None

    def run_batch(i: int, batch: list[Criterion]) -> judge.JudgeOutput:
        msgs, schema = prompt_builder.build(conv, facts_block, batch, checklist.settings, sections,
                                            include_overview=want_overview and i == 0)
        return judge.run(provider, msgs, schema, batch, conv, checklist.settings, model=model, seed=seed)

    outs: list[judge.JudgeOutput] = []
    if batches:
        with ThreadPoolExecutor(max_workers=len(batches)) as pool:
            outs = list(pool.map(lambda a: run_batch(*a), enumerate(batches)))

    results: dict[str, CriterionOutput] = {k: v for k, v in reused.items() if any(c.key == k for c in criteria)}
    issues: list[Issue] = []
    calls: list[CallRecord] = []
    overview = reused_overview
    for batch, out in zip(batches, outs):
        keys = [c.key for c in batch]
        results.update(out.results)
        issues.extend(out.issues)
        overview = overview or out.overview
        for n, res in enumerate(out.calls, start=1):
            calls.append(CallRecord(keys, res, n))
        if out.error and not out.calls:
            calls.append(CallRecord(keys, None, 1, out.error))

    if masked_spans:
        _unmask_quotes(results, original, masked_spans)
    issues.extend(guards.apply(results, booleans, criteria))
    answers = {k: r.answer for k, r in results.items() if r.answer is not None}
    score = scoring.compute(checklist, answers)

    answered = sum(1 for c in criteria if c.key in answers)
    status = "done" if answered == len(criteria) else ("partial" if answered else "failed")
    return EvalOutcome(
        results=results, score=score, facts=facts_json, overview=overview, calls=calls, issues=issues, status=status,
        prompt_version=pv, hashes={c.key: criterion_hash(c, pv, model_name, context) for c in criteria},
    )
