"""BOM extraction (T42, PLAN §7.2, D5, D9, D10, D12, D27, D28): a BOM PDF → BOM lines →
`draft_device` proposals, accessory lines and excluded lines.

Pure functions over PDF bytes and a `Target` (the project's levels and vocabulary) — no database,
no object store — so the whole pass is testable on `fixtures/BOM.pdf` and
`fixtures/15090056-BOM.pdf`.

Two BOM formats are read (Phase 1f, Phase 1 §4):

- the **submittal BOM** (ETC "BOM-n" drawings): a table per job with columns `Line Item · Part
  Number · Part Description · Model · Quantity (value)`, grouped by `VENUE` rows naming a floor
  (`Level 1`, `FLOOR 3`, `Floor B2`) or a pool (`Level B2 - 12`, `Level 16, 22`, `Link to P-CCS
  in other building`). A page may carry two tables side by side.
- the **Material List** (ETC order form, scanned): `Item · Material · Quantity`, one item over
  two or three rows (`part number · qty EA`, `Model: …`, description), with `Line 270 delivers for
  line 260` sub-item notes. No venue: every draft is in the project pool (`level_id` null).

Words come from the text layer (`pdfplumber`, `dedupe_chars` for the doubled title-block
glyphs) or, for a page whose table has no text layer, from `app.ocr` (tesseract at 300 dpi); both
give boxes in PDF points, and column **bands** are derived from the header words of each table,
so one row parser serves both. Every line keeps its `source_ref` (`job`, `page`, `line`,
`bbox`) and `extraction` (`text` | `ocr`).

Classification (`build`):

- ETC lighting-control **devices** become drafts: category from the project's device-type
  library (`library_type.model` / `aliases`, D183 (4)) first, then `MODEL_CATEGORY`.
- **Accessories** (faceplates, ERP option cards, through-beam parts, touchscreen backboxes, DIN
  enclosures…, `ACCESSORY_PARENT`) attach to the nearest parent line of the right model in the
  same venue (preceding first), as `accessories[]` on its draft (D27).
- An **Equipment rack** venue (an `18U RACK` or `ERn4` enclosure line) folds every following
  component line of the venue into one draft, components in `accessories[]` with `role:
  component` (PLAN §7.2); the rack's model is the ERn4 enclosure's when it has one (the master's
  naming), else the rack line's.
- Everything else (energisation, engineering, manuals, data termination, hardware kits, brackets,
  breakers, boxes, cable…) is **excluded** with a reason and stays in the batch stats, promotable
  by hand (D12).
- Models are normalised by `vocab(model_map)` (D9): the colour / finish suffix (`-4Z`, `-4`,
  `-5`) is stripped, `P-DOC-W-WD` → `P-DOC-W`, `P-NSPS-D-KIT` → `P-NSPS-D`; a small-range sensor
  (`P-DOC-C-SR`) keeps both `SR` and `LR` as candidates with a conflict for the reviewer (D28).
- Levels: a venue naming one floor → that level (`vocab(level_alias)` first: `Level 5` → 06M); a
  pooled venue → `level_id` null, `level_basis` `pooled_venue`, confidence halved (the riser
  places them, D10); a floor the project does not have → null, `level_not_in_project`.
"""

from __future__ import annotations

import io
import re
import statistics
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pdfplumber

from app.ocr import Word

# ----------------------------------------------------------------- constants

TEXT_CONFIDENCE = 0.95
"""A line read from the text layer."""

OCR_CONFIDENCE_CAP = 0.9
"""An OCR line's confidence is tesseract's mean word confidence, never above this."""

POOLED_FACTOR = 0.5
"""A pooled venue halves a draft's confidence (Phase 1f §2)."""

ROW_GAP_PT = 4.0
"""Words whose vertical centres differ by less than this are on one row."""

COLUMN_MARGIN_PT = 5.0
"""A column's words may start this far left of its header word (OCR box jitter, the header's
bolder face); the gaps between columns are several times wider."""

QTY_MARGIN_PT = 6.0
"""A quantity may start this far left of its header (right-aligned numbers, OCR box jitter)."""

SUBMITTAL_HEADER = ("Line", "Item", "Part", "Number", "Part", "Description", "Model", "Quantity")
MATERIAL_HEADER = ("Item", "Material", "Quantity")

SUFFIX_RE = re.compile(r"^(?P<base>.+?)-(?:4Z|4|5)$")
"""ETC colour / finish suffixes the master never carries (D9)."""

