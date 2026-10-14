"""The floor PDF (T59, PLAN §7.7, D56, D66, D120): one level's report for the EC, ETC and GC.

Dense by design (D66): a cover, then sections that flow without forced page breaks — findings
three to four per page, then connections, the punch list, missing parts and a 2×3 photo appendix.
The header carries the survey date only, never a company name (R7).

    load(session, store, project_id, level_code, sections) → FloorData   (reads, no writes)
    render(data) → PDF bytes                                            (WeasyPrint)

The plan snapshot is the level's display sheet rasterised with pdfium (`pypdfium2`) in sheet
coordinates (CropBox top-left origin, y down, PDF points — `app/src/plan/viewport.ts`), every
user's ink layer drawn over it with the stroke rules of `packages/core/docs/strokes.md`
(`markup.draw_strokes`), then the pins: shape = category, fill = status (D64, the app's
`pins.ts`), labelled with the device type (the app's `pinLabel`, D119/D120). The findings carry a
crop of the same raster around each device's pin. Photos in the appendix are the full JPEG when
the server has it (else the thumbnail), markup flattened, scaled down for print.

WeasyPrint needs the Pango libraries (present in the server image); it is imported only by
`render`, so the module loads anywhere.
"""

from __future__ import annotations

import base64
import html
import io
import math
import uuid
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.blobs import object_key
from app.jobs import export_xlsx, markup
from app.models import (
    Device,
    InkLayer,
    Level,
    MissingPart,
    Op,
    Photo,
    PhotoLink,
    Project,
    PunchItem,
    Sheet,
)
from app.storage import ObjectMissing, ObjectStore

PDF_MIME = "application/pdf"
SECTIONS = ("plan", "findings", "connections", "punch", "parts", "photos")
UNSURVEYED = export_xlsx.UNSURVEYED
NOT_A_FINDING = "Installed, untested"  # PLAN §7.7: findings = Status ≠ Installed, untested
PIN_LABEL_MAX = 22  # app/src/plan/data.ts
DEVICE_STATUS = ("Complete", "Installed, untested", "Issue", "Not installed", "No access")

# app/src/plan/pins.ts (D64)
STATUS_STYLE: dict[str | None, tuple[str, bool, str]] = {
    "Complete": ("#2e7d32", False, "C"),
    "Installed, untested": ("#6a1b9a", False, "U"),
    "Issue": ("#c62828", False, "!"),
    "Not installed": ("#c62828", True, "NI"),
    "No access": ("#f9a825", False, "A"),
    "Not started": ("#757575", False, "·"),
    None: ("#757575", False, "–"),
}

COVER_PX = 1700  # cover raster width; printed ≈ 7.5 in → ~225 dpi
CROP_PT = (300.0, 200.0)  # sheet area around a finding's pin
CROP_SCALE = 1.0  # raster px per sheet pt for crops
PHOTO_MAX_PX = 1100
THUMBS_PER_FINDING = 4


# ------------------------------------------------------------------ data


@dataclass
class FloorDevice:
    id: uuid.UUID
    display_id: str
    category: str | None
    device: str | None
    type: str | None
    room: str | None
    status: str | None
    notes: str | None
    pin: tuple[float, float] | None
    owners: list[str]
    open_items: list[str]
    thumbs: list[bytes]

    @property
    def label(self) -> str:
        return pin_label(self.type, self.device, self.category)


@dataclass
class FloorPhoto:
    number: int | None
    subject: str | None
    device_ids: list[str]
    jpeg: bytes | None


@dataclass
class FloorData:
    title: str
    level: str
    surveyed: date | None
    sections: tuple[str, ...]
    devices: list[FloorDevice]
    counts: dict[str, int]
    sheet_pdf: bytes | None = None
    sheet_size: tuple[float, float] | None = None
    ink: list[bytes] = field(default_factory=list)
    connections: list[list[Any]] = field(default_factory=list)
    punch: list[list[Any]] = field(default_factory=list)
    parts: list[list[Any]] = field(default_factory=list)
    photos: list[FloorPhoto] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)


