"""Подключение к SQLite и сессии для FastAPI."""
from __future__ import annotations

from pathlib import Path
from typing import Iterator

from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from .config import settings


def make_engine(url: str | None = None) -> Engine:
    url = url or settings.database_url
    kwargs: dict = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        path = url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
    return create_engine(url, **kwargs)


engine = make_engine()


def init_db(eng: Engine | None = None) -> None:
    from . import models  # noqa: F401  (регистрирует таблицы)

    SQLModel.metadata.create_all(eng or engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