DEFAULT_MODEL_MAP: dict[str, str] = {
    "P-DOC-W-WD": "P-DOC-W",  # the master's wall occupancy sensor
    "P-NSPS-D-KIT": "P-NSPS-D",  # the kit = the NSPS + a DIN8 enclosure
}
"""Built-in `model_map` (PLAN §7.2); project `vocab(model_map)` rows add to it."""

SR_LR_RE = re.compile(r"^(?P<base>P-DOC-C)-(?P<range>SR|LR)$")
"""Small-range vs large-range ceiling sensor: both candidates, a human decides (D28)."""

DEFAULT_LEVEL_ALIAS: dict[str, str] = {"LEVEL 5": "06M"}
"""Built-in `level_alias` (PLAN §7.2, the Tower's BOM calls the 06M rack venue `Level 5`);
applied only when the project has the target level. Project `vocab(level_alias)` rows add to it."""

CATEGORY_RELAY = "Relay panel"
CATEGORY_FOUNDRY = "Foundry panel"
CATEGORY_EBDK = "EBDK"
CATEGORY_RACK = "Equipment rack"
CATEGORY_NSPS = "NSPS"
CATEGORY_TOUCHSCREEN = "Touchscreen"
CATEGORY_STATION = "Station"
CATEGORY_SENSOR = "Sensor"

MODEL_CATEGORY: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^ERP\d+"), CATEGORY_RELAY),
    (re.compile(r"^UFMP\d"), CATEGORY_FOUNDRY),
    (re.compile(r"^EBDK"), CATEGORY_EBDK),
    (re.compile(r"^P-NSPS"), CATEGORY_NSPS),
    (re.compile(r"^P-TS\d"), CATEGORY_TOUCHSCREEN),
    (re.compile(r"^P-LCD(?!-FBB)"), CATEGORY_TOUCHSCREEN),
    (re.compile(r"^ETS-\d"), CATEGORY_TOUCHSCREEN),  # EchoTouch
    (re.compile(r"^PI\d{4}"), CATEGORY_STATION),  # Paradigm Inspire
    (re.compile(r"^EPS\d+(?!-FP)"), CATEGORY_STATION),  # Echo preset station
    (re.compile(r"^P-DOC"), CATEGORY_SENSOR),
    (re.compile(r"^P-LS\b"), CATEGORY_SENSOR),
    (re.compile(r"^UHCI"), CATEGORY_SENSOR),  # partition sensor interface
]
"""Built-in model → category (CLAUDE.md §3); the project's library types come first."""

RACK_ROOT_RE = re.compile(r"^(?:\d+U RACK|ERN4)")
"""A line that opens an Equipment rack: the rack itself or an ERn4 enclosure (wall mount)."""

PANEL_CATEGORIES = frozenset(
    {CATEGORY_RELAY, CATEGORY_FOUNDRY, CATEGORY_EBDK, CATEGORY_RACK, CATEGORY_NSPS}
)
"""Categories the master keeps on the mezzanine (06M) when a floor is split (Phase 1f §4)."""

ACCESSORY_PARENT: list[tuple[re.Pattern[str], re.Pattern[str]]] = [
    # Inspire faceplate → station, or the switch-mount sensor that shares the gang
    (re.compile(r"^1IFP"), re.compile(r"^PI\d{4}|^P-DOC-SM")),
    (re.compile(r"^EPS\d+-FP"), re.compile(r"^EPS\d+")),  # Echo faceplate → preset station
    (re.compile(r"^ERP-FT-LVD$|^ERP-RTO$"), re.compile(r"^ERP\d+")),  # option cards
    (re.compile(r"^AD-C18"), re.compile(r"^UHCI")),  # through-beam emitter / receiver
    (re.compile(r"^P-LCD-FBB"), re.compile(r"^P-TS\d|^P-LCD")),  # touchscreen backbox
    (re.compile(r"^DIN14"), re.compile(r"^P-NSPS")),  # DIN enclosure
    (re.compile(r"^ERM[ -]VDK"), re.compile(r"^UFMP|^ERP\d+")),  # Echo divider kit
    (re.compile(r"^URTO"), re.compile(r"^ERN4|^\d+U RACK|^P-ACP")),  # Unison ride-thru
]
"""Accessory model → the model its parent line must match (D27)."""

EXCLUDED_PART_RE = re.compile(r"^(?:ENERGIZATION|ENGINEERING|DATA|PROJECT)$")
"""Service lines: the part number is a word, not an ETC part."""

