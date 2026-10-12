"""TP-3 synthetic project (T32): a project the size of a full tower, for timing the iPad and the
export against realistic volumes (Phase 4 §4 TP-3: 2,000 devices, 10,000 photos, 1,500 ops).

Everything is written the way real data arrives, so an iPad pulls it with the normal sync:

1. `projects.create_project` makes the project, its numbering groups and levels (D127);
2. one display sheet per level, all pointing at the 06M composite's bytes (one blob), so every
   level opens a real 153K-segment plan;
3. devices with pins spread over the sheet (one level carries a dense share, the worst case for
   plan open), cables with two ends each, punch items, missing parts and photos, as **trusted**
   creates through `app.sync.Push` in chunks (device IDs carried; punch / part / photo numbers
   and `C-nn` assigned by the server as for any create);
4. each photo gets its own distinct 320×240 JPEG thumbnail stored as a complete blob (so a
   prefetch downloads 10,000 different files); full-size images are not generated
   (`seed_thumbnail_only`, D40) — TP-3's ≈ 25 GB is 10,000 × 2.5 MB of arithmetic, not bytes;
5. then `ops` ordinary field edits (status, notes, punch tracking) by the team users, each with
   the correct `base_op_id`, through an untrusted push, as iPads would send them.

    python -m app.jobs.synthetic --name "TP-3 synthetic" [--devices 2000 --photos 10000
        --ops 1500 --dense-level 06M --dense-share 0.5 --seed 3 --user Landry]

Prints the project id and the timings as JSON. Never run against production data by accident:
it only ever creates a new project.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import random
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw
from sqlalchemy.orm import Session

from app.auth import upsert_user
from app.blobs import object_key
from app.ids import uuid7
from app.models import Blob, User
from app.projects import LevelIn, ProjectIn, create_project
from app.storage import ObjectStore
from app.sync import SERVER_INSTALL_ID, OpIn, Push, jsonable

log = logging.getLogger("app.jobs.synthetic")

FIXTURE_SHEET = (
    Path(__file__).resolve().parents[3] / "fixtures" / "Level_06M_-_Lighting_Composite_vector.pdf"
)
SHEET_SIZE = (4235.48, 3604.72)  # the 06M composite's CropBox (app/src/plan/demo.ts)
LEVELS = ("B2", "B1", "01", "02", "03", "04", "06", "06M")
CATEGORIES = (  # (category, model, share)
    ("Station", "PI1002", 0.40),
    ("Sensor", "UHCI-WM", 0.22),
    ("Relay panel", "CT01LCPA", 0.08),
    ("EBDK", "EBDK", 0.08),
    ("Foundry panel", "UFMP4", 0.06),
    ("NSPS", "P-NSPS-D", 0.06),
    ("Touchscreen", "P-TS7", 0.05),
    ("Equipment rack", "ERP", 0.05),
)
DEVICE_STATUS = ("Installed, untested", "Issue", "Not installed", "No access", None)
END_STATUS = ("Installed, untested", "Issue", "Not installed", "No access", "Not started")
CABLE_CODES = ("X", "N", "U", "NG")
PUNCH = (
    ("Run DMX to the panel", "Cable not run", "EC"),
    ("Terminate network cable", "Termination", "EC"),
    ("Waiting on DMX Termination Kits", "Missing part", "EC/ETC"),
    ("Replace wire nuts with Wagos (provided in box)", "Wiring", "EC"),
    ("Install station", "Not installed", "EC"),
)
TRACKING = ("Open", "Open", "In progress", "Closed")
NOTES = (
    "Run, not terminated",
    "Not run",
    "Empty box on wall.",
    "Reterminated - all good",
    "Confirm whether on site",
)
CHUNK = 2000
CHANGE_TYPE = "Master edit"
REASON = "TP-3 synthetic project (T32)"


@dataclass
class Spec:
    name: str = "TP-3 synthetic"
    devices: int = 2000
    photos: int = 10000
    ops: int = 1500
    levels: tuple[str, ...] = LEVELS
    dense_level: str | None = "06M"
    dense_share: float = 0.5
    seed: int = 3
    users: tuple[str, ...] = ("Landry", "Wiley", "Zach")
    sheet_pdf: Path | None = field(default_factory=lambda: FIXTURE_SHEET)


class _Ops:
    def __init__(self, project_id: uuid.UUID, user_id: uuid.UUID):
        self.project_id = project_id
        self.user_id = user_id
        self.ts = datetime.now(UTC)
        self.ops: list[OpIn] = []
        self.heads: dict[tuple[uuid.UUID, str], uuid.UUID] = {}
        # indexes a push chunk must not end after (a cable and its ends reference each other,
        # so they commit together)
        self.glued: set[int] = set()

    def create(self, entity_kind: str, payload: dict[str, Any]) -> uuid.UUID:
        eid = payload.get("id") or uuid7()
        self.ts += timedelta(microseconds=1)
        op_id = uuid7()
        body = jsonable({"id": eid, **payload})
        self.ops.append(
            OpIn(
                op_id=op_id,
                project_id=self.project_id,
                user_id=self.user_id,
                install_id=SERVER_INSTALL_ID,
                client_ts=self.ts,
                entity_kind=entity_kind,
                entity_id=eid,
                kind="create",
                payload=body,
                change_type=CHANGE_TYPE,
                reason=REASON,
            )
        )
        for k in body:
            if k != "id":
                self.heads[(eid, k)] = op_id
        return eid


def thumbnail(i: int, rng: random.Random) -> bytes:
    """A distinct 320×240 JPEG per photo (content-addressed blobs never dedupe them)."""
    img = Image.new("RGB", (320, 240), (rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    d = ImageDraw.Draw(img)
    for _ in range(6):
        x, y = rng.randrange(320), rng.randrange(240)
        d.rectangle(
            (x, y, x + rng.randrange(20, 120), y + rng.randrange(20, 90)),
            fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256)),
        )
    d.text((12, 12), f"TP-3 photo {i}", fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def _put_blob(session: Session, store: ObjectStore, data: bytes, mime: str, w=None, h=None) -> str:
    sha = hashlib.sha256(data).hexdigest()
    if session.get(Blob, sha) is None:
        store.put_file(object_key(sha), io.BytesIO(data), mime)
        session.add(
            Blob(
                sha256=sha,
                size=len(data),
                mime=mime,
                width=w,
                height=h,
                upload_state="complete",
                chunks_received=[],
            )
        )
    return sha


def _push(
    session: Session,
    project_id: uuid.UUID,
    ops: list[OpIn],
    trusted: bool,
    glued: set[int] | None = None,
) -> int:
    class _Body:
        def __init__(self, pid):
            self.project_id = pid
            self.since = None

    applied = 0
    glued = glued or set()
    i = 0
    while i < len(ops):
        end = min(i + CHUNK, len(ops))
        while end < len(ops) and end - 1 in glued:
            end += 1
        out = Push(session, _Body(project_id), trusted=trusted).run(ops[i:end])
        i = end
        bad = [r for r in out.results if r.outcome != "applied"]
        if bad:
            raise RuntimeError(f"{len(bad)} synthetic ops did not apply: {bad[0]}")
        applied += len(out.results)
        session.commit()
    return applied


def _split(total: int, levels: tuple[str, ...], dense: str | None, share: float) -> dict[str, int]:
    if dense not in levels or len(levels) == 1:
        dense = None
    out = {c: 0 for c in levels}
    rest_levels = [c for c in levels if c != dense]
    dense_n = round(total * share) if dense else 0
    if dense:
        out[dense] = dense_n
    rest = total - dense_n
    for i, c in enumerate(rest_levels):
        out[c] = rest // len(rest_levels) + (1 if i < rest % len(rest_levels) else 0)
    return out


def generate(session: Session, store: ObjectStore, spec: Spec) -> dict[str, Any]:
    """Create the synthetic project; returns its id, counts and timings."""
    rng = random.Random(spec.seed)
    t0 = time.monotonic()
    timings: dict[str, float] = {}
    users: list[User] = [upsert_user(session, n) for n in spec.users]
    session.commit()

    levels = [
        LevelIn(level=c, share_with="06" if c == "06M" and "06" in spec.levels else None)
        for c in spec.levels
    ]
    created = create_project(session, ProjectIn(name=spec.name, levels=levels), users[0])
    project_id = uuid.UUID(created.id)
    level_ids = {lv.level: uuid.UUID(lv.id) for lv in created.levels}
    timings["project"] = round(time.monotonic() - t0, 2)

    ops = _Ops(project_id, users[0].id)
    W, H = SHEET_SIZE
    sheet_ids: dict[str, uuid.UUID] = {}
    sheet_sha = None
    if spec.sheet_pdf is not None and not spec.sheet_pdf.exists():
        log.warning(json.dumps({"event": "synthetic_no_sheet", "path": str(spec.sheet_pdf)}))
    if spec.sheet_pdf is not None and spec.sheet_pdf.exists():
        sheet_sha = _put_blob(session, store, spec.sheet_pdf.read_bytes(), "application/pdf")
    for code in spec.levels:
        sheet_ids[code] = ops.create(
            "sheet",
            {
                "level_id": level_ids[code],
                "kind": "display",
                "blob": sheet_sha,
                "page": 1,
                "title": f"Level {code} - Lighting Composite (synthetic)",
                "width_pt": W,
                "height_pt": H,
            },
        )

    # devices
    per_level = _split(spec.devices, spec.levels, spec.dense_level, spec.dense_share)
    cat_weights = [c[2] for c in CATEGORIES]
    devices: list[tuple[uuid.UUID, str, str]] = []  # (id, level code, display id)
    for code in spec.levels:
        n = per_level[code]
        counters = {"panel": 0, "S": 0, "D": 0}
        cols = max(1, int((n * W / H) ** 0.5))
        for i in range(n):
            cat, model, _ = rng.choices(CATEGORIES, weights=cat_weights)[0]
            if cat == "Station":
                counters["S"] += 1
                display = f"{code}-S{counters['S']}"
            elif cat == "Sensor":
                counters["D"] += 1
                display = f"{code}-D{counters['D']}"
            else:
                counters["panel"] += 1
                display = f"{code}-{counters['panel']:02d}"
            row, col = divmod(i, cols)
            rows = max(1, (n + cols - 1) // cols)
            x = 150 + (col + rng.random()) * (W - 300) / cols
            y = 150 + (row + rng.random()) * (H - 300) / rows
            did = ops.create(
                "device",
                {
                    "level_id": level_ids[code],
                    "display_id": display,
                    "category": cat,
                    "device": model,
                    "room_location": f"XX{code}-{rng.randrange(1, 60):03d}",
                    "status": rng.choice(DEVICE_STATUS),
                    "notes": rng.choice(NOTES) if rng.random() < 0.4 else None,
                    "pin": {"sheet": str(sheet_ids[code]), "x": round(x, 1), "y": round(y, 1)},
                    "origin": "baseline",
                },
            )
            devices.append((did, code, display))
    level_ops = []
    for code in spec.levels:  # display sheet after the sheet exists (ordinary set, no head yet)
        ops.ts += timedelta(microseconds=1)
        level_ops.append(
            OpIn(
                op_id=uuid7(),
                project_id=project_id,
                user_id=users[0].id,
                install_id=SERVER_INSTALL_ID,
                client_ts=ops.ts,
                entity_kind="level",
                entity_id=level_ids[code],
                kind="set",
                field="display_sheet_id",
                now=str(sheet_ids[code]),
                change_type=CHANGE_TYPE,
                reason=REASON,
            )
        )
    ops.ops.extend(level_ops)

    # cables: consecutive devices on a level, one cable per two devices
    by_level: dict[str, list[tuple[uuid.UUID, str, str]]] = {}
    for d in devices:
        by_level.setdefault(d[1], []).append(d)
    ends: list[uuid.UUID] = []
    for code, devs in by_level.items():
        for a, b in zip(devs[0::2], devs[1::2], strict=False):
            cid, ea, eb = uuid7(), uuid7(), uuid7()
            cable = rng.choice(CABLE_CODES)
            ops.glued.update({len(ops.ops), len(ops.ops) + 1})  # the cable and end A
            ops.create(
                "cable",
                {
                    "id": cid,
                    "project_id": project_id,
                    "cable": cable,
                    "qty": 1,
                    "origin": "manual",
                    "end_a_id": ea,
                    "end_b_id": eb,
                },
            )
            for eid, side, here, there in ((ea, "A", a, b), (eb, "B", b, a)):
                ops.create(
                    "cable_end",
                    {
                        "id": eid,
                        "cable_id": cid,
                        "side": side,
                        "endpoint_kind": "device",
                        "device_id": here[0],
                        "level_id": level_ids[code],
                        "from_text": here[2],
                        "to_text": there[2],
                        "status": rng.choice(END_STATUS),
                    },
                )
                ends.append(eid)

    # punch items (one per two devices) and missing parts (3 per 20 devices)
    punch_ids: dict[uuid.UUID, uuid.UUID] = {}
    for did, code, _display in devices[0::2]:
        item, ptype, owner = rng.choice(PUNCH)
        status = rng.choice(TRACKING)
        punch_ids[did] = ops.create(
            "punch_item",
            {
                "level_id": level_ids[code],
                "device_id": did,
                "item": item,
                "type": ptype,
                "owner": owner,
                "tracking_status": status,
                "date_closed": "2026-10-09" if status == "Closed" else None,
            },
        )
    for did, code, display in devices[3::7]:
        ops.create(
            "missing_part",
            {
                "level_id": level_ids[code],
                "device_id": did,
                "device_location": display,
                "part": "DMX termination kit - panel run",
                "qty": 1,
                "owner": "EC",
                "part_status": rng.choice(("Needed", "Ordered", "On site")),
                "notes": "Need to be ordered",
            },
        )
    timings["records_planned"] = round(time.monotonic() - t0, 2)

    # photos with distinct thumbnails
    taken = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)
    for i in range(spec.photos):
        did, code, display = devices[i % len(devices)] if devices else (None, spec.levels[0], "")
        thumb = thumbnail(i, rng)
        sha = _put_blob(session, store, thumb, "image/jpeg", 320, 240)
        ops.create(
            "photo",
            {
                "level_id": level_ids[code],
                "location": f"Near {display}",
                "subject": display,
                "what_it_shows": f"Synthetic photo {i + 1} of {display}",
                "device_id": did,
                "punch_item_id": punch_ids.get(did) if did and i % 3 == 0 else None,
                "thumb_blob": sha,
                "seed_thumbnail_only": True,
                "taken_by_id": users[i % len(users)].id,
                "taken_at": taken + timedelta(seconds=17 * i),
            },
        )
        if i % 1000 == 999:
            session.commit()
            log.info(json.dumps({"event": "synthetic_photos", "done": i + 1}))
    session.commit()
    timings["thumbnails"] = round(time.monotonic() - t0, 2)

    creates = _push(session, project_id, ops.ops, trusted=True, glued=ops.glued)
    timings["creates_applied"] = round(time.monotonic() - t0, 2)

    # field edits by the team, each based on the field's current head
    edits: list[OpIn] = []
    edit_ts = datetime.now(UTC)
    punch_list = list(punch_ids.values())
    for k in range(spec.ops):
        user = users[k % len(users)]
        if punch_list and k % 3 == 2:
            eid, kind, fld = rng.choice(punch_list), "punch_item", "tracking_status"
            now: Any = rng.choice(("Open", "In progress", "Closed"))
        elif k % 3 == 1:
            eid, kind, fld = rng.choice(devices)[0], "device", "notes"
            now = rng.choice(NOTES)
        else:
            eid, kind, fld = rng.choice(devices)[0], "device", "status"
            now = rng.choice(DEVICE_STATUS[:-1])
        edit_ts += timedelta(milliseconds=5)
        op_id = uuid7()
        edits.append(
            OpIn(
                op_id=op_id,
                project_id=project_id,
                user_id=user.id,
                install_id=uuid.uuid5(uuid.NAMESPACE_URL, f"tp3:{user.name}"),
                client_ts=edit_ts,
                entity_kind=kind,
                entity_id=eid,
                kind="set",
                field=fld,
                now=now,
                base_op_id=ops.heads.get((eid, fld)),
                change_type="Field survey",
                reason="Field survey",
            )
        )
        ops.heads[(eid, fld)] = op_id
    edited = _push(session, project_id, edits, trusted=False)
    timings["total"] = round(time.monotonic() - t0, 2)

    stats = {
        "project_id": str(project_id),
        "name": spec.name,
        "levels": {c: per_level[c] for c in spec.levels},
        "devices": len(devices),
        "cables": len(ends) // 2,
        "ends": len(ends),
        "punch_items": len(punch_ids),
        "missing_parts": len(devices[3::7]),
        "photos": spec.photos,
        "sheet_blob": sheet_sha,
        "creates": creates,
        "edits": edited,
        "seconds": timings,
    }
    log.info(json.dumps({"event": "synthetic_done", **{k: v for k, v in stats.items()}}))
    return stats


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    p = argparse.ArgumentParser(prog="python -m app.jobs.synthetic", description=__doc__)
    p.add_argument("--name", default=Spec.name)
    p.add_argument("--devices", type=int, default=Spec.devices)
    p.add_argument("--photos", type=int, default=Spec.photos)
    p.add_argument("--ops", type=int, default=Spec.ops)
    p.add_argument("--levels", default=",".join(LEVELS))
    p.add_argument("--dense-level", default=Spec.dense_level)
    p.add_argument("--dense-share", type=float, default=Spec.dense_share)
    p.add_argument("--seed", type=int, default=Spec.seed)
    p.add_argument("--users", default="Landry,Wiley,Zach", help="team names; the first creates")
    p.add_argument("--no-sheet", action="store_true", help="levels without a plan sheet")
    p.add_argument(
        "--sheet",
        type=Path,
        default=FIXTURE_SHEET,
        help="the PDF every level opens (06M composite)",
    )
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    spec = Spec(
        name=a.name,
        devices=a.devices,
        photos=a.photos,
        ops=a.ops,
        levels=tuple(c.strip() for c in a.levels.split(",") if c.strip()),
        dense_level=a.dense_level or None,
        dense_share=a.dense_share,
        seed=a.seed,
        users=tuple(n.strip() for n in a.users.split(",") if n.strip()),
        sheet_pdf=None if a.no_sheet else a.sheet,
    )
    with SessionLocal() as s:
        stats = generate(s, get_object_store(), spec)
    print(json.dumps(stats, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
