"""Entra sign-in (T03, D264): tokens signed here with a local RSA key, keys served by a fake
JWKS fetch; no network."""

import json
import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from sqlalchemy import select

from app import auth, entra
from app.config import settings
from app.main import app
from app.models import User

TENANT = "11111111-2222-3333-4444-555555555555"
AUDIENCE = "api://field-survey"
ISSUER = f"https://login.microsoftonline.com/{TENANT}/v2.0"
KEYS_URL = f"https://login.microsoftonline.com/{TENANT}/discovery/v2.0/keys"
SHARED = "shared-token"
OID = "aaaaaaaa-0000-0000-0000-000000000001"


def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


KEY = rsa_key()
OTHER_KEY = rsa_key()


def jwk(private_key, kid):
    d = json.loads(RSAAlgorithm.to_jwk(private_key.public_key()))
    return {**d, "kid": kid, "use": "sig"}


class FakeJwks:
    """What the tenant publishes; counts fetches; can be made to fail."""

    def __init__(self, *keys):
        self.keys = list(keys)
        self.calls = 0
        self.down = False

    def __call__(self, url):
        assert url == KEYS_URL
        self.calls += 1
        if self.down:
            raise OSError("network unreachable")
        return {"keys": self.keys}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def token(key=KEY, kid="k1", alg="RS256", **overrides):
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": now,
        "nbf": now,
        "exp": now + 3600,
        "oid": OID,
        "tid": TENANT,
        "name": "Landry Smith",
        "preferred_username": "landry@ltp.example",
        "scp": "access",
    }
    claims.update(overrides)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


def bearer(t, user=None):
    h = {"Authorization": f"Bearer {t}"}
    if user:
        h["X-Survey-User"] = user
    return h


@pytest.fixture
def keys(monkeypatch):
    fake = FakeJwks(jwk(KEY, "k1"))
    clock = Clock()
    monkeypatch.setattr(entra, "_jwks", entra.Jwks(KEYS_URL, fetch=fake, clock=clock))
    fake.clock = clock
    return fake


@pytest.fixture
def client(session, monkeypatch, keys):
    monkeypatch.setattr(settings, "auth_mode", "entra")
    monkeypatch.setattr(settings, "survey_shared_token", SHARED)
    monkeypatch.setattr(settings, "team_names_csv", "")
    monkeypatch.setattr(settings, "entra_tenant_id", TENANT)
    monkeypatch.setattr(
        settings, "entra_audience", f"{AUDIENCE}, 99999999-0000-0000-0000-000000000000"
    )
    monkeypatch.setattr(settings, "entra_issuer", "")
    monkeypatch.setattr(settings, "entra_jwks_url", "")
    app.dependency_overrides[auth.get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def interim(session, name):
    return auth.upsert_user(session, name)


# --- token validation -------------------------------------------------------------------------


def test_health_stays_public(client):
    assert client.get("/health").status_code == 200


def test_valid_token_upserts_user(client, session):
    first = client.get("/me", headers=bearer(token()))
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["name"] == "Landry Smith" and body["email"] == "landry@ltp.example"
    again = client.get("/me", headers=bearer(token(email="l.smith@ltp.example"))).json()
    assert again["id"] == body["id"] and again["email"] == "l.smith@ltp.example"
    rows = session.scalars(select(User).where(User.entra_oid == OID)).all()
    assert len(rows) == 1 and rows[0].last_seen


def test_second_audience_accepted(client):
    t = token(aud="99999999-0000-0000-0000-000000000000")
    assert client.get("/me", headers=bearer(t)).status_code == 200


def test_defaults_from_tenant():
    s = settings.model_copy(
        update={"entra_tenant_id": TENANT, "entra_issuer": "", "entra_jwks_url": ""}
    )
    assert s.entra_issuer_url == ISSUER and s.entra_keys_url == KEYS_URL


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(lambda: token(exp=int(time.time()) - 600), id="expired"),
        pytest.param(lambda: token(nbf=int(time.time()) + 600), id="not-yet-valid"),
        pytest.param(lambda: token(aud="api://someone-else"), id="audience"),
        pytest.param(
            lambda: token(iss="https://login.microsoftonline.com/other/v2.0"), id="issuer"
        ),
        pytest.param(lambda: token(key=OTHER_KEY), id="wrong-signature"),
        pytest.param(lambda: token(oid=None), id="no-oid"),
        pytest.param(lambda: token(oid=" "), id="empty-oid"),
        pytest.param(lambda: token(exp=None), id="no-exp"),
        pytest.param(lambda: token(kid="nope"), id="unknown-kid"),
        pytest.param(lambda: token(key=SHARED * 4, alg="HS256"), id="hs256"),
        pytest.param(
            lambda: jwt.encode(
                {"oid": OID, "aud": AUDIENCE, "iss": ISSUER}, None, algorithm="none"
            ),
            id="alg-none",
        ),
        pytest.param(lambda: "not.a.jwt", id="garbage"),
        pytest.param(lambda: SHARED, id="shared-token-in-entra-mode"),
    ],
)
def test_bad_tokens_rejected(client, bad):
    r = client.get("/me", headers=bearer(bad()))
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Bearer")
    assert client.get("/team", headers=bearer(bad())).status_code == 401


