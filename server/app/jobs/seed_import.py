"""Workbook rows → ops (PLAN §7.5, T27, D30).

`build_plan(workbook, target)` turns a read workbook into a `Plan`: the ops the apply loop
(`app.sync.Push`, trusted) will store, the Change Log rows as historical ops, the Photo Log
images to put in the object store, and stats. Nothing here touches the database; the runner
(`app.jobs.runner`) supplies the project context and applies the plan in one transaction.

- Devices → `device` creates (`origin=import`, ID kept, `panel_name` from `CTxxLCPx`);
  `Unsurveyed` → empty status (D110).
- Connections → one `cable_end` per row, paired into cables by code, level cross-reference and
  labels with a confidence: `PAIR_MIN` and up pairs; below it the end keeps its own cable and an
  `import_pair` review item lists the candidates. `P`/`0-10V`/`120V` are single-row. A far end
  that names an out-of-scope level or a seed placeholder gets that placeholder. From/To are kept
  verbatim (D32); the Unison bus spellings become `Stations & Sensors` by a recorded ruling (D50).
- Punch List → `punch_item`; the device is matched from the Device text (tag, panel, model +
  room); a row it links to no device raises a `review_item(lint)` for Needs review (D148); the
  Neuron ID row is `sort_last`. A cable item ("Run DMX to B3A Canyon", "Land 0-10V control
  wiring") whose signal and destination name exactly one end of its device gets that end as
  `cable_end_id` (T119); one naming none or several stays device-only and is listed in the checks.
- Missing Parts → `missing_part` + `part_source` links parsed from Source; unparsed → `finding`.
  A part reaches its end through its Source (a `Connections C-nn`, or a punch item with an end);
  a kit part reaching none is listed in the checks (T119).
- Photo Log → `photo` with the 320×240 image as `thumb_blob`, `seed_thumbnail_only` (D40),
  linked to the first Device ID and to the first punch item that lists the number.
- Change Log → historical ops: user `import`, state `superseded` (recorded, never
  materialised), one per row.
- Summary → levels (code, floor order, Surveyed/Updated).

Values outside a fixed list (status, type, owner, part status) are stored empty and raised as a
`review_item(lint)` so nothing invalid enters the baseline and nothing is lost.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app import vocab
from app.ids import uuid7
from app.jobs.workbook import Image, Row, Workbook
from app.sync import OpIn

IMPORT_INSTALL_ID = uuid.uuid5(uuid.NAMESPACE_URL, "field-survey:import")
IMPORT_USER_NAME = "import"
IMPORT_CHANGE_TYPE = "Master edit"

NEURON_ITEM = "Missing all Device Neuron IDs"
# `review_item(lint)` for a punch row linked to no device (D148); the iPad offers Link / Create
PUNCH_DEVICE_LINT = "import.punch_device_unmatched"
# T122: a cable item left on its device only waits on Needs review for its end (one end, D220)
PUNCH_END_LINT = "import.punch_end_unmatched"
UNSURVEYED = "Unsurveyed"
BUS_LABEL = "Stations & Sensors"
POWER_LABEL = "120v Power"
FIXTURES_LABEL = "Fixtures"
SINGLE_ROW_CODES = ("P", "0-10V", "120V")

# PLAN §7.5 seed placeholders (label, kind); `Level NN` far ends beyond the list are added as met.
SEED_PLACEHOLDERS: tuple[tuple[str, str], ...] = (
    (FIXTURES_LABEL, "fixtures"),
    (POWER_LABEL, "power"),
    (BUS_LABEL, "station_bus"),
    ("Level 09", "level_not_in_scope"),
    ("Level 10", "level_not_in_scope"),
    ("Level 11", "level_not_in_scope"),
    ("Level 12", "level_not_in_scope"),
    ("Walter Tower ETC P-CCS", "external"),
    ("B3A Canyon", "fixture_run"),
    ("C13A Oculus", "fixture_run"),
    ("D1 ED Column Capital", "fixture_run"),
    ("B3B Elev Core C fixture", "fixture_run"),
    ("B7 Stair A fixture", "fixture_run"),
    ("Spare DMX out", "spare"),
    ("Missing DMX run (one per UFMP4)", "unknown"),
)

# Pairing confidence: at or above PAIR_MIN the two ends become one cable; between CANDIDATE_MIN
# and PAIR_MIN the partner is offered on the review item; below it is not mentioned.
PAIR_MIN = 0.8
CANDIDATE_MIN = 0.4

PANEL_RE = re.compile(r"\bCT[0-9A-Z]{1,3}LCP[AB]\b")
LEVEL_RE = re.compile(r"\bLevel\s+(B?\d{1,2}M?)\b", re.I)
TAG_RE = re.compile(r"\b([SD])(\d{1,3})\b")
HASH_TAG_RE = re.compile(r"^(PI\d{4}|P-DOC\S*|P-LS)\s+#(\d+)\b")
LABEL_SPLIT_RE = re.compile(r"\s+[-–—�]\s+")
MULTI_RE = re.compile(r"[,/]|\bto\b|\band\b|&", re.I)

# T119: a punch item about a cable — its verb, the signal words it names (the master's, as
# `R3.signal` spells them; network & ground before network) and where it runs to / from.
CABLE_VERB_RE = re.compile(r"^(?:run|pull|re-?pull|terminate|re-?terminate|land|connect)\b", re.I)
SIGNAL_WORDS: tuple[tuple[re.Pattern[str], frozenset[str]], ...] = tuple(
    (re.compile(pat, re.I), frozenset(codes))
    for pat, codes in (
        (r"\bnetwork\s*(?:&|and)\s*ground\b", ("NG",)),
        (r"\bnetwork\b", ("N", "NG")),
        (r"\bDMX\b", ("X",)),
        (r"\bUnison\b", ("U",)),
        (r"\bfiber\b", ("F",)),
        (r"\b0-10\s*V\b", ("0-10V",)),
        (r"\b120\s*V\b", ("120V",)),
        (r"\bpanic\b", ("P",)),
        (r"\bDALI\b", ("D",)),
        (r"\bUHCI-WM\b|\bpartition sensor\b", ("UV",)),
    )
)
DESTINATION_RE = re.compile(r"\b(?:to|from)\s+(.+)$", re.I)
SEVERAL_RE = re.compile(r"[,/&]|\band\b", re.I)

# Change Log master column → our field, per sheet; missing = the master name is kept as `field`.
HISTORY_FIELDS: dict[str, dict[str, str]] = {
    "Devices": {
        "Notes": "notes",
        "Status": "status",
        "Category": "category",
        "Type": "type",
        "Device": "device",
        "Room / Location": "room_location",
        "Drawing Position": "drawing_position",
    },
    "Connections": {
        "Note": "note",
        "Status": "status",
        "To": "to_text",
        "From": "from_text",
        "Qty": "qty",
    },
    "Punch List": {
        "#": "number",
        "Date closed": "date_closed",
        "Item": "item",
        "Notes": "notes",
        "Owner": "owner",
        "Tracking status": "tracking_status",
        "Type": "type",
    },
    "Missing Parts": {
        "#": "number",
        "Device / Location": "device_location",
        "Notes": "notes",
        "Part": "part",
        "Part no.": "part_no",
        "Part status": "part_status",
        "Qty": "qty",
        "Owner": "owner",
    },
    "Photo Log": {
        "Location": "location",
        "Subject": "subject",
        "What it shows": "what_it_shows",
    },
}
ROW_ADDED = "(row added)"


@dataclass
class LevelRef:
    code: str
    level_id: uuid.UUID
    numbering_group_id: uuid.UUID
    floor_order: int
    exists: bool  # already in the project (no create op)
    surveyed: date | None = None
    updated: date | None = None
    # the Summary's dates for a level that already exists with them empty (D159 (1))
    fill_surveyed: date | None = None
    fill_updated: date | None = None


@dataclass
class Target:
    """The project the plan is built for; the runner fills it from the database."""

    project_id: uuid.UUID
    user_id: uuid.UUID
    import_user_id: uuid.UUID
    levels: dict[str, LevelRef]
    placeholders: dict[str, uuid.UUID]  # existing, by label (case-insensitive key)
    source_name: str
    now: datetime = field(default_factory=lambda: datetime.now(UTC))
    # numbering groups the workbook adds (id → label): created as ops before their levels, so a
    # client pulling the project gets the group rows too (T35; `POST /projects` does the same)
    new_groups: dict[uuid.UUID, str] = field(default_factory=dict)


@dataclass
class Plan:
    ops: list[OpIn]
    history: list[dict[str, Any]]  # Op columns for `Push.store(row, "superseded")`
    blobs: list[Image]
    stats: dict[str, Any]
    checks: list[str]


# ------------------------------------------------------------------- helpers


def family(code: str) -> str:
    """06 and 06M are one floor for cross-references (D33): `06M` → `06`."""
    return code[:-1] if len(code) > 2 and code.endswith("M") else code


def norm_level(code: str) -> str:
    code = code.upper()
    return code.zfill(2) if code.isdigit() else code


def panel_name(*texts: str | None) -> str | None:
    for t in texts:
        if t and (m := PANEL_RE.search(t)):
            return m.group(0)
    return None


def is_bus_label(text: str | None) -> bool:
    """The master's Unison bus spellings (D50): any label naming stations (and sensors)."""
    if not text:
        return False
    t = text.casefold()
    if t == BUS_LABEL.casefold():
        return True
    return "station" in t and ("sensor" in t or t.endswith("stations"))


