"""Riser extraction (T43, PLAN §7.3, D6, D10, D21, D28): the riser PDF → level bands → device
symbols and wire bubbles → `draft_device` / `draft_cable` proposals, with the band crops and
prompts the Claude API answers for endpoints.

Pure functions over PDF bytes and a `Target` (the project's levels, placeholders and BOM drafts) —
no database, no object store, no network — so the whole pass runs on `fixtures/riser.pdf` in
tests. `app.jobs.riser` wires it to the batch, the Claude client and the apply loop.

What the drawing is (Phase 1f §1, §3): one column of level bands per sheet (two columns on sheet
002), separated by long horizontal rules, the level label (`LEVEL 03`) printed above each rule.
A band shows the level's relay panels (`CT03LCPB` + `ECHO ERP-FT-241P` + option-card lines),
Foundry panels (`UFMP4/8`), `EBDK`, NSPS enclosures (`n - P-NSPS-DIN`), the equipment rack with
its output stack, and the station / sensor chain (`PARADIGM PI1002` … with a `QTY: nn` callout
under each symbol). Wires are **stadium bubbles** with a letter: the wire identification code
(`X` DMX, `N` network, `NG` network + ground, `U` Unison, `F` fibre, `P` panic, `UV` partition
sensor) — never a quantity. A bubble is drawn as ~50 tiny curve fragments around a lone code
token, which is how a bubble is told from the `WHT / F` finish labels under every station.

Sheet 001 has a text layer; sheet 002 does not (its drawing is outlined into curves), so its
bands go to the Claude API as images and the model reads devices, bubbles and endpoints.

Deterministic first (zero cost, reproducible, `source_ref` on everything): separators are found
on a raster row profile (both sheets), devices by tag and the `QTY:` nearest by centre-x, bubbles
by geometry, rack output labels by adjacency. Then one Claude call per band (the band crop at
≤ 2000 px plus a column overview with the band outlined) resolves the endpoints the geometry
cannot: runs route through vertical trunk lines between bands. Unison `U` bubbles are chain links
between device types, not runs (Phase 1f §4): they are counted, never proposed — the library
makes the Unison bus rows (R2e).
"""

from __future__ import annotations

import io
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

from app import roles
from app.ids import uuid7
from app.jobs import bom_extract as bx

# ----------------------------------------------------------------- constants

RASTER_SCALE = 2.0
"""Pixels per point for the separator profile (a 0-width rule is one dark pixel at 144 dpi)."""

SEPARATOR_MIN_PT = 250.0
"""A dark run at least this long on one pixel row is a separator (a band's bottom rule)."""

SEPARATOR_DARK = 160
"""Gray level under which a pixel is ink."""

COLUMN_TOLERANCE_PT = 20.0
"""Separators whose x-extents agree within this form one column of bands."""

MIN_SEPARATORS = 2
"""A column needs at least this many rules; a lone long line is a connector, not a rule."""

BAND_BLANK_PT = 20.0
"""The first band of a column starts under a blank run this tall above its first content."""

BAND_MAX_PT = 450.0
"""A first band is never taller than this (the column's top rule is the page edge otherwise)."""

CROP_MAX_PX = 2000
"""Longest edge of a band crop sent to the Claude API (Phase 1f §5: ≤ 2000 px per image)."""

OVERVIEW_MAX_PX = 1800
"""Height of the column overview that shows the trunk lines leaving the band."""

CROP_PAD_PT = 24.0
"""Context around a band crop (labels at trunk ends sit just outside the rules)."""

BUBBLE_MIN_FRAGMENTS = 30
"""Curve fragments within `BUBBLE_REACH_PT` of a code token for it to be a bubble (real bubbles
carry 52–146; the station finish labels and symbol lettering 0–15)."""

BUBBLE_REACH_PT = 10.0
BUBBLE_FRAGMENT_MAX_PT = 25.0

CODES = ("X", "N", "NG", "U", "F", "P", "UV")
RUN_CODES = ("X", "N", "NG", "F", "P", "UV")
"""Bubble codes that are cable runs; `U` is a chain link (see the module docstring)."""

GUESS_CODES = ("X", "N", "NG", "U", "F", "P", "UV", "0-10V", "120V")
"""What a line with no bubble may be guessed as: every cable code (CLAUDE.md §3), D192."""

LINE_TOUCH_PT = 2.0
"""Segment ends this close join one line; a line end this close to a symbol box touches it."""

LINE_MIN_PT = 8.0
"""A line shorter than this in total (symbol detail, arrowhead slivers) is not a connection."""

LINE_LABEL_PT = 24.0
"""Text this close to a line's free end is what the line is labelled (`TO LOAD CKTS`)."""

LINE_TRUNK_SHARE = 0.6
"""A vertical segment longer than this share of the band's height is a trunk between bands."""

SYMBOL_MIN_PT = 20.0
"""The smallest box drawn round a device symbol."""

TRACE_CONFIDENCE = 0.9
"""Endpoints read by tracing a bubble's line to the device box it reaches (T107): geometry, as
certain as a printed label."""

TRACE_BESIDE_PT = 40.0
"""A traced line that stops this close to a device names it in the prompt's hint (a bubble the
PDF draws with no vector ink — CT02LCPB's — breaks the line there)."""

UNISON_ROLES = ("station", "sensor", "touchscreen")
"""Symbols drawn with no outline that a bubble's stub never lands in (their label boxes overlap
the trunks beside them)."""

LABEL_GUESS_CONFIDENCE = 0.5
"""A code guessed from the line's printed text alone (`0-10V CONTROL`, `120V`), no model."""

LABEL_GUESSES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"0-10V"), "0-10V"),
    (re.compile(r"\b120V\b|\b1[02]0-277V\b"), "120V"),
]

GUESS_PLACEHOLDERS: dict[str, tuple[str, str]] = {
    "0-10V": ("Fixtures", "fixtures"),
    "120V": ("120v Power", "power"),
}
"""The library's far end for a guessed code (R2c / R2d, D52): offered as the To candidate so an
accepted line meets the library's row for the same device (D194)."""

LOAD_LABEL_RE = re.compile(r"^(?:TO\s+)?LOAD(?:\s+(?:CKTS?|CIRCUITS?))?$")
"""A line's text naming its panel's load circuits — the relay panels' `TO LOAD CKTS`, the
Foundry panels' `TO LOAD`: that panel's 120V load wiring to the fixtures (D221)."""

LOAD_GUESS = "120V"
LOAD_PLACEHOLDER = ("Fixtures", "fixtures")
"""A load-circuit line's guess and its far end (D221), whatever the model guessed."""

ROW_GAP_PT = 2.5
RUN_GAP_PT = 14.0
"""Tokens further apart than this on one row are separate labels."""

LEVEL_LABEL_MIN_SIZE = 10.0
"""The `LEVEL nn` label's font size; the same words appear at 2.6–5.3 pt in notes."""

PANEL_RE = re.compile(r"^CT[A-Z0-9]{2}LCP[AB]$")
PANEL_MODEL_RE = re.compile(r"^(?:ERP-FT-\d{3}P|UFMP\d)$")
ACCESSORY_LINE_RE = re.compile(r"(?<![\w-])(\d+) - ([A-Z][-A-Z0-9/]+(?:\s[A-Z]{2,4})?)")
"""`2 - ERP-FT-LVD`: a count, a spaced hyphen, a model (never the `4-RM` inside `ERn4-RM`)."""
QTY_RE = re.compile(r"^QTY:?$")
MODEL_WORD_RE = re.compile(r"^[A-Z]{1,4}(?:-[A-Z0-9]+)+$|^[A-Z]+\d[-A-Z0-9]*$")
"""`P-DOC-C-LR`, `P-LS`, `UHCI-WM`, `P-TS7-E`, `PI1002`, `UFMP8`, `ERP-FT-241P`."""
LEVEL_RE = re.compile(r"\bLEVEL\s+([A-Z]?\d{1,2}M?)\b")
RACK_LABEL_RE = re.compile(r"^EQUIPMENT RACK")
OPTION_CARD_RE = re.compile(r"^ERP-(?:FT-LVD|RTO)$")
"""The ERP option cards the riser lists per panel — the only accessories it can count."""
OUTPUT_LABEL_RE = re.compile(r"^(?:TO |DMX|SPARE|FIBER|FIBRE|NET)")
"""How the rack's output stack labels its runs (`DMX TO …`, `SPARE DMX OUT`, `TO ERn4 LEVEL 16`)."""
RACK_COMPONENT_WORDS = ("PATCH PANEL", "NETWORK SWITCH", "UNINTERRUPTIBLE", "MOSAIC", "BRUSH PANEL")

TEXT_CONFIDENCE = 0.9
"""A device read from the text layer (one symbol, one count; the BOM's 0.95 is a typed table)."""

LABEL_CONFIDENCE = 0.9
"""A rack output run whose far end is printed beside its bubble."""

MODEL_CONFIDENCE_CAP = 0.85
"""Nothing the model alone proposed is bulk-acceptable at ≥ 0.9 (prompt Must: review ≥ 0.9)."""

LOW_CONFIDENCE = 0.7
"""Below this a draft is flagged for Needs review (D11)."""

RISER_MODEL_MAP: dict[str, str] = {
    "ERP-FT-241P": "ERP24-FT-241P",
    "ERP-FT-481P": "ERP48-FT-481P",
    "ERN4-RM": "ERN4-RM-120",
    "ERN4": "ERN4-RM-120",
    "P-NSPS-DIN": "P-NSPS-D",
}
"""The riser's spelling → the BOM's model (the project `model_map` applies after)."""

RACK_NAME = "Equipment Rack 18U"
"""The master's Device text for the rack (PLAN §2.2 `device.Device`)."""

RACK_OUTPUT_LABELS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"^SPARE DMX OUT$"), "Spare DMX out", "spare"),
    (re.compile(r"^TO WALTER TOWER ETC P-CCS$"), "Walter Tower ETC P-CCS", "external"),
]
"""Rack output labels with a fixed placeholder (PLAN §7.5 seed list)."""

FIXTURE_RUN_RE = re.compile(r"^DMX(?:/KINET)?\s+TO\s+(?P<name>.+)$")
TO_LEVEL_RE = re.compile(
    r"^TO\s+(?P<what>EQUIP(?:MENT)? RACK|ERN4|RELAY PANEL|UNISON STATIONS|P-NSPS-DIN|NSPS)"
    r"\s+LEVEL\s+(?P<level>[A-Z]?\d{1,2}M?)$"
)

SCHEMA_PATH = Path(__file__).with_name("riser_endpoints.schema.json")
SCHEMA: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

SYSTEM_PROMPT = """You read ETC lighting-control riser diagrams for a field-survey app.

A riser sheet is a column of horizontal bands, one per building level; the level's label (LEVEL
03, LEVEL B2) is printed at the lower right of its band, just above the rule that closes it. A
band shows that level's devices as boxed symbols: Echo relay panels tagged CTxxLCPA / CTxxLCPB
with their model (ECHO ERP-FT-241P = 24 relays, ERP-FT-481P = 48) and option-card lines (2 -
ERP-FT-LVD, 1 - ERP-RTO); Foundry panels (FOUNDRY UFMP4 / UFMP8, sometimes also tagged
CTxxLCPA); EBDK emergency bypass kits; NSPS station power supplies (n - P-NSPS-DIN in a DIN14
enclosure, or PARADIGM P-NSPS-DIN W/ENCLOSURE); an EQUIPMENT RACK - 18U with its output stack;
and the Paradigm station and sensor chain (PARADIGM PI1002 / PI1004 / PI1104 stations, P-DOC-C-
LR / P-LS / P-DOC-SM2 sensors, P-TS7-E touchscreen, UNISON UHCI-WM partition sensor) with a QTY:
nn callout under each symbol.

Wires are drawn as small stadium-shaped bubbles with one letter, the wire identification code: X
= DMX, N = network (ETCNet), NG = network with ground, F = fibre, P = panic, UV = partition-
sensor wire, U = Unison. The letter is never a quantity. A bubble sits on the line of the device
the wire starts at. Lines that leave a band vertically are trunk lines to another level; the
overview image shows the whole column so you can follow them, and labels such as TO EQUIP RACK
LEVEL 06 or TO ERn4 LEVEL 16 name the far end outright. The rack's output stack lists its DMX
outputs (DMX TO B3A CANYON), spares (SPARE DMX OUT) and fibre / network runs to other racks.

Classify every device by its role: relay_panel (an Echo relay panel, ERP…), foundry_panel
(UFMPn), ebdk, equipment_rack (the rack, or an ERn4 enclosure), nsps (a P-NSPS power supply or
its DIN enclosure), touchscreen (P-TS…, P-LCD…), station (PI…, EPS…), sensor (P-DOC…, P-LS,
UHCI-WM) or other.

U bubbles are chain links between the device types of one level's Unison bus, not runs: never
list them as cables.

Some lines connect to a device with no bubble at all: the last Unison link into an NSPS
enclosure or the rack, a trunk whose only mark is a label at its end (TO RELAY PANEL LEVEL 20,
TO UNISON STATIONS LEVEL 24), a line that just leaves the band, and the feed and note arrows
(TO LOAD CKTS, the (2)#16 AWG ... TO 0-10V CONTROL leader, the 120V feed arrows under panels and
NSPS enclosures, the EBDK sense feed). List each as an unlabelled line with your best guess at
its code (0-10V for control leaders, 120V for power feeds, U for a Unison link, X / N / F for a
data trunk) or null when you cannot tell; a reviewer decides what it is.

Answer only in the JSON schema you were given; coordinates are pixels of the band image;
confidence is your own estimate from 0 to 1, below 0.7 when you are guessing."""

# ------------------------------------------------------------------- types


