"""Seed import job (T27): `import_batch` lifecycle, the one-transaction apply, the worker tick
and a command line.

    POST /imports → import_batch(job_state="queued") → worker: run_queued() → done | failed
    python -m app.jobs.runner <project_id> <workbook.xlsx> [--user NAME] [--kind master_xlsx]

`import_workbook` is the whole job: read the file from the object store, build the plan
(`app.jobs.seed_import`), create the numbering groups and the `import` user the plan needs, push
every op through the ordinary apply loop (`Push`, trusted so the master's numbers are kept), store
the Change Log rows as historical ops, put the Photo Log images in the bucket as complete blobs,
and write the stats. All of it is one database transaction: a failure leaves the project exactly
as it was and the batch `failed` with the error; a retry starts over.

Idempotence is by file: a workbook (by SHA-256) already imported into the project is not imported
twice — the batch ends `skipped` and points at the earlier one. Re-importing a *changed* master
into a seeded project is a merge, not a seed (see `server/docs/imports.md`).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import sys
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import system_user, upsert_user
from app.blobs import object_key
from app.ids import uuid7
from app.jobs import seed_import
from app.jobs.workbook import WorkbookError, read_workbook
from app.models import Blob, ImportBatch, Level, NumberingGroup, Op, Placeholder, Project, User
from app.storage import ObjectStore
from app.sync import Push

log = logging.getLogger("jobs")

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SEED_KINDS = ("master_xlsx", "floor_xlsx")
STATES = ("queued", "running", "done", "failed", "skipped")


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


class ImportError_(Exception):
    """A job failure the batch records (bad file, unknown project…)."""


@dataclass
class _Body:
    """What `Push` reads from a push body."""

    project_id: uuid.UUID
    since: int | None = None


# ----------------------------------------------------------------- batches


def file_key(batch_id: uuid.UUID, filename: str) -> str:
    return f"imports/{batch_id}/{filename}"


def create_batch(
    session: Session,
    store: ObjectStore,
    *,
    project_id: uuid.UUID,
    kind: str,
    filename: str,
    data: bytes,
    user: User | None,
    mapping: dict[str, dict[str, str]] | None = None,
    mime: str = XLSX_MIME,
    extra: dict[str, Any] | None = None,
) -> ImportBatch:
    """Store the file and queue the job. Commits. `extra` goes into the file entry (the plans
    job keeps `level_id` / `sheet_kind` there, T45)."""
    if kind not in SEED_KINDS and kind != "plans":
        raise ImportError_(f"kind must be one of {', '.join((*SEED_KINDS, 'plans'))}")
    if session.get(Project, project_id) is None:
        raise ImportError_(f"unknown project {project_id}")
    if not data:
        raise ImportError_("empty file")
    batch_id = uuid7()
    key = file_key(batch_id, filename or "workbook.xlsx")
    store.put_file(key, io.BytesIO(data), mime)
    entry: dict[str, Any] = {
        "name": filename,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "key": key,
        **(extra or {}),
    }
    if mapping:
        entry["mapping"] = mapping  # column-mapping UI overrides (T28)
    batch = ImportBatch(
        id=batch_id,
        project_id=project_id,
        kind=kind,
        files=[entry],
        job_state="queued",
        stats=None,
        created_by_id=user.id if user else None,
    )
    session.add(batch)
    session.commit()
    _event("import_queued", batch=str(batch_id), project=str(project_id), kind=kind, file=filename)
    return batch


def batch_out(batch: ImportBatch) -> dict[str, Any]:
    return {
        "id": str(batch.id),
        "project_id": str(batch.project_id),
        "kind": batch.kind,
        "files": [{k: v for k, v in f.items() if k != "key"} for f in (batch.files or [])],
        "job_state": batch.job_state,
        "stats": batch.stats,
        "created_by_id": str(batch.created_by_id) if batch.created_by_id else None,
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
    }


# --------------------------------------------------------------- the job


def import_workbook(session: Session, store: ObjectStore, batch: ImportBatch) -> dict[str, Any]:
    """Apply one queued batch inside the caller's transaction and return its stats. Raises
    `ImportError_` (recorded on the batch) or lets a programming error propagate."""
    if batch.kind not in SEED_KINDS:
        raise ImportError_(f"not a seed import: {batch.kind}")
    files = batch.files or []
    if not files:
        raise ImportError_("batch has no file")
    entry = files[0]
    project = session.scalars(
        select(Project).where(Project.id == batch.project_id).with_for_update()
    ).first()
    if project is None:
        raise ImportError_(f"unknown project {batch.project_id}")

    earlier = session.scalars(
        select(ImportBatch).where(
            ImportBatch.project_id == batch.project_id,
            ImportBatch.id != batch.id,
            ImportBatch.job_state == "done",
        )
    ).all()
    for b in earlier:
        if any(f.get("sha256") == entry.get("sha256") for f in (b.files or [])):
            return {"skipped": "already imported", "earlier_batch": str(b.id)}

    try:
        data = store.read(entry["key"])
    except KeyError as e:
        raise ImportError_(f"file {entry.get('key')} is not in the object store") from e
    try:
        wb = read_workbook(io.BytesIO(data), entry.get("name"), entry.get("mapping"))
    except WorkbookError as e:
        raise ImportError_(str(e)) from e

    requester = session.get(User, batch.created_by_id) if batch.created_by_id else None
    import_user = system_user(session, seed_import.IMPORT_USER_NAME)
    target = seed_import.Target(
        project_id=project.id,
        user_id=(requester or import_user).id,
        import_user_id=import_user.id,
        levels=_levels(session, project.id, wb),
        placeholders={
            p.label: p.id
            for p in session.scalars(
                select(Placeholder).where(
                    Placeholder.project_id == project.id, Placeholder.deleted_at.is_(None)
                )
            )
        },
        source_name=entry.get("name") or "workbook",
    )
    plan = seed_import.build_plan(wb, target)

    push = Push(session, _Body(project.id), trusted=True)
    out = push.run(plan.ops)
    not_applied = [r for r in out.results if r.outcome != "applied"]
    if not_applied:  # an import writes only new records; anything else is a bug
        raise ImportError_(
            f"{len(not_applied)} ops did not apply: "
            + ", ".join(f"{r.op_id} {r.outcome}" for r in not_applied[:5])
        )
    for h in plan.history:
        push.store(Op(**h), "superseded")
    push.flush_ops()  # `store` batches op rows; `run` flushed its own, these need it too (T75)
    stored = 0
    for image in plan.blobs:
        if session.get(Blob, image.sha256) is None:
            store.put_file(object_key(image.sha256), io.BytesIO(image.data), image.mime)
            session.add(
                Blob(
                    sha256=image.sha256,
                    size=len(image.data),
                    mime=image.mime,
                    width=image.width,
                    height=image.height,
                    upload_state="complete",
                    chunks_received=[],
                )
            )
            stored += 1
    session.flush()
    stats = {
        **plan.stats,
        "server_ops": len(push.server_ops),
        "blobs_stored": stored,
        "last_server_seq": push.seq,
        "checks_list": plan.checks[:200],
    }
    _event(
        "import_applied",
        batch=str(batch.id),
        project=str(project.id),
        **{k: v for k, v in stats.items() if k != "checks_list"},
    )
    return stats


def _levels(session: Session, project_id: uuid.UUID, wb) -> dict[str, seed_import.LevelRef]:
    """The workbook's floors as `LevelRef`s: existing project levels by code, new ones with a
    numbering group per floor family (06 and 06M share one, D33), created here as rows."""
    existing = {
        lv.level: lv
        for lv in session.scalars(
            select(Level).where(Level.project_id == project_id, Level.deleted_at.is_(None))
        )
    }
    groups_by_family: dict[str, NumberingGroup] = {}
    for lv in existing.values():
        g = session.get(NumberingGroup, lv.numbering_group_id)
        if g is not None:
            groups_by_family.setdefault(seed_import.family(lv.level), g)
    refs: dict[str, seed_import.LevelRef] = {}
    for row in wb.levels:
        code = seed_import.norm_level(row.code)
        if code in existing:
            lv = existing[code]
            refs[code] = seed_import.LevelRef(
                code=code,
                level_id=lv.id,
                numbering_group_id=lv.numbering_group_id,
                floor_order=lv.floor_order if lv.floor_order is not None else row.floor_order,
                exists=True,
                surveyed=lv.surveyed,
                updated=lv.updated,
            )
            continue
        fam = seed_import.family(code)
        group = groups_by_family.get(fam)
        if group is None:
            members = [
                seed_import.norm_level(r.code)
                for r in wb.levels
                if seed_import.family(seed_import.norm_level(r.code)) == fam
            ]
            group = NumberingGroup(id=uuid7(), project_id=project_id, label="/".join(members))
            session.add(group)
            session.flush()
            groups_by_family[fam] = group
        refs[code] = seed_import.LevelRef(
            code=code,
            level_id=uuid7(),
            numbering_group_id=group.id,
            floor_order=row.floor_order,
            exists=False,
            surveyed=row.surveyed,
            updated=row.updated,
        )
    return refs


# ------------------------------------------------------------- lifecycle

SessionFactory = Callable[[], Session]
Job = Callable[[Session, ObjectStore, ImportBatch], dict[str, Any]]


def run_batch(
    session_factory: SessionFactory,
    store: ObjectStore,
    batch_id: uuid.UUID,
    job: Job = import_workbook,
) -> str:
    """Run one batch to `done`, `skipped` or `failed`; returns the final state. The data
    transaction and the batch-state updates are separate sessions so a failure is recorded.
    `job` is the seed import by default; the plans job (`app.jobs.plans`) passes its own."""
    with session_factory() as s:
        batch = s.get(ImportBatch, batch_id)
        if batch is None:
            raise ImportError_(f"unknown batch {batch_id}")
        if batch.job_state not in ("queued", "failed"):
            return batch.job_state
        batch.job_state = "running"
        batch.stats = {"started_at": datetime.now(UTC).isoformat()}
        s.commit()
    state = "failed"
    stats: dict[str, Any]
    try:
        with session_factory() as s:
            batch = s.get(ImportBatch, batch_id)
            assert batch is not None
            stats = job(s, store, batch)
            s.commit()
        state = "skipped" if "skipped" in stats else "done"
    except ImportError_ as e:
        stats = {"error": str(e)}
    except Exception as e:  # noqa: BLE001 - recorded on the batch, logged, worker keeps running
        stats = {"error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
        log.error(json.dumps({"event": "import_crashed", "batch": str(batch_id), "error": repr(e)}))
    with session_factory() as s:
        batch = s.get(ImportBatch, batch_id)
        assert batch is not None
        batch.job_state = state
        batch.stats = {**stats, "finished_at": datetime.now(UTC).isoformat()}
        s.commit()
    _event("import_finished", batch=str(batch_id), state=state)
    return state


def run_queued(
    session_factory: SessionFactory,
    store: ObjectStore,
    limit: int = 1,
    kinds: tuple[str, ...] = SEED_KINDS,
    job: Job = import_workbook,
) -> list[str]:
    """Worker tick: run up to `limit` queued batches of `kinds` with `job`, oldest first."""
    with session_factory() as s:
        ids = list(
            s.scalars(
                select(ImportBatch.id)
                .where(ImportBatch.job_state == "queued", ImportBatch.kind.in_(kinds))
                .order_by(ImportBatch.created_at)
                .limit(limit)
            )
        )
    return [run_batch(session_factory, store, i, job) for i in ids]


# ------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.runner")
    parser.add_argument("project_id", type=uuid.UUID)
    parser.add_argument("workbook", help="path to the master or floor .xlsx")
    parser.add_argument("--user", default=None, help="team name to record as the importer")
    parser.add_argument("--kind", default="master_xlsx", choices=SEED_KINDS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with open(args.workbook, "rb") as f:
        data = f.read()
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            batch = create_batch(
                s,
                store,
                project_id=args.project_id,
                kind=args.kind,
                filename=args.workbook.replace("\\", "/").rsplit("/", 1)[-1],
                data=data,
                user=user,
            )
        except ImportError_ as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
    state = run_batch(SessionLocal, store, batch.id)
    with SessionLocal() as s:
        print(json.dumps(batch_out(s.get(ImportBatch, batch.id)), indent=2, default=str))
    return 0 if state in ("done", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
