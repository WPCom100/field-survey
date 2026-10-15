"""The master workbook export (PLAN §7.6, T29) — XlsxWriter, modelled cell for cell on
`fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx`.

`load(session, store, project_id, params)` reads the project's materialised tables into plain
rows; `write(data, fileobj)` writes the workbook. Nothing here touches job rows (that is
`app.jobs.exports`). The TP-4 diff (`tests/xlsx_diff.py`) holds this file to the fixture: every
tab, value, width, freeze pane, table, validation, conditional format, chart and picture, with
the documented differences listed in `server/docs/exports.md`.

Tabs: Summary · Devices · Connections · Punch List · Missing Parts · Photo Log · Lists — no
Change Log (D51). Generated columns: Devices **Photo** and Punch List **Photo** from photo links,
Punch List **Device** from the stored text (D136) else the linked device, Missing Parts **Source**
from `part_source`, Photo Log **Device ID** from the photo's device and its links, **Floor Order**
from the level order. An empty device or connection status is written `Unsurveyed` (D110, D138).
"""

from __future__ import annotations

import io
import math
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, BinaryIO

import xlsxwriter
from sqlalchemy import select
from sqlalchemy.orm import Session
from xlsxwriter.utility import xl_col_to_name

from app import vocab
from app.blobs import object_key
from app.jobs import markup
from app.models import (
    Cable,
    CableEnd,
    Device,
    Level,
    MissingPart,
    PartSource,
    Photo,
    PhotoLink,
    Project,
    PunchItem,
)
from app.storage import ObjectMissing, ObjectStore

DEFAULT_TITLE = "ETC Lighting Controls Survey"

# A running job's progress report (T93): (stage, done, total, unit), e.g. ("Photo Log", 3200,
# 10000, "pictures"); `app.jobs.exports.Progress` writes it to the export row.
ProgressFn = Callable[..., None]


def no_progress(stage: str, done: int | None = None, total: int | None = None, unit=None) -> None:
    pass


DEFAULT_DISCLAIMER = (
    "THIS SHEET IS NOT A SUBSTITUTE FOR THE SUBMITTAL DRAWINGS! "
    "PLEASE REFER TO SUBMITTALS BEFORE ACTING ON ANY NOTES IN THIS SHEET!"
)
UNSURVEYED = "Unsurveyed"
HEADER_ROW = 2  # zero-based: row 3
FIRST_DATA_ROW = 3  # row 4
RANGE_END = 2000  # the master's formulas and validations run over rows 4–2000
LINE_PT = 16.5  # one line of Arial 10 in the master
TITLE_LINE_PT = 17.25  # one line of Arial 14
HEADER_PT = 30.0
IMAGE_PAD_PT = 6.0
IMAGE_OFFSET_PX = 4
CHART_PX = (491, 260)  # 4680000 × 2476500 EMU in the master (13 cm × 6.9 cm)
CHART_X_OFFSET_PX = 15  # 144000 EMU
CHART_BLOCK_ROWS = 12  # a chart spans about twelve 16.5-pt rows
WRAP_FACTOR = 1.15  # characters per line ≈ column width × factor (Arial 10 is narrower than
# Calibri 11, which the width unit measures)

HEADER_FILL = "#1F3864"
EDIT_FILL = "#FFF2CC"  # the columns the EC/ETC fill in on the Punch List and Missing Parts
STATUS_FILL = {
    "Complete": "#C6EFCE",
    "Installed, untested": "#E4DFEC",
    "Issue": "#FFC7CE",
    "Not installed": "#FFC7CE",
    "No access": "#FFEB9C",
    "Not started": "#E7E6E6",
    "Open": "#FFC7CE",
    "In progress": "#FFEB9C",
    "Closed": "#C6EFCE",
    "Needed": "#FFC7CE",
    "Ordered": "#FFEB9C",
    "On site": "#E4DFEC",
    "Installed": "#C6EFCE",
}
CHART_COLOR = {
    "Installed, untested": "#8064A2",
    "Issue": "#C0504D",
    "Not installed": "#FF9999",
    "No access": "#FFC000",
    "Complete": "#70AD47",
    "Open": "#C0504D",
    "In progress": "#FFC000",
    "Closed": "#70AD47",
    "Needed": "#C0504D",
    "Ordered": "#FFC000",
    "On site": "#8064A2",
    "Installed": "#70AD47",
}
# Summary table 1 lists the statuses in the master's order, not the vocabulary's.
DEVICE_STATUS_COLUMNS = ("Installed, untested", "Issue", "Not installed", "No access", "Complete")


@dataclass(frozen=True)
class Col:
    header: str
    width: float  # the master's stored width in character units
    center: bool = False
    fill: bool = False
    date: bool = False


@dataclass(frozen=True)
class TabSpec:
    name: str
    title: str
    table: str
    columns: tuple[Col, ...]
    validation: tuple[int, str, tuple[str, ...]] | None = None  # (column, Lists range, values)
    text_numbers: int | None = None  # a column of numbers stored as text (ignored errors)

    def col(self, header: str) -> int:
        return next(i for i, c in enumerate(self.columns) if c.header == header)


