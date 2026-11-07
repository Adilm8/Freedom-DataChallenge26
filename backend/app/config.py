from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    organizer_api_url: str = ""
    dataset_group_id: str = "DEV"

    llm_provider: str = "openrouter"  # openrouter | gemini | ollama

    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = ""
    # Глубина рассуждений модели: none | low | medium | high; пусто — по умолчанию модели
    openrouter_reasoning_effort: str = "low"

    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    gemini_model: str = ""

    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_model: str = ""

    # Параллельность вызовов на провайдера и стратегия по умолчанию (ADR-002)
    openrouter_concurrency: int = 8
    gemini_concurrency: int = 2
    eval_strategy: str = "grouped"  # single | grouped | per_criterion

    # Сдача результатов (docs/task/results-format.md)
    team_name: str = ""
    model_mode: str = "external_api"  # local | external_api | hybrid

    database_url: str = f"sqlite:///{ROOT / 'data' / 'cqa.db'}"


settings = Settings()