@dataclass(frozen=True)
class Tok:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    size: float

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass(frozen=True)
class Separator:
    y: float
    x0: float
    x1: float


@dataclass
class Band:
    page: int  # 1-based
    column: int
    index: int  # 0 = top band of the column
    top: float
    bottom: float
    x0: float
    x1: float
    level_code: str | None = None
    level_source: str | None = None  # text | interpolated | model

    @property
    def key(self) -> str:
        return f"p{self.page}c{self.column}b{self.index}"

    def contains(self, t: Tok) -> bool:
        return self.top <= t.cy <= self.bottom and self.x0 - 5 <= t.cx <= self.x1 + 5

    def bbox(self) -> list[float]:
        return [
            round(self.x0, 1),
            round(self.top, 1),
            round(self.x1 - self.x0, 1),
            round(self.bottom - self.top, 1),
        ]


@dataclass
class Device:
    id: str  # short id within the band (d1, d2…), the prompt's handle
    band: Band
    role: str  # relay_panel … other (D201, T115)
    category: str | None  # the D196 category the draft carries
    model: str
    model_raw: str
    name: str | None
    qty: int
    qty_source: str  # qty | one | model
    accessories: list[dict[str, Any]]
    bbox: list[float]  # [x, y, w, h] page points
    label: str
    extraction: str  # text | model
    confidence: float
    draft_id: Any = None  # the draft_device id once build() has placed it
    bom_ids: list[Any] = field(default_factory=list)

    @property
    def cx(self) -> float:
        return self.bbox[0] + self.bbox[2] / 2

    @property
    def cy(self) -> float:
        return self.bbox[1] + self.bbox[3] / 2


@dataclass
class Bubble:
    id: str
    band: Band
    code: str
    bbox: list[float]  # page points
    fragments: int
    extraction: str  # text | model
    output_label: str | None = None  # the rack output label printed beside it
    # endpoints (deterministic from the label, else the model's answer)
    from_device: str | None = None
    from_label: str | None = None
    to_device: str | None = None
    to_label: str | None = None
    to_level_code: str | None = None
    confidence: float = 0.0
    endpoint_source: str | None = None  # label | trace | model | none
    note: str | None = None
    to_ref: Device | None = None  # a traced far end on another band (T107)
    via: list[str] = field(default_factory=list)  # bubbles the trace passed through
    twin: Bubble | None = None  # the bubble at the run's other end, folded into this one
    merged_into: str | None = None  # this bubble is the other end of that bubble's run
    trace_hint: str | None = None  # what an inconclusive trace reached, for the prompt


@dataclass
class Line:
    """A connecting line with no wire bubble (D192): the last Unison link into an enclosure, a
    trunk marked only by a label at its end, a feed or note arrow. Its code is unknown; the
    reviewer says what it is."""

    id: str
    band: Band
    bbox: list[float]  # page points, grown so a straight line has an area
    extraction: str  # text (geometry) | model
    label: str | None = None  # the text printed at its free end
    leaves_band: bool = False  # reaches a trunk or the band's edge
    from_device: str | None = None
    from_label: str | None = None
    to_device: str | None = None
    to_label: str | None = None
    to_level_code: str | None = None
    guess: str | None = None  # a code from GUESS_CODES, never written as the code
    guess_confidence: float = 0.0
    guess_source: str | None = None  # label | model
    guess_reason: str | None = None  # load: a load-circuit label, 120V to Fixtures (D221)
    confidence: float = 0.0
    endpoint_source: str | None = None  # geometry | model
    note: str | None = None
    code: str | None = None  # always None; lets `_Build.cable` read a line as a bubble
    output_label: str | None = None


@dataclass
class Sheet:
    page: int
    drawing: str  # "001", "002" (the title block's DRAWING number), else the page number
    width: float
    height: float
    has_text: bool
    bands: list[Band]
    devices: list[Device]
    bubbles: list[Bubble]
    unison_links: int
    columns: int
    lines: list[Line] = field(default_factory=list)

    def band_devices(self, band: Band) -> list[Device]:
        return [d for d in self.devices if d.band is band]

    def band_bubbles(self, band: Band) -> list[Bubble]:
        return [b for b in self.bubbles if b.band is band]

    def band_lines(self, band: Band) -> list[Line]:
        return [ln for ln in self.lines if ln.band is band]


@dataclass
class Riser:
    sheets: list[Sheet]

    @property
    def bands(self) -> list[Band]:
        return [b for s in self.sheets for b in s.bands]

    def levels(self) -> list[str]:
        return [b.level_code for b in self.bands if b.level_code]

    def stats(self) -> dict[str, Any]:
        return {
            "sheets": [
                {
                    "page": s.page,
                    "drawing": s.drawing,
                    "text": s.has_text,
                    "columns": s.columns,
                    "bands": [
                        {"level": b.level_code, "source": b.level_source, "bbox": b.bbox()}
                        for b in s.bands
                    ],
                    "devices": len(s.devices),
                    "bubbles": len(s.bubbles),
                    "unison_links": s.unison_links,
                    "unlabelled_lines": len(s.lines),
                    "traced": sum(1 for b in s.bubbles if b.endpoint_source == "trace"),
                    "twins": sum(1 for b in s.bubbles if b.merged_into),
                }
                for s in self.sheets
            ]
        }


# ----------------------------------------------------------------- the PDF


def page_count(pdf_bytes: bytes) -> int:
    return bx.page_count(pdf_bytes)


def render(
    pdf_bytes: bytes,
    page_index: int,
    scale: float,
    crop_pt: tuple[float, float, float, float] | None = None,
) -> Image.Image:
    """The page (or `crop_pt` = (x0, top, x1, bottom) in points, top-left origin) as RGB."""
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        try:
            if crop_pt is None:
                return page.render(scale=scale).to_pil().convert("RGB")
            w, h = page.get_size()
            x0, top, x1, bottom = crop_pt
            x0, top = max(0.0, x0), max(0.0, top)
            x1, bottom = min(w, x1), min(h, bottom)
            # pdfium crops are (left, bottom, right, top) margins from the page edges
            return (
                page.render(scale=scale, crop=(x0, h - bottom, w - x1, top)).to_pil().convert("RGB")
            )
        finally:
            page.close()
    finally:
        doc.close()


def page_size(pdf_bytes: bytes, page_index: int) -> tuple[float, float]:
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        try:
            return page.get_size()
        finally:
            page.close()
    finally:
        doc.close()


def words_of(pdf_bytes: bytes, page_index: int) -> list[Tok]:
    """Text-layer words with font size (a size change splits a word: the outlined `LEVEL 03`
    never merges with a note, the big labels keep their size)."""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[page_index]
        words = page.extract_words(x_tolerance=1.5, y_tolerance=2, extra_attrs=["size"])
    return [
        Tok(
            w["text"],
            float(w["x0"]),
            float(w["top"]),
            float(w["x1"]),
            float(w["bottom"]),
            float(w["size"]),
        )
        for w in words
        if w["text"].strip()
    ]


def small_curves(pdf_bytes: bytes, page_index: int) -> list[tuple[float, float, float, float]]:
    """Bubble fragments: curve boxes no larger than `BUBBLE_FRAGMENT_MAX_PT`."""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[page_index]
        out = []
        for c in page.curves:
            w, h = c["x1"] - c["x0"], c["bottom"] - c["top"]
            if w <= BUBBLE_FRAGMENT_MAX_PT and h <= BUBBLE_FRAGMENT_MAX_PT:
                out.append((float(c["x0"]), float(c["top"]), float(c["x1"]), float(c["bottom"])))
    return out


Seg = tuple[tuple[float, float], tuple[float, float]]


def segments_of(pdf_bytes: bytes, page_index: int) -> list[Seg]:
    """Every straight piece of vector ink: lines, rectangle edges and each step of a curve's
    point list (the riser draws connectors both ways). Top-left origin, points."""
    out: list[Seg] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[page_index]
        for ln in page.lines:
            out.append(
                ((float(ln["x0"]), float(ln["top"])), (float(ln["x1"]), float(ln["bottom"])))
            )
        for c in page.curves + page.rects:
            pts = c.get("pts") or [
                (c["x0"], c["top"]),
                (c["x1"], c["top"]),
                (c["x1"], c["bottom"]),
                (c["x0"], c["bottom"]),
                (c["x0"], c["top"]),
            ]
            ps = [(float(x), float(y)) for x, y in pts]
            out.extend(zip(ps, ps[1:], strict=False))
    return [(a, b) for a, b in out if abs(a[0] - b[0]) + abs(a[1] - b[1]) > 0.3]


def drawing_number(words: list[Tok]) -> str | None:
    """The title block's DRAWING: number (`001`), the large digits under the word."""
    for w in words:
        if w.text.upper().startswith("DRAWING"):
            below = [
                t
                for t in words
                if t.text.isdigit()
                and t.size >= 10
                and 0 < t.top - w.bottom < 60
                and abs(t.cx - w.cx) < 120
            ]
            if below:
                return below[0].text
    return None


# ------------------------------------------------------------------ bands


def separators(image: Image.Image, scale: float, title_block_x: float | None) -> list[Separator]:
    """Dark pixel runs at least `SEPARATOR_MIN_PT` long on one row, left of the title block.
    Consecutive rows of one rule (a 2-px line) collapse into one separator."""
    gray = image.convert("L")
    binary = gray.point(lambda v: 255 if v < SEPARATOR_DARK else 0, mode="L")
    px = binary.load()
    width, height = binary.size
    limit_px = SEPARATOR_MIN_PT * scale
    # the title block's own rules start a little left of its DRAWING: word
    right_px = ((title_block_x - 40) * scale) if title_block_x else width
    found: list[Separator] = []
    for y in range(height):
        x = 0
        while x < width:
            if px[x, y]:
                x0 = x
                while x < width and px[x, y]:
                    x += 1
                if x - x0 >= limit_px and x0 < right_px:
                    found.append(Separator(y / scale, x0 / scale, x / scale))
            else:
                x += 1
    merged: list[Separator] = []
    for s in found:
        if merged and abs(merged[-1].y - s.y) <= 1.5 and abs(merged[-1].x0 - s.x0) < 10:
            continue
        merged.append(s)
    return merged


def columns_of(seps: list[Separator], page_height: float) -> list[list[Separator]]:
    """Separators grouped by x-extent (one group per column of bands), page frame lines and
    lone connectors dropped."""
    groups: list[list[Separator]] = []
    last: Separator | None = None
    for s in sorted(seps, key=lambda s: s.y):
        if s.y < 30 or s.y > page_height - 30:
            continue  # the sheet frame
        if last is not None and s.y - last.y < 10 and abs(s.x0 - last.x0) < 10:
            continue  # a double rule (the legend box)
        last = s
        for g in groups:
            if (
                abs(g[0].x0 - s.x0) <= COLUMN_TOLERANCE_PT
                and abs(g[0].x1 - s.x1) <= COLUMN_TOLERANCE_PT * 5
            ):
                g.append(s)
                break
        else:
            groups.append([s])
    keep = [g for g in groups if len(g) >= MIN_SEPARATORS]
    keep.sort(key=lambda g: g[0].x0)
    return keep


def _first_band_top(image: Image.Image, scale: float, x0: float, x1: float, bottom: float) -> float:
    """Scan upward from the column's first rule for a blank run `BAND_BLANK_PT` tall."""
    gray = image.convert("L")
    width, height = gray.size
    cx0, cx1 = max(0, int(x0 * scale)), min(width, int(x1 * scale))
    strip = gray.crop((cx0, 0, cx1, height)).point(
        lambda v: 255 if v < SEPARATOR_DARK else 0, mode="L"
    )
    column = strip.resize((1, height), Image.Resampling.BOX)
    dark = list(column.get_flattened_data())
    y = int(bottom * scale) - 3
    blank = 0
    floor = max(0, int((bottom - BAND_MAX_PT) * scale))
    while y > floor:
        if dark[y] == 0:
            blank += 1
            if blank >= BAND_BLANK_PT * scale:
                return (y + blank) / scale
        else:
            blank = 0
        y -= 1
    return max(0.0, bottom - BAND_MAX_PT)


def bands_of(
    image: Image.Image, scale: float, page: int, page_height: float, title_block_x: float | None
) -> tuple[list[Band], int]:
    seps = separators(image, scale, title_block_x)
    cols = columns_of(seps, page_height)
    bands: list[Band] = []
    for ci, col in enumerate(cols):
        x0 = min(s.x0 for s in col)
        x1 = max(s.x1 for s in col)
        prev_y: float | None = None
        for i, s in enumerate(col):
            top = prev_y if prev_y is not None else _first_band_top(image, scale, x0, x1, s.y)
            bands.append(Band(page=page, column=ci, index=i, top=top, bottom=s.y, x0=x0, x1=x1))
            prev_y = s.y
    return bands, len(cols)


def label_levels(bands: list[Band], words: list[Tok]) -> None:
    """`LEVEL nn` at label size inside a band names it; a band with no label between two
    numbered neighbours two apart is the level between (sheet 001's outlined `LEVEL 03`)."""
    big = [w for w in words if w.size >= LEVEL_LABEL_MIN_SIZE]
    for b in bands:
        for w in big:
            if w.text.upper() == "LEVEL" and b.contains(w):
                code = next(
                    (
                        t
                        for t in big
                        if t is not w and abs(t.cy - w.cy) < 6 and 0 < t.x0 - w.x1 < 30
                    ),
                    None,
                )
                if code is not None:
                    b.level_code = bx.norm_level(code.text)
                    b.level_source = "text"
                    break
    _interpolate(bands)


