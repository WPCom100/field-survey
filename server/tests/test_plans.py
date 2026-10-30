"""Plan sheets (T45, PLAN §7.4, D100): the text pass on the 06M composite — grid sets, residuals,
Drawing Position wording, rooms, tags, boundaries, the OCG-off display PDF — and the job that
turns an upload into `sheet` ops."""

import io
import json
import math
import uuid

import pypdfium2 as pdfium
import pytest
from conftest import HDR, SERVER_DIR
from pypdf import PdfReader
from sqlalchemy import select

from app import projects
from app.auth import upsert_user
from app.jobs import plan_analysis as pa
from app.jobs import plans, runner
from app.models import Blob, ImportBatch, Level, Op, Sheet

FIXTURE = SERVER_DIR.parent / "fixtures" / "Level_06M_-_Lighting_Composite_vector.pdf"
needs_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason=f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)"
)


@pytest.fixture(scope="module")
def analysis():
    if not FIXTURE.exists():
        pytest.skip(f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)")
    return pa.analyse_sheet(FIXTURE.read_bytes())


def labels(gs, axis):
    return [lab["label"] for lab in gs[f"{axis}_labels"]]


# ------------------------------------------------------------ the text pass


@needs_fixture
def test_06m_grid_sets_auto_calibrate(analysis):
    """DoD: both grid sets auto, residual < 2 pt — the sheet in fact carries three (D47)."""
    sets = analysis.grid_sets
    assert len(sets) == 3
    assert all(s["mode"] == "auto" for s in sets)
    assert all(s["residual"] < pa.AUTO_RESIDUAL_PT for s in sets)
    by_name = {s["name"]: s for s in sets}
    centennial = by_name["A–H / 13.5–5"]
    assert labels(centennial, "col") == ["A", "B", "C", "D", "E", "F", "G", "G.9", "H"]
    assert labels(centennial, "row")[:4] == ["13.5", "13", "12.8", "12"]
    assert labels(centennial, "row")[-3:] == ["6.4", "5.2", "5"]
    assert abs(centennial["angle"]) < 0.5
    wt = by_name["A.–F. / 15.–5."]
    assert labels(wt, "col") == ["A.", "B.", "C.", "D.", "E.", "F."]
    rotated = next(s for s in sets if s["name"].startswith("R.–K."))
    assert 21 < rotated["angle"] < 23
    assert labels(rotated, "row") == ["16.", "15.", "14.", "13."]
    # the frame: s across the columns, t across the rows, both unit vectors
    for s in sets:
        a = s["affine"]
        assert abs((a["a"] ** 2 + a["c"] ** 2) - 1) < 0.02
        assert abs((a["b"] ** 2 + a["d"] ** 2) - 1) < 0.02
    assert analysis.width_pt == pytest.approx(4235.48, abs=0.01)
    assert analysis.height_pt == pytest.approx(3604.72, abs=0.01)


@needs_fixture
def test_06m_drawing_position_wording(analysis):
    """DoD: tap → "C-9"-style label, in the master's wording (PLAN §7.4)."""
    sets = analysis.grid_sets
    dp = lambda x, y: pa.drawing_position(sets, x, y)  # noqa: E731
    assert dp(1100, 2200) == "Grid B-C / 9-8"
    assert dp(1248, 2054) == "Grid C / 9"  # on the C line and the 9 line
    assert dp(300, 2200) == "Grid West of A / 9-8"
    assert dp(1100, 500) == "Grid B-C / North of 13.5"
    assert dp(1100, 3500) == "Grid B-C / South of 5"
    assert dp(3300, 2600) == "Grid C.-D. / 7.-6."  # Walter Tower, labels verbatim
    assert dp(3000, 2600) is None or dp(3000, 2600).startswith("Grid")
    # "East of H": the Centennial grid alone, with the Walter Tower sets gone
    centennial = [s for s in sets if s["name"].startswith("A–H")]
    assert pa.drawing_position(centennial, 3000, 2200) == "Grid East of H / 9-8"
    # the prefix per set (D47) leads the text
    wt = [dict(s, prefix="WT") for s in sets if s["name"].startswith("A.–F.")]
    assert pa.drawing_position(wt, 3300, 2600) == "WT Grid C.-D. / 7.-6."
    # nothing claims a point far off every grid
    assert pa.drawing_position(sets, -5000, -5000) is None


