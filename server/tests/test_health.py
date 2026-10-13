from sqlalchemy import text

from app.config import settings


def test_health_reports_commit_and_migration(client, session, monkeypatch):
    monkeypatch.setattr(settings, "git_sha", "abc1234")
    head = session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "commit": "abc1234", "migration": head}
