"""Resumable, content-addressed blob uploads (PLAN §3.4, T12, D87).

The iPad declares a blob by its SHA-256 and size, sends 2-MB chunks in any order (each is stored
as its own object, because S3/R2 multipart parts must be ≥ 5 MB), asks which chunks the server
holds whenever it resumes, and finally asks the server to assemble the object and check the hash.

Keys: chunks at `blobs/.chunks/<sha>/<nnnnn>`, the finished object at `blobs/<sha>`. The `blob`
row is the state: `partial` while chunks arrive (`chunks_received` lists them), `complete` once the
object is assembled and verified. A complete blob is never rewritten (A14); declaring it again
answers "complete" so the client skips the upload (dedup).
"""

import hashlib
import json
import logging
import re
import tempfile
from dataclasses import dataclass

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Blob
from app.storage import ObjectMissing, ObjectStore

log = logging.getLogger("blobs")

CHUNK_SIZE = 2 * 1024 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SPOOL_BYTES = 16 * 1024 * 1024


def object_key(sha: str) -> str:
    return f"blobs/{sha}"


def chunk_key(sha: str, n: int) -> str:
    return f"blobs/.chunks/{sha}/{n:05d}"


def chunks_total(size: int) -> int:
    return -(-size // CHUNK_SIZE)


def chunk_length(size: int, n: int) -> int:
    return min(CHUNK_SIZE, size - n * CHUNK_SIZE)


class BlobError(Exception):
    def __init__(self, status: int, detail: dict) -> None:
        super().__init__(detail.get("error", "blob_error"))
        self.status = status
        self.detail = detail


class DeclareIn(BaseModel):
    size: int = Field(ge=0)
    mime: str = Field(min_length=1, max_length=200)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)


class BlobOut(BaseModel):
    sha256: str
    size: int
    mime: str
    width: int | None
    height: int | None
    upload_state: str
    chunk_size: int
    chunks_total: int
    chunks_received: list[int]


@dataclass
class Content:
    mime: str
    size: int


def out(row: Blob) -> BlobOut:
    return BlobOut(
        sha256=row.sha256,
        size=row.size,
        mime=row.mime,
        width=row.width,
        height=row.height,
        upload_state=row.upload_state,
        chunk_size=CHUNK_SIZE,
        chunks_total=chunks_total(row.size),
        chunks_received=sorted(row.chunks_received or []),
    )


def check_sha(sha: str) -> None:
    if not SHA_RE.match(sha):
        raise BlobError(422, {"error": "bad_sha", "detail": "64 lowercase hex characters"})


def _locked(session: Session, sha: str) -> Blob | None:
    return session.scalars(select(Blob).where(Blob.sha256 == sha).with_for_update()).first()


def _event(event: str, **data) -> None:
    log.info(json.dumps({"event": event, **data}))


def declare(session: Session, sha: str, body: DeclareIn) -> BlobOut:
    """Create the blob row (idempotent). A size that disagrees with an earlier declare is 409."""
    check_sha(sha)
    if body.size > settings.blob_max_bytes:
        raise BlobError(413, {"error": "too_large", "max": settings.blob_max_bytes})
    row = _locked(session, sha)
    if row is None:
        row = Blob(
            sha256=sha,
            size=body.size,
            mime=body.mime,
            width=body.width,
            height=body.height,
            upload_state="partial",
            chunks_received=[],
        )
        session.add(row)
        session.flush()
        _event("blob_declared", sha=sha, size=body.size, mime=body.mime)
    elif row.size != body.size:
        raise BlobError(409, {"error": "size_mismatch", "size": row.size})
    result = out(row)
    session.commit()
    return result


def status(session: Session, sha: str) -> BlobOut:
    check_sha(sha)
    row = session.get(Blob, sha)
    if row is None:
        raise BlobError(404, {"error": "unknown_blob"})
    return out(row)


def put_chunk(session: Session, store: ObjectStore, sha: str, n: int, data: bytes) -> BlobOut:
    """Store chunk `n` (any order, repeats harmless) and record it on the row."""
    check_sha(sha)
    row = session.get(Blob, sha)
    if row is None:
        raise BlobError(404, {"error": "unknown_blob"})
    if row.upload_state == "complete":
        return out(row)
    total = chunks_total(row.size)
    if not 0 <= n < total:
        raise BlobError(422, {"error": "bad_chunk", "chunks_total": total})
    expected = chunk_length(row.size, n)
    if len(data) != expected:
        raise BlobError(422, {"error": "bad_chunk_length", "expected": expected, "got": len(data)})
    # Write the bytes before taking the row lock: a 2-MB put must not hold the row.
    store.put_bytes(chunk_key(sha, n), data)
    session.rollback()  # end the read transaction so the lock below sees the latest row
    row = _locked(session, sha)
    if row is None:  # pragma: no cover - rows are never deleted
        raise BlobError(404, {"error": "unknown_blob"})
    if row.upload_state != "complete" and n not in (row.chunks_received or []):
        row.chunks_received = sorted([*(row.chunks_received or []), n])
    result = out(row)
    session.commit()
    return result


def complete(session: Session, store: ObjectStore, sha: str) -> BlobOut:
    """Assemble the chunks, check size and SHA-256, publish `blobs/<sha>`.

    Missing chunks → 409 with the list. A hash or size mismatch → 422, and the chunks are
    discarded so a retry starts clean. Completing twice is harmless.
    """
    check_sha(sha)
    row = _locked(session, sha)
    if row is None:
        raise BlobError(404, {"error": "unknown_blob"})
    if row.upload_state == "complete":
        result = out(row)
        session.commit()
        return result
    total = chunks_total(row.size)
    received = set(row.chunks_received or [])
    missing = [n for n in range(total) if n not in received]
    if missing:
        session.commit()
        raise BlobError(409, {"error": "missing_chunks", "missing": missing})

    digest = hashlib.sha256()
    length = 0
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_BYTES) as buf:
        lost: list[int] = []
        for n in range(total):
            try:
                part = store.read(chunk_key(sha, n))
            except ObjectMissing:
                lost.append(n)
                continue
            digest.update(part)
            length += len(part)
            buf.write(part)
        if lost:
            # The row said we had them but the bucket does not: forget them, ask for them again.
            row.chunks_received = sorted(received - set(lost))
            session.commit()
            _event("blob_chunks_lost", sha=sha, lost=lost)
            raise BlobError(409, {"error": "missing_chunks", "missing": lost})
        got = digest.hexdigest()
        if got != sha or length != row.size:
            row.chunks_received = []
            session.commit()
            store.delete_many([chunk_key(sha, n) for n in range(total)])
            _event("blob_hash_mismatch", sha=sha, got=got, size=row.size, length=length)
            raise BlobError(422, {"error": "hash_mismatch", "got": got, "length": length})
        buf.seek(0)
        store.put_file(object_key(sha), buf, row.mime)
    row.upload_state = "complete"
    result = out(row)
    session.commit()
    _event("blob_complete", sha=sha, size=row.size)
    try:
        store.delete_many([chunk_key(sha, n) for n in range(total)])
    except Exception as e:  # leftovers are garbage, never data
        log.warning(json.dumps({"event": "blob_chunk_cleanup_failed", "sha": sha, "error": str(e)}))
    return result


def content(session: Session, sha: str) -> Content:
    """The finished blob's type and size; 404 until it is complete."""
    check_sha(sha)
    row = session.get(Blob, sha)
    if row is None or row.upload_state != "complete":
        raise BlobError(
            404, {"error": "not_available", "upload_state": row.upload_state if row else None}
        )
    return Content(mime=row.mime, size=row.size)
