"""Export jobs (PLAN §8 `/exports`, T29): the `export` row's lifecycle, the worker tick, the
daily master export backup (D149, T82) and a command line.

    POST /exports → export(job_state="queued") → worker: run_queued() → done | failed
    POST /exports/{id}/cancel → cancelled (queued: at once; running: at its next progress report)
    python -m app.jobs.exports <project_id> --out master.xlsx [--levels B2,B1] [--user NAME]

`run_export` builds the workbook from the materialised tables (`app.jobs.export_xlsx`), stores it
as a content-addressed blob (`blobs/<sha256>`, a `blob` row with the xlsx MIME type, so an iPad
downloads it through `GET /blobs/{sha}/content` like a photo) and records `export.blob`, the
stats (filename, row counts, timings) and a `diff_summary` against the project's previous xlsx
export. A failure leaves the row `failed` with the error; the worker keeps running.

One queued or running export per project and kind (T93, D166; the `ux_export_active` index):
a second one is refused with `ExportBusy`. While it runs, the job writes its stage and counts
into `stats` (`Progress`, about once a second) and stops when Cancel was pressed.

Filename: `Lighting_Control_Survey_Master_<first>-<last>_<n>.xlsx`, Landry's convention for the
fixture (`…_B2-06_4.xlsx`), with `n` the project's xlsx export count.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import re
import sys
import time
import traceback
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import openpyxl
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from app.auth import system_user, upsert_user
from app.blobs import object_key
from app.config import settings
from app.ids import uuid7
from app.jobs import export_xlsx, floor_pdf
from app.models import Blob, Export, Op, Project, User
from app.storage import ObjectMissing, ObjectStore

log = logging.getLogger("jobs")

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KINDS = ("xlsx", "floor_pdf")  # floor_pdf: T59, app.jobs.floor_pdf
MIME = {"xlsx": XLSX_MIME, "floor_pdf": "application/pdf"}
STATES = ("queued", "running", "done", "failed", "cancelled")
ACTIVE = ("queued", "running")  # at most one per project and kind (D166)
EXPORT_USER_NAME = "export"  # the daily backup's system user
DAILY_GAP = timedelta(hours=20)  # D149: a restart never doubles the day's backup
DATA_TABS = ("Devices", "Connections", "Punch List", "Missing Parts", "Photo Log")
COMPARING = "Comparing with the last export"
COMPARE_EVERY = 500  # rows between the compare's progress reports (Cancel lands there, T170)


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


class ExportError(Exception):
    """A job failure the export row records (unknown project, bad params…)."""


class ExportBusy(ExportError):
    """An export of this project and kind is already queued or running (D166)."""

    def __init__(self, active: Export):
        super().__init__(f"an export is already {active.job_state}: {active.id}")
        self.active = active


class ExportCancelled(Exception):
    """Raised inside a running job when Cancel was pressed (D166)."""


def active_export(session: Session, project_id: uuid.UUID, kind: str) -> Export | None:
    return session.scalars(
        select(Export).where(
            Export.project_id == project_id, Export.kind == kind, Export.job_state.in_(ACTIVE)
        )
    ).first()


# ----------------------------------------------------------------- rows


def create_export(
    session: Session,
    *,
    project_id: uuid.UUID,
    kind: str = "xlsx",
    params: dict[str, Any] | None = None,
    user: User | None,
) -> Export:
    """Queue an export. Commits."""
    if kind not in KINDS:
        raise ExportError(f"kind must be one of {', '.join(KINDS)}")
    if session.get(Project, project_id) is None:
        raise ExportError(f"unknown project {project_id}")
    params = dict(params or {})
    levels = params.get("levels")
    if levels is not None and (
        not isinstance(levels, list) or not all(isinstance(c, str) and c for c in levels)
    ):
        raise ExportError("params.levels must be a list of level codes")
    if kind == "floor_pdf":
        level = params.get("level")
        if not isinstance(level, str) or not level:
            raise ExportError("params.level (one level code) is required for a floor PDF")
        sections = params.get("sections")
        if sections is not None and (
            not isinstance(sections, list)
            or not sections
            or not set(sections) <= set(floor_pdf.SECTIONS)
        ):
            raise ExportError(
                f"params.sections must be a non-empty list of: {', '.join(floor_pdf.SECTIONS)}"
            )
    tabs = params.get("tabs")
    if tabs is not None and (
        not isinstance(tabs, list) or not tabs or not set(tabs) <= set(DATA_TABS)
    ):
        raise ExportError(f"params.tabs must be a non-empty list of: {', '.join(DATA_TABS)}")
    busy = active_export(session, project_id, kind)
    if busy is not None:
        raise ExportBusy(busy)
    row = Export(
        id=uuid7(),
        project_id=project_id,
        kind=kind,
        params=params or None,
        job_state="queued",
        created_by_id=user.id if user else None,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:  # two people pressed Generate at the same moment
        session.rollback()
        busy = active_export(session, project_id, kind)
        if busy is None:
            raise
        raise ExportBusy(busy) from None
    _event("export_queued", export=str(row.id), project=str(project_id), kind=kind, params=params)
    return row


def _user_name(row: Export, user_id: uuid.UUID | None) -> str | None:
    s = object_session(row)
    user = s.get(User, user_id) if s is not None and user_id else None
    return user.name if user else None


def export_out(row: Export) -> dict[str, Any]:
    stats = row.stats or {}
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "kind": row.kind,
        "params": row.params,
        "job_state": row.job_state,
        "blob": row.blob,
        "filename": stats.get("filename"),
        "stats": row.stats,
        "diff_summary": row.diff_summary,
        "created_by_id": str(row.created_by_id) if row.created_by_id else None,
        "created_by": _user_name(row, row.created_by_id),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "cancel_requested_at": (
            row.cancel_requested_at.isoformat() if row.cancel_requested_at else None
        ),
        "cancelled_by": _user_name(row, row.cancelled_by_id),
    }


def filename_for(levels: list[str], n: int) -> str:
    if levels:
        first, last = export_xlsx.family(levels[0]), export_xlsx.family(levels[-1])
        span = f"{first}-{last}"
    else:
        span = "none"
    span = re.sub(r"[^A-Za-z0-9-]", "", span)
    return f"Lighting_Control_Survey_Master_{span}_{n}.xlsx"


# ---------------------------------------------------------------- the job


def build(
    session: Session,
    store: ObjectStore,
    row: Export,
    progress: export_xlsx.ProgressFn = export_xlsx.no_progress,
) -> dict[str, Any]:
    """Write the workbook for one export row into the object store and return its stats. The
    caller owns the transaction."""
    if row.kind == "floor_pdf":
        return build_floor_pdf(session, store, row, progress)
    if row.kind != "xlsx":
        raise ExportError(f"not an xlsx export: {row.kind}")
    started = time.monotonic()
    try:
        data_bytes, data = export_xlsx.export_bytes(
            session, store, row.project_id, row.params, progress
        )
    except LookupError as e:
        raise ExportError(str(e)) from e
    sha = hashlib.sha256(data_bytes).hexdigest()
    n = session.scalar(
        select(func.count())
        .select_from(Export)
        .where(
            Export.project_id == row.project_id, Export.kind == "xlsx", Export.job_state == "done"
        )
    )
    previous = session.scalars(
        select(Export)
        .where(
            Export.project_id == row.project_id,
            Export.kind == "xlsx",
            Export.job_state == "done",
            Export.id != row.id,
        )
        .order_by(Export.created_at.desc())
    ).first()
    # Compared before it is saved (T170, D261): the compare reports progress, so a Cancel during
    # it stops the job with nothing stored; after "Saving the file" the job only finishes.
    if previous:
        progress(COMPARING)
    row.diff_summary = diff_summary(store, previous, data, progress) if previous else None
    progress("Saving the file")
    if session.get(Blob, sha) is None:
        store.put_file(object_key(sha), io.BytesIO(data_bytes), XLSX_MIME)
        session.add(
            Blob(
                sha256=sha,
                size=len(data_bytes),
                mime=XLSX_MIME,
                upload_state="complete",
                chunks_received=[],
            )
        )
    row.blob = sha
    stats = {
        **data.stats,
        "filename": filename_for(data.levels, (n or 0) + 1),
        "sha256": sha,
        "bytes": len(data_bytes),
        "seconds": round(time.monotonic() - started, 2),
        "checks_list": data.checks[:200],
        "previous_export": str(previous.id) if previous else None,
    }
    _event(
        "export_built",
        export=str(row.id),
        project=str(row.project_id),
        **{k: v for k, v in stats.items() if k != "checks_list"},
    )
    return stats


def floor_filename(level: str, n: int) -> str:
    """`ETC_Lighting_Controls_Survey_Level_06M_<n>.pdf`, `n` = that level's finished floor PDFs."""
    return f"ETC_Lighting_Controls_Survey_Level_{re.sub(r'[^A-Za-z0-9-]', '', level)}_{n}.pdf"