def endpoint_tokens(label: str | None) -> frozenset[str]:
    """What a From label names, for matching against a To text."""
    if not label:
        return frozenset()
    t = label.casefold()
    out: set[str] = set()
    if m := PANEL_RE.search(label):
        out.add(m.group(0).casefold())
    if "rack" in t:
        out.add("rack")
    for key in ("ufmp4", "ufmp8", "nsps", "uhci", "ts7", "ern4"):
        if key in t:
            out.add(key)
    if is_bus_label(label):
        out.add("bus")
    if "120v" in t:
        out.add("power")
    return frozenset(out)


def mentioned_tokens(text: str | None) -> frozenset[str]:
    if not text:
        return frozenset()
    t = text.casefold()
    out: set[str] = set()
    for m in PANEL_RE.finditer(text):
        out.add(m.group(0).casefold())
    if "rack" in t:
        out.add("rack")
    for key in ("ufmp4", "ufmp8", "nsps", "uhci", "ts7", "ern4"):
        if key in t:
            out.add(key)
    if "station" in t or "devices" in t:
        out.add("bus")
    return frozenset(out)


def level_mentions(text: str | None) -> frozenset[str]:
    if not text:
        return frozenset()
    return frozenset(family(norm_level(m.group(1))) for m in LEVEL_RE.finditer(text))


# -------------------------------------------------------------------- devices


@dataclass
class Dev:
    id: uuid.UUID
    level: str
    display_id: str
    category: str | None
    device: str | None
    type: str | None
    room: str | None
    panel: str | None


@dataclass
class EndMiss:
    """T122: a cable item that names no single end of its device — the codes it names and the
    device's ends with them, for its Needs review item."""

    codes: frozenset[str]
    candidates: list["End"]


@dataclass
class End:
    """One Connections row before pairing."""

    row: Row
    id: uuid.UUID
    level: str
    display_id: str
    from_text: str | None
    code: str | None
    to_text: str | None
    qty: int | None
    status: str | None
    note: str | None
    endpoint: tuple[str, uuid.UUID] | None = None  # ("device" | "placeholder", id)
    tokens: frozenset[str] = frozenset()
    cable_id: uuid.UUID | None = None
    partner: End | None = None
    side_b: bool = False  # the partner writes the cable; this end is its side B
    far: tuple[str, uuid.UUID] | None = None  # resolved far-end placeholder

    @property
    def single_row(self) -> bool:
        return self.code in SINGLE_ROW_CODES


