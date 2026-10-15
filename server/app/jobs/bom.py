"""BOM extraction job (T42, PLAN §7.2, D5, D12, D28): a BOM PDF uploaded to a project becomes
`draft_device` rows (proposed, with candidates, accessories and `source_ref`) delivered to
iPads as ops, and a list of excluded lines in the batch stats.

    POST /imports (kind=bom, file) → import_batch("queued")
    worker: run_queued() → extract (app.jobs.bom_extract, app.ocr) → ops → done | skipped | failed
    python -m app.jobs.bom <project_id> <bom.pdf> [--user NAME]

The same file (SHA-256) for the same project is not extracted twice (`skipped`). Everything is
one transaction through the ordinary apply loop (`Push`, trusted, the requesting user); a
failure — including a page that needs OCR on a server without tesseract — leaves the project as
it was and the batch `failed` with the reason. Nothing here decides anything: every draft waits
for the per-level review (T44), pooled and conflicting ones flagged (D11, D28).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ocr
from app.auth import system_user, upsert_user
from app.ids import uuid7
from app.jobs import bom_extract, runner
from app.models import ImportBatch, Level, LibraryType, Project, User, Vocab
from app.storage import ObjectStore
from app.sync import SERVER_INSTALL_ID, OpIn, Push, jsonable

log = logging.getLogger("jobs")

BOM_KIND = "bom"
PDF_MIME = "application/pdf"
CHANGE_TYPE = "Master edit"
REASON = "BOM extraction"


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


# ----------------------------------------------------------------- batches


def create_bom_batch(
    session: Session,
    store: ObjectStore,
    *,
    project_id: uuid.UUID,
    filename: str,
    data: bytes,
    user: User | None,
) -> ImportBatch:
    """Store the PDF and queue the job. Commits. Raises `runner.ImportError_` on a bad request."""
    if session.get(Project, project_id) is None:
        raise runner.ImportError_(f"unknown project {project_id}")
    if not data.startswith(b"%PDF"):
        raise runner.ImportError_("not a PDF")
    try:
        pages = bom_extract.page_count(data)
    except Exception as e:  # noqa: BLE001 - any parser failure is "not a readable PDF"
        raise runner.ImportError_(f"the PDF could not be read: {e}") from e
    if pages == 0:
        raise runner.ImportError_("the PDF has no pages")
    return runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind=BOM_KIND,
        filename=filename or "bom.pdf",
        data=data,
        user=user,
        mime=PDF_MIME,
        extra={"pages": pages},
    )


class _Ops:
    """Trusted `create` ops stamped by the requesting user from the server's install."""

    def __init__(self, project_id: uuid.UUID, user_id: uuid.UUID, reason: str):
        self.project_id = project_id
        self.user_id = user_id
        self.reason = reason
        self.ts = datetime.now(UTC)
        self.ops: list[OpIn] = []

    def create(self, entity_kind: str, payload: dict[str, Any]) -> uuid.UUID:
        self.ts += timedelta(microseconds=1)
        eid = payload.get("id") or uuid7()
        self.ops.append(
            OpIn(
                op_id=uuid7(),
                project_id=self.project_id,
                user_id=self.user_id,
                install_id=SERVER_INSTALL_ID,
                client_ts=self.ts,
                change_type=CHANGE_TYPE,
                reason=self.reason,
                entity_kind=entity_kind,
                entity_id=eid,
                kind="create",
                payload=jsonable({"id": eid, **payload}),
            )
        )
        return eid


class _Body:
    since: int | None = None

    def __init__(self, project_id: uuid.UUID):
        self.project_id = project_id


# ---------------------------------------------------------------- the target


def target_of(session: Session, project_id: uuid.UUID) -> bom_extract.Target:
    """The project's levels, `model_map` / `level_alias` vocabulary and device-type library
    (project rows, then the app library's, D65) as the extractor reads them."""
    levels = {
        lv.level: lv.id
        for lv in session.scalars(
            select(Level).where(Level.project_id == project_id, Level.deleted_at.is_(None))
        )
    }
    model_map = _vocab_map(session, project_id, "model_map")
    level_alias = _vocab_map(session, project_id, "level_alias")
    library: list[bom_extract.LibraryModel] = []
    rows = session.scalars(
        select(LibraryType)
        .where(
            LibraryType.deleted_at.is_(None),
            LibraryType.state != "rejected",
            (LibraryType.project_id == project_id) | (LibraryType.project_id.is_(None)),
        )
        # the project's own types first, so they win over the app library's
        .order_by(LibraryType.project_id.is_(None), LibraryType.id)
    )
    for t in rows:
        library.append(
            bom_extract.LibraryModel(
                model=t.model,
                category=t.category,
                aliases=tuple(str(a) for a in (t.aliases or []) if a),
            )
        )
    return bom_extract.Target(
        levels=levels, model_map=model_map, level_alias=level_alias, library=library
    )


