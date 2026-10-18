"""BOM extraction (T42, PLAN §7.2): `fixtures/BOM.pdf` end to end — the text pages, page 3 by
OCR, the drafts with their candidates, accessories, racks, levels and excluded lines — the
Material List format on `fixtures/15090056-BOM.pdf`, the job, and the `/imports` route."""

import json
import uuid

import pytest
from conftest import HDR, SERVER_DIR
from sqlalchemy import select

from app import ocr, projects
from app.auth import upsert_user
from app.ids import uuid7
from app.jobs import bom, runner
from app.jobs import bom_extract as bx
from app.models import DraftDevice, ImportBatch, Level, Op, Vocab

FIXTURE = SERVER_DIR.parent / "fixtures" / "BOM.pdf"
AZLE = SERVER_DIR.parent / "fixtures" / "15090056-BOM.pdf"
needs_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason=f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)"
)
needs_azle = pytest.mark.skipif(
    not AZLE.exists(), reason=f"golden fixture missing: {AZLE} (CLAUDE.md §6)"
)
needs_ocr = pytest.mark.skipif(
    not ocr.available(),
    reason="tesseract is not installed (app/ocr.py: TESSERACT_CMD, PATH or the Windows default)",
)

TOWER_LEVELS = ("B2", "B1", "01", "02", "03", "04", "06", "06M")
TEXT_PAGE_LINES = {1: 57, 2: 35, 4: 42, 5: 42, 6: 15}
"""Rows per text page (Phase 1f: 258 lines in all, 67 of them on the OCR page)."""


def _no_ocr(_pdf: bytes, _page: int, **_kw) -> list[ocr.Word]:
    return []


@pytest.fixture(scope="module")
def parsed():
    """Lines of the BOM: page 3 by tesseract when it is installed, else left out."""
    if not FIXTURE.exists():
        pytest.skip(f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)")
    data = FIXTURE.read_bytes()
    lines, pages = bx.parse(data, ocr.ocr_page if ocr.available() else _no_ocr)
    return lines, pages


def target(**kw) -> bx.Target:
    return bx.Target(levels={code: uuid7() for code in TOWER_LEVELS}, **kw)


def by_ref(lines, page, line):
    return next(ln for ln in lines if ln.page == page and ln.line == line)


def draft_at(result, page, line):
    return next(d for d in result.drafts if d.line.page == page and d.line.line == line)


# ----------------------------------------------------------------- the lines


@needs_fixture
def test_text_pages_parse_every_row(parsed):
    lines, pages = parsed
    assert [(p.page, p.extraction) for p in pages if p.page != 3] == [
        (1, "text"),
        (2, "text"),
        (4, "text"),
        (5, "text"),
        (6, "text"),
    ]
    counts = {}
    for ln in lines:
        if ln.page != 3:
            counts[ln.page] = counts.get(ln.page, 0) + 1
    assert counts == TEXT_PAGE_LINES
    assert all(
        ln.extraction == "text" and ln.confidence == bx.TEXT_CONFIDENCE
        for ln in lines
        if ln.page != 3
    )
    # the four jobs and the VENUE rows that group them
    assert {ln.job for ln in lines if ln.page in (1, 2)} == {"15076538", "15076539"}
    assert {ln.job for ln in lines if ln.page in (4, 5, 6)} == {"15084074"}
    venues = [ln.description for ln in lines if ln.kind == "venue" and ln.page != 3]
    assert venues[:4] == ["Level B2 - 12", "Level 1", "Level 5", "Link to P-CCS in other building"]
    assert len(venues) == 19
    # a line, verbatim
    erp = by_ref(lines, 1, 30)
    assert (erp.part_number, erp.model, erp.qty) == ("7123A1122", "ERP24-FT-241P", 9)
    assert erp.description == "ERP24-FT MK2 ENCLOSURE W/24 1P RELAYS"
    assert erp.venue == "Level B2 - 12"
    assert erp.source_ref()["bbox"][0] < 20 and erp.source_ref()["page"] == 1
    # the doubled title-block glyphs of pp.4–6 never leak into a row
    rack = by_ref(lines, 1, 100)
    assert rack.model == "18U RACK"
    wd = by_ref(lines, 4, 130)
    assert wd.model == "P-DOC-W-WD-4" and wd.qty == 8 and wd.venue == "Floor B1"
    # a venue runs on past the page break (FLOOR 6 → p.5, FLOOR 21 → p.6)
    assert by_ref(lines, 5, 360).venue == "FLOOR 6"
    assert by_ref(lines, 6, 790).venue == "FLOOR 21"
    assert by_ref(lines, 6, 840).venue == "FLOOR 27"
    assert by_ref(lines, 6, 920).venue == "FLOOR 27"


