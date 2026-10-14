"""Floor PDF (T59, PLAN §7.7, D56, D66, D120): data, plan snapshot with ink and pins, density,
the export job and its routes. Rendering needs WeasyPrint's system libraries (the server image
and CI have them); on a machine without them those tests skip with the reason."""

import hashlib
import io
import json
import uuid
from collections import Counter

import pypdfium2 as pdfium
import pytest
from conftest import HDR
from PIL import Image
from sqlalchemy import select

from app.blobs import object_key
from app.jobs import exports, floor_pdf, synthetic
from app.models import Blob, Device, InkLayer, Level, Project, Sheet, User

NO_WEASYPRINT = floor_pdf.weasyprint_available()
needs_weasyprint = pytest.mark.skipif(NO_WEASYPRINT is not None, reason=NO_WEASYPRINT or "")
needs_sheet = pytest.mark.skipif(
    not synthetic.FIXTURE_SHEET.exists(), reason="fixtures/ 06M composite missing"
)


def make_project(session, store, devices=24, photos=36):
    spec = synthetic.Spec(
        name="Floor PDF test",
        devices=devices,
        photos=photos,
        ops=0,
        levels=("06", "06M"),
        dense_level="06M",
        dense_share=0.5,
    )
    stats = synthetic.generate(session, store, spec)
    return uuid.UUID(stats["project_id"])


def add_ink(session, store, project_id, level="06M"):
    """A thick red pen stroke across the middle of the level's sheet, in sheet points."""
    lv = session.scalars(
        select(Level).where(Level.project_id == project_id, Level.level == level)
    ).one()
    sheet = session.get(Sheet, lv.display_sheet_id)
    w, h = sheet.width_pt, sheet.height_pt
    doc = {
        "format": "field-survey/strokes",
        "version": 1,
        "space": "sheet",
        "width": w,
        "height": h,
        "strokes": [
            {
                "id": "s1",
                "tool": "pen",
                "color": "#ff0000",
                "width": 30,
                "points": [w * 0.1, h * 0.05, 0.5, w * 0.9, h * 0.05, 0.5],
                "at": "2026-10-12T10:00:00Z",
            }
        ],
    }
    data = json.dumps(doc).encode()
    sha = hashlib.sha256(data).hexdigest()
    store.put_file(object_key(sha), io.BytesIO(data), "application/json")
    session.add(
        Blob(
            sha256=sha,
            size=len(data),
            mime="application/json",
            upload_state="complete",
            chunks_received=[],
        )
    )
    user = session.scalars(select(User)).first()
    session.add(InkLayer(id=uuid.uuid4(), sheet_id=sheet.id, user_id=user.id, drawing_blob=sha))
    session.commit()
    return sheet, (w * 0.5, h * 0.05)


def test_pin_label_is_the_apps_rule():
    assert floor_pdf.pin_label("Corridor station", "PI1002", "Station") == "Corridor station"
    assert floor_pdf.pin_label(None, "PI1002", "Station") == "PI1002"
    assert floor_pdf.pin_label(None, None, "Sensor") == "Sensor"
    assert floor_pdf.pin_label(None, " ", None) == "Device"
    long = floor_pdf.pin_label("A very long device type name here", None, None)
    assert long == "A very long device ty…" and len(long) == 22


@needs_sheet
def test_load_counts_findings_tables_and_header(session, store):
    pid = make_project(session, store)
    data = floor_pdf.load(session, store, pid, "06M")
    assert len(data.devices) == 12
    assert sum(data.counts.values()) == 12 and "Unsurveyed" in data.counts
    findings = [d for d in data.devices if d.status != "Installed, untested"]
    assert 0 < len(findings) <= 12
    # tables are the workbook's rows for this level only
    assert all(r[0] == "06M" for r in data.connections + data.punch + data.parts)
    assert len(data.connections) == 12 and len(data.punch) == 6
    # photos with their numbers and device IDs
    assert data.photos and all(p.jpeg for p in data.photos)
    html = floor_pdf.build_html(data)
    assert "ETC Lighting Controls Survey — Level 06M" in html
    assert "Surveyed" in html
    # R7: date only — no company or project name anywhere in the report
    assert "Floor PDF test" not in html and "Luminary" not in html
    # D120: the plan's pins are labelled by type; IDs stay in the tables
    assert f"Findings ({len(findings)})" in html


@needs_sheet
def test_plan_snapshot_has_ink_and_pins(session, store):
    pid = make_project(session, store, devices=10, photos=0)
    _sheet, red_at = add_ink(session, store, pid)
    data = floor_pdf.load(session, store, pid, "06M")
    assert len(data.ink) == 1
    base = floor_pdf.sheet_raster(data, 1.0)
    r, g, b, _ = base.getpixel((round(red_at[0]), round(red_at[1])))
    assert r > 200 and g < 60 and b < 60  # the ink stroke is drawn in sheet points
    cover = Image.open(io.BytesIO(floor_pdf.cover_image(data, base)))
    assert cover.width == floor_pdf.COVER_PX
    # a crop is centred on its device's pin, which is drawn in its status colour
    subject = next(d for d in data.devices if d.pin and d.status in ("Issue", "No access"))
    crop = Image.open(io.BytesIO(floor_pdf.crop_image(data, base, 1.0, subject)))
    assert crop.size == (300, 200)
    cx = round(min(subject.pin[0], 150) if subject.pin[0] < 150 else 150)
    cy = round(min(subject.pin[1], 100) if subject.pin[1] < 100 else 100)
    want = floor_pdf._rgb(floor_pdf.STATUS_STYLE[subject.status][0])
    near = [crop.getpixel((cx + dx, cy + dy)) for dx in (-4, 0, 4) for dy in (-4, 0, 4)]
    assert any(sum(abs(a - b) for a, b in zip(px, want, strict=True)) < 90 for px in near)