EXCLUDED_DESCRIPTION: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"HARDWARE KIT"), "hardware kit"),
    (re.compile(r"\bBRACKET\b"), "bracket"),
]


# -------------------------------------------------------------------- lines


@dataclass
class Line:
    """One BOM row (a `VENUE` row or an item)."""

    page: int
    line: int
    part_number: str
    description: str
    model: str
    qty: int | None
    bbox: tuple[float, float, float, float]
    extraction: str
    confidence: float
    job: str | None = None
    venue: str | None = None
    kind: str = "item"  # item | venue
    column: int = 0
    # Material List: the line this one "delivers for" (a sub-item of)
    delivers_for: int | None = None

    @property
    def model_text(self) -> str:
        return self.model or self.part_number

    def source_ref(self) -> dict[str, Any]:
        return {
            "kind": "bom_line",
            "job": self.job,
            "page": self.page,
            "line": self.line,
            "bbox": [round(v, 1) for v in self.bbox],
            "venue": self.venue,
        }


@dataclass
class PageWords:
    page: int
    words: list[Word]
    extraction: str  # text | ocr


def page_count(pdf_bytes: bytes) -> int:
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        return len(pdf.pages)


def text_words(pdf_bytes: bytes, page_index: int) -> list[Word]:
    """The page's text-layer words (deduped: pp.4–6 of the BOM print two title blocks)."""
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[page_index].dedupe_chars()
        return [
            Word(
                text=w["text"],
                x0=float(w["x0"]),
                top=float(w["top"]),
                x1=float(w["x1"]),
                bottom=float(w["bottom"]),
            )
            for w in page.extract_words(keep_blank_chars=False, use_text_flow=False)
            if w["text"].strip()
        ]


OcrFn = Callable[[bytes, int], list[Word]]
"""`app.ocr.ocr_page(pdf_bytes, page_index)`."""


def read_pages(pdf_bytes: bytes, ocr: OcrFn | None) -> list[PageWords]:
    """Words per page: the text layer when it carries a table header, else OCR (`ocr` is
    `app.ocr.ocr_page`; `None` raises `NeedsOcr` for such a page)."""
    out: list[PageWords] = []
    for i in range(page_count(pdf_bytes)):
        words = text_words(pdf_bytes, i)
        if _has_header(words):
            out.append(PageWords(i + 1, words, "text"))
            continue
        if ocr is None:
            raise NeedsOcr(i + 1)
        # the title block text (job number…) still counts when the table did not
        out.append(PageWords(i + 1, [*words, *ocr(pdf_bytes, i)], "ocr"))
    return out


def _has_header(words: list[Word]) -> bool:
    return bool(_headers(words, SUBMITTAL_HEADER) or _headers(words, MATERIAL_HEADER))


class NeedsOcr(Exception):
    def __init__(self, page: int):
        super().__init__(f"page {page} has no text layer for its table and no OCR is available")
        self.page = page


# ------------------------------------------------------------------- tables


@dataclass
class Table:
    """One table on a page: its header words and the column bands they define."""

    kind: str  # submittal | material
    x0: float
    x1: float
    top: float
    bands: dict[str, tuple[float, float]]
    conf: float = 1.0


def rows_of(words: list[Word], gap: float = ROW_GAP_PT) -> list[list[Word]]:
    """Group words into rows by their vertical centre, each row sorted left to right. A word
    joins the row whose mean centre is within `gap`; comparing to the mean (not the last word)
    keeps OCR box jitter on a long row from chaining into the next row."""
    rows: list[list[Word]] = []
    centres: list[float] = []
    for w in sorted(words, key=lambda w: ((w.top + w.bottom) / 2, w.x0)):
        c = (w.top + w.bottom) / 2
        if rows and c - centres[-1] < gap:
            rows[-1].append(w)
            centres[-1] += (c - centres[-1]) / len(rows[-1])
        else:
            rows.append([w])
            centres.append(c)
    return [sorted(r, key=lambda w: w.x0) for r in rows]


def _headers(words: list[Word], header: tuple[str, ...]) -> list[list[Word]]:
    """Every occurrence of `header` as consecutive words on one row (two tables → two). An
    OCR'd header word may lose letters at either end (`Quantit`, `tem`): a prefix or suffix of
    at least three letters missing at most two counts."""
    found: list[list[Word]] = []
    n = len(header)
    for row in rows_of(words):
        for i in range(len(row) - n + 1):
            if all(_header_word(row[i + k].text, header[k]) for k in range(n)):
                found.append(row[i : i + n])
    return found


