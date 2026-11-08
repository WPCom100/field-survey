"""Request identity (D69, D77, D264).

AUTH_MODE=token: the shared token from .env, the user named by `X-Survey-User` (interim).
AUTH_MODE=entra: an Entra ID access token (`app.entra`); the user is keyed by its `oid`.
AUTH_MODE=both: either, while the iPads move to the sign-in build.

A first Microsoft sign-in whose interim user can be found (`merge_candidate`) is held at
409 `merge_pending` until the iPad confirms with `POST /me/merge`, which adopts that interim row
(same id, so every op keeps its author) or starts a new one.
"""

import hmac
import json
import logging
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import entra
from app.config import settings
from app.db import SessionLocal
from app.entra import EntraIdentity
from app.models import User

log = logging.getLogger("auth")

AUTH_MODES = ("token", "entra", "both")


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


@dataclass(frozen=True)
class Principal:
    """What the bearer proved: the shared token (`entra` None) or an Entra identity."""

    entra: EntraIdentity | None = None


def _unauthorized(error: str | None = None) -> HTTPException:
    challenge = f'Bearer error="{error}"' if error else "Bearer"
    return HTTPException(401, "Missing or invalid token", {"WWW-Authenticate": challenge})


def _is_shared_token(supplied: str) -> bool:
    expected = settings.survey_shared_token
    return bool(expected) and hmac.compare_digest(supplied.encode(), expected.encode())


def require_token(authorization: Annotated[str | None, Header()] = None) -> Principal:
    """Every route but /health. Named for D69's shared token; per AUTH_MODE it accepts the
    shared token, an Entra access token, or either."""
    mode = settings.auth_mode
    if mode not in AUTH_MODES:
        raise HTTPException(500, f"AUTH_MODE must be one of {', '.join(AUTH_MODES)}")
    scheme, _, supplied = (authorization or "").partition(" ")
    supplied = supplied.strip()
    if scheme.lower() != "bearer" or not supplied:
        raise _unauthorized()
    if mode in ("token", "both") and _is_shared_token(supplied):
        return Principal()
    if mode in ("entra", "both"):
        if not entra.configured():
            log.error(json.dumps({"event": "entra_not_configured"}))
            raise _unauthorized()
        try:
            return Principal(entra.verify(supplied))
        except entra.TokenError as e:
            log.info(json.dumps({"event": "token_rejected", "reason": str(e)}))
            raise _unauthorized("invalid_token") from e
        except entra.KeysUnavailable as e:
            raise HTTPException(503, "Sign-in keys unavailable; try again shortly") from e
    raise _unauthorized()


SYSTEM_OID_PREFIX = "system:"


def _not_system():
    return or_(User.entra_oid.is_(None), ~User.entra_oid.startswith(SYSTEM_OID_PREFIX))


def upsert_user(session: Session, name: str) -> User:
    """The person with this name (trimmed, case-insensitive), or a new interim user.

    Interim rows first, then signed-in ones: a user merged into an Entra sign-in keeps its
    name (D264), so the team picker and job `--user` names still find that row."""
    name = name.strip()
    if not name:
        raise HTTPException(400, "Empty user name")
    user = session.scalars(
        select(User)
        .where(func.lower(User.name) == name.lower(), _not_system())
        .order_by(User.entra_oid.is_not(None), User.created_at)
    ).first()
    if user is None:
        user = User(name=name)
        session.add(user)
    user.last_seen = datetime.now(UTC)
    session.commit()
    return user


def system_user(session: Session, name: str) -> User:
    """A server-side actor (the seed import's `import` user, PLAN §7.5): an `app_user` whose
    `entra_oid` is `system:<name>`, so it never merges with a person and never shows in the
    team picker (`GET /team`)."""
    oid = f"{SYSTEM_OID_PREFIX}{name}"
    user = session.scalars(select(User).where(User.entra_oid == oid)).first()
    if user is None:
        user = User(entra_oid=oid, name=name)
        session.add(user)
        session.flush()
    return user


def is_system_user(user: User) -> bool:
    return bool(user.entra_oid and user.entra_oid.startswith(SYSTEM_OID_PREFIX))


SessionDep = Annotated[Session, Depends(get_session)]


def _by_oid(session: Session, oid: str) -> User | None:
    return session.scalars(select(User).where(User.entra_oid == oid)).first()


def merge_candidate(
    session: Session, ident: EntraIdentity, interim_name: str | None
) -> User | None:
    """The interim user a first sign-in would merge: the one named by the iPad's
    `X-Survey-User` (the name it was using), else the only one whose name is the Entra display
    name, else the only one whose name is the given name (or the display name's first word)."""
    interim = session.scalars(select(User).where(User.entra_oid.is_(None))).all()
    first = ident.given_name or (ident.name.split()[0] if ident.name.split() else None)
    for name in (interim_name, ident.name, first):
        key = (name or "").strip().lower()
        if not key:
            continue
        matches = [u for u in interim if u.name.strip().lower() == key]
        if len(matches) == 1:
            return matches[0]
    return None


def _touch(session: Session, user: User, ident: EntraIdentity) -> User:
    if ident.email:
        user.email = ident.email
    user.last_seen = datetime.now(UTC)
    try:
        session.commit()
    except IntegrityError as e:  # the same oid signed in twice at once
        session.rollback()
        raise HTTPException(409, {"error": "sign_in_race", "detail": "try again"}) from e
    return user


def entra_user(session: Session, ident: EntraIdentity, interim_name: str | None) -> User:
    """The signed-in user's row. A first sign-in with a merge candidate is held (409) until
    `POST /me/merge`; with none the row is created under the Entra display name."""
    user = _by_oid(session, ident.oid)
    if user is None:
        candidate = merge_candidate(session, ident, interim_name)
        if candidate is not None:
            raise HTTPException(
                409,
                {
                    "error": "merge_pending",
                    "name": ident.name,
                    "email": ident.email,
                    "merge_candidate": {"id": str(candidate.id), "name": candidate.name},
                },
            )
        user = User(entra_oid=ident.oid, name=ident.name)
        session.add(user)
    return _touch(session, user, ident)


def merge_entra_user(session: Session, ident: EntraIdentity, user_id: uuid.UUID | None) -> User:
    """Finish a first sign-in: adopt the interim user `user_id` (it keeps its id and name and
    gains the oid and email), or with None start a new user. A retry of the same choice
    returns the same row."""
    existing = _by_oid(session, ident.oid)
    if existing is not None:
        if user_id is None or existing.id == user_id:
            return _touch(session, existing, ident)
        raise HTTPException(409, {"error": "already_signed_in", "id": str(existing.id)})
    if user_id is None:
        user = User(entra_oid=ident.oid, name=ident.name)
        session.add(user)
    else:
        user = session.get(User, user_id)
        if user is None:
            raise HTTPException(404, {"error": "unknown_user", "id": str(user_id)})
        if user.entra_oid is not None:
            raise HTTPException(409, {"error": "not_interim", "id": str(user_id)})
        user.entra_oid = ident.oid
    log.info(
        json.dumps({"event": "entra_merge" if user_id else "entra_new", "user": str(user_id or "")})
    )
    return _touch(session, user, ident)


def current_user(
    principal: Annotated[Principal, Depends(require_token)],
    session: SessionDep,
    x_survey_user: Annotated[str | None, Header()] = None,
) -> User:
    if principal.entra is not None:
        return entra_user(session, principal.entra, x_survey_user)
    if not x_survey_user:
        raise HTTPException(400, "X-Survey-User header required")
    return upsert_user(session, x_survey_user)