def build_floor_pdf(
    session: Session,
    store: ObjectStore,
    row: Export,
    progress: export_xlsx.ProgressFn = export_xlsx.no_progress,
) -> dict[str, Any]:
    """The floor PDF of `params.level` (T59, PLAN §7.7) as a blob; returns its stats."""
    started = time.monotonic()
    params = row.params or {}
    level = str(params.get("level") or "")
    sections = tuple(params.get("sections") or floor_pdf.SECTIONS)
    try:
        data = floor_pdf.load(session, store, row.project_id, level, sections, progress)
    except LookupError as e:
        raise ExportError(str(e)) from e
    progress("Rendering the PDF")
    pdf = floor_pdf.render(data)
    sha = hashlib.sha256(pdf).hexdigest()
    progress("Saving the file")
    if session.get(Blob, sha) is None:
        store.put_file(object_key(sha), io.BytesIO(pdf), floor_pdf.PDF_MIME)
        session.add(
            Blob(
                sha256=sha,
                size=len(pdf),
                mime=floor_pdf.PDF_MIME,
                upload_state="complete",
                chunks_received=[],
            )
        )
    done = session.scalars(
        select(Export).where(
            Export.project_id == row.project_id,
            Export.kind == "floor_pdf",
            Export.job_state == "done",
            Export.id != row.id,
        )
    ).all()
    n = sum(1 for e in done if (e.params or {}).get("level") == data.level) + 1
    row.blob = sha
    row.diff_summary = None
    stats = {
        "filename": floor_filename(data.level, n),
        "levels": [data.level],
        "sections": list(data.sections),
        "rows": {
            "Devices": len(data.devices),
            "Findings": sum(1 for d in data.devices if d.status != floor_pdf.NOT_A_FINDING),
            "Connections": len(data.connections),
            "Punch List": len(data.punch),
            "Missing Parts": len(data.parts),
            "Photos": len(data.photos),
        },
        "images_missing": sum(1 for p in data.photos if p.jpeg is None),
        "sha256": sha,
        "bytes": len(pdf),
        "seconds": round(time.monotonic() - started, 2),
        "checks_list": data.checks[:200],
    }
    _event(
        "export_built",
        export=str(row.id),
        project=str(row.project_id),
        **{k: v for k, v in stats.items() if k != "checks_list"},
    )
    return stats