def _interpolate(bands: list[Band]) -> None:
    by_col: dict[tuple[int, int], list[Band]] = defaultdict(list)
    for b in bands:
        by_col[(b.page, b.column)].append(b)
    for col in by_col.values():
        col.sort(key=lambda b: b.index)
        for i, b in enumerate(col):
            if b.level_code is not None or i == 0 or i == len(col) - 1:
                continue
            above, below = col[i - 1].level_code, col[i + 1].level_code
            if (
                above
                and below
                and above.isdigit()
                and below.isdigit()
                and int(above) - int(below) == 2
            ):
                b.level_code = f"{int(above) - 1:02d}"
                b.level_source = "interpolated"


# ----------------------------------------------------------------- devices


def rows_of(toks: list[Tok]) -> list[list[Tok]]:
    rows: list[list[Tok]] = []
    for t in sorted(toks, key=lambda t: (t.top, t.x0)):
        if rows and abs(rows[-1][0].cy - t.cy) <= ROW_GAP_PT:
            rows[-1].append(t)
        else:
            rows.append([t])
    for r in rows:
        r.sort(key=lambda t: t.x0)
    return rows


def runs_of(row: list[Tok]) -> list[list[Tok]]:
    """A row split where the gap between tokens exceeds `RUN_GAP_PT`: one label per run."""
    runs: list[list[Tok]] = []
    for t in row:
        if runs and t.x0 - runs[-1][-1].x1 <= RUN_GAP_PT:
            runs[-1].append(t)
        else:
            runs.append([t])
    return runs


def _text(toks: list[Tok]) -> str:
    return " ".join(t.text for t in toks)


def _bbox(toks: list[Tok]) -> list[float]:
    x0 = min(t.x0 for t in toks)
    y0 = min(t.top for t in toks)
    return [
        round(x0, 1),
        round(y0, 1),
        round(max(t.x1 for t in toks) - x0, 1),
        round(max(t.bottom for t in toks) - y0, 1),
    ]


def _grow(box: list[float], dx: float, dy: float) -> list[float]:
    return [
        round(box[0] - dx, 1),
        round(box[1] - dy, 1),
        round(box[2] + 2 * dx, 1),
        round(box[3] + 2 * dy, 1),
    ]


def riser_model(raw: str) -> str:
    return RISER_MODEL_MAP.get(raw.upper(), raw)


class _Groups:
    """The symbol labels of one band, before the `QTY:` callouts are matched."""

    def __init__(self, band: Band):
        self.band = band
        self.devices: list[Device] = []
        self.claimed: set[int] = set()
        self.n = 0

    def add(
        self,
        *,
        role: str,
        model_raw: str,
        name: str | None,
        qty: int | None,
        label: str,
        bbox: list[float],
        accessories: list[dict[str, Any]] | None = None,
    ) -> Device:
        self.n += 1
        d = Device(
            id=f"d{self.n}",
            band=self.band,
            role=role,
            category=roles.ROLE_CATEGORY.get(role),
            model=riser_model(model_raw),
            model_raw=model_raw,
            name=name,
            qty=qty if qty is not None else 1,
            qty_source="qty" if qty is not None else "one",
            accessories=accessories or [],
            bbox=bbox,
            label=label,
            extraction="text",
            confidence=TEXT_CONFIDENCE,
        )
        self.devices.append(d)
        return d


def devices_of(band: Band, words: list[Tok]) -> list[Device]:
    toks = [t for t in words if band.contains(t)]
    rows = rows_of(toks)
    runs = [r for row in rows for r in runs_of(row)]
    g = _Groups(band)
    claimed: set[int] = set()  # id() of tokens explained by a tag

    def below(tok: Tok, dy: float, dx: float) -> list[list[Tok]]:
        return [
            r
            for r in runs
            if 0 < r[0].top - tok.bottom <= dy and abs((r[0].x0 + r[-1].x1) / 2 - tok.cx) <= dx
        ]

    # panels by tag: CT03LCPB + the model under it + option cards
    for t in toks:
        if not PANEL_RE.match(t.text):
            continue
        model_tok = next(
            (m for r in below(t, 14, 60) for m in r if PANEL_MODEL_RE.match(m.text)),
            None,
        )
        model_raw = model_tok.text if model_tok else "ERP-FT-241P"
        if model_tok:
            claimed.add(id(model_tok))
        accessories = []
        for r in below(t, 45, 60):
            for m in ACCESSORY_LINE_RE.finditer(_text(r)):
                acc = m.group(2).strip()
                if acc.startswith(("ERP-FT-LVD", "ERP-RTO", "ERM")):
                    accessories.append({"model": acc, "qty": int(m.group(1)), "role": "accessory"})
                    for x in r:
                        claimed.add(id(x))
        g.add(
            role=bx.ROLE_FOUNDRY if model_raw.startswith("UFMP") else bx.ROLE_RELAY,
            model_raw=model_raw,
            name=t.text,
            qty=1,
            label=t.text,
            bbox=_grow(_bbox([t, model_tok] if model_tok else [t]), 30, 10),
            accessories=accessories,
        )

    # the equipment rack and the components listed inside it
    for r in runs:
        text = _text(r).upper()
        if not RACK_LABEL_RE.match(text):
            continue
        anchor = r[0]
        comps: list[dict[str, Any]] = []
        for rr in below(anchor, 130, 80):
            rt = _text(rr)
            ms = list(ACCESSORY_LINE_RE.finditer(rt))
            if ms:
                for m in ms:
                    comps.append(
                        {"model": m.group(2).strip(), "qty": int(m.group(1)), "role": "component"}
                    )
            elif any(k in rt.upper() for k in RACK_COMPONENT_WORDS):
                comps.append({"model": rt, "qty": 1, "role": "component"})
            for x in rr:
                claimed.add(id(x))
        rack_model = next(
            (c["model"] for c in comps if c["model"].upper().startswith("ERN4")), None
        )
        g.add(
            role=bx.ROLE_RACK,
            model_raw=rack_model or "ERN4-RM",
            name=RACK_NAME,
            qty=1,
            label=_text(r),
            bbox=_grow(_bbox(r), 20, 0),
            accessories=comps,
        )
        for x in r:
            claimed.add(id(x))

    # `n - P-NSPS-DIN`: a DIN enclosure holding n power supplies
    for r in runs:
        rt = _text(r)
        for m in ACCESSORY_LINE_RE.finditer(rt):
            if m.group(2).upper().startswith("P-NSPS") and not any(id(x) in claimed for x in r):
                g.add(
                    role=bx.ROLE_NSPS,
                    model_raw="P-NSPS-DIN",
                    name=None,
                    qty=int(m.group(1)),
                    label=rt,
                    bbox=_grow(_bbox(r), 10, 4),
                )
                for x in r:
                    claimed.add(id(x))

    # symbol labels: PARADIGM <model>, <model> PARADIGM …, UNISON UHCI-WM, FOUNDRY UFMPn, EBDK
    groups: list[Device] = []
    for r in runs:
        if any(id(x) in claimed for x in r):
            continue
        texts = [t.text for t in r]
        upper = [s.upper() for s in texts]
        for i, s in enumerate(upper):
            if s in ("PARADIGM", "UNISON"):
                model_tok = None
                if i + 1 < len(r) and MODEL_WORD_RE.match(upper[i + 1]):
                    model_tok = r[i + 1]
                elif i > 0 and MODEL_WORD_RE.match(upper[i - 1]):
                    model_tok = r[i - 1]
                if model_tok is None:
                    continue
                raw = model_tok.text
                role = bx.model_role(riser_model(raw)) or bx.model_role(raw) or bx.ROLE_OTHER
                if raw.upper().startswith("P-NSPS"):
                    role = bx.ROLE_NSPS
                label = _text(sorted((r[i], model_tok), key=lambda t: t.x0))
                after = upper[i + 2] if model_tok is r[i + 1] and i + 2 < len(r) else ""
                enclosure = after.startswith("W/ENCL")
                qty = 1 if role == bx.ROLE_NSPS or enclosure else None
                groups.append(
                    g.add(
                        role=role,
                        model_raw=raw,
                        name=None,
                        qty=qty,
                        label=label,
                        bbox=_grow(_bbox([r[i], model_tok]), 25, 4),
                    )
                )
                for x in (r[i], model_tok):
                    claimed.add(id(x))
            elif s.startswith("UFMP") and id(r[i]) not in claimed:
                groups.append(
                    g.add(
                        role=bx.ROLE_FOUNDRY,
                        model_raw=r[i].text,
                        name=None,
                        qty=None,
                        label=_text(r),
                        bbox=_grow(_bbox([r[i]]), 40, 10),
                    )
                )
                claimed.add(id(r[i]))
            elif s == "EBDK" and id(r[i]) not in claimed:
                g.add(
                    role=bx.ROLE_EBDK,
                    model_raw="EBDK",
                    name=None,
                    qty=1,
                    label="EBDK",
                    bbox=_grow(_bbox([r[i]]), 30, 30),
                )
                claimed.add(id(r[i]))
            elif s.startswith("P-TS") and id(r[i]) not in claimed and "PARADIGM" not in upper:
                groups.append(
                    g.add(
                        role=bx.ROLE_TOUCHSCREEN,
                        model_raw=r[i].text,
                        name=None,
                        qty=None,
                        label=_text(r),
                        bbox=_grow(_bbox(r), 10, 4),
                    )
                )
                claimed.add(id(r[i]))

    # QTY: nn callouts → the group nearest by centre-x above them
    pending = [d for d in groups if d.qty_source == "one"]
    for r in runs:
        for i, t in enumerate(r):
            if not QTY_RE.match(t.text.upper()):
                continue
            digits = "".join(
                x.text for x in r[i + 1 : i + 4] if x.text.isdigit() and x.x0 - t.x1 < 14
            )
            if not digits:
                continue
            cands = [d for d in groups if abs(d.cx - t.cx) <= 45 and 0 < t.top - d.bbox[1] <= 100]
            if not cands:
                continue
            free = [d for d in cands if d in pending]
            best = min(free or cands, key=lambda d: (abs(d.cx - t.cx), t.top - d.bbox[1]))
            if best in pending:
                best.qty = int(digits)
                best.qty_source = "qty"
                best.bbox = [
                    best.bbox[0],
                    best.bbox[1],
                    best.bbox[2],
                    round(t.bottom - best.bbox[1], 1),
                ]
                pending.remove(best)
            else:
                best.qty += int(digits)
    return g.devices


# ----------------------------------------------------------------- bubbles


def _bubble_tokens(
    band: Band, words: list[Tok], curves: list[tuple[float, float, float, float]]
) -> list[tuple[Tok, int]]:
    """Every code token of the band ringed by enough curve fragments to be a bubble (`U` too)."""
    toks = [t for t in words if band.contains(t) and t.text in CODES]
    in_band = [
        c
        for c in curves
        if band.top - BUBBLE_REACH_PT <= c[1] and c[3] <= band.bottom + BUBBLE_REACH_PT
    ]
    out = []
    for t in sorted(toks, key=lambda t: (t.top, t.x0)):
        x0, y0, x1, y1 = (
            t.x0 - BUBBLE_REACH_PT,
            t.top - BUBBLE_REACH_PT,
            t.x1 + BUBBLE_REACH_PT,
            t.bottom + BUBBLE_REACH_PT,
        )
        frags = sum(1 for c in in_band if c[0] <= x1 and c[2] >= x0 and c[1] <= y1 and c[3] >= y0)
        if frags >= BUBBLE_MIN_FRAGMENTS:
            out.append((t, frags))
    return out


def bubbles_of(
    band: Band, words: list[Tok], curves: list[tuple[float, float, float, float]], start: int
) -> tuple[list[Bubble], int]:
    """Lone code tokens ringed by curve fragments; `U` links are counted, not returned."""
    out: list[Bubble] = []
    links = 0
    n = start
    for t, frags in _bubble_tokens(band, words, curves):
        if t.text == "U":
            links += 1
            continue
        n += 1
        out.append(
            Bubble(
                id=f"b{n}",
                band=band,
                code=t.text,
                bbox=_grow(_bbox([t]), 9, 3),
                fragments=frags,
                extraction="text",
            )
        )
    return out, links


def output_labels(band: Band, words: list[Tok], bubbles: list[Bubble]) -> None:
    """A label printed right beside a bubble (the rack's output stack) names its far end."""
    toks = [t for t in words if band.contains(t) and t.text not in CODES]
    for row in rows_of(toks):
        for run in runs_of(row):
            text = _text(run).upper()
            if not OUTPUT_LABEL_RE.match(text):
                continue
            for b in bubbles:
                bx1 = b.bbox[0] + b.bbox[2]
                by = b.bbox[1] + b.bbox[3] / 2
                if (
                    0 <= run[0].x0 - bx1 <= 40
                    and abs(run[0].cy - by) <= 6
                    and b.output_label is None
                ):
                    b.output_label = _text(run)
                    break


# ------------------------------------------------------------------- lines

Box = tuple[float, float, float, float]  # x0, top, x1, bottom


def _seg_len(s: Seg) -> float:
    (a, b) = s
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _in_box(p: tuple[float, float], b: Box, tol: float) -> bool:
    return b[0] - tol <= p[0] <= b[2] + tol and b[1] - tol <= p[1] <= b[3] + tol


def _on_edge(p: tuple[float, float], b: Box, tol: float = LINE_TOUCH_PT) -> bool:
    return _in_box(p, b, tol) and (
        abs(p[0] - b[0]) <= tol
        or abs(p[0] - b[2]) <= tol
        or abs(p[1] - b[1]) <= tol
        or abs(p[1] - b[3]) <= tol
    )


