"""`POST /imports` · `GET /imports/{id}` · `GET /imports?project_id` (PLAN §8, T27) ·
`GET /imports/{id}/crop` (a draft's source crop as PNG, T44).

A seed import is a multipart upload: `project_id`, `kind` (`master_xlsx` | `floor_xlsx`), the
workbook as `file`, and an optional `mapping` (JSON `{tab: {field: header}}` from the column-
mapping UI, T28). The file goes to the object store and an `import_batch` is queued; the worker
runs it (`app.jobs.runner`). Poll `GET /imports/{id}` for `job_state` and `stats`.
"""

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import select

from app.auth import SessionDep, current_user, require_token
from app.config import settings
from app.jobs import bom, crops, plans, riser, runner
from app.jobs.workbook import WorkbookError, inspect_workbook
from app.models import ImportBatch, User
from app.storage import ObjectMissing, ObjectStore, get_object_store

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
    level_id: Annotated[uuid.UUID | None, Form()] = None,
    sheet_kind: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """Queue a seed import of the uploaded workbook — or, with `kind=plans`, a plan sheet PDF for
    `level_id` as its `sheet_kind` (`display` | `source`, T45) — or, with `kind=bom`, a BOM PDF
    for extraction into device drafts (T42) — or, with `kind=riser`, the riser PDF for device
    and cable drafts with Claude-read endpoints (T43). 202 with the batch; poll it by id."""
    data = await file.read()
    if len(data) > settings.blob_max_bytes:
        raise HTTPException(413, {"error": "too_large", "max": settings.blob_max_bytes})
    if kind in (bom.BOM_KIND, riser.RISER_KIND):
        create = bom.create_bom_batch if kind == bom.BOM_KIND else riser.create_riser_batch
        try:
            batch = create(
                session,
                store,
                project_id=project_id,
                filename=file.filename or f"{kind}.pdf",
                data=data,
                user=user,
            )
        except runner.ImportError_ as e:
            session.rollback()
            status = 404 if "unknown" in str(e) else 422
            raise HTTPException(status, str(e)) from e
        return runner.batch_out(batch)
    if kind == plans.PLANS_KIND:
        if level_id is None:
            raise HTTPException(
                422, {"error": "bad_request", "detail": "kind=plans needs level_id"}
            )
        try:
            batch = plans.create_sheet_batch(
                session,
                store,
                project_id=project_id,
                level_id=level_id,
                sheet_kind=sheet_kind or "display",
                filename=file.filename or "sheet.pdf",
                data=data,
                user=user,
            )
        except runner.ImportError_ as e:
            session.rollback()
            status = 404 if "unknown" in str(e) else 422
            raise HTTPException(status, str(e)) from e
        return runner.batch_out(batch)
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


@router.get("/{batch_id}/crop")
def get_crop(
    batch_id: uuid.UUID,
    session: SessionDep,
    store: StoreDep,
    page: int,
    bbox: str,
    pad: float = 36.0,
    px: int = 1200,
    mark: bool = True,
) -> Response:
    """A PNG of the batch's stored PDF around `bbox` (`x,y,w,h` in points, top-left origin) on
    1-based `page`, the bbox outlined in red: the source crop of a draft (T44, Phase 3 §3.3).
    The file never changes, so the image may be cached."""
    batch = session.get(ImportBatch, batch_id)
    if batch is None:
        raise HTTPException(404, f"unknown import {batch_id}")
    key = (batch.files or [{}])[0].get("key")
    if not key:
        raise HTTPException(404, "the import has no stored file")
    try:
        data = store.read(key)
    except ObjectMissing as e:
        raise HTTPException(404, "the import's file is missing from storage") from e
    if not data.startswith(b"%PDF"):
        raise HTTPException(422, {"error": "not_a_pdf", "detail": "this import is not a PDF"})
    try:
        png = crops.render_crop(
            data, page, crops.parse_bbox(bbox), pad=max(0.0, pad), px=px, mark=mark
        )
    except crops.CropError as e:
        raise HTTPException(422, {"error": "bad_crop", "detail": str(e)}) from e
    return Response(
        png, media_type="image/png", headers={"Cache-Control": "private, max-age=604800"}
    )


@router.get("")
def list_imports(project_id: uuid.UUID, session: SessionDep) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(ImportBatch)
        .where(ImportBatch.project_id == project_id)
        .order_by(ImportBatch.created_at.desc())
    )
    return [runner.batch_out(b) for b in rows]
