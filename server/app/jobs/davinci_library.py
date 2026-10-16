"""DaVinci library import (T111, D65, D183, D184, D196, D197): ETC's product catalogue, as the
DaVinci design tool writes it to `%LOCALAPPDATA%/ETC/DaVinci/library.json` at every launch,
becomes **app-library** `library_type` drafts — one per product type Landry's category mapping
keeps — through the library's own op log (`/library/ops`, D184). Never fetched from ETC: Landry
uploads the file from the setup Sources screen (or runs the CLI) whenever a refresh is wanted.

    POST /imports (kind=davinci, file=library.json[, categories=DaVinci_categories.xlsx])
        → import_batch("queued")
    worker: run_queued() → read_library + read_categories → build_plan → ops
            → done | skipped | failed
    python -m app.jobs.davinci_library <library.json> --project <id>
            [--categories <xlsx>] [--user NAME]

What a type gets (PLAN §2.2 `library_type`): `model` = the generated model number with its
`{property}` suffixes stripped; `aliases` = display name, part numbers and the suffixed variants
of the part lookup; `category` from the mapping workbook (Categories tab "Our category", Types tab
"Override"; `Ignore` rows are skipped); `default_cables` from the ports (DMX → X, 0-10V → 0-10V,
Panic → P, LinkConnect and EchoConnect → U, aux power → UV, Sense → 120V, DALI → D, Fiber → F,
Ethernet → NG on Touchscreen and Station types else N, Paradigm Portable → N (D199, D200); a
Power **input** → 120V, a Power output is a load circuit and no cable; the protocols Landry ruled
**not surveyed** (contact closures, USB, serial, MIDI…) make no row; any protocol nobody has ruled
on becomes a `vocab(cable_code)` draft in the uploading project — never a new code). A type that
**is a power supply** (DaVinci's Power Supplies category, a PowerSupplyCurrentDraw script, a
"Power Supply - Aux" property, or the name) or **carries one as an accessory** gets a `120V` feed
row too (D198: every power supply needs a 120 V line in). `optional_accessories` = the
accessory slots with `max_quantity`, `expected_qty`
for forced (`userDefinable = false`) and `SetMinAccessories` slots, and the `MaxAccessoryMonitor`
group each slot belongs to (`{label, min, max}`); `needs_neuron_id` = true when the type carries
IP / subnet / gateway properties; `description`, the first datasheet URL and `source_ref`
(`{kind: "davinci", type_id, …}`). Accessories a kept type references are imported too, even from
an `Ignore` row, as `accessory_only` types (never offered as a device). From / To templates,
far-end placeholders and the NSPS -KIT power-supply expectation (D52) are not written: the
reviewer adds them.

Re-running on a newer file updates **draft** rows by DaVinci `typeId` (field by field, as `set`
ops with history) and never touches an accepted or rejected type. With `retire_hand_made` the
run first soft-deletes every app-library type that has no `source_ref` (hand-made, any state) —
Landry's ruling once the catalogue covers them (D199); the project copies of those types stay.
The same pair of files is not imported twice (`skipped`). Everything is one transaction through
the ordinary apply loop.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import re
import sys
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import system_user, upsert_user
from app.ids import uuid7
from app.jobs import runner
from app.models import FieldHead, ImportBatch, LibraryType, Project, User, Vocab
from app.storage import ObjectStore
from app.sync import LIBRARY_STREAM, SERVER_INSTALL_ID, OpIn, Push, jsonable

log = logging.getLogger("jobs")

DAVINCI_KIND = "davinci"
JSON_MIME = "application/json"
XLSX_MIME = runner.XLSX_MIME
CHANGE_TYPE = "Master edit"
REASON = "DaVinci library import"
IMPORT_USER_NAME = "davinci"
RETIRE_REASON = "Replaced by the DaVinci library import"
IGNORE = "Ignore"
CABLE_CODE_LIST = "cable_code"

# Port protocol (DaVinci `constants.portProtocols[].text`) → cable code (CLAUDE.md §3; the
# EchoConnect, aux power, Sense and DALI rows are Landry's, D199).
CODE_BY_PROTOCOL: dict[str, str] = {
    "DMX": "X",
    "0-10V": "0-10V",
    "Panic": "P",
    "LinkConnect": "U",
    "EchoConnect": "U",
    "Aux Power Input": "UV",
    "24vdc Auxiliary Power": "UV",
    "48vdc Auxiliary Power": "UV",
    "Sense": "120V",
    "DALI": "D",
    "Paradigm Portable": "N",
    "Fiber (Short Haul)": "F",
    "Fiber (Long Haul)": "F",
}
# Not surveyed (Landry, D200): no cable row, no vocab draft; the ports stay in `source_ref.ports`.
NOT_SURVEYED: frozenset[str] = frozenset(
    {
        "Contact",
        "EBDK Switch",
        "USB",
        "Serial",
        "MIDI",
        "SMPTE",
        "LSH Control",
        "SPS Connection",
        "Control",
        "Emergency",
        "CANbus",
        "CANbus (Connect)",
        "CANbus (Report)",
        "Multiverse",
        "MeshConnect",
        "Echoflex",
        "Audio",
        "F-Drive Connection (CC)",
        "F-Drive Connection (CV)",
        "F-Drive Connection (FTW)",
        "F-Drive Connection (Chroma)",
        "F-Drive Connection (ArcLamp)",
        "F-Drive RX Connection (CC)",
        "F-Drive RX Connection (CV)",
        "F-Drive RX Connection (FTW)",
        "F-Drive RX Power Supply",
        "F-Drive R12 Power Supply",
    }
)
ETHERNET = "Ethernet"
POWER = "Power"
# A Power port that feeds the device (Input, or a Bus such as an ECPB's AC pass-through) is a
# 120V feed; a Power Output is a load circuit, not a surveyed cable.
POWER_FEED_DIRECTIONS = frozenset({"Input", "Bus"})
# How DaVinci marks a power supply (D198): its category, the scripts that size one, the property
# naming its aux capacity, or the name. "Power Supply - Units" / "Enabled" sit on hosts that may
# take one and are not used.
POWER_SUPPLY_CATEGORY = "Power Supplies"
POWER_SUPPLY_SCRIPTS = frozenset({"PowerSupplyCurrentDraw", "ParadigmPowerSupplyCurrentDraw"})
POWER_SUPPLY_PROPERTY = "Power Supply - Aux"
POWER_SUPPLY_NAME = re.compile(r"power supply|power module", re.I)
NOT_A_POWER_SUPPLY = re.compile(r"no power supply", re.I)
# Ethernet is `NG` (network + ground) on these categories, `N` elsewhere.
GROUND_CATEGORIES = frozenset({"Touchscreen", "Station"})
# One row per device with `qty` = port count: P and 0-10V (CLAUDE.md §3) and DALI loops (as 0-10V).
SINGLE_ROW = frozenset({"P", "0-10V", "120V", "D"})
# A type with any of these properties is addressed on the network: it carries a Neuron ID.
NEURON_PROPERTIES = ("IP Address", "Subnet Mask", "Gateway Address")
DATASHEET = "Datasheet"
MAX_ACCESSORY_MONITOR = "MaxAccessoryMonitor"
SET_MIN_ACCESSORIES = "SetMinAccessories"
# The `library_type` fields a re-run compares and updates on a draft.
UPDATED_FIELDS = (
    "model",
    "aliases",
    "category",
    "default_cables",
    "optional_accessories",
    "needs_neuron_id",
    "description",
    "datasheet_url",
    "source_ref",
    "accessory_only",
)


def _event(event: str, **data: Any) -> None:
    log.info(json.dumps({"event": event, **data}, default=str))


class LibraryError(runner.ImportError_):
    """A file that is not a DaVinci library or not the mapping workbook."""


# ------------------------------------------------------------- the library


@dataclass(frozen=True)
class Port:
    protocol: str
    direction: str
    name: str


@dataclass(frozen=True)
class Slot:
    type_id: str
    max_quantity: int
    user_definable: bool
    min_count: int = 0
    """A `SetMinAccessories` rule's minimum for this slot (0 = none)."""


