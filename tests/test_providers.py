"""Провайдер LLM без сети: httpx.MockTransport вместо API (FR-EVAL-06, 10; llm-and-models.md §1)."""

import json

import httpx
import pytest

from backend.app.providers.base import ProviderError, ProviderPolicyError
from backend.app.providers.openai_compat import OpenAICompatProvider

SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"], "additionalProperties": False}


def completion(content: str, finish: str = "stop", usage: dict | None = None, model: str = "vendor/model-a") -> dict:
    return {
        "id": "gen-1", "object": "chat.completion", "created": 0, "model": model,
        "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}],
        "usage": usage or {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
    }


def make(handler, **kw) -> tuple[OpenAICompatProvider, list]:
    seen: list = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": kw.pop("_models", [])})
        seen.append(json.loads(request.content))
        return handler(request, len(seen))

    models = kw.pop("models", [])
    def h(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"object": "list", "data": models})
        seen.append(json.loads(request.content))
        return handler(request, len(seen))

    p = OpenAICompatProvider(
        kw.pop("name", "openrouter"), base_url="https://llm.test/api/v1", default_model="vendor/model-a",
        http_client=httpx.Client(transport=httpx.MockTransport(h)), sleep=lambda s: None, **kw,
    )
    return p, seen


def test_openrouter_strict_schema_and_cost_from_usage():
    usage = {"prompt_tokens": 1000, "completion_tokens": 50, "total_tokens": 1050, "cost": 0.0021,
             "prompt_tokens_details": {"cached_tokens": 800}}
    p, seen = make(lambda r, n: httpx.Response(200, json=completion('{"x": "ok"}', usage=usage)), is_openrouter=True)
    res = p.complete([{"role": "user", "content": "hi"}], json_schema=SCHEMA, seed=7)
    body = seen[0]
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["provider"] == {"require_parameters": True}
    assert body["temperature"] == 0 and body["seed"] == 7
    assert res.parsed == {"x": "ok"}
    assert (res.tokens_in, res.tokens_out, res.cached_tokens, res.cost_usd) == (1000, 50, 800, 0.0021)
    assert res.request["response_format"] == {"type": "json_schema"}


def test_temperature_and_schema_dropped_when_model_does_not_support_them():
    models = [{"id": "vendor/model-a", "supported_parameters": ["max_tokens"],
               "pricing": {"prompt": "0.000001", "completion": "0.000002"}}]
    p, seen = make(lambda r, n: httpx.Response(200, json=completion('{"x": "ok"}')), is_openrouter=True, models=models)
    res = p.complete([{"role": "user", "content": "hi"}], json_schema=SCHEMA, seed=1)
    body = seen[0]
    assert "temperature" not in body and "seed" not in body
    assert body["response_format"] == {"type": "json_object"}
    # стоимости в usage нет → по таблице цен: 100 × 1e-6 + 20 × 2e-6
    assert res.cost_usd == pytest.approx(0.00014)


def test_retries_on_429_then_succeeds():
    def handler(r, n):
        return httpx.Response(429, json={"error": {"message": "rate"}}) if n < 3 else httpx.Response(200, json=completion('{"x": "1"}'))
    p, seen = make(handler)
    res = p.complete([{"role": "user", "content": "hi"}])
    assert len(seen) == 3 and res.attempts == 3


def test_gives_up_after_retries_and_does_not_retry_400():
    p, seen = make(lambda r, n: httpx.Response(503, json={"error": {"message": "down"}}))
    with pytest.raises(ProviderError):
        p.complete([{"role": "user", "content": "hi"}])
    assert len(seen) == 4
    p2, seen2 = make(lambda r, n: httpx.Response(400, json={"error": {"message": "bad"}}))
    with pytest.raises(ProviderError):
        p2.complete([{"role": "user", "content": "hi"}])
    assert len(seen2) == 2                                 # 400 не ретраится; один повтор — без sampling-параметров
    assert "temperature" in seen2[0] and "temperature" not in seen2[1]


def test_sampling_params_dropped_when_model_rejects_them():
    def h(r, n):
        body = json.loads(r.content)
        if "temperature" in body:
            return httpx.Response(400, json={"error": {"message": "temperature is not supported"}})
        return httpx.Response(200, json=completion('{"x": "a"}'))

    p, seen = make(h)
    res = p.complete([{"role": "user", "content": "hi"}], seed=7)
    assert res.parsed == {"x": "a"} and "temperature" not in res.request and "seed" not in res.request


def test_free_gemini_refuses_voice_calls():
    p, seen = make(lambda r, n: httpx.Response(200, json=completion("{}")), name="gemini", allow_voice=False, free=True)
    with pytest.raises(ProviderPolicyError):
        p.complete([{"role": "user", "content": "hi"}], channel="voice call")
    assert seen == []
    res = p.complete([{"role": "user", "content": "hi"}], channel="agent chat")
    assert res.cost_usd == 0.0


def test_truncation_and_fenced_json():
    p, _ = make(lambda r, n: httpx.Response(200, json=completion('```json\n{"x": "a"}\n```', finish="length")))
    res = p.complete([{"role": "user", "content": "hi"}])
    assert res.truncated and res.parsed == {"x": "a"}
