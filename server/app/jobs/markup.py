"""Flatten a photo's markup (a `field-survey/strokes` list) onto its JPEG (T29; T59 reuses it).

The drawing rules are `packages/core/docs/strokes.md`, the one source of truth shared with the
iPad (`app/src/ink/render.ts`): pen width `width × (0.4 + 1.2 p̄)`, highlighter at constant width
and alpha 0.35, arrow barbs `4 × width` at ±π/7, ellipse in the box of its two corners, bold text
at size `width` with a halo of `width / 6`, a camera mark `width` across. Coordinates are in the
list's `space` units (`image`: pixels of the stored JPEG) and are scaled by `shown / width` when the
image is drawn at another size (the Photo Log carries the 320-px thumbnail, not the full JPEG).

A photo without markup is returned **byte for byte** (never re-encoded), so TP-4 compares the
seed-imported thumbnails as identical media. A malformed stroke is skipped, never fatal.
"""

from __future__ import annotations

import io
import json
import math
from typing import Any

from PIL import Image, ImageDraw, ImageFont

FORMAT = "field-survey/strokes"
VERSION = 1
HIGHLIGHTER_ALPHA = 0.35
JPEG_QUALITY = 90

_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)


class MarkupError(ValueError):
    pass


def parse_strokes(data: bytes | str | dict[str, Any]) -> dict[str, Any]:
    """The envelope, checked; raises `MarkupError` for another format or a newer version."""
    doc = data if isinstance(data, dict) else json.loads(data)
    if doc.get("format") != FORMAT:
        raise MarkupError(f"not a stroke list: format {doc.get('format')!r}")
    if doc.get("version") != VERSION:
        raise MarkupError(f"stroke list version {doc.get('version')!r} is not {VERSION}")
    if not isinstance(doc.get("strokes"), list):
        raise MarkupError("stroke list without strokes")
    return doc


def _color(text: str | None, alpha: float = 1.0) -> tuple[int, int, int, int]:
    t = (text or "#111111").lstrip("#")
    if len(t) == 3:
        t = "".join(c * 2 for c in t)
    if len(t) not in (6, 8):
        t = "111111"
    r, g, b = int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16)
    a = int(t[6:8], 16) if len(t) == 8 else 255
    return (r, g, b, round(a * alpha))


def _points(stroke: dict[str, Any], scale: float) -> list[tuple[float, float, float]]:
    raw = stroke.get("points")
    if not isinstance(raw, list) or len(raw) < 3 or len(raw) % 3:
        raise MarkupError("points must be flat x, y, p triples")
    out = []
    for k in range(0, len(raw), 3):
        x, y, p = raw[k : k + 3]
        out.append((float(x) * scale, float(y) * scale, min(1.0, max(0.0, float(p)))))
    return out