@dataclass(frozen=True)
class Group:
    """A `MaxAccessoryMonitor` rule: between `min_count` and `max_count` of these accessories."""

    label: str
    min_count: int
    max_count: int | None
    type_ids: tuple[str, ...]


@dataclass
class DType:
    type_id: str
    display_name: str
    description: str
    family: str
    category: str
    classification: str
    legacy: bool
    model_pattern: str
    """The generated model with each property placeholder as `{Property name}`."""
    model: str
    """`model_pattern` with the placeholders stripped (then trailing separators), else the name."""
    variants: tuple[str, ...]
    part_numbers: tuple[str, ...]
    ports: tuple[Port, ...]
    slots: tuple[Slot, ...]
    groups: tuple[Group, ...]
    properties: tuple[str, ...]
    datasheet_url: str | None
    is_power_supply: bool = False
    """DaVinci marks it as a power supply (D198): it needs a 120 V feed, and so does its host."""


@dataclass
class Library:
    timestamp: str | None
    types: dict[str, DType]
    order: list[str]
    """Type ids in file order."""


def _by(items: Any, key: str, text: str = "text") -> dict[str, str]:
    out: dict[str, str] = {}
    for it in items or []:
        if isinstance(it, dict) and it.get(key):
            out[str(it[key])] = str(it.get(text) or it.get("constantName") or "")
    return out


def _strip_pattern(pattern: str) -> str:
    """`UH10002-{Heritage Color}` → `UH10002`; `97{Gridiron Box}` → `97`; `{LV}` → ``."""
    bare = re.sub(r"\{[^}]*\}", "", pattern)
    return bare.strip().rstrip("-/ ").strip()


def _rules(text: str | None) -> list[dict[str, Any]]:
    """The `rules[]` of a script's JSON `scriptData` (empty for none or malformed)."""
    if not text or not text.strip():
        return []
    try:
        rules = (json.loads(text) or {}).get("rules") or []
    except ValueError:
        return []
    return [r for r in rules if isinstance(r, dict)]


