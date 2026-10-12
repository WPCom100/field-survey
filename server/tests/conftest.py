import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app import auth
from app.config import settings
from app.main import app
from app.storage import MemoryObjectStore, get_object_store

TOKEN = "test-token"
HDR = {"Authorization": f"Bearer {TOKEN}"}

SERVER_DIR = __import__("pathlib").Path(__file__).resolve().parents[1]


def alembic_config(url: str) -> Config:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "alembic"))
    cfg.attributes["url"] = url
    cfg.attributes["configure_logger"] = False
    return cfg


@pytest.fixture(scope="session")
def db_url() -> str:
    """A fresh `<db>_test` database built by `alembic upgrade head`.

    Needs Postgres (docker compose up -d postgres, or the CI service). Fails loudly if absent.
    """
    base = make_url(settings.database_url)
    test_url = base.set(database=f"{base.database}_test")
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{test_url.database}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{test_url.database}"'))
    url = test_url.render_as_string(hide_password=False)
    command.upgrade(alembic_config(url), "head")
    yield url
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{test_url.database}" WITH (FORCE)'))
    admin.dispose()


@pytest.fixture(scope="session")
def engine(db_url):
    eng = create_engine(db_url)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    """Commits are real (deferred FKs are checked at commit); every table is emptied after."""
    with Session(engine) as s:
        yield s
    with engine.begin() as conn:
        tables = conn.execute(
            text(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
                " AND tablename <> 'alembic_version'"
            )
        ).scalars()
        conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " CASCADE"))


@pytest.fixture
def client(session, monkeypatch):
    """The API in token mode, bound to the test session (commits are the route's)."""
    monkeypatch.setattr(settings, "auth_mode", "token")
    monkeypatch.setattr(settings, "survey_shared_token", TOKEN)
    app.dependency_overrides[auth.get_session] = lambda: session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


@pytest.fixture
def store():
    """An in-memory object store bound to the API (blobs, imports, exports)."""
    s = MemoryObjectStore()
    app.dependency_overrides[get_object_store] = lambda: s
    yield s
    app.dependency_overrides.pop(get_object_store, None)


@pytest.fixture
def factory(engine):
    """A session factory for the job runners (each job opens its own sessions)."""
    return lambda: Session(engine)
