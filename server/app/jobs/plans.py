"""Plan sheets job (T45, PLAN §7.4, D29, D100): a display sheet (the level's composite) or
source sheets uploaded for a level become `sheet` records with their grid calibration and text
pass, delivered to iPads as ops.

    POST /imports (kind=plans, level_id, sheet_kind, file) → import_batch("queued")
    worker: run_queued() → analyse (app.jobs.plan_analysis) → blobs + ops → done | skipped | failed
    python -m app.jobs.plans <project_id> <level_id> <sheet.pdf> [--kind display|source]
        [--user NAME]

One batch is one PDF. A **display** sheet is its first page: the PDF is rewritten with the
"Source sheet boundaries" optional-content group off (D100) and stored as the sheet's blob, the
level's `display_sheet_id` is set to the new sheet (the previous display sheet, if any, is
soft-deleted — pins placed on it keep its id and show as "elsewhere" until moved, see TASKS), and
the boundaries are kept in `sheet.features`. A **source** PDF gives one `sheet` per page, all on
the same blob, text pass only. The same file (SHA-256) for the same level and kind is not
imported twice (`skipped`). Everything is one transaction through the ordinary apply loop
(`Push`, trusted, the requesting user); a failure leaves the project as it was.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import vocab
from app.auth import system_user, upsert_user
from app.blobs import object_key
from app.ids import uuid7
from app.jobs import plan_analysis, runner
from app.models import Blob, FieldHead, ImportBatch, Level, Project, Sheet, User
from app.storage import ObjectStore
from app.sync import SERVER_INSTALL_ID, OpIn, Push, jsonable

log = logging.getLogger("jobs")

PLANS_KIND = "plans"
PDF_MIME = "application/pdf"
CHANGE_TYPE = "Master edit"
REASON = "Plan sheet upload"


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


# ----------------------------------------------------------------- batches


def create_sheet_batch(
    session: Session,
    store: ObjectStore,
    *,
    project_id: uuid.UUID,
    level_id: uuid.UUID,
    sheet_kind: str,
    filename: str,
    data: bytes,
    user: User | None,
) -> ImportBatch:
    """Store the PDF and queue the job. Commits. Raises `runner.ImportError_` on a bad request."""
    if sheet_kind not in vocab.SHEET_KIND:
        raise runner.ImportError_(f"sheet_kind must be one of {', '.join(vocab.SHEET_KIND)}")
    level = session.get(Level, level_id)
    if level is None or level.project_id != project_id or level.deleted_at is not None:
        raise runner.ImportError_(f"unknown level {level_id} in project {project_id}")
    if not data.startswith(b"%PDF"):
        raise runner.ImportError_("not a PDF")
    try:
        pages = plan_analysis.page_count(data)
    except Exception as e:  # noqa: BLE001 - any parser failure is "not a readable PDF"
        raise runner.ImportError_(f"the PDF could not be read: {e}") from e
    if pages == 0:
        raise runner.ImportError_("the PDF has no pages")
    return runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind=PLANS_KIND,
        filename=filename or "sheet.pdf",
        data=data,
        user=user,
        mime=PDF_MIME,
        extra={"level_id": str(level_id), "sheet_kind": sheet_kind, "pages": pages},
    )


# --------------------------------------------------------------- the job


class _Ops:
    """Trusted ops stamped by the requesting user from the server's install (as D127 does)."""

    def __init__(self, project_id: uuid.UUID, user_id: uuid.UUID):
        self.project_id = project_id
        self.user_id = user_id
        self.ts = datetime.now(UTC)
        self.ops: list[OpIn] = []

    def _op(self, **kw: Any) -> OpIn:
        self.ts += timedelta(microseconds=1)
        op = OpIn(
            op_id=uuid7(),
            project_id=self.project_id,
            user_id=self.user_id,
            install_id=SERVER_INSTALL_ID,
            client_ts=self.ts,
            change_type=CHANGE_TYPE,
            reason=REASON,
            **kw,
        )
        self.ops.append(op)
        return op

    def create(self, entity_kind: str, payload: dict[str, Any]) -> uuid.UUID:
        eid = payload.get("id") or uuid7()
        self._op(
            entity_kind=entity_kind,
            entity_id=eid,
            kind="create",
            payload=jsonable({"id": eid, **payload}),
        )
        return eid

    def set(
        self,
        entity_kind: str,
        entity_id: uuid.UUID,
        field: str,
        was: Any,
        now: Any,
        base: uuid.UUID | None,
    ) -> None:
        self._op(
            entity_kind=entity_kind,
            entity_id=entity_id,
            kind="set",
            field=field,
            was=jsonable(was),
            now=jsonable(now),
            base_op_id=base,
        )

    def delete(
        self, entity_kind: str, entity_id: uuid.UUID, base: uuid.UUID | None, reason: str
    ) -> None:
        op = self._op(entity_kind=entity_kind, entity_id=entity_id, kind="delete", base_op_id=base)
        op.reason = reason