def symbol_boxes(segs: list[Seg], max_w: float, max_h: float) -> list[Box]:
    """Closed axis-aligned rectangles (symbol outlines) from horizontal and vertical pieces,
    collinear pieces joined first (a panel's outline is drawn in parts)."""
    hs: dict[float, list[tuple[float, float]]] = defaultdict(list)
    vs: dict[float, list[tuple[float, float]]] = defaultdict(list)
    for a, b in segs:
        if abs(a[1] - b[1]) < 0.5 and abs(a[0] - b[0]) >= 1:
            hs[round(a[1] * 2) / 2].append((min(a[0], b[0]), max(a[0], b[0])))
        elif abs(a[0] - b[0]) < 0.5 and abs(a[1] - b[1]) >= 1:
            vs[round(a[0] * 2) / 2].append((min(a[1], b[1]), max(a[1], b[1])))

    def join(d: dict[float, list[tuple[float, float]]]) -> list[tuple[float, float, float]]:
        out = []
        for k, spans in d.items():
            spans.sort()
            lo, hi = spans[0]
            for s0, s1 in spans[1:]:
                if s0 <= hi + 1.0:
                    hi = max(hi, s1)
                else:
                    out.append((k, lo, hi))
                    lo, hi = s0, s1
            out.append((k, lo, hi))
        return [s for s in out if s[2] - s[1] >= SYMBOL_MIN_PT / 2]

    horizontal, vertical = join(hs), join(vs)
    boxes: set[Box] = set()
    for y, hx0, hx1 in horizontal:
        downs = [v for v in vertical if hx0 - 1 <= v[0] <= hx1 + 1 and abs(v[1] - y) <= 1]
        for vl in downs:
            for vr in downs:
                w = vr[0] - vl[0]
                if w < SYMBOL_MIN_PT or w > max_w:
                    continue
                reach = min(vl[2], vr[2])
                for y2, bx0, bx1 in horizontal:
                    if (
                        SYMBOL_MIN_PT <= y2 - y <= max_h
                        and y2 <= reach + 1
                        and bx0 <= vl[0] + 1
                        and bx1 >= vr[0] - 1
                    ):
                        boxes.add((vl[0], y, vr[0], y2))
    return sorted(boxes)


def drawn_box(d: Device, boxes: list[Box]) -> Box | None:
    """The outline drawn round a device: the largest box holding its label's centre, else the
    box just under its label (stations, NSPS, EBDK); None when no rectangle is drawn."""
    lx, ly, lw, lh = d.bbox
    cx, cy = lx + lw / 2, ly + lh / 2
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])  # noqa: E731
    holding = [b for b in boxes if b[0] <= cx <= b[2] and b[1] <= cy <= b[3]]
    if holding:
        return max(holding, key=area)
    under = [b for b in boxes if -6 <= b[1] - (ly + lh) <= 25 and b[0] - 5 <= cx <= b[2] + 5]
    if under:
        return max(under, key=area)
    return None


def symbol_box(d: Device, boxes: list[Box]) -> Box:
    """The outline drawn round a device (`drawn_box`), else the label's own box."""
    if (drawn := drawn_box(d, boxes)) is not None:
        return drawn
    lx, ly, lw, lh = d.bbox
    # the label box, widened by the boxes drawn inside it (the EBDK's breaker module)
    own: Box = (lx, ly, lx + lw, ly + lh)
    parts = [own] + [b for b in boxes if _in_box(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), own, 2)]
    return (
        min(b[0] for b in parts),
        min(b[1] for b in parts),
        max(b[2] for b in parts),
        max(b[3] for b in parts),
    )


def _label_runs(band: Band, words: list[Tok], skip: set[int], boxes: list[Box]) -> list[list[Tok]]:
    toks = [
        t
        for t in words
        if band.contains(t)
        and id(t) not in skip
        and t.size < LEVEL_LABEL_MIN_SIZE  # not the band's LEVEL nn
        and not any(_in_box((t.cx, t.cy), b, 0) for b in boxes)
    ]
    runs = [r for row in rows_of(toks) for r in runs_of(row)]
    # not a symbol's QTY: callout, not a glyph (the `~` of a sense feed)
    return [r for r in runs if not QTY_RE.match(r[0].text) and any(ch.isalnum() for ch in _text(r))]


def _run_box(r: list[Tok]) -> Box:
    return (
        min(t.x0 for t in r),
        min(t.top for t in r),
        max(t.x1 for t in r),
        max(t.bottom for t in r),
    )


def _label_at(points: list[tuple[float, float]], runs: list[list[Tok]]) -> str | None:
    """The text block nearest the line's free end (within `LINE_LABEL_PT`), all its lines."""
    best, dist = None, LINE_LABEL_PT
    for r in runs:
        x0, y0, x1, y1 = _run_box(r)
        for px, py in points:
            d = math.hypot(max(x0 - px, 0, px - x1), max(y0 - py, 0, py - y1))
            if d < dist:
                best, dist = r, d
    if best is None:
        return None
    block = [best]
    grew = True
    while grew:
        grew = False
        bx0 = min(_run_box(r)[0] for r in block)
        by0 = min(_run_box(r)[1] for r in block)
        bx1 = max(_run_box(r)[2] for r in block)
        by1 = max(_run_box(r)[3] for r in block)
        for r in runs:
            if any(r is b for b in block):
                continue
            x0, y0, x1, y1 = _run_box(r)
            if x0 <= bx1 and x1 >= bx0 and (0 <= y0 - by1 <= 2.5 or 0 <= by0 - y1 <= 2.5):
                block.append(r)
                grew = True
    block.sort(key=lambda r: (_run_box(r)[1], _run_box(r)[0]))
    return " ".join(_text(r) for r in block)


def is_load_label(label: str | None) -> bool:
    """`TO LOAD CKTS` / `TO LOAD` / `LOAD CKTS`: the panel's load circuits (D221)."""
    return bool(LOAD_LABEL_RE.match(re.sub(r"\s+", " ", (label or "").strip().upper())))


def label_guess(label: str | None) -> str | None:
    """A code the line's own text names (`TO 0-10V CONTROL`, `120V`; a load-circuit label is
    `120V`, D221), else None."""
    if is_load_label(label):
        return LOAD_GUESS
    t = (label or "").upper()
    return next((code for pat, code in LABEL_GUESSES if pat.search(t)), None)