def pin_label(type_: str | None, device: str | None, category: str | None) -> str:
    """Type, else Device (model), else category, cut to 22 characters (app `pinLabel`, D120)."""
    s = ((type_ or device or category or "").strip()) or "Device"
    return s if len(s) <= PIN_LABEL_MAX else s[: PIN_LABEL_MAX - 1].rstrip() + "…"


def _read(store: ObjectStore | None, sha: str | None) -> bytes | None:
    if store is None or not sha:
        return None
    try:
        return store.read(object_key(sha))
    except (ObjectMissing, KeyError):
        return None


def _last_survey_date(session: Session, project_id: uuid.UUID, ids: list[uuid.UUID]) -> date:
    """D159: with no `surveyed` on the level, the date of its newest field-survey op, else today."""
    newest = None
    if ids:
        newest = session.scalar(
            select(func.max(func.coalesce(Op.server_ts, Op.client_ts))).where(
                Op.project_id == project_id,
                Op.change_type == "Field survey",
                Op.entity_id.in_(ids),
            )
        )
    return newest.date() if newest else date.today()


def load(
    session: Session,
    store: ObjectStore | None,
    project_id: uuid.UUID,
    level_code: str,
    sections: tuple[str, ...] = SECTIONS,
) -> FloorData:
    project = session.get(Project, project_id)
    if project is None:
        raise LookupError(f"unknown project {project_id}")
    level = session.scalars(
        select(Level).where(
            Level.project_id == project_id, Level.level == level_code, Level.deleted_at.is_(None)
        )
    ).first()
    if level is None:
        raise LookupError(f"unknown level {level_code}")
    settings = project.settings or {}
    data = FloorData(
        title=settings.get("export_title") or export_xlsx.DEFAULT_TITLE,
        level=level.level,
        surveyed=level.surveyed,  # D159 fallback is applied below, once the rows are loaded
        sections=tuple(s for s in SECTIONS if s in sections),
        devices=[],
        counts={},
    )

    def live(model):
        return session.scalars(
            select(model).where(model.level_id == level.id, model.deleted_at.is_(None))
        ).all()

    devices = live(Device)
    punches = live(PunchItem)
    parts = live(MissingPart)
    if data.surveyed is None:
        ids = [r.id for r in (*devices, *punches, *parts)]
        data.surveyed = _last_survey_date(session, project_id, ids)
    photos = sorted(live(Photo), key=lambda p: (p.number is None, p.number or 0))

    owners: dict[uuid.UUID, set[str]] = {}
    items: dict[uuid.UUID, list[str]] = {}
    for p in sorted(punches, key=lambda p: (p.sort_last, p.number or 0)):
        if p.device_id and p.tracking_status != "Closed":
            if p.owner:
                owners.setdefault(p.device_id, set()).add(p.owner)
            num = f"#{p.number}" if p.number is not None else "NEW"
            items.setdefault(p.device_id, []).append(f"{num} {p.item or ''}".strip())
    for m in parts:
        if m.device_id and m.part_status != "Installed" and m.owner:
            owners.setdefault(m.device_id, set()).add(m.owner)

    # photos per device: taken from (device_id) and links (D128)
    device_photos: dict[uuid.UUID, list[Photo]] = {}
    photo_devices: dict[uuid.UUID, list[uuid.UUID]] = {p.id: [] for p in photos}
    for ph in photos:
        if ph.device_id:
            photo_devices[ph.id].append(ph.device_id)
    if photos:
        for link in session.scalars(
            select(PhotoLink).where(
                PhotoLink.photo_id.in_(list(photo_devices)),
                PhotoLink.target_kind == "device",
                PhotoLink.deleted_at.is_(None),
            )
        ):
            photo_devices[link.photo_id].append(link.target_id)
    for ph in photos:
        for did in photo_devices[ph.id]:
            device_photos.setdefault(did, []).append(ph)

    sheet = session.get(Sheet, level.display_sheet_id) if level.display_sheet_id else None
    by_id: dict[uuid.UUID, Device] = {d.id: d for d in devices}
    for d in sorted(devices, key=lambda d: export_xlsx.id_sort_key(d.display_id)):
        pin = None
        if (
            sheet is not None
            and isinstance(d.pin, dict)
            and str(d.pin.get("sheet")) == str(sheet.id)
        ):
            try:
                pin = (float(d.pin["x"]), float(d.pin["y"]))
            except (KeyError, TypeError, ValueError):
                data.checks.append(f"{d.display_id}: pin unreadable")
        status = d.status if d.status in STATUS_STYLE else None
        want_thumbs = "findings" in data.sections and status != NOT_A_FINDING
        thumbs = []
        if want_thumbs:
            for ph in device_photos.get(d.id, [])[:THUMBS_PER_FINDING]:
                b = _read(store, ph.thumb_blob)
                if b:
                    thumbs.append(b)
        data.devices.append(
            FloorDevice(
                id=d.id,
                display_id=d.display_id or f"{level.level}-?",
                category=d.category,
                device=d.device,
                type=d.type,
                room=d.room_location,
                status=status,
                notes=d.notes,
                pin=pin,
                owners=sorted(owners.get(d.id, set())),
                open_items=items.get(d.id, []),
                thumbs=thumbs,
            )
        )
    for s in (*DEVICE_STATUS, None):
        data.counts[s or UNSURVEYED] = sum(1 for d in data.devices if d.status == s)

    if sheet is not None and ({"plan", "findings"} & set(data.sections)):
        data.sheet_pdf = _read(store, sheet.blob)
        if data.sheet_pdf is None:
            data.checks.append("display sheet not in storage: no plan snapshot")
        data.sheet_size = (float(sheet.width_pt or 0), float(sheet.height_pt or 0))
        for layer in session.scalars(
            select(InkLayer).where(InkLayer.sheet_id == sheet.id, InkLayer.deleted_at.is_(None))
        ):
            b = _read(store, layer.drawing_blob)
            if b:
                data.ink.append(b)
            elif layer.drawing_blob:
                data.checks.append("an ink layer is not in storage")

    # the tables, generated exactly as the workbook's (one level)
    if {"connections", "punch", "parts"} & set(data.sections):
        rows = export_xlsx.load(session, None, project_id, {"levels": [level.level]}).rows
        data.connections = rows["Connections"]
        data.punch = rows["Punch List"]
        data.parts = rows["Missing Parts"]

    if "photos" in data.sections:
        for ph in photos:
            jpeg = _read(store, ph.image_blob) or _read(store, ph.thumb_blob)
            if jpeg and ph.markup_blob:
                strokes = _read(store, ph.markup_blob)
                try:
                    jpeg, _ = markup.flatten(jpeg, strokes)
                except (markup.MarkupError, ValueError):
                    data.checks.append(f"photo {ph.number}: markup not drawn")
            ids = [by_id[i].display_id for i in photo_devices[ph.id] if i in by_id]
            data.photos.append(
                FloorPhoto(
                    number=ph.number,
                    subject=ph.subject,
                    device_ids=[i for i in ids if i],
                    jpeg=_shrink(jpeg) if jpeg else None,
                )
            )
    return data