def test_missing_header_rejected(client):
    assert client.get("/me").status_code == 401
    assert client.get("/team", headers={"Authorization": token()}).status_code == 401


def test_leeway_tolerates_small_clock_skew(client):
    assert client.get("/me", headers=bearer(token(exp=int(time.time()) - 30))).status_code == 200


@pytest.mark.parametrize("field", ["entra_audience", "entra_tenant_id"])
def test_unconfigured_rejects_everything(client, monkeypatch, field):
    monkeypatch.setattr(settings, field, "")
    assert client.get("/me", headers=bearer(token())).status_code == 401


def test_routers_accept_entra_token(client):
    assert client.get("/team", headers=bearer(token())).status_code == 200


# --- key cache ---------------------------------------------------------------------------------


def test_keys_cached_between_requests(client, keys):
    for _ in range(3):
        assert client.get("/me", headers=bearer(token())).status_code == 200
    assert keys.calls == 1


def test_rolled_key_is_fetched(client, keys):
    assert client.get("/me", headers=bearer(token())).status_code == 200
    keys.keys.append(jwk(OTHER_KEY, "k2"))
    keys.clock.now += 301
    assert client.get("/me", headers=bearer(token(key=OTHER_KEY, kid="k2"))).status_code == 200
    assert keys.calls == 2


def test_unknown_kid_refetch_is_rate_limited(client, keys):
    assert client.get("/me", headers=bearer(token())).status_code == 200
    for _ in range(3):
        assert client.get("/me", headers=bearer(token(kid="nope"))).status_code == 401
    assert keys.calls == 1  # within min_refresh of the last fetch: no new fetch
    keys.clock.now += 301
    assert client.get("/me", headers=bearer(token(kid="nope"))).status_code == 401
    assert keys.calls == 2


def test_keys_unreachable_is_503(client, keys):
    keys.down = True
    assert client.get("/me", headers=bearer(token())).status_code == 503


def test_failed_refresh_keeps_cached_keys(client, keys):
    assert client.get("/me", headers=bearer(token())).status_code == 200
    keys.down = True
    keys.clock.now += 24 * 3600 + 1  # stale: a refresh is due and fails
    assert client.get("/me", headers=bearer(token())).status_code == 200
    keys.clock.now += 301
    assert client.get("/me", headers=bearer(token(kid="k9"))).status_code == 503


def test_jwks_skips_unusable_keys():
    fake = FakeJwks(
        {"kid": "enc", "kty": "RSA", "use": "enc", "n": "x", "e": "AQAB"},
        {"kid": "ec", "kty": "EC", "crv": "P-256", "x": "x", "y": "y"},
        {"kty": "RSA", "n": "x", "e": "AQAB"},
        {"kid": "broken", "kty": "RSA", "n": "!!", "e": "!!"},
        jwk(KEY, "k1"),
    )
    cache = entra.Jwks(KEYS_URL, fetch=fake)
    assert cache.key("k1")
    with pytest.raises(entra.TokenError):
        cache.key("enc")


# --- first sign-in and the interim merge ------------------------------------------------------


def test_first_sign_in_without_candidate_creates_user(client, session):
    interim(session, "Wiley")
    r = client.get("/me", headers=bearer(token()))
    assert r.status_code == 200
    assert r.json()["name"] == "Landry Smith"


@pytest.mark.parametrize(
    ("names", "header", "claims", "expect"),
    [
        (["Landry", "Zach"], "Landry", {}, "Landry"),  # the name the iPad was using
        (["Landry", "Zach"], "ZACH", {}, "Zach"),  # header wins over the token's name
        (["Landry", "Zach"], None, {}, "Landry"),  # first word of the display name
        (["Landry Smith", "Landry"], None, {}, "Landry Smith"),  # full name before first name
        (["Lan", "Zach"], None, {"given_name": "Lan"}, "Lan"),  # given_name claim
        (["Landry", "Zach"], "Nobody", {}, "Landry"),  # unknown header name: fall back
    ],
)
def test_merge_candidate(client, session, names, header, claims, expect):
    users = {n: interim(session, n) for n in names}
    r = client.get("/me", headers=bearer(token(**claims), user=header))
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "merge_pending"
    assert detail["merge_candidate"] == {"id": str(users[expect].id), "name": expect}
    assert detail["name"] == "Landry Smith" and detail["email"] == "landry@ltp.example"
    assert session.scalars(select(User).where(User.entra_oid == OID)).first() is None