class Builder:
    def __init__(self, wb: Workbook, target: Target) -> None:
        self.wb = wb
        self.t = target
        self.ops: list[OpIn] = []
        self.history: list[dict[str, Any]] = []
        self.blobs: list[Image] = []
        self.checks: list[str] = list(wb.checks)
        self.stats: dict[str, Any] = {}
        self._ts = target.now
        self.placeholders: dict[str, uuid.UUID] = {
            k.casefold(): v for k, v in target.placeholders.items()
        }
        self.devices: list[Dev] = []
        self.by_display: dict[str, Dev] = {}
        self.by_level: dict[str, list[Dev]] = {}
        self.punch_by_key: dict[tuple[uuid.UUID, int], uuid.UUID] = {}
        self.part_by_key: dict[tuple[uuid.UUID, int], uuid.UUID] = {}
        self.photo_by_key: dict[tuple[uuid.UUID, int], uuid.UUID] = {}
        self.end_by_key: dict[tuple[str, str], End] = {}
        self.ends_by_device: dict[uuid.UUID, list[End]] = {}
        self.punch_end: dict[uuid.UUID, uuid.UUID] = {}  # punch item → its cable end (T119)
        # every punch item / device row naming a photo number, in sheet order (D128: all linked)
        self.punch_photo_refs: dict[tuple[uuid.UUID, int], list[uuid.UUID]] = {}
        self.device_photo_refs: dict[tuple[uuid.UUID, int], list[uuid.UUID]] = {}
        self.reviews = 0
        self.findings = 0

    # ----------------------------------------------------------- op factory

    def op(self, kind: str, entity_kind: str, entity_id: uuid.UUID, **kw: Any) -> OpIn:
        self._ts += timedelta(microseconds=1)  # keeps D37 order inside the import
        op = OpIn(
            op_id=uuid7(),
            project_id=self.t.project_id,
            user_id=self.t.user_id,
            install_id=IMPORT_INSTALL_ID,
            client_ts=self._ts,
            entity_kind=entity_kind,
            entity_id=entity_id,
            kind=kind,
            change_type=IMPORT_CHANGE_TYPE,
            reason=f"Seed import from {self.t.source_name}",
            **kw,
        )
        self.ops.append(op)
        return op

    def create(self, entity_kind: str, payload: dict[str, Any]) -> OpIn:
        eid = payload.get("id") or uuid7()
        payload = {"id": eid, **payload}
        return self.op("create", entity_kind, eid, payload=jsonable(payload))

    def count(self, key: str, n: int = 1) -> None:
        self.stats[key] = self.stats.get(key, 0) + n

    # --------------------------------------------------------- level lookup

    def level(self, code: str | None, where: str) -> LevelRef | None:
        if not code:
            self.checks.append(f"{where}: no Level; row skipped")
            return None
        ref = self.t.levels.get(norm_level(code))
        if ref is None:
            self.checks.append(f"{where}: Level {code!r} is not in the Summary; row skipped")
        return ref

    def group_levels(self, group_id: uuid.UUID) -> list[str]:
        return [c for c, r in self.t.levels.items() if r.numbering_group_id == group_id]

    # ----------------------------------------------------- review / finding

    def review(self, kind: str, level_id, subject: dict, candidates: list[dict]) -> None:
        self.reviews += 1
        self.create(
            "review_item",
            {
                "project_id": self.t.project_id,
                "level_id": level_id,
                "kind": kind,
                "subject": subject,
                "op_a_id": None,
                "op_b_id": None,
                "candidates": candidates,
                "ruling": False,
                "state": "open",
            },
        )

    def finding(self, lint_id: str, level_id, subject: dict, message: str) -> None:
        self.findings += 1
        self.create(
            "finding",
            {
                "project_id": self.t.project_id,
                "level_id": level_id,
                "lint_id": lint_id,
                "subject": subject,
                "message": message,
                "state": "open",
            },
        )

    def enum(
        self,
        allowed: tuple[str, ...],
        raw: str | None,
        *,
        entity_kind: str,
        entity_id: uuid.UUID,
        fld: str,
        level_id,
    ) -> str | None:
        """A fixed-list value, or None plus a `lint` review item when the text is off the list."""
        if raw is None or raw in allowed:
            return raw
        self.review(
            "lint",
            level_id,
            {
                "entity_kind": entity_kind,
                "entity_id": str(entity_id),
                "field": fld,
                "level_id": str(level_id) if level_id else None,
                "lint_id": "import.out_of_list",
            },
            [{"side": "import", "value": raw, "allowed": list(allowed)}],
        )
        return None

    # ---------------------------------------------------------- placeholders

    def placeholder(self, label: str, kind: str) -> uuid.UUID:
        key = label.casefold()
        if key in self.placeholders:
            return self.placeholders[key]
        pid = uuid7()
        self.create(
            "placeholder",
            {"id": pid, "project_id": self.t.project_id, "label": label, "kind": kind},
        )
        self.placeholders[key] = pid
        self.count("placeholders")
        return pid

    def far_placeholder(self, to_text: str | None) -> tuple[str, uuid.UUID] | None:
        """A far end the To text names outright: an out-of-scope `Level NN` or a seed label."""
        if not to_text:
            return None
        for lv in LEVEL_RE.finditer(to_text):
            code = norm_level(lv.group(1))
            if family(code) not in {family(c) for c in self.t.levels}:
                return ("placeholder", self.placeholder(f"Level {code}", "level_not_in_scope"))
        t = to_text.casefold()
        for label, kind in SEED_PLACEHOLDERS:
            if kind in ("fixtures", "power", "station_bus", "level_not_in_scope"):
                continue
            if label.casefold() in t:
                return ("placeholder", self.placeholder(label, kind))
        return None

    # ------------------------------------------------------------- the plan

    def build(self) -> Plan:
        self.levels()
        for label, kind in SEED_PLACEHOLDERS:
            self.placeholder(label, kind)
        self.devices_tab()
        self.connections_tab()
        self.punch_tab()
        self.parts_tab()
        self.photos_tab()
        self.change_log_tab()
        self.stats["review_items"] = self.reviews
        self.stats["findings"] = self.findings
        self.stats["ops"] = len(self.ops)
        self.stats["historical_ops"] = len(self.history)
        self.stats["checks"] = len(self.checks)
        return Plan(self.ops, self.history, self.blobs, self.stats, self.checks)

    # --------------------------------------------------------------- levels

    def levels(self) -> None:
        for gid, label in self.t.new_groups.items():
            self.create(
                "numbering_group", {"id": gid, "project_id": self.t.project_id, "label": label}
            )
            self.count("numbering_groups")
        for code, ref in self.t.levels.items():
            if ref.exists:
                fills = (("surveyed", ref.fill_surveyed), ("updated", ref.fill_updated))
                for fld, value in fills:
                    if value is not None:
                        now = value.isoformat()
                        self.op("set", "level", ref.level_id, field=fld, was=None, now=now)
                        self.count("level_dates")
                continue
            self.create(
                "level",
                {
                    "id": ref.level_id,
                    "project_id": self.t.project_id,
                    "level": code,
                    "floor_order": ref.floor_order,
                    "numbering_group_id": ref.numbering_group_id,
                    "in_scope": True,
                    "surveyed": ref.surveyed,
                    "updated": ref.updated,
                    "state": "setup",
                },
            )
            self.count("levels")

    # -------------------------------------------------------------- devices

    def devices_tab(self) -> None:
        for row in self.wb.tab("Devices"):
            where = f"Devices row {row.excel_row}"
            lv = self.level(row.get("level"), where)
            if lv is None:
                continue
            display_id = row.get("display_id")
            if not display_id:
                self.checks.append(f"{where}: no ID; row skipped")
                continue
            if display_id in self.by_display:
                self.checks.append(f"{where}: duplicate ID {display_id}; row skipped")
                continue
            did = uuid7()
            raw_status = row.get("status")
            status = (
                None
                if raw_status == UNSURVEYED
                else self.enum(
                    vocab.DEVICE_STATUS,
                    raw_status,
                    entity_kind="device",
                    entity_id=did,
                    fld="status",
                    level_id=lv.level_id,
                )
            )
            dev = Dev(
                id=did,
                level=lv.code,
                display_id=display_id,
                category=row.get("category"),
                device=row.get("device"),
                type=row.get("type"),
                room=row.get("room_location"),
                panel=panel_name(row.get("device"), row.get("type")),
            )
            self.create(
                "device",
                {
                    "id": did,
                    "level_id": lv.level_id,
                    "display_id": display_id,
                    "category": dev.category,
                    "device": dev.device,
                    "type": dev.type,
                    "room_location": dev.room,
                    "drawing_position": row.get("drawing_position"),
                    "status": status,
                    "notes": row.get("notes"),
                    "origin": "import",
                    "panel_name": dev.panel,
                },
            )
            self.devices.append(dev)
            self.by_display[display_id] = dev
            self.by_level.setdefault(lv.code, []).append(dev)
            for n in photo_numbers(row.get("photo")):
                self.device_photo_refs.setdefault((lv.numbering_group_id, n), []).append(did)
            self.count("devices")

    # ---------------------------------------------------- device matching

    def level_devices(self, code: str) -> list[Dev]:
        return self.by_level.get(code, [])

    def device_for_label(self, label: str | None, code: str) -> Dev | None:
        """The device a From/To label or a punch/part Device text names on `code`, else None."""
        if not label:
            return None
        text = label.strip()
        head = LABEL_SPLIT_RE.split(text, maxsplit=1)
        name, room = head[0].strip(), (head[1].strip() if len(head) > 1 else None)
        devs = self.level_devices(code)
        if not devs:
            return None
        several = bool(MULTI_RE.search(name))  # `S1, S2` · `CT01LCPB, CT01LCPA` · `#2 / #3`
        if m := HASH_TAG_RE.match(name):  # `PI1002 #2` (level 06 style) → 06-S2
            if several:
                return None
            letter = "S" if m.group(1).upper().startswith("PI") else "D"
            return self.by_display.get(f"{code}-{letter}{m.group(2)}")
        tags = {(m.group(1).upper(), int(m.group(2))) for m in TAG_RE.finditer(name)}
        if tags:  # `PI1104 S4`; a range (`S3-S9`) or a list names several → no single match
            if len(tags) != 1:
                return None
            ((letter, n),) = tags
            return self.by_display.get(f"{code}-{letter}{n}")
        if several:
            return None
        lname = name.casefold()
        if panel := PANEL_RE.search(name):
            if lname.startswith("ebdk"):
                return first(d for d in devs if d.category == "EBDK" and d.panel == panel.group(0))
            return first(
                d for d in devs if d.panel == panel.group(0) and d.category != "EBDK"
            ) or first(d for d in devs if d.panel == panel.group(0))
        if "rack" in lname:
            return first(d for d in devs if d.category == "Equipment rack")
        if "nsps" in lname:
            return first(d for d in devs if d.category == "NSPS")
        index = None
        if m := re.fullmatch(r"(.+?)\s+#(\d+)", name):  # `UFMP4 #2` → the second UFMP4
            lname, index = m.group(1).casefold(), int(m.group(2))
        exact = [d for d in devs if (d.device or "").casefold() == lname]
        if not exact:  # `UFMP4 (7)`, `UFMP4s`, `UHCI-WM partition sensor`
            exact = [d for d in devs if d.device and lname.startswith(d.device.casefold())]
        if not exact:
            exact = [
                d for d in devs if d.device and len(d.device) >= 4 and d.device.casefold() in lname
            ]
        if index is not None and len(exact) >= index:
            return exact[index - 1]
        if room and len(exact) > 1:
            lroom = room.casefold()
            by_room = [
                d
                for d in exact
                if d.room and (lroom in d.room.casefold() or d.room.casefold() in lroom)
            ]
            if len(by_room) == 1:
                return by_room[0]
        if len(exact) == 1:
            return exact[0]
        if exact:
            self.count("ambiguous_device_labels")
        return None

    # ---------------------------------------------------------- connections

    def connections_tab(self) -> None:
        ends: list[End] = []
        for row in self.wb.tab("Connections"):
            where = f"Connections row {row.excel_row}"
            lv = self.level(row.get("level"), where)
            if lv is None:
                continue
            display_id = row.get("display_id")
            if not display_id:
                self.checks.append(f"{where}: no ID; row skipped")
                continue
            eid = uuid7()
            status = self.enum(
                vocab.CONNECTION_STATUS,
                row.get("status"),
                entity_kind="cable_end",
                entity_id=eid,
                fld="status",
                level_id=lv.level_id,
            )
            e = End(
                row=row,
                id=eid,
                level=lv.code,
                display_id=display_id,
                from_text=row.get("from_text"),
                code=row.get("cable"),
                to_text=row.get("to_text"),
                qty=row.get("qty"),
                status=status,
                note=row.get("note"),
            )
            self.resolve_endpoint(e)
            ends.append(e)
            self.end_by_key[(lv.code, display_id)] = e
            if e.endpoint and e.endpoint[0] == "device":
                self.ends_by_device.setdefault(e.endpoint[1], []).append(e)
        self.pair(ends)
        renamed: list[tuple[End, OpIn]] = []
        for e in ends:
            if e.side_b:
                continue  # written with its partner
            cable_id = uuid7()
            a, b = e, e.partner
            e.cable_id = cable_id
            if b is not None:
                b.cable_id = cable_id
            qty = a.qty if a.qty is not None else (b.qty if b else None)
            if b is not None and a.qty is not None and b.qty is not None and a.qty != b.qty:
                self.checks.append(
                    f"Connections {a.level} {a.display_id} / {b.level} {b.display_id}: "
                    f"Qty {a.qty} vs {b.qty}; {a.qty} kept"
                )
            b_id = b.id if b is not None else uuid7()
            self.create(
                "cable",
                {
                    "id": cable_id,
                    "project_id": self.t.project_id,
                    "cable": a.code,
                    "qty": qty,
                    "origin": "import",
                    "single_row": a.single_row,
                    "end_a_id": a.id,
                    "end_b_id": b_id,
                    "endpoint_confirmed": False,
                },
            )
            self.count("cables")
            created = self.end_create(a, cable_id, "A")
            if a.from_text and is_bus_label(a.from_text) and a.from_text != BUS_LABEL:
                renamed.append((a, created))
            if b is not None:
                created_b = self.end_create(b, cable_id, "B")
                if b.from_text and is_bus_label(b.from_text) and b.from_text != BUS_LABEL:
                    renamed.append((b, created_b))
                self.count("paired_cables")
            else:
                self.far_end_create(a, cable_id, b_id)
        self.rename_ruling(renamed)
        self.stats["ends"] = len(ends)

    def resolve_endpoint(self, e: End) -> None:
        """The row's own endpoint, from its From label (the To device for `120V`, whose From is
        the power placeholder)."""
        label = e.from_text
        if e.code == "120V" and (not label or "120v" in label.casefold()):
            dev = self.device_for_label(e.to_text, e.level)
            if dev is not None:
                e.endpoint = ("device", dev.id)
                e.tokens = endpoint_tokens(e.to_text)
                return
        if is_bus_label(label):
            e.endpoint = ("placeholder", self.placeholder(BUS_LABEL, "station_bus"))
        elif label and "120v" in label.casefold():
            e.endpoint = ("placeholder", self.placeholder(POWER_LABEL, "power"))
        else:
            dev = self.device_for_label(label, e.level)
            if dev is not None:
                e.endpoint = ("device", dev.id)
        e.tokens = endpoint_tokens(label)
        if e.endpoint is None:
            lv = self.t.levels[e.level]
            self.finding(
                "import.endpoint",
                lv.level_id,
                {"entity_kind": "cable_end", "entity_id": str(e.id), "level_id": str(lv.level_id)},
                f"{e.level} {e.display_id}: From {label!r} matches no device or placeholder",
            )

    def pair(self, ends: list[End]) -> None:
        """Greedy best-score matching of pairable ends; the rest get candidates or a far end."""
        for e in ends:
            if e.single_row:
                continue
            e.far = self.far_placeholder(e.to_text)
        pool = [e for e in ends if not e.single_row and e.far is None]
        scores: list[tuple[float, End, End]] = []
        for i, a in enumerate(pool):
            for b in pool[i + 1 :]:
                s = pair_score(a, b)
                if s >= CANDIDATE_MIN:
                    scores.append((s, a, b))
        scores.sort(key=lambda t: (-t[0], t[1].row.excel_row, t[2].row.excel_row))
        for s, a, b in scores:
            if s < PAIR_MIN or a.partner is not None or b.partner is not None:
                continue
            # side A is the lower floor (then the earlier row); its partner is side B
            side_a, side_b = sorted(
                (a, b), key=lambda e: (self.t.levels[e.level].floor_order, e.row.excel_row)
            )
            side_a.partner, side_b.partner = side_b, side_a
            side_b.side_b = True
            self.count("pairs")
        for e in pool:
            if e.partner is not None:
                continue
            candidates = sorted(
                (
                    (s, b if a is e else a)
                    for s, a, b in scores
                    if (a is e or b is e) and (b if a is e else a).partner is None
                ),
                key=lambda t: -t[0],
            )
            lv = self.t.levels[e.level]
            self.review(
                "import_pair",
                lv.level_id,
                {
                    "entity_kind": "cable_end",
                    "entity_id": str(e.id),
                    "field": "cable_id",
                    "level_id": str(lv.level_id),
                    "label": f"{e.level} {e.display_id} · {e.from_text} {e.code} {e.to_text}",
                },
                [
                    {
                        "side": "candidate",
                        "entity_kind": "cable_end",
                        "entity_id": str(c.id),
                        "level": c.level,
                        "display_id": c.display_id,
                        "from_text": c.from_text,
                        "cable": c.code,
                        "to_text": c.to_text,
                        "confidence": round(s, 2),
                    }
                    for s, c in candidates
                ],
            )
            self.count("unpaired_ends")

    def end_create(self, e: End, cable_id: uuid.UUID, side: str) -> OpIn:
        lv = self.t.levels[e.level]
        kind, ref = e.endpoint if e.endpoint else (None, None)
        op = self.create(
            "cable_end",
            {
                "id": e.id,
                "cable_id": cable_id,
                "side": side,
                "endpoint_kind": kind,
                "device_id": ref if kind == "device" else None,
                "placeholder_id": ref if kind == "placeholder" else None,
                "level_id": lv.level_id,
                "display_id": e.display_id,
                "from_text": e.from_text,
                "to_text": e.to_text,
                "status": e.status,
                "note": e.note,
                "status_source": "surveyed" if e.status else None,
            },
        )
        self.count("numbered_ends")
        return op

    def far_end_create(self, a: End, cable_id: uuid.UUID, b_id: uuid.UUID) -> None:
        """Side B of a single-row or unpaired cable: a device (the panel's EBDK for `P`), the
        placeholder the To text names, or nothing yet (an `import_pair` item is open)."""
        kind: str | None = None
        ref: uuid.UUID | None = None
        level_id = None
        if a.code == "P":
            devs = self.level_devices(a.level)
            panel = panel_name(a.from_text)
            ebdk = first(d for d in devs if d.category == "EBDK" and panel and d.panel == panel)
            if ebdk is None:
                only = [d for d in devs if d.category == "EBDK"]
                ebdk = only[0] if len(only) == 1 else None
            if ebdk is not None:
                kind, ref, level_id = "device", ebdk.id, self.t.levels[a.level].level_id
        elif a.code == "0-10V":
            kind, ref = "placeholder", self.placeholder(FIXTURES_LABEL, "fixtures")
        elif a.code == "120V":
            kind, ref = "placeholder", self.placeholder(POWER_LABEL, "power")
        elif a.far is not None:
            kind, ref = a.far
        self.create(
            "cable_end",
            {
                "id": b_id,
                "cable_id": cable_id,
                "side": "B",
                "endpoint_kind": kind,
                "device_id": ref if kind == "device" else None,
                "placeholder_id": ref if kind == "placeholder" else None,
                "level_id": level_id,
            },
        )
        self.count("far_ends")

    def rename_ruling(self, renamed: list[tuple[End, OpIn]]) -> None:
        """D50: the bus spellings become `Stations & Sensors` by one recorded ruling."""
        if not renamed:
            return
        spellings = sorted({e.from_text for e, _ in renamed if e.from_text})
        ruling_id = uuid7()
        text = f"Unison bus placeholder is spelled {BUS_LABEL!r} (D50)"
        self.create(
            "ruling",
            {
                "id": ruling_id,
                "project_id": self.t.project_id,
                "text": text,
                "scope_levels": sorted(self.t.levels),
                "filter": {"entity": "cable_end", "field": "from_text", "values": spellings},
                "action": {"set": {"from_text": BUS_LABEL}},
                "standing": True,
                "created_by_id": self.t.user_id,
                "created_at": self.t.now,
                "applied_at": self.t.now,
                "op_count": len(renamed),
            },
        )
        for e, created in renamed:
            op = self.op(
                "set",
                "cable_end",
                e.id,
                field="from_text",
                was=e.from_text,
                now=BUS_LABEL,
                base_op_id=created.op_id,
                ruling_id=ruling_id,
            )
            op.change_type = "Ruling"
            op.reason = text
        self.stats["renamed_bus_ends"] = len(renamed)
        self.stats["bus_spellings"] = spellings

    # ---------------------------------------------------------------- punch

    def punch_tab(self) -> None:
        for row in self.wb.tab("Punch List"):
            where = f"Punch List row {row.excel_row}"
            lv = self.level(row.get("level"), where)
            if lv is None:
                continue
            number = row.get("number")
            if number is None:
                self.checks.append(f"{where}: no #; row skipped")
                continue
            pid = uuid7()
            item = row.get("item")
            dev = self.device_for_label(row.get("device"), lv.code)
            found = self.punch_end_for(dev, item, f"Punch List {lv.code} #{number}")
            end = found if isinstance(found, End) else None
            if end is not None:
                self.punch_end[pid] = end.id
            self.create(
                "punch_item",
                {
                    "id": pid,
                    "level_id": lv.level_id,
                    "number": number,
                    "device_id": dev.id if dev else None,
                    "cable_end_id": end.id if end else None,
                    # the master's spelling: Needs review shows it; exported only while no
                    # device is linked (D148, D150)
                    "device_text": row.get("device"),
                    "item": item,
                    "type": self.enum(
                        vocab.PUNCH_TYPE,
                        row.get("type"),
                        entity_kind="punch_item",
                        entity_id=pid,
                        fld="type",
                        level_id=lv.level_id,
                    ),
                    "owner": self.enum(
                        vocab.OWNER,
                        row.get("owner"),
                        entity_kind="punch_item",
                        entity_id=pid,
                        fld="owner",
                        level_id=lv.level_id,
                    ),
                    "tracking_status": self.enum(
                        vocab.TRACKING_STATUS,
                        row.get("tracking_status"),
                        entity_kind="punch_item",
                        entity_id=pid,
                        fld="tracking_status",
                        level_id=lv.level_id,
                    ),
                    "date_closed": row.get("date_closed"),
                    "notes": row.get("notes"),
                    "sort_last": item == NEURON_ITEM,
                },
            )
            self.punch_by_key[(lv.numbering_group_id, number)] = pid
            if dev is None and row.get("device") and item != NEURON_ITEM:
                self.punch_device_review(pid, lv, row.get("device"))
            if isinstance(found, EndMiss):
                self.punch_end_review(pid, lv, item, found)
            for n in photo_numbers(row.get("photo")):
                self.punch_photo_refs.setdefault((lv.numbering_group_id, n), []).append(pid)
            self.count("punch_items")

    def punch_end_for(self, dev: Dev | None, item: str | None, where: str) -> End | EndMiss | None:
        """T119: the one end of `dev` a cable item names — "Run DMX to B3A Canyon" ↔ C-09 "DMX to
        B3A Canyon", "Land 0-10V control wiring" ↔ its only 0-10V end. The item's verb says it is
        about a cable (Run / Pull / Terminate / Land …) and it names one signal; of the device's
        ends with that code, the one whose To text the item's destination matches (the same words,
        a plural `s` aside, one set inside the other), else the only one. A cable item naming
        none, or several (two signals, two destinations, two candidates), stays device-only, is
        listed in the checks and comes back as an `EndMiss` for its Needs review item (T122)."""
        if dev is None or not item or not CABLE_VERB_RE.match(item.strip()):
            return None
        codes = item_signals(item)
        if codes is None:
            return None
        label = f"{where}: {item!r} on {dev.display_id}"
        signals = frozenset().union(*codes)
        if len(codes) > 1:
            self.end_unmatched(f"{label} names several signals; linked to the device only")
            return EndMiss(
                signals, [e for e in self.ends_by_device.get(dev.id, []) if e.code in signals]
            )
        (code,) = codes
        candidates = [e for e in self.ends_by_device.get(dev.id, []) if e.code in code]
        m = DESTINATION_RE.search(item)
        destination = re.sub(r"\([^)]*\)", " ", m.group(1)) if m else None
        if destination and SEVERAL_RE.search(destination):
            self.end_unmatched(f"{label} names several runs; linked to the device only")
            return EndMiss(signals, candidates)
        hits = candidates
        if destination and (want := word_set(destination)):
            named = [
                e
                for e in candidates
                if (have := word_set(end_target(e.to_text))) and (want <= have or have <= want)
            ]
            hits = named or candidates
        if len(hits) == 1:
            self.count("punch_end_links")
            return hits[0]
        found = ", ".join(e.display_id for e in hits) if hits else "none"
        self.end_unmatched(
            f"{label} names no single connection end (candidates: {found}); "
            "linked to the device only"
        )
        return EndMiss(signals, hits or candidates)

    def end_unmatched(self, check: str) -> None:
        self.count("punch_end_unmatched")
        self.checks.append(check)

    def punch_end_review(
        self, pid: uuid.UUID, lv: LevelRef, item: str | None, miss: EndMiss
    ) -> None:
        """T122: a cable item left on its device waits on Needs review, where a person puts it on
        one of its device's ends with the codes it names (`candidates`, as imported; the iPad
        lists the device's ends live) or keeps it on the device. An item about two runs goes on
        one of them; the other run gets its own Run draft (D220)."""
        self.review(
            "lint",
            lv.level_id,
            {
                "entity_kind": "punch_item",
                "entity_id": str(pid),
                "field": "cable_end_id",
                "level_id": str(lv.level_id),
                "lint_id": PUNCH_END_LINT,
                "codes": sorted(miss.codes),
            },
            [{"side": "import", "value": item}]
            + [
                {
                    "side": "end",
                    "value": str(e.id),
                    "label": f"{e.display_id} {e.to_text or ''}".strip(),
                }
                for e in miss.candidates
            ],
        )

    def punch_device_review(self, pid: uuid.UUID, lv: LevelRef, text: str) -> None:
        """D148: a Punch List row whose Device text links to no single device (no match, a room,
        `All devices`, `S3-S9`) waits on Needs review, where a person links it to a device or
        creates one. The Neuron ID row is left out: it names every device by design (D49)."""
        self.count("punch_device_unmatched")
        self.review(
            "lint",
            lv.level_id,
            {
                "entity_kind": "punch_item",
                "entity_id": str(pid),
                "field": "device_id",
                "level_id": str(lv.level_id),
                "lint_id": PUNCH_DEVICE_LINT,
            },
            [{"side": "import", "value": text}],
        )

    # ---------------------------------------------------------------- parts

    def parts_tab(self) -> None:
        for row in self.wb.tab("Missing Parts"):
            where = f"Missing Parts row {row.excel_row}"
            lv = self.level(row.get("level"), where)
            if lv is None:
                continue
            number = row.get("number")
            if number is None:
                self.checks.append(f"{where}: no #; row skipped")
                continue
            pid = uuid7()
            dev = self.device_for_label(row.get("device_location"), lv.code)
            self.create(
                "missing_part",
                {
                    "id": pid,
                    "level_id": lv.level_id,
                    "number": number,
                    "device_id": dev.id if dev else None,
                    "device_location": row.get("device_location"),
                    "part": row.get("part"),
                    "part_no": row.get("part_no"),
                    "qty": row.get("qty"),
                    "owner": self.enum(
                        vocab.OWNER,
                        row.get("owner"),
                        entity_kind="missing_part",
                        entity_id=pid,
                        fld="owner",
                        level_id=lv.level_id,
                    ),
                    "part_status": self.enum(
                        vocab.PART_STATUS,
                        row.get("part_status"),
                        entity_kind="missing_part",
                        entity_id=pid,
                        fld="part_status",
                        level_id=lv.level_id,
                    ),
                    "notes": row.get("notes"),
                },
            )
            self.part_by_key[(lv.numbering_group_id, number)] = pid
            self.count("missing_parts")
            source = row.get("source")
            links, bad = self.parse_source(source, lv)
            part = row.get("part")
            if (
                part
                and re.search(r"(?<![-\w])kit\b", part, re.I)  # not `P-NSPS-D-KIT`
                and not any(
                    k == "cable_end" or (k == "punch" and t in self.punch_end) for k, t in links
                )
            ):
                # T119: a kit whose Source reaches no end; the rules match it by text (D213 (e))
                self.count("part_end_unmatched")
                self.checks.append(
                    f"Missing Parts {lv.code} #{number}: {part!r} reaches no connection end "
                    f"through its Source ({source or 'none'})"
                )
            for target_kind, target_id in links:
                self.op(
                    "link_add",
                    "part_source",
                    pid,
                    payload={"target_kind": target_kind, "target_id": str(target_id)},
                )
                self.count("part_sources")
            if bad:
                self.finding(
                    "import.part_source",
                    lv.level_id,
                    {
                        "entity_kind": "missing_part",
                        "entity_id": str(pid),
                        "level_id": str(lv.level_id),
                    },
                    f"{lv.code} #{number}: Source {source!r} not understood: {'; '.join(bad)}",
                )

    def parse_source(
        self, source: str | None, lv: LevelRef
    ) -> tuple[list[tuple[str, uuid.UUID]], list[str]]:
        """`Punch #8-14`, `#15, #19`, `Punch #14; Devices 06-S3`, `Connections C-06 (fiber …)`."""
        links: list[tuple[str, uuid.UUID]] = []
        bad: list[str] = []
        if not source:
            return links, bad
        for segment in source.split(";"):
            seg = re.sub(r"\s*\([^)]*\)\s*$", "", segment.strip())
            if not seg:
                continue
            m = re.match(r"^(Punch|Devices?|Connections?)\b\s*(.*)$", seg, re.I)
            kind = m.group(1).casefold() if m else "punch"
            body = m.group(2) if m else seg
            if kind == "punch":
                nums = number_refs(body)
                if nums is None:
                    bad.append(seg)
                    continue
                for n in nums:
                    pid = self.punch_by_key.get((lv.numbering_group_id, n))
                    if pid is None:
                        bad.append(f"#{n} not on the punch list")
                    else:
                        links.append(("punch", pid))
            elif kind.startswith("device"):
                for ref in re.split(r"[,\s]+", body):
                    if not ref:
                        continue
                    dev = self.by_display.get(ref)
                    if dev is None:
                        bad.append(f"device {ref} unknown")
                    else:
                        links.append(("device", dev.id))
            else:
                for ref in re.split(r"[,\s]+", body):
                    if not ref:
                        continue
                    end = self.end_by_key.get((lv.code, ref)) or first(
                        self.end_by_key[(c, ref)]
                        for c in self.group_levels(lv.numbering_group_id)
                        if (c, ref) in self.end_by_key
                    )
                    if end is None:
                        bad.append(f"connection {ref} unknown")
                    else:
                        links.append(("cable_end", end.id))
        return links, bad

    # --------------------------------------------------------------- photos

    def photos_tab(self) -> None:
        seen_blobs: set[str] = set()
        for row in self.wb.tab("Photo Log"):
            where = f"Photo Log row {row.excel_row}"
            lv = self.level(row.get("level"), where)
            if lv is None:
                continue
            number = row.get("number")
            if number is None:
                self.checks.append(f"{where}: no Photo number; row skipped")
                continue
            image = self.wb.images.get(row.excel_row)
            if image is None:
                self.checks.append(f"{where}: no image; photo record kept without a thumbnail")
                self.count("photos_without_image")
            elif image.sha256 not in seen_blobs:
                seen_blobs.add(image.sha256)
                self.blobs.append(image)
            key = (lv.numbering_group_id, number)
            named = photo_device_ids(row.get("device_id") or "", self.by_display)
            devices = [self.by_display[i].id for i in named] or self.device_photo_refs.get(key, [])
            devices = list(dict.fromkeys(devices))
            punches = list(dict.fromkeys(self.punch_photo_refs.get(key, [])))
            if len(named) > 1 or len(devices) > 1:
                self.count("photos_with_several_devices")
            pid = uuid7()
            self.create(
                "photo",
                {
                    "id": pid,
                    "level_id": lv.level_id,
                    "number": number,
                    "location": row.get("location"),
                    "subject": row.get("subject"),
                    "what_it_shows": row.get("what_it_shows"),
                    "device_id": devices[0] if devices else None,
                    "punch_item_id": punches[0] if punches else None,
                    "thumb_blob": image.sha256 if image else None,
                    "seed_thumbnail_only": True,
                },
            )
            # D128: the other devices and punch items the master names for this photo
            for kind, targets in (("device", devices[1:]), ("punch", punches[1:])):
                for target in targets:
                    self.op(
                        "link_add",
                        "photo_link",
                        pid,
                        payload={"target_kind": kind, "target_id": str(target)},
                    )
                    self.count("photo_links")
            self.photo_by_key[(lv.numbering_group_id, number)] = pid
            self.count("photos")

    # ----------------------------------------------------------- change log

    def change_log_tab(self) -> None:
        order = 0
        for row in self.wb.tab("Change Log"):
            where = f"Change Log row {row.excel_row}"
            sheet = row.get("sheet") or ""
            fld = row.get("field") or ""
            change = row.get("change")
            if change not in vocab.CHANGE_TYPE:
                self.checks.append(
                    f"{where}: Change {change!r} is not a change type; recorded as 'Master edit'"
                )
                change = IMPORT_CHANGE_TYPE
            lv = self.t.levels.get(norm_level(row.get("level") or "")) if row.get("level") else None
            entity_kind, entity_id, mapped = self.resolve_history(sheet, row.get("ref"), fld, lv)
            if entity_id is None:
                if lv is None:
                    self.checks.append(
                        f"{where}: Level {row.get('level')!r} unknown; row kept on the project"
                    )
                    entity_kind, entity_id = "project", self.t.project_id
                else:
                    entity_kind, entity_id = "level", lv.level_id
                self.count("history_on_level")
            day = row.get("date") or self.t.now.date()
            order += 1
            ts = datetime(day.year, day.month, day.day, 12, tzinfo=UTC) + timedelta(seconds=order)
            self.history.append(
                {
                    "op_id": uuid7(),
                    "project_id": self.t.project_id,
                    "user_id": self.t.import_user_id,
                    "install_id": IMPORT_INSTALL_ID,
                    "client_ts": ts,
                    "entity_kind": entity_kind,
                    "entity_id": entity_id,
                    "kind": "create" if fld == ROW_ADDED else "set",
                    "field": None if fld == ROW_ADDED else (mapped or fld),
                    "was": row.get("was"),
                    "now": row.get("now"),
                    "payload": {
                        "source": "Change Log",
                        "sheet": sheet,
                        "ref": row.get("ref"),
                        "entry": row.get("entry"),
                        "field": fld,
                        "level": row.get("level"),
                    },
                    "change_type": change,
                    "reason": row.get("reason"),
                }
            )

    def resolve_history(self, sheet: str, ref: str | None, fld: str, lv: LevelRef | None):
        """(entity_kind, entity_id, mapped field) for a Change Log row, ids None when the Ref is
        a range or unknown (the row then hangs off the level)."""
        mapped = HISTORY_FIELDS.get(sheet, {}).get(fld)
        if not ref:
            return None, None, mapped
        ref = ref.strip()
        if sheet == "Devices":
            dev = self.by_display.get(ref)
            return ("device", dev.id, mapped) if dev else (None, None, mapped)
        if lv is None:
            return None, None, mapped
        group = lv.numbering_group_id
        if sheet == "Punch List":
            n = single_number(ref)
            pid = self.punch_by_key.get((group, n)) if n is not None else None
            return ("punch_item", pid, mapped) if pid else (None, None, mapped)
        if sheet == "Missing Parts":
            n = single_number(ref)
            pid = self.part_by_key.get((group, n)) if n is not None else None
            return ("missing_part", pid, mapped) if pid else (None, None, mapped)
        if sheet == "Photo Log":
            n = single_number(ref.replace("Photo", ""))
            pid = self.photo_by_key.get((group, n)) if n is not None else None
            return ("photo", pid, mapped) if pid else (None, None, mapped)
        if sheet == "Connections":
            end = self.end_by_key.get((lv.code, ref))
            if end is None:
                return None, None, mapped
            if fld == "Qty":
                return "cable", end.cable_id, mapped
            return "cable_end", end.id, mapped
        return None, None, mapped