# ------------------------------------------------------------------ pictures


def _shrink(jpeg: bytes, max_px: int = PHOTO_MAX_PX) -> bytes:
    with Image.open(io.BytesIO(jpeg)) as im:
        if max(im.size) <= max_px:
            return jpeg
        im = im.convert("RGB")
        im.thumbnail((max_px, max_px))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85)
        return buf.getvalue()


def _font(px: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return markup._font(px)


def _rgb(hex_: str) -> tuple[int, int, int]:
    h = hex_.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _polygon(n: int, r: float, cx: float, cy: float) -> list[tuple[float, float]]:
    return [
        (
            cx + r * math.cos(-math.pi / 2 + 2 * math.pi * k / n),
            cy + r * math.sin(-math.pi / 2 + 2 * math.pi * k / n),
        )
        for k in range(n)
    ]


def draw_pin(
    draw: ImageDraw.ImageDraw,
    x: float,
    y: float,
    category: str | None,
    status: str | None,
    size: float,
    label: str | None = None,
    ring: bool = False,
) -> None:
    """One pin as the app draws it (pins.ts): shape by category, fill by status, glyph inside."""
    fill_hex, hollow, glyph = STATUS_STYLE.get(status, STATUS_STYLE[None])
    color = _rgb(fill_hex)
    fill = (255, 255, 255) if hollow else color
    outline = color if hollow else (255, 255, 255)
    width = max(2, round(size / 8))
    r = size / 2
    if ring:
        rr = size * 1.05
        draw.ellipse(
            (x - rr, y - rr, x + rr, y + rr), outline=(255, 152, 0), width=max(3, round(size / 6))
        )
    if category == "Relay panel":
        draw.rectangle((x - r, y - r, x + r, y + r), fill=fill, outline=outline, width=width)
    elif category == "Foundry panel":
        draw.rounded_rectangle(
            (x - r, y - r, x + r, y + r),
            radius=size * 0.25,
            fill=fill,
            outline=outline,
            width=width,
        )
    elif category == "EBDK":
        draw.rectangle(
            (x - r * 1.5, y - r * 0.7, x + r * 1.5, y + r * 0.7),
            fill=fill,
            outline=outline,
            width=width,
        )
    elif category == "Station":
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill, outline=outline, width=width)
    else:
        n, k = {
            "Equipment rack": (6, 1.1),
            "NSPS": (5, 1.1),
            "Touchscreen": (3, 1.2),
            "Sensor": (4, 1.2),
        }.get(category or "", (8, 1.05))
        draw.polygon(_polygon(n, r * k, x, y), fill=fill, outline=outline, width=width)
    font = _font(max(8, round(size * (0.42 if len(glyph) > 1 else 0.6))))
    draw.text((x, y), glyph, font=font, fill=color if hollow else (255, 255, 255), anchor="mm")
    if label:
        lf = _font(max(9, round(size * 0.6)))
        draw.text(
            (x + r * 1.6, y),
            label,
            font=lf,
            fill=(20, 20, 20),
            anchor="lm",
            stroke_width=max(1, round(size / 10)),
            stroke_fill=(255, 255, 255),
        )


