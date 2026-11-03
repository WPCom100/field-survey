"""Plan sheet analysis (T45, PLAN §7.4, D7, D47, D100): the text pass over a vector sheet.

Pure functions over PDF bytes — no database, no object store — so the whole pass is testable on
`fixtures/Level_06M_-_Lighting_Composite_vector.pdf`. `analyse_sheet()` returns, per page:

- `grid_sets`: one entry per grid system found (D47). Each set is a **frame** fitted to the grid
  bubbles: `affine` maps sheet coordinates to `(s, t)` in points, `s` across the column lines
  (east positive) and `t` across the row lines (south positive); `col_labels` / `row_labels` are
  the bubble labels with their `pos` on that axis, in sheet order (west → east, north → south);
  `residual` is the RMS distance (pt) of every bubble from its label's line — `auto` below
  `AUTO_RESIDUAL_PT`, else `none` (the iPad's three-tap calibration makes it `manual`).
  `packages/core/src/grid.ts` reads the same JSON (`drawing_position` below is its Python twin).
- `features`: the rest of the text pass — `rooms` (code + name), `tags` (panel / rack tags and
  the device types printed beside devices, for T46's pre-placement proposals — T140), `bubbles`
  (circled labels no set claimed, for manual snapping) and the `boundaries` the composite's
  "Source sheet boundaries" optional-content group draws (D100), as polylines in sheet
  coordinates with their sheet labels.
- `display_pdf`: the same PDF with that optional-content group switched **off** in the default
  configuration, so PDFKit no longer paints the magenta and Skia draws the boundaries as a layer
  (D100); `None` when the file has no such group.

Coordinates everywhere are **sheet** coordinates (`app/src/plan/viewport.ts`): the CropBox's
top-left corner as origin, y down, PDF points. Raster content is ignored (A11).
"""

from __future__ import annotations

import io
import math
import re
import statistics
from array import array
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pdfplumber
from pdfminer.converter import PDFPageAggregator
from pdfminer.layout import LTLine, LTRect
from pdfminer.pdfinterp import PDFPageInterpreter
from pdfplumber.page import PDFPageAggregatorWithMarkedContent
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ContentStream, NameObject

# ----------------------------------------------------------------- constants

AUTO_RESIDUAL_PT = 2.0
"""A set whose bubbles sit within this RMS distance of their grid lines is `auto` (PLAN §7.4)."""

LINE_TOL_PT = 3.0
"""How far a bubble may sit from a grid line and still count as on it."""

ANGLE_TOL_DEG = 4.0
MIN_SPACING_PT = 40.0
"""Bubbles closer than this along an axis are a key plan or a legend, not a grid."""

ON_LINE_FRACTION = 0.08
"""A pin within this fraction of the local spacing of a grid line is "on" it ("Grid E / 7.5")."""

MARGIN_SPACINGS = 1.5
"""How far beyond its last bubble a set still claims a pin ("East of H")."""

LABEL_RE = re.compile(r"^(?P<core>[A-Z](?:\.\d)?|([A-Z])\2|\d{1,2}(?:\.\d)?)(?P<dot>\.)?$")
"""A grid bubble label: `A`, `AA`, `G.9`, `9`, `13.5`, and the dotted Walter Tower style
`C.` / `6.`.
Two different letters (`OF`, `TO`, `IN`) are words in notes, never bubbles."""

MIN_LABELS = 3
"""An axis needs this many labels printed on two sheet edges before it counts as a grid."""

DEFAULT_ROOM_CODE_PATTERNS = (r"[A-Z]{2}\d{2}[A-Z]?-[A-Z0-9]{2,6}",)
"""Room codes as the Tower's drawings print them (`XX06M-1E05`). A project's own
`vocab(room_code_pattern)` rows replace these (T79, D240); `app/src/vocab/seed.ts` seeds the
same strings."""

DEFAULT_TAG_PATTERNS = (
    r"CT[0-9A-Z]{1,3}LCP[AB]",  # relay panels
    r"EBDK",
    r"UFMP\d*",  # Foundry panels
    r"ERP\d*",
    r"NSPS",
    r"P-[A-Z]{2,5}(?:-[A-Z]{1,2})?",  # rack components (P-ACP, P-SPM-E, P-REP)
)
"""Device tags as the Tower's drawings print them; `vocab(tag_pattern)` replaces them (D240)."""

MAX_CHARS = 500_000
"""Characters one page may draw before the job gives up (T124): the 14 MB Level 02 composite
draws 143,000; each one kept costs pdfplumber about 2 KB."""

BOUNDARY_OCG_WORD = "boundar"
DEDUPE_PT = 1.5

Point = tuple[float, float]


# ------------------------------------------------------------------ geometry


def _unit(x: float, y: float) -> Point:
    n = math.hypot(x, y)
    return (x / n, y / n) if n else (1.0, 0.0)


def _dot(a: Point, b: Point) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _angle_deg(v: Point) -> float:
    """Direction of a line through `v`, in [0, 180)."""
    return math.degrees(math.atan2(v[1], v[0])) % 180.0


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def _from_angle(deg: float) -> Point:
    r = math.radians(deg)
    return (math.cos(r), math.sin(r))


def _perp(v: Point) -> Point:
    return (-v[1], v[0])


def _rms(values: list[float]) -> float:
    return math.sqrt(sum(v * v for v in values) / len(values)) if values else 0.0


# --------------------------------------------------------------------- words


@dataclass
class Word:
    text: str
    x: float  # centre, sheet coordinates
    y: float
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    upright: bool


def _page_words(page: pdfplumber.page.Page) -> list[Word]:
    """pdfplumber words in sheet coordinates, duplicates from overlaid source sheets dropped."""
    cx, cy = page.cropbox[0], page.cropbox[1]
    seen: set[tuple[str, int, int]] = set()
    out: list[Word] = []
    for w in page.extract_words(extra_attrs=["upright", "size"]):
        text = w["text"].strip()
        if not text:
            continue
        x0, x1 = w["x0"] - cx, w["x1"] - cx
        y0, y1 = w["top"] - cy, w["bottom"] - cy
        key = (text, round((x0 + x1) / 2 / DEDUPE_PT), round((y0 + y1) / 2 / DEDUPE_PT))
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Word(
                text,
                (x0 + x1) / 2,
                (y0 + y1) / 2,
                x0,
                y0,
                x1,
                y1,
                float(w["size"]),
                bool(w["upright"]),
            )
        )
    return out


RING_CELL = 32.0
RING_RADIUS = 22.0


