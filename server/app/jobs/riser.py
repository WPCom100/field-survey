"""Riser extraction job (T43, PLAN §7.3, D6, D10, D21, D28, D189): the riser PDF uploaded to a
project becomes `draft_device` and `draft_cable` rows (proposed, with candidates, both sources
and `source_ref`), delivered to iPads as ops, with the Claude API resolving endpoints per band.

    POST /imports (kind=riser, file) → import_batch("queued")
    worker: run_queued() → analyse (app.jobs.riser_extract) → Claude per band (app.claude)
            → merge with the BOM's drafts → ops → done | skipped | failed
    python -m app.jobs.riser <project_id> <riser.pdf> [--user NAME]

The same file (SHA-256) for the same project is not extracted twice (`skipped`). Everything is
one transaction through the ordinary apply loop (`Push`, trusted, the requesting user); a
failure leaves the project as it was and the batch `failed` with the reason. Without a Claude
API key the job still runs: devices, bubbles and the rack's labelled outputs are deterministic,
the other cables are written with `endpoint:unresolved` for the reviewer (D11 — an import never
blocks), and the stats say so. Nothing here decides anything: every draft waits for the
per-level review (T44), conflicting and low-confidence ones flagged (D11, D28).

The riser PDF itself is kept as a complete blob (`stats.blob`) so review screens can render the
`source_ref` crops; cost per run is logged (`claude_call` events, `stats.claude`).
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

from app import claude as claude_api
from app.auth import system_user, upsert_user
from app.blobs import object_key
from app.ids import uuid7
from app.jobs import bom, riser_extract, runner
from app.models import (
    Blob,
    Device,
    DraftDevice,
    FieldHead,
    ImportBatch,
    Level,
    Placeholder,
    Project,
    User,
)
from app.storage import ObjectStore
from app.sync import SERVER_INSTALL_ID, OpIn, Push, jsonable

log = logging.getLogger("jobs")

RISER_KIND = "riser"
PDF_MIME = "application/pdf"
CHANGE_TYPE = "Master edit"
REASON = "Riser extraction"


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


# ----------------------------------------------------------------- batches


def create_riser_batch(
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
        pages = riser_extract.page_count(data)
    except Exception as e:  # noqa: BLE001 - any parser failure is "not a readable PDF"
        raise runner.ImportError_(f"the PDF could not be read: {e}") from e
    if pages == 0:
        raise runner.ImportError_("the PDF has no pages")
    return runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind=RISER_KIND,
        filename=filename or "riser.pdf",
        data=data,
        user=user,
        mime=PDF_MIME,
        extra={"pages": pages},
    )


class _Ops:
    """Trusted ops stamped by the requesting user from the server's install."""

    def __init__(self, project_id: uuid.UUID, user_id: uuid.UUID, reason: str):
        self.project_id = project_id
        self.user_id = user_id
        self.reason = reason
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
            reason=self.reason,
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


# ---------------------------------------------------------------- the target


def target_of(session: Session, project_id: uuid.UUID, filename: str) -> riser_extract.Target:
    """The project's levels, placeholders, BOM drafts (the merge, D28), live devices (the
    master cross-check, D30) and the BOM job's normalisation target."""
    levels = {
        lv.level: lv.id
        for lv in session.scalars(
            select(Level).where(Level.project_id == project_id, Level.deleted_at.is_(None))
        )
    }
    by_id = {v: k for k, v in levels.items()}
    placeholders = {
        p.label: p.id
        for p in session.scalars(
            select(Placeholder).where(
                Placeholder.project_id == project_id, Placeholder.deleted_at.is_(None)
            )
        )
    }
    bom_rows = session.scalars(
        select(DraftDevice).where(
            DraftDevice.project_id == project_id,
            DraftDevice.deleted_at.is_(None),
            DraftDevice.state != "rejected",
        )
    ).all()
    drafts = []
    for d in bom_rows:
        ref = d.source_ref or {}
        if ref.get("kind") != "bom_line":
            continue
        drafts.append(
            riser_extract.BomDraft(
                id=d.id,
                level_id=d.level_id,
                # a floor the project lacks keeps its code in source_ref (`level_not_in_project`)
                level_code=by_id.get(d.level_id) if d.level_id else ref.get("level_code"),
                model=d.model or "",
                candidates=list(d.candidates or []),
                qty=d.qty,
                level_basis=d.level_basis,
                venue=ref.get("venue"),
                accessories=list(d.accessories or []),
                source_ref=dict(ref),
                conflicts=list(d.conflicts or []),
                confidence=d.confidence,
                name=d.name,
            )
        )
    master = [
        riser_extract.MasterDevice(
            level_code=by_id[dev.level_id], device=dev.device or "", category=dev.category
        )
        for dev in session.scalars(
            select(Device).where(
                Device.deleted_at.is_(None), Device.level_id.in_(list(levels.values()))
            )
        )
        if dev.level_id in by_id and dev.device
    ]
    return riser_extract.Target(
        levels=levels,
        placeholders=placeholders,
        bom=drafts,
        master=master,
        bom_target=bom.target_of(session, project_id),
        file=filename,
    )


# ------------------------------------------------------------ the endpoints


