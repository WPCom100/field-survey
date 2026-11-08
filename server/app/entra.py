"""Entra ID access tokens (T03, D264): RS256 JWTs signed by one of the tenant's published keys,
for this API's audience, from the configured issuer. Identity only, no roles (D8)."""

import json
import logging
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jwt

from app.config import settings

log = logging.getLogger("auth")

ALGORITHMS = ["RS256"]

Fetch = Callable[[str], dict[str, Any]]


class TokenError(Exception):
    """The bearer is not a valid access token for this API (→ 401)."""


class KeysUnavailable(Exception):
    """The tenant's signing keys could not be fetched and none cached fit (→ 503)."""


@dataclass(frozen=True)
class EntraIdentity:
    oid: str
    name: str
    email: str | None
    given_name: str | None


def _http_fetch(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=10) as r:  # the https URL from .env
        return json.load(r)


class Jwks:
    """The tenant's signing keys, cached. A `kid` not in the cache (Entra rolls its keys) or a
    set older than `ttl` refetches, at most once per `min_refresh` seconds once a fetch has
    succeeded. A failed refresh keeps serving the cached keys."""

    def __init__(
        self,
        url: str,
        fetch: Fetch = _http_fetch,
        ttl: float = 24 * 3600,
        min_refresh: float = 300,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.url = url
        self._fetch = fetch
        self._ttl = ttl
        self._min_refresh = min_refresh
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at: float | None = None
        self._tried_at: float | None = None
        self._lock = threading.Lock()

    def _load(self) -> dict[str, jwt.PyJWK]:
        try:
            data = self._fetch(self.url)
        except Exception as e:  # network, HTTP or JSON: all mean "no keys right now"
            raise KeysUnavailable(f"{type(e).__name__}: {e}") from e
        keys: dict[str, jwt.PyJWK] = {}
        for k in data.get("keys", []) if isinstance(data, dict) else []:
            if not isinstance(k, dict) or not k.get("kid") or k.get("kty") != "RSA":
                continue
            if k.get("use", "sig") != "sig":
                continue
            try:
                keys[k["kid"]] = jwt.PyJWK(k, algorithm="RS256")
            except (jwt.PyJWTError, ValueError, TypeError, KeyError):  # a malformed key
                continue
        return keys

    def key(self, kid: str) -> jwt.PyJWK:
        with self._lock:
            now = self._clock()
            due = (
                self._fetched_at is None
                or now - self._fetched_at >= self._ttl
                or kid not in self._keys
            )
            allowed = (
                self._fetched_at is None
                or self._tried_at is None
                or now - self._tried_at >= self._min_refresh
            )
            failed = False
            if due and allowed:
                self._tried_at = now
                try:
                    self._keys = self._load()
                    self._fetched_at = now
                except KeysUnavailable as e:
                    log.warning(json.dumps({"event": "jwks_unavailable", "error": str(e)}))
                    if self._fetched_at is None:
                        raise
                    failed = True
            key = self._keys.get(kid)
        if key is None:
            if failed:
                raise KeysUnavailable("signing keys could not be refreshed")
            raise TokenError("unknown signing key")
        return key


_jwks: Jwks | None = None
_jwks_lock = threading.Lock()


def jwks() -> Jwks:
    """The process-wide key cache for the configured JWKS URL."""
    global _jwks
    with _jwks_lock:
        if _jwks is None or _jwks.url != settings.entra_keys_url:
            _jwks = Jwks(settings.entra_keys_url)
        return _jwks


def configured() -> bool:
    """Issuer, audience and keys are all known; otherwise every bearer is refused (as an empty
    shared token refuses everything, D77)."""
    return bool(settings.entra_issuer_url and settings.entra_audiences and settings.entra_keys_url)


def _email(claims: dict[str, Any]) -> str | None:
    for claim in ("email", "preferred_username", "upn", "unique_name"):
        value = claims.get(claim)
        if isinstance(value, str) and "@" in value:
            return value.strip()
    return None


def verify(token: str) -> EntraIdentity:
    """The identity in a valid access token, else TokenError (or KeysUnavailable)."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as e:
        raise TokenError("not a JWT") from e
    if header.get("alg") not in ALGORITHMS:
        raise TokenError(f"algorithm {header.get('alg')!r} not accepted")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise TokenError("no key id")
    key = jwks().key(kid)
    try:
        claims = jwt.decode(
            token,
            key.key,
            algorithms=ALGORITHMS,
            audience=settings.entra_audiences,
            issuer=settings.entra_issuer_url,
            leeway=settings.entra_leeway_seconds,
            options={"require": ["exp", "iss", "aud", "oid"]},
        )
    except jwt.PyJWTError as e:
        raise TokenError(str(e)) from e
    oid = claims["oid"]
    if not isinstance(oid, str) or not oid.strip():
        raise TokenError("empty oid")
    email = _email(claims)
    name = claims.get("name")
    name = name.strip() if isinstance(name, str) and name.strip() else (email or oid)
    given = claims.get("given_name")
    given = given.strip() if isinstance(given, str) and given.strip() else None
    return EntraIdentity(oid=oid.strip(), name=name, email=email, given_name=given)