def _rows_by_key(ws, tick: Callable[[], None] = lambda: None) -> dict[tuple, tuple]:
    """Data rows of a tab keyed by (Level, ID | #); the Image column is never compared. `ws` is a
    read-only sheet (T171: rows streamed as values; the full-mode walk read `ws.max_column`, a
    scan of every cell, once per row — 16 s on a 10,000-row Photo Log). `tick` runs every
    `COMPARE_EVERY` rows (the job's progress report, where Cancel lands — T170)."""
    out: dict[tuple, tuple] = {}
    for i, values in enumerate(ws.iter_rows(min_row=4, values_only=True)):
        if i % COMPARE_EVERY == COMPARE_EVERY - 1:
            tick()
        if all(v is None for v in values):
            continue
        key = (values[0], values[1])
        out[key] = tuple(v.isoformat() if hasattr(v, "isoformat") else v for v in values)
    return out


def diff_summary(
    store: ObjectStore,
    previous: Export,
    data: export_xlsx.ExportData,
    progress: export_xlsx.ProgressFn = export_xlsx.no_progress,
) -> dict[str, Any]:
    """Rows added / removed / changed per tab against the previous xlsx export. Reports
    `Comparing with the last export n / N tabs` at each tab and every `COMPARE_EVERY` rows, so
    Cancel stops it (T170, D261). The previous file is opened read-only (T171, D262): its load,
    the one step that reports nothing, is under half a second on the 34 MB scale workbook."""
    out: dict[str, Any] = {"previous": str(previous.id), "tabs": {}}
    if not previous.blob:
        out["note"] = "previous export has no file"
        return out
    try:
        old = openpyxl.load_workbook(
            io.BytesIO(store.read(object_key(previous.blob))), read_only=True, data_only=True
        )
    except (ObjectMissing, KeyError, Exception) as e:  # noqa: BLE001 - a summary, never fatal
        out["note"] = f"previous export unreadable: {type(e).__name__}"
        return out
    try:
        _compare_tabs(old, data, out, progress)
    finally:
        old.close()
    return out


