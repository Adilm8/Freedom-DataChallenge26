"""Проверка подключения к провайдерам LLM и короткий тест моделей.

    python scripts/model_smoke.py --list                     # какие модели доступны (OpenRouter + Gemini)
    python scripts/model_smoke.py --models openrouter:vendor/model gemini:model-name
    python scripts/model_smoke.py --models ... --dialog p1-kz-001

Тест: модель получает один диалог и отвечает строгим JSON по критерию 01 (Установление контакта).
Печатается: ответ, валидность JSON, токены, задержка, стоимость (если провайдер её вернул).
Ключи берутся из .env и нигде не печатаются.
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from openai import OpenAI  # noqa: E402

from backend.app.config import settings  # noqa: E402

FAMILIES = ("anthropic/", "openai/", "google/", "qwen/", "deepseek/", "meta-llama/", "mistralai/", "x-ai/")


def client(provider: str) -> OpenAI:
    if provider == "openrouter":
        return OpenAI(base_url=settings.openrouter_base_url, api_key=settings.openrouter_api_key or "missing")
    if provider == "gemini":
        return OpenAI(base_url=settings.gemini_base_url, api_key=settings.gemini_api_key or "missing")
    if provider == "ollama":
        return OpenAI(base_url=settings.ollama_base_url, api_key="ollama")
    raise SystemExit(f"неизвестный провайдер: {provider}")


def list_models() -> None:
    print("== OpenRouter (цена за 1M токенов: вход / выход) ==")
    try:
        import httpx

        data = httpx.get(f"{settings.openrouter_base_url}/models", timeout=30).json()["data"]
        rows = []
        for m in data:
            if not m["id"].startswith(FAMILIES):
                continue
            p = m.get("pricing", {})
            sp = m.get("supported_parameters", [])
            rows.append((m["id"], float(p.get("prompt", 0)) * 1e6, float(p.get("completion", 0)) * 1e6,
                         "json_schema" if "structured_outputs" in sp else "", "temp" if "temperature" in sp else ""))
        for r in sorted(rows):
            print(f"{r[0]:60s} {r[1]:7.2f} / {r[2]:7.2f}  {r[3]} {r[4]}")
    except Exception as e:  # noqa: BLE001
        print("ошибка:", e)
    print("\n== Gemini ==")
    try:
        for m in client("gemini").models.list():
            print(m.id)
    except Exception as e:  # noqa: BLE001
        print("ошибка:", e)


SCHEMA = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "answer": {"type": "string", "enum": ["yes", "no"]},
        "evidence": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["reasoning", "answer", "evidence"],
    "additionalProperties": False,
}

SYSTEM = (
    "Ты оцениваешь работу оператора поддержки по одному критерию чек-листа. "
    "Реплики bot и system — контекст, оценивается только operator.\n"
    "Критерий 01 «Установление контакта»: Да — оператор поздоровался на языке клиента и представился "
    "в первом ответе. Иначе — Нет.\n"
    "Верни JSON: reasoning (кратко), answer (yes|no), evidence (id реплик вида m<idx>)."
)


def run(spec: str, dialog: dict) -> None:
    provider, model = spec.split(":", 1)
    lines = "\n".join(f"m{i} [{t['timestamp']}] {t['speaker']}: {t['text']}" for i, t in enumerate(dialog["transcript"]))
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Язык диалога: {dialog['language']}\n\n{lines}"}]
    c = client(provider)
    t0 = time.time()
    mode = "json_schema"
    try:
        resp = c.chat.completions.create(
            model=model, messages=messages, max_tokens=2000,
            response_format={"type": "json_schema", "json_schema": {"name": "crit", "strict": True, "schema": SCHEMA}},
        )
    except Exception as e:  # noqa: BLE001
        mode = f"json_object (json_schema не принят: {str(e)[:80]})"
        resp = c.chat.completions.create(model=model, messages=messages, max_tokens=2000,
                                         response_format={"type": "json_object"})
    dt = time.time() - t0
    ch = resp.choices[0]
    text = ch.message.content or ""
    try:
        parsed = json.loads(text)
        valid = isinstance(parsed, dict) and parsed.get("answer") in ("yes", "no")
    except json.JSONDecodeError:
        parsed, valid = text[:200], False
    u = resp.usage
    cost = getattr(u, "cost", None) if u else None
    print(f"\n== {spec} ==")
    print(f"режим: {mode} | finish: {ch.finish_reason} | {dt:.1f} c | токены: "
          f"{getattr(u, 'prompt_tokens', '?')} вход / {getattr(u, 'completion_tokens', '?')} выход | стоимость: {cost}")
    print(f"валидный JSON: {valid}")
    print(json.dumps(parsed, ensure_ascii=False, indent=2) if isinstance(parsed, dict) else parsed)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--models", nargs="*", default=[])
    ap.add_argument("--dialog", default="p1-kz-001")
    args = ap.parse_args()
    if args.list:
        list_models()
    if args.models:
        recs = json.loads((ROOT / "data" / "raw" / "DEV.json").read_text(encoding="utf-8"))["data"]["records"]
        dialog = next(r for r in recs if r["conversation_id"] == args.dialog)
        for spec in args.models:
            try:
                run(spec, dialog)
            except Exception as e:  # noqa: BLE001
                print(f"\n== {spec} ==\nошибка: {e}")


if __name__ == "__main__":
    main()
