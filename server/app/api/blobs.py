"""Resumable blob routes (PLAN §3.4, §8): declare, chunks, status, complete, content."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import StreamingResponse

from app import blobs
from app.auth import SessionDep, require_token
from app.storage import ObjectMissing, ObjectStore, get_object_store

router = APIRouter(prefix="/blobs", dependencies=[Depends(require_token)])

StoreDep = Annotated[ObjectStore, Depends(get_object_store)]
Sha = Annotated[str, Path(description="SHA-256 of the bytes, 64 lowercase hex")]


def _fail(e: blobs.BlobError) -> HTTPException:
    return HTTPException(e.status, e.detail)


@router.post("/{sha}")
def declare(sha: Sha, body: blobs.DeclareIn, session: SessionDep) -> blobs.BlobOut:
    """Start (or resume) an upload: returns the chunk size and the chunks already received."""
    try:
        return blobs.declare(session, sha, body)
    except blobs.BlobError as e:
        session.rollback()
        raise _fail(e) from e


@router.get("/{sha}")
def status(sha: Sha, session: SessionDep) -> blobs.BlobOut:
    try:
        return blobs.status(session, sha)
    except blobs.BlobError as e:
        raise _fail(e) from e


@router.put("/{sha}/chunks/{n}")
async def put_chunk(
    sha: Sha, n: int, request: Request, session: SessionDep, store: StoreDep
) -> blobs.BlobOut:
    """Raw bytes of chunk `n` (2 MB, the last one shorter), in any order."""
    data = await request.body()
    try:
        return blobs.put_chunk(session, store, sha, n, data)
    except blobs.BlobError as e:
        session.rollback()
        raise _fail(e) from e


@router.post("/{sha}/complete")
def complete(sha: Sha, session: SessionDep, store: StoreDep) -> blobs.BlobOut:
    try:
        return blobs.complete(session, store, sha)
    except blobs.BlobError as e:
        session.rollback()
        raise _fail(e) from e


@router.get("/{sha}/content")
def content(sha: Sha, session: SessionDep, store: StoreDep) -> StreamingResponse:
    """The finished bytes. Content-addressed, so cacheable forever."""
    try:
        info = blobs.content(session, sha)
        pieces = store.stream(blobs.object_key(sha))
    except blobs.BlobError as e:
        raise _fail(e) from e
    except ObjectMissing as e:
        raise HTTPException(404, {"error": "not_available", "upload_state": "complete"}) from e
    return StreamingResponse(
        pieces,
        media_type=info.mime,
        headers={
            "Content-Length": str(info.size),
            "ETag": f'"{sha}"',
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