@needs_fixture
@needs_ocr
def test_page3_by_ocr(parsed):
    """Phase 1f: 67/67 lines recovered from the image-only page (two tables side by side)."""
    lines, pages = parsed
    page3 = next(p for p in pages if p.page == 3)
    assert page3.extraction == "ocr"
    rows = [ln for ln in lines if ln.page == 3]
    assert len(rows) == 67
    assert len(lines) == 258
    assert [ln.line for ln in rows[:3]] == [10, 20, 30]
    assert [ln.column for ln in rows].count(0) == 46 and [ln.column for ln in rows].count(1) == 21
    assert {ln.job for ln in rows} == {"15084073"}
    assert [ln.description for ln in rows if ln.kind == "venue"] == [
        "FLOOR 1",
        "FLOOR 2",
        "FLOOR 9",
        "FLOOR 10",
        "FLOOR 15",
        "FLOOR 16",
        "FLOOR 19",
        "FLOOR 20",
    ]
    assert all(0 < ln.confidence <= bx.OCR_CONFIDENCE_CAP for ln in rows)
    first = by_ref(lines, 3, 20)
    assert (first.part_number, first.model, first.qty, first.venue) == (
        "7179A1007",
        "UFMP4",
        7,
        "FLOOR 1",
    )
    assert by_ref(lines, 3, 250).qty == 47
    assert by_ref(lines, 3, 100).model == "P-DOC-C-SR-4"
    assert by_ref(lines, 3, 40).model == "PI1002-4Z"  # the `P11002` fix
    assert by_ref(lines, 3, 440).model == "ERN4-W-120"
    assert by_ref(lines, 3, 470).model == "URTO" and by_ref(lines, 3, 470).venue == "FLOOR 16"
    assert by_ref(lines, 3, 670).part_number.startswith("DATA")
    # the grey-banded row Tesseract 5.4 on Windows reads as `‘630` (T109)
    row630 = by_ref(lines, 3, 630)
    assert (row630.model, row630.qty, row630.venue, row630.column) == (
        "P-DOC-C-SR-4",
        1,
        "FLOOR 20",
        1,
    )
    # every row's quantity was read as a number
    assert all(ln.qty is not None for ln in rows)


# ---------------------------------------------------------------- the drafts


@pytest.fixture(scope="module")
def result(parsed):
    lines, _ = parsed
    return bx.build(lines, target())