class _Body:
    since: int | None = None

    def __init__(self, project_id: uuid.UUID):
        self.project_id = project_id


def _head(session: Session, entity_id: uuid.UUID, field: str) -> uuid.UUID | None:
    return session.scalar(
        select(FieldHead.op_id).where(FieldHead.entity_id == entity_id, FieldHead.field == field)
    )


def _store_blob(session: Session, store: ObjectStore, data: bytes) -> tuple[str, bool]:
    sha = hashlib.sha256(data).hexdigest()
    if session.get(Blob, sha) is not None:
        return sha, False
    store.put_file(object_key(sha), io.BytesIO(data), PDF_MIME)
    session.add(
        Blob(
            sha256=sha,
            size=len(data),
            mime=PDF_MIME,
            width=None,
            height=None,
            upload_state="complete",
            chunks_received=[],
        )
    )
    session.flush()
    return sha, True


def import_sheets(session: Session, store: ObjectStore, batch: ImportBatch) -> dict[str, Any]:
    """Apply one queued plans batch inside the caller's transaction; returns its stats."""
    if batch.kind != PLANS_KIND:
        raise runner.ImportError_(f"not a plans batch: {batch.kind}")
    files = batch.files or []
    if not files:
        raise runner.ImportError_("batch has no file")
    entry = files[0]
    project = session.scalars(
        select(Project).where(Project.id == batch.project_id).with_for_update()
    ).first()
    if project is None:
        raise runner.ImportError_(f"unknown project {batch.project_id}")
    level_id = uuid.UUID(str(entry.get("level_id")))
    sheet_kind = str(entry.get("sheet_kind") or "display")
    level = session.get(Level, level_id)
    if level is None or level.project_id != project.id:
        raise runner.ImportError_(f"unknown level {level_id}")

    earlier = session.scalars(
        select(ImportBatch).where(
            ImportBatch.project_id == project.id,
            ImportBatch.id != batch.id,
            ImportBatch.kind == PLANS_KIND,
            ImportBatch.job_state == "done",
        )
    ).all()
    for b in earlier:
        for f in b.files or []:
            if (
                f.get("sha256") == entry.get("sha256")
                and f.get("level_id") == entry.get("level_id")
                and f.get("sheet_kind") == sheet_kind
            ):
                return {"skipped": "already imported", "earlier_batch": str(b.id)}

    try:
        data = store.read(entry["key"])
    except KeyError as e:
        raise runner.ImportError_(f"file {entry.get('key')} is not in the object store") from e

    requester = session.get(User, batch.created_by_id) if batch.created_by_id else None
    user_id = (requester or system_user(session, "import")).id
    ops = _Ops(project.id, user_id)
    title = Path(str(entry.get("name") or "sheet.pdf")).stem
    pages = range(1) if sheet_kind == "display" else range(plan_analysis.page_count(data))
    sheets: list[dict[str, Any]] = []
    blobs_stored = 0
    source_sha: str | None = None
    for i in pages:
        try:
            a = plan_analysis.analyse_sheet(data, i, boundaries=sheet_kind == "display")
        except plan_analysis.SheetTooLarge as e:
            raise runner.ImportError_(str(e)) from e
        if sheet_kind == "display":
            sha, stored = _store_blob(session, store, a.display_pdf or data)
        else:
            if source_sha is None:
                source_sha, stored = _store_blob(session, store, data)
            else:
                stored = False
            sha = source_sha
        blobs_stored += int(stored)
        sheet_id = ops.create(
            "sheet",
            {
                "level_id": level.id,
                "kind": sheet_kind,
                "blob": sha,
                "page": a.page,
                "title": title if len(pages) == 1 else f"{title} p.{a.page}",
                "width_pt": round(a.width_pt, 2),
                "height_pt": round(a.height_pt, 2),
                "grid_sets": a.grid_sets,
                "features": a.features,
                "revision": None,
            },
        )
        sheets.append(
            {
                "id": str(sheet_id),
                "page": a.page,
                **a.stats,
                "residuals": [s["residual"] for s in a.grid_sets],
            }
        )

    if sheet_kind == "display":
        old = level.display_sheet_id
        ops.set(
            "level",
            level.id,
            "display_sheet_id",
            old,
            uuid.UUID(sheets[0]["id"]),
            _head(session, level.id, "display_sheet_id"),
        )
        if old is not None:
            old_sheet = session.get(Sheet, old)
            if old_sheet is not None and old_sheet.deleted_at is None:
                ops.delete(
                    "sheet",
                    old,
                    _head(session, old, "deleted_at"),
                    "Replaced by a new display sheet",
                )

    push = Push(session, _Body(project.id), trusted=True)
    out = push.run(ops.ops)
    not_applied = [r for r in out.results if r.outcome != "applied"]
    if not_applied:
        raise runner.ImportError_(
            f"{len(not_applied)} ops did not apply: "
            + ", ".join(f"{r.op_id} {r.outcome}" for r in not_applied[:5])
        )
    stats = {
        "level": level.level,
        "sheet_kind": sheet_kind,
        "sheets": sheets,
        "grid_sets": sum(s["grid_sets"] for s in sheets),
        "auto_sets": sum(s["auto_sets"] for s in sheets),
        "blobs_stored": blobs_stored,
        "ops": len(ops.ops),
        "last_server_seq": push.seq,
    }
    _event(
        "plans_applied",
        batch=str(batch.id),
        project=str(project.id),
        level=level.level,
        kind=sheet_kind,
        sheets=len(sheets),
        auto_sets=stats["auto_sets"],
    )
    return stats


def run_queued(
    session_factory: runner.SessionFactory, store: ObjectStore, limit: int = 1
) -> list[str]:
    """Worker tick: run up to `limit` queued plans batches, oldest first."""
    return runner.run_queued(session_factory, store, limit, kinds=(PLANS_KIND,), job=import_sheets)


# ------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.plans")
    parser.add_argument("project_id", type=uuid.UUID)
    parser.add_argument("level_id", type=uuid.UUID)
    parser.add_argument("pdf", help="path to the sheet PDF")
    parser.add_argument("--kind", default="display", choices=vocab.SHEET_KIND)
    parser.add_argument("--user", default=None, help="team name to record as the uploader")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    data = Path(args.pdf).read_bytes()
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            batch = create_sheet_batch(
                s,
                store,
                project_id=args.project_id,
                level_id=args.level_id,
                sheet_kind=args.kind,
                filename=Path(args.pdf).name,
                data=data,
                user=user,
            )
        except runner.ImportError_ as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
    state = runner.run_batch(SessionLocal, store, batch.id, job=import_sheets)
    with SessionLocal() as s:
        print(json.dumps(runner.batch_out(s.get(ImportBatch, batch.id)), indent=2, default=str))
    return 0 if state in ("done", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
