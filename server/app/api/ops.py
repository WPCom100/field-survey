"""`POST /ops`: push a batch of ops (PLAN §3.2, §8). `GET /ops`: pull since a `server_seq`."""

import json
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from app.auth import SessionDep, require_token
from app.sync import MAX_OPS_PER_PULL, PullOut, PushError, PushIn, PushOut, apply_push, pull_ops

log = logging.getLogger("sync")
router = APIRouter(dependencies=[Depends(require_token)])


@router.post("/ops")
def push_ops(body: PushIn, session: SessionDep) -> PushOut:
    """Apply one push in one transaction: every op is stored with its outcome, or none is."""
    try:
        out = apply_push(session, body)
        session.commit()
    except PushError as e:
        session.rollback()
        raise HTTPException(e.status, e.detail) from e
    except IntegrityError as e:
        # Deferred foreign keys are checked at commit: a record referencing something the server
        # has never seen fails the whole push. Nothing is stored; the client keeps the ops.
        session.rollback()
        log.error(
            json.dumps(
                {
                    "event": "push_integrity",
                    "project": str(body.project_id),
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
def get_ops(
    session: SessionDep,
    project_id: uuid.UUID,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_OPS_PER_PULL)] = MAX_OPS_PER_PULL,
) -> PullOut:
    """Ops with `server_seq > since`, oldest first, at most `limit`; `has_more` says to page on."""
    try:
        return pull_ops(session, project_id, since, limit)
    except PushError as e:
        raise HTTPException(e.status, e.detail) from e
