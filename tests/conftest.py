import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.app import db
from backend.app.main import app
from backend.app.services import checklists


@pytest.fixture()
def client(tmp_path):
    eng = db.make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    db.init_db(eng)
    with Session(eng) as s:
        checklists.seed_default(s)

    def _session():
        with Session(eng) as s:
            yield s

    app.dependency_overrides[db.get_session] = _session
    yield TestClient(app)
    app.dependency_overrides.clear()
    eng.dispose()
