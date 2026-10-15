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
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

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

U bubbles are chain links between the device types of one level's Unison bus, not runs: never
list them as cables. Answer only in the JSON schema you were given; coordinates are pixels of
the band image; confidence is your own estimate from 0 to 1, below 0.7 when you are guessing."""

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
    category: str | None
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
    endpoint_source: str | None = None  # label | model | none
    note: str | None = None


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

    def band_devices(self, band: Band) -> list[Device]:
        return [d for d in self.devices if d.band is band]

    def band_bubbles(self, band: Band) -> list[Bubble]:
        return [b for b in self.bubbles if b.band is band]


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
        category: str | None,
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
            category=category,
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
        category = bx.CATEGORY_FOUNDRY if model_raw.startswith("UFMP") else bx.CATEGORY_RELAY
        g.add(
            category=category,
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
            category=bx.CATEGORY_RACK,
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
                    category=bx.CATEGORY_NSPS,
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
                cat = bx.category_of(riser_model(raw), bx.Target(levels={})) or bx.category_of(
                    raw, bx.Target(levels={})
                )
                if raw.upper().startswith("P-NSPS"):
                    cat = bx.CATEGORY_NSPS
                label = _text(sorted((r[i], model_tok), key=lambda t: t.x0))
                after = upper[i + 2] if model_tok is r[i + 1] and i + 2 < len(r) else ""
                enclosure = after.startswith("W/ENCL")
                qty = 1 if cat == bx.CATEGORY_NSPS or enclosure else None
                groups.append(
                    g.add(
                        category=cat,
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
                        category=bx.CATEGORY_FOUNDRY,
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
                    category=bx.CATEGORY_EBDK,
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
                        category=bx.CATEGORY_TOUCHSCREEN,
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


def bubbles_of(
    band: Band, words: list[Tok], curves: list[tuple[float, float, float, float]], start: int
) -> tuple[list[Bubble], int]:
    """Lone code tokens ringed by curve fragments; `U` links are counted, not returned."""
    toks = [t for t in words if band.contains(t) and t.text in CODES]
    in_band = [
        c
        for c in curves
        if band.top - BUBBLE_REACH_PT <= c[1] and c[3] <= band.bottom + BUBBLE_REACH_PT
    ]
    out: list[Bubble] = []
    links = 0
    n = start
    for t in sorted(toks, key=lambda t: (t.top, t.x0)):
        x0, y0, x1, y1 = (
            t.x0 - BUBBLE_REACH_PT,
            t.top - BUBBLE_REACH_PT,
            t.x1 + BUBBLE_REACH_PT,
            t.bottom + BUBBLE_REACH_PT,
        )
        frags = sum(1 for c in in_band if c[0] <= x1 and c[2] >= x0 and c[1] <= y1 and c[3] >= y0)
        if frags < BUBBLE_MIN_FRAGMENTS:
            continue
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


# ----------------------------------------------------------------- analyse


def analyse(pdf_bytes: bytes) -> Riser:
    """The deterministic pass over every page: bands, levels, devices, bubbles, output labels."""
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
        links = 0
        if has_text:
            label_levels(bands, words)
            curves = small_curves(pdf_bytes, i)
            n = 0
            for b in bands:
                devices.extend(devices_of(b, words))
                bb, lk = bubbles_of(b, words, curves, n)
                n += len(bb)
                links += lk
                output_labels(b, words, bb)
                bubbles.extend(bb)
        sheets.append(
            Sheet(
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
            )
        )
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
        lines.append("\nDevices on this band (id: label, category, model, qty, [x, y, w, h] px):")
        for d in devices:
            lines.append(
                f"- {d.id}: {d.label} — {d.category or 'Other'}, {d.model}"
                + (f", tag {d.name}" if d.name and d.name != d.label else "")
                + f", qty {d.qty}, {crop.to_px(d.bbox)}"
            )
        lines.append(
            "\nWire bubbles on this band (id: code, [x, y, w, h] px, label printed beside it "
            "if any):"
        )
        for b in bubbles:
            lines.append(
                f"- {b.id}: {b.code}, {crop.to_px(b.bbox)}"
                + (f", label '{b.output_label}'" if b.output_label else "")
            )
        lines.append(
            "\nReturn devices as an empty list (they are known). For every bubble above return "
            "one cable: from_device = the listed device whose line the bubble sits on; to_device "
            "when the other end is a device on this band; otherwise to_label (the printed far-end "
            "text, or Equipment rack / Relay panel / NSPS) with to_level_code read from the "
            "overview — trunk lines run between bands and are labelled at their ends. A bubble "
            "beside a rack output label goes from the rack to that label. Add a cable for any run "
            "bubble you see that is not listed (new ids), never for U bubbles."
        )
    else:
        lines.append(
            "\nThis sheet has no text layer. Read the band: level_code from its LEVEL label; "
            "every device symbol with its printed label, model, panel tag, QTY: count and box in "
            "pixels; every wire bubble (X, N, NG, F, P, UV — not U) with its box and endpoints as "
            "above. Use new-1, new-2 … as device ids and new-b1, new-b2 … as bubble ids."
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
            cat = item.get("category")
            if cat == "Other":
                cat = bx.category_of(riser_model(raw), bx.Target(levels={}))
            name = item.get("name") or None
            if cat == bx.CATEGORY_RACK and not name:
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
        if b is None:
            if sheet.has_text and bid in by_id:
                continue
            b = Bubble(
                id=bid or f"new-b{len(by_id) + 1}",
                band=band,
                code=code,
                bbox=crop.to_pt(list(item.get("bbox") or [])),
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
        b.note = item.get("note") or None
        if b.output_label and b.endpoint_source == "label":
            # the printed label is the truth; the model only confirms the near end
            b.confidence = max(b.confidence, LABEL_CONFIDENCE)
        else:
            b.confidence = conf
            b.endpoint_source = "model"


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
    code: str
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
            "cables_by_code": dict(sorted(_count(c.code for c in self.cables).items())),
            "endpoints_low_confidence": sum(
                1 for c in self.cables if c.confidence < LOW_CONFIDENCE
            ),
            "endpoints_unresolved": sum(
                1 for c in self.cables if "endpoint:unresolved" in c.conflicts
            ),
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

    def bom_on(self, level_code: str, key: str, category: str | None) -> list[BomDraft]:
        """The BOM's drafts of this model family on the level — and on its mezzanine for a
        panel-class device (the BOM's `Level 5` rack is the master's 06M, the riser's band 06)."""
        codes = {level_code}
        if category in bx.PANEL_CATEGORIES and (mezz := self.t.split_level(level_code)):
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
                ebdk = sum(d.qty for d in devs if d.category == bx.CATEGORY_EBDK)
                erp = sum(1 for d in devs if d.category == bx.CATEGORY_RELAY)
                n_runs = any(b.code in ("N", "NG") for b in sheet.band_bubbles(band))
                for d in devs:
                    m = bx.normalise_model(d.model, self.norm)
                    key = model_key(m.model)
                    conflicts = list(m.conflicts)
                    if (
                        code
                        and d.category in bx.PANEL_CATEGORIES
                        and (mezz := self.t.split_level(code))
                    ):
                        conflicts.append(f"level:{code}/{mezz}")
                    if d.category == bx.CATEGORY_EBDK and ebdk != erp:
                        conflicts.append("pairing:ebdk≠erp")
                        self.findings.append(
                            {"check": "ebdk_erp_pairing", "level": code, "ebdk": ebdk, "erp": erp}
                        )
                    if d.category in (bx.CATEGORY_NSPS, bx.CATEGORY_RACK) and not n_runs:
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
                    same_level = self.bom_on(code, key, d.category) if code else []
                    if same_level:
                        self.merge(d, same_level, riser_ref, conflicts)
                        continue
                    pooled = self.pooled_for(code, key) if code else []
                    draft = DeviceDraft(
                        id=uuid7(),
                        level_id=level_id,
                        level_code=code,
                        model=m.model,
                        model_raw=d.model_raw,
                        candidates=m.candidates,
                        name=d.name,
                        category=d.category,
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
        if d.category != bx.CATEGORY_RELAY:
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
                    self.cable(sheet, band, level_id, code, devs, b)

    def cable(
        self,
        sheet: Sheet,
        band: Band,
        level_id: Any,
        code: str | None,
        devs: dict[str, Device],
        b: Bubble,
    ) -> None:
        conflicts: list[str] = []
        candidates: list[dict[str, Any]] = []
        from_label = b.from_label
        to_label = b.to_label
        to_level_id = None
        to_level_code = b.to_level_code
        confidence = b.confidence
        extraction = "model" if b.endpoint_source == "model" or b.extraction == "model" else "text"
        frm = devs.get(b.from_device or "")
        if b.output_label:
            # the rack's output stack: from the rack, to the printed label
            rack = next((d for d in devs.values() if d.category == bx.CATEGORY_RACK), None)
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
        if frm is None or (to is None and not to_label):
            conflicts.append("endpoint:unresolved")
        if confidence < LOW_CONFIDENCE:
            conflicts.append("endpoint:low_confidence")
        if b.endpoint_source is None and not b.output_label:
            conflicts.append("endpoint:unresolved")
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
                source_ref=self.source_ref(
                    sheet,
                    band,
                    b.bbox,
                    "riser_bubble",
                    label=b.output_label,
                    bubble=b.id,
                    note=b.note,
                ),
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
                "EQUIP RACK": bx.CATEGORY_RACK,
                "EQUIPMENT RACK": bx.CATEGORY_RACK,
                "ERN4": bx.CATEGORY_RACK,
                "RELAY PANEL": bx.CATEGORY_RELAY,
                "UNISON STATIONS": None,
                "P-NSPS-DIN": bx.CATEGORY_NSPS,
                "NSPS": bx.CATEGORY_NSPS,
            }[what]
            if code in self.t.levels:
                target = self.device_on(code, kind) if kind else None
                name = (
                    RACK_NAME
                    if kind == bx.CATEGORY_RACK
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

    def device_on(self, code: str, category: str | None) -> Device | None:
        for sheet in self.riser.sheets:
            for d in sheet.devices:
                if d.band.level_code == code and d.category == category:
                    return d
        return None


def build(riser: Riser, target: Target) -> Result:
    """Devices (merged into the BOM's drafts where they match, D28 / D10), the master
    cross-check (D30), then one `draft_cable` per run bubble."""
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
