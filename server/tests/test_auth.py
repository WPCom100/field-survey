import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import auth, users
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


def test_unknown_auth_mode_is_refused(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "jwt")
    assert client.get("/team", headers=hdr()).status_code == 500
    assert client.get("/health").status_code == 200


def test_retired_people_stay_named_but_flagged(client, session):
    """D269: retired people stay in /team (history still names them) with `retired`; TEAM_NAMES
    listing them does not bring them back; adding the name in the picker does."""
    client.get("/team", headers=hdr())  # creates Ann and Bob from TEAM_NAMES
    assert users.set_retired(session, ["  bob "], True) == ["Bob: retired"]
    team = {m["name"]: m["retired"] for m in client.get("/team", headers=hdr()).json()}
    assert team == {"Ann": False, "Bob": True}
    assert users.set_retired(session, ["Bob"], True) == ["Bob: already retired"]
    # the edits keep their author: the row is the same and the header still resolves to it
    bob = session.scalars(select(User).where(User.name == "Bob")).one()
    assert client.get("/me", headers=hdr(user="Bob")).json()["id"] == str(bob.id)
    r = client.post("/team", json={"name": "bob"}, headers=hdr())
    assert r.status_code == 201 and r.json() == {"id": str(bob.id), "name": "Bob", "retired": False}
    assert not any(m["retired"] for m in client.get("/team", headers=hdr()).json())


def test_retire_cli_refuses_unknown_names_and_skips_system_users(client, session):
    client.get("/team", headers=hdr())
    auth.system_user(session, "import")
    session.commit()
    with pytest.raises(SystemExit, match="No such person: import, Zed"):
        users.set_retired(session, ["Ann", "import", "Zed"], True)
    session.expire_all()
    assert session.scalars(select(User).where(User.retired_at.is_not(None))).first() is None
    assert users.set_retired(session, ["Ann"], True) == ["Ann: retired"]
    ann = users.listing(session)[0].split("\t")
    assert ann[0] == "Ann" and ann[1].startswith("retired 20") and ann[2] == "team picker"
    assert users.set_retired(session, ["ann"], False) == ["Ann: restored"]
    assert [line.split("\t")[1] for line in users.listing(session)] == ["active", "active"]