def _compare_tabs(
    old: openpyxl.Workbook,
    data: export_xlsx.ExportData,
    out: dict[str, Any],
    progress: export_xlsx.ProgressFn,
) -> None:
    exported = set(data.stats.get("tabs") or DATA_TABS)
    # compare only tabs both files have (an export may leave tabs out, D141)
    tabs = [t for t in DATA_TABS if t in exported and t in old.sheetnames]
    for i, tab in enumerate(tabs):

        def tick(i: int = i) -> None:
            progress(COMPARING, i, len(tabs), "tabs")

        tick()
        new_rows = {
            (r[0], r[1]): tuple(v.isoformat() if hasattr(v, "isoformat") else v for v in r)
            for r in data.rows.get(tab, [])
        }
        old_rows = _rows_by_key(old[tab], tick)
        added = [k for k in new_rows if k not in old_rows]
        removed = [k for k in old_rows if k not in new_rows]
        changed = [
            k
            for k in new_rows
            if k in old_rows and _comparable(new_rows[k]) != _comparable(old_rows[k])
        ]
        out["tabs"][tab] = {
            "rows": len(new_rows),
            "added": len(added),
            "removed": len(removed),
            "changed": len(changed),
            "examples": [f"{k[0]} {k[1]}" for k in (added + removed + changed)[:5]],
        }


def _comparable(row: tuple) -> tuple:
    # Photo Log pictures are not cells; the other tabs compare whole.
    return tuple(None if v == "" else v for v in row[:8] if not isinstance(v, bytes))


# ------------------------------------------------------------- lifecycle

SessionFactory = Callable[[], Session]