def _header_word(text: str, expected: str) -> bool:
    t = re.sub(r"[^A-Za-z()]", "", text)
    if t == expected:
        return True
    clipped = len(t) >= max(3, len(expected) - 2)
    return clipped and (expected.startswith(t) or expected.endswith(t))


def tables_of(words: list[Word]) -> list[Table]:
    """The tables on a page from their header rows; each spans from its first header word to the
    next table's (or a margin past its last header word)."""
    tables: list[Table] = []
    for hdr in _headers(words, SUBMITTAL_HEADER):
        line_item, _, part_number, _, part_desc, _, model, quantity = hdr
        m = COLUMN_MARGIN_PT
        tables.append(
            Table(
                kind="submittal",
                x0=line_item.x0 - m,
                x1=quantity.x1 + 60,
                top=line_item.bottom,
                bands={
                    "line": (line_item.x0 - m, part_number.x0 - m),
                    "part_number": (part_number.x0 - m, part_desc.x0 - m),
                    "description": (part_desc.x0 - m, model.x0 - m),
                    "model": (model.x0 - m, quantity.x0 - QTY_MARGIN_PT),
                    "qty": (quantity.x0 - QTY_MARGIN_PT, quantity.x1 + 60),
                },
                conf=statistics.fmean(w.conf for w in hdr),
            )
        )
    for hdr in _headers(words, MATERIAL_HEADER):
        item, material, quantity = hdr
        m = COLUMN_MARGIN_PT
        tables.append(
            Table(
                kind="material",
                x0=item.x0 - m,
                x1=quantity.x1 + 120,
                top=item.bottom,
                bands={
                    "line": (item.x0 - m, material.x0 - m),
                    "material": (material.x0 - m, quantity.x0 - QTY_MARGIN_PT),
                    "qty": (quantity.x0 - QTY_MARGIN_PT, quantity.x1 + 120),
                },
                conf=statistics.fmean(w.conf for w in hdr),
            )
        )
    tables.sort(key=lambda t: t.x0)
    for a, b in zip(tables, tables[1:], strict=False):
        a.x1 = min(a.x1, b.x0 - 1)
    return tables


def _in_band(row: list[Word], band: tuple[float, float]) -> list[Word]:
    x0, x1 = band
    return [w for w in row if w.x0 >= x0 and w.x0 < x1]


def _text(words: list[Word]) -> str:
    return " ".join(w.text for w in words)


def _int(text: str) -> int | None:
    t = text.strip().replace(",", "")
    if re.fullmatch(r"\d+(?:\.0+)?", t):
        return int(float(t))
    return None


def _bbox(words: list[Word]) -> tuple[float, float, float, float]:
    return (
        min(w.x0 for w in words),
        min(w.top for w in words),
        max(w.x1 for w in words),
        max(w.bottom for w in words),
    )


JOB_NUMBER_RE = re.compile(r"\d{6,}")


def job_number(words: list[Word]) -> str | None:
    """`JOB# 15076538` (submittal) or `Order # 15090056` (Material List) on the page: the first
    long number after a `JOB#` / `ORDER #` label on its row."""
    for row in rows_of(words):
        texts = [w.text.upper() for w in row]
        for i, t in enumerate(texts):
            order = t == "ORDER" and i + 1 < len(texts) and texts[i + 1] == "#"
            if t in ("JOB#", "ORDER#") or order:
                for later in texts[i + 1 :]:
                    if JOB_NUMBER_RE.fullmatch(later):
                        return later
    return None


OCR_MODEL_FIXES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^P1(\d{4})"), r"PI\1"),  # Phase 1f: `P11002` → `PI1002`
    (re.compile(r"^PL(\d{4})"), r"PI\1"),
    (re.compile(r"O(?=\d)"), "0"),  # a letter O before a digit is a zero (`EPSO5` → `EPS05`)
    (re.compile(r"-42Z$"), "-4Z"),  # the `Z` of `-4Z` read twice
    (re.compile(r"[.,;:]+$"), ""),  # a speck after the model
]


def fix_ocr_model(text: str) -> str:
    for pat, rep in OCR_MODEL_FIXES:
        text = pat.sub(rep, text.strip())
    return text.strip()


