"""Tesseract OCR for PDF pages that have no text layer (PLAN §7.1, D5, T42).

The BOM's page 3 and a scanned Material List carry their tables as vector curves or raster
images: no `pdfplumber` words. This module renders such a page at 300 dpi (`pypdfium2`), cuts it
into **panels** at the full-height separator rules (the BOM's two side-by-side tables and its
title block), runs `tesseract --psm 6` on each panel and returns words with boxes in **PDF
points**, the same shape the text layer gives, so one table parser serves both paths.

Tesseract is a system binary (`apt-get install tesseract-ocr` in the image and CI; the
UB-Mannheim build on the Windows PC). It is only ever run through `subprocess` with the image
on stdin; no Python binding is needed. `available()` says whether it can be run; a job that needs
OCR and finds no binary fails loudly with that reason (CLAUDE.md §5).
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache

import pypdfium2 as pdfium
from PIL import Image, ImageOps

DPI = 300
"""Phase 1f recovered 67/67 lines of BOM p.3 at this resolution."""

PSM = 6
"""Page segmentation mode: one uniform block of text (a table panel)."""

WINDOWS_DEFAULT = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

SEPARATOR_FRACTION = 0.8
"""A pixel column dark over this fraction of the panel's height is a separator rule."""

MIN_PANEL_PX = 200
"""Narrower slices between separators are rules drawn double, not panels."""


@dataclass(frozen=True)
class Word:
    """A word with its box in PDF points (top-left origin, y down) and OCR confidence 0–1."""

    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    conf: float = 1.0


@lru_cache(maxsize=1)
def tesseract_path() -> str | None:
    """The binary to run: `TESSERACT_CMD`, then `tesseract` on PATH, then the Windows default."""
    env = os.environ.get("TESSERACT_CMD")
    if env and (shutil.which(env) or os.path.exists(env)):
        return env
    found = shutil.which("tesseract")
    if found:
        return found
    if os.path.exists(WINDOWS_DEFAULT):
        return WINDOWS_DEFAULT
    return None


def available() -> bool:
    return tesseract_path() is not None


class OcrError(Exception):
    """Tesseract is missing or failed on an image."""


def render_page(pdf_bytes: bytes, page_index: int, dpi: int = DPI) -> tuple[Image.Image, float]:
    """The page as a grayscale image and the pixels-per-point scale it was drawn at."""
    scale = dpi / 72
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        try:
            image = page.render(scale=scale).to_pil().convert("L")
        finally:
            page.close()
    finally:
        doc.close()
    return image, scale


def panels(image: Image.Image) -> list[tuple[int, int]]:
    """Horizontal `(x0, x1)` pixel ranges between full-height separator rules, trimmed to their
    ink. A page without separators is one panel."""
    width, height = image.size
    dark_cols = _dark_columns(image)
    limit = SEPARATOR_FRACTION * height
    cuts: list[int] = [x for x, n in enumerate(dark_cols) if n >= limit]
    bounds = [0, *cuts, width]
    out: list[tuple[int, int]] = []
    for a, b in zip(bounds, bounds[1:], strict=False):
        if b - a < MIN_PANEL_PX:
            continue
        # trim blank margins so tesseract sees the table, not a sea of white
        inked = [x for x in range(a, b) if dark_cols[x] > 0]
        if not inked:
            continue
        x0, x1 = max(a, inked[0] - 8), min(b, inked[-1] + 8)
        if x1 - x0 >= MIN_PANEL_PX:
            out.append((x0, x1))
    return out or [(0, width)]


def _dark_columns(image: Image.Image) -> list[float]:
    """Dark pixels per column (threshold at mid-gray), as a count. A box resample to one row
    averages each column in C; the mean of the thresholded image is the dark fraction."""
    width, height = image.size
    binary = image.point(lambda v: 255 if v < 128 else 0, mode="L")
    row = binary.resize((width, 1), Image.Resampling.BOX)
    return [v / 255 * height for v in row.getdata()]