def sheet_raster(data: FloorData, scale: float) -> Image.Image | None:
    """The display sheet at `scale` px per sheet point with every ink layer drawn on it."""
    if not data.sheet_pdf:
        return None
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data.sheet_pdf)
    try:
        img = doc[0].render(scale=scale).to_pil().convert("RGBA")
    finally:
        doc.close()
    if data.ink:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        for blob in data.ink:
            try:
                skipped = markup.draw_strokes(layer, blob, scale)
            except (markup.MarkupError, ValueError):
                data.checks.append("an ink layer is not a stroke list")
                continue
            if skipped:
                data.checks.append(f"ink: {skipped} stroke(s) not drawn")
        img = Image.alpha_composite(img, layer)
    return img


def cover_image(data: FloorData, base: Image.Image) -> bytes:
    """The whole sheet with every pin, labelled by device type."""
    w = COVER_PX
    s = w / base.width
    img = base.resize((w, max(1, round(base.height * s))), Image.LANCZOS).convert("RGB")
    draw = ImageDraw.Draw(img)
    px_per_pt = s * CROP_SCALE  # the base raster is CROP_SCALE px per sheet point
    for d in data.devices:
        if d.pin:
            draw_pin(
                draw, d.pin[0] * px_per_pt, d.pin[1] * px_per_pt, d.category, d.status, 20, d.label
            )
    return _jpeg(img)