DEVICES = TabSpec(
    "Devices",
    "Devices",
    "Devices",
    (
        Col("Level", 8, center=True),
        Col("ID", 10.42578125),
        Col("Category", 15),
        Col("Device", 20.28515625),
        Col("Type", 41.28515625),
        Col("Room / Location", 50),
        Col("Drawing Position", 40),
        Col("Status", 20),
        Col("Notes", 64.42578125),
        Col("Photo", 8, center=True),
        Col("Floor Order", 8, center=True),
    ),
    validation=(7, "=Lists!$A$2:$A$6", vocab.DEVICE_STATUS),
    text_numbers=9,
)
CONNECTIONS = TabSpec(
    "Connections",
    "Connections",
    "Connections",
    (
        Col("Level", 8, center=True),
        Col("ID", 10.42578125),
        Col("From", 29),
        Col("Cable", 8, center=True),
        Col("To", 40),
        Col("Qty", 7, center=True),
        Col("Status", 20),
        Col("Note", 66.85546875),
        Col("Floor Order", 8, center=True),
    ),
    validation=(6, "=Lists!$D$2:$D$7", vocab.CONNECTION_STATUS),
)
PUNCH = TabSpec(
    "Punch List",
    "Outstanding items",
    "PunchList",
    (
        Col("Level", 8, center=True),
        Col("#", 10.42578125, center=True),
        Col("Device", 49.140625),
        Col("Item", 52),
        Col("Type", 15),
        Col("Photo", 8, center=True),
        Col("Owner", 10, center=True, fill=True),
        Col("Tracking status", 16, fill=True),
        Col("Date closed", 12, fill=True, date=True),
        Col("Notes", 57, fill=True),
        Col("Floor Order", 8, center=True),
    ),
    validation=(7, "=Lists!$B$2:$B$4", vocab.TRACKING_STATUS),
    text_numbers=5,
)
PARTS = TabSpec(
    "Missing Parts",
    "Missing Parts",
    "MissingParts",
    (
        Col("Level", 8, center=True),
        Col("#", 11.42578125, center=True),
        Col("Device / Location", 32),
        Col("Part", 42),
        Col("Part no.", 14),
        Col("Qty", 7, center=True),
        Col("Owner", 10, center=True),
        Col("Source", 32),
        Col("Part status", 14, fill=True),
        Col("Notes", 44, fill=True),
        Col("Floor Order", 8, center=True),
    ),
    validation=(8, "=Lists!$C$2:$C$5", vocab.PART_STATUS),
)
PHOTOS = TabSpec(
    "Photo Log",
    "Photo Log",
    "PhotoLog",
    (
        Col("Level", 8, center=True),
        Col("Photo", 10.42578125, center=True),
        Col("Location", 32),
        Col("Subject", 32),
        Col("What it shows", 70),
        Col("Device ID", 16),
        Col("Floor Order", 8, center=True),
        Col("Image", 46),
    ),
)
TABS = (DEVICES, CONNECTIONS, PUNCH, PARTS, PHOTOS)
DATA_TAB_NAMES = tuple(t.name for t in TABS)
LISTS = (
    ("Device status", vocab.DEVICE_STATUS),
    ("Tracking status", vocab.TRACKING_STATUS),
    ("Part status", vocab.PART_STATUS),
    ("Connection status", vocab.CONNECTION_STATUS),
)


# ------------------------------------------------------------------ rows


@dataclass
class ImageOut:
    data: bytes
    width: int
    height: int
    sha256: str


@dataclass
class ExportData:
    project_name: str
    title: str
    disclaimer: str
    levels: list[str]  # codes in floor order
    surveyed: list[date]
    rows: dict[str, list[list[Any]]] = field(default_factory=dict)  # tab → rows (cell values)
    images: dict[int, ImageOut | None] = field(default_factory=dict)  # Photo Log row index → image
    stats: dict[str, Any] = field(default_factory=dict)
    checks: list[str] = field(default_factory=list)


def family(code: str) -> str:
    """06 and 06M are one floor on the title line (D33): `06M` → `06`."""
    return code[:-1] if len(code) > 2 and code.endswith("M") else code


def id_sort_key(display_id: str | None) -> tuple:
    """`06M-01` < `06M-S1` < `06M-D1`, numerically within each kind; unnumbered last."""
    if not display_id:
        return (9, 0, "")
    tail = display_id.split("-", 1)[1] if "-" in display_id else display_id
    m = re.fullmatch(r"([SD]?)(\d+)", tail)
    if m:
        kind = {"": 0, "S": 1, "D": 2}[m.group(1)]
        return (kind, int(m.group(2)), tail)
    m = re.fullmatch(r"C-(\d+)", display_id)
    if m:
        return (0, int(m.group(1)), display_id)
    return (3, 0, tail)


def join_numbers(numbers: list[int]) -> str | None:
    return ", ".join(str(n) for n in sorted(set(numbers))) or None