def parse_page(pw: PageWords, fallback: list[Table] | None = None) -> list[Line]:
    """Every BOM row on the page, in reading order (left table first). A page whose header the
    OCR missed uses `fallback`, a sibling page's tables (the Material List repeats its layout on
    every page)."""
    tables = tables_of(pw.words) or list(fallback or [])
    if not tables:
        return []
    job = job_number(pw.words)
    lines: list[Line] = []
    for column, table in enumerate(tables):
        in_table = [w for w in pw.words if table.x0 <= w.x0 < table.x1 and w.top > table.top]
        if table.kind == "submittal":
            lines.extend(_submittal_lines(pw, table, in_table, job, column))
        else:
            lines.extend(_material_lines(pw, table, in_table, job, column))
    return lines


def _row_confidence(pw: PageWords, row: list[Word]) -> float:
    if pw.extraction == "text":
        return TEXT_CONFIDENCE
    return min(OCR_CONFIDENCE_CAP, statistics.fmean(w.conf for w in row))


def _submittal_lines(
    pw: PageWords, table: Table, words: list[Word], job: str | None, column: int
) -> list[Line]:
    lines: list[Line] = []
    venue: str | None = None
    for row in rows_of(words):
        number = _int(_text(_in_band(row, table.bands["line"])))
        if number is None:
            continue  # a title-block fragment or a wrapped word: not a BOM row
        part = _text(_in_band(row, table.bands["part_number"]))
        desc = _text(_in_band(row, table.bands["description"]))
        model = _text(_in_band(row, table.bands["model"]))
        qty_words = _in_band(row, table.bands["qty"])
        qty = _int(qty_words[0].text) if qty_words else None
        if pw.extraction == "ocr":
            model = fix_ocr_model(model)
            part = fix_ocr_model(part)
        conf = _row_confidence(pw, row)
        if part.upper() == "VENUE":
            venue = desc
            lines.append(
                Line(
                    page=pw.page,
                    line=number,
                    part_number=part,
                    description=desc,
                    model=model,
                    qty=qty,
                    bbox=_bbox(row),
                    extraction=pw.extraction,
                    confidence=conf,
                    job=job,
                    venue=None,
                    kind="venue",
                    column=column,
                )
            )
            continue
        lines.append(
            Line(
                page=pw.page,
                line=number,
                part_number=part,
                description=desc,
                model=model,
                qty=qty,
                bbox=_bbox(row),
                extraction=pw.extraction,
                confidence=conf,
                job=job,
                venue=venue,
                column=column,
            )
        )
    return lines


DELIVERS_RE = re.compile(r"^Line\s+(\d+)\s+delivers\s+for\s+line\s+(\d+)", re.IGNORECASE)
SUB_ITEMS_RE = re.compile(r"^Sub-items", re.IGNORECASE)


def _material_lines(
    pw: PageWords, table: Table, words: list[Word], job: str | None, column: int
) -> list[Line]:
    """Material List items: an item row (`20  7131A1075  1.00 EA`) followed by `Model: …` and a
    description row; `Line 270 delivers for line 260` makes 270 a sub-item of 260."""
    lines: list[Line] = []
    current: Line | None = None
    rows = rows_of(words)
    for row in rows:
        line_words = _in_band(row, table.bands["line"])
        number = _int(_text(line_words))
        material = _in_band(row, table.bands["material"])
        text = _text(material)
        if number is not None and material:
            qty_words = _in_band(row, table.bands["qty"])
            qty = _int(qty_words[0].text) if qty_words else None
            current = Line(
                page=pw.page,
                line=number,
                part_number=material[0].text,
                description="",
                model="",
                qty=qty,
                bbox=_bbox(row),
                extraction=pw.extraction,
                confidence=_row_confidence(pw, row),
                job=job,
                venue=None,
                column=column,
            )
            lines.append(current)
            continue
        if current is None or not text:
            continue
        if text.lower().startswith("this is not an invoice") or text.lower().startswith(
            "this transaction"
        ):
            current = None
            continue
        # the row belongs to the open item: widen its box
        current.bbox = (
            min(current.bbox[0], row[0].x0),
            current.bbox[1],
            max(current.bbox[2], max(w.x1 for w in row)),
            max(current.bbox[3], max(w.bottom for w in row)),
        )
        if m := DELIVERS_RE.match(text):
            if int(m.group(1)) == current.line:
                current.delivers_for = int(m.group(2))
            continue
        if SUB_ITEMS_RE.match(text):
            continue
        if text.lower().startswith("model:"):
            model = text[6:].strip()
            if pw.extraction == "ocr":
                model = fix_ocr_model(model)
            current.model = model
            continue
        if text.lower().startswith("ship date"):
            continue
        if not current.description:
            current.description = text
    return lines