def crop_image(
    data: FloorData, base: Image.Image, scale: float, subject: FloorDevice
) -> bytes | None:
    """The sheet around one device's pin, its neighbours drawn, the subject ringed."""
    if not subject.pin:
        return None
    cw, ch = CROP_PT
    x0 = min(max(0.0, subject.pin[0] - cw / 2), max(0.0, base.width / scale - cw))
    y0 = min(max(0.0, subject.pin[1] - ch / 2), max(0.0, base.height / scale - ch))
    box = tuple(round(v * scale) for v in (x0, y0, x0 + cw, y0 + ch))
    img = base.crop(box).convert("RGB")
    draw = ImageDraw.Draw(img)
    for d in data.devices:
        if not d.pin:
            continue
        x, y = (d.pin[0] - x0) * scale, (d.pin[1] - y0) * scale
        if -20 <= x <= img.width + 20 and -20 <= y <= img.height + 20 and d is not subject:
            draw_pin(draw, x, y, d.category, d.status, 16)
    sx, sy = (subject.pin[0] - x0) * scale, (subject.pin[1] - y0) * scale
    draw_pin(draw, sx, sy, subject.category, subject.status, 20, subject.display_id, ring=True)
    return _jpeg(img)


def _jpeg(img: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _uri(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


# ------------------------------------------------------------------ HTML

CSS = (Path(__file__).with_suffix(".css")).read_text(encoding="utf-8")


def _e(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, date):
        return v.isoformat()
    return html.escape(str(v))


def _table(headers: list[str], rows: list[list[Any]], widths: list[str] | None = None) -> str:
    if not rows:
        return '<p class="empty">None.</p>'
    cols = "".join(f'<col style="width:{w}">' for w in widths) if widths else ""
    head = "".join(f"<th>{_e(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{_e(c)}</td>" for c in r) + "</tr>" for r in rows)
    return (
        f"<table><colgroup>{cols}</colgroup><thead><tr>{head}</tr></thead>"
        f"<tbody>{body}</tbody></table>"
    )


def build_html(data: FloorData) -> str:
    surveyed = f"Surveyed {data.surveyed.isoformat()}" if data.surveyed else "Surveyed —"
    heading = f"{data.title} — Level {data.level}"
    out: list[str] = []
    # the running header: date only, no company name (R7); a CSS string, not markup
    header = f"{heading} · {surveyed}".replace("\\", "\\\\").replace('"', '\\"')
    page_css = (
        f'@page {{ @top-left {{ content: "{header}"; }} }}'
        " @page cover { @top-left { content: none; } }"
    )

    base = None
    if data.sheet_pdf and ({"plan", "findings"} & set(data.sections)):
        try:
            base = sheet_raster(data, CROP_SCALE)
        except Exception as e:  # noqa: BLE001 - a broken sheet must not lose the report
            data.checks.append(f"plan not rendered: {type(e).__name__}")

    # cover
    statuses = list(data.counts)
    counts = (
        "<table class='counts'><thead><tr>"
        + "".join(f"<th>{_e(s)}</th>" for s in statuses)
        + "<th>Total</th></tr></thead><tbody><tr>"
        + "".join(f"<td>{data.counts[s]}</td>" for s in statuses)
        + f"<td>{sum(data.counts.values())}</td></tr></tbody></table>"
    )
    out.append(
        f'<section class="cover"><h1>{_e(heading)}</h1>'
        f'<div class="surveyed">{_e(surveyed)}</div>{counts}'
    )
    if "plan" in data.sections:
        if base is not None:
            out.append(f'<img class="plan" src="{_uri(cover_image(data, base))}">')
        else:
            out.append('<p class="empty">No plan sheet for this level.</p>')
    out.append("</section>")

    if "findings" in data.sections:
        findings = [d for d in data.devices if d.status != NOT_A_FINDING]
        out.append(f"<h2>Findings ({len(findings)})</h2>")
        if not findings:
            out.append('<p class="empty">Every device is Installed, untested.</p>')
        for d in findings:
            color, _, _ = STATUS_STYLE.get(d.status, STATUS_STYLE[None])
            title = f"{d.display_id} — {d.device or d.category or 'Device'}"
            meta = " | ".join(
                [d.status or UNSURVEYED, "/".join(d.owners) or "no open owner", d.category or "—"]
            )
            crop = crop_image(data, base, CROP_SCALE, d) if base is not None else None
            parts = [
                '<div class="finding"><div class="text">',
                f'<div class="ftitle"><span class="dot" style="background:{color}"></span>'
                f"{_e(title)}</div>",
                f'<div class="meta">{_e(meta)}</div>',
            ]
            if d.room:
                parts.append(f'<div class="meta">Room / Location: {_e(d.room)}</div>')
            if d.type:
                parts.append(f'<div class="meta">Type: {_e(d.type)}</div>')
            if d.notes:
                parts.append(f'<div class="notes">{_e(d.notes)}</div>')
            if d.open_items:
                parts.append(
                    '<ul class="items">'
                    + "".join(f"<li>{_e(i)}</li>" for i in d.open_items[:5])
                    + "</ul>"
                )
            if d.thumbs:
                parts.append(
                    '<div class="thumbs">'
                    + "".join(f'<img src="{_uri(t)}">' for t in d.thumbs)
                    + "</div>"
                )
            parts.append("</div>")
            if crop:
                parts.append(f'<img class="crop" src="{_uri(crop)}">')
            parts.append("</div>")
            out.append("".join(parts))

    if "connections" in data.sections:
        out.append(f"<h2>Connections ({len(data.connections)})</h2>")
        out.append(
            _table(
                ["ID", "From", "Cable", "To", "Qty", "Status", "Note"],
                [r[1:8] for r in data.connections],
                ["7%", "22%", "6%", "25%", "5%", "12%", "23%"],
            )
        )
    if "punch" in data.sections:
        out.append(f"<h2>Punch list ({len(data.punch)})</h2>")
        out.append(
            _table(
                ["#", "Device", "Item", "Type", "Owner", "Tracking", "Closed", "Notes"],
                [[r[1], r[2], r[3], r[4], r[6], r[7], r[8], r[9]] for r in data.punch],
                ["5%", "20%", "23%", "10%", "7%", "9%", "9%", "17%"],
            )
        )
    if "parts" in data.sections:
        out.append(f"<h2>Missing parts ({len(data.parts)})</h2>")
        out.append(
            _table(
                [
                    "#",
                    "Device / Location",
                    "Part",
                    "Part no.",
                    "Qty",
                    "Owner",
                    "Source",
                    "Status",
                    "Notes",
                ],
                [r[1:10] for r in data.parts],
                ["5%", "15%", "18%", "9%", "5%", "6%", "14%", "9%", "19%"],
            )
        )
    if "photos" in data.sections:
        out.append(f"<h2>Photos ({len(data.photos)})</h2>")
        if not data.photos:
            out.append('<p class="empty">No photos on this level.</p>')
        cells = []
        for ph in data.photos:
            num = ph.number if ph.number is not None else "NEW"
            caption = " — ".join(
                x for x in (f"Photo {num}", ph.subject or "", ", ".join(ph.device_ids)) if x
            )
            img = (
                f'<img src="{_uri(ph.jpeg)}">'
                if ph.jpeg
                else '<div class="empty">picture not on the server yet</div>'
            )
            cells.append(f'<td class="photo">{img}<div class="caption">{_e(caption)}</div></td>')
        # a two-column table: rows paginate cleanly (3 rows = the 2×3 page of D56)
        rows = [cells[k : k + 2] for k in range(0, len(cells), 2)]
        out.append(
            '<table class="photos">'
            + "".join(
                "<tr>" + "".join(r) + ("<td></td>" if len(r) == 1 else "") + "</tr>" for r in rows
            )
            + "</table>"
        )
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        + CSS
        + page_css
        + "</style></head><body>"
        + "".join(out)
        + "</body></html>"
    )


def render(data: FloorData) -> bytes:
    """The PDF. Needs WeasyPrint's system libraries (Pango), present in the server image."""
    from weasyprint import HTML

    return HTML(string=build_html(data)).write_pdf()


def weasyprint_available() -> str | None:
    """None when WeasyPrint can run here, else why not (tests skip with that reason)."""
    try:
        import weasyprint  # noqa: F401
    except (ImportError, OSError) as e:
        return f"WeasyPrint cannot load here ({type(e).__name__}); run in the server image"
    return None