def number_refs(numbers: list[int]) -> str:
    """`#8-14`, `#15, #19` — runs of three or more collapse, as the master writes them."""
    nums = sorted(set(numbers))
    parts: list[str] = []
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        if j - i >= 2:
            parts.append(f"#{nums[i]}-{nums[j]}")
            i = j + 1
        else:
            parts.append(f"#{nums[i]}")
            i += 1
    return ", ".join(parts)


# D136, D151: named by their device alone (no room); so is any device with a panel name
NAME_ONLY_CATEGORIES = ("Relay panel", "Equipment rack", "NSPS")


def default_device_text(dev: Device | None) -> str | None:
    """The Device text of a punch item linked to `dev` (D136 format, D148, D151): `PI1002 S3 -
    Corridor …` for a station or sensor (model, tag, room), `UFMP4 - BH OBS RM 47 …` for a
    Foundry panel without a panel name; `CTB2LCPB` for a named panel, `EBDK (CTB2LCPB)` for an
    EBDK, the model alone for a rack or NSPS. Mirrored by `defaultDeviceText` in packages/core."""
    if dev is None:
        return None
    name = dev.device or dev.type or dev.category or ""
    if dev.category == "EBDK":
        return f"EBDK ({dev.panel_name})" if dev.panel_name else (name or None)
    if dev.category in NAME_ONLY_CATEGORIES or dev.panel_name:
        return name or None
    tail = dev.display_id.split("-", 1)[1] if dev.display_id and "-" in dev.display_id else ""
    if re.fullmatch(r"[SD]\d+", tail):
        name = f"{name} {tail}".strip()
    if dev.room_location:
        name = f"{name} - {dev.room_location}" if name else dev.room_location
    return name or None


def punch_device_text(p: PunchItem, dev: Device | None) -> str | None:
    """The Punch List's Device column (D148, D150): derived from the linked device, so a rename
    follows with no op on the punch item; an item linked to no device keeps the master's text
    (`device_text`, e.g. the room or `All devices`)."""
    return default_device_text(dev) if dev is not None else p.device_text