def lines_of(
    band: Band,
    words: list[Tok],
    segs: list[Seg],
    curves: list[tuple[float, float, float, float]],
    devices: list[Device],
    start: int,
) -> list[Line]:
    """Connecting lines with no bubble on a text sheet (D192): pieces of ink joined end to end
    (`LINE_TOUCH_PT`) that touch a device's outline, reach out of it, and carry no wire bubble
    (`U` links included). A device's arrows that end at one label are one line (the triple
    feed arrow). Trunks between bands are not followed: a line that reaches one `leaves_band`
    and the model reads where it goes."""
    height = band.bottom - band.top
    near = [
        s
        for s in segs
        if all(
            band.x0 - 5 <= p[0] <= band.x1 + 5 and band.top - 2 <= p[1] <= band.bottom + 2
            for p in s
        )
    ]
    trunks = [
        (s[0][0], min(s[0][1], s[1][1]), max(s[0][1], s[1][1]))
        for s in segs
        if abs(s[0][0] - s[1][0]) < 0.5
        and _seg_len(s) > height * LINE_TRUNK_SHARE
        and band.x0 <= s[0][0] <= band.x1
        and (min(s[0][1], s[1][1]) <= band.top + 3 or max(s[0][1], s[1][1]) >= band.bottom - 3)
        and min(s[0][1], s[1][1]) < band.bottom
        and max(s[0][1], s[1][1]) > band.top
    ]  # a tall panel's side is not a trunk: a trunk reaches the band's edge
    boxes = symbol_boxes(near, max_w=250.0, max_h=height * 0.8)
    dbox = {d.id: symbol_box(d, boxes) for d in devices}
    bubble_toks = _bubble_tokens(band, words, curves)
    bubbles: list[Box] = []
    for t, _ in bubble_toks:
        x, y, w, h = _grow(_bbox([t]), 9, 3)
        bubbles.append((x, y, x + w, y + h))
    free = [
        s
        for s in near
        if _seg_len(s) <= height * LINE_TRUNK_SHARE
        and not any(_in_box(s[0], b, 0.5) and _in_box(s[1], b, 0.5) for b in dbox.values())
    ]
    # pieces whose ends meet are one line
    parent = list(range(len(free)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cell = 4.0
    grid: dict[tuple[int, int], list[tuple[int, tuple[float, float]]]] = defaultdict(list)
    for i, s in enumerate(free):
        for p in s:
            grid[(round(p[0] / cell), round(p[1] / cell))].append((i, p))
    for i, s in enumerate(free):
        for p in s:
            gx, gy = round(p[0] / cell), round(p[1] / cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j, q in grid[(gx + dx, gy + dy)]:
                        if (
                            j != i
                            and abs(p[0] - q[0]) <= LINE_TOUCH_PT
                            and abs(p[1] - q[1]) <= LINE_TOUCH_PT
                        ):
                            parent[root(i)] = root(j)
    comps: dict[int, list[Seg]] = defaultdict(list)
    for i, s in enumerate(free):
        comps[root(i)].append(s)

    runs = _label_runs(band, words, {id(t) for t, _ in bubble_toks}, list(dbox.values()))
    by_key: dict[tuple[Any, ...], dict[str, Any]] = {}
    for n, comp in enumerate(comps.values()):
        if sum(_seg_len(s) for s in comp) < LINE_MIN_PT:
            continue
        pts = [p for s in comp for p in s]
        touched = [d.id for d in devices if any(_on_edge(p, dbox[d.id]) for p in pts)]
        if not touched:
            continue
        if any(_in_box(p, b, LINE_TOUCH_PT) for p in pts for b in bubbles):
            continue  # a run with a bubble (T43) or a Unison link
        if all(any(_in_box(p, b, 3.0) for b in dbox.values()) for p in pts):
            continue  # detail inside a symbol
        leaves = any(
            abs(p[0] - x) <= LINE_TOUCH_PT and y0 - 1 <= p[1] <= y1 + 1
            for p in pts
            for x, y0, y1 in trunks
        ) or any(p[1] <= band.top + 3 or p[1] >= band.bottom - 3 for p in pts)
        # the label sits at the free end: the points farthest from the device it leaves
        home = dbox[touched[0]]
        reach = [
            (
                math.hypot(
                    max(home[0] - p[0], 0, p[0] - home[2]), max(home[1] - p[1], 0, p[1] - home[3])
                ),
                p,
            )
            for p in pts
        ]
        far = max(r for r, _ in reach)
        ends = [p for r, p in reach if r >= far * 0.6 and r > LINE_TOUCH_PT]
        label = None if leaves else _label_at(ends, runs)
        if label is None and not leaves and len(touched) < 2:
            continue  # nothing at its end: a drawing detail, not a connection
        key = (touched[0], label) if label else ("comp", n)
        entry = by_key.setdefault(key, {"pts": [], "touched": [], "label": label, "leaves": False})
        entry["pts"].extend(pts)
        entry["touched"].extend(t for t in touched if t not in entry["touched"])
        entry["leaves"] = entry["leaves"] or leaves

    names = {d.id: d for d in devices}
    out: list[Line] = []
    for e in sorted(
        by_key.values(), key=lambda e: (min(p[1] for p in e["pts"]), min(p[0] for p in e["pts"]))
    ):
        xs = [p[0] for p in e["pts"]]
        ys = [p[1] for p in e["pts"]]
        frm = names[e["touched"][0]]
        to = names[e["touched"][1]] if len(e["touched"]) > 1 else None
        guess = label_guess(e["label"])
        out.append(
            Line(
                id=f"l{start + len(out) + 1}",
                band=band,
                bbox=_grow(
                    [
                        round(min(xs), 1),
                        round(min(ys), 1),
                        round(max(xs) - min(xs), 1),
                        round(max(ys) - min(ys), 1),
                    ],
                    4,
                    4,
                ),
                extraction="text",
                label=e["label"],
                leaves_band=e["leaves"],
                from_device=frm.id,
                from_label=frm.name or frm.label,
                to_device=to.id if to else None,
                to_label=e["label"] if to is None else None,
                guess=guess,
                guess_confidence=LABEL_GUESS_CONFIDENCE if guess else 0.0,
                guess_source="label" if guess else None,
                guess_reason="load" if is_load_label(e["label"]) else None,
                confidence=TEXT_CONFIDENCE if to else LABEL_GUESS_CONFIDENCE,
                endpoint_source="geometry",
            )
        )
    return out


# ------------------------------------------------------------------- trace


class _BoxIndex:
    """Boxes by coarse cell, for point lookups over the whole sheet."""

    CELL = 32.0

    def __init__(self) -> None:
        self.cells: dict[tuple[int, int], list[tuple[Box, Any]]] = defaultdict(list)

    def add(self, box: Box, item: Any) -> None:
        c = self.CELL
        for gx in range(math.floor(box[0] / c) - 1, math.floor(box[2] / c) + 2):
            for gy in range(math.floor(box[1] / c) - 1, math.floor(box[3] / c) + 2):
                self.cells[(gx, gy)].append((box, item))

    def near(self, p: tuple[float, float]) -> list[tuple[Box, Any]]:
        return self.cells.get((math.floor(p[0] / self.CELL), math.floor(p[1] / self.CELL)), [])


def _at_ring(p: tuple[float, float], ring: Box) -> bool:
    """A line end at a bubble: within the ring's height exactly (stacked bubbles sit 7.6 pt
    apart), a little past its round ends."""
    return ring[0] - 3 <= p[0] <= ring[2] + 3 and ring[1] <= p[1] <= ring[3]


def _pt_box(box: Box) -> list[float]:
    return [
        round(box[0], 1),
        round(box[1], 1),
        round(box[2] - box[0], 1),
        round(box[3] - box[1], 1),
    ]


def _trace_hint(
    b: Bubble,
    reached: list[tuple[int, Device]],
    dead: list[tuple[float, float]],
    drawn: _BoxIndex,
) -> str | None:
    """What an inconclusive trace saw, for the prompt: the devices it reached and the device a
    dead end stops beside (a bubble with no vector ink breaks the line there)."""

    if b.output_label:
        return None  # the printed label names the far end

    def name(d: Device) -> str:
        return d.id if d.band is b.band else f"{d.name or d.label} (level {d.band.level_code})"

    parts = ["reaches " + ", ".join(name(d) for _, d in reached)] if reached else []
    for p in dead:
        boxes = [(box, d) for box, d in drawn.near(p) if d.role not in UNISON_ROLES]
        gaps = [
            (math.hypot(max(x0 - p[0], 0, p[0] - x1), max(y0 - p[1], 0, p[1] - y1)), d)
            for (x0, y0, x1, y1), d in boxes
        ]
        best = min(gaps, key=lambda g: g[0], default=None)
        if best is not None and best[0] <= TRACE_BESIDE_PT:
            parts.append(f"stops {best[0]:.0f} pt from {name(best[1])}")
    return "; ".join(parts) or None


def trace_runs(
    sheet: Sheet,
    words: list[Tok],
    segs: list[Seg],
    curves: list[tuple[float, float, float, float]],
) -> None:
    """Endpoints by line tracing on a text sheet (T107): every run bubble's line is followed
    through the ink — pieces whose ends meet within `LINE_TOUCH_PT`; a crossing is no joint —
    across bands, through the bubble at the run's other end and through a bubble ring with no
    text, to the device outlines it reaches. A trace that reaches exactly two devices, one of
    them on the bubble's band, with no dead end and no bubble of another code on the way, fixes
    the endpoints (`endpoint_source = trace`): the bubble's own device is the near end, except
    that a panic run leaves the panel for its EBDK (the master's single P row). A run drawn
    with a bubble at each end is one run: the bubble on the higher band keeps it, the other is
    `merged_into` it (D206)."""
    if not sheet.bands or not sheet.bubbles:
        return
    x0 = min(b.x0 for b in sheet.bands) - 5
    x1 = max(b.x1 for b in sheet.bands) + 5
    y0 = min(b.top for b in sheet.bands) - 2
    y1 = max(b.bottom for b in sheet.bands) + 2
    region = [s for s in segs if all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in s)]

    drawn, loose, rings = _BoxIndex(), _BoxIndex(), _BoxIndex()
    for band in sheet.bands:
        near = [
            s
            for s in region
            if all(
                band.x0 - 5 <= p[0] <= band.x1 + 5 and band.top - 2 <= p[1] <= band.bottom + 2
                for p in s
            )
        ]
        boxes = symbol_boxes(near, max_w=250.0, max_h=(band.bottom - band.top) * 0.8)
        for d in sheet.band_devices(band):
            box = drawn_box(d, boxes)
            if box is None:
                # no outline round it (sensors, an EBDK): reached only where a line ends in it
                loose.add(symbol_box(d, boxes), d)
            else:
                drawn.add(box, d)
    listed = {tuple(b.bbox): b for b in sheet.bubbles}
    for band in sheet.bands:
        for t, _ in _bubble_tokens(band, words, curves):
            bb = _grow(_bbox([t]), 9, 3)
            rings.add((bb[0], bb[1], bb[0] + bb[2], bb[1] + bb[3]), (t.text, listed.get(tuple(bb))))

    def inside_one(s: Seg, boxes: list[tuple[Box, Any]], tol: float) -> bool:
        return any(_in_box(s[0], b, tol) and _in_box(s[1], b, tol) for b, _ in boxes)

    # the ink: a bubble's own outline and a symbol's inner detail are not lines
    ink = [
        s
        for s in region
        if not inside_one(s, rings.near(s[0]), 1.0) and not inside_one(s, drawn.near(s[0]), 0.5)
    ]
    cell = 4.0
    ends: dict[tuple[int, int], list[tuple[int, tuple[float, float]]]] = defaultdict(list)
    for i, s in enumerate(ink):
        for p in s:
            ends[(round(p[0] / cell), round(p[1] / cell))].append((i, p))

    def joined(p: tuple[float, float], i: int) -> list[int]:
        gx, gy = round(p[0] / cell), round(p[1] / cell)
        return [
            j
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for j, q in ends[(gx + dx, gy + dy)]
            if j != i and abs(p[0] - q[0]) <= LINE_TOUCH_PT and abs(p[1] - q[1]) <= LINE_TOUCH_PT
        ]

    def at(ring: Box) -> list[int]:
        return sorted(
            {
                i
                for gx in range(round((ring[0] - 3) / cell) - 1, round((ring[2] + 3) / cell) + 2)
                for gy in range(round(ring[1] / cell) - 1, round(ring[3] / cell) + 2)
                for i, p in ends[(gx, gy)]
                if _at_ring(p, ring)
            }
        )

    def device_at(p: tuple[float, float], index: _BoxIndex, edge: bool) -> Device | None:
        hit = [
            (b, d)
            for b, d in index.near(p)
            if ((_on_edge(p, b) or _in_box(p, b, 0)) if edge else _in_box(p, b, LINE_TOUCH_PT))
        ]
        if not hit:
            return None
        return min(hit, key=lambda h: (h[0][2] - h[0][0]) * (h[0][3] - h[0][1]))[1]

    resolved: dict[str, tuple[Device, Device]] = {}
    for b in sheet.bubbles:
        own: Box = (b.bbox[0], b.bbox[1], b.bbox[0] + b.bbox[2], b.bbox[1] + b.bbox[3])
        visited: list[Box] = [own]
        hits: dict[int, tuple[int, Device]] = {}  # id(device) → (hops, device)
        via: list[Bubble] = []
        dead: list[tuple[float, float]] = []
        foreign = False
        queue = [(i, 0) for i in at(own)]
        seen = {i for i, _ in queue}
        while queue:
            i, hops = queue.pop(0)
            for p in ink[i]:
                d = device_at(p, drawn, edge=True)
                if d is not None:
                    hits.setdefault(id(d), (hops, d))
                    continue
                nxt = joined(p, i)
                ring = next((r for r in visited if _at_ring(p, r)), None)
                if ring is not None:
                    outside = p[0] < ring[0] or p[0] > ring[2]
                    d = device_at(p, loose, edge=False) if not nxt and outside else None
                    if d is not None and d.role not in UNISON_ROLES:
                        hits.setdefault(id(d), (hops, d))  # a stub straight into an EBDK
                    continue
                other = next(((r, v) for r, v in rings.near(p) if _at_ring(p, r)), None)
                if other is not None:
                    r, (code, o) = other
                    if code != b.code:
                        foreign = True  # a Unison link or another run: not this line
                        continue
                    visited.append(r)
                    if o is not None:
                        via.append(o)
                    nxt = at(r)
                elif not nxt:
                    if (d := device_at(p, loose, edge=False)) is not None:
                        hits.setdefault(id(d), (hops, d))
                    else:
                        dead.append(p)
                for j in nxt:
                    if j not in seen:
                        seen.add(j)
                        queue.append((j, hops + 1))
        reached = sorted(hits.values(), key=lambda h: h[0])
        near = [d for _, d in reached if d.band is b.band]
        if dead or foreign or len(reached) != 2 or not near:
            b.trace_hint = _trace_hint(b, reached, dead, drawn)
            continue
        frm = near[0]
        if b.code == "P" and frm.role == bx.ROLE_EBDK:
            frm = next(d for _, d in reached if d is not frm)  # the panel's panic wire
        to = next(d for _, d in reached if d is not frm)
        b.from_device, b.from_label = frm.id, frm.name or frm.label
        if to.band is b.band:
            b.to_device, b.to_label, b.to_ref = to.id, None, None
            b.to_level_code = None
        else:
            b.to_device, b.to_label, b.to_ref = None, to.name or to.label, to
            b.to_level_code = to.band.level_code
        b.via = [o.id for o in via]
        b.confidence = TRACE_CONFIDENCE
        b.endpoint_source = "trace"
        resolved[b.id] = (frm, to)

    # a run drawn with a bubble at each end is one run: the higher band's bubble keeps it
    order = {id(band): n for n, band in enumerate(sheet.bands)}
    by_id = {b.id: b for b in sheet.bubbles}
    for b in sheet.bubbles:
        if b.id not in resolved or b.merged_into or b.twin:
            continue
        for oid in b.via:
            o = by_id.get(oid)
            if o is None or o.id not in resolved or o.merged_into or o.twin:
                continue
            if {id(d) for d in resolved[b.id]} != {id(d) for d in resolved[o.id]}:
                continue
            keep, drop = (b, o) if order[id(b.band)] <= order[id(o.band)] else (o, b)
            keep.twin, drop.merged_into = drop, keep.id
            break


# ----------------------------------------------------------------- analyse


def analyse(pdf_bytes: bytes) -> Riser:
    """The deterministic pass over every page: bands, levels, devices, bubbles, output labels,
    lines with no bubble and, on a text sheet, the runs' endpoints by tracing (T107)."""
    sheets: list[Sheet] = []
    for i in range(page_count(pdf_bytes)):
        width, height = page_size(pdf_bytes, i)
        words = words_of(pdf_bytes, i)
        title_x = min((w.x0 for w in words if w.text.upper().startswith("DRAWING")), default=None)
        image = render(pdf_bytes, i, RASTER_SCALE)
        bands, ncols = bands_of(image, RASTER_SCALE, i + 1, height, title_x)
        in_bands = [w for w in words if any(b.contains(w) for b in bands)]
        has_text = len(in_bands) >= 50
        devices: list[Device] = []
        bubbles: list[Bubble] = []
        lines: list[Line] = []
        links = 0
        if has_text:
            label_levels(bands, words)
            curves = small_curves(pdf_bytes, i)
            segs = segments_of(pdf_bytes, i)
            n = 0
            for b in bands:
                band_devices = devices_of(b, words)
                devices.extend(band_devices)
                bb, lk = bubbles_of(b, words, curves, n)
                n += len(bb)
                links += lk
                output_labels(b, words, bb)
                bubbles.extend(bb)
                lines.extend(lines_of(b, words, segs, curves, band_devices, len(lines)))
        sheet = Sheet(
            page=i + 1,
            drawing=drawing_number(words) or f"{i + 1:03d}",
            width=width,
            height=height,
            has_text=has_text,
            bands=bands,
            devices=devices,
            bubbles=bubbles,
            unison_links=links,
            columns=ncols,
            lines=lines,
        )
        if has_text:
            trace_runs(sheet, words, segs, curves)
        sheets.append(sheet)
    return Riser(sheets)


# ------------------------------------------------------------------- crops


@dataclass
class Crop:
    png: bytes
    scale: float
    x0: float
    top: float
    width_px: int
    height_px: int

    def to_px(self, bbox: list[float]) -> list[int]:
        return [
            round((bbox[0] - self.x0) * self.scale),
            round((bbox[1] - self.top) * self.scale),
            round(bbox[2] * self.scale),
            round(bbox[3] * self.scale),
        ]

    def to_pt(self, box: list[float]) -> list[float]:
        if len(box) != 4:
            return [round(self.x0, 1), round(self.top, 1), 0.0, 0.0]
        return [
            round(self.x0 + box[0] / self.scale, 1),
            round(self.top + box[1] / self.scale, 1),
            round(box[2] / self.scale, 1),
            round(box[3] / self.scale, 1),
        ]


def band_crop(pdf_bytes: bytes, sheet: Sheet, band: Band) -> Crop:
    x0, top = band.x0 - CROP_PAD_PT, band.top - CROP_PAD_PT / 2
    x1, bottom = band.x1 + CROP_PAD_PT, band.bottom + CROP_PAD_PT / 2
    scale = min(CROP_MAX_PX / (x1 - x0), CROP_MAX_PX / (bottom - top), 3.0)
    img = render(pdf_bytes, sheet.page - 1, scale, (x0, top, x1, bottom))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return Crop(buf.getvalue(), scale, max(0.0, x0), max(0.0, top), img.size[0], img.size[1])


def column_overview(pdf_bytes: bytes, sheet: Sheet, band: Band) -> bytes:
    """The band's whole column at low resolution with the band outlined in red."""
    col = [b for b in sheet.bands if b.column == band.column]
    x0, x1 = band.x0 - CROP_PAD_PT * 2, band.x1 + CROP_PAD_PT * 2
    top, bottom = min(b.top for b in col) - CROP_PAD_PT, max(b.bottom for b in col) + CROP_PAD_PT
    scale = min(OVERVIEW_MAX_PX / (bottom - top), OVERVIEW_MAX_PX / (x1 - x0))
    img = render(pdf_bytes, sheet.page - 1, scale, (x0, top, x1, bottom))
    draw = ImageDraw.Draw(img)
    ox, oy = max(0.0, x0), max(0.0, top)
    draw.rectangle(
        [
            (band.x0 - ox) * scale,
            (band.top - oy) * scale,
            (band.x1 - ox) * scale,
            (band.bottom - oy) * scale,
        ],
        outline=(220, 0, 0),
        width=3,
    )
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def band_prompt(sheet: Sheet, band: Band, crop: Crop, levels_known: list[str]) -> str:
    """The user turn for one band: what is known, what is asked."""
    col = [b.level_code or "?" for b in sheet.bands if b.column == band.column]
    lines = [
        f"Riser sheet {sheet.drawing}, page {sheet.page}. The first image is the band of level "
        f"{band.level_code or '(unlabelled)'} at {crop.width_px}x{crop.height_px} px; the second "
        f"is its whole column with this band outlined in red. Levels in this column, top to "
        f"bottom: {', '.join(col)}. Project levels: {', '.join(levels_known) or '(none yet)'}.",
    ]
    devices = sheet.band_devices(band)
    bubbles = sheet.band_bubbles(band)
    if sheet.has_text:
        lines.append("\nDevices on this band (id: label, role, model, qty, [x, y, w, h] px):")
        for d in devices:
            lines.append(
                f"- {d.id}: {d.label} — {d.role}, {d.model}"
                + (f", tag {d.name}" if d.name and d.name != d.label else "")
                + f", qty {d.qty}, {crop.to_px(d.bbox)}"
            )
        lines.append(
            "\nWire bubbles on this band (id: code, [x, y, w, h] px, label printed beside it "
            "if any; what tracing its line found):"
        )
        for b in bubbles:
            lines.append(
                f"- {b.id}: {b.code}, {crop.to_px(b.bbox)}"
                + (f", label '{b.output_label}'" if b.output_label else "")
                + _trace_note(sheet, b)
            )
        lines.append(
            "\nLines with no bubble on this band (id: the device it leaves, [x, y, w, h] px, "
            "text at its free end if any):"
        )
        for ln in sheet.band_lines(band):
            lines.append(
                f"- {ln.id}: from {ln.from_device}"
                + (f" to {ln.to_device}" if ln.to_device else "")
                + f", {crop.to_px(ln.bbox)}"
                + (f", text '{ln.label}'" if ln.label else "")
                + (", leaves the band" if ln.leaves_band else "")
            )
        lines.append(
            "\nReturn devices as an empty list (they are known). A bubble marked RESOLVED was "
            "traced along its line to both ends: do not return it, and do not add a cable for "
            "the bubble at its other end. For every other bubble above return "
            "one cable: from_device = the listed device whose line the bubble sits on; to_device "
            "when the other end is a device on this band; otherwise to_label (the printed far-end "
            "text, or Equipment rack / Relay panel / NSPS) with to_level_code read from the "
            "overview — trunk lines run between bands and are labelled at their ends. A bubble "
            "beside a rack output label goes from the rack to that label. Add a cable for any run "
            "bubble you see that is not listed (new ids), never for U bubbles. For every line "
            "with no bubble above return one unlabelled_lines entry with its endpoints read the "
            "same way and your code_guess; add one for any such line you see that is not listed "
            "(new-l1, new-l2 …)."
        )
    else:
        lines.append(
            "\nThis sheet has no text layer. Read the band: level_code from its LEVEL label; "
            "every device symbol with its printed label, model, panel tag, QTY: count and box in "
            "pixels; every wire bubble (X, N, NG, F, P, UV — not U) with its box and endpoints as "
            "above; every line that connects to a device with no bubble as an unlabelled_lines "
            "entry with your code_guess. Use new-1, new-2 … as device ids, new-b1, new-b2 … as "
            "bubble ids and new-l1, new-l2 … as line ids."
        )
    return "\n".join(lines)


# ------------------------------------------------------------ the answer


def apply_answer(sheet: Sheet, band: Band, crop: Crop, data: dict[str, Any]) -> None:
    """Fold one band's answer into the sheet: vision devices and bubbles on a no-text sheet,
    endpoints on every run bubble."""
    if not sheet.has_text:
        code = data.get("level_code")
        if code and band.level_code is None:
            band.level_code = bx.norm_level(str(code))
            band.level_source = "model"
        n = len(sheet.band_devices(band))
        for item in data.get("devices") or []:
            n += 1
            raw = str(item.get("model") or "").strip() or str(item.get("label") or "?")
            role = item.get("role")
            if not roles.is_role(role) or role == bx.ROLE_OTHER:
                role = bx.model_role(riser_model(raw)) or bx.ROLE_OTHER
            # the role names the category (the rename ruling's table); `other` has none until
            # the library type or the reviewer gives one
            cat = roles.ROLE_CATEGORY.get(str(role))
            name = item.get("name") or None
            if role == bx.ROLE_RACK and not name:
                name = RACK_NAME
            conf = min(float(item.get("confidence") or 0.0), MODEL_CONFIDENCE_CAP)
            accs = [
                {"model": str(a.get("model")), "qty": int(a.get("qty") or 1), "role": "accessory"}
                for a in item.get("accessories") or []
                if a.get("model")
            ]
            d = Device(
                id=str(item.get("id") or f"new-{n}"),
                band=band,
                role=str(role),
                category=cat,
                model=riser_model(raw),
                model_raw=raw,
                name=name,
                qty=max(1, int(item.get("qty") or 1)),
                qty_source="model",
                accessories=accs,
                bbox=crop.to_pt(list(item.get("bbox") or [])),
                label=str(item.get("label") or raw),
                extraction="model",
                confidence=conf,
            )
            sheet.devices.append(d)
    by_id = {b.id: b for b in sheet.band_bubbles(band)}
    device_ids = {d.id for d in sheet.band_devices(band)}
    for item in data.get("cables") or []:
        bid = str(item.get("bubble_id") or "")
        code = str(item.get("code") or "")
        if code not in RUN_CODES:
            continue
        b = by_id.get(bid)
        if b is not None and (b.endpoint_source == "trace" or b.merged_into):
            continue  # the trace is the truth (T107)
        if b is None:
            box = crop.to_pt(list(item.get("bbox") or []))
            if _other_end(sheet, band, item, box) is not None:
                continue
            b = Bubble(
                id=bid or f"new-b{len(by_id) + 1}",
                band=band,
                code=code,
                bbox=box,
                fragments=0,
                extraction="model",
            )
            sheet.bubbles.append(b)
            by_id[b.id] = b
        conf = min(float(item.get("confidence") or 0.0), MODEL_CONFIDENCE_CAP)
        frm = item.get("from_device")
        to = item.get("to_device")
        b.from_device = frm if frm in device_ids else None
        b.from_label = item.get("from_label") or (None if b.from_device else frm)
        b.to_device = to if to in device_ids else None
        b.to_label = item.get("to_label") or (None if b.to_device else to)
        b.to_level_code = (
            bx.norm_level(str(item["to_level_code"])) if item.get("to_level_code") else None
        )
        if b.to_device is None and b.to_label and b.to_level_code:
            b.to_ref = _named(sheet, b.to_label, b.to_level_code)  # "CT02LCPB", level 02
        b.note = item.get("note") or None
        if b.output_label and b.endpoint_source == "label":
            # the printed label is the truth; the model only confirms the near end
            b.confidence = max(b.confidence, LABEL_CONFIDENCE)
        else:
            b.confidence = conf
            b.endpoint_source = "model"
    apply_lines(sheet, band, crop, data, device_ids)


def _trace_note(sheet: Sheet, b: Bubble) -> str:
    """The prompt's account of a bubble's trace (T107)."""
    if b.merged_into:
        return f", RESOLVED: the other end of {b.merged_into}'s run"
    if b.endpoint_source != "trace":
        return f", trace: {b.trace_hint}" if b.trace_hint else ""
    to = b.to_device if b.to_device else f"{b.to_label} on level {b.to_level_code or '?'}"
    twin = f" (its other end is {b.twin.id} on level {b.twin.band.level_code})" if b.twin else ""
    return f", RESOLVED: traced from {b.from_device} to {to}{twin}"


def _named(sheet: Sheet, label: str, level_code: str) -> Device | None:
    """The device a far-end label names outright on a level of this sheet (`CT02LCPB`)."""
    key = label.strip().upper()
    return next(
        (
            d
            for d in sheet.devices
            if d.band.level_code == level_code and (d.name or "").upper() == key
        ),
        None,
    )


def _other_end(sheet: Sheet, band: Band, item: dict[str, Any], box: list[float]) -> Bubble | None:
    """A bubble the model adds that is the far end of a run already listed (T107): on a traced
    bubble's box, or leaving the device another band's run of the same code arrives at. The
    run takes the device as its far end when it had none."""
    devs = {d.id: d for d in sheet.band_devices(band)}
    frm = devs.get(str(item.get("from_device") or ""))
    level = bx.norm_level(str(item["to_level_code"])) if item.get("to_level_code") else None
    for o in sheet.bubbles:
        if o.code != item.get("code"):
            continue
        if o.band is band and _overlaps(o.bbox, _grow(box, 2, 2)):
            return o
        if o.merged_into:
            continue
        if (
            frm is not None
            and o.band is not band
            and o.band.level_code == level
            and o.to_level_code == band.level_code
            and o.to_ref in (None, frm)
        ):
            if o.to_ref is None:
                o.to_ref, o.to_label = frm, frm.name or frm.label
            return o
    return None


def _overlaps(a: list[float], b: list[float]) -> bool:
    return (
        a[0] <= b[0] + b[2] and b[0] <= a[0] + a[2] and a[1] <= b[1] + b[3] and b[1] <= a[1] + a[3]
    )


def apply_lines(
    sheet: Sheet, band: Band, crop: Crop, data: dict[str, Any], device_ids: set[str]
) -> None:
    """The model's reading of the lines with no bubble (D192): far ends and a code guess on the
    lines the geometry found (its near end stands), and the lines it saw that were not listed —
    every one on a sheet with no text layer."""
    known = {ln.id: ln for ln in sheet.band_lines(band)}
    for raw in data.get("unlabelled_lines") or []:
        item = dict(raw)
        if item.get("from_device") not in device_ids and item.get("to_device") in device_ids:
            # written arrow-first (from the feed note to the device): the device is the near end
            item["from_device"], item["to_device"] = item["to_device"], None
            item["label"] = item.get("label") or item.get("from_label")
            item["to_label"], item["from_label"] = item.get("from_label"), None
        lid = str(item.get("line_id") or "")
        frm = item.get("from_device")
        ln = known.get(lid)
        if ln is None and frm not in device_ids:
            continue  # a trunk passing through: asked about on the band whose device it leaves
        if ln is None:
            box = _grow(crop.to_pt(list(item.get("bbox") or [])), 4, 4)
            if any(o.from_device == frm and _overlaps(o.bbox, box) for o in known.values()):
                continue  # a listed line under a new id
            ln = Line(id=f"new-l{len(sheet.lines) + 1}", band=band, bbox=box, extraction="model")
            sheet.lines.append(ln)
            known[ln.id] = ln
        conf = min(float(item.get("confidence") or 0.0), MODEL_CONFIDENCE_CAP)
        to = item.get("to_device")
        if ln.from_device is None:
            ln.from_device = frm if frm in device_ids else None
            ln.from_label = item.get("from_label") or (None if ln.from_device else frm)
        if to in device_ids and to != ln.from_device:
            ln.to_device, ln.to_label = to, None
        elif item.get("to_label") and ln.to_device is None:
            ln.to_label = item["to_label"]
        if item.get("to_level_code"):
            ln.to_level_code = bx.norm_level(str(item["to_level_code"]))
        ln.label = ln.label or item.get("label") or None
        guess = item.get("code_guess")
        if is_load_label(ln.label):
            # a load-circuit line is 120V to Fixtures, always (D221): the model does not change it
            ln.guess, ln.guess_source, ln.guess_reason = LOAD_GUESS, "label", "load"
            ln.guess_confidence = ln.guess_confidence or LABEL_GUESS_CONFIDENCE
        elif guess in GUESS_CODES:
            ln.guess, ln.guess_confidence, ln.guess_source = guess, conf, "model"
        ln.confidence = conf
        ln.endpoint_source = "model"
        ln.note = item.get("note") or None


# -------------------------------------------------------------------- build


@dataclass
class BomDraft:
    """An existing `draft_device` from the BOM job, as the merge reads it."""

    id: Any
    level_id: Any
    level_code: str | None
    model: str
    candidates: list[str]
    qty: int | None
    level_basis: str | None
    venue: str | None
    accessories: list[dict[str, Any]]
    source_ref: dict[str, Any]
    conflicts: list[str]
    confidence: float | None
    name: str | None


@dataclass
class MasterDevice:
    """A live `device` row of the project (the seed import's baseline, D30)."""

    level_code: str
    device: str
    category: str | None


@dataclass
class Target:
    levels: dict[str, Any]  # level code → level id
    placeholders: dict[str, Any] = field(default_factory=dict)  # label → id
    bom: list[BomDraft] = field(default_factory=list)
    master: list[MasterDevice] = field(default_factory=list)
    bom_target: bx.Target | None = None  # model_map / level_alias / library for normalisation
    file: str = "riser.pdf"

    def norm(self) -> bx.Target:
        return self.bom_target or bx.Target(levels=self.levels)

    def split_level(self, code: str) -> str | None:
        """The mezzanine code when the project splits `code` (06 → 06M, Phase 1f §4)."""
        mezz = f"{code}M"
        return mezz if mezz in self.levels and code in self.levels else None


def level_order_key(code: str) -> float:
    """B2 < B1 < 01 < 02 < … < 06 < 06M < 07; letters alone sort last."""
    c = code.upper()
    if m := re.match(r"^B(\d+)$", c):
        return -int(m.group(1))
    if m := re.match(r"^(\d+)(M?)$", c):
        return int(m.group(1)) + (0.5 if m.group(2) else 0)
    return 1000


def model_key(model: str) -> str:
    """Models that are one device family for matching: SR / LR sensors, the NSPS kit."""
    k = bx._key(model)
    if m := bx.SR_LR_RE.match(model.upper()):
        return m.group("base")
    if k.startswith("P-NSPS"):
        return "P-NSPS-D"
    return k


def fixture_label(text: str) -> str:
    """`B3B ELEV CORE C FIX` → `B3B Elev Core C fixture` (the seed list's spelling)."""
    out = []
    for tok in text.split():
        if tok.upper() == "FIX":
            out.append("fixture")
        elif any(ch.isdigit() for ch in tok) or len(tok) <= 2:
            out.append(tok.upper())
        else:
            out.append(tok.capitalize())
    return " ".join(out)


@dataclass
class DeviceDraft:
    id: Any
    level_id: Any
    level_code: str | None
    model: str
    model_raw: str
    candidates: list[str]
    name: str | None
    category: str | None
    role: str | None
    qty: int
    accessories: list[dict[str, Any]]
    source_ref: dict[str, Any]
    level_basis: str
    extraction: str
    confidence: float
    conflicts: list[str]

    def row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "level_id": self.level_id,
            "model": self.model,
            "model_raw": self.model_raw,
            "candidates": self.candidates if len(self.candidates) > 1 else None,
            "name": self.name,
            "category": self.category,
            "role": self.role,
            "qty": self.qty,
            "accessories": self.accessories or None,
            "source_ref": {**self.source_ref, "level_code": self.level_code},
            "level_basis": self.level_basis,
            "extraction": self.extraction,
            "confidence": round(self.confidence, 3),
            "conflicts": sorted(set(self.conflicts)) or None,
            "state": "proposed",
        }


@dataclass
class Edit:
    """A field change on an existing BOM draft (the merge, D28)."""

    draft_id: Any
    field: str
    now: Any


@dataclass
class Deletion:
    draft_id: Any
    reason: str


@dataclass
class NewPlaceholder:
    id: Any
    label: str
    kind: str


@dataclass
class CableDraft:
    id: Any
    level_id: Any
    level_code: str | None
    code: str | None  # None: a line with no bubble, the reviewer says what it is (D192)
    from_label: str | None
    to_label: str | None
    to_level_id: Any
    candidates: list[dict[str, Any]]
    source_ref: dict[str, Any]
    extraction: str
    confidence: float
    conflicts: list[str]

    def row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "level_id": self.level_id,
            "code": self.code,
            "qty": 1,
            "from_label": self.from_label,
            "to_label": self.to_label,
            "to_level_id": self.to_level_id,
            "origin": "riser",
            "candidates": self.candidates or None,
            "source_ref": {**self.source_ref, "level_code": self.level_code},
            "level_basis": "riser_band",
            "extraction": self.extraction,
            "confidence": round(self.confidence, 3),
            "conflicts": sorted(set(self.conflicts)) or None,
            "state": "proposed",
        }