@needs_fixture
def test_drafts_from_the_text_pages(result):
    text = [d for d in result.drafts if d.line.page != 3]
    assert len(text) == 74
    racks = [d for d in text if d.role == "equipment_rack"]
    assert {d.category for d in racks} == {"Equipment Panels"}  # T115: the D196 category
    assert len(racks) == 3
    # rack component lines fold into one Equipment rack draft named by its ERn4 enclosure
    level1 = draft_at(result, 1, 100)
    assert level1.model == "ERN4-RM-120" and level1.model_raw == "ERN4-RM-120"
    assert level1.level_code == "01" and level1.level_basis == "venue"
    components = [a for a in level1.accessories if a["role"] == "component"]
    assert len(components) == 18
    assert {a["model"] for a in components} >= {"P-ACP3", "P-SPM-E", "MSCX10 Mk3", "MAP S1000R"}
    assert all(a["source_ref"]["line"] for a in components)
    # `Level 5` is the 06M rack (level_alias)
    level5 = draft_at(result, 1, 320)
    assert level5.level_code == "06M" and level5.level_id == result_levels(result)["06M"]
    assert len(level5.accessories) == 15
    # a floor the project does not have keeps its code, no level
    level28 = draft_at(result, 2, 80)
    assert level28.level_id is None and level28.level_basis == "level_not_in_project"
    assert level28.level_code == "28"
    # pooled venues wait for the riser (D10): no level, confidence halved → flagged
    pooled = [d for d in text if d.level_basis == "pooled_venue"]
    assert len(pooled) == 15
    assert all(d.level_id is None and d.confidence < 0.7 for d in pooled)
    assert draft_at(result, 1, 80).model == "EBDK" and draft_at(result, 1, 80).qty == 15
    # models: suffix stripped, model_map, SR / LR both candidates (D28)
    wd = draft_at(result, 4, 130)
    assert (wd.model, wd.model_raw, wd.candidates) == ("P-DOC-W", "P-DOC-W-WD-4", ["P-DOC-W"])
    sr = draft_at(result, 4, 50)
    assert sr.model == "P-DOC-C-SR" and sr.candidates == ["P-DOC-C-SR", "P-DOC-C-LR"]
    assert sr.conflicts == ["model:SR/LR"] and sr.level_code == "B2"
    ts = draft_at(result, 1, 530)
    assert ts.model == "P-TS7-E" and (ts.role, ts.category) == ("touchscreen", "Touchscreen")
    assert [a["model"] for a in ts.accessories] == ["P-LCD-FBB"]
    nsps = draft_at(result, 4, 20)
    assert nsps.model == "P-NSPS-D" and (nsps.role, nsps.category) == ("nsps", "Equipment")
    # levels by venue
    assert (
        draft_at(result, 4, 145).level_code == "03"
        and draft_at(result, 4, 145).level_basis == "venue"
    )
    ufmp = draft_at(result, 4, 145)
    assert (ufmp.role, ufmp.category) == ("foundry_panel", "Power Distribution")
    assert ufmp.row()["role"] == "foundry_panel"
    assert draft_at(result, 4, 340).level_code == "06" and not draft_at(result, 4, 340).conflicts
    assert draft_at(result, 5, 360).level_code == "06"  # carried over the page break
    floor11 = draft_at(result, 5, 380)
    assert floor11.level_id is None and floor11.level_basis == "level_not_in_project"
    # accessories (D27): faceplates on their stations, option cards on the ERP, AD parts on UHCI
    for d in text:
        if d.role == "station":
            plates = [a for a in d.accessories if a["model"] == "1IFP"]
            assert len(plates) == 1 and plates[0]["qty"] == d.qty, d.line
    erp48 = draft_at(result, 1, 40)
    assert {(a["model"], a["qty"]) for a in erp48.accessories} == {
        ("ERP-FT-LVD", 21),
        ("ERP-RTO", 15),
    }
    uhci = draft_at(result, 4, 250)
    assert (uhci.role, uhci.category) == ("sensor", "Sensor")
    assert sorted(a["model"] for a in uhci.accessories) == ["AD-C18E-00-2A", "AD-C18R-0P-2A"]
    assert draft_at(result, 5, 380).accessories[0]["model"] == "ERM VDK"
    assert draft_at(result, 5, 410).accessories[0]["model"] == "DIN14"
    # excluded lines stay listed with a reason (D12)
    reasons = {}
    for e in result.excluded:
        if e.line.page != 3:
            reasons[e.reason] = reasons.get(e.reason, 0) + 1
    assert reasons == {"service line": 10, "hardware kit": 3, "bracket": 1}
    bracket = next(e for e in result.excluded if e.reason == "bracket")
    assert bracket.out()["model"] == "AD-ST18A" and bracket.out()["source_ref"]["line"] == 251
    # the row an op carries: plain JSON with every draft_device column it fills
    row = sr.row()
    json.dumps(row, default=str)  # the job's `jsonable` turns the level id into text
    assert row["candidates"] == ["P-DOC-C-SR", "P-DOC-C-LR"] and row["state"] == "proposed"
    assert row["source_ref"] == {
        "kind": "bom_line",
        "job": "15084074",
        "page": 4,
        "line": 50,
        "bbox": row["source_ref"]["bbox"],
        "venue": "Floor B2",
        "level_code": "B2",
    }
    assert wd.row()["candidates"] is None and wd.row()["conflicts"] is None
    assert level1.row()["accessories"][0]["role"] == "component"