def ocr_words(
    image: Image.Image,
    scale: float,
    *,
    origin: tuple[float, float] = (0.0, 0.0),
    psm: int = PSM,
    inverted: bool = False,
) -> list[Word]:
    """Run tesseract on `image` and return its words in PDF points (`origin` = the image's
    top-left in points, `scale` = pixels per point). `inverted` OCRs the negative: light text on
    a dark fill (the BOM's table header) is invisible to tesseract otherwise."""
    exe = tesseract_path()
    if exe is None:
        raise OcrError("tesseract is not installed (TESSERACT_CMD, PATH or the Windows default)")
    if inverted:
        image = ImageOps.invert(image)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    try:
        proc = subprocess.run(
            [exe, "stdin", "stdout", "--psm", str(psm), "tsv"],
            input=buf.getvalue(),
            capture_output=True,
            check=False,
            timeout=300,
        )
    except OSError as e:
        raise OcrError(f"tesseract could not be run: {e}") from e
    if proc.returncode != 0:
        raise OcrError(f"tesseract failed: {proc.stderr.decode('utf-8', 'replace')[-500:]}")
    ox, oy = origin
    words: list[Word] = []
    # QUOTE_NONE: a word tesseract reads as `"` must not open a quoted field spanning lines
    reader = csv.DictReader(
        io.StringIO(proc.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE
    )
    for row in reader:
        if row.get("level") != "5":
            continue
        text = (row.get("text") or "").strip()
        if not text:
            continue
        left, top = float(row["left"]), float(row["top"])
        w, h = float(row["width"]), float(row["height"])
        conf = float(row.get("conf") or 0)
        words.append(
            Word(
                text=text,
                x0=ox + left / scale,
                top=oy + top / scale,
                x1=ox + (left + w) / scale,
                bottom=oy + (top + h) / scale,
                conf=max(0.0, min(1.0, conf / 100)),
            )
        )
    return words


FILLED_GRAY = 175
"""A pixel row whose mean gray is below this sits on a dark fill (the BOM's blue header bar:
≈ 125–160; its striped rows ≈ 200–217; paper ≈ 253)."""

MIN_BAND_PX = 8
STRIP_MARGIN_PX = 3


def filled_bands(image: Image.Image) -> list[tuple[int, int]]:
    """`(y0, y1)` pixel ranges of rows on a dark fill. Tesseract's page layout treats a filled
    bar as a graphic and drops the light text printed on it; each band is OCR'd on its own."""
    width, height = image.size
    column = image.resize((1, height), Image.Resampling.BOX)
    means = list(column.getdata())
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for y, v in enumerate([*means, 255]):
        if v < FILLED_GRAY and start is None:
            start = y
        elif v >= FILLED_GRAY and start is not None:
            if y - start >= MIN_BAND_PX:
                bands.append((start, y))
            start = None
    return bands


def dedupe(words: list[Word], overlap: float = 0.5) -> list[Word]:
    """Drop a word whose box mostly covers one already kept (the same print read twice, by the
    plain and the negative pass — `tem` under `Item`); the better confidence stays."""
    kept: list[Word] = []
    for w in sorted(words, key=lambda w: -w.conf):
        if any(_overlap(k, w) > overlap for k in kept):
            continue
        kept.append(w)
    return kept


def _overlap(a: Word, b: Word) -> float:
    """Intersection over the smaller box's area."""
    ix = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    iy = max(0.0, min(a.bottom, b.bottom) - max(a.top, b.top))
    smaller = min((a.x1 - a.x0) * (a.bottom - a.top), (b.x1 - b.x0) * (b.bottom - b.top))
    return ix * iy / smaller if smaller > 0 else 0.0


def ocr_page(pdf_bytes: bytes, page_index: int) -> list[Word]:
    """Render one page, OCR each panel and each panel's filled bands (as single lines, plain and
    in the negative), return every word in page points."""
    image, scale = render_page(pdf_bytes, page_index)
    words: list[Word] = []
    for x0, x1 in panels(image):
        crop = image.crop((x0, 0, x1, image.size[1]))
        words.extend(ocr_words(crop, scale, origin=(x0 / scale, 0.0)))
        for y0, y1 in filled_bands(crop):
            top = max(0, y0 - STRIP_MARGIN_PX)
            strip = crop.crop((0, top, crop.size[0], min(crop.size[1], y1 + STRIP_MARGIN_PX)))
            origin = (x0 / scale, top / scale)
            for inverted in (False, True):
                words.extend(ocr_words(strip, scale, origin=origin, psm=7, inverted=inverted))
    return dedupe(words)
