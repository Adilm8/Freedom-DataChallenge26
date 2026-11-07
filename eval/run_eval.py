"""Прогон оценщика на gold-разметке DEV и метрики близости (FR-OPS-02, architecture/quality-eval.md).

    python eval/run_eval.py --provider gemini --split dev --limit 3          # бесплатная отладка (звонки пропускаются)
    python eval/run_eval.py --provider openrouter --model vendor/model --split dev --approved "Лида, 14:05"
    python eval/run_eval.py --metrics-only eval/runs/<файл>.json             # пересчитать метрики без вызовов
    python eval/run_eval.py ... --repeat 2                                     # стабильность (NFR-14)

Платные прогоны (OpenRouter) требуют `--approved` с отметкой, кто и когда разрешил (правило Лиды).
Эталон — `data/gold/gold_labels.json`; пока его нет, можно `--use-drafts` (черновик — только для отладки).
Результаты — `eval/runs/` (не в git).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import settings  # noqa: E402
from backend.app.domain import Checklist  # noqa: E402
from backend.app.providers import get_provider  # noqa: E402
from backend.app.services.evaluator import evaluate_conversation  # noqa: E402
from backend.app.services.normalize import normalize  # noqa: E402
from backend.app.services.prompt_builder import prompt_version  # noqa: E402
from eval.metrics import bootstrap_ci, calibration, compare, stability  # noqa: E402

GOLD_DIR = ROOT / "data" / "gold"
RUNS_DIR = ROOT / "eval" / "runs"


def load_gold(use_drafts: bool) -> dict[str, dict]:
    out: dict[str, dict] = {}
    labels = GOLD_DIR / "gold_labels.json"
    if labels.exists():
        for cid, item in json.loads(labels.read_text(encoding="utf-8")).get("items", {}).items():
            out[cid] = {"answers": {k: v["answer"] for k, v in item["criteria"].items()}, "total": item.get("total"),
                        "source": "gold"}
    if use_drafts:
        for f in sorted((GOLD_DIR / "drafts").glob("*.json")):
            d = json.loads(f.read_text(encoding="utf-8"))
            out.setdefault(d["conversation_id"], {"answers": {k: v["answer"] for k, v in d["criteria"].items()},
                                                  "total": d.get("total"), "source": "draft"})
    return out


def criteria_meta(cl: Checklist) -> dict[str, dict]:
    return {c.key: {"type": c.type, "scale": [s.value for s in c.scale] if c.scale else None} for c in cl.enabled_criteria()}


def run_once(records, cl, provider, model, strategy, checkpoint=None) -> tuple[dict, dict]:
    pred, details = {}, {}
    for rec in records:
        conv = normalize(rec)
        if conv.is_voice and not provider.allow_voice:
            print(f"  {conv.conversation_id}: пропущен — звонки не отправляются в {provider.name}")
            continue
        t0 = time.monotonic()
        out = evaluate_conversation(conv, cl, provider, model=model, strategy=strategy)
        answers = {k: r.answer for k, r in out.results.items() if r.answer is not None}
        pred[conv.conversation_id] = {
            "answers": answers, "total": out.score.total,
            "confidence": {k: r.confidence for k, r in out.results.items()},
        }
        details[conv.conversation_id] = {
            "status": out.status, "cost_usd": round(out.cost_usd, 6), "tokens": out.tokens,
            "seconds": round(time.monotonic() - t0, 1), "calls": len(out.calls),
            "retries": sum(1 for c in out.calls if c.attempt > 1), "needs_review": out.needs_review,
            "critical": out.score.critical, "overview": out.overview,
            "criteria": {k: {"answer": r.answer, "confidence": r.confidence, "reasoning": r.reasoning,
                             "evidence": r.evidence, "issues": r.issues} for k, r in out.results.items()},
        }
        print(f"  {conv.conversation_id}: итог {out.score.total} · {out.status} · ${out.cost_usd:.4f} · "
              f"{details[conv.conversation_id]['seconds']} с")
        if checkpoint:
            checkpoint(pred, details)
    return pred, details


def print_report(m: dict) -> None:
    t = m["total"]
    print(f"\nДиалогов: {m['dialogs']} · среднее согласие: {m['mean_agreement']} · MAE итога: {t['mae']} · "
          f"в пределах ±5: {t['within_5']} · ±10: {t['within_10']}")
    ci = m.get("ci95") or {}
    if ci.get("mean_agreement") or ci.get("mae"):
        print(f"95% ДИ (бутстреп, {ci['n_resamples']} выборок): согласие {ci.get('mean_agreement')} · MAE {ci.get('mae')}")
    for k, r in m["criteria"].items():
        extra = " ".join(f"{a}={r[a]}" for a in ("within_1_step", "recall", "precision") if a in r)
        print(f"  {k}: {r['exact']:.2f} (n={r['n']}) {extra}")
    for name in ("by_language", "by_channel"):
        print(f"  {name}: " + ", ".join(f"{g}: {v['agreement']} / MAE {v['mae']}" for g, v in m[name].items()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default=settings.llm_provider)
    ap.add_argument("--model")
    ap.add_argument("--strategy", default=settings.eval_strategy)
    ap.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only", nargs="*", help="conversation_id через пробел")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--use-drafts", action="store_true")
    ap.add_argument("--snapshot", default=str(ROOT / "data/raw/DEV.json"))
    ap.add_argument("--approved", help="кто и когда разрешил платный прогон")
    ap.add_argument("--metrics-only", help="пересчитать метрики сохранённого прогона без вызовов модели")
    ap.add_argument("--update", action="store_true",
                    help="с --metrics-only: записать пересчитанные метрики (с интервалами) обратно в файл прогона")
    args = ap.parse_args()

    cl = Checklist.model_validate(json.loads((ROOT / "data/checklists/default.json").read_text(encoding="utf-8")))
    gold = load_gold(args.use_drafts)

    if args.metrics_only:
        saved = json.loads(Path(args.metrics_only).read_text(encoding="utf-8"))
        m = compare(saved["pred"][0], gold, saved["meta"], criteria_meta(cl))
        m["ci95"] = bootstrap_ci(saved["pred"][0], gold, saved["meta"], criteria_meta(cl))
        print_report(m)
        if args.update:
            # обновляем только метрики эталона; стоимость, стабильность и калибровка остаются как были
            saved["metrics"] = {**saved.get("metrics", {}), **m}
            Path(args.metrics_only).write_text(json.dumps(saved, ensure_ascii=False, indent=2, default=str),
                                               encoding="utf-8")
            print(f"Обновлено: {args.metrics_only}")
        return

    if not gold:
        sys.exit("нет эталона: data/gold/gold_labels.json пуст (или добавьте --use-drafts для отладки)")
    provider = get_provider(args.provider)
    if provider.name == "openrouter" and not args.approved:
        sys.exit("платный прогон OpenRouter: укажите --approved \"кто и когда разрешил\" (правило Лиды)")

    ids = list(gold)
    split_file = GOLD_DIR / "split.json"
    if args.split != "all" and split_file.exists():
        allowed = set(json.loads(split_file.read_text(encoding="utf-8"))[args.split])
        ids = [i for i in ids if i in allowed]
    if args.only:
        ids = [i for i in ids if i in set(args.only)]
    ids = ids[: args.limit] if args.limit else ids

    records = {r["conversation_id"]: r for r in json.loads(Path(args.snapshot).read_text(encoding="utf-8"))["data"]["records"]}
    todo = [records[i] for i in ids if i in records]
    meta = {r["conversation_id"]: {"language": r["language"], "channel": r["channel"]} for r in todo}
    model = args.model or provider.default_model
    print(f"Прогон: {provider.name} / {model} / {args.strategy} · диалогов: {len(todo)} · повторов: {args.repeat}")

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = RUNS_DIR / f"{stamp}_{provider.name}_{(model or 'model').replace('/', '-')}_{args.strategy}_{args.split}.json"
    partial = out.with_suffix(".partial.json")

    preds, details_all = [], []

    def checkpoint(p, d):  # падение посреди платного прогона не теряет уже оплаченные ответы
        partial.write_text(json.dumps({"model": model, "strategy": args.strategy, "approved": args.approved,
                                       "meta": meta, "pred": preds + [p], "details": details_all + [d]},
                                      ensure_ascii=False, default=str), encoding="utf-8")

    for i in range(args.repeat):
        if args.repeat > 1:
            print(f"Повтор {i + 1}")
        p, d = run_once(todo, cl, provider, model, args.strategy, checkpoint)
        preds.append(p)
        details_all.append(d)

    metrics = compare(preds[0], gold, meta, criteria_meta(cl))
    metrics["calibration"] = calibration(preds[0], gold)
    metrics["ci95"] = bootstrap_ci(preds[0], gold, meta, criteria_meta(cl))
    if len(preds) > 1:
        metrics["stability"] = stability(preds[0], preds[1])
    cost = sum(d["cost_usd"] for ds in details_all for d in ds.values())
    secs = [d["seconds"] for d in details_all[0].values()]
    metrics["cost"] = {"total_usd": round(cost, 4),
                       "per_dialog_usd": round(cost / max(1, sum(len(ds) for ds in details_all)), 5),
                       "mean_seconds": round(sum(secs) / len(secs), 1) if secs else None}
    metrics["gold_source"] = sorted({gold[c]["source"] for c in preds[0] if c in gold})
    print_report(metrics)
    print(f"Стоимость: ${metrics['cost']['total_usd']} (≈ ${metrics['cost']['per_dialog_usd']} на диалог)")

    out.write_text(json.dumps({
        "created_at": stamp, "provider": provider.name, "model": model, "strategy": args.strategy, "split": args.split,
        "approved": args.approved, "prompt_version": prompt_version(),
        "metrics": metrics, "meta": meta, "pred": preds, "details": details_all,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    partial.unlink(missing_ok=True)
    print(f"Сохранено: {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