def resolve_with_claude(
    pdf_bytes: bytes,
    riser: riser_extract.Riser,
    client: claude_api.Claude,
    levels_known: list[str],
) -> list[dict[str, Any]]:
    """One structured call per band: the crop, the column overview, the known devices and
    bubbles → endpoints (and, on a sheet with no text layer, the devices and bubbles too).
    A failed band is recorded and skipped; its cables stay unresolved."""
    report: list[dict[str, Any]] = []
    for sheet in riser.sheets:
        for band in sheet.bands:
            label = f"sheet {sheet.drawing} band {band.key} level {band.level_code or '?'}"
            crop = riser_extract.band_crop(pdf_bytes, sheet, band)
            overview = riser_extract.column_overview(pdf_bytes, sheet, band)
            prompt = riser_extract.band_prompt(sheet, band, crop, levels_known)
            try:
                answer = client.extract(
                    system=riser_extract.SYSTEM_PROMPT,
                    prompt=prompt,
                    schema=riser_extract.SCHEMA,
                    images=[crop.png, overview],
                    label=label,
                )
            except claude_api.ClaudeError as e:
                report.append({"band": band.key, "level": band.level_code, "error": str(e)})
                _event("riser_band_failed", band=band.key, error=str(e))
                continue
            riser_extract.apply_answer(sheet, band, crop, answer.data)
            report.append(
                {
                    "band": band.key,
                    "level": band.level_code,
                    "cables": len(answer.data.get("cables") or []),
                    "devices": len(answer.data.get("devices") or []),
                    **answer.out(),
                }
            )
    return report


# --------------------------------------------------------------- the job


def import_riser(
    session: Session,
    store: ObjectStore,
    batch: ImportBatch,
    client: claude_api.Claude | None = None,
) -> dict[str, Any]:
    """Apply one queued riser batch inside the caller's transaction; returns its stats."""
    if batch.kind != RISER_KIND:
        raise runner.ImportError_(f"not a riser batch: {batch.kind}")
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
            ImportBatch.kind == RISER_KIND,
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

    name = str(entry.get("name") or "riser.pdf")
    target = target_of(session, project.id, name)
    riser = riser_extract.analyse(data)
    if not riser.bands:
        raise runner.ImportError_("no level bands found (no horizontal rules on any page)")

    client = client if client is not None else claude_api.Claude()
    claude_report: list[dict[str, Any]] | None = None
    if client.available():
        claude_report = resolve_with_claude(
            data, riser, client, sorted(target.levels, key=riser_extract.level_order_key)
        )
    result = riser_extract.build(riser, target)

    requester = session.get(User, batch.created_by_id) if batch.created_by_id else None
    user_id = (requester or system_user(session, "import")).id
    ops = _Ops(project.id, user_id, f"{REASON}: {name}")
    for p in result.placeholders:
        ops.create(
            "placeholder", {"id": p.id, "project_id": project.id, "label": p.label, "kind": p.kind}
        )
    for d in result.drafts:
        ops.create(
            "draft_device", {"project_id": project.id, "import_batch_id": batch.id, **d.row()}
        )
    bom_by_id = {b.id: b for b in target.bom}
    for e in result.edits:
        was = getattr(bom_by_id[e.draft_id], e.field, None)
        ops.set(
            "draft_device", e.draft_id, e.field, was, e.now, _head(session, e.draft_id, e.field)
        )
    for dl in result.deletions:
        ops.delete(
            "draft_device", dl.draft_id, _head(session, dl.draft_id, "deleted_at"), dl.reason
        )
    for c in result.cables:
        ops.create(
            "draft_cable", {"project_id": project.id, "import_batch_id": batch.id, **c.row()}
        )
    for cf in result.conflicts:
        ops.create(
            "review_item",
            {
                "project_id": project.id,
                "level_id": cf.level_id,
                "kind": "source_conflict",
                "subject": {
                    "entity_kind": "draft_device",
                    "entity_id": str(cf.draft_id) if cf.draft_id else None,
                    "field": "qty",
                    "level_code": cf.level_code,
                    "model": cf.model,
                },
                "candidates": [
                    {"side": "riser", "value": cf.riser_qty},
                    {"side": "bom", "value": cf.bom_qty},
                    {"side": "master", "value": cf.master_qty},
                ],
                "state": "open",
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
    sha, _stored = _store_blob(session, store, data)
    stats = {
        "file": name,
        "blob": sha,
        **riser.stats(),
        "levels": riser.levels(),
        **result.stats(),
        "claude": client.totals()
        if claude_report is not None
        else "unavailable (no ANTHROPIC_API_KEY)",
        "claude_bands": claude_report,
        "ops": len(ops.ops),
        "last_server_seq": push.seq,
    }
    _event(
        "riser_applied",
        batch=str(batch.id),
        project=str(project.id),
        **{k: v for k, v in stats.items() if k not in ("claude_bands", "findings", "sheets")},
    )
    return stats


def run_queued(
    session_factory: runner.SessionFactory, store: ObjectStore, limit: int = 1
) -> list[str]:
    """Worker tick: run up to `limit` queued riser batches, oldest first."""
    return runner.run_queued(session_factory, store, limit, kinds=(RISER_KIND,), job=import_riser)


# ------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.riser")
    parser.add_argument("project_id", type=uuid.UUID)
    parser.add_argument("pdf", help="path to the riser PDF")
    parser.add_argument("--user", default=None, help="team name to record as the uploader")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    data = Path(args.pdf).read_bytes()
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            batch = create_riser_batch(
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
    state = runner.run_batch(SessionLocal, store, batch.id, job=import_riser)
    with SessionLocal() as s:
        print(json.dumps(runner.batch_out(s.get(ImportBatch, batch.id)), indent=2, default=str))
    return 0 if state in ("done", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
