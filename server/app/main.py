from typing import Annotated

from fastapi import Depends, FastAPI
from pydantic import BaseModel
from sqlalchemy import select, text

from app.api import blobs, exports, imports, ops, projects
from app.auth import SessionDep, current_user, is_system_user, require_token, upsert_user
from app.config import settings
from app.models import User

app = FastAPI(title="Field Survey")
app.include_router(ops.router)
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


@app.get("/me")
def me(user: Annotated[User, Depends(current_user)]) -> TeamMember:
    return TeamMember(id=str(user.id), name=user.name)