def test_other_routes_wait_for_the_merge(client, session):
    interim(session, "Landry")
    r = client.post("/projects", json={"name": "P"}, headers=bearer(token()))
    assert r.status_code == 409 and r.json()["detail"]["error"] == "merge_pending"


def test_merge_adopts_the_interim_row(client, session):
    landry = interim(session, "Landry")
    r = client.post("/me/merge", json={"user_id": str(landry.id)}, headers=bearer(token()))
    assert r.status_code == 200, r.text
    assert r.json() == {"id": str(landry.id), "name": "Landry", "email": "landry@ltp.example"}
    session.refresh(landry)
    assert landry.entra_oid == OID
    # signed in from now on, same id; a retry of the same choice is harmless
    assert client.get("/me", headers=bearer(token())).json()["id"] == str(landry.id)
    again = client.post("/me/merge", json={"user_id": str(landry.id)}, headers=bearer(token()))
    assert again.status_code == 200 and again.json()["id"] == str(landry.id)
    # but not a different choice
    zach = interim(session, "Zach")
    other = client.post("/me/merge", json={"user_id": str(zach.id)}, headers=bearer(token()))
    assert other.status_code == 409 and other.json()["detail"]["error"] == "already_signed_in"


def test_decline_starts_a_new_user(client, session):
    landry = interim(session, "Landry")
    r = client.post("/me/merge", json={"user_id": None}, headers=bearer(token()))
    assert r.status_code == 200
    assert r.json()["id"] != str(landry.id) and r.json()["name"] == "Landry Smith"
    assert client.get("/me", headers=bearer(token())).json()["id"] == r.json()["id"]
    session.refresh(landry)
    assert landry.entra_oid is None


def test_merge_target_must_be_an_interim_user(client, session):
    system = auth.system_user(session, "import")
    session.commit()
    signed = User(entra_oid="bbbbbbbb-0000-0000-0000-000000000002", name="Zach")
    session.add(signed)
    session.commit()
    for target, status in ((system.id, 409), (signed.id, 409), (uuid.uuid4(), 404)):
        r = client.post("/me/merge", json={"user_id": str(target)}, headers=bearer(token()))
        assert r.status_code == status


def test_signed_in_users_are_never_candidates(client, session):
    session.add(User(entra_oid="bbbbbbbb-0000-0000-0000-000000000002", name="Landry"))
    session.commit()
    assert client.get("/me", headers=bearer(token(), user="Landry")).status_code == 200


def test_merge_needs_a_microsoft_sign_in(client, monkeypatch, session):
    monkeypatch.setattr(settings, "auth_mode", "both")
    landry = interim(session, "Landry")
    r = client.post("/me/merge", json={"user_id": str(landry.id)}, headers=bearer(SHARED))
    assert r.status_code == 400


# --- AUTH_MODE=both and token ------------------------------------------------------------------


def test_both_accepts_either(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "both")
    assert client.get("/me", headers=bearer(SHARED, user="Wiley")).json()["name"] == "Wiley"
    assert client.get("/me", headers=bearer(token())).json()["name"] == "Landry Smith"
    assert client.get("/me", headers=bearer("wrong", user="Wiley")).status_code == 401
    assert client.get("/me", headers=bearer(token(key=OTHER_KEY))).status_code == 401


def test_token_mode_ignores_entra_tokens(client, monkeypatch, keys):
    monkeypatch.setattr(settings, "auth_mode", "token")
    assert client.get("/me", headers=bearer(token(), user="Ann")).status_code == 401
    assert keys.calls == 0


def test_merged_user_keeps_its_name_for_the_picker(client, monkeypatch, session):
    """An iPad still on the shared token (AUTH_MODE=both) that picks the merged name gets the
    merged row, and the .env team list does not recreate it as an interim user."""
    landry = interim(session, "Landry")
    client.post("/me/merge", json={"user_id": str(landry.id)}, headers=bearer(token()))
    monkeypatch.setattr(settings, "auth_mode", "both")
    monkeypatch.setattr(settings, "team_names_csv", "Landry, Zach")
    team = client.get("/team", headers=bearer(SHARED)).json()
    assert [m["name"] for m in team] == ["Landry", "Zach"]
    picked = client.post("/team", json={"name": "landry"}, headers=bearer(SHARED)).json()
    assert picked["id"] == str(landry.id)
    me = client.get("/me", headers=bearer(SHARED, user="Landry")).json()
    assert me["id"] == str(landry.id) and me["email"] == "landry@ltp.example"