def parse(pdf_bytes: bytes, ocr: OcrFn | None) -> tuple[list[Line], list[PageWords]]:
    """Every BOM line of the file in reading order. A venue runs on past a page break: the items
    at the top of a page before its first `VENUE` row belong to the previous page's last venue
    (same job, pp.4–6 of the BOM)."""
    pages = read_pages(pdf_bytes, ocr)
    lines: list[Line] = []
    carried: tuple[str | None, str] | None = None  # (job, venue) open at the end of a page
    tables = {pw.page: tables_of(pw.words) for pw in pages}
    with_header = [p for p, t in tables.items() if t]
    for pw in pages:
        fallback = None
        if not tables[pw.page] and with_header:
            nearest = min(with_header, key=lambda p: abs(p - pw.page))
            fallback = tables[nearest]
        page_lines = parse_page(pw, fallback)
        for ln in page_lines:
            if ln.kind == "venue":
                carried = (ln.job, ln.description)
            elif ln.venue is None and carried is not None and carried[0] == ln.job:
                ln.venue = carried[1]
            elif ln.venue is not None:
                carried = (ln.job, ln.venue)
        lines.extend(page_lines)
    return lines, pages


# ------------------------------------------------------------------- venues

LEVEL_WORD_RE = re.compile(r"^(?:LEVEL|FLOOR)\s+(?P<rest>.+)$", re.IGNORECASE)
LEVEL_CODE_RE = re.compile(r"^(?:B\d|\d{1,2}M?|[A-Z]{1,2}\d?)$", re.IGNORECASE)


def norm_level(code: str) -> str:
    code = code.upper()
    return code.zfill(2) if code.isdigit() else code


@dataclass(frozen=True)
class Venue:
    text: str
    codes: tuple[str, ...]  # normalised level codes named (empty for a pool with no floors)
    pooled: bool  # several floors, a range, or no floor at all


def parse_venue(text: str) -> Venue:
    """`Level 1` → `01`; `Floor B2` → `B2`; `Level B2 - 12`, `Level 16, 22`, `Link to P-CCS in
    other building` → pooled."""
    t = text.strip()
    m = LEVEL_WORD_RE.match(t)
    if not m:
        return Venue(t, (), True)
    rest = m.group("rest").strip()
    if re.search(r"\s-\s|\bTO\b|,", rest, re.IGNORECASE):
        codes = tuple(
            norm_level(p) for p in re.split(r"\s*(?:-|,|\bTO\b)\s*", rest) if LEVEL_CODE_RE.match(p)
        )
        return Venue(t, codes, True)
    if LEVEL_CODE_RE.match(rest):
        return Venue(t, (norm_level(rest),), False)
    return Venue(t, (), True)


# -------------------------------------------------------------- the target


@dataclass
class LibraryModel:
    model: str
    category: str | None
    aliases: tuple[str, ...] = ()


@dataclass
class Target:
    """What the project contributes: its levels, its vocabulary and its device-type library."""

    levels: dict[str, Any]  # level code → level id
    model_map: dict[str, str] = field(default_factory=dict)  # raw → canonical (vocab rows)
    level_alias: dict[str, str] = field(default_factory=dict)  # venue text → level code
    library: list[LibraryModel] = field(default_factory=list)

    def alias_for(self, venue_text: str) -> str | None:
        key = _key(venue_text)
        for table in (self.level_alias, DEFAULT_LEVEL_ALIAS):
            for raw, code in table.items():
                if _key(raw) == key and norm_level(code) in self.levels:
                    return norm_level(code)
        return None

    def mapped(self, model: str) -> str | None:
        key = _key(model)
        for table in (self.model_map, DEFAULT_MODEL_MAP):
            for raw, canonical in table.items():
                if _key(raw) == key:
                    return canonical
        return None

    def library_category(self, model: str) -> str | None:
        key = _key(model)
        for t in self.library:
            if _key(t.model) == key or any(_key(a) == key for a in t.aliases):
                return t.category
        return None


def _key(text: str) -> str:
    return re.sub(r"\s+", "", text).upper()


# --------------------------------------------------------------- normalise


@dataclass
class Model:
    model: str
    raw: str
    candidates: list[str]
    conflicts: list[str]