def read_library(data: bytes, filename: str = "library.json") -> Library:
    """Parse a DaVinci `library.json` (`types[]` resolved through `constants`, `propertyTypes`,
    `scripts` and `documents`). Raises `LibraryError` when it is not one."""
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as e:
        raise LibraryError(f"{filename} is not JSON: {e}") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("types"), list):
        raise LibraryError(f"{filename} is not a DaVinci library (no types[])")
    constants = doc.get("constants") or {}
    if not isinstance(constants, dict) or "portProtocols" not in constants:
        raise LibraryError(f"{filename} is not a DaVinci library (no constants.portProtocols)")
    lookups = {
        "families": _by(constants.get("families"), "familyId"),
        "categories": _by(constants.get("categories"), "categoryId"),
        "protocols": _by(constants.get("portProtocols"), "portProtocolId"),
        "directions": _by(constants.get("portDirections"), "portDirectionId"),
        "classes": _by(constants.get("productClassifications"), "productClassificationId"),
        "doc_types": _by(constants.get("documentTypes"), "documentTypeId"),
        "properties": _by(doc.get("propertyTypes"), "propertyTypeId", "propertyTypeName"),
        "scripts": _by(doc.get("scripts"), "scriptId", "scriptName"),
    }
    documents: dict[str, dict[str, Any]] = {}
    raw_docs = doc.get("documents")
    if isinstance(raw_docs, dict):
        raw_docs = raw_docs.get("documents")
    for d in raw_docs or []:
        if isinstance(d, dict) and d.get("documentId"):
            documents[str(d["documentId"])] = d

    types: dict[str, DType] = {}
    order: list[str] = []
    for raw in doc["types"]:
        if not isinstance(raw, dict) or not raw.get("typeId"):
            continue
        t = _read_type(raw, lookups, documents)
        types[t.type_id] = t
        order.append(t.type_id)
    ts = doc.get("timestamp")
    return Library(timestamp=str(ts) if ts else None, types=types, order=order)


def _read_type(
    raw: dict[str, Any], lk: dict[str, dict[str, str]], documents: dict[str, dict[str, Any]]
) -> DType:
    info = raw.get("typeInformation") or {}
    display_name = str(info.get("displayName") or "").strip()
    items = ((raw.get("modelInformation") or {}).get("generatorData") or {}).get("items") or []
    pieces: list[str] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        if it.get("type") == "string":
            pieces.append(str(it.get("value") or ""))
        else:
            pieces.append("{" + (lk["properties"].get(str(it.get("value"))) or "property") + "}")
    pattern = "".join(pieces).strip()
    model = _strip_pattern(pattern) or display_name
    lookup = ((raw.get("partInformation") or {}).get("generatorData") or {}).get("lookupData") or []
    variants: list[str] = []
    parts: list[str] = []
    for row in lookup:
        if not isinstance(row, dict):
            continue
        m = str(row.get("modelNumber") or "").strip()
        p = str(row.get("partNumber") or "").strip()
        if m and m != model and m not in variants:
            variants.append(m)
        if p and p not in parts:
            parts.append(p)
    ports = tuple(
        Port(
            protocol=lk["protocols"].get(str(p.get("portProtocolId")), "?"),
            direction=lk["directions"].get(str(p.get("portDirectionId")), "?"),
            name=str(p.get("name") or ""),
        )
        for p in raw.get("ports") or []
        if isinstance(p, dict)
    )
    groups: list[Group] = []
    minimums: dict[str, int] = {}
    script_names: set[str] = set()
    for s in raw.get("scripts") or []:
        if not isinstance(s, dict):
            continue
        name = lk["scripts"].get(str(s.get("scriptId")))
        if name:
            script_names.add(name)
        if name == MAX_ACCESSORY_MONITOR:
            for r in _rules(s.get("scriptData")):
                if not r.get("accessoryIds"):
                    continue
                groups.append(
                    Group(
                        label=str(r.get("minValueMessage") or "accessories"),
                        min_count=int(r.get("minCount") or 0),
                        max_count=int(r["maxCount"]) if r.get("maxCount") is not None else None,
                        type_ids=tuple(str(i) for i in r["accessoryIds"]),
                    )
                )
        elif name == SET_MIN_ACCESSORIES:
            for r in _rules(s.get("scriptData")):
                if r.get("accessoryId") and r.get("minCount"):
                    minimums[str(r["accessoryId"])] = int(r["minCount"])
    slots = tuple(
        Slot(
            type_id=str(a["typeId"]),
            max_quantity=int(a.get("maxQuantity") or 1),
            user_definable=a.get("userDefinable") is not False,
            min_count=minimums.get(str(a["typeId"]), 0),
        )
        for a in raw.get("accessories") or []
        if isinstance(a, dict) and a.get("typeId")
    )
    props = tuple(
        lk["properties"][str(p.get("propertyTypeId"))]
        for p in raw.get("propertyTypes") or []
        if isinstance(p, dict) and str(p.get("propertyTypeId")) in lk["properties"]
    )
    datasheets: list[tuple[str, str]] = []
    for did in raw.get("documents") or []:
        d = documents.get(str(did))
        if not d:
            continue
        meta = d.get("metadata") or {}
        if lk["doc_types"].get(str(meta.get("type"))) == DATASHEET and d.get("url"):
            datasheets.append((str(meta.get("name") or ""), str(d["url"])))
    english = [u for n, u in datasheets if "english" in n.lower()]
    datasheet = english[0] if english else (datasheets[0][1] if datasheets else None)
    active = info.get("typeActive") or {}
    description = str(info.get("description") or "").strip()
    category = lk["categories"].get(str(info.get("categoryId")), "")
    text = f"{display_name} {description}"
    is_power_supply = (
        category == POWER_SUPPLY_CATEGORY
        or bool(script_names & POWER_SUPPLY_SCRIPTS)
        or any(POWER_SUPPLY_PROPERTY in p for p in props)
        or (bool(POWER_SUPPLY_NAME.search(text)) and not NOT_A_POWER_SUPPLY.search(text))
    )
    return DType(
        type_id=str(raw["typeId"]),
        display_name=display_name,
        description=description,
        family=lk["families"].get(str(info.get("familyId")), ""),
        category=category,
        classification=lk["classes"].get(str(info.get("productClassificationId")), ""),
        legacy=active.get("legacy") is True,
        model_pattern=pattern,
        model=model,
        variants=tuple(variants),
        part_numbers=tuple(parts),
        ports=ports,
        slots=slots,
        groups=tuple(groups),
        properties=props,
        datasheet_url=datasheet,
        is_power_supply=is_power_supply,
    )