def _font(size: float) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    px = max(6, round(size))
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, px)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def _draw_stroke(layer: Image.Image, stroke: dict[str, Any], scale: float) -> None:
    tool = stroke.get("tool")
    width = max(0.5, float(stroke.get("width", 4)) * scale)
    pts = _points(stroke, scale)
    draw = ImageDraw.Draw(layer, "RGBA")
    if tool == "pen":
        color = _color(stroke.get("color"))
        if len(pts) == 1:
            x, y, p = pts[0]
            r = width * (0.4 + 1.2 * p) / 2
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
            return
        for (x0, y0, p0), (x1, y1, p1) in zip(pts, pts[1:], strict=False):
            w = width * (0.4 + 1.2 * (p0 + p1) / 2)
            draw.line((x0, y0, x1, y1), fill=color, width=max(1, round(w)))
            r = w / 2
            for x, y in ((x0, y0), (x1, y1)):  # round caps
                draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
    elif tool == "highlighter":
        color = _color(stroke.get("color"), HIGHLIGHTER_ALPHA)
        # One polyline on its own layer so overlapping segments do not double the alpha.
        band = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(band, "RGBA")
        w = max(1, round(width))
        if len(pts) == 1:
            x, y, _ = pts[0]
            bd.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=color)
        else:
            bd.line([(x, y) for x, y, _ in pts], fill=color, width=w, joint="curve")
            for x, y, _ in (pts[0], pts[-1]):
                bd.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=color)
        layer.alpha_composite(band)
    elif tool == "arrow":
        if len(pts) < 2:
            raise MarkupError("arrow needs two points")
        color = _color(stroke.get("color"))
        (x0, y0, _), (x1, y1, _) = pts[0], pts[-1]
        w = max(1, round(width))
        draw.line((x0, y0, x1, y1), fill=color, width=w)
        angle = math.atan2(y1 - y0, x1 - x0)
        barb = 4 * width
        for side in (math.pi / 7, -math.pi / 7):
            a = angle + math.pi + side
            draw.line(
                (x1, y1, x1 + barb * math.cos(a), y1 + barb * math.sin(a)), fill=color, width=w
            )
    elif tool == "ellipse":
        if len(pts) < 2:
            raise MarkupError("ellipse needs two points")
        color = _color(stroke.get("color"))
        (x0, y0, _), (x1, y1, _) = pts[0], pts[-1]
        box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        if box[2] - box[0] < 1 or box[3] - box[1] < 1:
            return
        draw.ellipse(box, outline=color, width=max(1, round(width)))
    elif tool == "text":
        text = str(stroke.get("text") or "")
        if not text:
            return
        color = _color(stroke.get("color"))
        x, y, _ = pts[0]
        font = _font(width)
        halo = max(1, round(width / 6))
        # Contrasting halo: white under dark text, black under light text.
        r, g, b, _a = color
        halo_color = (255, 255, 255, 255) if (r + g + b) < 384 else (0, 0, 0, 255)
        draw.text(
            (x, y),
            text,
            font=font,
            fill=color,
            anchor="ls",
            stroke_width=halo,
            stroke_fill=halo_color,
        )
    elif tool == "marker":
        color = _color(stroke.get("color"))
        x, y, _ = pts[0]
        s = width  # the mark is `width` across
        body = (x - s / 2, y - s * 0.3, x + s / 2, y + s * 0.4)
        draw.rounded_rectangle(body, radius=s / 10, fill=color)
        draw.rectangle((x - s / 6, y - s * 0.42, x + s / 6, y - s * 0.3), fill=color)
        lens = s * 0.22
        draw.ellipse(
            (x - lens, y + s * 0.05 - lens, x + lens, y + s * 0.05 + lens),
            fill=(255, 255, 255, 255),
        )
        draw.ellipse(
            (
                x - lens * 0.55,
                y + s * 0.05 - lens * 0.55,
                x + lens * 0.55,
                y + s * 0.05 + lens * 0.55,
            ),
            fill=color,
        )
    else:
        raise MarkupError(f"unknown tool {tool!r}")


def flatten(image_bytes: bytes, strokes: bytes | str | dict[str, Any] | None) -> tuple[bytes, int]:
    """The JPEG with the strokes drawn over it, and how many strokes were skipped. With no strokes
    (None, or an empty list) the input bytes come back untouched."""
    if strokes is None:
        return image_bytes, 0
    doc = parse_strokes(strokes)
    items = [s for s in doc["strokes"] if isinstance(s, dict)]
    if not items:
        return image_bytes, 0
    with Image.open(io.BytesIO(image_bytes)) as im:
        base = im.convert("RGBA")
    shown = base.width
    drawn = float(doc.get("width") or shown) or shown
    scale = shown / drawn
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    skipped = 0
    for stroke in items:
        try:
            _draw_stroke(layer, stroke, scale)
        except (MarkupError, ValueError, TypeError):
            skipped += 1
    out = Image.alpha_composite(base, layer).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue(), skipped