def normalise_model(raw: str, target: Target) -> Model:
    """Canonical model per D9 / D28: suffix stripped, `model_map` applied, SR / LR both kept."""
    text = raw.strip()
    base = text
    if m := SUFFIX_RE.match(base):
        base = m.group("base")
    mapped = target.mapped(base) or target.mapped(text)
    if mapped:
        base = mapped
    candidates = [base]
    conflicts: list[str] = []
    if m := SR_LR_RE.match(base):
        other = f"{m.group('base')}-{'LR' if m.group('range') == 'SR' else 'SR'}"
        candidates = [base, other]
        conflicts.append("model:SR/LR")
    return Model(model=base, raw=text, candidates=candidates, conflicts=conflicts)


def category_of(model: str, target: Target) -> str | None:
    cat = target.library_category(model)
    if cat:
        return cat
    for pat, name in MODEL_CATEGORY:
        if pat.match(model):
            return name
    return None


def accessory_parent(model: str) -> re.Pattern[str] | None:
    for pat, parent in ACCESSORY_PARENT:
        if pat.match(model):
            return parent
    return None


def exclusion_reason(line: Line, model: str) -> str | None:
    first_word = line.part_number.upper().split(" ")[0] if line.part_number else ""
    if EXCLUDED_PART_RE.match(first_word):
        return "service line"
    for pat, reason in EXCLUDED_DESCRIPTION:
        if pat.search(line.description.upper()):
            return reason
    return None


# ------------------------------------------------------------------ build


@dataclass
class Draft:
    """A `draft_device` row minus the ids the job adds."""

    level_id: Any
    level_code: str | None
    model: str
    model_raw: str
    candidates: list[str]
    category: str | None
    qty: int | None
    accessories: list[dict[str, Any]]
    source_ref: dict[str, Any]
    level_basis: str
    extraction: str
    confidence: float
    conflicts: list[str]
    line: Line

    def row(self) -> dict[str, Any]:
        return {
            "level_id": self.level_id,
            "model": self.model,
            "model_raw": self.model_raw,
            "candidates": self.candidates if len(self.candidates) > 1 else None,
            "name": None,
            "category": self.category,
            "qty": self.qty,
            "accessories": self.accessories or None,
            "source_ref": {**self.source_ref, "level_code": self.level_code},
            "level_basis": self.level_basis,
            "extraction": self.extraction,
            "confidence": round(self.confidence, 3),
            "conflicts": self.conflicts or None,
            "state": "proposed",
        }


@dataclass
class Excluded:
    line: Line
    model: str
    reason: str

    def out(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "model": self.model,
            "part_number": self.line.part_number,
            "description": self.line.description,
            "qty": self.line.qty,
            "source_ref": self.line.source_ref(),
            "extraction": self.line.extraction,
        }


@dataclass
class Result:
    drafts: list[Draft]
    excluded: list[Excluded]
    accessory_lines: int
    component_lines: int
    venues: list[Venue]

    def stats(self) -> dict[str, Any]:
        by_level: dict[str, int] = {}
        for d in self.drafts:
            by_level[d.level_code or "(pool)"] = by_level.get(d.level_code or "(pool)", 0) + 1
        return {
            "drafts": len(self.drafts),
            "racks": sum(1 for d in self.drafts if d.category == CATEGORY_RACK),
            "accessory_lines": self.accessory_lines,
            "component_lines": self.component_lines,
            "excluded": len(self.excluded),
            "venues": len(self.venues),
            "pooled_venues": sum(1 for v in self.venues if v.pooled),
            "drafts_by_level": dict(sorted(by_level.items())),
            "flagged": sum(1 for d in self.drafts if d.conflicts or d.confidence < 0.7),
        }


def _accessory_entry(line: Line, model: Model, role: str) -> dict[str, Any]:
    return {
        "model": model.model,
        "model_raw": model.raw,
        "qty": line.qty,
        "role": role,
        "description": line.description,
        "source_ref": line.source_ref(),
        "extraction": line.extraction,
        "confidence": round(line.confidence, 3),
    }


