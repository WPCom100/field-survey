import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import auth
from app.config import settings
from app.main import app
from app.models import User

TOKEN = "test-token"


@pytest.fixture
def client(session, monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "token")
    monkeypatch.setattr(settings, "survey_shared_token", TOKEN)
    monkeypatch.setattr(settings, "team_names_csv", "Ann, Bob")
    app.dependency_overrides[auth.get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def hdr(token=TOKEN, user=None):
    h = {"Authorization": f"Bearer {token}"} if token else {}
    if user:
        h["X-Survey-User"] = user
    return h


def test_health_is_public(client):
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize("headers", [hdr(None), hdr("wrong"), {"Authorization": TOKEN}])
def test_token_missing_or_wrong(client, headers):
    assert client.get("/team", headers=headers).status_code == 401
    assert client.get("/me", headers={**headers, "X-Survey-User": "Ann"}).status_code == 401


def test_empty_configured_token_rejects_everything(client, monkeypatch):
    monkeypatch.setattr(settings, "survey_shared_token", "")
    assert client.get("/team", headers=hdr("")).status_code == 401


def test_team_lists_configured_names(client, session):
    r = client.get("/team", headers=hdr())
    assert [m["name"] for m in r.json()] == ["Ann", "Bob"]
    assert client.get("/team", headers=hdr()).json() == r.json()  # idempotent
    assert session.scalars(select(User).where(User.entra_oid.is_not(None))).first() is None


def test_user_header_upserts_once(client, session):
    first = client.get("/me", headers=hdr(user="Cara")).json()
    again = client.get("/me", headers=hdr(user="  cara ")).json()
    assert first["id"] == again["id"]
    users = session.scalars(select(User).where(User.name == "Cara")).all()
    assert len(users) == 1 and users[0].entra_oid is None and users[0].last_seen


def test_user_header_required(client):
    assert client.get("/me", headers=hdr()).status_code == 400


def test_add_team_member(client):
    assert client.post("/team", json={"name": "Dee"}, headers=hdr()).status_code == 201
    assert "Dee" in [m["name"] for m in client.get("/team", headers=hdr()).json()]


def test_entra_mode_not_yet_available(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "entra")
    assert client.get("/team", headers=hdr()).status_code == 501
