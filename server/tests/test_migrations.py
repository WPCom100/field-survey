from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from conftest import alembic_config
from sqlalchemy import create_engine, inspect

from app.db import Base


def test_upgrade_head_matches_models(engine):
    """The fresh DB built by `alembic upgrade head` has no drift from the models."""
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == []


def test_downgrade_then_upgrade(db_url):
    cfg = alembic_config(db_url)
    command.downgrade(cfg, "base")
    eng = create_engine(db_url)
    assert inspect(eng).get_table_names() == ["alembic_version"]
    command.upgrade(cfg, "head")
    assert set(inspect(eng).get_table_names()) == set(Base.metadata.tables) | {"alembic_version"}
    eng.dispose()
