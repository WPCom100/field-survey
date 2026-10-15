"""`POST /library/ops`, `GET /library/ops`: the app-level device-type library's own op log (T61,
D65, D184). Same op format, apply loop, conflict review and history as a project's `/ops`; the
ops name `LIBRARY_STREAM` as their project and are stored with no project."""

import json
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from app.auth import SessionDep, require_token
from app.sync import (
    LIBRARY_STREAM,
    MAX_OPS_PER_PULL,
    MAX_OPS_PER_PUSH,
    OpIn,
    PullOut,
    PushError,
    PushIn,
    PushOut,
    apply_push,
    pull_ops,
)

log = logging.getLogger("sync")
router = APIRouter(prefix="/library", dependencies=[Depends(require_token)])


class LibraryPushIn(BaseModel):
    """As `PushIn` without a project: every op names `LIBRARY_STREAM` as its `project_id`."""

    since: int | None = Field(default=None, ge=0)
    ops: list[OpIn] = Field(max_length=MAX_OPS_PER_PUSH)


@router.post("/ops")
def push_library_ops(body: LibraryPushIn, session: SessionDep) -> PushOut:
    try:
        out = apply_push(
            session, PushIn(project_id=LIBRARY_STREAM, since=body.since, ops=body.ops), library=True
        )
        session.commit()
    except PushError as e:
        session.rollback()
        raise HTTPException(e.status, e.detail) from e
    except IntegrityError as e:
        session.rollback()
        log.error(
            json.dumps(
                {
                    "event": "push_integrity",
                    "project": "library",
                    "ops": [str(o.op_id) for o in body.ops],
                    "error": str(e.orig),
                }
            )
        )
        raise HTTPException(409, {"error": "integrity", "detail": str(e.orig)}) from e
    except Exception:
        session.rollback()
        raise
    return out


@router.get("/ops")
def get_library_ops(
    session: SessionDep,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_OPS_PER_PULL)] = MAX_OPS_PER_PULL,
) -> PullOut:
    return pull_ops(session, None, since, limit)