@needs_fixture
def test_06m_rooms_tags_bubbles(analysis):
    f = analysis.features
    rooms = {r["code"]: r for r in f["rooms"]}
    assert rooms["XX06M-2SV01"]["name"] == "Stair A Vestibule"
    assert rooms["XX06M-1EM02"]["name"] == "Elevator Machine Room"
    assert rooms["XX06M-3I03"]["name"] == "IDF"
    assert all({"code", "name", "x", "y"} <= r.keys() for r in f["rooms"])
    tags = {t["text"] for t in f["tags"]}
    assert {"CT06LCPA", "CT06LCPB", "EBDK", "UFMP8"} <= tags
    assert all(t["size"] >= pa.MIN_TAG_SIZE for t in f["tags"])
    # loose bubbles are ringed labels no set claimed — the detail callouts, not grid labels
    loose = {b["text"] for b in f["bubbles"]}
    assert "22" in loose
    claimed = {b["label"] for s in analysis.grid_sets for b in s["bubbles"]}
    assert not any(b["x"] == 653.8 and b["text"] == "A" for b in f["bubbles"])
    assert "A" in claimed


@needs_fixture
def test_06m_boundaries_and_display_pdf(analysis):
    """D100: the OCG's paths become sheet data and the display PDF has the group off."""
    f = analysis.features
    assert f["boundaries"], "no boundary polylines"
    assert all(len(b["points"]) >= 2 for b in f["boundaries"])
    xs = [p[0] for b in f["boundaries"] for p in b["points"]]
    ys = [p[1] for b in f["boundaries"] for p in b["points"]]
    assert 0 <= min(xs) and max(xs) <= analysis.width_pt
    assert 0 <= min(ys) and max(ys) <= analysis.height_pt
    assert {lab["text"] for lab in f["boundary_labels"]} == {
        "Ef.106.5.A",
        "Ef.106.5.B",
        "Ef.106.5.D",
        "Ef.106.5.E",
    }
    assert analysis.display_pdf is not None
    reader = PdfReader(io.BytesIO(analysis.display_pdf))
    d = reader.trailer["/Root"]["/OCProperties"]["/D"]
    off = [str(ref.get_object()["/Name"]) for ref in d["/OFF"]]
    assert off == ["Source sheet boundaries"]
    assert list(d["/ON"]) == []
    assert len(reader.pages) == 1
    # pdfium honours the default configuration: the magenta is gone from the rendered page
    assert _magenta_pixels(FIXTURE.read_bytes()) > 200
    assert _magenta_pixels(analysis.display_pdf) == 0


def _magenta_pixels(data: bytes) -> int:
    doc = pdfium.PdfDocument(data)
    img = doc[0].render(scale=0.12).to_pil().convert("RGB")
    raw = img.tobytes()
    px = zip(raw[0::3], raw[1::3], raw[2::3], strict=True)
    return sum(1 for r, g, b in px if r > 180 and b > 180 and g < 90)


def test_analysis_without_grid_or_ocg():
    """A plain one-page PDF with no bubbles: no sets, no boundaries, no rewritten file."""
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=600, height=400)
    buf = io.BytesIO()
    w.write(buf)
    a = pa.analyse_sheet(buf.getvalue())
    assert a.grid_sets == []
    assert a.features["boundaries"] == []
    assert a.display_pdf is None
    assert (a.width_pt, a.height_pt) == (600, 400)
    assert pa.drawing_position([], 10, 10) is None


