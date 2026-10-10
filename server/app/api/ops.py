"""`POST /ops`: push a batch of ops (PLAN §3.2, §8). `GET /ops` (pull) is T10."""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import SessionDep, require_token
from app.sync import PushError, PushIn, PushOut, apply_push

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
    except Exception:
        session.rollback()
        raise
    return out
