"""Rasterised display sheets (T141, D233, D242): the raster PDF keeps the sheet's CropBox, /Rotate
and coordinates, shows no seams between its tiles, and the plans job stores it as the blob the
iPad opens with the vector original beside it for the text pass, `retag` and the floor PDF."""

import io
import math

import pypdfium2 as pdfium
import pytest
from conftest import SERVER_DIR
from pypdf import PdfReader
from sqlalchemy import select
from test_plans import _project_with_level, _run, _vector_pdf

from app.jobs import plan_analysis, plan_raster, plans
from app.models import Blob, Op, Sheet

FIXTURES = SERVER_DIR.parent / "fixtures"
SHEET_06M = FIXTURES / "Level_06M_-_Lighting_Composite_vector.pdf"
SHEET_03 = FIXTURES / "Level_03_-_Lighting_Composite_vector.pdf"


def _pdf(content: bytes, box: str = "[5 7 805 607]", crop: str = "[25 37 625 437]", rotate=0):
    """One page drawing `content`, MediaBox and CropBox off the origin, with a form XObject
    holding two more paths."""
    form = b"0 0 m 10 10 l S 20 0 m 30 10 l S"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox {box} /CropBox {crop} /Rotate {rotate} "
        f"/Resources << /XObject << /F 5 0 R >> >> /Contents 4 0 R >>".encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 40 20] /Length %d >>\nstream\n" % len(form)
        + form
        + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


# a black square 20 pt across whose top-left corner is at sheet (100, 50) of the CropBox
# [25 37 625 437]: PDF x 125..145, y 437-50-20 = 367..387; and the form drawn at (300, 100)
SQUARE = b"0 0 0 rg 125 367 20 20 re f q 1 0 0 1 300 100 cm /F Do Q"


def _dark_box(data: bytes, scale: float) -> tuple[int, int, int, int]:
    """The pixel box of the square (dark pixels left of x = 250 pt) as pdfium renders the page."""
    img = pdfium.PdfDocument(data)[0].render(scale=scale).to_pil().convert("L")
    w, h = img.size
    px = img.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(min(w, int(150 * scale))):
            if px[x, y] < 100:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def test_page_objects_count_paths_inside_forms():
    assert plan_raster.page_objects(_pdf(SQUARE)) == 1 + 1 + 2  # square, form, its two paths


@pytest.mark.parametrize("rotate", [0, 90])
def test_the_raster_keeps_the_cropbox_rotation_and_sheet_coordinates(rotate):
    data = _pdf(SQUARE, rotate=rotate)
    r = plan_raster.rasterise(data, dpi=144)
    page = PdfReader(io.BytesIO(r.pdf)).pages[0]
    assert [float(v) for v in page.cropbox] == [25, 37, 625, 437]
    assert [float(v) for v in page.mediabox] == [25, 37, 625, 437]
    assert page.rotation == rotate
    xobjects = page["/Resources"]["/XObject"]
    assert {xobjects[k].get_object()["/Subtype"] for k in xobjects} == {"/Image"}
    assert (r.width_px, r.height_px) == (1200, 800) and r.dpi == 144
    assert r.tiles == math.ceil(1200 / 512) * math.ceil(800 / 512)
    assert plan_raster.page_objects(r.pdf) == r.tiles  # images only: no path left to draw
    # pdfium (as PDFKit) shows the square at the same place, rotated or not
    for scale in (1.0, 2.0):
        a, b = _dark_box(data, scale), _dark_box(r.pdf, scale)
        assert all(abs(p - q) <= 1 for p, q in zip(a, b, strict=True)), (scale, a, b)


def test_tiles_meet_without_seams():
    """A black page drawn from tiles shows no light hairline where they meet, at zooms that put
    the tile edges on fractional device pixels."""
    data = _pdf(b"0 0 0 rg 0 0 1000 1000 re f")
    r = plan_raster.rasterise(data, dpi=150, tile=64)
    assert r.tiles > 20
    for scale in (0.37, 1.13, 2.71):
        img = pdfium.PdfDocument(r.pdf)[0].render(scale=scale).to_pil().convert("L")
        w, h = img.size
        inner = img.crop((2, 2, w - 2, h - 2))
        assert inner.getextrema()[1] < 60, scale


def test_a_huge_sheet_drops_to_the_pixel_cap():
    r = plan_raster.rasterise(_pdf(SQUARE), dpi=200, max_pixels=600_000)
    assert r.width_px * r.height_px <= 600_000 * 1.01
    assert r.dpi == pytest.approx(math.sqrt(600_000 / (600 * 400 / 72 / 72)), rel=1e-6)


def test_vector_blob_reads_the_kept_original():
    assert plan_raster.vector_blob("r", {"raster": {"vector_blob": "v"}}) == "v"
    assert plan_raster.vector_blob("r", {"rooms": []}) == "r"
    assert plan_raster.vector_blob("r", None) == "r"


# ------------------------------------------------------------------ the job