# ------------------------------------------------------------- pure helpers


def first(it):
    for x in it:
        return x
    return None


def jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def item_signals(item: str) -> list[frozenset[str]] | None:
    """The cable codes each signal word of a punch item stands for, in order; None when it names
    none ("network & ground" is read before "network", so it counts once)."""
    text = item
    found: list[frozenset[str]] = []
    for pat, codes in SIGNAL_WORDS:
        if pat.search(text):
            found.append(codes)
            text = pat.sub(" ", text)
    return found or None


def end_target(to_text: str | None) -> str:
    """What an end's To text names as the far end: "DMX to B3A Canyon" → "B3A Canyon"."""
    if not to_text:
        return ""
    m = DESTINATION_RE.search(to_text)
    return m.group(1) if m else to_text


def word_set(text: str) -> frozenset[str]:
    """Lower-case words without parentheses or a plural `s`: "UFMP4 (7)" and "UFMP4s" → {ufmp4}."""
    text = re.sub(r"\([^)]*\)", " ", text.casefold())
    return frozenset(
        w[:-1] if len(w) > 3 and w.endswith("s") else w for w in re.split(r"[^a-z0-9]+", text) if w
    )


def photo_device_ids(text: str, known: dict[str, Any]) -> list[str]:
    """The known device IDs a Photo Log Device ID cell names, in order: a list
    (`B1-01, B1-02`) or a range (`01-S8 to 01-S12` → S8…S12, the IDs between that exist)."""
    out: list[str] = []
    for part in (p.strip() for p in text.split(",")):
        ends = [e.strip() for e in re.split(r"\bto\b", part) if e.strip()]
        if len(ends) == 2:
            a, b = (re.fullmatch(r"(.*?)(\d+)", e) for e in ends)
            if a and b and a.group(1) == b.group(1):
                lo, hi = sorted((int(a.group(2)), int(b.group(2))))
                width = len(a.group(2))
                for n in range(lo, hi + 1):
                    for cand in (f"{a.group(1)}{n}", f"{a.group(1)}{n:0{width}d}"):
                        if cand in known:
                            out.append(cand)
                            break
                continue
        out.extend(e for e in ends if e in known)
    return list(dict.fromkeys(out))