def test_drawing_position_on_a_synthetic_set():
    """The wording rules on a hand-made set: on-line tolerance, between, beyond, prefix."""
    gs = {
        "name": "t",
        "prefix": "",
        "mode": "auto",
        "residual": 0,
        "affine": {"a": 1, "c": 0, "tx": 0, "b": 0, "d": 1, "ty": 0},
        "col_labels": [
            {"label": "A", "pos": 100},
            {"label": "B", "pos": 200},
            {"label": "C", "pos": 300},
        ],
        "row_labels": [
            {"label": "3", "pos": 100},
            {"label": "2", "pos": 200},
            {"label": "1", "pos": 300},
        ],
    }
    dp = lambda x, y: pa.drawing_position([gs], x, y)  # noqa: E731
    assert dp(150, 150) == "Grid A-B / 3-2"
    assert dp(203, 297) == "Grid B / 1"  # within 8 % of the spacing
    assert dp(330, 150) == "Grid East of C / 3-2"
    assert dp(70, 150) == "Grid West of A / 3-2"
    assert dp(150, 70) == "Grid A-B / North of 3"
    assert dp(150, 340) == "Grid A-B / South of 1"
    assert dp(1000, 1000) is None  # beyond two spacings of the grid
    gs["prefix"] = "WT"
    assert dp(150, 150) == "WT Grid A-B / 3-2"
    gs["mode"] = "none"
    assert dp(150, 150) is None


def test_label_key_order():
    assert pa.label_key("A") < pa.label_key("B") < pa.label_key("Z") < pa.label_key("AA")
    assert pa.label_key("G") < pa.label_key("G.9") < pa.label_key("H")
    assert pa.label_key("9") < pa.label_key("9.5") < pa.label_key("13.5")


# ------------------------------------------------- a sheet with many paths (T124)


