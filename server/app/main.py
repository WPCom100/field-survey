from typing import Annotated

from fastapi import Depends, FastAPI
from pydantic import BaseModel
from sqlalchemy import select

from app.api import blobs, ops
from app.auth import SessionDep, current_user, require_token, upsert_user
from app.config import settings
from app.models import User

app = FastAPI(title="Field Survey")
app.include_router(ops.router)
app.include_router(blobs.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class TeamMember(BaseModel):
    id: str
    name: str


class NewMember(BaseModel):
    name: str


def _team(session: SessionDep) -> list[TeamMember]:
    users = session.scalars(select(User).order_by(User.name)).all()
    return [TeamMember(id=str(u.id), name=u.name) for u in users]


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
