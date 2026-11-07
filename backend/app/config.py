from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]
TEAM_NAME = "Data Mage"  # Q-17: название команды, подтверждено Лидой


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

    # Маскирование персональных данных перед отправкой в модель (services/pii.py)
    pii_masking: bool = True
    # При старте загрузить results/dev/results.json в БД, если у DEV нет оценок (без вызовов модели)
    autoload_results: bool = True

    # Сдача результатов (docs/task/results-format.md)
    # Локальные записи звонков (не в git): <audio_dir>/<conversation_id>.mp3 и т. п. Прокси записи кладёт сюда скачанное.
    audio_dir: Path = ROOT / "data" / "audio"

    team_name: str = TEAM_NAME  # пустой TEAM_NAME в .env (так было в старом шаблоне) не стирает название
    model_mode: str = "external_api"  # local | external_api | hybrid

    database_url: str = f"sqlite:///{ROOT / 'data' / 'cqa.db'}"

    @field_validator("team_name")
    @classmethod
    def _team_name(cls, v: str) -> str:
        return v.strip() or TEAM_NAME


settings = Settings()