def _vector_pdf(lines: int, chars: int = 0) -> bytes:
    """One page drawing `lines` short strokes in rows, a ring of twelve separate segments around
    a "C", a Bézier circle around a "7", a big rectangle, and `chars` more letters. The MediaBox
    and CropBox are both off the origin so the coordinate conversions are exercised."""
    ops = [b"0.5 w"]
    for i in range(lines):
        x, y = 40 + (i % 300) * 12, 1000 + (i // 300) * 3
        ops.append(b"%d %d m %d %d l S" % (x, y, x + 10, y))
    for k in range(12):  # the Walter Tower ring: short segments, each painted alone
        a0, a1 = math.radians(k * 30), math.radians(k * 30 + 30)
        ops.append(
            b"%.2f %.2f m %.2f %.2f l S"
            % (
                300 + 12 * math.cos(a0),
                300 + 12 * math.sin(a0),
                300 + 12 * math.cos(a1),
                300 + 12 * math.sin(a1),
            )
        )
    k = 12.0 * 0.5523  # a circle of radius 12 as four Béziers around (500, 300)
    ops.append(
        (
            f"512 300 m 512 {300 + k} {500 + k} 312 500 312 c "
            f"{500 - k} 312 488 {300 + k} 488 300 c "
            f"488 {300 - k} {500 - k} 288 500 288 c "
            f"{500 + k} 288 512 {300 - k} 512 300 c S"
        ).encode()
    )
    ops.append(b"100 100 400 200 re S")
    ops.append(b"BT /F1 10 Tf 297 296 Td (C) Tj ET BT /F1 10 Tf 497 296 Td (7) Tj ET")
    for i in range(chars):
        ops.append(b"BT /F1 6 Tf %d %d Td (x) Tj ET" % (40 + (i % 500) * 7, 2000 + (i // 500) * 7))
    content = b"\n".join(ops)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [5 7 4005 3007] /CropBox [15 27 3995 3002]"
        b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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


def test_streamed_paths_match_what_pdfplumber_kept():
    """`_PathSink` hands `Rings` exactly the circles and segment midpoints the old pass took from
    pdfplumber's `curves`, `lines` and `rects` (T124), in the same sheet coordinates."""
    import pdfplumber

    data = _vector_pdf(400)
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[0]
        cx, cy = page.cropbox[0], page.cropbox[1]
        circles = [
            (c["x0"] - cx, c["top"] - cy, c["x1"] - cx, c["bottom"] - cy)
            for c in page.curves
            if 8 <= c["width"] <= 60 and abs(c["width"] - c["height"]) < 2
        ]
        mids = sorted(
            ((o["x0"] + o["x1"]) / 2 - cx, (o["top"] + o["bottom"]) / 2 - cy)
            for o in page.lines + page.rects
            if 4 <= max(o["width"], o["height"]) <= 36
        )
        total = len(page.curves) + len(page.lines) + len(page.rects)
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        rings = pa._read_page(pdf, pdf.pages[0])
        assert pdf.pages[0].curves == [] and pdf.pages[0].lines == []  # nothing kept
        words = {w.text: w for w in pa._page_words(pdf.pages[0])}
    assert sorted(words) == ["7", "C"]
    assert len(circles) == 1 and len(mids) == 400 + 12
    assert rings.circles == pytest.approx(circles)
    got = sorted(
        (pts[k], pts[k + 1]) for pts in rings.cells.values() for k in range(0, len(pts), 2)
    )
    assert got == pytest.approx(mids)
    assert rings.paths == total == 400 + 12 + 2
    assert rings.around(words["C"].x, words["C"].y)  # the segment ring
    assert rings.around(words["7"].x, words["7"].y)  # the Bézier circle
    assert not rings.around(words["C"].x + 100, words["C"].y)


def test_many_paths_stay_small_in_memory():
    """A sheet's vector count no longer sets the job's memory (T124): 60,000 strokes used to be
    60,000 pdfplumber dicts (≈ 120 MB); streamed into `Rings` they cost about 2 MB."""
    import tracemalloc

    data = _vector_pdf(60_000)
    tracemalloc.start()
    try:
        a = pa.analyse_sheet(data)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert a.stats["paths"] == 60_000 + 12 + 2
    assert peak < 40e6, f"peak {peak / 1e6:.0f} MB"


def test_a_sheet_past_the_character_cap_fails_with_a_reason(session, store, factory, monkeypatch):
    """Over `MAX_CHARS` the batch fails with a message the iPad shows (`Failed: …`), not a crash."""
    monkeypatch.setattr(pa, "MAX_CHARS", 100)
    project_id, level, _ = _project_with_level(session)
    batch = _run(session, store, factory, project_id, level, _vector_pdf(10, chars=200))
    assert batch.job_state == "failed"
    assert "more than 100 characters" in batch.stats["error"]
    assert "traceback" not in batch.stats
    session.expire_all()
    assert session.get(Level, level.id).display_sheet_id is None


class _WorkerKilled(BaseException):
    """What the kernel's OOM killer looks like from inside: the job never returns."""


def test_a_batch_the_worker_died_under_runs_once_more_then_fails(session, store, factory):
    """A batch left `running` (out of memory, a deploy) is queued again at worker start; dying
    a second time fails it with a reason instead of looping (T124)."""
    project_id, level, user = _project_with_level(session)
    batch = plans.create_sheet_batch(
        session,
        store,
        project_id=project_id,
        level_id=level.id,
        sheet_kind="display",
        filename="big.pdf",
        data=_small_pdf(),
        user=user,
    )

    def dies(*_):
        raise _WorkerKilled

    def state():
        session.expire_all()
        b = session.get(ImportBatch, batch.id)
        return b.job_state, b.stats

    with pytest.raises(_WorkerKilled):
        runner.run_batch(factory, store, batch.id, job=dies)
    assert state()[0] == "running"
    assert runner.recover_interrupted(factory) == [f"{batch.id}:queued"]
    assert state() == ("queued", {"restarts": 1, "restarted_at": state()[1]["restarted_at"]})
    with pytest.raises(_WorkerKilled):
        runner.run_batch(factory, store, batch.id, job=dies)
    assert state()[1]["restarts"] == 1  # carried through the second start
    assert runner.recover_interrupted(factory) == [f"{batch.id}:failed"]
    st, stats = state()
    assert st == "failed" and stats["error"] == runner.INTERRUPTED
    assert runner.recover_interrupted(factory) == []  # nothing left running
    # a failed batch can still be run again by hand
    assert runner.run_batch(factory, store, batch.id, job=plans.import_sheets) == "done"


# ------------------------------------------------------------------ the job


def _project_with_level(session, code="06M"):
    user = upsert_user(session, "Landry")
    out = projects.create_project(
        session, projects.ProjectIn(name="Tower", levels=[projects.LevelIn(level=code)]), user
    )
    level = session.scalars(select(Level).where(Level.project_id == uuid.UUID(out.id))).one()
    return uuid.UUID(out.id), level, user


def _small_pdf(pages=1) -> bytes:
    from pypdf import PdfWriter

    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=600, height=400)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _run(session, store, factory, project_id, level, data, kind="display", name="sheet.pdf"):
    user = upsert_user(session, "Landry")
    batch = plans.create_sheet_batch(
        session,
        store,
        project_id=project_id,
        level_id=level.id,
        sheet_kind=kind,
        filename=name,
        data=data,
        user=user,
    )
    state = runner.run_batch(factory, store, batch.id, job=plans.import_sheets)
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state, batch.stats
    return batch


@needs_fixture
def test_display_sheet_job(session, store, factory):
    project_id, level, _ = _project_with_level(session)
    batch = _run(
        session,
        store,
        factory,
        project_id,
        level,
        FIXTURE.read_bytes(),
        name="Level_06M_-_Lighting_Composite_vector.pdf",
    )
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["sheet_kind"] == "display" and s["grid_sets"] == 3 and s["auto_sets"] == 3
    session.expire_all()
    level = session.get(Level, level.id)
    sheet = session.get(Sheet, level.display_sheet_id)
    assert sheet is not None and sheet.kind == "display" and sheet.page == 1
    assert sheet.title == "Level_06M_-_Lighting_Composite_vector"
    assert len(sheet.grid_sets) == 3 and sheet.features["boundaries"]
    assert sheet.width_pt == pytest.approx(4235.48, abs=0.01)
    blob = session.get(Blob, sheet.blob)
    assert blob is not None and blob.upload_state == "complete" and blob.mime == "application/pdf"
    stored = store.read(f"blobs/{sheet.blob}")
    assert _magenta_pixels(stored) == 0  # the OCG-off rewrite is what the iPad downloads
    # the ops an iPad pulls: the sheet create and the level's display_sheet_id set
    ops = session.scalars(
        select(Op).where(Op.project_id == project_id, Op.state == "applied").order_by(Op.server_seq)
    ).all()
    kinds = [
        (o.entity_kind, o.kind, o.field)
        for o in ops
        if o.entity_kind in ("sheet", "level") and o.kind != "create" or o.entity_kind == "sheet"
    ]
    assert ("sheet", "create", None) in kinds
    assert ("level", "set", "display_sheet_id") in kinds
    set_op = next(o for o in ops if o.kind == "set" and o.field == "display_sheet_id")
    assert set_op.was is None and uuid.UUID(set_op.now) == sheet.id
    assert (
        set_op.change_type == "Master edit" and set_op.user_id == upsert_user(session, "Landry").id
    )
    payload = next(o for o in ops if o.entity_kind == "sheet" and o.kind == "create").payload
    assert set(payload) >= {
        "id",
        "level_id",
        "kind",
        "blob",
        "page",
        "title",
        "width_pt",
        "height_pt",
        "grid_sets",
        "features",
    }
    json.dumps(payload)  # plain JSON all the way down

    # the same file again: skipped, nothing changes
    again = _run(session, store, factory, project_id, level, FIXTURE.read_bytes())
    assert again.job_state == "skipped" and again.stats["earlier_batch"] == str(batch.id)
    session.expire_all()
    assert session.get(Level, level.id).display_sheet_id == sheet.id


def test_replacing_a_display_sheet_soft_deletes_the_old_one(session, store, factory):
    project_id, level, _ = _project_with_level(session)
    first = _run(session, store, factory, project_id, level, _small_pdf(), name="a.pdf")
    assert first.job_state == "done", first.stats
    session.expire_all()
    old_id = session.get(Level, level.id).display_sheet_id
    second = _run(
        session, store, factory, project_id, level, _small_pdf() + b"\n%rev2\n", name="b.pdf"
    )
    assert second.job_state == "done", second.stats
    session.expire_all()
    level = session.get(Level, level.id)
    assert level.display_sheet_id != old_id
    assert session.get(Sheet, old_id).deleted_at is not None
    assert session.get(Sheet, level.display_sheet_id).deleted_at is None
    assert session.get(Sheet, level.display_sheet_id).grid_sets == []


def test_source_pdf_gives_one_sheet_per_page(session, store, factory):
    project_id, level, _ = _project_with_level(session)
    batch = _run(
        session,
        store,
        factory,
        project_id,
        level,
        _small_pdf(pages=3),
        kind="source",
        name="Ef.106.5.pdf",
    )
    assert batch.job_state == "done", batch.stats
    session.expire_all()
    sheets = session.scalars(
        select(Sheet).where(Sheet.level_id == level.id).order_by(Sheet.page)
    ).all()
    assert [s.page for s in sheets] == [1, 2, 3]
    assert [s.title for s in sheets] == ["Ef.106.5 p.1", "Ef.106.5 p.2", "Ef.106.5 p.3"]
    assert len({s.blob for s in sheets}) == 1 and all(s.kind == "source" for s in sheets)
    assert session.get(Level, level.id).display_sheet_id is None
    assert batch.stats["blobs_stored"] == 1


def test_bad_uploads_are_refused(session, store):
    project_id, level, user = _project_with_level(session)
    with pytest.raises(runner.ImportError_, match="not a PDF"):
        plans.create_sheet_batch(
            session,
            store,
            project_id=project_id,
            level_id=level.id,
            sheet_kind="display",
            filename="x.pdf",
            data=b"hello",
            user=user,
        )
    with pytest.raises(runner.ImportError_, match="sheet_kind"):
        plans.create_sheet_batch(
            session,
            store,
            project_id=project_id,
            level_id=level.id,
            sheet_kind="plan",
            filename="x.pdf",
            data=_small_pdf(),
            user=user,
        )
    with pytest.raises(runner.ImportError_, match="unknown level"):
        plans.create_sheet_batch(
            session,
            store,
            project_id=project_id,
            level_id=uuid.uuid4(),
            sheet_kind="display",
            filename="x.pdf",
            data=_small_pdf(),
            user=user,
        )


def test_imports_route_queues_a_plans_batch(client, session, store, factory):
    project_id, level, _ = _project_with_level(session)
    res = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={
            "project_id": str(project_id),
            "kind": "plans",
            "level_id": str(level.id),
            "sheet_kind": "display",
        },
        files={"file": ("plan.pdf", _small_pdf(), "application/pdf")},
    )
    assert res.status_code == 202, res.text
    body = res.json()
    assert body["job_state"] == "queued" and body["kind"] == "plans"
    assert (
        body["files"][0]["level_id"] == str(level.id)
        and body["files"][0]["sheet_kind"] == "display"
    )
    assert "key" not in body["files"][0]
    assert plans.run_queued(factory, store) == ["done"]
    res = client.get(f"/imports/{body['id']}", headers=HDR)
    assert res.json()["job_state"] == "done"
    # a plans batch without a level, and a workbook route untouched by the new fields
    res = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(project_id), "kind": "plans"},
        files={"file": ("plan.pdf", _small_pdf(), "application/pdf")},
    )
    assert res.status_code == 422
    res = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(project_id), "kind": "plans", "level_id": str(level.id)},
        files={"file": ("plan.pdf", b"nope", "application/pdf")},
    )
    assert res.status_code == 422
