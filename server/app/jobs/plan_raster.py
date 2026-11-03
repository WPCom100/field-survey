"""Rasterised display sheets (T141, D233, D242): a heavy vector composite as a one-page image PDF.

PDFKit draws every path of a vector page on each zoom step, so a composite of two million paths
(the Level 03 sheet) loads slowly and lags while panning, where the 155,000-path 06M composite
passed TP-6. A display sheet whose page draws more than `RASTER_MIN_OBJECTS` page objects is
therefore stored, as the blob the iPad opens, as a PDF whose page is the same sheet rendered at
`RASTER_DPI` in JPEG tiles: the same MediaBox (the original's CropBox), CropBox and /Rotate, so
sheet coordinates, pins, ink and the grid are untouched and the viewer stays PDFKit. The vector
original stays on the server (`features.raster.vector_blob`) for the text pass, `retag` and the
floor PDF's crops — `vector_blob()` is how the server finds it.

Tiles rather than one image: PDFKit renders the page tile by tile at each zoom level, and an image
XObject outside a tile's clip is skipped, so panning at high zoom decodes only the few tiles in
view. Each tile carries one extra pixel row and column of its neighbour, so no hairline seam shows
where two tiles meet at a fractional device position.

Pure functions over PDF bytes (pypdfium2 renders, Pillow encodes, the PDF is written by hand);
memory stays at one band of `BAND_PX` rows plus the encoded tiles.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from pypdf import PdfReader

RASTER_MIN_OBJECTS = 400_000
"""Page objects (paths, text runs, images, shadings, in form XObjects too) above which a display
sheet is rasterised: 2.5 × the 06M composite (155,627 paths, smooth on the iPad in TP-6). The
Level 03 composite draws 1,999,744 and Level 02 1,375,078."""

RASTER_DPI = 200.0
"""Pixels per inch of the sheet: the 5.5 pt device labels are ~15 px tall."""

RASTER_MAX_PIXELS = 250_000_000
"""A larger sheet is rendered at the dpi that fits this many pixels (Level 02, 120 × 82 in, at
~159 dpi): ~1 GB decoded on the iPad if PDFKit holds every tile at once."""

TILE_PX = 512
BAND_PX = 2048
"""Rows rendered at once; a band of the Level 03 sheet at 200 dpi is ~90 MB."""

JPEG_QUALITY = 75


@dataclass
class Raster:
    pdf: bytes
    dpi: float
    width_px: int
    height_px: int
    tiles: int


def page_objects(data: bytes, page_index: int = 0) -> int:
    """Every page object PDFKit would draw on the page, form XObjects' contents included."""
    doc = pdfium.PdfDocument(data)
    try:
        return sum(1 for _ in doc[page_index].get_objects(max_depth=32))
    finally:
        doc.close()


def vector_blob(blob: str | None, features: dict[str, Any] | None) -> str | None:
    """The sheet's vector PDF: the original kept beside a rasterised display sheet, else the
    sheet's own blob."""
    raster = (features or {}).get("raster") or {}
    return raster.get("vector_blob") or blob


def _num(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".")


def _boxes(data: bytes, page_index: int) -> tuple[list[float], int]:
    """The page's CropBox (as written in the file) and its /Rotate."""
    page = PdfReader(io.BytesIO(data)).pages[page_index]
    box = [float(v) for v in page.cropbox]
    return [min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])], (
        int(page.rotation) % 360
    )


def rasterise(
    data: bytes,
    page_index: int = 0,
    *,
    dpi: float = RASTER_DPI,
    max_pixels: int = RASTER_MAX_PIXELS,
    tile: int = TILE_PX,
    quality: int = JPEG_QUALITY,
) -> Raster:
    """The page rendered as a one-page PDF of JPEG tiles with the same CropBox and /Rotate."""
    (x0, y0, x1, y1), rotate = _boxes(data, page_index)
    wpt, hpt = x1 - x0, y1 - y0
    dpi = min(dpi, math.sqrt(max_pixels / (wpt * hpt / 72 / 72)))
    width, height = max(1, round(wpt * dpi / 72)), max(1, round(hpt * dpi / 72))
    sx, sy = width / wpt, height / hpt  # px per pt, after rounding to whole pixels

    doc = pdfium.PdfDocument(data)
    tiles: list[tuple[int, int, int, int, bytes]] = []  # col px, row px, w, h, jpeg
    try:
        page = doc[page_index]
        page.set_rotation(0)  # render the CropBox upright; the new page keeps the /Rotate
        band = max(tile, BAND_PX - BAND_PX % tile)
        for top in range(0, height, band):
            rows = min(band + 1, height - top)
            bitmap = pdfium.PdfBitmap.new_native(width, rows, pdfium_c.FPDFBitmap_BGR)
            bitmap.fill_rect((255, 255, 255, 255), 0, 0, width, rows)
            pdfium_c.FPDF_RenderPageBitmap(bitmap, page, 0, -top, width, height, 0, 0)
            image = bitmap.to_pil()
            for r in range(0, min(band, height - top), tile):
                for c in range(0, width, tile):
                    w, h = min(tile + 1, width - c), min(tile + 1, rows - r)
                    buf = io.BytesIO()
                    image.crop((c, r, c + w, r + h)).save(buf, "JPEG", quality=quality)
                    tiles.append((c, top + r, w, h, buf.getvalue()))
            del image, bitmap
    finally:
        doc.close()

    content = "".join(
        f"q {_num(w / sx)} 0 0 {_num(h / sy)} {_num(x0 + c / sx)} {_num(y1 - (r + h) / sy)} cm "
        f"/T{i} Do Q\n"
        for i, (c, r, w, h, _) in enumerate(tiles)
    ).encode()
    pdf = _write_pdf((x0, y0, x1, y1), rotate, content, tiles)
    return Raster(pdf, dpi, width, height, len(tiles))


def _write_pdf(
    box: tuple[float, float, float, float],
    rotate: int,
    content: bytes,
    tiles: list[tuple[int, int, int, int, bytes]],
) -> bytes:
    """Catalog 1, Pages 2, Page 3, contents 4, tile i = object 5 + i."""
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []

    def obj(body: bytes, stream: bytes | None = None) -> None:
        offsets.append(out.tell())
        out.write(f"{len(offsets)} 0 obj\n".encode() + body)
        if stream is not None:
            out.write(b"\nstream\n" + stream + b"\nendstream")
        out.write(b"\nendobj\n")

    media = " ".join(_num(v) for v in box)
    xobjects = " ".join(f"/T{i} {5 + i} 0 R" for i in range(len(tiles)))
    obj(b"<< /Type /Catalog /Pages 2 0 R >>")
    obj(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    obj(
        f"<< /Type /Page /Parent 2 0 R /MediaBox [{media}] /CropBox [{media}] /Rotate {rotate} "
        f"/Resources << /XObject << {xobjects} >> >> /Contents 4 0 R >>".encode()
    )
    obj(f"<< /Length {len(content)} >>".encode(), content)
    for _, _, w, h, jpeg in tiles:
        obj(
            f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB "
            f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>".encode(),
            jpeg,
        )
    xref = out.tell()
    out.write(f"xref\n0 {len(offsets) + 1}\n0000000000 65535 f \n".encode())
    out.write("".join(f"{o:010d} 00000 n \n" for o in offsets).encode())
    out.write(f"trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R >>\n".encode())
    out.write(f"startxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()
