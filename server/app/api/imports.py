"""`POST /imports` · `GET /imports/{id}` · `GET /imports?project_id` (PLAN §8, T27).

A seed import is a multipart upload: `project_id`, `kind` (`master_xlsx` | `floor_xlsx`), the
workbook as `file`, and an optional `mapping` (JSON `{tab: {field: header}}` from the column-
mapping UI, T28). The file goes to the object store and an `import_batch` is queued; the worker
runs it (`app.jobs.runner`). Poll `GET /imports/{id}` for `job_state` and `stats`.
"""

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select

from app.auth import SessionDep, current_user, require_token
from app.config import settings
from app.jobs import runner
from app.jobs.workbook import WorkbookError, inspect_workbook
from app.models import ImportBatch, User
from app.storage import ObjectStore, get_object_store

router = APIRouter(prefix="/imports", dependencies=[Depends(require_token)])

StoreDep = Annotated[ObjectStore, Depends(get_object_store)]


@router.post("", status_code=202)
async def create_import(
    session: SessionDep,
    store: StoreDep,
    user: Annotated[User, Depends(current_user)],
    project_id: Annotated[uuid.UUID, Form()],
    file: Annotated[UploadFile, File()],
    kind: Annotated[str, Form()] = "master_xlsx",
    mapping: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """Queue a seed import of the uploaded workbook. 202 with the batch; poll it by id."""
    data = await file.read()
    if len(data) > settings.blob_max_bytes:
        raise HTTPException(413, {"error": "too_large", "max": settings.blob_max_bytes})
    overrides = None
    if mapping:
        try:
            overrides = json.loads(mapping)
        except ValueError as e:
            raise HTTPException(422, {"error": "bad_mapping", "detail": str(e)}) from e
        if not isinstance(overrides, dict):
            raise HTTPException(422, {"error": "bad_mapping", "detail": "expected an object"})
    try:
        batch = runner.create_batch(
            session,
            store,
            project_id=project_id,
            kind=kind,
            filename=file.filename or "workbook.xlsx",
            data=data,
            user=user,
            mapping=overrides,
        )
    except runner.ImportError_ as e:
        session.rollback()
        status = 404 if "unknown project" in str(e) else 422
        raise HTTPException(status, str(e)) from e
    return runner.batch_out(batch)


@router.post("/preview")
async def preview_import(
    file: Annotated[UploadFile, File()],
    mapping: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """The column-mapping UI's first look (T28): headers, default matches and checks of the
    workbook under an optional `mapping`. Reads only; nothing is stored or queued."""
    data = await file.read()
    if len(data) > settings.blob_max_bytes:
        raise HTTPException(413, {"error": "too_large", "max": settings.blob_max_bytes})
    overrides = None
    if mapping:
        try:
            overrides = json.loads(mapping)
        except ValueError as e:
            raise HTTPException(422, {"error": "bad_mapping", "detail": str(e)}) from e
        if not isinstance(overrides, dict):
            raise HTTPException(422, {"error": "bad_mapping", "detail": "expected an object"})
    try:
        return inspect_workbook(data, file.filename, overrides)
    except WorkbookError as e:
        raise HTTPException(422, {"error": "bad_workbook", "detail": str(e)}) from e


@router.get("/{batch_id}")
def get_import(batch_id: uuid.UUID, session: SessionDep) -> dict[str, Any]:
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise HTTPException(404, f"unknown import {batch_id}")
    return runner.batch_out(batch)


@router.get("")
def list_imports(project_id: uuid.UUID, session: SessionDep) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(ImportBatch)
        .where(ImportBatch.project_id == project_id)
        .order_by(ImportBatch.created_at.desc())
    )
    return [runner.batch_out(b) for b in rows]