@dataclass
class Conflict:
    """A `review_item(source_conflict)`: the riser's count vs the project's devices (D30)."""

    level_id: Any
    level_code: str
    model: str
    riser_qty: int
    master_qty: int
    bom_qty: int | None
    draft_id: Any


@dataclass
class Result:
    drafts: list[DeviceDraft]
    edits: list[Edit]
    deletions: list[Deletion]
    placeholders: list[NewPlaceholder]
    cables: list[CableDraft]
    conflicts: list[Conflict]
    findings: list[dict[str, Any]]
    merged: int
    split: int

    def stats(self) -> dict[str, Any]:
        by_level: dict[str, int] = defaultdict(int)
        for d in self.drafts:
            by_level[d.level_code or "(none)"] += 1
        return {
            "device_drafts": len(self.drafts),
            "merged_into_bom": self.merged,
            "pooled_split": self.split,
            "bom_edits": len(self.edits),
            "bom_deleted": len(self.deletions),
            "placeholders_added": len(self.placeholders),
            "cable_drafts": len(self.cables),
            "cables_by_code": dict(
                sorted(_count(c.code for c in self.cables if c.code is not None).items())
            ),
            "cables_unknown_code": sum(1 for c in self.cables if c.code is None),
            "code_guesses": dict(
                sorted(
                    _count(
                        next((x["value"] for x in c.candidates if x["side"] == "code"), "none")
                        for c in self.cables
                        if c.code is None
                    ).items()
                )
            ),
            "endpoints_low_confidence": sum(
                1 for c in self.cables if c.confidence < LOW_CONFIDENCE
            ),
            "endpoints_unresolved": sum(
                1 for c in self.cables if "endpoint:unresolved" in c.conflicts
            ),
            "endpoints_traced": sum(1 for c in self.cables if c.source_ref.get("traced")),
            "twins_folded": sum(1 for c in self.cables if "twin" in c.source_ref),
            "source_conflicts": len(self.conflicts),
            "findings": self.findings,
            "flagged": sum(1 for d in self.drafts if d.conflicts or d.confidence < LOW_CONFIDENCE),
            "drafts_by_level": dict(sorted(by_level.items())),
        }


