"""Export jobs (PLAN §8 `/exports`, T29): the `export` row's lifecycle, the worker tick, the
weekly master export (D67) and a command line.

    POST /exports → export(job_state="queued") → worker: run_queued() → done | failed
    python -m app.jobs.exports <project_id> --out master.xlsx [--levels B2,B1] [--user NAME]

`run_export` builds the workbook from the materialised tables (`app.jobs.export_xlsx`), stores it
as a content-addressed blob (`blobs/<sha256>`, a `blob` row with the xlsx MIME type, so an iPad
downloads it through `GET /blobs/{sha}/content` like a photo) and records `export.blob`, the
stats (filename, row counts, timings) and a `diff_summary` against the project's previous xlsx
export. A failure leaves the row `failed` with the error; the worker keeps running.

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
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import system_user, upsert_user
from app.blobs import object_key
from app.config import settings
from app.ids import uuid7
from app.jobs import export_xlsx, floor_pdf
from app.models import Blob, Export, Project, User
from app.storage import ObjectMissing, ObjectStore

log = logging.getLogger("jobs")

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
KINDS = ("xlsx", "floor_pdf")  # floor_pdf: T59, app.jobs.floor_pdf
MIME = {"xlsx": XLSX_MIME, "floor_pdf": "application/pdf"}
STATES = ("queued", "running", "done", "failed")
EXPORT_USER_NAME = "export"  # the weekly job's system user
WEEKLY_GAP = timedelta(days=6)
DATA_TABS = ("Devices", "Connections", "Punch List", "Missing Parts", "Photo Log")


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


class ExportError(Exception):
    """A job failure the export row records (unknown project, bad params…)."""


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
    row = Export(
        id=uuid7(),
        project_id=project_id,
        kind=kind,
        params=params or None,
        job_state="queued",
        created_by_id=user.id if user else None,
    )
    session.add(row)
    session.commit()
    _event("export_queued", export=str(row.id), project=str(project_id), kind=kind, params=params)
    return row


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
        "created_at": row.created_at.isoformat() if row.created_at else None,
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


def build(session: Session, store: ObjectStore, row: Export) -> dict[str, Any]:
    """Write the workbook for one export row into the object store and return its stats. The
    caller owns the transaction."""
    if row.kind == "floor_pdf":
        return build_floor_pdf(session, store, row)
    if row.kind != "xlsx":
        raise ExportError(f"not an xlsx export: {row.kind}")
    started = time.monotonic()
    try:
        data_bytes, data = export_xlsx.export_bytes(session, store, row.project_id, row.params)
    except LookupError as e:
        raise ExportError(str(e)) from e
    sha = hashlib.sha256(data_bytes).hexdigest()
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
    row.blob = sha
    row.diff_summary = diff_summary(store, previous, data) if previous else None
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


def build_floor_pdf(session: Session, store: ObjectStore, row: Export) -> dict[str, Any]:
    """The floor PDF of `params.level` (T59, PLAN §7.7) as a blob; returns its stats."""
    started = time.monotonic()
    params = row.params or {}
    level = str(params.get("level") or "")
    sections = tuple(params.get("sections") or floor_pdf.SECTIONS)
    try:
        data = floor_pdf.load(session, store, row.project_id, level, sections)
    except LookupError as e:
        raise ExportError(str(e)) from e
    pdf = floor_pdf.render(data)
    sha = hashlib.sha256(pdf).hexdigest()
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


def _rows_by_key(ws) -> dict[tuple, tuple]:
    """Data rows of a tab keyed by (Level, ID | #); the Image column is never compared."""
    out: dict[tuple, tuple] = {}
    for r in range(4, ws.max_row + 1):
        values = [ws.cell(r, c).value for c in range(1, ws.max_column + 1)]
        if all(v is None for v in values):
            continue
        key = (values[0], values[1])
        out[key] = tuple(v.isoformat() if hasattr(v, "isoformat") else v for v in values)
    return out


def diff_summary(
    store: ObjectStore, previous: Export, data: export_xlsx.ExportData
) -> dict[str, Any]:
    """Rows added / removed / changed per tab against the previous xlsx export."""
    out: dict[str, Any] = {"previous": str(previous.id), "tabs": {}}
    if not previous.blob:
        out["note"] = "previous export has no file"
        return out
    try:
        old = openpyxl.load_workbook(
            io.BytesIO(store.read(object_key(previous.blob))), data_only=True
        )
    except (ObjectMissing, KeyError, Exception) as e:  # noqa: BLE001 - a summary, never fatal
        out["note"] = f"previous export unreadable: {type(e).__name__}"
        return out
    exported = set(data.stats.get("tabs") or DATA_TABS)
    for tab in DATA_TABS:
        # compare only tabs both files have (an export may leave tabs out, D141)
        if tab not in exported or tab not in old.sheetnames:
            continue
        new_rows = {
            (r[0], r[1]): tuple(v.isoformat() if hasattr(v, "isoformat") else v for v in r)
            for r in data.rows.get(tab, [])
        }
        old_rows = _rows_by_key(old[tab]) if tab in old.sheetnames else {}
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
    return out


def _comparable(row: tuple) -> tuple:
    # Photo Log pictures are not cells; the other tabs compare whole.
    return tuple(None if v == "" else v for v in row[:8] if not isinstance(v, bytes))


# ------------------------------------------------------------- lifecycle

SessionFactory = Callable[[], Session]


def run_export(session_factory: SessionFactory, store: ObjectStore, export_id: uuid.UUID) -> str:
    """Run one export to `done` or `failed`; returns the final state."""
    with session_factory() as s:
        row = s.get(Export, export_id)
        if row is None:
            raise ExportError(f"unknown export {export_id}")
        if row.job_state not in ("queued", "failed"):
            return row.job_state
        row.job_state = "running"
        row.stats = {"started_at": datetime.now(UTC).isoformat()}
        s.commit()
    state = "failed"
    stats: dict[str, Any]
    try:
        with session_factory() as s:
            row = s.get(Export, export_id)
            assert row is not None
            stats = build(s, store, row)
            s.commit()
        state = "done"
    except ExportError as e:
        stats = {"error": str(e)}
    except Exception as e:  # noqa: BLE001 - recorded on the row, logged, worker keeps running
        stats = {"error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
        log.error(
            json.dumps({"event": "export_crashed", "export": str(export_id), "error": repr(e)})
        )
    with session_factory() as s:
        row = s.get(Export, export_id)
        assert row is not None
        row.job_state = state
        row.stats = {**stats, "finished_at": datetime.now(UTC).isoformat()}
        s.commit()
    _event("export_finished", export=str(export_id), state=state)
    return state


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


_weekly_checked_on = None


def weekly_tick(
    session_factory: SessionFactory, store: ObjectStore, now: datetime | None = None
) -> list[str]:
    """D67's weekly master export to R2: on `EXPORT_WEEKLY_WEEKDAY` from `BACKUP_HOUR_UTC`, queue
    and run one xlsx export per project that has none by the `export` user in the last six days.
    Gated by `BACKUP_ENABLED` like the dumps. Checked once a day; never raises."""
    global _weekly_checked_on
    now = now or datetime.now(UTC)
    if not settings.backup_enabled or _weekly_checked_on == now.date():
        return []
    if now.isoweekday() != settings.export_weekly_weekday or now.hour < settings.backup_hour_utc:
        return []
    ran: list[str] = []
    try:
        with session_factory() as s:
            user = system_user(s, EXPORT_USER_NAME)
            s.commit()
            projects = s.scalars(select(Project).where(Project.deleted_at.is_(None))).all()
            due = []
            for p in projects:
                recent = s.scalar(
                    select(func.count())
                    .select_from(Export)
                    .where(
                        Export.project_id == p.id,
                        Export.kind == "xlsx",
                        Export.created_by_id == user.id,
                        Export.created_at >= now - WEEKLY_GAP,
                    )
                )
                if not recent:
                    due.append(p.id)
            ids = []
            for pid in due:
                row = create_export(s, project_id=pid, params={"scheduled": True}, user=user)
                ids.append(row.id)  # read while the session is open (commit expires the row)
        for export_id in ids:
            ran.append(run_export(session_factory, store, export_id))
        _weekly_checked_on = now.date()
    except Exception as e:  # noqa: BLE001 - the worker must keep running (CLAUDE.md §5)
        _event("export_weekly_failed", error=repr(e), ran=ran)
    return ran


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