def build(lines: list[Line], target: Target) -> Result:
    """Lines → drafts, accessories folded into their parents, excluded lines."""
    venues: list[Venue] = []
    drafts: list[Draft] = []
    excluded: list[Excluded] = []
    accessory_lines = 0
    component_lines = 0

    # Group item lines by (job, venue) in reading order; the Material List has one group.
    groups: dict[tuple[str | None, str | None], list[Line]] = {}
    for ln in lines:
        if ln.kind == "venue":
            venues.append(parse_venue(ln.description))
            continue
        groups.setdefault((ln.job, ln.venue), []).append(ln)

    for (_job, venue_text), items in groups.items():
        venue = parse_venue(venue_text) if venue_text is not None else None
        models = {id(ln): normalise_model(ln.model_text, target) for ln in items}
        parents: list[tuple[Line, Draft]] = []
        pending: list[tuple[Line, Model, re.Pattern[str]]] = []
        rack: Draft | None = None
        by_line = {ln.line: ln for ln in items}

        for ln in items:
            model = models[id(ln)]
            if reason := exclusion_reason(ln, model.model):
                excluded.append(Excluded(ln, model.model, reason))
                continue
            parent_pat = accessory_parent(model.model)
            if parent_pat is not None:
                pending.append((ln, model, parent_pat))
                continue
            # Material List sub-items (`Line 270 delivers for line 260`) are accessories too
            if ln.delivers_for is not None and ln.delivers_for in by_line:
                parent_line = by_line[ln.delivers_for]
                parent_draft = next((d for p, d in parents if p is parent_line), None)
                if parent_draft is not None:
                    parent_draft.accessories.append(_accessory_entry(ln, model, "accessory"))
                    accessory_lines += 1
                    continue
            if RACK_ROOT_RE.match(model.model) and rack is None:
                rack = _draft(ln, model, CATEGORY_RACK, venue, target)
                rack.model_raw = model.raw
                drafts.append(rack)
                parents.append((ln, rack))
                continue
            category = category_of(model.model, target)
            if rack is not None and category is None:
                # a component of the open rack (switch, processor, UPS, patch panel…)
                if RACK_ROOT_RE.match(model.model) and model.model.upper().startswith("ERN4"):
                    rack.model, rack.model_raw = model.model, model.raw
                rack.accessories.append(_accessory_entry(ln, model, "component"))
                component_lines += 1
                continue
            if category is None:
                excluded.append(Excluded(ln, model.model, "not a lighting-control device"))
                continue
            draft = _draft(ln, model, category, venue, target)
            drafts.append(draft)
            parents.append((ln, draft))

        # attach accessories: nearest parent of the right model, preceding first
        for ln, model, parent_pat in pending:
            best: Draft | None = None
            best_d = None
            for p, d in parents:
                if not parent_pat.match(d.model) and not parent_pat.match(d.model_raw):
                    continue
                dist = (p.page, p.column, p.line) <= (ln.page, ln.column, ln.line)
                score = (0 if dist else 1, abs(_order(p) - _order(ln)))
                if best_d is None or score < best_d:
                    best, best_d = d, score
            if best is None:
                excluded.append(Excluded(ln, model.model, "accessory without a parent line"))
                continue
            best.accessories.append(_accessory_entry(ln, model, "accessory"))
            accessory_lines += 1

    return Result(drafts, excluded, accessory_lines, component_lines, venues)


def _order(ln: Line) -> int:
    return ln.page * 100_000 + ln.column * 10_000 + ln.line


def _draft(ln: Line, model: Model, category: str, venue: Venue | None, target: Target) -> Draft:
    level_id = None
    level_code: str | None = None
    basis: str
    conf = ln.confidence
    conflicts = list(model.conflicts)
    if venue is None:
        basis = "project_pool"  # Material List: no venue at all
    elif venue.pooled:
        basis = "pooled_venue"
        conf *= POOLED_FACTOR
    else:
        code = target.alias_for(venue.text) or venue.codes[0]
        level_code = code
        if code in target.levels:
            level_id = target.levels[code]
            basis = "venue"
            split = f"{code}M"
            if (
                split in target.levels
                and not code.endswith("M")
                and category in PANEL_CATEGORIES
                and target.alias_for(venue.text) is None
            ):
                # the master keeps panels and racks on the mezzanine when a floor is split
                conflicts.append(f"level:{code}/{split}")
        else:
            basis = "level_not_in_project"
    return Draft(
        level_id=level_id,
        level_code=level_code,
        model=model.model,
        model_raw=model.raw,
        candidates=list(model.candidates),
        category=category,
        qty=ln.qty,
        accessories=[],
        source_ref=ln.source_ref(),
        level_basis=basis,
        extraction=ln.extraction,
        confidence=conf,
        conflicts=conflicts,
        line=ln,
    )


def extract(pdf_bytes: bytes, target: Target, ocr: OcrFn | None) -> tuple[Result, list[Line]]:
    lines, _pages = parse(pdf_bytes, ocr)
    return build(lines, target), lines
