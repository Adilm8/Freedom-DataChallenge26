from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    organizer_api_url: str = ""
    dataset_group_id: str = "DEV"

    anthropic_api_key: str = ""
    cloud_model: str = "claude-opus-5-5"
    cloud_effort: str = "high"

    ollama_base_url: str = "http://localhost:11434"
    local_model: str = "qwen3:8b"

    llm_provider: str = "cloud"
    database_url: str = f"sqlite:///{ROOT / 'data' / 'cqa.db'}"


settings = Settings()