def load(
    session: Session,
    store: ObjectStore | None,
    project_id: uuid.UUID,
    params: dict[str, Any] | None = None,
    progress: ProgressFn = no_progress,
) -> ExportData:
    """Rows for every tab from the materialised tables. `params.levels` (codes) narrows the
    export; otherwise every in-scope level. `store` None skips the pictures."""
    params = params or {}
    progress("Reading the records")
    project = session.get(Project, project_id)
    if project is None:
        raise LookupError(f"unknown project {project_id}")
    settings = project.settings or {}
    levels_all = [
        lv
        for lv in session.scalars(
            select(Level).where(Level.project_id == project_id, Level.deleted_at.is_(None))
        )
    ]
    levels_all.sort(key=lambda lv: ((lv.floor_order is None), lv.floor_order or 0, lv.level))
    wanted = params.get("levels")
    if wanted:
        want = {str(c) for c in wanted}
        levels = [lv for lv in levels_all if lv.level in want]
    else:
        levels = [lv for lv in levels_all if lv.in_scope]
    level_ids = {lv.id for lv in levels}
    order = {lv.id: i + 1 for i, lv in enumerate(levels)}
    code = {lv.id: lv.level for lv in levels}
    data = ExportData(
        project_name=project.name,
        title=settings.get("export_title") or DEFAULT_TITLE,
        disclaimer=settings.get("disclaimer") or DEFAULT_DISCLAIMER,
        levels=[lv.level for lv in levels],
        surveyed=[lv.surveyed for lv in levels if lv.surveyed],
    )

    def in_levels(model):
        return session.scalars(
            select(model).where(model.level_id.in_(level_ids), model.deleted_at.is_(None))
        ).all()

    devices = in_levels(Device) if level_ids else []
    punches = in_levels(PunchItem) if level_ids else []
    parts = in_levels(MissingPart) if level_ids else []
    photos = in_levels(Photo) if level_ids else []
    ends = (
        session.scalars(
            select(CableEnd).where(
                CableEnd.level_id.in_(level_ids),
                CableEnd.display_id.is_not(None),
                CableEnd.deleted_at.is_(None),
            )
        ).all()
        if level_ids
        else []
    )
    cables = {
        c.id: c
        for c in session.scalars(
            select(Cable).where(
                Cable.id.in_({e.cable_id for e in ends}), Cable.deleted_at.is_(None)
            )
        )
    }
    ends = [e for e in ends if e.cable_id in cables]
    dev_by_id = {d.id: d for d in devices}
    punch_by_id = {p.id: p for p in punches}
    end_by_id = {e.id: e for e in ends}

    # photo links (D128): device → photo numbers, punch → photo numbers, photo → devices
    photo_devices: dict[uuid.UUID, list[uuid.UUID]] = {}
    photo_punches: dict[uuid.UUID, list[uuid.UUID]] = {}
    for ph in photos:
        photo_devices[ph.id] = [ph.device_id] if ph.device_id else []
        photo_punches[ph.id] = [ph.punch_item_id] if ph.punch_item_id else []
    if photos:
        for link in session.scalars(
            select(PhotoLink).where(
                PhotoLink.photo_id.in_({p.id for p in photos}), PhotoLink.deleted_at.is_(None)
            )
        ):
            if link.target_kind == "device":
                photo_devices[link.photo_id].append(link.target_id)
            elif link.target_kind == "punch":
                photo_punches[link.photo_id].append(link.target_id)
    device_photos: dict[uuid.UUID, list[int]] = {}
    punch_photos: dict[uuid.UUID, list[int]] = {}
    for ph in photos:
        if ph.number is None:
            continue
        for did in photo_devices[ph.id]:
            device_photos.setdefault(did, []).append(ph.number)
        for pid in photo_punches[ph.id]:
            punch_photos.setdefault(pid, []).append(ph.number)

    # part sources → Source text
    sources: dict[uuid.UUID, dict[str, list]] = {}
    if parts:
        for ps in session.scalars(
            select(PartSource).where(
                PartSource.missing_part_id.in_({p.id for p in parts}),
                PartSource.deleted_at.is_(None),
            )
        ):
            sources.setdefault(ps.missing_part_id, {"punch": [], "device": [], "cable_end": []})[
                ps.target_kind
            ].append(ps.target_id)

    def source_text(part: MissingPart) -> str | None:
        s = sources.get(part.id)
        if not s:
            return None
        out: list[str] = []
        nums = [punch_by_id[t].number for t in s["punch"] if t in punch_by_id]
        nums = [n for n in nums if n is not None]
        if nums:
            out.append(f"Punch {number_refs(nums)}")
        devs = sorted(
            (
                dev_by_id[t].display_id
                for t in s["device"]
                if t in dev_by_id and dev_by_id[t].display_id
            ),
            key=id_sort_key,
        )
        if devs:
            out.append("Devices " + ", ".join(devs))
        conns = sorted(
            (end_by_id[t].display_id for t in s["cable_end"] if t in end_by_id), key=id_sort_key
        )
        if conns:
            out.append("Connections " + ", ".join(conns))
        return "; ".join(out) or None

    # --- Devices
    devices.sort(key=lambda d: (order[d.level_id], id_sort_key(d.display_id)))
    data.rows["Devices"] = [
        [
            code[d.level_id],
            d.display_id or "",
            d.category,
            d.device,
            d.type,
            d.room_location,
            d.drawing_position,
            d.status or UNSURVEYED,
            d.notes,
            join_numbers(device_photos.get(d.id, [])),
            order[d.level_id],
        ]
        for d in devices
    ]

    # --- Connections: one row per numbered end, by level then C-nn
    ends.sort(key=lambda e: (order[e.level_id], id_sort_key(e.display_id)))
    data.rows["Connections"] = [
        [
            code[e.level_id],
            e.display_id,
            e.from_text,
            cables[e.cable_id].cable,
            e.to_text,
            cables[e.cable_id].qty,
            e.status or UNSURVEYED,
            e.note,
            order[e.level_id],
        ]
        for e in ends
    ]

    # --- Punch List by level, then (sort_last, #)
    punches.sort(key=lambda p: (order[p.level_id], p.sort_last, p.number or 0))
    data.rows["Punch List"] = [
        [
            code[p.level_id],
            p.number,
            punch_device_text(p, dev_by_id.get(p.device_id)),
            p.item,
            p.type,
            join_numbers(punch_photos.get(p.id, [])),
            p.owner,
            p.tracking_status,
            p.date_closed,
            p.notes,
            order[p.level_id],
        ]
        for p in punches
    ]

    # --- Missing Parts
    parts.sort(key=lambda p: (order[p.level_id], p.number or 0))
    data.rows["Missing Parts"] = [
        [
            code[p.level_id],
            p.number,
            p.device_location,
            p.part,
            p.part_no,
            p.qty,
            p.owner,
            source_text(p),
            p.part_status,
            p.notes,
            order[p.level_id],
        ]
        for p in parts
    ]

    # --- Photo Log
    photos.sort(key=lambda p: (order[p.level_id], p.number or 0))
    rows: list[list[Any]] = []
    flattened = skipped = missing = 0
    for i, ph in enumerate(photos):
        if store is not None:
            progress("Photo Log", i, len(photos), "pictures")
        ids = [dev_by_id[d].display_id for d in photo_devices[ph.id] if d in dev_by_id]
        first, rest = ids[:1], sorted(set(ids[1:]) - set(ids[:1]), key=id_sort_key)
        rows.append(
            [
                code[ph.level_id],
                ph.number,
                ph.location,
                ph.subject,
                ph.what_it_shows,
                ", ".join(first + rest) or None,
                order[ph.level_id],
                None,
            ]
        )
        image: ImageOut | None = None
        if store is not None and ph.thumb_blob:
            try:
                raw = store.read(object_key(ph.thumb_blob))
                strokes = store.read(object_key(ph.markup_blob)) if ph.markup_blob else None
                out, dropped = markup.flatten(raw, strokes)
                if strokes is not None:
                    flattened += 1
                    skipped += dropped
                w, h = _image_size(out)
                image = ImageOut(out, w, h, _sha(out))
            except (ObjectMissing, KeyError):
                missing += 1
                data.checks.append(
                    f"Photo Log {code[ph.level_id]} #{ph.number}: picture not in storage"
                )
            except (markup.MarkupError, ValueError) as e:
                data.checks.append(f"Photo Log {code[ph.level_id]} #{ph.number}: {e}")
                try:
                    w, h = _image_size(raw)
                    image = ImageOut(raw, w, h, _sha(raw))
                except ValueError:
                    missing += 1
        data.images[i] = image
    data.rows["Photo Log"] = rows
    data.stats = {
        "levels": data.levels,
        "rows": {tab: len(r) for tab, r in data.rows.items()},
        "images": sum(1 for v in data.images.values() if v is not None),
        "images_missing": missing,
        "markup_flattened": flattened,
        "strokes_skipped": skipped,
    }
    return data


