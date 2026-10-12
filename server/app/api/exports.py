"""`POST /exports` · `GET /exports/{id}` · `GET /exports/{id}/file` · `GET /exports?project_id`
(PLAN §8, T29).

An export is a job: `POST` queues an `export` row (JSON `{project_id, kind, params}`; `kind` is
`xlsx` or `floor_pdf`; `params.levels` / `params.tabs` narrow a workbook, `params.level` and
`params.sections` choose a floor PDF), the worker builds the
workbook (`app.jobs.exports`), and `GET /exports/{id}` reports `job_state` (`queued · running ·
done · failed`), `stats` (filename, row counts, error) and `blob` — the finished file's SHA-256,
downloadable through `GET /blobs/{sha}/content` or, with its filename, `GET /exports/{id}/file`.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.auth import SessionDep, current_user, require_token
from app.blobs import object_key
from app.jobs import exports
from app.models import Blob, Export, User
from app.storage import ObjectMissing, ObjectStore, get_object_store

router = APIRouter(prefix="/exports", dependencies=[Depends(require_token)])

StoreDep = Annotated[ObjectStore, Depends(get_object_store)]


class ExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: uuid.UUID
    kind: str = "xlsx"
    params: dict[str, Any] | None = None


@router.post("", status_code=202)
def create_export(
    body: ExportIn,
    session: SessionDep,
    user: Annotated[User, Depends(current_user)],
) -> dict[str, Any]:
    """Queue an export of the project; poll it by id."""
    try:
        row = exports.create_export(
            session, project_id=body.project_id, kind=body.kind, params=body.params, user=user
        )
    except exports.ExportError as e:
        session.rollback()
        status = 404 if "unknown project" in str(e) else 422
        raise HTTPException(status, str(e)) from e
    return exports.export_out(row)


@router.get("/{export_id}")
def get_export(export_id: uuid.UUID, session: SessionDep) -> dict[str, Any]:
    row = session.get(Export, export_id)
    if row is None:
        raise HTTPException(404, f"unknown export {export_id}")
    return exports.export_out(row)


@router.get("/{export_id}/file")
def export_file(export_id: uuid.UUID, session: SessionDep, store: StoreDep) -> StreamingResponse:
    """The finished workbook with its filename (for Share / Save to Files, T31)."""
    row = session.get(Export, export_id)
    if row is None:
        raise HTTPException(404, f"unknown export {export_id}")
    if row.job_state != "done" or not row.blob:
        raise HTTPException(409, {"error": "not_ready", "job_state": row.job_state})
    blob = session.get(Blob, row.blob)
    try:
        pieces = store.stream(object_key(row.blob))
    except ObjectMissing as e:
        raise HTTPException(404, {"error": "not_available"}) from e
    ext = "pdf" if row.kind == "floor_pdf" else "xlsx"
    filename = (row.stats or {}).get("filename") or f"export-{row.id}.{ext}"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "ETag": f'"{row.blob}"'}
    if blob is not None:
        headers["Content-Length"] = str(blob.size)
    mime = exports.MIME.get(row.kind, "application/octet-stream")
    return StreamingResponse(pieces, media_type=mime, headers=headers)


@router.get("")
def list_exports(project_id: uuid.UUID, session: SessionDep) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(Export).where(Export.project_id == project_id).order_by(Export.created_at.desc())
    )
    return [exports.export_out(r) for r in rows]
