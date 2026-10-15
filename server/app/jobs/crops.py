"""Source crops for the draft review screens (T44, Phase 3 §3.3).

A draft's `source_ref` points into the PDF its import batch stored (`imports/<batch>/<file>`):
a 1-based `page` and a `bbox` in page points, top-left origin, as `[x, y, width, height]`
(the iPad converts the BOM's `[x0, top, x1, bottom]` lines before asking). The reviewer sees
that region with some page around it and the region itself outlined in red — the BOM line, the
riser symbol, or the wire bubble whose endpoints are being confirmed (D6).

Pure: bytes in, PNG bytes out. No database, no network.
"""

import io

import pypdfium2 as pdfium
from PIL import Image, ImageDraw

MAX_PX = 2000
MIN_PX = 200
MAX_SCALE = 6.0
MARK = (211, 47, 47)


class CropError(ValueError):
    """A request the PDF cannot answer (no such page, a box off the page)."""


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    """`"x,y,w,h"` → floats; width and height must be positive."""
    try:
        parts = [float(v) for v in text.split(",")]
    except ValueError as e:
        raise CropError(f"bbox must be four numbers x,y,w,h: {text!r}") from e
    if len(parts) != 4:
        raise CropError(f"bbox must be four numbers x,y,w,h: {text!r}")
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        raise CropError("bbox width and height must be positive")
    return x, y, w, h


def render_crop(
    pdf: bytes,
    page: int,
    bbox: tuple[float, float, float, float],
    *,
    pad: float = 36.0,
    px: int = 1200,
    mark: bool = True,
) -> bytes:
    """The region `bbox` of 1-based `page`, grown by `pad` points on every side and clipped to
    the page, rendered so its long edge is about `px` pixels, as PNG; with `mark`, the bbox
    itself outlined in red."""
    px = max(MIN_PX, min(MAX_PX, int(px)))
    doc = pdfium.PdfDocument(pdf)
    try:
        if page < 1 or page > len(doc):
            raise CropError(f"page {page} is not in this PDF ({len(doc)} pages)")
        p = doc[page - 1]
        try:
            pw, ph = p.get_size()
            x, y, w, h = bbox
            x0, top = max(0.0, x - pad), max(0.0, y - pad)
            x1, bottom = min(pw, x + w + pad), min(ph, y + h + pad)
            if x1 - x0 < 1 or bottom - top < 1:
                raise CropError("bbox is outside the page")
            scale = min(MAX_SCALE, px / max(x1 - x0, bottom - top))
            # pdfium crops are (left, bottom, right, top) margins from the page edges
            img = (
                p.render(scale=scale, crop=(x0, ph - bottom, pw - x1, top)).to_pil().convert("RGB")
            )
        finally:
            p.close()
    finally:
        doc.close()
    if mark:
        draw = ImageDraw.Draw(img)
        line = max(2, round(scale * 1.2))
        box = [
            (x - x0) * scale - line,
            (y - top) * scale - line,
            (x + w - x0) * scale + line,
            (y + h - top) * scale + line,
        ]
        draw.rectangle(box, outline=MARK, width=line)
    return _png(img)


def _png(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()