class Rings:
    """Where the sheet draws a ring a bubble label could sit in: a circle-like curve, or (the
    Walter Tower style) a small polygon of short line segments. Segment midpoints are bucketed
    so `around(x, y)` stays cheap on a sheet with 1,300,000 lines.

    Fed one painted path at a time by `_PathSink` (T124): nothing but a circle's box or a short
    segment's midpoint is kept, so a sheet's vector count no longer sets the job's memory."""

    def __init__(self, cx: float = 0.0, cy: float = 0.0):
        self.cx, self.cy = cx, cy  # the CropBox origin in pdfplumber's top-down space
        self.circles: list[tuple[float, float, float, float]] = []
        self.cells: dict[tuple[int, int], array[float]] = {}
        self.paths = 0

    def add(self, kind: str, x0: float, top: float, x1: float, bottom: float) -> None:
        """One pdfplumber-classified object (`curve`, `line` or `rect`) in pdfplumber's
        coordinates (top-down, MediaBox origin)."""
        self.paths += 1
        w, h = x1 - x0, bottom - top
        if kind == "curve":
            if 8 <= w <= 60 and abs(w - h) < 2:
                self.circles.append((x0 - self.cx, top - self.cy, x1 - self.cx, bottom - self.cy))
            return
        if max(w, h) > 36 or max(w, h) < 4:
            return
        mx, my = (x0 + x1) / 2 - self.cx, (top + bottom) / 2 - self.cy
        cell = self.cells.setdefault((int(mx // RING_CELL), int(my // RING_CELL)), array("d"))
        cell.append(mx)
        cell.append(my)

    def around(self, x: float, y: float) -> bool:
        if any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in self.circles):
            return True
        i, j = int(x // RING_CELL), int(y // RING_CELL)
        near = 0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                pts = self.cells.get((i + di, j + dj), ())
                for k in range(0, len(pts), 2):
                    if math.hypot(pts[k] - x, pts[k + 1] - y) <= RING_RADIUS:
                        near += 1
        return near >= 3


class SheetTooLarge(ValueError):
    """A page past `MAX_CHARS`; the plans job fails the batch with this message (T124)."""


class _PathSink(PDFPageAggregatorWithMarkedContent):
    """pdfplumber's layout device, except that a painted path goes to `Rings` and never into the
    layout (T124): pdfplumber kept a dict per curve, line and rect, and the Level 02 composite's
    1.3 million lines took the worker past 3 GB. Only the characters stay for `_page_words`."""

    def __init__(self, pdf: pdfplumber.PDF, page: pdfplumber.page.Page, rings: Rings):
        super().__init__(pdf.rsrcmgr, pageno=page.page_number, laparams=pdf.laparams)
        self.rings = rings
        self.mb_x0, self.mb_top = float(page.mediabox[0]), float(page.mediabox[1])
        self.height = float(page.height)
        self.chars = 0

    def paint_path(self, gstate, stroke, fill, evenodd, path):  # type: ignore[no-untyped-def]
        objs = self.cur_item._objs  # noqa: SLF001 - where pdfminer puts what it builds
        n = len(objs)
        PDFPageAggregator.paint_path(self, gstate, stroke, fill, evenodd, path)
        for o in objs[n:]:  # pdfplumber's own coordinates (Page.process_object)
            kind = "line" if type(o) is LTLine else "rect" if type(o) is LTRect else "curve"
            top = self.height - o.y1 + self.mb_top
            self.rings.add(kind, o.x0 + self.mb_x0, top, o.x1 + self.mb_x0, top + o.height)
        del objs[n:]

    def render_char(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        self.chars += 1
        if self.chars > MAX_CHARS:
            raise SheetTooLarge(
                f"the sheet draws more than {MAX_CHARS:,} characters on one page; "
                "upload it as a smaller or flattened PDF"
            )
        return super().render_char(*args, **kwargs)


def _read_page(pdf: pdfplumber.PDF, page: pdfplumber.page.Page) -> Rings:
    """One pdfminer pass over the page: characters into pdfplumber's layout, paths into the
    returned `Rings`."""
    rings = Rings(float(page.cropbox[0]), float(page.cropbox[1]))
    device = _PathSink(pdf, page, rings)
    PDFPageInterpreter(pdf.rsrcmgr, device).process_page(page.page_obj)
    page._layout = device.get_result()  # noqa: SLF001 - pdfplumber reads its chars from here
    return rings


# ------------------------------------------------------------- grid bubbles


@dataclass
class Bubble:
    label: str  # as printed, "C." stays "C."
    core: str  # without the dotted-style suffix
    kind: str  # alpha | num
    style: str  # plain | dot
    size: float
    x: float
    y: float


def _bubbles(words: list[Word]) -> list[Bubble]:
    out = []
    for w in words:
        m = LABEL_RE.match(w.text)
        if not m:
            continue
        core = m.group("core")
        out.append(
            Bubble(
                label=w.text,
                core=core,
                kind="alpha" if core[0].isalpha() else "num",
                style="dot" if m.group("dot") else "plain",
                size=round(w.size * 2) / 2,
                x=w.x,
                y=w.y,
            )
        )
    return out


@dataclass
class Axis:
    """Bubbles of one family along one direction: the candidate for a set's columns or rows."""

    kind: str
    style: str
    size: float
    normal: Point  # unit normal of the grid lines (what `pos` is measured along)
    direction: Point  # unit direction of the grid lines
    labels: list[tuple[str, float, list[Bubble]]]  # (label, mean pos, bubbles) sorted by pos
    used: bool = False

    @property
    def positions(self) -> list[float]:
        return [p for _, p, _ in self.labels]

    def spacing(self) -> float:
        p = self.positions
        gaps = [b - a for a, b in zip(p, p[1:], strict=False)]
        return statistics.median(gaps) if gaps else 0.0

    def along(self, b: Bubble) -> float:
        return _dot(self.normal, (b.x, b.y))

    def edge_of(self, b: Bubble) -> float:
        return _dot(self.direction, (b.x, b.y))

    def edges(self) -> list[float]:
        """Where along the lines the bubbles sit (one value per sheet edge, roughly)."""
        vals = sorted(self.edge_of(b) for _, _, bs in self.labels for b in bs)
        out: list[float] = []
        for v in vals:
            if not out or v - out[-1] > LINE_TOL_PT * 2:
                out.append(v)
        return out

    def residuals(self) -> list[float]:
        return [abs(self.along(b) - pos) for _, pos, bs in self.labels for b in bs]


def _direction_hypotheses(bubbles: list[Bubble]) -> list[Point]:
    """Grid-line directions: the vectors between two bubbles of the same label, clustered."""
    by_label: dict[str, list[Bubble]] = defaultdict(list)
    for b in bubbles:
        by_label[b.label].append(b)
    angles: list[float] = []
    for bs in by_label.values():
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                dx, dy = bs[j].x - bs[i].x, bs[j].y - bs[i].y
                if math.hypot(dx, dy) >= MIN_SPACING_PT:
                    angles.append(_angle_deg((dx, dy)))
    clusters: list[list[float]] = []
    medians: list[float] = []  # each cluster's median, kept as it grows (T124: 10,000 bubbles)
    for a in sorted(angles):
        for i, c in enumerate(clusters):
            if _angle_diff(a, medians[i]) <= ANGLE_TOL_DEG:
                c.append(a)
                medians[i] = statistics.median(c)
                break
        else:
            clusters.append([a])
            medians.append(a)
    good = [c for c in clusters if len(c) >= 2]
    if good:
        return [_from_angle(_circular_median(c)) for c in good]
    # Fallback (bubbles on one edge only): the bubbles themselves run along the edge; grid
    # lines are taken perpendicular to it.
    if len(bubbles) >= 3:
        xs = [b.x for b in bubbles]
        ys = [b.y for b in bubbles]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        syy = sum((y - my) ** 2 for y in ys)
        sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
        theta = 0.5 * math.atan2(2 * sxy, sxx - syy)
        edge = (math.cos(theta), math.sin(theta))
        return [_perp(edge)]
    return []


def _circular_median(angles: list[float]) -> float:
    """Median of line angles that may straddle 0/180."""
    ref = angles[0]
    unwrapped = [
        a if _angle_diff(a, ref) == abs(a - ref) % 180 and abs(a - ref) <= 90 else a - 180
        for a in angles
    ]
    unwrapped = [a + 180 if a < ref - 90 else a for a in unwrapped]
    return statistics.median(unwrapped) % 180.0


def label_key(core: str) -> float:
    """Where a label sits in its natural order: `A`=1 … `Z`=26, `AA`=27, `G.9`=7.9, `13.5`=13.5."""
    if core[0].isalpha():
        letters, _, frac = core.partition(".")
        n = 0
        for ch in letters:
            n = n * 26 + (ord(ch) - ord("A") + 1)
        return n + (int(frac) / 10 if frac else 0.0)
    return float(core)


def _monotonic(
    members: list[tuple[str, float, list[Bubble]]],
) -> list[tuple[str, float, list[Bubble]]]:
    """The longest run of labels whose natural order follows their position (ascending or
    descending) — what a real grid does; a stray label from a note breaks the order and is
    left out."""
    keys = [label_key(LABEL_RE.match(m[0]).group("core")) for m in members]  # type: ignore[union-attr]
    best: list[int] = []
    for sign in (1, -1):
        n = len(keys)
        length = [1] * n
        prev = [-1] * n
        for i in range(n):
            for j in range(i):
                if sign * (keys[i] - keys[j]) > 0 and length[j] + 1 > length[i]:
                    length[i], prev[i] = length[j] + 1, j
        if not n:
            continue
        end = max(range(n), key=lambda i: length[i])
        chain: list[int] = []
        while end != -1:
            chain.append(end)
            end = prev[end]
        if len(chain) > len(best):
            best = chain[::-1]
    return [members[i] for i in best]


def _axes_for_family(bubbles: list[Bubble]) -> list[Axis]:
    """Group a family's bubbles into axes: labels printed on two sheet edges whose bubbles line up
    along one direction, split into runs where a label repeats (two towers side by side), in
    their natural order, with tiny spacings (key plans) dropped. Labels printed once are
    adopted later (`_adopt_singles`)."""
    axes: list[Axis] = []
    first = bubbles[0]
    for direction in _direction_hypotheses(bubbles):
        normal = _perp(direction)
        by_label: dict[str, list[Bubble]] = defaultdict(list)
        for b in bubbles:
            by_label[b.label].append(b)
        members: list[tuple[str, float, list[Bubble]]] = []
        for label, bs in by_label.items():
            if len(bs) < 2:
                continue
            pos = [_dot(normal, (b.x, b.y)) for b in bs]
            # the label's bubbles must agree on a line in this direction
            groups: list[list[int]] = []
            for i in sorted(range(len(bs)), key=lambda i: pos[i]):
                if groups and pos[i] - pos[groups[-1][0]] <= LINE_TOL_PT * 2:
                    groups[-1].append(i)
                else:
                    groups.append([i])
            for g in groups:
                if len(g) >= 2:
                    members.append((label, statistics.fmean(pos[i] for i in g), [bs[i] for i in g]))
        members.sort(key=lambda m: m[1])
        # runs: the longest ordered sequence is one grid; what is left may hold another (two
        # towers with their own A…H), stray circled numbers (detail callouts) fall through
        remaining = members
        while True:
            ordered = _monotonic(remaining)
            if len(ordered) < MIN_LABELS:
                break
            remaining = [m for m in remaining if m not in ordered]
            axis = Axis(first.kind, first.style, first.size, normal, direction, ordered)
            if axis.spacing() >= MIN_SPACING_PT:
                axes.append(axis)
    return axes


def _orient(axis: Axis, role: str) -> None:
    """Columns count eastward (+x), rows southward (+y, sheet y points down)."""
    nx, ny = axis.normal
    flip = (
        (nx < 0 if abs(nx) >= 0.1 else ny < 0)
        if role == "col"
        else (ny < 0 if abs(ny) >= 0.1 else nx < 0)
    )
    if flip:
        axis.normal = (-nx, -ny)
        axis.labels = sorted(((lab, -p, bs) for lab, p, bs in axis.labels), key=lambda m: m[1])


def _overlap(a: Axis, b: Axis) -> float:
    """Fraction of `b`'s bubbles that lie within `a`'s span (plus a margin) along `a`'s normal."""
    pos = a.positions
    margin = MARGIN_SPACINGS * a.spacing()
    lo, hi = min(pos) - margin, max(pos) + margin
    bubbles = [bb for _, _, bs in b.labels for bb in bs]
    inside = sum(1 for bb in bubbles if lo <= a.along(bb) <= hi)
    return inside / len(bubbles) if bubbles else 0.0


def _adopt_singles(
    axis: Axis, candidates: list[Bubble], taken: set[int], rings: Rings | None
) -> None:
    """A label printed once (one sheet edge only) joins the axis when it sits on one of the
    axis's edges within the span, keeps the labels in order and — when the axis's own bubbles
    are ringed — is ringed too."""
    edges = axis.edges()
    pos = axis.positions
    margin = MARGIN_SPACINGS * axis.spacing()
    lo, hi = min(pos) - margin, max(pos) + margin
    have = {label for label, _, _ in axis.labels}
    own = [b for _, _, bs in axis.labels for b in bs]
    ringed = rings is not None and sum(1 for b in own if rings.around(b.x, b.y)) >= len(own) / 2
    for b in candidates:
        if id(b) in taken or b.label in have:
            continue
        if b.kind != axis.kind or b.style != axis.style or b.size != axis.size:
            continue
        e = axis.edge_of(b)
        if not any(abs(e - edge) <= LINE_TOL_PT for edge in edges):
            continue
        p = axis.along(b)
        if not lo <= p <= hi:
            continue
        if ringed and rings is not None and not rings.around(b.x, b.y):
            continue
        trial = sorted([*axis.labels, (b.label, p, [b])], key=lambda m: m[1])
        if len(_monotonic(trial)) != len(trial):
            continue
        axis.labels = trial
        have.add(b.label)
        taken.add(id(b))


def find_grid_sets(
    bubbles: list[Bubble], rings: Rings | None = None
) -> tuple[list[dict[str, Any]], set[int]]:
    """Grid sets from the bubble labels (D47): a lettered axis paired with a numbered one of the
    same style and font, roughly perpendicular, each spanning the other's bubbles. Returns the
    sets as stored JSON and the ids of the bubbles they claimed."""
    families: dict[tuple[str, str, float], list[Bubble]] = defaultdict(list)
    for b in bubbles:
        # a grid bubble is always drawn in a ring; a letter from a rotated note never is
        if rings is None or rings.around(b.x, b.y):
            families[(b.kind, b.style, b.size)].append(b)
    axes: list[Axis] = []
    for fam in families.values():
        if len(fam) >= 2 * MIN_LABELS:
            axes.extend(_axes_for_family(fam))

    pairs: list[tuple[float, Axis, Axis]] = []
    for a in (ax for ax in axes if ax.kind == "alpha"):
        for b in (ax for ax in axes if ax.kind == "num"):
            if a.style != b.style or a.size != b.size:
                continue
            cos = abs(_dot(a.normal, b.normal))
            if cos > 0.5:
                continue
            ab, ba = _overlap(a, b), _overlap(b, a)
            if ab < 0.5 or ba < 0.5:
                continue
            pairs.append((ab + ba - 2 * cos, a, b))
    pairs.sort(key=lambda p: -p[0])

    sets: list[dict[str, Any]] = []
    taken: set[int] = set()
    for _, col, row in pairs:
        if col.used or row.used:
            continue
        col.used = row.used = True
        _orient(col, "col")
        _orient(row, "row")
        for bb in (bb for ax in (col, row) for _, _, bs in ax.labels for bb in bs):
            taken.add(id(bb))
        _adopt_singles(col, bubbles, taken, rings)
        _adopt_singles(row, bubbles, taken, rings)
        sets.append(_set_json(col, row))
    sets.sort(key=lambda s: -(len(s["col_labels"]) + len(s["row_labels"])))
    return sets, taken


def _set_json(col: Axis, row: Axis) -> dict[str, Any]:
    residuals = col.residuals() + row.residuals()
    rms = _rms(residuals)
    angle = math.degrees(math.atan2(col.normal[1], col.normal[0]))
    name = f"{col.labels[0][0]}–{col.labels[-1][0]} / {row.labels[0][0]}–{row.labels[-1][0]}"
    if abs(angle) > 2:
        name += f" ({angle:+.0f}°)"
    r = lambda v: round(v, 2)  # noqa: E731
    return {
        "name": name,
        "prefix": "",
        "mode": "auto" if rms < AUTO_RESIDUAL_PT else "none",
        "residual": r(rms),
        "max_residual": r(max(residuals)) if residuals else 0.0,
        "angle": r(angle),
        # sheet → frame, viewport.ts column convention: s = a·x + c·y + tx, t = b·x + d·y + ty
        "affine": {
            "a": r(col.normal[0]),
            "c": r(col.normal[1]),
            "tx": 0.0,
            "b": r(row.normal[0]),
            "d": r(row.normal[1]),
            "ty": 0.0,
        },
        "col_labels": [{"label": lab, "pos": r(p)} for lab, p, _ in col.labels],
        "row_labels": [{"label": lab, "pos": r(p)} for lab, p, _ in row.labels],
        "bubbles": [
            {"label": lab, "axis": axis, "x": r(b.x), "y": r(b.y)}
            for axis, ax in (("col", col), ("row", row))
            for lab, _, bs in ax.labels
            for b in bs
        ],
    }


# ------------------------------------------------------------ rooms and tags


@dataclass(frozen=True)
class Patterns:
    """What the text pass reads as a room code and as a device tag: each pattern must match a
    whole word (`re.fullmatch`, so `^` / `$` are optional)."""

    rooms: tuple[re.Pattern[str], ...]
    tags: tuple[re.Pattern[str], ...]


def compile_patterns(
    rooms: list[str] | tuple[str, ...] = DEFAULT_ROOM_CODE_PATTERNS,
    tags: list[str] | tuple[str, ...] = DEFAULT_TAG_PATTERNS,
) -> tuple[Patterns, list[dict[str, str]]]:
    """Compile the patterns; one that does not compile is left out and returned as
    `{list, pattern, error}` for the batch to report (T79, D240) — never raised."""
    bad: list[dict[str, str]] = []

    def build(values: list[str] | tuple[str, ...], list_name: str) -> tuple[re.Pattern[str], ...]:
        out = []
        for v in values:
            try:
                out.append(re.compile(v))
            except re.error as e:
                bad.append({"list": list_name, "pattern": v, "error": str(e)})
        return tuple(out)

    return Patterns(build(rooms, "room_code_pattern"), build(tags, "tag_pattern")), bad


DEFAULT_PATTERNS = compile_patterns()[0]


def _any_match(patterns: tuple[re.Pattern[str], ...], text: str) -> bool:
    return any(rx.fullmatch(text) for rx in patterns)


def _title(s: str) -> str:
    """`ELEVATOR MACHINE ROOM` → `Elevator Machine Room`; short tokens, codes and bracketed
    abbreviations (`IDF`, `C16`, `(FSAE)`) stay as printed."""
    return " ".join(w.capitalize() if len(w) >= 4 and w.isalpha() else w for w in s.split())


def find_rooms(words: list[Word], patterns: Patterns = DEFAULT_PATTERNS) -> list[dict[str, Any]]:
    """Room codes with the name printed above them (one or two lines of the same font). The
    composite overlays source sheets, so a name's words can be printed twice a few points apart;
    a repeated word within 12 pt is one word."""
    out = []
    is_code = {id(w) for w in words if _any_match(patterns.rooms, w.text)}
    codes = [w for w in words if id(w) in is_code]
    for code in codes:
        lines: dict[int, list[Word]] = defaultdict(list)
        for w in words:
            if id(w) in is_code or abs(w.size - code.size) > 1:
                continue
            if abs(w.x - code.x) > 70:
                continue
            gap = code.y0 - w.y1
            if -2 < gap < 2.6 * code.size:
                lines[round(w.y / 3)].append(w)
        name_words: list[Word] = []
        for k in sorted(lines):
            for w in sorted(lines[k], key=lambda w: w.x0):
                if any(
                    o.text == w.text and abs(o.x - w.x) < 12 and abs(o.y - w.y) < 12
                    for o in name_words
                ):
                    continue
                name_words.append(w)
        tokens = [
            w.text for w in name_words if w.text.isupper() or w.text.isdigit() or w.text.isalpha()
        ]
        while tokens and not tokens[0].isalpha():  # a detail callout above the name ("1", "C16")
            tokens.pop(0)
        name = " ".join(tokens)
        out.append(
            {
                "code": code.text,
                "name": _title(name) if name else None,
                "x": round(code.x, 1),
                "y": round(code.y, 1),
            }
        )
    out.sort(key=lambda r: (r["code"], r["y"], r["x"]))
    return out


MIN_TAG_SIZE = 4.0
"""Smaller text is a legend symbol's label or the hairline text of a rack elevation, never the
label beside a device: the composites print those labels at 5.5 pt, their legend tables at 8 pt
and the legend symbols at 1–2.3 pt (T140; 06M, Level 02, Level 03)."""

MIN_NAME_LEN = 4
"""A library model or alias shorter than this (`NET`, `UPS`, `TBD`, `97`) reads as an ordinary word
on a sheet — the Level 02 composite prints `NET` 142 times — so the text pass does not keep it."""

JOIN_GAP = 0.1
"""× size: fragments of one line this close are one word (the 03 composite draws `P-DOC` as
`P`, `-D`, `O`, `C` with no gap between them)."""

LINE_STEP = (0.6, 1.1)
"""× size: how far below a word the next line of a two-line label sits (`P-DOC` / `C-LR`,
`ERP24-FT` / `241P`)."""

PROSE_GAP = 0.8
"""× size: a plain word this close on the same line makes a type part of a note (`… SYSTEM EBDK
LOCATION IN …`), not a label."""

LEGEND_ROWS = 3
LEGEND_STEP = 4.5
"""A column of `LEGEND_ROWS`+ words of one size, centred on one x and at most this many × size
apart, with two device names in it or headed `Description`, is a legend table ("Device Layout ·
Description · Quantity"), not devices on the plan: the composites repeat each source sheet's."""
LEGEND_HEADERS = frozenset({"DESCRIPTION"})

_PLAIN_WORD = re.compile(r"[A-Za-z]{2,}[.,;:]?")


def _name_key(s: str) -> str:
    return "".join(s.split()).upper()


def name_keys(types: Iterable[tuple[str | None, Sequence[Any] | None]]) -> frozenset[str]:
    """The device types a sheet may print beside a device (T140, D234): every model and alias of
    the project's live library, keyed as the library matches them (spaces and case ignored), and
    each **variant cut short** — an alias that extends the model with `-` parts names a variant
    (`P-DOC-C-LR-X` of `P-DOC-C`), and the drawings print it without its last parts
    (`P-DOC-C-LR`). Names shorter than `MIN_NAME_LEN` or without a letter are left out."""
    out: set[str] = set()
    for model, aliases in types:
        m = _name_key(model or "")
        for k in [m, *(_name_key(a) for a in aliases or [] if isinstance(a, str))]:
            out.add(k)
            if m and k.startswith(m + "-"):
                rest = k[len(m) + 1 :].split("-")
                out.update(m + "-" + "-".join(rest[:i]) for i in range(1, len(rest)))
    return frozenset(k for k in out if len(k) >= MIN_NAME_LEN and re.search("[A-Z]", k))


def _merge(a: Word, b: Word, text: str) -> Word:
    x0, y0 = min(a.x0, b.x0), min(a.y0, b.y0)
    x1, y1 = max(a.x1, b.x1), max(a.y1, b.y1)
    return Word(text, (x0 + x1) / 2, (y0 + y1) / 2, x0, y0, x1, y1, a.size, a.upright)


def _join_fragments(words: list[Word]) -> list[Word]:
    """Glue the fragments of one word back together: upright words of one size on one baseline
    that touch, one of them at most two characters long (`P` + `-D` + `O` + `C` → `P-DOC`)."""
    rows: dict[tuple[float, float], list[Word]] = defaultdict(list)
    out: list[Word] = []
    for w in words:
        if w.upright:
            rows[(round(w.size, 1), round(w.y, 1))].append(w)
        else:
            out.append(w)
    for row in rows.values():
        row.sort(key=lambda w: w.x0)
        cur = row[0]
        for w in row[1:]:
            touching = abs(w.x0 - cur.x1) <= JOIN_GAP * cur.size
            if touching and (len(w.text) <= 2 or len(cur.text) <= 2):
                cur = _merge(cur, w, cur.text + w.text)
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out


class _Near:
    """Words bucketed by position, for the neighbours of one word."""

    CELL = 24.0

    def __init__(self, words: list[Word]):
        self.cells: dict[tuple[int, int], list[Word]] = defaultdict(list)
        for w in words:
            self.cells[(int(w.x // self.CELL), int(w.y // self.CELL))].append(w)

    def around(self, w: Word, reach: float) -> list[Word]:
        n = int(reach // self.CELL) + 1
        cx, cy = int(w.x // self.CELL), int(w.y // self.CELL)
        return [
            o
            for i in range(cx - n, cx + n + 1)
            for j in range(cy - n, cy + n + 1)
            for o in self.cells.get((i, j), ())
            if o is not w
        ]


def _is_kept(text: str, patterns: Patterns, names: frozenset[str]) -> bool:
    return _name_key(text) in names or _any_match(patterns.tags, text)


def _join_lines(words: list[Word], names: frozenset[str]) -> list[Word]:
    """A type printed over two lines (`P-DOC` / `C-LR`, `ERP24-FT` / `241P`) is one word when the
    two lines, run together with or without a `-`, are a library name."""
    near = _Near(words)
    used: set[int] = set()
    joined: list[Word] = []
    for a in words:
        if id(a) in used or not a.upright:
            continue
        for b in near.around(a, LINE_STEP[1] * a.size):
            if id(b) in used or not b.upright or abs(b.size - a.size) > 0.1:
                continue
            step = (b.y - a.y) / a.size
            aligned = abs(b.x - a.x) <= 0.6 * a.size or abs(b.x0 - a.x0) <= 0.2 * a.size
            if not (LINE_STEP[0] <= step <= LINE_STEP[1] and aligned):
                continue
            text = next(
                (t for t in (a.text + b.text, f"{a.text}-{b.text}") if _name_key(t) in names),
                None,
            )
            if text:
                used.update((id(a), id(b)))
                joined.append(_merge(a, b, text))
                break
    return [w for w in words if id(w) not in used] + joined


def _in_prose(w: Word, near: _Near, patterns: Patterns, names: frozenset[str]) -> bool:
    for o in near.around(w, w.x1 - w.x0 + (PROSE_GAP + 8) * w.size):
        if abs(o.size - w.size) > 0.1 or abs(o.y - w.y) > 0.2 * w.size:
            continue
        gap = max(o.x0 - w.x1, w.x0 - o.x1)
        if -0.1 * w.size <= gap <= PROSE_GAP * w.size and _PLAIN_WORD.fullmatch(o.text):
            if not _is_kept(o.text.rstrip(".,;:"), patterns, names):
                return True
    return False


def _legend(kept: list[Word], near: _Near) -> set[int]:
    """The kept words that stand in a legend table's device column: a column of `LEGEND_ROWS`+
    words of one size centred on one x, rows at most `LEGEND_STEP` × size apart (its header
    counts), holding two kept words or more — or any column under a `Description` header (a
    legend of one row on the Level 02 composite)."""
    out: set[int] = set()
    seen: set[int] = set()
    for k in kept:
        if id(k) in seen:
            continue
        col, todo = {id(k): k}, [k]
        while todo:
            w = todo.pop()
            for o in near.around(w, LEGEND_STEP * w.size):
                if id(o) in col or abs(o.size - k.size) > 0.1 or abs(o.x - w.x) > 1.0:
                    continue
                if abs(o.y - w.y) <= LEGEND_STEP * k.size:
                    col[id(o)] = o
                    todo.append(o)
        mine = [w for w in kept if id(w) in col]
        seen.update(id(w) for w in mine)
        headed = any(w.text.upper() in LEGEND_HEADERS for w in col.values())
        if headed or (len(col) >= LEGEND_ROWS and len(mine) >= 2):
            out.update(id(w) for w in mine)
    return out


def find_tags(
    words: list[Word],
    patterns: Patterns = DEFAULT_PATTERNS,
    names: frozenset[str] = frozenset(),
) -> list[dict[str, Any]]:
    """What the sheet prints beside its devices: tags matching the project's tag patterns (panel
    names, EBDK, Foundry panels, rack components) and — T140, D234 — every word that is a model or
    alias of a library type (`names`, from `name_keys`: `PI1104`, `P-LS`, `P-DOC-C-LR`, `UFMP4`).
    A type split into fragments or over two lines is joined; a word in a sentence of a note, a
    legend table's device column and the hairline text of rack elevations and legend symbols are
    left out."""
    pieces = _join_fragments([w for w in words if w.size >= MIN_TAG_SIZE])
    joined = _join_lines(pieces, names) if names else pieces
    near = _Near(joined)
    kept = [
        w
        for w in joined
        if _is_kept(w.text, patterns, names) and not _in_prose(w, near, patterns, names)
    ]
    legend = _legend(kept, near)
    out = [
        {"text": w.text, "x": round(w.x, 1), "y": round(w.y, 1), "size": round(w.size, 1)}
        for w in kept
        if id(w) not in legend
    ]
    out.sort(key=lambda t: (t["text"], t["y"], t["x"]))
    return out


# --------------------------------------------------------------- boundaries


def _boundary_ocgs(reader: PdfReader) -> dict[Any, str]:
    """Optional-content groups that draw source-sheet boundaries, keyed by their object reference.
    Any group whose name says so; with exactly one group in the file, that one."""
    ocp = reader.trailer["/Root"].get("/OCProperties")
    if not ocp:
        return {}
    groups = list(ocp.get("/OCGs", []))
    named = {}
    for ref in groups:
        name = str(ref.get_object().get("/Name", ""))
        if BOUNDARY_OCG_WORD in name.lower():
            named[ref.idnum] = name
    if not named and len(groups) == 1:
        named[groups[0].idnum] = str(groups[0].get_object().get("/Name", ""))
    return named


def _mat_mul(m: tuple[float, ...], n: tuple[float, ...]) -> tuple[float, ...]:
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (
        a * a2 + b * c2,
        a * b2 + b * d2,
        c * a2 + d * c2,
        c * b2 + d * d2,
        e * a2 + f * c2 + e2,
        e * b2 + f * d2 + f2,
    )


def _mat_apply(m: tuple[float, ...], x: float, y: float) -> Point:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def extract_boundaries(
    reader: PdfReader, page_index: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    """Polylines and labels drawn inside the boundary OCG of one page, in sheet coordinates.
    Returns (boundaries, labels, found) — `found` says whether the page has such a group."""
    page = reader.pages[page_index]
    ocgs = _boundary_ocgs(reader)
    if not ocgs:
        return [], [], False
    props = page.get("/Resources", {}).get("/Properties", {}) or {}
    names = {k for k, v in props.items() if getattr(v, "idnum", None) in ocgs}
    if not names:
        return [], [], False
    crop = page.cropbox
    cx0, cy1 = float(crop.left), float(crop.top)
    to_sheet = lambda p: (p[0] - cx0, cy1 - p[1])  # noqa: E731

    content = ContentStream(page.get_contents(), reader)
    ctm: tuple[float, ...] = (1, 0, 0, 1, 0, 0)
    stack: list[tuple[float, ...]] = []
    depth = 0  # nesting of marked content; >0 while inside the boundary group
    inside_depth: list[bool] = []
    segments: list[tuple[Point, Point]] = []
    labels: list[dict[str, Any]] = []
    subpath: list[Point] = []
    tm: tuple[float, ...] = (1, 0, 0, 1, 0, 0)
    tlm: tuple[float, ...] = tm
    text_parts: list[str] = []
    text_at: Point | None = None

    def flush_path() -> None:
        nonlocal subpath
        for p0, p1 in zip(subpath, subpath[1:], strict=False):
            segments.append((p0, p1))
        subpath = []

    def inside() -> bool:
        return any(inside_depth)

    for operands, op in content.operations:
        if op == b"q":
            stack.append(ctm)
        elif op == b"Q":
            ctm = stack.pop() if stack else ctm
        elif op == b"cm":
            ctm = _mat_mul(tuple(float(v) for v in operands), ctm)
        elif op == b"BDC":
            tag = str(operands[1]) if len(operands) > 1 else ""
            inside_depth.append(str(operands[0]) == "/OC" and tag in names)
            depth += 1
        elif op == b"BMC":
            inside_depth.append(False)
            depth += 1
        elif op == b"EMC":
            if inside_depth:
                inside_depth.pop()
            depth = max(0, depth - 1)
        elif not inside():
            continue
        elif op == b"m":
            flush_path()
            subpath = [to_sheet(_mat_apply(ctm, float(operands[0]), float(operands[1])))]
        elif op == b"l":
            subpath.append(to_sheet(_mat_apply(ctm, float(operands[0]), float(operands[1]))))
        elif op == b"c":
            subpath.append(to_sheet(_mat_apply(ctm, float(operands[4]), float(operands[5]))))
        elif op in (b"v", b"y"):
            subpath.append(to_sheet(_mat_apply(ctm, float(operands[-2]), float(operands[-1]))))
        elif op == b"re":
            x, y, w, h = (float(v) for v in operands)
            flush_path()
            corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
            subpath = [to_sheet(_mat_apply(ctm, *p)) for p in corners]
            flush_path()
        elif op == b"h":
            if subpath:
                subpath.append(subpath[0])
        elif op in (b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n"):
            if op in (b"s", b"b", b"b*") and subpath:
                subpath.append(subpath[0])
            flush_path()
        elif op == b"BT":
            tm = tlm = (1, 0, 0, 1, 0, 0)
            text_parts = []
            text_at = None
        elif op == b"Tm":
            tm = tlm = tuple(float(v) for v in operands)
        elif op in (b"Td", b"TD"):
            tlm = _mat_mul((1, 0, 0, 1, float(operands[0]), float(operands[1])), tlm)
            tm = tlm
        elif op in (b"Tj", b"TJ", b"'", b'"'):
            if text_at is None:
                text_at = to_sheet(_mat_apply(ctm, *_mat_apply(tm, 0, 0)))
            raw = operands[-1] if op != b"TJ" else operands[0]
            if op == b"TJ":
                text_parts.extend(
                    str(x)
                    for x in raw
                    if not isinstance(x, (int, float)) and not hasattr(x, "as_numeric")
                )
            else:
                text_parts.append(str(raw))
        elif op == b"ET":
            text = "".join(text_parts).strip()
            if text and text_at is not None:
                labels.append({"text": text, "x": round(text_at[0], 1), "y": round(text_at[1], 1)})
    flush_path()
    return _merge_segments(segments), labels, True


SIMPLIFY_PT = 10.0
"""The composite traces each source sheet's outline in 8-pt steps; a stair-stepped diagonal
within this tolerance of a straight line becomes that line."""


def _simplify(points: list[Point], tol: float) -> list[Point]:
    """Douglas–Peucker."""
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    best, worst = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = (
            abs(dx * (y0 - py) - (x0 - px) * dy) / length
            if length
            else math.hypot(px - x0, py - y0)
        )
        if d > best:
            best, worst = d, i
    if best <= tol:
        return [points[0], points[-1]]
    return _simplify(points[: worst + 1], tol)[:-1] + _simplify(points[worst:], tol)


def _merge_segments(segments: list[tuple[Point, Point]]) -> list[dict[str, Any]]:
    """Chain the drawn segments end to end into polylines (dashes and stair steps alike), then
    straighten each within `SIMPLIFY_PT`."""
    key = lambda p: (round(p[0] * 2), round(p[1] * 2))  # noqa: E731
    segs = [(p0, p1) for p0, p1 in segments if math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 1e-6]
    at: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, (p0, p1) in enumerate(segs):
        at[key(p0)].append(i)
        at[key(p1)].append(i)
    used = [False] * len(segs)
    out: list[dict[str, Any]] = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        chain = [segs[i][0], segs[i][1]]
        for end in (1, 0):  # extend forward from the last point, then backward from the first
            while True:
                tip = chain[-1] if end == 1 else chain[0]
                nxt = next((j for j in at[key(tip)] if not used[j]), None)
                if nxt is None:
                    break
                used[nxt] = True
                a, b = segs[nxt]
                other = b if key(a) == key(tip) else a
                if end == 1:
                    chain.append(other)
                else:
                    chain.insert(0, other)
        pts = _simplify(chain, SIMPLIFY_PT)
        out.append({"points": [[round(x, 1), round(y, 1)] for x, y in pts]})
    out.sort(key=lambda b: (b["points"][0][1], b["points"][0][0]))
    return out


def write_display_pdf(reader: PdfReader) -> bytes | None:
    """The PDF with every boundary OCG off in the default configuration (D100); None without one."""
    ocgs = _boundary_ocgs(reader)
    if not ocgs:
        return None
    writer = PdfWriter(clone_from=reader)
    ocp = writer._root_object["/OCProperties"]  # noqa: SLF001 - pypdf has no public accessor
    d = ocp["/D"] if "/D" in ocp else None
    if d is None:
        return None
    d = d.get_object()
    # the clone renumbers objects: find the groups again by name, in the writer
    names = set(ocgs.values())
    is_boundary = lambda ref: str(ref.get_object().get("/Name", "")) in names  # noqa: E731
    off_refs = [ref for ref in ocp["/OCGs"] if is_boundary(ref)]
    on = [ref for ref in list(d.get("/ON", [])) if not is_boundary(ref)]
    off = [ref for ref in list(d.get("/OFF", [])) if not is_boundary(ref)] + off_refs
    d[NameObject("/ON")] = ArrayObject(on)
    d[NameObject("/OFF")] = ArrayObject(off)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


# ----------------------------------------------------------------- analysis


@dataclass
class SheetAnalysis:
    page: int  # 1-based
    width_pt: float
    height_pt: float
    grid_sets: list[dict[str, Any]]
    features: dict[str, Any]
    display_pdf: bytes | None
    stats: dict[str, Any] = field(default_factory=dict)


def sheet_tags(
    data: bytes,
    page_index: int = 0,
    *,
    patterns: Patterns = DEFAULT_PATTERNS,
    names: frozenset[str] = frozenset(),
) -> list[dict[str, Any]]:
    """The tag pass alone over one page, for a sheet already stored (`plans.retag_sheets`, T140)."""
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[page_index]
        _read_page(pdf, page)
        words = _page_words(page)
    return find_tags(words, patterns, names)


def page_count(data: bytes) -> int:
    return len(PdfReader(io.BytesIO(data)).pages)


def analyse_sheet(
    data: bytes,
    page_index: int = 0,
    *,
    boundaries: bool = True,
    patterns: Patterns = DEFAULT_PATTERNS,
    names: frozenset[str] = frozenset(),
) -> SheetAnalysis:
    """The whole text pass over one page. `boundaries=False` skips the OCG work (source sheets);
    `patterns` are the project's room-code and tag patterns (D240), `names` the device names of
    its library (`name_keys`, T140)."""
    reader = PdfReader(io.BytesIO(data))
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[page_index]
        rings = _read_page(pdf, page)
        words = _page_words(page)
        crop = page.cropbox
        width, height = float(crop[2] - crop[0]), float(crop[3] - crop[1])
    bubbles = _bubbles(words)
    sets, taken = find_grid_sets(bubbles, rings)
    loose = [
        {"text": b.label, "x": round(b.x, 1), "y": round(b.y, 1)}
        for b in bubbles
        if id(b) not in taken and rings.around(b.x, b.y)
    ]
    rooms = find_rooms(words, patterns)
    tags = find_tags(words, patterns, names)
    lines, labels, found = extract_boundaries(reader, page_index) if boundaries else ([], [], False)
    display = write_display_pdf(reader) if boundaries and found else None
    features = {
        "rooms": rooms,
        "tags": tags,
        "bubbles": loose,
        "boundaries": lines,
        "boundary_labels": labels,
    }
    stats = {
        "words": len(words),
        "bubbles": len(bubbles),
        "grid_sets": len(sets),
        "auto_sets": sum(1 for s in sets if s["mode"] == "auto"),
        "rooms": len(rooms),
        "tags": len(tags),
        "paths": rings.paths,
        "boundaries": len(lines),
        "ocg_off": display is not None,
    }
    return SheetAnalysis(page_index + 1, width, height, sets, features, display, stats)


# ------------------------------------------------------- Drawing Position


def _axis_text(labels: list[dict[str, Any]], v: float, before: str, beyond: str) -> str | None:
    """`B-C`, `E`, `East of H` or `West of A` for a coordinate along one axis; None when the
    axis has no labels."""
    if not labels:
        return None
    pos = [float(lab["pos"]) for lab in labels]
    gaps = [b - a for a, b in zip(pos, pos[1:], strict=False)]
    spacing = statistics.median(gaps) if gaps else 0.0
    tol = lambda gap: max(2.0, ON_LINE_FRACTION * gap)  # noqa: E731
    if v < pos[0] - tol(spacing):
        return f"{before} {labels[0]['label']}"
    if v > pos[-1] + tol(spacing):
        return f"{beyond} {labels[-1]['label']}"
    for i, p in enumerate(pos):
        local = min(
            [
                g
                for g in (gaps[i - 1] if i > 0 else None, gaps[i] if i < len(gaps) else None)
                if g is not None
            ]
            or [spacing]
        )
        if abs(v - p) <= tol(local):
            return str(labels[i]["label"])
    for i in range(len(pos) - 1):
        if pos[i] < v < pos[i + 1]:
            return f"{labels[i]['label']}-{labels[i + 1]['label']}"
    return None


def _frame(gs: dict[str, Any], x: float, y: float) -> tuple[float, float]:
    a = gs["affine"]
    return (a["a"] * x + a["c"] * y + a.get("tx", 0.0), a["b"] * x + a["d"] * y + a.get("ty", 0.0))


def _span(labels: list[dict[str, Any]]) -> tuple[float, float, float]:
    pos = [float(lab["pos"]) for lab in labels]
    gaps = [b - a for a, b in zip(pos, pos[1:], strict=False)]
    spacing = statistics.median(gaps) if gaps else 100.0
    return min(pos), max(pos), spacing


def choose_grid_set(grid_sets: list[dict[str, Any]], x: float, y: float) -> int | None:
    """The set whose grid (plus a margin of `MARGIN_SPACINGS`) holds the point; else the nearest
    set within a further margin; else None."""
    best: tuple[float, float, int] | None = None
    for i, gs in enumerate(grid_sets):
        if gs.get("mode") == "none" or not gs.get("col_labels") or not gs.get("row_labels"):
            continue
        s, t = _frame(gs, x, y)
        s0, s1, sp = _span(gs["col_labels"])
        t0, t1, tp = _span(gs["row_labels"])
        ds = max(s0 - MARGIN_SPACINGS * sp - s, s - (s1 + MARGIN_SPACINGS * sp), 0.0) / sp
        dt = max(t0 - MARGIN_SPACINGS * tp - t, t - (t1 + MARGIN_SPACINGS * tp), 0.0) / tp
        d = max(ds, dt)
        if d > 2.0:
            continue
        # where two grids overlap (the towers' sheets do), the one the point sits deeper in wins
        depth = min(s - s0, s1 - s, t - t0, t1 - t) / max(sp, tp)
        if best is None or (d, -depth) < (best[0], -best[1]):
            best = (d, depth, i)
    return best[2] if best else None


def drawing_position(grid_sets: list[dict[str, Any]], x: float, y: float) -> str | None:
    """`Grid B-C / 9-8`, `Grid E / 7.5`, `Grid East of H / 9-8`, `WT Grid C.-D. / 6.-5.` — the
    master's wording (PLAN §7.4) for a sheet point; None when no set claims it."""
    i = choose_grid_set(grid_sets, x, y)
    if i is None:
        return None
    gs = grid_sets[i]
    s, t = _frame(gs, x, y)
    cols = _axis_text(gs["col_labels"], s, "West of", "East of")
    rows = _axis_text(gs["row_labels"], t, "North of", "South of")
    if cols is None or rows is None:
        return None
    prefix = (gs.get("prefix") or "").strip()
    return f"{prefix + ' ' if prefix else ''}Grid {cols} / {rows}"