def result_levels(result) -> dict[str, uuid.UUID]:
    return {d.level_code: d.level_id for d in result.drafts if d.level_id is not None}


@needs_fixture
@needs_ocr
def test_drafts_of_the_whole_bom(result):
    """Phase 1f counted 113 drafts, 56 accessory lines and 17 excluded lines; the accessory and
    excluded counts match. Its `device_drafts.json` is not in the repo, and its five extra
    drafts are rack component lines this pass folds into their rack (PLAN §7.2)."""
    stats = result.stats()
    assert stats["accessory_lines"] == 56
    assert stats["excluded"] == 17
    assert stats["drafts"] == 108
    assert stats["racks"] == 4
    assert stats["venues"] == 27 and stats["pooled_venues"] == 4
    assert stats["component_lines"] == 50
    # the wall-mount ERn4 on FLOOR 16 is a rack too: processors fold in, the ride-thru is a part
    f16 = draft_at(result, 3, 440)
    assert f16.role == "equipment_rack" and f16.model == "ERN4-W-120"
    assert f16.level_code == "16" and f16.level_basis == "level_not_in_project"
    assert [(a["model"], a["role"]) for a in f16.accessories] == [
        ("P-ACP3", "component"),
        ("P-SPM-E", "component"),
        ("URTO", "accessory"),
    ]
    floor1 = [d for d in result.drafts if d.line.page == 3 and d.line.venue == "FLOOR 1"]
    assert [d.model for d in floor1] == ["UFMP4", "PI1002", "PI1004", "PI1104", "P-DOC-C-SR"]
    assert all(d.extraction == "ocr" and 0.5 < d.confidence <= 0.9 for d in floor1)
    assert draft_at(result, 3, 20).accessories[0]["model"] == "ERM VDK"
    assert draft_at(result, 3, 200).accessories[0]["model"] == "DIN14"
    assert stats["drafts_by_level"]["(pool)"] == 15


@needs_fixture
def test_vocabulary_and_library_override_the_defaults(parsed):
    """Project `vocab(model_map)` / `vocab(level_alias)` rows and the device-type library win."""
    lines, _ = parsed
    t = target(
        model_map={"P-DOC-C-SR": "P-DOC-C-LR", "PI1104": "PI1104-F"},
        level_alias={"FLOOR 11": "02"},
        library=[bx.LibraryModel("UFMP4", "Relay panel", aliases=("Foundry 4-circuit panel",))],
    )
    res = bx.build(lines, t)
    sr = draft_at(res, 4, 50)
    assert sr.model == "P-DOC-C-LR" and sr.candidates == ["P-DOC-C-LR", "P-DOC-C-SR"]
    assert draft_at(res, 4, 180).model == "PI1104-F"
    f11 = draft_at(res, 5, 420)
    assert f11.level_code == "02" and f11.level_id == t.levels["02"] and f11.level_basis == "venue"
    # the type's (old-spelled) category names the role and is written canonical (T115)
    assert (draft_at(res, 4, 145).role, draft_at(res, 4, 145).category) == (
        "relay_panel",
        "Power Distribution",
    )
    # a split floor (03 with a 03M): panels on 03 are flagged for 03M, stations are not
    split = bx.Target(levels={**target().levels, "03M": uuid7()})
    res2 = bx.build(lines, split)
    assert draft_at(res2, 4, 145).conflicts == ["level:03/03M"]
    assert draft_at(res2, 4, 150).conflicts == ["level:03/03M"]  # the NSPS too
    assert not draft_at(res2, 4, 160).conflicts
    assert not draft_at(result_of(lines), 4, 145).conflicts  # no mezzanine: no flag


def result_of(lines):
    return bx.build(lines, target())


