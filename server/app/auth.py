"""Request identity. AUTH_MODE=token is the interim mode (D69); AUTH_MODE=entra is T03."""

import hmac
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import User


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    if settings.auth_mode != "token":
        # T03 replaces this branch with JWT validation against the tenant JWKS.
        raise HTTPException(501, "AUTH_MODE=entra is not implemented until T03")
    expected = settings.survey_shared_token
    scheme, _, supplied = (authorization or "").partition(" ")
    if (
        not expected
        or scheme.lower() != "bearer"
        or not hmac.compare_digest(supplied.encode(), expected.encode())
    ):
        raise HTTPException(401, "Missing or invalid token", {"WWW-Authenticate": "Bearer"})


def upsert_user(session: Session, name: str) -> User:
    """Find the interim (entra_oid null) user with this name, case-insensitively, or create it."""
    name = name.strip()
    if not name:
        raise HTTPException(400, "Empty user name")
    user = session.scalars(
        select(User).where(User.entra_oid.is_(None), func.lower(User.name) == name.lower())
    ).first()
    if user is None:
        user = User(name=name)
        session.add(user)
    user.last_seen = datetime.now(UTC)
    session.commit()
    return user


SessionDep = Annotated[Session, Depends(get_session)]


def current_user(
    _: Annotated[None, Depends(require_token)],
    session: SessionDep,
    x_survey_user: Annotated[str | None, Header()] = None,
) -> User:
    if not x_survey_user:
        raise HTTPException(400, "X-Survey-User header required")
    return upsert_user(session, x_survey_user)