def test_floor_pdf_params_are_checked(client, session):
    project = Project(id=uuid.uuid4(), name="P")
    session.add(project)
    session.commit()
    headers = {**HDR, "X-Survey-User": "Landry"}
    for params in (
        None,
        {},
        {"level": ""},
        {"level": "06M", "sections": []},
        {"level": "06M", "sections": ["cover"]},
    ):
        body = {"project_id": str(project.id), "kind": "floor_pdf"}
        if params is not None:
            body["params"] = params
        assert client.post("/exports", json=body, headers=headers).status_code == 422, params


@needs_weasyprint
@needs_sheet
def test_floor_pdf_renders_dense_and_exports_as_a_job(session, store, factory, client):
    pid = make_project(session, store, devices=40, photos=50)
    add_ink(session, store, pid)
    # every 06M device a finding (not Installed, untested), to measure the density
    session.execute(
        Device.__table__.update()
        .where(Device.level_id.in_(select(Level.id).where(Level.level == "06M")))
        .values(status="Issue")
    )
    session.commit()
    headers = {**HDR, "X-Survey-User": "Landry"}
    r = client.post(
        "/exports",
        json={"project_id": str(pid), "kind": "floor_pdf", "params": {"level": "06M"}},
        headers=headers,
    )
    assert r.status_code == 202, r.text
    assert exports.run_queued(factory, store) == ["done"]
    got = client.get(f"/exports/{r.json()['id']}", headers=HDR).json()
    assert got["job_state"] == "done", got["stats"]
    assert got["filename"] == "ETC_Lighting_Controls_Survey_Level_06M_1.pdf"
    assert got["stats"]["rows"]["Findings"] == 20 and got["diff_summary"] is None
    f = client.get(f"/exports/{got['id']}/file", headers=HDR)
    assert f.status_code == 200 and f.headers["content-type"] == "application/pdf"
    assert f.content[:5] == b"%PDF-"

    doc = pdfium.PdfDocument(f.content)
    texts = [doc[i].get_textpage().get_text_range() for i in range(len(doc))]
    assert "ETC Lighting Controls Survey — Level 06M" in texts[0]
    assert "Floor PDF test" not in "".join(texts)  # R7
    # D66: findings run several per page — 20 findings on at most 7 pages, ≥ 3 on a full page
    per_page = Counter(
        i
        for i, t in enumerate(texts)
        for line in t.splitlines()
        if line.strip().startswith("06M-") and " — " in line
    )
    assert sum(per_page.values()) == 20
    assert len(per_page) <= 7 and max(per_page.values()) >= 3
    # the header (date only) on later pages, the photo appendix with captions
    assert "Surveyed" in texts[1]
    assert any("Photo " in t and " — " in t for t in texts)
    # a second floor PDF of the same level counts up
    r2 = client.post(
        "/exports",
        json={
            "project_id": str(pid),
            "kind": "floor_pdf",
            "params": {"level": "06M", "sections": ["plan", "punch"]},
        },
        headers=headers,
    )
    assert exports.run_queued(factory, store) == ["done"]
    got2 = client.get(f"/exports/{r2.json()['id']}", headers=HDR).json()
    assert got2["filename"] == "ETC_Lighting_Controls_Survey_Level_06M_2.pdf"
    assert got2["stats"]["sections"] == ["plan", "punch"]


@needs_sheet
def test_header_date_falls_back_to_the_newest_field_survey_op_then_today(session, store):
    """D159 (2): a level with no `surveyed` is never printed undated."""
    from datetime import date, datetime

    from app.models import Op

    pid = make_project(session, store)
    lv = session.scalars(select(Level).where(Level.project_id == pid, Level.level == "06M")).one()
    lv.surveyed = None
    session.commit()
    assert floor_pdf.load(session, store, pid, "06M").surveyed == date.today()
    dev = session.scalars(select(Device).where(Device.level_id == lv.id)).first()
    session.add(
        Op(
            op_id=uuid.uuid4(),
            project_id=pid,
            user_id=session.scalars(select(User)).first().id,
            install_id=uuid.uuid4(),
            client_ts=datetime(2026, 10, 11, 9, 0),
            entity_kind="device",
            entity_id=dev.id,
            kind="set",
            field="status",
            now="Issue",
            change_type="Field survey",
        )
    )
    session.commit()
    assert floor_pdf.load(session, store, pid, "06M").surveyed == date(2026, 10, 11)
    lv.surveyed = date(2026, 10, 8)
    session.commit()
    assert floor_pdf.load(session, store, pid, "06M").surveyed == date(2026, 10, 8)