def test_venue_parsing():
    assert bx.parse_venue("Level 1") == bx.Venue("Level 1", ("01",), False)
    assert bx.parse_venue("FLOOR B2") == bx.Venue("FLOOR B2", ("B2",), False)
    assert bx.parse_venue("Level B2 - 12") == bx.Venue("Level B2 - 12", ("B2", "12"), True)
    assert bx.parse_venue("Level 16, 22") == bx.Venue("Level 16, 22", ("16", "22"), True)
    link = bx.parse_venue("Link to P-CCS in other building")
    assert link.pooled and link.codes == ()


def test_ocr_number_specks():
    """T109: specks at the ends of an OCR'd number are noise; the text layer stays strict."""
    for text in ("‘630", "630’", "|630", "'630.", "“630”"):
        assert bx._int(text, ocr=True) == 630
    assert bx._int("‘630") is None
    assert bx._int("1,000", ocr=True) == 1000
    assert bx._int("6‘30", ocr=True) is None  # inside the number it is not a speck
    assert bx._int("‘", ocr=True) is None


def test_model_normalisation():
    t = target()
    assert bx.normalise_model("PI1002-4Z", t).model == "PI1002"
    assert bx.normalise_model("P-TS7-E-5", t).model == "P-TS7-E"
    assert bx.normalise_model("ERP24-FT-241P", t).model == "ERP24-FT-241P"
    assert bx.normalise_model("CBS350-24P-4G-NA", t).model == "CBS350-24P-4G-NA"
    assert bx.normalise_model("P-NSPS-D-KIT", t).model == "P-NSPS-D"
    lr = bx.normalise_model("P-DOC-C-LR-5", t)
    assert lr.candidates == ["P-DOC-C-LR", "P-DOC-C-SR"] and lr.conflicts == ["model:SR/LR"]
    assert bx.fix_ocr_model("P11002-4Z") == "PI1002-4Z"
    assert bx.classify("UHCI-WM", t) == bx.Kind("sensor", "Sensor")
    assert bx.classify("SGE1552", t) is None


def test_classify_by_library_role():
    """T115 (D201): a type's role first, else the role its category names, else the model's;
    the category is the type's, canonicalised, else the role's."""
    lib = [
        # DaVinci's spelling: `Equipment` names several roles, the type carries `nsps`
        bx.LibraryModel("P-NSPS-D", "Equipment", role="nsps"),
        # a `Power Distribution` type with no role yet: the model says relay panel
        bx.LibraryModel("ERP24-FT-241P", "Power Distribution"),
        # a gateway: `Equipment`, no role, no model rule → other, still a device
        bx.LibraryModel("P-GWY", "Equipment"),
        # the role overrides what the model rule would say
        bx.LibraryModel("UFMP8", "Power Distribution", role="relay_panel"),
        bx.LibraryModel("ERn4-RM-120", "Equipment rack"),
    ]
    t = bx.Target(levels={}, library=lib)
    assert bx.classify("P-NSPS-D", t) == bx.Kind("nsps", "Equipment")
    assert bx.classify("ERP24-FT-241P", t) == bx.Kind("relay_panel", "Power Distribution")
    assert bx.classify("P-GWY", t) == bx.Kind("other", "Equipment")
    assert bx.classify("UFMP8", t) == bx.Kind("relay_panel", "Power Distribution")
    assert bx.classify("ERN4-RM-120", t) == bx.Kind("equipment_rack", "Equipment Panels")
    # no type: the model rule and the role's category (the rename ruling's table)
    bare = bx.Target(levels={})
    assert bx.classify("ERP48-FT-481P", bare) == bx.Kind("relay_panel", "Power Distribution")
    assert bx.classify("EBDK", bare) == bx.Kind("ebdk", "Emergency Equipment")
    assert bx.classify("PI1002", bare) == bx.Kind("station", "Station")


# --------------------------------------------------------- the Material List