# ------------------------------------------------------------- the mapping

CATEGORIES_TAB = "Categories"
TYPES_TAB = "Types"
OUR_CATEGORY = "Our category"
OVERRIDE = "Override"


@dataclass
class Mapping:
    """Landry's grouping of DaVinci family / category rows into our device categories (D196)."""

    rows: dict[tuple[str, str], str]
    """(DaVinci family, DaVinci category) → our category, or `Ignore`."""
    overrides: dict[tuple[str, str, str], str]
    """(family, category, display name) → our category or `Ignore`, where one type differs."""
    unassigned: list[tuple[str, str]]
    """Category rows with an empty "Our category" (the sheet is incomplete)."""

    @property
    def categories(self) -> set[str]:
        return {v for v in (*self.rows.values(), *self.overrides.values()) if v != IGNORE}

    def category_of(self, t: DType) -> str:
        """Our category for a type, or `Ignore` (also for a family / category pair the sheet
        does not list — a newer library than the sheet)."""
        o = self.overrides.get((t.family, t.category, t.display_name))
        if o:
            return o
        return self.rows.get((t.family, t.category)) or IGNORE


def _cell(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def _header_index(header: list[Any], *names: str) -> int:
    for i, h in enumerate(header):
        cell = _cell(h).lower()
        if any(cell.startswith(n.lower()) for n in names):
            return i
    raise LibraryError(f"the mapping workbook has no column {names[0]!r}")


def read_categories(data: bytes, filename: str = "DaVinci_categories.xlsx") -> Mapping:
    """Read the mapping workbook: the Categories tab's "Our category" per family / category row
    and the Types tab's "Override" per type. Raises `LibraryError` on the wrong file."""
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001 - any openpyxl failure is "not the workbook"
        raise LibraryError(f"{filename} is not a workbook: {e}") from e
    if CATEGORIES_TAB not in wb.sheetnames:
        raise LibraryError(f"{filename} has no {CATEGORIES_TAB!r} tab")
    rows: dict[tuple[str, str], str] = {}
    unassigned: list[tuple[str, str]] = []
    it = wb[CATEGORIES_TAB].iter_rows(values_only=True)
    header = list(next(it, []))
    fam_i = _header_index(header, "DaVinci family")
    cat_i = _header_index(header, "DaVinci category")
    our_i = _header_index(header, OUR_CATEGORY)
    for row in it:
        cells = list(row)
        key = (_cell(cells[fam_i]), _cell(cells[cat_i]))
        if not key[0] and not key[1]:
            continue
        ours = _cell(cells[our_i]) if our_i < len(cells) else ""
        if not ours:
            unassigned.append(key)
            continue
        rows[key] = ours
    overrides: dict[tuple[str, str, str], str] = {}
    if TYPES_TAB in wb.sheetnames:
        it = wb[TYPES_TAB].iter_rows(values_only=True)
        header = list(next(it, []))
        try:
            fam_i = _header_index(header, "DaVinci family")
            cat_i = _header_index(header, "DaVinci category")
            name_i = _header_index(header, "Display name")
            ov_i = _header_index(header, OVERRIDE)
        except LibraryError:
            fam_i = -1
        if fam_i >= 0:
            for row in it:
                cells = list(row)
                ov = _cell(cells[ov_i]) if ov_i < len(cells) else ""
                if ov:
                    key3 = (_cell(cells[fam_i]), _cell(cells[cat_i]), _cell(cells[name_i]))
                    overrides[key3] = ov
    wb.close()
    if not rows and not unassigned:
        raise LibraryError(f"{filename}: the {CATEGORIES_TAB} tab is empty")
    return Mapping(rows=rows, overrides=overrides, unassigned=unassigned)


# ----------------------------------------------------------------- the plan


def model_key(s: str) -> str:
    """How the library matches models and aliases (D183 (4)): spaces and case ignored."""
    return re.sub(r"\s+", "", s).upper()


@dataclass
class TypePlan:
    type_id: str
    payload: dict[str, Any]
    """The `library_type` fields (no id / state / created_by_id)."""
    unmapped: tuple[str, ...]
    """Port protocols with no cable code."""


@dataclass
class Plan:
    types: list[TypePlan] = field(default_factory=list)
    unmapped_protocols: Counter[str] = field(default_factory=Counter)
    not_surveyed_protocols: Counter[str] = field(default_factory=Counter)
    stats: dict[str, Any] = field(default_factory=dict)


def _cable(code: str, single_row: bool, qty: int) -> dict[str, Any]:
    return {
        "code": code,
        "from": None,
        "to": None,
        "far": None,
        "single_row": single_row,
        "qty": qty,
        "status": None,
    }


@dataclass
class Cables:
    rows: list[dict[str, Any]]
    unmapped: list[str]
    """Port protocols nobody has ruled on (no code, not in `NOT_SURVEYED`)."""
    power_supply: dict[str, Any] | None
    """Why the type has a 120V feed: `{self, accessories[]}` (D198), or None."""
    load_outputs: int
    """Power Output ports (load circuits): no cable."""
    not_surveyed: list[str]
    """Port protocols Landry ruled not surveyed (D200): no row."""


def cables_of(t: DType, category: str | None, supplies: list[str] | None = None) -> Cables:
    """The type's default cable rows from its ports — one row per port for X / N / NG / U / F,
    one row with `qty` = port count for P and 0-10V — plus one `120V` feed row when a Power
    input port, the type itself being a power supply, or one of `supplies` (the models of its
    power-supply accessories) asks for it (D198); `qty` = the input-port count, else 1."""
    rows: list[dict[str, Any]] = []
    single: dict[str, int] = {}
    unmapped: list[str] = []
    not_surveyed: list[str] = []
    feeds = 0
    load_outputs = 0
    for p in t.ports:
        if p.protocol == POWER:
            if p.direction in POWER_FEED_DIRECTIONS:
                feeds += 1
            else:
                load_outputs += 1
            continue
        if p.protocol in NOT_SURVEYED:
            if p.protocol not in not_surveyed:
                not_surveyed.append(p.protocol)
            continue
        if p.protocol == ETHERNET:
            code: str | None = "NG" if category in GROUND_CATEGORIES else "N"
        else:
            code = CODE_BY_PROTOCOL.get(p.protocol)
        if code is None:
            if p.protocol not in unmapped:
                unmapped.append(p.protocol)
            continue
        if code in SINGLE_ROW:
            single[code] = single.get(code, 0) + 1
            continue
        rows.append(_cable(code, False, 1))
    power_supply = None
    if t.is_power_supply or supplies:
        power_supply = {"self": t.is_power_supply, "accessories": list(supplies or [])}
    if feeds or power_supply:
        # one 120V row per device: the feed and a Sense wire (also 120V) share it
        single["120V"] = max(single.get("120V", 0), feeds or 1)
    for code, n in single.items():
        rows.append(_cable(code, True, n))
    return Cables(rows, unmapped, power_supply, load_outputs, not_surveyed)


def accessories_of(t: DType, model_of: dict[str, str]) -> list[dict[str, Any]]:
    """The type's accessory slots as `optional_accessories` rows: the accessory's model (as this
    import names it), `max_quantity`, `expected_qty` for a forced or minimum slot, and the
    `MaxAccessoryMonitor` group (`{label, min, max}`) the slot belongs to."""
    group_of: dict[str, Group] = {}
    for g in t.groups:
        for tid in g.type_ids:
            group_of.setdefault(tid, g)
    out: list[dict[str, Any]] = []
    for s in t.slots:
        model = model_of.get(s.type_id)
        if not model:
            continue
        expected: int | None = None
        if not s.user_definable:
            expected = s.max_quantity
        if s.min_count:
            expected = max(expected or 0, s.min_count)
        row: dict[str, Any] = {
            "model": model,
            "expected_qty": expected,
            "max_quantity": s.max_quantity,
        }
        g = group_of.get(s.type_id)
        if g is not None:
            row["group"] = {"label": g.label, "min": g.min_count, "max": g.max_count}
        out.append(row)
    return out


def source_ref_of(t: DType, category: str, timestamp: str | None, filename: str) -> dict[str, Any]:
    ports = Counter((p.protocol, p.direction) for p in t.ports)
    return {
        "kind": DAVINCI_KIND,
        "type_id": t.type_id,
        "display_name": t.display_name,
        "family": t.family,
        "category": t.category,
        "mapped_to": category,
        "classification": t.classification,
        "legacy": t.legacy,
        "model_pattern": t.model_pattern,
        "part_numbers": list(t.part_numbers),
        "ports": [
            {"protocol": pr, "direction": d, "count": n} for (pr, d), n in sorted(ports.items())
        ],
        "library_timestamp": timestamp,
        "file": filename,
    }


def build_plan(
    lib: Library,
    mapping: Mapping,
    *,
    reserved: dict[str, str | None] | None = None,
    filename: str = "library.json",
) -> Plan:
    """What the app library should hold for this file: a `TypePlan` per kept type (the mapping's
    rows, then the accessories they reference), models and aliases unique across the plan and
    `reserved` (model key → the DaVinci type id that holds it, or None for a hand-made type).
    Pure."""
    plan = Plan()
    kept: dict[str, str] = {}  # type_id → our category
    for tid in lib.order:
        t = lib.types[tid]
        cat = mapping.category_of(t)
        if cat != IGNORE:
            kept[tid] = cat
    accessory_only: dict[str, str | None] = {}
    missing_slots = 0
    for tid in kept:
        for s in lib.types[tid].slots:
            if s.type_id in kept or s.type_id in accessory_only:
                continue
            acc = lib.types.get(s.type_id)
            if acc is None:
                missing_slots += 1
                continue
            o = mapping.overrides.get((acc.family, acc.category, acc.display_name))
            accessory_only[s.type_id] = o if o and o != IGNORE else None

    # Names: placeable types first (file order), then the accessories. A model the app library
    # already holds under another type (hand-made, or a different DaVinci type) is a clash: the
    # type is left out and reported, never merged (D197). Within the file, a model already taken
    # falls back to the display name, then to the name with the part number.
    reserved = dict(reserved or {})
    existing = {tid for tid in reserved.values() if tid}  # types that already have a row
    taken: dict[str, str | None] = dict(reserved)
    model_of: dict[str, str] = {}
    aliases_of: dict[str, list[str]] = {}
    renamed: list[dict[str, str]] = []
    clashes: list[dict[str, str | None]] = []
    dropped_aliases = 0

    def free(key: str, tid: str) -> bool:
        return key not in taken or taken[key] == tid

    for tid in [*kept, *accessory_only]:
        t = lib.types[tid]
        key = model_key(t.model)
        if tid not in existing and key in reserved and reserved[key] != tid:
            clashes.append({"type_id": tid, "model": t.model, "held_by": reserved[key]})
            continue
        candidates = [t.model, t.display_name]
        if t.part_numbers:
            candidates.append(f"{t.display_name} ({t.part_numbers[0]})")
        candidates.append(f"{t.display_name} ({tid[:8]})")
        model = next(c for c in candidates if c and free(model_key(c), tid))
        if model != t.model:
            renamed.append({"type_id": tid, "model": t.model, "as": model})
        taken[model_key(model)] = tid
        model_of[tid] = model
    for tid in model_of:
        t = lib.types[tid]
        keys = {model_key(model_of[tid])}
        aliases: list[str] = []
        for a in (t.display_name, *t.part_numbers, *t.variants):
            if not a:
                continue
            k = model_key(a)
            if k in keys:
                continue
            if not free(k, tid):
                dropped_aliases += 1
                continue
            keys.add(k)
            taken[k] = tid
            aliases.append(a)
        aliases_of[tid] = aliases

    by_category: Counter[str] = Counter()
    power_feeds = 0
    load_outputs = 0
    for tid in model_of:
        t = lib.types[tid]
        is_accessory = tid not in kept
        category = accessory_only[tid] if is_accessory else kept[tid]
        supplies = [
            model_of[s.type_id]
            for s in t.slots
            if s.type_id in model_of and lib.types[s.type_id].is_power_supply
        ]
        cables = cables_of(t, category, supplies)
        for u in cables.unmapped:
            plan.unmapped_protocols[u] += 1
        for u in cables.not_surveyed:
            plan.not_surveyed_protocols[u] += 1
        ref = source_ref_of(t, category or IGNORE, lib.timestamp, filename)
        if cables.power_supply:
            ref["power_supply"] = cables.power_supply
            power_feeds += 1
        load_outputs += cables.load_outputs
        payload: dict[str, Any] = {
            "model": model_of[tid],
            "aliases": aliases_of[tid] or None,
            "category": category,
            "default_cables": cables.rows or None,
            "optional_accessories": accessories_of(t, model_of) or None,
            "needs_neuron_id": (
                True if any(p.startswith(NEURON_PROPERTIES) for p in t.properties) else None
            ),
            "description": t.description or None,
            "datasheet_url": t.datasheet_url,
            "source_ref": ref,
            "accessory_only": True if is_accessory else None,
        }
        plan.types.append(TypePlan(type_id=tid, payload=payload, unmapped=tuple(cables.unmapped)))
        if not is_accessory:
            by_category[category or "?"] += 1
    plan.stats = {
        "types_in_file": len(lib.order),
        "placeable": len(kept),
        "accessory_only": len(accessory_only),
        "by_category": dict(sorted(by_category.items())),
        "power_supplies": power_feeds,
        "load_outputs": load_outputs,
        "renamed": renamed,
        "clashes": clashes,
        "aliases_dropped": dropped_aliases,
        "slots_missing_from_file": missing_slots,
        "rows_not_in_mapping": sorted(
            {
                f"{t.family} / {t.category}"
                for t in lib.types.values()
                if (t.family, t.category) not in mapping.rows
                and (t.family, t.category, t.display_name) not in mapping.overrides
            }
        ),
        "rows_unassigned": [f"{f} / {c}" for f, c in mapping.unassigned],
        "unmapped_protocols": dict(plan.unmapped_protocols.most_common()),
        "not_surveyed_protocols": dict(plan.not_surveyed_protocols.most_common()),
    }
    return plan


# -------------------------------------------------------------- the batch


def _entry(batch_id: uuid.UUID, role: str, filename: str, data: bytes) -> dict[str, Any]:
    return {
        "name": filename,
        "role": role,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "key": runner.file_key(batch_id, filename),
    }


def latest_categories(session: Session) -> dict[str, Any] | None:
    """The mapping workbook of the most recent davinci batch that carried one (any project)."""
    rows = session.scalars(
        select(ImportBatch)
        .where(
            ImportBatch.kind == DAVINCI_KIND,
            ImportBatch.job_state.in_(("done", "queued", "running")),
        )
        .order_by(ImportBatch.created_at.desc(), ImportBatch.id.desc())
    )
    for b in rows:
        for f in b.files or []:
            if f.get("role") == "categories" and f.get("key"):
                return {**f, "reused_from": str(b.id)}
    return None


def create_davinci_batch(
    session: Session,
    store: ObjectStore,
    *,
    project_id: uuid.UUID,
    library: tuple[str, bytes],
    categories: tuple[str, bytes] | None,
    user: User | None,
    retire_hand_made: bool = False,
) -> ImportBatch:
    """Store the library (and the mapping workbook, else reuse the last uploaded one) and queue
    the job under `project_id` — the project whose Sources screen started it, which also takes
    the `vocab(cable_code)` drafts. `retire_hand_made` soft-deletes the app library's hand-made
    types first (D199). Commits. Raises `runner.ImportError_` on a bad request."""
    if session.get(Project, project_id) is None:
        raise runner.ImportError_(f"unknown project {project_id}")
    lib_name, lib_data = library
    if not lib_data:
        raise runner.ImportError_("empty file")
    read_library(lib_data, lib_name)  # the whole file, so a wrong upload fails now, not later
    batch_id = uuid7()
    entries = [_entry(batch_id, "library", lib_name or "library.json", lib_data)]
    if retire_hand_made:
        entries[0]["retire_hand_made"] = True
    if categories is not None:
        cat_name, cat_data = categories
        read_categories(cat_data, cat_name)
        entries.append(
            _entry(batch_id, "categories", cat_name or "DaVinci_categories.xlsx", cat_data)
        )
    else:
        reused = latest_categories(session)
        if reused is None:
            raise runner.ImportError_(
                "no category mapping: upload DaVinci_categories.xlsx with the library (once)"
            )
        entries.append(reused)
    store.put_file(entries[0]["key"], io.BytesIO(lib_data), JSON_MIME)
    if categories is not None:
        store.put_file(entries[1]["key"], io.BytesIO(categories[1]), XLSX_MIME)
    batch = ImportBatch(
        id=batch_id,
        project_id=project_id,
        kind=DAVINCI_KIND,
        files=entries,
        job_state="queued",
        stats=None,
        created_by_id=user.id if user else None,
    )
    session.add(batch)
    session.commit()
    _event(
        "import_queued",
        batch=str(batch_id),
        project=str(project_id),
        kind=DAVINCI_KIND,
        file=lib_name,
    )
    return batch


# ---------------------------------------------------------------- the ops


class _Ops:
    """Trusted ops stamped by the requesting user from the server's install (as the riser's)."""

    def __init__(self, stream: uuid.UUID, user_id: uuid.UUID):
        self.stream = stream
        self.user_id = user_id
        self.ts = datetime.now(UTC)
        self.ops: list[OpIn] = []

    def _op(self, **kw: Any) -> OpIn:
        self.ts += timedelta(microseconds=1)
        op = OpIn(
            op_id=uuid7(),
            project_id=self.stream,
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

    def delete(self, entity_kind: str, entity_id: uuid.UUID, base: uuid.UUID | None) -> None:
        op = self._op(entity_kind=entity_kind, entity_id=entity_id, kind="delete", base_op_id=base)
        op.reason = RETIRE_REASON


def _head(session: Session, entity_id: uuid.UUID, field: str) -> uuid.UUID | None:
    return session.scalar(
        select(FieldHead.op_id).where(FieldHead.entity_id == entity_id, FieldHead.field == field)
    )


def _same(a: Any, b: Any) -> bool:
    return json.dumps(jsonable(a), sort_keys=True) == json.dumps(jsonable(b), sort_keys=True)


def _push(session: Session, stream: uuid.UUID, ops: list[OpIn], *, library: bool) -> Push:
    push = Push(session, runner._Body(stream), trusted=True, library=library)
    out = push.run(ops)
    not_applied = [r for r in out.results if r.outcome != "applied"]
    if not_applied:
        raise runner.ImportError_(
            f"{len(not_applied)} ops did not apply: "
            + ", ".join(f"{r.op_id} {r.outcome}" for r in not_applied[:5])
        )
    return push


def import_davinci(session: Session, store: ObjectStore, batch: ImportBatch) -> dict[str, Any]:
    """Apply one queued davinci batch inside the caller's transaction; returns its stats."""
    if batch.kind != DAVINCI_KIND:
        raise runner.ImportError_(f"not a davinci batch: {batch.kind}")
    files = {f.get("role"): f for f in (batch.files or [])}
    lib_entry, cat_entry = files.get("library"), files.get("categories")
    if not lib_entry or not cat_entry:
        raise runner.ImportError_("batch needs a library file and a categories file")
    project = session.get(Project, batch.project_id)
    if project is None:
        raise runner.ImportError_(f"unknown project {batch.project_id}")

    earlier = session.scalars(
        select(ImportBatch).where(
            ImportBatch.kind == DAVINCI_KIND,
            ImportBatch.id != batch.id,
            ImportBatch.job_state == "done",
        )
    ).all()
    pair = {lib_entry.get("sha256"), cat_entry.get("sha256")}
    for b in earlier:
        if {f.get("sha256") for f in (b.files or [])} == pair:
            return {"skipped": "already imported", "earlier_batch": str(b.id)}

    try:
        lib_data = store.read(lib_entry["key"])
        cat_data = store.read(cat_entry["key"])
    except KeyError as e:
        raise runner.ImportError_(f"a file is not in the object store: {e}") from e
    lib_name = lib_entry.get("name") or "library.json"
    lib = read_library(lib_data, lib_name)
    mapping = read_categories(cat_data, cat_entry.get("name") or "DaVinci_categories.xlsx")

    existing = session.scalars(
        select(LibraryType).where(
            LibraryType.project_id.is_(None), LibraryType.deleted_at.is_(None)
        )
    ).all()
    requester = session.get(User, batch.created_by_id) if batch.created_by_id else None
    actor = requester or system_user(session, IMPORT_USER_NAME)
    ops = _Ops(LIBRARY_STREAM, actor.id)
    retired: list[str] = []
    if lib_entry.get("retire_hand_made"):
        # D199: the catalogue covers the hand-made types; soft-delete them (history keeps them,
        # a restore op brings one back) so they neither clash nor stay in the pickers
        for row in existing:
            if (row.source_ref or {}).get("kind") == DAVINCI_KIND:
                continue
            ops.delete("library_type", row.id, _head(session, row.id, "state"))
            retired.append(row.model)
        existing = [r for r in existing if (r.source_ref or {}).get("kind") == DAVINCI_KIND]
    by_type_id: dict[str, LibraryType] = {}
    reserved: dict[str, str | None] = {}
    for row in existing:
        ref = row.source_ref or {}
        tid = (
            str(ref.get("type_id"))
            if ref.get("kind") == DAVINCI_KIND and ref.get("type_id")
            else None
        )
        if tid:
            by_type_id.setdefault(tid, row)
        if row.state == "rejected":
            continue
        for name in (row.model, *(row.aliases or [])):
            if isinstance(name, str) and name:
                reserved.setdefault(model_key(name), tid)

    plan = build_plan(lib, mapping, reserved=reserved, filename=lib_name)

    counts: Counter[str] = Counter()
    for tp in plan.types:
        row = by_type_id.get(tp.type_id)
        if row is None:
            ops.create(
                "library_type",
                {
                    "project_id": None,
                    "id_scheme": None,
                    "optional_cables": None,
                    **tp.payload,
                    "state": "draft",
                    "created_by_id": actor.id,
                },
            )
            counts["created"] += 1
            continue
        if row.state != "draft":
            counts["kept_" + row.state] += 1
            continue
        changed = 0
        for f in UPDATED_FIELDS:
            was = getattr(row, f)
            now = tp.payload.get(f)
            if _same(was, now):
                continue
            ops.set("library_type", row.id, f, was, now, _head(session, row.id, f))
            changed += 1
        counts["updated" if changed else "unchanged"] += 1
        counts["fields_set"] += changed
    push = _push(session, LIBRARY_STREAM, ops.ops, library=True) if ops.ops else None

    # Unmapped port protocols: `vocab(cable_code)` drafts in the uploading project (D197).
    have = {
        v.value.lower()
        for v in session.scalars(
            select(Vocab).where(
                Vocab.project_id == project.id,
                Vocab.list == CABLE_CODE_LIST,
                Vocab.deleted_at.is_(None),
            )
        )
    }
    vocab_ops = _Ops(project.id, actor.id)
    for name in plan.unmapped_protocols:
        if name.lower() in have:
            continue
        vocab_ops.create(
            "vocab",
            {"project_id": project.id, "list": CABLE_CODE_LIST, "value": name, "state": "draft"},
        )
    vpush = _push(session, project.id, vocab_ops.ops, library=False) if vocab_ops.ops else None

    stats = {
        "file": lib_name,
        "library_timestamp": lib.timestamp,
        "categories_file": cat_entry.get("name"),
        "categories_reused_from": cat_entry.get("reused_from"),
        **plan.stats,
        "created": counts["created"],
        "updated": counts["updated"],
        "unchanged": counts["unchanged"],
        "fields_set": counts["fields_set"],
        "kept_accepted": counts["kept_accepted"],
        "kept_rejected": counts["kept_rejected"],
        "retired": retired,
        "vocab_drafts": len(vocab_ops.ops),
        "ops": len(ops.ops) + len(vocab_ops.ops),
        "last_library_seq": push.seq if push else None,
        "last_server_seq": vpush.seq if vpush else None,
    }
    _event(
        "davinci_applied",
        batch=str(batch.id),
        project=str(project.id),
        **{k: v for k, v in stats.items() if k not in ("renamed", "clashes", "by_category")},
    )
    return stats


def run_queued(
    session_factory: runner.SessionFactory, store: ObjectStore, limit: int = 1
) -> list[str]:
    return runner.run_queued(
        session_factory, store, limit, kinds=(DAVINCI_KIND,), job=import_davinci
    )


# ------------------------------------------------------------------- CLI


def _basename(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1]


def main(argv: list[str] | None = None) -> int:
    from app.db import SessionLocal
    from app.storage import get_object_store

    parser = argparse.ArgumentParser(prog="python -m app.jobs.davinci_library")
    parser.add_argument("library", help="path to DaVinci's library.json")
    parser.add_argument(
        "--project",
        type=uuid.UUID,
        required=True,
        help="the project the batch is filed under (its vocabulary takes the unmapped protocols)",
    )
    parser.add_argument(
        "--categories",
        default=None,
        help="path to DaVinci_categories.xlsx (else the last uploaded)",
    )
    parser.add_argument("--user", default=None, help="team name to record as the importer")
    parser.add_argument(
        "--retire-hand-made",
        action="store_true",
        help="soft-delete the app library's hand-made types first (D199)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with open(args.library, "rb") as f:
        lib_data = f.read()
    categories = None
    if args.categories:
        with open(args.categories, "rb") as f:
            categories = (_basename(args.categories), f.read())
    store = get_object_store()
    with SessionLocal() as s:
        user = upsert_user(s, args.user) if args.user else None
        try:
            batch = create_davinci_batch(
                s,
                store,
                project_id=args.project,
                library=(_basename(args.library), lib_data),
                categories=categories,
                user=user,
                retire_hand_made=args.retire_hand_made,
            )
        except runner.ImportError_ as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
    state = runner.run_batch(SessionLocal, store, batch.id, job=import_davinci)
    with SessionLocal() as s:
        print(json.dumps(runner.batch_out(s.get(ImportBatch, batch.id)), indent=2, default=str))
    return 0 if state in ("done", "skipped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
