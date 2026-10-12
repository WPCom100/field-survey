"""`GET /projects` · `POST /projects` (PLAN §8, T41).

Projects are created here, server-side, so their numbering groups exist before any op
(`app.projects`). The list is what an iPad reads at sign-in to learn which projects to pull.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import projects
from app.auth import SessionDep, current_user, require_token
from app.models import User

router = APIRouter(prefix="/projects", dependencies=[Depends(require_token)])


@router.get("")
def list_projects(session: SessionDep) -> list[projects.ProjectOut]:
    return projects.list_projects(session)


@router.post("", status_code=201)
def create_project(
    body: projects.ProjectIn,
    session: SessionDep,
    user: Annotated[User, Depends(current_user)],
) -> projects.CreatedOut:
    try:
        return projects.create_project(session, body, user)
    except projects.ProjectError as e:
        session.rollback()
        raise HTTPException(e.status, e.detail) from e