def photo_numbers(text: str | None) -> list[int]:
    """`9, 10` / `12,13` → [9, 10]; anything else → []."""
    if text is None:
        return []
    out: list[int] = []
    for part in re.split(r"[,\s]+", str(text)):
        if part.isdigit():
            out.append(int(part))
    return out


def number_refs(text: str) -> list[int] | None:
    """`#8-14`, `#15, #19, #20`, `#17-19, #21-24` → the numbers; None when a token is not one."""
    out: list[int] = []
    for token in text.split(","):
        token = token.strip().replace(" ", "")
        if not token:
            continue
        m = re.fullmatch(r"#?(\d+)(?:-#?(\d+))?", token)
        if not m:
            return None
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo
        if hi < lo:
            return None
        out.extend(range(lo, hi + 1))
    return out


def single_number(ref: str) -> int | None:
    m = re.fullmatch(r"\s*#?\s*(\d+)\s*", ref)
    return int(m.group(1)) if m else None


def pair_score(a: End, b: End) -> float:
    """How likely two numbered ends are the two ends of one cable (0 = no)."""
    if a.code != b.code or a.single_row or b.single_row:
        return 0.0
    if a.endpoint is not None and a.endpoint == b.endpoint:
        return 0.0  # both ends on one device or one placeholder: never a cable
    if (
        a.from_text
        and b.from_text
        and a.from_text.casefold() == b.from_text.casefold()
        and a.level == b.level
    ):
        return 0.0
    fa, fb = family(a.level), family(b.level)
    same = fa == fb
    ma, mb = level_mentions(a.to_text), level_mentions(b.to_text)

    def lvl(mentions: frozenset[str], other: str) -> float:
        if mentions:
            return 1.0 if other in mentions else -1.0
        return 0.8 if same else 0.0

    la, lb = lvl(ma, fb), lvl(mb, fa)
    if la < 0 or lb < 0:
        return 0.0
    da, db = mentioned_tokens(a.to_text), mentioned_tokens(b.to_text)

    def dev(mentions: frozenset[str], other: frozenset[str]) -> float:
        if mentions:
            return 1.0 if mentions & other else -1.0
        return 0.0

    xa, xb = dev(da, b.tokens), dev(db, a.tokens)
    if xa < 0 or xb < 0:
        return 0.0
    return round(0.3 * la + 0.3 * lb + 0.2 * xa + 0.2 * xb, 3)


def build_plan(wb: Workbook, target: Target) -> Plan:
    return Builder(wb, target).build()