def _count(items: Any) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for i in items:
        out[i] += 1
    return dict(out)


class _Build:
    def __init__(self, riser: Riser, target: Target):
        self.riser = riser
        self.t = target
        self.norm = target.norm()
        self.drafts: list[DeviceDraft] = []
        self.edits: list[Edit] = []
        self.deletions: list[Deletion] = []
        self.placeholders: list[NewPlaceholder] = []
        self.cables: list[CableDraft] = []
        self.conflicts: list[Conflict] = []
        self.findings: list[dict[str, Any]] = []
        self.merged = 0
        self.split = 0
        self.placeholder_ids: dict[str, Any] = {
            k.casefold(): v for k, v in target.placeholders.items()
        }
        self.touched: dict[Any, dict[str, Any]] = {}  # BOM draft id → fields set so far
        self.has_bom = bool(target.bom)

    # ---------------------------------------------------------- helpers

    def level_of(self, band: Band) -> tuple[Any, str | None]:
        code = band.level_code
        if code is None:
            return None, None
        return self.t.levels.get(code), code

    def source_ref(
        self, sheet: Sheet, band: Band, bbox: list[float], kind: str, **extra: Any
    ) -> dict[str, Any]:
        return {
            "kind": kind,
            "file": self.t.file,
            "page": sheet.page,
            "sheet": sheet.drawing,
            "band": band.key,
            "bbox": bbox,
            **extra,
        }

    def placeholder(self, label: str, kind: str) -> Any:
        key = label.casefold()
        if key in self.placeholder_ids:
            return self.placeholder_ids[key]
        pid = uuid7()
        self.placeholder_ids[key] = pid
        self.placeholders.append(NewPlaceholder(pid, label, kind))
        return pid

    def bom_on(self, level_code: str, key: str, role: str) -> list[BomDraft]:
        """The BOM's drafts of this model family on the level — and on its mezzanine for a
        panel-class device (the BOM's `Level 5` rack is the master's 06M, the riser's band 06)."""
        codes = {level_code}
        if role in bx.PANEL_ROLES and (mezz := self.t.split_level(level_code)):
            codes.add(mezz)
        return [
            b
            for b in self.t.bom
            if b.level_code in codes
            and (model_key(b.model) == key or any(model_key(c) == key for c in b.candidates))
        ]

    def pooled_for(self, level_code: str, key: str) -> list[BomDraft]:
        """The pooled BOM line this riser placement draws down: a venue naming the floors
        first (`Level B2 - 12`); a venue naming none (`Link to P-CCS in other building`) only
        when no floored line covers the level."""
        coded, loose = [], []
        for b in self.t.bom:
            if b.level_id is not None or b.level_basis != "pooled_venue":
                continue
            if model_key(b.model) != key and not any(model_key(c) == key for c in b.candidates):
                continue
            if not self.in_venue(level_code, b.venue):
                continue
            (coded if b.venue and bx.parse_venue(b.venue).codes else loose).append(b)
        return coded or loose

    def in_venue(self, level_code: str, venue: str | None) -> bool:
        if not venue:
            return True
        v = bx.parse_venue(venue)
        if not v.codes:
            return True  # `Link to P-CCS in other building`: anywhere, as a last resort
        if len(v.codes) == 2 and " - " in venue:
            lo, hi = sorted((level_order_key(v.codes[0]), level_order_key(v.codes[1])))
            return lo <= level_order_key(level_code) <= hi
        fam = {bx.norm_level(c) for c in v.codes}
        return level_code in fam or level_code.rstrip("M") in fam

    def edit(self, draft: BomDraft, fld: str, now: Any) -> None:
        self.touched.setdefault(draft.id, {})[fld] = now
        self.edits = [e for e in self.edits if not (e.draft_id == draft.id and e.field == fld)]
        self.edits.append(Edit(draft.id, fld, now))

    # ---------------------------------------------------------- devices

    def run_devices(self) -> None:
        pooled_hits: dict[Any, list[tuple[str, int, list[dict[str, Any]]]]] = defaultdict(list)
        for sheet in self.riser.sheets:
            for band in sheet.bands:
                level_id, code = self.level_of(band)
                devs = sheet.band_devices(band)
                ebdk = sum(d.qty for d in devs if d.role == bx.ROLE_EBDK)
                erp = sum(1 for d in devs if d.role == bx.ROLE_RELAY)
                n_runs = any(b.code in ("N", "NG") for b in sheet.band_bubbles(band))
                for d in devs:
                    m = bx.normalise_model(d.model, self.norm)
                    key = model_key(m.model)
                    conflicts = list(m.conflicts)
                    if code and d.role in bx.PANEL_ROLES and (mezz := self.t.split_level(code)):
                        conflicts.append(f"level:{code}/{mezz}")
                    if d.role == bx.ROLE_EBDK and ebdk != erp:
                        conflicts.append("pairing:ebdk≠erp")
                        self.findings.append(
                            {"check": "ebdk_erp_pairing", "level": code, "ebdk": ebdk, "erp": erp}
                        )
                    if d.role in (bx.ROLE_NSPS, bx.ROLE_RACK) and not n_runs:
                        conflicts.append("network:no_N_run")
                        self.findings.append(
                            {"check": "network_run", "level": code, "device": d.label}
                        )
                    if d.confidence < LOW_CONFIDENCE:
                        conflicts.append("confidence:low")
                    riser_ref = self.source_ref(
                        sheet,
                        band,
                        d.bbox,
                        "riser_symbol",
                        label=d.label,
                        qty=d.qty,
                        model=d.model_raw,
                    )
                    same_level = self.bom_on(code, key, d.role) if code else []
                    if same_level:
                        self.merge(d, same_level, riser_ref, conflicts)
                        continue
                    pooled = self.pooled_for(code, key) if code else []
                    # the project's library type for the model, when there is one, gives the
                    # role and category (D183 (4), T115); else what the riser read
                    kind = (
                        bx.classify(m.model, self.norm)
                        if self.norm.library_type(m.model) is not None
                        else None
                    ) or bx.Kind(d.role, d.category)
                    draft = DeviceDraft(
                        id=uuid7(),
                        level_id=level_id,
                        level_code=code,
                        model=m.model,
                        model_raw=d.model_raw,
                        candidates=m.candidates,
                        name=d.name,
                        category=kind.category,
                        role=kind.role,
                        qty=d.qty,
                        accessories=[
                            {
                                **a,
                                "source_ref": {**riser_ref, "kind": "riser_text"},
                                "extraction": d.extraction,
                                "confidence": d.confidence,
                            }
                            for a in d.accessories
                        ],
                        source_ref=riser_ref,
                        level_basis="riser_band" if code else "riser_band_unlabelled",
                        extraction=d.extraction,
                        confidence=d.confidence,
                        conflicts=conflicts,
                    )
                    if pooled:
                        p = pooled[0]
                        draft.source_ref["bom"] = {
                            "draft_id": str(p.id),
                            "page": p.source_ref.get("page"),
                            "line": p.source_ref.get("line"),
                            "venue": p.venue,
                            "qty": p.qty,
                        }
                        draft.level_basis = "riser_band"
                        pooled_hits[p.id].append((code or "?", d.qty, d.accessories))
                        d.bom_ids = [p.id]
                        self.split += 1
                    elif self.has_bom:
                        draft.conflicts.append("source:riser_only")
                    d.draft_id = draft.id
                    self.drafts.append(draft)
        self.settle_pooled(pooled_hits)

    def merge(
        self, d: Device, boms: list[BomDraft], riser_ref: dict[str, Any], conflicts: list[str]
    ) -> None:
        """One riser symbol ↔ the BOM drafts of that model on the level: the drafts carry both
        sources (D28); a differing count is a conflict, never resolved here."""
        bom_qty = sum(b.qty or 0 for b in boms)
        agree = bom_qty == d.qty
        for b in boms:
            ref = {
                **b.source_ref,
                "riser": {**riser_ref, "shared_with": [str(o.id) for o in boms if o is not b]},
            }
            self.edit(b, "source_ref", ref)
            # a draft the BOM already put on the mezzanine has settled the 06 / 06M question
            new_conf = list(b.conflicts) + [
                c
                for c in conflicts
                if not (c.startswith("level:") and b.level_code != d.band.level_code)
            ]
            if not agree:
                new_conf.append("qty:bom≠riser")
            cards = self.card_mismatch(d, boms)
            if cards:
                new_conf.append("cards:bom≠riser")
                self.findings.append(
                    {
                        "check": "option_cards",
                        "level": d.band.level_code,
                        "device": d.label,
                        **cards,
                    }
                )
            new_conf = sorted(set(new_conf))
            if new_conf != sorted(set(b.conflicts)):
                self.edit(b, "conflicts", new_conf or None)
            if d.name and not b.name:
                self.edit(b, "name", d.name)  # D10: the riser's panel name is the Device name
            if agree and (b.confidence or 0) < d.confidence:
                self.edit(b, "confidence", round(d.confidence, 3))
            d.bom_ids.append(b.id)
        if not agree:
            self.findings.append(
                {
                    "check": "qty",
                    "level": d.band.level_code,
                    "model": d.model,
                    "bom": bom_qty,
                    "riser": d.qty,
                }
            )
        d.draft_id = boms[0].id
        self.merged += 1

    def card_mismatch(self, d: Device, boms: list[BomDraft]) -> dict[str, Any] | None:
        if d.role != bx.ROLE_RELAY:
            return None
        riser = {
            a["model"]: a["qty"] for a in d.accessories if OPTION_CARD_RE.match(str(a["model"]))
        }
        bom: dict[str, int] = defaultdict(int)
        for b in boms:
            for a in b.accessories:
                if OPTION_CARD_RE.match(str(a.get("model"))):
                    bom[str(a.get("model"))] += int(a.get("qty") or 0)
        diff = {
            k: (riser.get(k, 0), bom.get(k, 0))
            for k in set(riser) | set(bom)
            if riser.get(k, 0) != bom.get(k, 0)
        }
        return (
            {"cards": {k: {"riser": v[0], "bom": v[1]} for k, v in diff.items()}} if diff else None
        )

    def settle_pooled(self, hits: dict[Any, list[tuple[str, int, list[dict[str, Any]]]]]) -> None:
        """A pooled BOM line placed by the riser (D10): the per-level drafts replace it when the
        counts (and option cards) agree; otherwise it stays, flagged, beside them."""
        by_id = {b.id: b for b in self.t.bom}
        # option cards are pooled per venue over every ERP line (T42 → T43): compare per venue
        venue_cards: dict[tuple[str | None, str | None], tuple[dict[str, int], dict[str, int]]] = {}
        for pid, placed in hits.items():
            b = by_id[pid]
            key = (b.venue, b.source_ref.get("job"))
            riser_c, bom_c = venue_cards.setdefault(key, (defaultdict(int), defaultdict(int)))
            for _, _, accs in placed:
                for a in accs:
                    if OPTION_CARD_RE.match(str(a["model"])):
                        riser_c[a["model"]] += a["qty"]
            for a in b.accessories:
                if OPTION_CARD_RE.match(str(a.get("model"))):
                    bom_c[str(a.get("model"))] += int(a.get("qty") or 0)
        for pid, placed in hits.items():
            b = by_id[pid]
            total = sum(q for _, q, _ in placed)
            riser_cards, bom_cards = venue_cards[(b.venue, b.source_ref.get("job"))]
            cards_agree = all(riser_cards.get(k, 0) == v for k, v in bom_cards.items())
            levels = [c for c, _, _ in placed]
            if total == (b.qty or 0) and cards_agree:
                self.deletions.append(
                    Deletion(
                        pid,
                        f"Placed by the riser: {len(placed)} drafts on levels {', '.join(levels)}",
                    )
                )
                continue
            conf = sorted(
                set(b.conflicts) | {"qty:bom≠riser" if total != (b.qty or 0) else "cards:bom≠riser"}
            )
            self.edit(b, "conflicts", conf)
            self.edit(
                b,
                "source_ref",
                {
                    **b.source_ref,
                    "riser": {"levels": levels, "qty": total, "cards": dict(riser_cards)},
                },
            )
            self.findings.append(
                {
                    "check": "pooled_total",
                    "model": b.model,
                    "venue": b.venue,
                    "bom": b.qty,
                    "riser": total,
                    "levels": levels,
                }
            )
            for d in self.drafts:
                if d.source_ref.get("bom", {}).get("draft_id") == str(pid):
                    d.conflicts.append(
                        "qty:bom≠riser" if total != (b.qty or 0) else "cards:bom≠riser"
                    )

    # ----------------------------------------------------------- master

    def run_master(self) -> None:
        """The riser's count per (level, model family) vs the project's devices (D30): a
        difference is a `source_conflict` review item on the draft."""
        if not self.t.master:
            return
        master: dict[tuple[str, str], int] = defaultdict(int)
        for m in self.t.master:
            key = self.master_key(m.device)
            master[(m.level_code, key)] += 1
            if m.level_code.endswith("M"):
                master[(m.level_code[:-1], key)] += 1  # the mezzanine is the riser's band 06
        riser: dict[tuple[str, str], list[Device]] = defaultdict(list)
        for sheet in self.riser.sheets:
            for d in sheet.devices:
                if d.band.level_code:
                    riser[(d.band.level_code, self.master_key(d.name or d.model))].append(d)
        bom_by_id = {b.id: b for b in self.t.bom}
        surveyed = {m.level_code.rstrip("M") for m in self.t.master}
        for (code, key), devs in riser.items():
            qty = sum(d.qty for d in devs)
            if code not in self.t.levels or code.rstrip("M") not in surveyed:
                continue  # a floor the master has not surveyed has nothing to differ from
            have = master.get((code, key), 0)
            if have == qty:
                continue
            d0 = devs[0]
            bom_qty = None
            if d0.bom_ids:
                bom_qty = sum((bom_by_id[i].qty or 0) for i in d0.bom_ids if i in bom_by_id)
            self.conflicts.append(
                Conflict(self.t.levels.get(code), code, d0.model, qty, have, bom_qty, d0.draft_id)
            )

    def master_key(self, text: str) -> str:
        """A panel or rack by its name (the master's Device text), anything else by model."""
        t = text.strip()
        if PANEL_RE.match(t.upper()) or bx._key(t) == bx._key(RACK_NAME):
            return t.upper()
        return model_key(bx.normalise_model(riser_model(t), self.norm).model)

    # ----------------------------------------------------------- cables

    def run_cables(self) -> None:
        for sheet in self.riser.sheets:
            for band in sheet.bands:
                level_id, code = self.level_of(band)
                devs = {d.id: d for d in sheet.band_devices(band)}
                for b in sheet.band_bubbles(band):
                    if not b.merged_into:  # the run's other end (T107)
                        self.cable(sheet, band, level_id, code, devs, b)
                for ln in sheet.band_lines(band):
                    self.cable(sheet, band, level_id, code, devs, ln)

    def cable(
        self,
        sheet: Sheet,
        band: Band,
        level_id: Any,
        code: str | None,
        devs: dict[str, Device],
        b: Bubble | Line,
    ) -> None:
        """One `draft_cable` per run (a bubble not `merged_into` another, D206), and per line
        with no bubble (D192): `code` null,
        conflict `code:unknown`, the guess as a `{side: code}` candidate — never the code."""
        line = isinstance(b, Line)
        conflicts: list[str] = []
        candidates: list[dict[str, Any]] = []
        from_label = b.from_label
        to_label = b.to_label
        to_level_id = None
        to_level_code = b.to_level_code
        confidence = b.confidence
        extraction = "model" if b.endpoint_source == "model" or b.extraction == "model" else "text"
        frm = devs.get(b.from_device or "")
        trace: dict[str, Any] = {}
        if isinstance(b, Bubble) and b.endpoint_source == "trace":
            trace["traced"] = True
            if b.twin is not None:
                trace["twin"] = {"bubble": b.twin.id, "band": b.twin.band.key, "bbox": b.twin.bbox}
        if b.output_label:
            # the rack's output stack: from the rack, to the printed label
            rack = next((d for d in devs.values() if d.role == bx.ROLE_RACK), None)
            frm = frm or rack
            to_label, to_level_code, far = self.resolve_label(b.output_label)
            if far:
                candidates.append({"side": "to", **far, "confidence": LABEL_CONFIDENCE})
            confidence = max(confidence, LABEL_CONFIDENCE)
            extraction = "text" if sheet.has_text else "model"
        if frm is not None:
            from_label = frm.name or frm.label
            candidates.append(
                {
                    "side": "from",
                    "kind": "draft_device",
                    "id": str(frm.draft_id),
                    "label": from_label,
                    "confidence": round(confidence, 3),
                }
            )
        to = devs.get(b.to_device or "")
        far_ref = b.to_ref if isinstance(b, Bubble) else None
        if to is not None:
            to_label = to.name or to.label
            to_level_code = code
            candidates.append(
                {
                    "side": "to",
                    "kind": "draft_device",
                    "id": str(to.draft_id),
                    "label": to_label,
                    "confidence": round(confidence, 3),
                }
            )
        elif far_ref is not None and far_ref.draft_id is not None:
            # a device on another band, reached by the trace or named by the model (T107)
            to_label = far_ref.name or far_ref.label
            to_level_code = far_ref.band.level_code
            candidates.append(
                {
                    "side": "to",
                    "kind": "draft_device",
                    "id": str(far_ref.draft_id),
                    "label": to_label,
                    "confidence": round(confidence, 3),
                }
            )
        elif to_label and not any(c["side"] == "to" for c in candidates):
            label, lvl, far = self.resolve_label(to_label, to_level_code)
            to_label, to_level_code = label, lvl or to_level_code
            if far:
                candidates.append({"side": "to", **far, "confidence": round(confidence, 3)})
        if to_level_code:
            to_level_id = self.t.levels.get(to_level_code)
            if to_level_id is None and not any(
                c["side"] == "to" and c["kind"] == "placeholder" for c in candidates
            ):
                pid = self.placeholder(f"Level {to_level_code}", "level_not_in_scope")
                candidates.append(
                    {
                        "side": "to",
                        "kind": "placeholder",
                        "id": str(pid),
                        "label": f"Level {to_level_code}",
                        "confidence": round(confidence, 3),
                    }
                )
        if isinstance(b, Line):
            conflicts.append("code:unknown")
            if b.guess:
                candidates.append(
                    {
                        "side": "code",
                        "value": b.guess,
                        "confidence": round(b.guess_confidence, 3),
                        "source": b.guess_source,
                        **({"reason": b.guess_reason} if b.guess_reason else {}),
                    }
                )
                # the library's far end for that code (D194): an accepted line meets R2c / R2d;
                # a load-circuit line's is the fixtures (D221)
                load = b.guess_reason == "load"
                far_end = LOAD_PLACEHOLDER if load else GUESS_PLACEHOLDERS.get(b.guess)
                if far_end and frm is not None and not any(c["side"] == "to" for c in candidates):
                    candidates.append(
                        {
                            "side": "to",
                            "kind": "placeholder",
                            "id": str(self.placeholder(*far_end)),
                            "label": far_end[0],
                            "confidence": round(b.guess_confidence, 3),
                        }
                    )
                    to_label = to_label or far_end[0]
        if frm is None or (to is None and not to_label):
            conflicts.append("endpoint:unresolved")
        if confidence < LOW_CONFIDENCE:
            conflicts.append("endpoint:low_confidence")
        if b.endpoint_source is None and not b.output_label:
            conflicts.append("endpoint:unresolved")
        ref = (
            self.source_ref(
                sheet, band, b.bbox, "riser_line", label=b.label, line=b.id, note=b.note
            )
            if line
            else self.source_ref(
                sheet,
                band,
                b.bbox,
                "riser_bubble",
                label=b.output_label,
                bubble=b.id,
                note=b.note,
                **trace,
            )
        )
        self.cables.append(
            CableDraft(
                id=uuid7(),
                level_id=level_id,
                level_code=code,
                code=b.code,
                from_label=from_label,
                to_label=to_label,
                to_level_id=to_level_id,
                candidates=candidates,
                source_ref=ref,
                extraction=extraction,
                confidence=confidence,
                conflicts=conflicts,
            )
        )

    def resolve_label(
        self, text: str, level_hint: str | None = None
    ) -> tuple[str, str | None, dict[str, Any] | None]:
        """A far-end label → (To text, level code, endpoint candidate): a rack / panel on a
        project level, an out-of-scope `Level nn`, or a seed placeholder (PLAN §7.5)."""
        t = re.sub(r"\s+", " ", text.strip().upper())
        for pat, label, kind in RACK_OUTPUT_LABELS:
            if pat.match(t):
                return (
                    label,
                    None,
                    {
                        "kind": "placeholder",
                        "id": str(self.placeholder(label, kind)),
                        "label": label,
                    },
                )
        if m := FIXTURE_RUN_RE.match(t):
            label = fixture_label(m.group("name"))
            return (
                label,
                None,
                {
                    "kind": "placeholder",
                    "id": str(self.placeholder(label, "fixture_run")),
                    "label": label,
                },
            )
        if m := TO_LEVEL_RE.match(t):
            code = bx.norm_level(m.group("level"))
            what = m.group("what")
            kind = {
                "EQUIP RACK": bx.ROLE_RACK,
                "EQUIPMENT RACK": bx.ROLE_RACK,
                "ERN4": bx.ROLE_RACK,
                "RELAY PANEL": bx.ROLE_RELAY,
                "UNISON STATIONS": None,
                "P-NSPS-DIN": bx.ROLE_NSPS,
                "NSPS": bx.ROLE_NSPS,
            }[what]
            if code in self.t.levels:
                target = self.device_on(code, kind) if kind else None
                name = (
                    RACK_NAME
                    if kind == bx.ROLE_RACK
                    else (what.capitalize() if kind else "Stations & Sensors")
                )
                label = f"{name} Level {code}"
                if target is not None and target.draft_id is not None:
                    return (
                        label,
                        code,
                        {
                            "kind": "draft_device",
                            "id": str(target.draft_id),
                            "label": target.name or target.label,
                        },
                    )
                return label, code, None
            pid = self.placeholder(f"Level {code}", "level_not_in_scope")
            return (
                f"Level {code}",
                code,
                {"kind": "placeholder", "id": str(pid), "label": f"Level {code}"},
            )
        if level_hint:
            return text.strip(), level_hint, None
        return text.strip(), None, None

    def device_on(self, code: str, role: str) -> Device | None:
        """The device of `role` on level `code` that a trunk label (TO RELAY PANEL LEVEL 20)
        names (T115: by role, not by the category text)."""
        for sheet in self.riser.sheets:
            for d in sheet.devices:
                if d.band.level_code == code and d.role == role:
                    return d
        return None


def build(riser: Riser, target: Target) -> Result:
    """Devices (merged into the BOM's drafts where they match, D28 / D10), the master
    cross-check (D30), then one `draft_cable` per run (D206) and per line with no bubble."""
    b = _Build(riser, target)
    b.run_devices()
    b.run_master()
    b.run_cables()
    return Result(
        drafts=b.drafts,
        edits=b.edits,
        deletions=b.deletions,
        placeholders=b.placeholders,
        cables=b.cables,
        conflicts=b.conflicts,
        findings=b.findings,
        merged=b.merged,
        split=b.split,
    )
