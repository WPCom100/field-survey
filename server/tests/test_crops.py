"""Source crops for the draft review (T44, Phase 3 §3.3): `app.jobs.crops` renders the region of a
stored import PDF around a draft's `source_ref.bbox` with the bbox outlined in red, and
`GET /imports/{id}/crop` serves it as PNG."""

import io
import uuid

import pytest
from conftest import HDR
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

from app import projects
from app.auth import upsert_user
from app.ids import uuid7
from app.jobs import bom, crops

PAGE_W, PAGE_H = 612.0, 792.0
BOX = (100.0, 100.0, 50.0, 20.0)
"""A black box drawn at x 100, y 100 (top-left origin), 50 × 20 points."""


def _pdf(pages: int = 1) -> bytes:
    """A small PDF whose first page carries one filled black box at `BOX`."""
    w = PdfWriter()
    for i in range(pages):
        page = w.add_blank_page(width=PAGE_W, height=PAGE_H)
        if i == 0:
            x, y, bw, bh = BOX
            stream = DecodedStreamObject()
            # PDF user space is bottom-left origin: y_pdf = H - y - h
            stream.set_data(f"0 0 0 rg {x} {PAGE_H - y - bh} {bw} {bh} re f".encode())
            page[NameObject("/Contents")] = w._add_object(stream)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def _img(png: bytes) -> Image.Image:
    assert png.startswith(b"\x89PNG")
    return Image.open(io.BytesIO(png)).convert("RGB")


def test_crop_is_the_padded_region_with_the_box_outlined():
    img = _img(crops.render_crop(_pdf(), 1, BOX, pad=10, px=700))
    # region 70 × 40 pt, long edge 70 → scale min(6, 700 / 70) = 6
    assert img.size == (420, 240)
    centre = img.getpixel((210, 120))
    assert max(centre) < 60, centre  # the black box
    assert img.getpixel((5, 5)) == (255, 255, 255)  # page around it
    # the red outline sits just outside the box (box starts 10 pt = 60 px in)
    reds = [img.getpixel((x, 120)) for x in range(45, 61)]
    assert any(r > 180 and g < 90 and b < 90 for r, g, b in reds), reds


def test_crop_clips_to_the_page_and_can_skip_the_mark():
    img = _img(crops.render_crop(_pdf(), 1, (0, 0, 40, 40), pad=100, px=400, mark=False))
    # left and top are clipped at the page edge: 140 × 140 pt
    assert img.size == (400, 400)
    assert not any(
        r > 180 and g < 90 and b < 90
        for r, g, b in (img.getpixel((x, y)) for x in range(0, 400, 7) for y in range(0, 400, 7))
    )


def test_crop_refusals():
    with pytest.raises(crops.CropError, match="page 3"):
        crops.render_crop(_pdf(2), 3, BOX)
    with pytest.raises(crops.CropError, match="outside"):
        crops.render_crop(_pdf(), 1, (2000, 2000, 10, 10), pad=0)
    with pytest.raises(crops.CropError, match="four numbers"):
        crops.parse_bbox("1,2,3")
    with pytest.raises(crops.CropError, match="positive"):
        crops.parse_bbox("1,2,0,4")
    assert crops.parse_bbox("1.5,2,3,4") == (1.5, 2.0, 3.0, 4.0)


def test_crop_route(client, session, store):
    out = projects.create_project(
        session,
        projects.ProjectIn(name="Tower", levels=[projects.LevelIn(level="01")]),
        upsert_user(session, "Landry"),
    )
    batch = bom.create_bom_batch(
        session,
        store,
        project_id=uuid.UUID(out.id),
        filename="BOM.pdf",
        data=_pdf(2),
        user=upsert_user(session, "Landry"),
    )
    url = f"/imports/{batch.id}/crop"
    r = client.get(
        url, headers=HDR, params={"page": 1, "bbox": "100,100,50,20", "pad": 10, "px": 700}
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/png"
    assert "max-age" in r.headers["cache-control"]
    assert _img(r.content).size == (420, 240)

    assert client.get(url, params={"page": 1, "bbox": "1,1,5,5"}).status_code == 401
    bad_page = client.get(url, headers=HDR, params={"page": 9, "bbox": "1,1,5,5"})
    assert bad_page.status_code == 422 and "page 9" in bad_page.text
    bad_box = client.get(url, headers=HDR, params={"page": 1, "bbox": "1,1"})
    assert bad_box.status_code == 422
    unknown = client.get(
        f"/imports/{uuid7()}/crop", headers=HDR, params={"page": 1, "bbox": "1,1,5,5"}
    )
    assert unknown.status_code == 404
    store.objects.clear()
    gone = client.get(url, headers=HDR, params={"page": 1, "bbox": "1,1,5,5"})
    assert gone.status_code == 404