class Progress:
    """The running job's stage and counts in `export.stats` (T93, D166): `started_at`, `stage`,
    `done` / `total` / `unit` (e.g. Photo Log 3,200 / 10,000 pictures) and `stage_seconds`, the
    time each finished stage took (T94 measures with them). Written in its own transaction at a
    new stage and otherwise at most once every `every` seconds; each write reads
    `cancel_requested_at` and raises `ExportCancelled` when Cancel was pressed."""

    def __init__(
        self,
        session_factory: SessionFactory,
        export_id: uuid.UUID,
        started_at: str,
        every: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.session_factory = session_factory
        self.export_id = export_id
        self.started_at = started_at
        self.every = every
        self.clock = clock
        self.stage: str | None = None
        self.stage_started = 0.0
        self.last_write: float | None = None
        self.stage_seconds: dict[str, float] = {}

    def __call__(
        self, stage: str, done: int | None = None, total: int | None = None, unit: str | None = None
    ) -> None:
        now = self.clock()
        if stage != self.stage:
            self.finish()
            self.stage, self.stage_started = stage, now
        elif self.last_write is not None and now - self.last_write < self.every:
            return
        self.last_write = now
        stats: dict[str, Any] = {**self.base(), "stage": stage}
        if total is not None:
            stats.update(done=done or 0, total=total, unit=unit)
        with self.session_factory() as s:
            cancel = s.execute(
                update(Export)
                .where(Export.id == self.export_id)
                .values(stats=stats)
                .returning(Export.cancel_requested_at)
            ).scalar()
            s.commit()
        if cancel is not None:
            raise ExportCancelled()

    def finish(self) -> None:
        """Close the current stage's timing."""
        if self.stage is not None:
            self.stage_seconds[self.stage] = round(self.clock() - self.stage_started, 2)
            self.stage = None

    def base(self) -> dict[str, Any]:
        return {"started_at": self.started_at, "stage_seconds": dict(self.stage_seconds)}


def run_export(session_factory: SessionFactory, store: ObjectStore, export_id: uuid.UUID) -> str:
    """Run one export to `done`, `failed` or `cancelled`; returns the final state."""
    started_at = datetime.now(UTC).isoformat()
    with session_factory() as s:
        row = s.get(Export, export_id)
        if row is None:
            raise ExportError(f"unknown export {export_id}")
        if row.job_state not in ("queued", "failed"):
            return row.job_state
        # only a row still queued (or failed, rerun by hand) starts: Cancel may have just won
        started = s.execute(
            update(Export)
            .where(Export.id == export_id, Export.job_state.in_(("queued", "failed")))
            .values(job_state="running", stats={"started_at": started_at})
        ).rowcount
        s.commit()
        if not started:
            s.expire_all()
            return s.get(Export, export_id).job_state
    progress = Progress(session_factory, export_id, started_at)
    state = "failed"
    stats: dict[str, Any]
    try:
        progress("Starting")
        with session_factory() as s:
            row = s.get(Export, export_id)
            assert row is not None
            stats = build(s, store, row, progress)
            s.commit()
        state = "done"
    except ExportCancelled:
        state, stats = "cancelled", {}
    except ExportError as e:
        stats = {"error": str(e)}
    except Exception as e:  # noqa: BLE001 - recorded on the row, logged, worker keeps running
        stats = {"error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
        log.error(
            json.dumps({"event": "export_crashed", "export": str(export_id), "error": repr(e)})
        )
    progress.finish()
    with session_factory() as s:
        row = s.get(Export, export_id)
        assert row is not None
        row.job_state = state
        row.stats = {**progress.base(), **stats, "finished_at": datetime.now(UTC).isoformat()}
        s.commit()
    _event("export_finished", export=str(export_id), state=state, stages=progress.stage_seconds)
    return state


def cancel_export(session: Session, export_id: uuid.UUID, user: User | None) -> Export:
    """Cancel (D166, anyone on the team): a queued export is cancelled at once; a running one is
    flagged and stops at its next progress report; a finished one is left as it is. Commits."""
    if session.get(Export, export_id) is None:
        raise ExportError(f"unknown export {export_id}")
    now = datetime.now(UTC)
    by = user.id if user else None
    queued = session.execute(
        update(Export)
        .where(Export.id == export_id, Export.job_state == "queued")
        .values(
            job_state="cancelled",
            cancel_requested_at=now,
            cancelled_by_id=by,
            stats={"finished_at": now.isoformat()},
        )
    ).rowcount
    if not queued:
        session.execute(
            update(Export)
            .where(
                Export.id == export_id,
                Export.job_state == "running",
                Export.cancel_requested_at.is_(None),
            )
            .values(cancel_requested_at=now, cancelled_by_id=by)
        )
    session.commit()
    row = session.get(Export, export_id)
    assert row is not None
    session.refresh(row)
    _event(
        "export_cancel", export=str(export_id), state=row.job_state, by=user.name if user else None
    )
    return row


def recover_interrupted(session_factory: SessionFactory) -> list[str]:
    """Worker start: a job left `running` by a restart (a deploy) is queued again, or cancelled
    if Cancel was pressed meanwhile; jobs are idempotent, so it simply runs again."""
    with session_factory() as s:
        rows = s.scalars(select(Export).where(Export.job_state == "running")).all()
        now = datetime.now(UTC).isoformat()
        for row in rows:
            if row.cancel_requested_at is not None:
                row.job_state = "cancelled"
                row.stats = {**(row.stats or {}), "finished_at": now}
            else:
                row.job_state = "queued"
                row.stats = {"restarted_at": now}
        s.commit()
        out = [f"{r.id}:{r.job_state}" for r in rows]
    if out:
        _event("export_recovered", exports=out)
    return out


def run_queued(session_factory: SessionFactory, store: ObjectStore, limit: int = 1) -> list[str]:
    """Worker tick: run up to `limit` queued exports, oldest first."""
    with session_factory() as s:
        ids = list(
            s.scalars(
                select(Export.id)
                .where(Export.job_state == "queued", Export.kind.in_(KINDS))
                .order_by(Export.created_at)
                .limit(limit)
            )
        )
    return [run_export(session_factory, store, i) for i in ids]


_daily_checked_on = None


def _project_seq(session: Session, project_id: uuid.UUID) -> int | None:
    """The project's newest server sequence: every edit, import and assignment is an op."""
    return session.scalar(select(func.max(Op.server_seq)).where(Op.project_id == project_id))


def _unchanged_since(last: Export | None, seq: int | None) -> bool:
    """True when `last` (the newest finished backup) already holds everything up to `seq` with
    every picture in it; a backup that missed a photo still in upload is taken again."""
    if last is None or seq is None:
        return False
    return (last.params or {}).get("server_seq") == seq and not (last.stats or {}).get(
        "images_missing"
    )


def daily_tick(
    session_factory: SessionFactory, store: ObjectStore, now: datetime | None = None
) -> list[str]:
    """D149's daily master export backup: from `BACKUP_HOUR_UTC`, gated by `BACKUP_ENABLED`, queue
    and run one xlsx export per project by the `export` user (`params.scheduled`, with the
    project's `server_seq`), unless the project has a scheduled export in the last 20 hours or
    nothing changed since its last finished one (T82). Then prune backups past
    `EXPORT_BACKUP_RETENTION_DAYS`. Checked once a day; never raises."""
    global _daily_checked_on
    now = now or datetime.now(UTC)
    if not settings.backup_enabled or _daily_checked_on == now.date():
        return []
    if now.hour < settings.backup_hour_utc:
        return []
    ran: list[str] = []
    try:
        with session_factory() as s:
            user = system_user(s, EXPORT_USER_NAME)
            s.commit()
            projects = s.scalars(select(Project).where(Project.deleted_at.is_(None))).all()
            scheduled = (
                Export.kind == "xlsx",
                Export.created_by_id == user.id,
                Export.params["scheduled"].as_boolean().is_(True),
            )
            due: list[tuple[uuid.UUID, int | None]] = []
            for p in projects:
                recent = s.scalar(
                    select(func.count())
                    .select_from(Export)
                    .where(
                        Export.project_id == p.id, *scheduled, Export.created_at >= now - DAILY_GAP
                    )
                )
                if recent:
                    continue
                seq = _project_seq(s, p.id)
                last = s.scalars(
                    select(Export)
                    .where(Export.project_id == p.id, *scheduled, Export.job_state == "done")
                    .order_by(Export.created_at.desc())
                    .limit(1)
                ).first()
                if _unchanged_since(last, seq):
                    _event("export_daily_unchanged", project=str(p.id), server_seq=seq)
                    continue
                due.append((p.id, seq))
            ids = []
            busy = False
            for pid, seq in due:
                params = {"scheduled": True, "server_seq": seq}
                try:
                    row = create_export(s, project_id=pid, params=params, user=user)
                except ExportBusy:  # someone's workbook is queued or running: next minute
                    busy = True
                    _event("export_daily_busy", project=str(pid))
                    continue
                ids.append(row.id)  # read while the session is open (commit expires the row)
        for export_id in ids:
            ran.append(run_export(session_factory, store, export_id))
        prune_backups(session_factory, store, now)
        if not busy:
            _daily_checked_on = now.date()
    except Exception as e:  # noqa: BLE001 - the worker must keep running (CLAUDE.md §5)
        _event("export_daily_failed", error=repr(e), ran=ran)
    return ran


def prune_backups(
    session_factory: SessionFactory, store: ObjectStore, now: datetime | None = None
) -> list[str]:
    """Delete the files of scheduled exports older than `EXPORT_BACKUP_RETENTION_DAYS` (T82: six
    months), always keeping each project's newest one (with skip-unchanged it can be old and still
    current). The export row stays in the history with `stats.pruned_at`; its file then answers
    404. A file another export row still uses is kept. The copy bucket keeps every file it ever
    received (rclone copy, never sync). Returns the pruned export ids."""
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=settings.export_backup_retention_days)
    pruned: list[str] = []
    with session_factory() as s:
        user = system_user(s, EXPORT_USER_NAME)
        rows = s.scalars(
            select(Export)
            .where(
                Export.kind == "xlsx",
                Export.created_by_id == user.id,
                Export.params["scheduled"].as_boolean().is_(True),
                Export.job_state == "done",
                Export.blob.is_not(None),
            )
            .order_by(Export.project_id, Export.created_at.desc())
        ).all()
        newest: set[uuid.UUID] = set()
        old: list[Export] = []
        for row in rows:
            if row.project_id not in newest:
                newest.add(row.project_id)  # each project's newest backup is always kept
            elif row.created_at < cutoff and not (row.stats or {}).get("pruned_at"):
                old.append(row)
        old_ids = {r.id for r in old}
        for row in old:
            shared = s.scalar(
                select(func.count())
                .select_from(Export)
                .where(Export.blob == row.blob, Export.id.not_in(old_ids))
            )
            if not shared:
                store.delete_many([object_key(row.blob)])
                blob = s.get(Blob, row.blob)
                if blob is not None:
                    s.delete(blob)  # so an identical file later is stored again, not assumed
            row.stats = {**(row.stats or {}), "pruned_at": now.isoformat()}
            pruned.append(str(row.id))
        s.commit()
    if pruned:
        _event("export_backup_pruned", exports=len(pruned), cutoff=cutoff.isoformat())
    return pruned


# ------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.exports")
    parser.add_argument("project_id", type=uuid.UUID)
    parser.add_argument("--out", default=None, help="also write the workbook to this path")
    parser.add_argument(
        "--levels", default=None, help="comma-separated level codes (default: in scope)"
    )
    parser.add_argument("--user", default=None, help="team name to record as the requester")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    params = (
        {"levels": [c.strip() for c in args.levels.split(",") if c.strip()]}
        if args.levels
        else None
    )
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            row = create_export(s, project_id=args.project_id, params=params, user=user)
        except ExportError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
    state = run_export(SessionLocal, store, row.id)
    with SessionLocal() as s:
        row = s.get(Export, row.id)
        print(json.dumps(export_out(row), indent=2, default=str))
        if state == "done" and args.out:
            with open(args.out, "wb") as f:
                f.write(store.read(object_key(row.blob)))
            print(f"written {args.out}")
    return 0 if state == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
