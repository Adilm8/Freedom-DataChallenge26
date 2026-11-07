"""Контроль одной командой (FR-EXP-04, docs/task/results-format.md).

    python scripts/control.py --group <id> --target prod --expect-count 10 --approved "Лида, 23:05"
    python scripts/control.py --file data/raw/CTRL.json --group CTRL --target prod --expect-count 10 --approved "…"
    python scripts/control.py --group DEV --target dev --approved "…"            # DEV-файл, все 65 диалогов
    python scripts/control.py --group <id> --target prod --expect-count 10 --reuse auto --approved "…"  # повтор после сбоя

`--version <id>` — оценить по этой версии чек-листа, а не по активной. До импорта и вызовов скрипт проверяет, что
версия ложится в формат сдачи (8 кодов организаторов, допустимые значения), иначе выходит с объяснением.

Шаги: набор из API организаторов (или файла) → снапшот `data/raw/<group>.json` → импорт с исходными ID →
оценка всех диалогов → повтор неудачных (`reuse: auto` дозапрашивает только недостающие критерии) →
`results/<target>/results.json` → проверка. Commit и push — вручную, сразу после (их требуют до стоп-кода).
Платный провайдер — только с `--approved` (правило Лиды).
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlmodel import Session, select  # noqa: E402

from backend.app import db  # noqa: E402
from backend.app.config import settings  # noqa: E402
from backend.app.domain import Checklist  # noqa: E402
from backend.app.models import ChecklistVersion, Conversation, Evaluation, EvaluationRun  # noqa: E402
from backend.app.providers import configured_models  # noqa: E402
from backend.app.services import checklists, evaluations, ingest, results_export, runs  # noqa: E402


def latest_ok(session: Session, pks: list[int], version_id: int) -> set[int]:
    done = session.exec(select(Evaluation.conversation_pk).where(
        Evaluation.conversation_pk.in_(pks), Evaluation.checklist_version_id == version_id, Evaluation.status == "done"))
    return set(done)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", required=True, help="group_id набора (сохраняется в БД как есть)")
    ap.add_argument("--file", type=Path, help="набор из файла вместо API")
    ap.add_argument("--target", choices=["dev", "prod"], required=True)
    ap.add_argument("--provider", default=settings.llm_provider)
    ap.add_argument("--model")
    ap.add_argument("--strategy", default=settings.eval_strategy)
    ap.add_argument("--team", default=settings.team_name)
    ap.add_argument("--mode", default=settings.model_mode, choices=results_export.MODES)
    ap.add_argument("--expect-count", type=int)
    ap.add_argument("--retries", type=int, default=1)
    ap.add_argument("--skip-import", action="store_true", help="набор уже в БД")
    ap.add_argument("--version", type=int, help="id версии чек-листа (по умолчанию активная)")
    ap.add_argument("--reuse", choices=evaluations.REUSE_MODES, default="none",
                    help="auto — ответы с тем же хешем (модель, промпт, транскрипт, критерий) взять из прошлых оценок "
                         "без вызовов: повторный запуск после сбоя не платит второй раз")
    ap.add_argument("--approved", help="кто и когда разрешил платный прогон")
    args = ap.parse_args()

    if not args.team:
        sys.exit("укажите --team или TEAM_NAME в .env")
    if args.provider == "openrouter" and not args.approved:
        sys.exit("платный прогон OpenRouter: укажите --approved \"кто и когда разрешил\" (правило Лиды)")
    model = args.model or {m["provider"]: m["model"] for m in configured_models()}.get(args.provider)
    if not model:
        sys.exit(f"у провайдера {args.provider} не задана модель")
    t0 = time.monotonic()

    db.init_db()
    raw = ROOT / "data" / "raw" / f"{args.group}.json"
    with Session(db.engine) as s:
        checklists.seed_default(s)
        ver = s.get(ChecklistVersion, args.version) if args.version else checklists.get_active(s)
        if not ver:
            sys.exit(f"нет версии чек-листа с id {args.version}")
        # до любого платного вызова: файл по этой версии должен пройти проверку формата организаторов
        issues = results_export.format_issues(Checklist.model_validate(ver.body))
        if issues:
            sys.exit(f"чек-лист v{ver.version} (id {ver.id}) не ложится в формат сдачи, файл не пройдёт проверку:\n  "
                     + "\n  ".join(issues) + "\nВыберите другую версию (--version <id>) или поправьте критерий в редакторе"
                     " (код в файле сдачи, N/A, ступени шкалы).")
        print(f"чек-лист: v{ver.version} (id {ver.id}){'' if ver.is_active else ' — НЕ активная'}"
              f"{f' · «{ver.note}»' if ver.note else ''}")
        skipped: dict[str, str] = {}
        if not args.skip_import:
            try:
                payload = (json.loads(args.file.read_text(encoding="utf-8-sig")) if args.file
                           else ingest.fetch_payload(args.group))
                rep = ingest.import_payload(s, payload, "file" if args.file else "api", group_id=args.group)
            except (ingest.IngestError, ValueError) as e:  # текст ошибки API может повторить адрес с подписью
                sys.exit(f"импорт не выполнен: {ingest.scrub(str(e))}")
            raw.parent.mkdir(parents=True, exist_ok=True)  # снапшот — только удачного ответа API
            raw.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            skipped = rep["skipped"]
            print(f"импорт: {rep['imported']} новых, {rep['updated']} обновлено, пропущено {len(skipped)}, "
                  f"предупреждений {len(rep['warnings'])}")
            for w in rep["warnings"]:
                print(f"  {w}")
        else:
            payload = json.loads(raw.read_text(encoding="utf-8")) if raw.exists() else None
        expected = ingest.payload_ids(payload) if payload else None
        pks = list(s.exec(select(Conversation.id).where(Conversation.group_id == args.group, Conversation.source != "manual")))
        if not pks:
            sys.exit("в группе нет диалогов")
        print(f"оценка: {len(pks)} диалогов · {args.provider} / {model} / {args.strategy} · чек-лист v{ver.version}"
              f"{' · reuse auto' if args.reuse == 'auto' else ''}")
        run_id = runs.run_sync(s, pks, group_id=args.group, checklist_version_id=ver.id, provider=args.provider,
                               model=model, strategy=args.strategy, reuse=args.reuse)
        cost = s.get(EvaluationRun, run_id).cost_usd
        for i in range(args.retries):
            s.expire_all()
            left = [pk for pk in pks if pk not in latest_ok(s, pks, ver.id)]
            if not left:
                break
            print(f"повтор {i + 1}: {len(left)} диалогов без полной оценки")
            rid = runs.run_sync(s, left, group_id=args.group, checklist_version_id=ver.id, provider=args.provider,
                                model=model, strategy=args.strategy, reuse="auto")
            cost += s.get(EvaluationRun, rid).cost_usd
        s.expire_all()
        doc = results_export.build(s, args.group, team_name=args.team, mode=args.mode, checklist_version_id=ver.id,
                                   expected_ids=expected, skipped=skipped)
        ids = expected or list(s.exec(select(Conversation.conversation_id).where(Conversation.group_id == args.group,
                                                                 Conversation.source != "manual")))
        errs = results_export.validate(doc, expected_ids=ids, expected_count=args.expect_count)

    out = ROOT / "results" / args.target / "results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ok = sum(r["status"] == "ok" for r in doc["results"])
    print(f"готово за {time.monotonic() - t0:.0f} с · ${cost:.4f} · ok {ok} из {len(doc['results'])} · {out.relative_to(ROOT)}")
    for r in doc["results"]:
        if r["status"] == "error":
            print(f"  {r['conversation_id']}: {r['error']}")
    if errs:
        print("ОШИБКИ ПРОВЕРКИ:\n  " + "\n  ".join(errs))
        sys.exit(1)
    print(f"проверка пройдена. Дальше: git add {out.relative_to(ROOT)} && git commit && git push")


if __name__ == "__main__":
    main()