def _vocab_map(session: Session, project_id: uuid.UUID, list_name: str) -> dict[str, str]:
    """`vocab(<list>)` rows as raw → canonical: a variant row's `value` maps to the `value` of
    the row its `canonical_of_id` points at (D187)."""
    rows = {
        v.id: v
        for v in session.scalars(
            select(Vocab).where(
                Vocab.project_id == project_id,
                Vocab.list == list_name,
                Vocab.deleted_at.is_(None),
                Vocab.state != "rejected",
            )
        )
    }
    out: dict[str, str] = {}
    for v in rows.values():
        if v.canonical_of_id is not None and (canon := rows.get(v.canonical_of_id)) is not None:
            out[v.value] = canon.value
    return out


# --------------------------------------------------------------- the job


def import_bom(session: Session, store: ObjectStore, batch: ImportBatch) -> dict[str, Any]:
    """Apply one queued BOM batch inside the caller's transaction; returns its stats."""
    if batch.kind != BOM_KIND:
        raise runner.ImportError_(f"not a BOM batch: {batch.kind}")
    files = batch.files or []
    if not files:
        raise runner.ImportError_("batch has no file")
    entry = files[0]
    project = session.scalars(
        select(Project).where(Project.id == batch.project_id).with_for_update()
    ).first()
    if project is None:
        raise runner.ImportError_(f"unknown project {batch.project_id}")

    earlier = session.scalars(
        select(ImportBatch).where(
            ImportBatch.project_id == project.id,
            ImportBatch.id != batch.id,
            ImportBatch.kind == BOM_KIND,
            ImportBatch.job_state == "done",
        )
    ).all()
    for b in earlier:
        if any(f.get("sha256") == entry.get("sha256") for f in (b.files or [])):
            return {"skipped": "already extracted", "earlier_batch": str(b.id)}

    try:
        data = store.read(entry["key"])
    except KeyError as e:
        raise runner.ImportError_(f"file {entry.get('key')} is not in the object store") from e

    target = target_of(session, project.id)
    try:
        result, lines = bom_extract.extract(data, target, ocr.ocr_page if ocr.available() else None)
    except bom_extract.NeedsOcr as e:
        raise runner.ImportError_(f"{e} (install tesseract-ocr on the server)") from e
    except ocr.OcrError as e:
        raise runner.ImportError_(str(e)) from e
    if not lines:
        raise runner.ImportError_(
            "no BOM table found (neither a submittal BOM nor a Material List)"
        )

    requester = session.get(User, batch.created_by_id) if batch.created_by_id else None
    user_id = (requester or system_user(session, "import")).id
    name = str(entry.get("name") or "bom.pdf")
    ops = _Ops(project.id, user_id, f"{REASON}: {name}")
    for draft in result.drafts:
        ops.create(
            "draft_device",
            {
                "project_id": project.id,
                "import_batch_id": batch.id,
                **draft.row(),
                "source_ref": {**draft.row()["source_ref"], "file": name},
            },
        )
    push = Push(session, _Body(project.id), trusted=True)
    out = push.run(ops.ops)
    not_applied = [r for r in out.results if r.outcome != "applied"]
    if not_applied:
        raise runner.ImportError_(
            f"{len(not_applied)} ops did not apply: "
            + ", ".join(f"{r.op_id} {r.outcome}" for r in not_applied[:5])
        )
    pages = sorted({ln.page for ln in lines})
    ocr_pages = sorted({ln.page for ln in lines if ln.extraction == "ocr"})
    stats = {
        "file": name,
        "lines": len(lines),
        "pages": pages,
        "ocr_pages": ocr_pages,
        "jobs": sorted({ln.job for ln in lines if ln.job}),
        **result.stats(),
        "excluded_lines": [e.out() for e in result.excluded],
        "ops": len(ops.ops),
        "last_server_seq": push.seq,
    }
    _event(
        "bom_applied",
        batch=str(batch.id),
        project=str(project.id),
        **{k: v for k, v in stats.items() if k != "excluded_lines"},
    )
    return stats


def run_queued(
    session_factory: runner.SessionFactory, store: ObjectStore, limit: int = 1
) -> list[str]:
    """Worker tick: run up to `limit` queued BOM batches, oldest first."""
    return runner.run_queued(session_factory, store, limit, kinds=(BOM_KIND,), job=import_bom)


# ------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.bom")
    parser.add_argument("project_id", type=uuid.UUID)
    parser.add_argument("pdf", help="path to the BOM PDF")
    parser.add_argument("--user", default=None, help="team name to record as the uploader")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    data = Path(args.pdf).read_bytes()
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            batch = create_bom_batch(
                s,
                store,
                project_id=args.project_id,
                filename=Path(args.pdf).name,
                data=data,
                user=user,
            )
        except runner.ImportError_ as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
    state = runner.run_batch(SessionLocal, store, batch.id, job=import_bom)
    with SessionLocal() as s:
        print(json.dumps(runner.batch_out(s.get(ImportBatch, batch.id)), indent=2, default=str))
    return 0 if state in ("done", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
