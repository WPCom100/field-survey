import uuid
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, text

from app.api import blobs, exports, imports, library, ops, projects
from app.auth import (
    Principal,
    SessionDep,
    current_user,
    is_system_user,
    merge_entra_user,
    require_token,
    upsert_user,
)
from app.config import settings
from app.models import User

app = FastAPI(title="Field Survey")
app.include_router(ops.router)
app.include_router(library.router)
app.include_router(blobs.router)
app.include_router(imports.router)
app.include_router(projects.router)
app.include_router(exports.router)


@app.get("/health")
def health(session: SessionDep) -> dict[str, str]:
    """The deployed commit and the database's Alembic revision (D154 (4)).

    The deploy job waits for `commit` to equal the sha it shipped; the Sync screen shows it
    beside the server URL. A database that cannot be read fails the check.
    """
    migration = session.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
    return {"status": "ok", "commit": settings.git_sha, "migration": migration}


class EntraClient(BaseModel):
    tenant_id: str
    client_id: str
    scopes: list[str]


class AuthConfig(BaseModel):
    mode: str
    entra: EntraClient | None


@app.get("/auth/config")
def auth_config() -> AuthConfig:
    """Public (T04, D265): how this server signs people in. The iPad offers Microsoft sign-in
    when `entra` is set and signs in against that registration. Nothing here is a secret."""
    mode = settings.auth_mode
    tenant, client_id = settings.entra_tenant_id.strip(), settings.entra_client_id.strip()
    client = None
    if mode in ("entra", "both") and tenant and client_id:
        client = EntraClient(
            tenant_id=tenant, client_id=client_id, scopes=settings.entra_scope_list
        )
    return AuthConfig(mode=mode, entra=client)


class TeamMember(BaseModel):
    id: str
    name: str


class NewMember(BaseModel):
    name: str


def _team(session: SessionDep) -> list[TeamMember]:
    users = session.scalars(select(User).order_by(User.name)).all()
    return [TeamMember(id=str(u.id), name=u.name) for u in users if not is_system_user(u)]


@app.get("/team", dependencies=[Depends(require_token)])
def team(session: SessionDep) -> list[TeamMember]:
    """Names for the interim picker (D69): TEAM_NAMES from .env plus anyone already known."""
    for name in settings.team_names:
        upsert_user(session, name)
    return _team(session)


@app.post("/team", dependencies=[Depends(require_token)], status_code=201)
def add_team_member(body: NewMember, session: SessionDep) -> TeamMember:
    user = upsert_user(session, body.name)
    return TeamMember(id=str(user.id), name=user.name)


class Me(BaseModel):
    id: str
    name: str
    email: str | None


class MergeChoice(BaseModel):
    # The interim user to merge into this Microsoft sign-in; null starts a new user (D264).
    user_id: uuid.UUID | None


def _me(user: User) -> Me:
    return Me(id=str(user.id), name=user.name, email=user.email)


@app.get("/me")
def me(user: Annotated[User, Depends(current_user)]) -> Me:
    """The caller's user. A first Microsoft sign-in with an interim user to merge answers 409
    `merge_pending` (with `merge_candidate`) until `POST /me/merge`."""
    return _me(user)


@app.post("/me/merge")
def me_merge(
    body: MergeChoice,
    principal: Annotated[Principal, Depends(require_token)],
    session: SessionDep,
) -> Me:
    """Finish a first Microsoft sign-in after the iPad's confirmation (T04)."""
    if principal.entra is None:
        raise HTTPException(400, "Merging needs a Microsoft sign-in")
    return _me(merge_entra_user(session, principal.entra, body.user_id))