def test_a_heavy_display_sheet_is_stored_as_a_raster(session, store, factory, monkeypatch):
    monkeypatch.setattr(plan_raster, "RASTER_MIN_OBJECTS", 500)
    project_id, level, _ = _project_with_level(session, "03")
    data = _vector_pdf(800)
    batch = _run(session, store, factory, project_id, level, data, name="03.pdf")
    assert batch.job_state == "done", batch.stats
    stats = batch.stats["sheets"][0]
    assert stats["objects"] > 800 and stats["raster"]["dpi"] == plan_raster.RASTER_DPI
    assert stats["raster"]["vector_bytes"] == len(data)
    sheet = session.scalars(select(Sheet).where(Sheet.level_id == level.id)).one()
    raster, vector = store.read(f"blobs/{sheet.blob}"), sheet.features["raster"]["vector_blob"]
    assert store.read(f"blobs/{vector}") == data  # no boundary OCG: the upload as is
    assert session.get(Blob, sheet.blob) is not None and session.get(Blob, vector) is not None
    assert sheet.features["raster"] == {
        "vector_blob": vector,
        "dpi": plan_raster.RASTER_DPI,
        "objects": stats["objects"],
    }
    # the iPad's sheet: the same CropBox, so the analysis' size and coordinates hold
    page = PdfReader(io.BytesIO(raster)).pages[0]
    assert [float(v) for v in page.cropbox] == [15, 27, 3995, 3002]
    assert sheet.width_pt == pytest.approx(3980) and sheet.height_pt == pytest.approx(2975)
    assert plan_raster.page_objects(raster) == batch.stats["sheets"][0]["raster"]["tiles"]
    # the text pass read the vector page: the ring bubbles are still found
    assert sheet.features == {
        **plan_analysis.analyse_sheet(data).features,
        "raster": sheet.features["raster"],
    }


def test_a_light_display_sheet_stays_vector(session, store, factory):
    project_id, level, _ = _project_with_level(session, "06M")
    data = _vector_pdf(50)
    batch = _run(session, store, factory, project_id, level, data, name="06M.pdf")
    stats = batch.stats["sheets"][0]
    assert stats["raster"] is None and 0 < stats["objects"] <= plan_raster.RASTER_MIN_OBJECTS
    sheet = session.scalars(select(Sheet).where(Sheet.level_id == level.id)).one()
    assert store.read(f"blobs/{sheet.blob}") == data and "raster" not in sheet.features
    assert batch.stats["blobs_stored"] == 1


def test_rasterise_stored_sheets_then_retag_reads_the_vector(session, store, factory, monkeypatch):
    """`plans rasterise` (T141) on a sheet uploaded before: one `blob` and one `features` set,
    pins untouched; a second run changes nothing; `retag` then reads the vector original."""
    project_id, level, user = _project_with_level(session, "03")
    data = _vector_pdf(800)
    _run(session, store, factory, project_id, level, data, name="03.pdf")
    sheet = session.scalars(select(Sheet).where(Sheet.level_id == level.id)).one()
    old_blob, old_features = sheet.blob, dict(sheet.features)
    assert "raster" not in old_features

    monkeypatch.setattr(plan_raster, "RASTER_MIN_OBJECTS", 500)
    out = plans.rasterise_sheets(session, store, project_id, user.id)
    session.commit()
    assert out["sheets"] == 1 and len(out["rasterised"]) == 1 and out["kept"] == []
    session.expire_all()
    sheet = session.get(Sheet, sheet.id)
    assert sheet.blob != old_blob
    assert sheet.features == {**old_features, "raster": sheet.features["raster"]}
    assert sheet.features["raster"]["vector_blob"] == old_blob
    ops = session.scalars(
        select(Op).where(Op.entity_id == sheet.id, Op.kind == "set").order_by(Op.server_seq)
    ).all()
    assert [(o.field, o.change_type, o.reason) for o in ops] == [
        ("blob", "Master edit", plans.RASTER_REASON),
        ("features", "Master edit", plans.RASTER_REASON),
    ]
    assert ops[0].was == old_blob and ops[0].now == sheet.blob

    again = plans.rasterise_sheets(session, store, project_id, user.id)
    assert again["rasterised"] == [] and again["last_server_seq"] is None

    read: list[bytes] = []
    real = plan_analysis.sheet_tags

    def spy(pdf, *a, **kw):
        read.append(pdf)
        return real(pdf, *a, **kw)

    monkeypatch.setattr(plan_analysis, "sheet_tags", spy)
    retag = plans.retag_sheets(session, store, project_id, user.id)
    assert read == [data] and retag["changed"] == []


def test_rasterise_keeps_a_light_sheet(session, store, factory):
    project_id, level, user = _project_with_level(session, "06M")
    _run(session, store, factory, project_id, level, _vector_pdf(50), name="06M.pdf")
    out = plans.rasterise_sheets(session, store, project_id, user.id)
    assert out["rasterised"] == [] and len(out["kept"]) == 1 and out["last_server_seq"] is None
    assert out["kept"][0]["objects"] <= plan_raster.RASTER_MIN_OBJECTS


# ------------------------------------------------------------- the composites


@pytest.mark.skipif(not SHEET_06M.exists(), reason=f"golden fixture missing: {SHEET_06M}")
def test_06m_stays_vector():
    """TP-6 passed on the 06M composite as vectors; the threshold leaves it so."""
    assert plan_raster.page_objects(SHEET_06M.read_bytes()) < plan_raster.RASTER_MIN_OBJECTS


@pytest.mark.skipif(not SHEET_03.exists(), reason=f"golden fixture missing: {SHEET_03}")
def test_03_is_rasterised_on_its_cropbox():
    """The 03 composite (round 2026-11-01, C-38): two million page objects → a 200 dpi raster
    whose page box is the vector page's, and which pdfium draws far faster."""
    data = SHEET_03.read_bytes()
    r = plans.raster_display(data)
    assert r.pdf is not None and r.objects > 1_900_000
    assert r.stats["raster"]["dpi"] == 200 and r.stats["raster"]["px"] == [15173, 13269]
    a, b = pdfium.PdfDocument(data)[0], pdfium.PdfDocument(r.pdf)[0]
    assert a.get_cropbox() == b.get_cropbox() and a.get_size() == b.get_size()