def _sha(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def _image_size(data: bytes) -> tuple[int, int]:
    from app.jobs.workbook import jpeg_size, png_size

    size = jpeg_size(data) or png_size(data)
    if size is None:
        raise ValueError("not a JPEG or PNG")
    return size


# ------------------------------------------------------------- row heights


def wrapped_lines(text: str, width_chars: float, font_size: float = 10) -> int:
    """How many lines Excel will show for `text` wrapped in a column `width_chars` wide."""
    cpl = max(1.0, width_chars * WRAP_FACTOR * 10 / font_size)
    total = 0
    for para in text.split("\n"):
        words = para.split(" ")
        lines, cur = 1, 0.0
        for w in words:
            n = len(w)
            if cur == 0:
                if n <= cpl:
                    cur = n
                else:
                    lines += math.ceil(n / cpl) - 1
                    cur = n % cpl or cpl
            elif cur + 1 + n <= cpl:
                cur += 1 + n
            else:
                lines += 1
                if n <= cpl:
                    cur = n
                else:
                    lines += math.ceil(n / cpl) - 1
                    cur = n % cpl or cpl
        total += lines
    return max(1, total)


def row_height(
    cells: list[tuple[Any, float]], line_pt: float = LINE_PT, font_size: float = 10
) -> float:
    lines = 1
    for value, width in cells:
        if value is None:
            continue
        text = value.isoformat() if isinstance(value, (date, datetime)) else str(value)
        lines = max(lines, wrapped_lines(text, width, font_size))
    return round(lines * line_pt, 2)


# ------------------------------------------------------------------ writer


def _px(width_chars: float) -> int:
    """Excel stores column widths in character units; XlsxWriter reproduces a stored width
    exactly when given the pixel count it came from."""
    return round(width_chars * 7)


class _Formats:
    def __init__(self, wb: xlsxwriter.Workbook) -> None:
        base = {
            "font_name": "Arial",
            "font_size": 10,
            "text_wrap": True,
            "valign": "top",
            "border": 1,
        }
        self.wb = wb
        self.title = wb.add_format(
            {
                "font_name": "Arial",
                "font_size": 14,
                "bold": True,
                "text_wrap": True,
                "valign": "vcenter",
            }
        )
        self.subtitle = wb.add_format(
            {"font_name": "Arial", "font_size": 10, "text_wrap": True, "valign": "vcenter"}
        )
        self.section = wb.add_format(
            {
                "font_name": "Arial",
                "font_size": 10,
                "bold": True,
                "text_wrap": True,
                "valign": "vcenter",
            }
        )
        self.disclaimer = wb.add_format({"bold": True})
        self.plain = wb.add_format({"font_name": "Arial", "font_size": 10, "text_wrap": True})
        self.plain_bold = wb.add_format(
            {"font_name": "Arial", "font_size": 10, "bold": True, "text_wrap": True}
        )
        hdr = {**base, "bold": True, "font_color": "#FFFFFF", "bg_color": HEADER_FILL}
        self.header = wb.add_format(hdr)
        self.header_center = wb.add_format({**hdr, "align": "center"})
        self.header_left = wb.add_format({**hdr, "align": "left"})
        self._cache: dict[tuple, Any] = {}
        self._base = base

    def cell(self, *, center=False, left=False, fill=False, date=False, bold=False):
        key = (center, left, fill, date, bold)
        if key not in self._cache:
            spec = dict(self._base)
            if center:
                spec["align"] = "center"
            if left:
                spec["align"] = "left"
            if fill:
                spec["bg_color"] = EDIT_FILL
            if date:
                spec["num_format"] = "yyyy\\-mm\\-dd"
            if bold:
                spec["bold"] = True
            self._cache[key] = self.wb.add_format(spec)
        return self._cache[key]

    def status_fill(self, color: str):
        key = ("cf", color)
        if key not in self._cache:
            self._cache[key] = self.wb.add_format({"bg_color": color})
        return self._cache[key]


def _write_value(ws, r: int, c: int, value: Any, fmt) -> None:
    if value is None or value == "":
        ws.write_blank(r, c, None, fmt)
    elif isinstance(value, bool):
        ws.write_string(r, c, str(value), fmt)
    elif isinstance(value, (int, float)):
        ws.write_number(r, c, value, fmt)
    elif isinstance(value, datetime):
        ws.write_datetime(r, c, value, fmt)
    elif isinstance(value, date):
        ws.write_datetime(r, c, datetime(value.year, value.month, value.day), fmt)
    else:
        ws.write_string(r, c, str(value), fmt)


def _page_setup(ws, *, fit_height: int, repeat_header: bool) -> None:
    ws.set_landscape()
    ws.fit_to_pages(1, fit_height)
    if repeat_header:
        ws.repeat_rows(HEADER_ROW)
    ws.set_margins(left=0.75, right=0.75, top=1.0, bottom=1.0)
    ws.set_header("", {"margin": 0.5})
    ws.set_footer("", {"margin": 0.5})


def _write_tab(wb, f: _Formats, spec: TabSpec, data: ExportData, levels_text: str) -> None:
    ws = wb.add_worksheet(spec.name)
    rows = data.rows.get(spec.name, [])
    ncol = len(spec.columns)
    for i, col in enumerate(spec.columns):
        ws.set_column_pixels(i, i, _px(col.width))
    ws.merge_range(0, 0, 0, 1, spec.title, f.title)
    ws.merge_range(1, 0, 1, 1, levels_text, f.title)
    title_width = spec.columns[0].width + spec.columns[1].width
    ws.set_row(0, row_height([(spec.title, title_width)], TITLE_LINE_PT, 14))
    ws.set_row(1, row_height([(levels_text, title_width)], TITLE_LINE_PT, 14))
    ws.set_row(HEADER_ROW, HEADER_PT)
    last_row = FIRST_DATA_ROW + max(len(rows), 1) - 1  # a table needs one data row
    for r, row in enumerate(rows, start=FIRST_DATA_ROW):
        for c, col in enumerate(spec.columns):
            _write_value(ws, r, c, row[c], f.cell(center=col.center, fill=col.fill, date=col.date))
        if spec is PHOTOS:
            image = data.images.get(r - FIRST_DATA_ROW)
            text_h = row_height([(v, col.width) for v, col in zip(row, spec.columns, strict=True)])
            if image is not None:
                ws.insert_image(
                    r,
                    spec.col("Image"),
                    f"photo-{r}.jpg",
                    {
                        "image_data": io.BytesIO(image.data),
                        "x_offset": IMAGE_OFFSET_PX,
                        "y_offset": IMAGE_OFFSET_PX,
                    },
                )
                ws.set_row(r, max(text_h, round(image.height * 0.75 + IMAGE_PAD_PT, 2)))
            else:
                ws.set_row(r, text_h)
        else:
            ws.set_row(
                r, row_height([(v, col.width) for v, col in zip(row, spec.columns, strict=True)])
            )
    if not rows:
        for c, col in enumerate(spec.columns):
            ws.write_blank(
                FIRST_DATA_ROW, c, None, f.cell(center=col.center, fill=col.fill, date=col.date)
            )
    ws.add_table(
        HEADER_ROW,
        0,
        last_row,
        ncol - 1,
        {
            "name": spec.table,
            "style": "Table Style Light 1",
            "banded_rows": False,
            "autofilter": True,
            "columns": [
                {"header": col.header, "header_format": f.header_center if col.center else f.header}
                for col in spec.columns
            ],
        },
    )
    end = max(RANGE_END, last_row + 1)
    if spec.validation:
        c, source, values = spec.validation
        ws.data_validation(
            FIRST_DATA_ROW,
            c,
            end - 1,
            c,
            {
                "validate": "list",
                "source": source,
                "ignore_blank": True,
                "show_input": False,
                "show_error": False,
            },
        )
        for value in values:
            ws.conditional_format(
                FIRST_DATA_ROW,
                c,
                end - 1,
                c,
                {
                    "type": "cell",
                    "criteria": "==",
                    "value": f'"{value}"',
                    "format": f.status_fill(STATUS_FILL[value]),
                },
            )
    if spec.text_numbers is not None:
        col_letter = xl_col_to_name(spec.text_numbers)
        ws.ignore_errors(
            {"number_stored_as_text": f"{col_letter}{FIRST_DATA_ROW + 1}:{col_letter}{end}"}
        )
    ws.freeze_panes(FIRST_DATA_ROW, 2)
    _page_setup(ws, fit_height=0, repeat_header=True)


@dataclass
class _SummaryTable:
    title: str
    key_header: str
    keys: list[str]
    statuses: tuple[str, ...]
    sheet: str
    key_col: str  # column letter on the data tab holding the key (Level or Owner)
    status_col: str
    counts: dict[tuple[str, str], int]
    extra: tuple[str, ...] = ()  # Surveyed / Updated columns on the first table
    extra_values: dict[str, list[str | None]] = field(default_factory=dict)

    @property
    def width(self) -> int:
        return 1 + len(self.extra) + len(self.statuses) + 1


def _counts(rows: list[list[Any]], key_i: int, status_i: int) -> dict[tuple[str, str], int]:
    out: dict[tuple[str, str], int] = {}
    for row in rows:
        k, s = row[key_i], row[status_i]
        if k is None or s is None:
            continue
        out[(str(k), str(s))] = out.get((str(k), str(s)), 0) + 1
    return out


def _quote(sheet: str) -> str:
    return f"'{sheet}'" if " " in sheet else sheet


def _write_summary(
    wb,
    f: _Formats,
    data: ExportData,
    levels_text: str,
    level_dates: dict[str, tuple],
    tabs: tuple[str, ...] = DATA_TAB_NAMES,
) -> None:
    ws = wb.add_worksheet("Summary")
    ws.set_column_pixels(0, 8, _px(14))  # A–I, as the master
    ws.merge_range(0, 0, 0, 4, data.title, f.title)
    ws.merge_range(1, 0, 1, 4, levels_text, f.title)
    if data.surveyed:
        lo, hi = min(data.surveyed), max(data.surveyed)
        surveyed = (
            f"Surveyed {lo.isoformat()} to {hi.isoformat()}"
            if lo != hi
            else f"Surveyed {lo.isoformat()}"
        )
    else:
        surveyed = "Surveyed"
    ws.merge_range(2, 0, 2, 4, surveyed, f.subtitle)
    ws.write_string(3, 0, data.disclaimer, f.disclaimer)
    ws.set_row(0, TITLE_LINE_PT)
    ws.set_row(1, TITLE_LINE_PT)
    ws.set_row(2, LINE_PT)

    end = max(RANGE_END, *(FIRST_DATA_ROW + len(r) for r in data.rows.values()))
    tables = [
        _SummaryTable(
            "Device status by floor",
            "Floor",
            data.levels,
            DEVICE_STATUS_COLUMNS,
            "Devices",
            "A",
            "H",
            _counts(data.rows["Devices"], 0, 7),
            extra=("Surveyed", "Updated"),
            extra_values={
                "Surveyed": [level_dates[c][0] for c in data.levels],
                "Updated": [level_dates[c][1] for c in data.levels],
            },
        ),
        _SummaryTable(
            "Outstanding items by floor",
            "Floor",
            data.levels,
            vocab.TRACKING_STATUS,
            "Punch List",
            "A",
            "H",
            _counts(data.rows["Punch List"], 0, 7),
        ),
        _SummaryTable(
            "Outstanding items by owner",
            "Owner",
            list(vocab.OWNER),
            vocab.TRACKING_STATUS,
            "Punch List",
            "G",
            "H",
            _counts(data.rows["Punch List"], 6, 7),
        ),
        _SummaryTable(
            "Missing parts by floor",
            "Floor",
            data.levels,
            vocab.PART_STATUS,
            "Missing Parts",
            "A",
            "I",
            _counts(data.rows["Missing Parts"], 0, 8),
        ),
    ]
    # a table counts rows of its own tab; it is left out with that tab (T31: no formula may
    # point at a sheet the workbook does not have, or Excel treats it as an external link)
    tables = [t for t in tables if t.sheet in tabs]
    r = 5  # zero-based row of the first table title (row 6)
    for t in tables:
        hdr = r + 1
        first, last = hdr + 1, hdr + len(t.keys)
        total = last + 1
        ws.merge_range(r, 0, r, t.width - 1, t.title, f.section)
        ws.set_row(r, LINE_PT)
        headers = [t.key_header, *t.extra, *t.statuses, "Total"]
        for c, h in enumerate(headers):
            ws.write_string(hdr, c, h, f.header_left if c == 0 else f.header_center)
        ws.set_row(hdr, HEADER_PT)
        sheet = _quote(t.sheet)
        status_cols = []
        for i, key in enumerate(t.keys):
            row = first + i
            ws.write_string(row, 0, key, f.cell(left=True))
            c = 1
            for name in t.extra:
                _write_value(ws, row, c, t.extra_values[name][i], f.cell(center=True))
                c += 1
            first_status_col = c
            for status in t.statuses:
                col_letter = xl_col_to_name(c)
                formula = (
                    f"=SUMPRODUCT(({sheet}!${t.key_col}$4:${t.key_col}${end}=$A{row + 1})"
                    f"*({sheet}!${t.status_col}$4:${t.status_col}${end}={col_letter}${hdr + 1}))"
                )
                ws.write_formula(
                    row, c, formula, f.cell(center=True), t.counts.get((key, status), 0)
                )
                c += 1
            last_status_col = c - 1
            a, b = xl_col_to_name(first_status_col), xl_col_to_name(last_status_col)
            ws.write_formula(
                row,
                c,
                f"=SUM({a}{row + 1}:{b}{row + 1})",
                f.cell(center=True),
                sum(t.counts.get((key, s), 0) for s in t.statuses),
            )
            ws.set_row(row, LINE_PT)
            status_cols = list(range(first_status_col, last_status_col + 1))
        ws.write_string(total, 0, "Total", f.cell(left=True, bold=True))
        for c in range(1, 1 + len(t.extra)):
            ws.write_blank(total, c, None, f.cell(center=True, bold=True))
        if t.keys:
            for c in range(1 + len(t.extra), t.width):
                col_letter = xl_col_to_name(c)
                if c in status_cols:
                    status = t.statuses[c - status_cols[0]]
                    value = sum(t.counts.get((k, status), 0) for k in t.keys)
                else:
                    value = sum(t.counts.get((k, s), 0) for k in t.keys for s in t.statuses)
                ws.write_formula(
                    total,
                    c,
                    f"=SUM({col_letter}{first + 1}:{col_letter}{last + 1})",
                    f.cell(center=True, bold=True),
                    value,
                )
        else:
            for c in range(1 + len(t.extra), t.width):
                ws.write_number(total, c, 0, f.cell(center=True, bold=True))
        ws.set_row(total, LINE_PT)
        # the chart: right of the table, at the title row (none for a table without rows:
        # XlsxWriter refuses a chart with no series)
        if t.keys:
            chart = wb.add_chart({"type": "column", "subtype": "stacked"})
            for c, status in zip(status_cols, t.statuses, strict=True):
                col_letter = xl_col_to_name(c)
                chart.add_series(
                    {
                        "name": f"=Summary!${col_letter}${hdr + 1}",
                        "categories": f"=Summary!$A${first + 1}:$A${last + 1}",
                        "values": f"=Summary!${col_letter}${first + 1}:${col_letter}${last + 1}",
                        "fill": {"color": CHART_COLOR[status]},
                        "border": {"color": CHART_COLOR[status]},
                        "gap": 60,
                        "overlap": 100,
                    }
                )
            chart.set_title({"none": True})
            chart.set_legend({"position": "right"})
            chart.set_size({"width": CHART_PX[0], "height": CHART_PX[1]})
            ws.insert_chart(r, t.width, chart, {"x_offset": CHART_X_OFFSET_PX, "y_offset": 0})
        block = max(total - r + 2, CHART_BLOCK_ROWS)
        for gap in range(total + 1, r + block):
            ws.set_row(gap, LINE_PT)
        r += block
    _page_setup(ws, fit_height=1, repeat_header=False)


def _write_lists(wb, f: _Formats) -> None:
    ws = wb.add_worksheet("Lists")
    ws.set_column_pixels(0, 3, _px(18))
    for c, (header, values) in enumerate(LISTS):
        ws.write_string(0, c, header, f.plain_bold)
        for r, v in enumerate(values, start=1):
            ws.write_string(r, c, v, f.plain)


def selected_tabs(params: dict[str, Any] | None) -> tuple[str, ...]:
    """The data tabs an export writes: `params.tabs` (T31, D141) in workbook order, else all
    five. Summary and Lists are always written."""
    wanted = (params or {}).get("tabs")
    if not wanted:
        return DATA_TAB_NAMES
    return tuple(t for t in DATA_TAB_NAMES if t in set(wanted))


def write(
    data: ExportData,
    out: BinaryIO,
    level_dates: dict[str, tuple] | None = None,
    tabs: tuple[str, ...] = DATA_TAB_NAMES,
) -> None:
    """Write the workbook for `data` to `out`. `level_dates` = {code: (surveyed, updated)} as ISO
    text or None (the Summary keeps them as text in General format, T02 follow-up). `tabs` = the
    data tabs to write (Summary tables of a missing tab are left out)."""
    level_dates = level_dates or {c: (None, None) for c in data.levels}
    first, last = (data.levels[0], data.levels[-1]) if data.levels else ("", "")
    levels_text = f"Levels {family(first)}-{family(last)}" if data.levels else "Levels"
    wb = xlsxwriter.Workbook(out, {"in_memory": True})
    f = _Formats(wb)
    _write_summary(wb, f, data, levels_text, level_dates, tabs)
    for spec in TABS:
        if spec.name in tabs:
            _write_tab(wb, f, spec, data, levels_text)
    _write_lists(wb, f)
    wb.close()


def export_bytes(
    session: Session,
    store: ObjectStore | None,
    project_id: uuid.UUID,
    params: dict[str, Any] | None = None,
    progress: ProgressFn = no_progress,
) -> tuple[bytes, ExportData]:
    tabs = selected_tabs(params)
    # no Photo Log → no pictures to read from storage
    data = load(session, store if PHOTOS.name in tabs else None, project_id, params, progress)
    data.stats["rows"] = {t: n for t, n in data.stats.get("rows", {}).items() if t in tabs}
    data.stats["tabs"] = list(tabs)
    dates = {
        lv.level: (
            lv.surveyed.isoformat() if lv.surveyed else None,
            lv.updated.isoformat() if lv.updated else None,
        )
        for lv in session.scalars(
            select(Level).where(Level.project_id == project_id, Level.deleted_at.is_(None))
        )
    }
    buf = io.BytesIO()
    progress("Writing the workbook")
    write(data, buf, dates, tabs)
    return buf.getvalue(), data