@needs_azle
@needs_ocr
def test_material_list_goes_to_the_project_pool():
    """The scanned ETC order form (format example only, D4): items over two or three rows, no
    venue, sub-items as accessories."""
    data = AZLE.read_bytes()
    lines, pages = bx.parse(data, ocr.ocr_page)
    assert [p.extraction for p in pages] == ["ocr"] * 4
    assert {ln.job for ln in lines} == {"15090056"}
    assert all(ln.kind == "item" and ln.venue is None for ln in lines)
    first = by_ref(lines, 1, 20)
    assert (first.part_number, first.qty) == ("7131A1075", 1)
    assert first.model.endswith("Q48")  # the scan's `IQ48` reads as `1Q48`: a breaker panel
    assert first.description.startswith("SNSR") and "120V" in first.description
    assert by_ref(lines, 1, 50).qty == 43
    assert by_ref(lines, 1, 50).part_number == "CB852-2"
    assert by_ref(lines, 2, 270).delivers_for == 260
    assert by_ref(lines, 2, 280).delivers_for == 260
    res = bx.build(lines, target())
    assert all(d.level_id is None and d.level_basis == "project_pool" for d in res.drafts)
    station = draft_at(res, 2, 260)
    assert station.model == "EPS05" and station.role == "station"
    assert sorted(a["model"] for a in station.accessories) == ["EPS05-ELEC", "EPS05-FP"]
    assert any(e.line.part_number == "7131A1075" for e in res.excluded)  # the breaker panel
    assert any(e.line.part_number == "N4036" for e in res.excluded)  # a Cat5 cable


# ------------------------------------------------------------------ the job


def _project(session, codes=TOWER_LEVELS) -> tuple[uuid.UUID, dict[str, Level]]:
    levels = [
        projects.LevelIn(
            level=c, split_of="06" if c == "06M" else None, share_with="06" if c == "06M" else None
        )
        for c in codes
    ]
    out = projects.create_project(
        session, projects.ProjectIn(name="Tower", levels=levels), upsert_user(session, "Landry")
    )
    pid = uuid.UUID(out.id)
    rows = {lv.level: lv for lv in session.scalars(select(Level).where(Level.project_id == pid))}
    return pid, rows


def _run(session, store, factory, project_id, data, name="BOM.pdf"):
    batch = bom.create_bom_batch(
        session,
        store,
        project_id=project_id,
        filename=name,
        data=data,
        user=upsert_user(session, "Landry"),
    )
    state = runner.run_batch(factory, store, batch.id, job=bom.import_bom)
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state, batch.stats
    return batch


@needs_fixture
@needs_ocr
def test_bom_job_writes_drafts_as_ops(session, store, factory):
    project_id, levels = _project(session)
    # a vocab(model_map) row pair (D187): `P-DOC-C-SR` is a variant of `P-DOC-C-LR`
    canonical = Vocab(id=uuid7(), project_id=project_id, list="model_map", value="P-DOC-C-LR")
    variant = Vocab(
        id=uuid7(),
        project_id=project_id,
        list="model_map",
        value="P-DOC-C-SR",
        canonical_of_id=canonical.id,
    )
    session.add_all([canonical, variant])
    session.commit()

    batch = _run(session, store, factory, project_id, FIXTURE.read_bytes())
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["lines"] == 258 and s["ocr_pages"] == [3] and s["pages"] == [1, 2, 3, 4, 5, 6]
    assert s["jobs"] == ["15076538", "15076539", "15084073", "15084074"]
    assert s["drafts"] == 108 and s["excluded"] == 17 and len(s["excluded_lines"]) == 17
    assert s["ops"] == 108
    rows = session.scalars(select(DraftDevice).where(DraftDevice.project_id == project_id)).all()
    assert len(rows) == 108
    assert all(r.import_batch_id == batch.id and r.state == "proposed" for r in rows)
    # the vocab row pair mapped SR to LR (candidates kept, the conflict still raised — D28)
    b2_sensor = next(r for r in rows if r.source_ref["page"] == 4 and r.source_ref["line"] == 50)
    assert b2_sensor.model == "P-DOC-C-LR" and b2_sensor.model_raw == "P-DOC-C-SR-4"
    assert b2_sensor.candidates == ["P-DOC-C-LR", "P-DOC-C-SR"] and b2_sensor.conflicts == [
        "model:SR/LR"
    ]
    assert b2_sensor.level_id == levels["B2"].id and b2_sensor.source_ref["file"] == "BOM.pdf"
    rack = next(r for r in rows if r.source_ref["page"] == 1 and r.source_ref["line"] == 320)
    assert rack.level_id == levels["06M"].id and rack.category == "Equipment Panels"
    assert rack.role == "equipment_rack"
    assert rack.accessories[0]["role"] == "component"
    pooled = [r for r in rows if r.level_basis == "pooled_venue"]
    assert len(pooled) == 15 and all(r.level_id is None and r.confidence < 0.7 for r in pooled)
    # the ops an iPad pulls
    ops = session.scalars(
        select(Op).where(Op.project_id == project_id, Op.entity_kind == "draft_device")
    ).all()
    assert len(ops) == 108 and all(o.state == "applied" and o.kind == "create" for o in ops)
    assert all(
        o.change_type == "Master edit" and o.reason == "BOM extraction: BOM.pdf" for o in ops
    )
    assert all(o.user_id == upsert_user(session, "Landry").id for o in ops)
    json.dumps(ops[0].payload)
    # the same file again: skipped, nothing added
    again = _run(session, store, factory, project_id, FIXTURE.read_bytes())
    assert again.job_state == "skipped" and again.stats["earlier_batch"] == str(batch.id)
    assert session.scalar(
        select(DraftDevice.id).where(DraftDevice.project_id == project_id).limit(1)
    )
    assert (
        len(session.scalars(select(DraftDevice).where(DraftDevice.project_id == project_id)).all())
        == 108
    )


@needs_fixture
def test_bom_job_fails_loudly_without_ocr(session, store, factory, monkeypatch):
    """A page with no text layer and no tesseract: the batch fails with the reason, nothing is
    written (CLAUDE.md §5: fail loudly, never half-import)."""
    monkeypatch.setattr(ocr, "available", lambda: False)
    project_id, _ = _project(session)
    batch = _run(session, store, factory, project_id, FIXTURE.read_bytes())
    assert batch.job_state == "failed"
    assert "page 3 has no text layer" in batch.stats["error"]
    assert "tesseract" in batch.stats["error"]
    assert (
        session.scalars(select(DraftDevice).where(DraftDevice.project_id == project_id)).all() == []
    )


def test_bad_uploads_are_refused(session, store):
    project_id, _ = _project(session)
    with pytest.raises(runner.ImportError_, match="not a PDF"):
        bom.create_bom_batch(
            session, store, project_id=project_id, filename="x.pdf", data=b"hello", user=None
        )
    with pytest.raises(runner.ImportError_, match="could not be read"):
        bom.create_bom_batch(
            session,
            store,
            project_id=project_id,
            filename="x.pdf",
            data=b"%PDF-1.4 junk",
            user=None,
        )
    with pytest.raises(runner.ImportError_, match="unknown project"):
        bom.create_bom_batch(
            session, store, project_id=uuid7(), filename="x.pdf", data=b"%PDF", user=None
        )


@needs_fixture
def test_imports_route_queues_a_bom_batch(client, session, store):
    project_id, _ = _project(session)
    r = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(project_id), "kind": "bom"},
        files={"file": ("BOM.pdf", FIXTURE.read_bytes(), "application/pdf")},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["kind"] == "bom" and body["job_state"] == "queued"
    assert body["files"][0]["name"] == "BOM.pdf" and body["files"][0]["pages"] == 6
    assert "key" not in body["files"][0]
    assert client.get(f"/imports/{body['id']}", headers=HDR).json()["kind"] == "bom"
    bad = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(project_id), "kind": "bom"},
        files={"file": ("x.pdf", b"not a pdf", "application/pdf")},
    )
    assert bad.status_code == 422
    missing = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(uuid7()), "kind": "bom"},
        files={"file": ("BOM.pdf", b"%PDF-1.4 junk", "application/pdf")},
    )
    assert missing.status_code in (404, 422)
