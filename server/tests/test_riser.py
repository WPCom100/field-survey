"""Riser extraction (T43, PLAN §7.3, TP-9): `fixtures/riser.pdf` end to end — the bands and
levels of both sheets, the devices and bubbles of sheet 001, the rack output labels, the merge
with the BOM's drafts (D28, D10), the master cross-check (D30), the job with and without the
Claude API (recorded answers in `tests/golden/riser_claude.json`), and the `/imports` route."""

from __future__ import annotations

import json
import uuid
from collections import Counter

import pytest
from conftest import HDR, SERVER_DIR
from sqlalchemy import select
from test_seed_import import FIXTURE as MASTER
from test_seed_import import import_file

from app import claude as claude_api
from app import ocr, projects
from app.auth import upsert_user
from app.ids import uuid7
from app.jobs import bom, riser, runner
from app.jobs import bom_extract as bx
from app.jobs import riser_extract as rx
from app.models import (
    Blob,
    DraftCable,
    DraftDevice,
    ImportBatch,
    Level,
    Op,
    Placeholder,
    ReviewItem,
)

FIXTURE = SERVER_DIR.parent / "fixtures" / "riser.pdf"
BOM = SERVER_DIR.parent / "fixtures" / "BOM.pdf"
MASTER_OPS = SERVER_DIR.parent / "fixtures" / "master-ops.json"
GOLDEN = SERVER_DIR / "tests" / "golden" / "riser_claude.json"

needs_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason=f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)"
)
needs_bom = pytest.mark.skipif(not BOM.exists(), reason=f"golden fixture missing: {BOM}")
needs_master_ops = pytest.mark.skipif(
    not MASTER_OPS.exists(), reason=f"golden fixture missing: {MASTER_OPS}"
)
needs_master = pytest.mark.skipif(not MASTER.exists(), reason=f"golden fixture missing: {MASTER}")
needs_ocr = pytest.mark.skipif(
    not ocr.available(), reason="tesseract is not installed (the BOM's page 3 needs it)"
)

TOWER_LEVELS = ("B2", "B1", "01", "02", "03", "04", "06", "06M")
SHEET_001_LEVELS = ["12", "11", "10", "09", "06", "04", "03", "02", "01", "B1", "B2"]
SHEET_002_LEVELS = {
    "23",
    "24",
    "25",
    "26",
    "27",
    "28",
    "14",
    "15",
    "16",
    "17",
    "18",
    "19",
    "20",
    "21",
    "22",
}


@pytest.fixture(scope="module")
def riser_pdf() -> bytes:
    if not FIXTURE.exists():
        pytest.skip(f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)")
    return FIXTURE.read_bytes()


@pytest.fixture(scope="module")
def analysed(riser_pdf) -> rx.Riser:
    return rx.analyse(riser_pdf)


def tower_target(**kw) -> rx.Target:
    return rx.Target(levels={c: uuid7() for c in TOWER_LEVELS}, file="riser.pdf", **kw)


def band(r: rx.Riser, level: str) -> rx.Band:
    return next(b for b in r.sheets[0].bands if b.level_code == level)


def devs(r: rx.Riser, level: str) -> list[rx.Device]:
    return r.sheets[0].band_devices(band(r, level))


def dev(r: rx.Riser, level: str, model: str, name: str | None = None) -> rx.Device:
    return next(d for d in devs(r, level) if d.model == model and (name is None or d.name == name))


def recorded_client() -> claude_api.Claude:
    """Replays `tests/golden/riser_claude.json`; records live answers with `RISER_RECORD=1`."""
    return claude_api.Claude(recorder=claude_api.recorder_from_env(GOLDEN))


# ------------------------------------------------------------ the sheets


@needs_fixture
def test_bands_and_levels_of_both_sheets(analysed):
    s1, s2 = analysed.sheets
    assert (s1.drawing, s1.has_text, s1.columns) == ("001", True, 1)
    assert [b.level_code for b in s1.bands] == SHEET_001_LEVELS
    assert all(b.level_source == "text" for b in s1.bands)  # the outlined LEVEL 03 reads too
    assert all(abs(b.x0 - 1010) < 3 and abs(b.x1 - 1798) < 3 for b in s1.bands)
    assert all(b.bottom - b.top > 150 for b in s1.bands)
    # sheet 002 is outlined into curves: two columns of bands, nothing readable without vision
    assert (s2.drawing, s2.has_text, s2.columns) == ("002", False, 2)
    assert [b.column for b in s2.bands].count(0) == 6 and [b.column for b in s2.bands].count(1) == 9
    assert all(b.level_code is None for b in s2.bands) and not s2.devices and not s2.bubbles
    assert analysed.stats()["sheets"][1]["bands"][0]["bbox"][2] > 700


@needs_fixture
def test_sheet_001_devices_by_band(analysed):
    """Every device count on B2–06 matches the drawing (Phase 1f §3) — and the master's
    Devices tab for the floors it surveyed."""
    r = analysed
    # level 01: two 48-relay panels with their cards, the rack, UFMP4 ×7, the touchscreen, the chain
    l01 = devs(r, "01")
    pb = dev(r, "01", "ERP48-FT-481P", "CT01LCPB")
    assert pb.category == "Relay panel" and pb.model_raw == "ERP-FT-481P"
    assert [(a["model"], a["qty"]) for a in pb.accessories] == [("ERP-FT-LVD", 2), ("ERP-RTO", 1)]
    assert dev(r, "01", "ERP48-FT-481P", "CT01LCPA").qty == 1
    rack = dev(r, "01", "ERN4-RM-120")
    assert rack.category == "Equipment rack" and rack.name == rx.RACK_NAME
    comps = {a["model"] for a in rack.accessories}
    assert {"P-ACP", "P-SPM-E", "MOSAIC MSCX-10 SHOW CONTROLLER", "24-PORT PATCH PANEL"} <= comps
    assert all(a["role"] == "component" for a in rack.accessories)
    assert dev(r, "01", "UFMP4").qty == 7 and dev(r, "01", "UFMP4").qty_source == "qty"
    assert dev(r, "01", "P-TS7-E").category == "Touchscreen"
    assert sum(1 for d in l01 if d.category == "EBDK") == 2
    counts = {(d.model, d.qty) for d in l01 if d.category in ("Station", "Sensor")}
    assert counts == {("P-DOC-C-LR", 1), ("PI1002", 5), ("PI1004", 2), ("PI1104", 15)}
    assert all(d.extraction == "text" and d.confidence == rx.TEXT_CONFIDENCE for d in l01)
    # level 06: CT06LCPA is a Foundry panel, CT06LCPB a 24-relay panel; the mezzanine rack
    assert dev(r, "06", "UFMP8", "CT06LCPA").category == "Foundry panel"
    assert [
        (a["model"], a["qty"]) for a in dev(r, "06", "ERP24-FT-241P", "CT06LCPB").accessories
    ] == [("ERP-FT-LVD", 1), ("ERP-RTO", 1)]
    assert dev(r, "06", "ERN4-RM-120").qty == 1
    assert {(d.model, d.qty) for d in devs(r, "06") if d.category in ("Station", "Sensor")} == {
        ("P-DOC-C-LR", 7),
        ("PI1002", 7),
    }
    # level 04: the partition sensor, the switch-mount sensor, an NSPS in its enclosure
    l04 = {(d.model, d.qty) for d in devs(r, "04")}
    assert {
        ("UHCI-WM", 1),
        ("P-DOC-SM2", 2),
        ("P-DOC-C-LR", 4),
        ("P-LS", 1),
        ("PI1002", 10),
        ("PI1004", 2),
        ("PI1104", 4),
        ("UFMP8", 1),
        ("P-NSPS-D", 1),
    } <= l04
    assert dev(r, "04", "P-NSPS-D").model_raw == "P-NSPS-DIN"
    # level 03: 13 ceiling sensors (the BOM says 11 LR + 2 SR; the survey found 9 — a conflict)
    assert dev(r, "03", "P-DOC-C-LR").qty == 13
    assert {(d.model, d.qty) for d in devs(r, "03") if d.category == "Station"} == {
        ("PI1002", 8),
        ("PI1004", 1),
        ("PI1104", 10),
    }
    assert dev(r, "03", "UFMP4").qty == 2
    # B1: the wall sensors the BOM calls P-DOC-W-WD
    assert dev(r, "B1", "P-DOC-W").qty == 8 and dev(r, "B1", "P-DOC-C-LR").qty == 13
    assert dev(r, "B1", "ERP24-FT-241P", "CTB1LCPB").category == "Relay panel"
    # NSPS enclosures: `2 - P-NSPS-DIN` on 09 and 10, `1 -` on 11
    assert dev(r, "10", "P-NSPS-D").qty == 2 and dev(r, "11", "P-NSPS-D").qty == 1
    # Phase 1f: pooled BOM totals equal the riser's placements on B2–12
    all_devs = r.sheets[0].devices
    assert sum(1 for d in all_devs if d.model == "ERP24-FT-241P") == 9
    assert sum(1 for d in all_devs if d.model == "ERP48-FT-481P") == 6
    assert sum(d.qty for d in all_devs if d.category == "EBDK") == 15
    assert sum(1 for d in all_devs if d.model == "UFMP8" and d.name) == 5  # + the loose one on 04
    assert len(all_devs) == 93


@needs_fixture
def test_bubbles_and_rack_output_labels(analysed):
    r = analysed
    s1 = r.sheets[0]
    assert Counter(b.code for b in s1.bubbles) == {
        "X": 46,
        "N": 5,
        "F": 3,
        "P": 15,
        "NG": 1,
        "UV": 1,
    }
    assert s1.unison_links == 41  # chain links between device types, not runs
    assert all(
        b.fragments >= rx.BUBBLE_MIN_FRAGMENTS and b.extraction == "text" for b in s1.bubbles
    )
    assert all(b.bbox[2] > 15 and b.bbox[3] > 8 for b in s1.bubbles)
    labelled = {(b.band.level_code, b.code, b.output_label) for b in s1.bubbles if b.output_label}
    assert labelled == {
        ("01", "X", "DMX TO B3A CANYON"),
        ("01", "X", "DMX TO C13A OCULUS"),
        ("01", "X", "DMX TO D1 ED COLUMN CAPITAL"),
        ("01", "N", "TO WALTER TOWER ETC P-CCS"),
        ("01", "F", "TO EQUIP RACK LEVEL 06"),
        ("06", "X", "DMX/KINET TO B3B ELEV CORE C FIX"),
        ("06", "X", "DMX/KINET TO B7 STAIR A FIX"),
        ("06", "X", "SPARE DMX OUT"),
        ("06", "N", "TO ERn4 LEVEL 16"),
        ("06", "F", "TO EQUIP RACK LEVEL 28"),
        ("06", "F", "TO EQUIP RACK LEVEL 01"),
    }
    assert sum(1 for b in s1.bubbles if b.output_label == "SPARE DMX OUT") == 2
    assert sum(1 for b in s1.bubbles if b.output_label == "TO ERn4 LEVEL 16") == 2
    assert [b.code for b in s1.band_bubbles(band(r, "04")) if b.code == "UV"] == ["UV"]
    # a crop for the model: ≤ 2000 px, pixel boxes inside it
    crop = rx.band_crop(FIXTURE.read_bytes(), s1, band(r, "01"))
    assert crop.width_px <= rx.CROP_MAX_PX and crop.height_px <= rx.CROP_MAX_PX
    for b in s1.band_bubbles(band(r, "01")):
        x, y, w, h = crop.to_px(b.bbox)
        assert 0 <= x < crop.width_px and 0 <= y < crop.height_px and w > 0 and h > 0
    assert crop.to_pt(crop.to_px(b.bbox)) == pytest.approx(b.bbox, abs=1.0)
    assert rx.column_overview(FIXTURE.read_bytes(), s1, band(r, "01")).startswith(b"\x89PNG")
    prompt = rx.band_prompt(s1, band(r, "01"), crop, list(TOWER_LEVELS))
    assert "d1: CT01LCPB" in prompt and "label 'DMX TO B3A CANYON'" in prompt
    assert "12, 11, 10, 09, 06, 04, 03, 02, 01, B1, B2" in prompt


def test_far_end_labels_resolve_to_placeholders_and_levels():
    t = tower_target(placeholders={"B3A Canyon": uuid7(), "Spare DMX out": uuid7()})
    b = rx._Build(rx.Riser([]), t)
    label, lvl, far = b.resolve_label("DMX TO B3A CANYON")
    assert (label, lvl) == ("B3A Canyon", None) and far["id"] == str(t.placeholders["B3A Canyon"])
    label, lvl, far = b.resolve_label("DMX/KINET TO B3B ELEV CORE C FIX")
    assert label == "B3B Elev Core C fixture" and far["kind"] == "placeholder"
    assert rx.fixture_label("D1 ED COLUMN CAPITAL") == "D1 ED Column Capital"
    assert rx.fixture_label("B7 STAIR A FIX") == "B7 Stair A fixture"
    assert b.resolve_label("SPARE DMX OUT")[2]["id"] == str(t.placeholders["Spare DMX out"])
    assert b.resolve_label("TO WALTER TOWER ETC P-CCS")[0] == "Walter Tower ETC P-CCS"
    label, lvl, far = b.resolve_label("TO EQUIP RACK LEVEL 06")
    assert (label, lvl, far) == ("Equipment Rack 18U Level 06", "06", None)  # no rack draft yet
    label, lvl, far = b.resolve_label("TO ERn4 LEVEL 16")
    assert (label, lvl, far["kind"], far["label"]) == ("Level 16", "16", "placeholder", "Level 16")
    assert b.resolve_label("TO RELAY PANEL LEVEL 20")[1] == "20"
    assert b.resolve_label("Something else", "03") == ("Something else", "03", None)
    assert {p.label for p in b.placeholders} == {
        "B3B Elev Core C fixture",
        "Walter Tower ETC P-CCS",
        "Level 16",
        "Level 20",
    }
    assert {p.kind for p in b.placeholders} == {"fixture_run", "external", "level_not_in_scope"}
    assert (
        rx.level_order_key("B2")
        < rx.level_order_key("B1")
        < rx.level_order_key("01")
        < rx.level_order_key("06")
        < rx.level_order_key("06M")
        < rx.level_order_key("07")
    )
    assert rx.model_key("P-DOC-C-SR") == rx.model_key("P-DOC-C-LR") and rx.model_key(
        "P-NSPS-D-KIT"
    ) == rx.model_key("P-NSPS-DIN")


# ----------------------------------------------------------------- build


@needs_fixture
def test_build_without_a_bom_or_endpoints(analysed):
    """The deterministic drafts alone: every symbol a draft, every run bubble a cable, the
    rack's labelled outputs resolved, the rest flagged for the reviewer (D11)."""
    t = tower_target()
    res = rx.build(analysed, t)
    assert len(res.drafts) == len(analysed.sheets[0].devices) == 93
    assert not res.edits and not res.deletions and res.merged == 0
    assert all(
        "source:riser_only" not in d.conflicts for d in res.drafts
    )  # no BOM to disagree with
    on_06 = [d for d in res.drafts if d.level_code == "06"]
    assert {d.model for d in on_06 if "level:06/06M" in d.conflicts} == {
        "UFMP8",
        "ERP24-FT-241P",
        "ERN4-RM-120",
        "EBDK",
    }
    assert all(d.level_id == t.levels["06"] for d in on_06)
    off = [d for d in res.drafts if d.level_code == "12"]
    assert off and all(d.level_id is None and d.level_basis == "riser_band" for d in off)
    assert all(d.level_basis == "riser_band" and d.extraction == "text" for d in res.drafts)
    row = next(d for d in res.drafts if d.name == "CT01LCPB").row()
    json.dumps(row, default=str)
    assert row["source_ref"]["kind"] == "riser_symbol" and row["source_ref"]["sheet"] == "001"
    assert row["source_ref"]["level_code"] == "01" and row["source_ref"]["band"] == "p1c0b8"
    assert row["accessories"][0]["role"] == "accessory" and row["state"] == "proposed"
    assert row["confidence"] == 0.9 and row["candidates"] is None
    nsps = next(d for d in res.drafts if d.level_code == "03" and d.category == "NSPS")
    assert "network:no_N_run" in nsps.conflicts
    assert {f["check"] for f in res.findings} == {"network_run"}
    # cables: one per run bubble; the labelled outputs resolved, the rest unresolved
    assert len(res.cables) == 71 and Counter(c.code for c in res.cables)["X"] == 46
    labelled = [c for c in res.cables if c.source_ref["label"]]
    assert len(labelled) == 13 and all(c.confidence == rx.LABEL_CONFIDENCE for c in labelled)
    canyon = next(c for c in labelled if c.source_ref["label"] == "DMX TO B3A CANYON")
    assert canyon.to_label == "B3A Canyon" and canyon.level_id == t.levels["01"]
    assert [c["side"] for c in canyon.candidates] == ["to", "from"]
    assert (
        canyon.candidates[0]["kind"] == "placeholder"
        and canyon.candidates[1]["label"] == rx.RACK_NAME
    )
    assert canyon.from_label == rx.RACK_NAME and not canyon.conflicts
    to06 = next(c for c in labelled if c.source_ref["label"] == "TO EQUIP RACK LEVEL 06")
    assert to06.to_level_id == t.levels["06"] and to06.to_label == "Equipment Rack 18U Level 06"
    assert to06.candidates[0]["kind"] == "draft_device"  # the rack draft on band 06
    to16 = next(c for c in labelled if c.source_ref["label"] == "TO ERn4 LEVEL 16")
    assert to16.to_level_id is None and to16.candidates[0]["label"] == "Level 16"
    rest = [c for c in res.cables if not c.source_ref["label"]]
    assert all("endpoint:unresolved" in c.conflicts and c.confidence == 0 for c in rest)
    assert {p.label for p in res.placeholders} == {
        "B3A Canyon",
        "C13A Oculus",
        "D1 ED Column Capital",
        "Walter Tower ETC P-CCS",
        "B3B Elev Core C fixture",
        "B7 Stair A fixture",
        "Spare DMX out",
        "Level 16",
        "Level 28",
    }
    crow = canyon.row()
    json.dumps(crow, default=str)
    assert (
        crow["origin"] == "riser"
        and crow["qty"] == 1
        and crow["source_ref"]["kind"] == "riser_bubble"
    )
    stats = res.stats()
    assert (
        stats["cable_drafts"] == 71
        and stats["endpoints_unresolved"] == 58
        and stats["placeholders_added"] == 9
    )


def _no_ocr(_pdf: bytes, _page: int, **_kw) -> list[ocr.Word]:
    return []


def bom_drafts(levels: dict[str, uuid.UUID]) -> list[rx.BomDraft]:
    """The BOM's text pages as `BomDraft`s (page 3 — levels 01 and 02 — needs OCR and is
    left out, so this stays deterministic on every machine)."""
    lines, _ = bx.parse(BOM.read_bytes(), _no_ocr)
    res = bx.build(lines, bx.Target(levels=levels))
    out = []
    for d in res.drafts:
        row = d.row()
        out.append(
            rx.BomDraft(
                id=uuid7(),
                level_id=d.level_id,
                level_code=d.level_code,
                model=d.model,
                candidates=list(d.candidates),
                qty=d.qty,
                level_basis=d.level_basis,
                venue=row["source_ref"].get("venue"),
                accessories=list(d.accessories),
                source_ref=row["source_ref"],
                conflicts=list(d.conflicts),
                confidence=d.confidence,
                name=None,
            )
        )
    return out


@needs_fixture
@needs_bom
def test_build_merges_with_the_bom(analysed):
    """D28 / D10: one draft per device carrying both sources; pooled BOM lines placed by the
    riser; a differing count is a conflict the reviewer settles."""
    t = tower_target()
    t.bom = bom_drafts(t.levels)
    # the OCR page's `PI1004 1` on Level 1 (Phase 1f: BOM 1 / riser 2 / master 2), by hand
    pi1004 = rx.BomDraft(
        uuid7(),
        t.levels["01"],
        "01",
        "PI1004",
        ["PI1004"],
        1,
        "venue",
        "FLOOR 1",
        [],
        {"kind": "bom_line", "page": 3, "line": 60, "venue": "FLOOR 1"},
        [],
        0.85,
        None,
    )
    t.bom.append(pi1004)
    res = rx.build(analysed, t)
    by_id = {b.id: b for b in t.bom}
    # pooled lines whose riser placements add up are replaced by per-level drafts
    deleted = {by_id[d.draft_id].model for d in res.deletions}
    assert {"ERP24-FT-241P", "ERP48-FT-481P", "EBDK", "UFMP8", "P-TS7-E"} <= deleted
    assert all("Placed by the riser" in d.reason for d in res.deletions)
    erp24 = [d for d in res.drafts if d.model == "ERP24-FT-241P"]
    assert len(erp24) == 9 and all(d.source_ref["bom"]["venue"] == "Level B2 - 12" for d in erp24)
    assert all(d.level_basis == "riser_band" and "qty:bom≠riser" not in d.conflicts for d in erp24)
    assert {d.level_code for d in erp24} == {"B2", "B1", "02", "03", "04", "06"}
    ts = next(d for d in res.drafts if d.model == "P-TS7-E")
    assert (
        ts.level_code == "01" and ts.source_ref["bom"]["venue"] == "Link to P-CCS in other building"
    )
    # the option cards pooled over the venue's ERP lines agree with the riser's card lines
    assert not any(f["check"] == "option_cards" for f in res.findings)
    # pooled sensors of the upper floors (sheet 002, unread here) stay as they are
    upper = [
        b
        for b in t.bom
        if b.level_basis == "pooled_venue" and b.venue in ("Level 14 - 28", "Level 16, 22")
    ]
    assert {b.model for b in upper} >= {"P-DOC-C-LR", "P-LS", "PI1002"}
    assert all(
        b.id not in {e.draft_id for e in res.edits} | {d.draft_id for d in res.deletions}
        for b in upper
    )
    # the pooled lines the riser places only in part (floors 09 / 10 / 01 / 02 are on the OCR
    # page, left out here) stay beside their per-level drafts, both flagged
    partial = next(f for f in res.findings if f["check"] == "pooled_total" and f["model"] == "P-LS")
    assert partial["riser"] > 0 and partial["riser"] != partial["bom"]
    conf_now = {e.draft_id: e.now for e in res.edits if e.field == "conflicts"}
    pls = next(b for b in t.bom if b.model == "P-LS" and b.venue == partial["venue"])
    assert "qty:bom≠riser" in conf_now[pls.id]
    assert all(
        "qty:bom≠riser" in d.conflicts
        for d in res.drafts
        if d.source_ref.get("bom", {}).get("draft_id") == str(pls.id)
    )
    # same-level merges: both sources on the BOM draft, no riser draft
    merged_ids = {e.draft_id for e in res.edits}
    l03_sensors = [b for b in t.bom if b.level_code == "03" and b.model.startswith("P-DOC-C")]
    assert len(l03_sensors) == 2 and all(b.id in merged_ids for b in l03_sensors)
    refs = {e.draft_id: e.now for e in res.edits if e.field == "source_ref"}
    lr = next(b for b in l03_sensors if b.model == "P-DOC-C-LR")
    assert refs[lr.id]["kind"] == "bom_line" and refs[lr.id]["riser"]["qty"] == 13
    assert refs[lr.id]["riser"]["shared_with"] == [str(o.id) for o in l03_sensors if o is not lr]
    conf = {e.draft_id: e.now for e in res.edits if e.field == "conflicts"}
    assert lr.id not in conf or "qty:bom≠riser" not in conf[lr.id]  # 11 + 2 = 13: counts agree
    assert not any(d.model.startswith("P-DOC-C") and d.level_code == "03" for d in res.drafts)
    # the known conflict: Level 1 PI1004, BOM 1 vs riser 2
    assert "qty:bom≠riser" in conf[pi1004.id]
    assert any(
        f == {"check": "qty", "level": "01", "model": "PI1004", "bom": 1, "riser": 2}
        for f in res.findings
    )
    # the BOM's `Level 5` rack is on 06M; the riser's band 06 rack merges into it, no level flag
    rack = next(b for b in t.bom if b.model == "ERN4-RM-120" and b.level_code == "06M")
    assert rack.id in merged_ids and "level:06/06M" not in conf.get(rack.id, [])
    assert not any(d.model == "ERN4-RM-120" and d.level_code == "06" for d in res.drafts)
    # names: the riser's panel tag becomes the Device name on a merged draft (D10)
    names = {e.draft_id: e.now for e in res.edits if e.field == "name"}
    # the Tower's panels are pooled (riser drafts, named at birth); the BOM's two racks get theirs
    assert len(names) == 2 and set(names.values()) == {rx.RACK_NAME}
    assert all(d.name for d in erp24)
    # riser-only (no BOM line on that level): flagged for the reviewer
    riser_only = [d for d in res.drafts if "source:riser_only" in d.conflicts]
    assert {d.level_code for d in riser_only} >= {"01", "02"}  # the OCR page's floors
    assert res.merged > 10 and res.split >= 9 + 6 + 15 + 5 + 1  # + the OCR floors' partial placements
    stats = res.stats()
    assert stats["bom_deleted"] == len(res.deletions) and stats["pooled_split"] == res.split


@needs_fixture
@needs_master_ops
@needs_bom
def test_tp9_device_keys_and_the_master_cross_check(analysed):
    """TP-9: ≥ 50 of the master's (level, model) keys come out of BOM + riser; the two known
    quantity conflicts are raised (Level 1 PI1004 BOM ≠ riser; Level 3 sensors riser ≠ master)."""
    ops = json.loads(MASTER_OPS.read_text(encoding="utf-8"))["ops"]
    levels = {
        o["entity_id"]: o["payload"]["level"]
        for o in ops
        if o["entity_kind"] == "level" and o["kind"] == "create"
    }
    master = [
        rx.MasterDevice(
            levels[o["payload"]["level_id"]], o["payload"]["device"], o["payload"].get("category")
        )
        for o in ops
        if o["entity_kind"] == "device" and o["kind"] == "create" and o["payload"].get("device")
    ]
    keys = sorted({(m.level_code, m.device) for m in master})
    assert len(keys) == 57
    t = tower_target(master=master)
    t.bom = bom_drafts(t.levels)
    res = rx.build(analysed, t)
    found: set[tuple[str, str]] = set()
    for d in analysed.sheets[0].devices:
        if d.band.level_code:
            found.add((d.band.level_code, (d.name or d.model).upper()))
            found.add((d.band.level_code, rx.model_key(d.model)))
    for b in t.bom:
        if b.level_code:
            found.add((b.level_code, rx.model_key(b.model)))
            for c in b.candidates:
                found.add((b.level_code, rx.model_key(c)))

    def hit(level: str, device: str) -> bool:
        fam = level[:-1] if level.endswith("M") else level
        return any(
            (lv, k) in found for lv in (level, fam) for k in (device.upper(), rx.model_key(device))
        )

    misses = [k for k in keys if not hit(*k)]
    assert len(keys) - len(misses) >= 50, misses
    assert misses == [
        ("04", "Partition sensors")
    ]  # the BOM's AD-C18 parts under UHCI-WM (Phase 1f)
    # the master cross-check (D30): Level 3 sensors 13 on the riser, 9 found on site
    conflicts = {(c.level_code, c.model): (c.riser_qty, c.master_qty) for c in res.conflicts}
    assert conflicts[("03", "P-DOC-C-LR")] == (13, 9)
    assert (
        "01",
        "PI1004",
    ) not in conflicts  # riser 2 = master 2 (the BOM's 1 is the other conflict)
    assert all(c.level_id == t.levels[c.level_code] for c in res.conflicts)
    assert len(res.conflicts) <= 6, conflicts


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


def _run(session, store, factory, project_id, data, client, name="riser.pdf"):
    batch = riser.create_riser_batch(
        session,
        store,
        project_id=project_id,
        filename=name,
        data=data,
        user=upsert_user(session, "Landry"),
    )
    state = runner.run_batch(
        factory, store, batch.id, job=lambda s, st, b: riser.import_riser(s, st, b, client=client)
    )
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state, batch.stats
    return batch


@needs_fixture
def test_riser_job_without_a_claude_key(session, store, factory):
    """No key, no recording: the deterministic drafts land, cables wait for the reviewer, the
    stats say Claude was unavailable (D11: an import never blocks)."""
    project_id, levels = _project(session)
    client = claude_api.Claude(api_key="", recorder=None)
    assert not client.available()
    batch = _run(session, store, factory, project_id, FIXTURE.read_bytes(), client)
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["claude"].startswith("unavailable") and s["claude_bands"] is None
    assert s["levels"] == SHEET_001_LEVELS and s["device_drafts"] == 93 and s["cable_drafts"] == 71
    assert s["endpoints_unresolved"] == 58 and s["placeholders_added"] == 9
    rows = session.scalars(select(DraftDevice).where(DraftDevice.project_id == project_id)).all()
    assert len(rows) == 93 and all(
        r.state == "proposed" and r.import_batch_id == batch.id for r in rows
    )
    assert all(
        r.source_ref["kind"] == "riser_symbol" and r.source_ref["file"] == "riser.pdf" for r in rows
    )
    assert {r.level_id for r in rows if r.source_ref["level_code"] == "01"} == {levels["01"].id}
    cables = session.scalars(select(DraftCable).where(DraftCable.project_id == project_id)).all()
    assert len(cables) == 71 and all(c.origin == "riser" and c.state == "proposed" for c in cables)
    canyon = next(c for c in cables if c.source_ref.get("label") == "DMX TO B3A CANYON")
    ph = session.scalars(select(Placeholder).where(Placeholder.project_id == project_id)).all()
    assert {p.label: p.kind for p in ph}["B3A Canyon"] == "fixture_run" and len(ph) == 9
    assert canyon.candidates[0]["id"] == str(next(p.id for p in ph if p.label == "B3A Canyon"))
    assert canyon.level_id == levels["01"].id and canyon.to_label == "B3A Canyon"
    blob = session.get(Blob, s["blob"])
    assert blob is not None and blob.upload_state == "complete" and store.read(f"blobs/{s['blob']}")
    ops = session.scalars(
        select(Op).where(
            Op.project_id == project_id,
            Op.entity_kind.in_(("draft_device", "draft_cable", "placeholder")),
        )
    ).all()
    assert len(ops) == 93 + 71 + 9 == s["ops"] and all(
        o.state == "applied" and o.kind == "create" for o in ops
    )
    assert all(
        o.change_type == "Master edit" and o.reason == "Riser extraction: riser.pdf" for o in ops
    )
    json.dumps(ops[0].payload)
    again = _run(session, store, factory, project_id, FIXTURE.read_bytes(), client)
    assert again.job_state == "skipped" and again.stats["earlier_batch"] == str(batch.id)


@needs_fixture
def test_riser_job_with_claude_endpoints(session, store, factory):
    """The recorded Claude answers (TP-9): endpoints on every run, sheet 002 read by vision,
    low-confidence endpoints flagged, cost per run in the stats."""
    client = recorded_client()
    if not client.available():
        pytest.skip("no recorded Claude answers and no ANTHROPIC_API_KEY")
    project_id, levels = _project(session)
    batch = _run(session, store, factory, project_id, FIXTURE.read_bytes(), client)
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["claude"]["calls"] == 11 + 15 and s["claude"]["model"] == client.model
    assert s["claude"]["input_tokens"] > 50_000 and s["claude"]["output_tokens"] > 5_000
    assert 0.5 < s["claude"]["cost_usd"] < 5.0
    assert all("error" not in b for b in s["claude_bands"]), s["claude_bands"]
    # sheet 002's bands got their levels and devices from the model
    assert set(s["levels"]) == set(SHEET_001_LEVELS) | SHEET_002_LEVELS
    sheet2 = s["sheets"][1]
    assert sheet2["devices"] >= 60 and sheet2["bubbles"] >= 20
    assert all(b["source"] == "model" for b in sheet2["bands"])
    rows = session.scalars(select(DraftDevice).where(DraftDevice.project_id == project_id)).all()
    vision = [r for r in rows if r.extraction == "model"]
    assert len(vision) == sheet2["devices"] and all(
        r.confidence <= rx.MODEL_CONFIDENCE_CAP for r in vision
    )
    assert all(
        r.level_id is None and r.source_ref["sheet"] == "002" for r in vision
    )  # 14–28 are not project levels
    l16 = [r for r in vision if r.source_ref["level_code"] == "16"]
    assert {(r.model, r.qty) for r in l16} >= {
        ("ERP24-FT-241P", 1),
        ("UFMP8", 1),
        ("EBDK", 1),
        ("ERN4-RM-120", 1),
    }
    # cables: every run has endpoints now; the guesses are flagged
    cables = session.scalars(select(DraftCable).where(DraftCable.project_id == project_id)).all()
    assert len(cables) >= 71 + 20
    unresolved = [c for c in cables if "endpoint:unresolved" in (c.conflicts or [])]
    assert len(unresolved) < len(cables) // 4, len(unresolved)
    low = [c for c in cables if c.confidence < rx.LOW_CONFIDENCE]
    assert low and all("endpoint:low_confidence" in c.conflicts for c in low)
    assert s["endpoints_low_confidence"] == len(low)
    resolved = [c for c in cables if c.from_label and (c.to_label or c.to_level_id)]
    assert len(resolved) >= len(cables) * 3 // 4
    assert all(
        c.confidence <= rx.MODEL_CONFIDENCE_CAP
        for c in cables
        if c.extraction == "model" and not c.source_ref.get("label")
    )
    # a DMX run from a Level 3 panel: from the panel, to a device or a level, with a candidate
    l03 = [c for c in cables if c.source_ref["level_code"] == "03" and c.code == "X"]
    assert l03 and any(c.from_label and c.from_label.startswith("CT03LCP") for c in l03)
    assert any(c["side"] == "from" and c["kind"] == "draft_device" for c in l03[0].candidates or [])
    # the recording is what the test ran against (nothing live in CI)
    if not client.recorder.record:
        assert s["claude"]["replayed"] == s["claude"]["calls"]
    client.recorder.save()


@needs_fixture
@needs_bom
@needs_master
@needs_ocr
def test_riser_after_the_master_and_the_bom(session, store, factory):
    """The Tower as it will be set up: the master seeded (D30), the BOM extracted, then the
    riser — the BOM's drafts carry both sources, the known conflicts are review items."""
    project_id, _ = import_file(session, store, factory, MASTER)
    bom_batch = bom.create_bom_batch(
        session,
        store,
        project_id=project_id,
        filename="BOM.pdf",
        data=BOM.read_bytes(),
        user=upsert_user(session, "Landry"),
    )
    assert runner.run_batch(factory, store, bom_batch.id, job=bom.import_bom) == "done"
    client = recorded_client()
    if not client.available():
        client = claude_api.Claude(api_key="", recorder=None)
    batch = _run(session, store, factory, project_id, FIXTURE.read_bytes(), client)
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["merged_into_bom"] >= 15 and s["pooled_split"] >= 30 and s["bom_deleted"] >= 4
    levels = {
        lv.id: lv.level
        for lv in session.scalars(select(Level).where(Level.project_id == project_id))
    }
    drafts = session.scalars(
        select(DraftDevice).where(
            DraftDevice.project_id == project_id, DraftDevice.deleted_at.is_(None)
        )
    ).all()
    pi1004 = next(
        d
        for d in drafts
        if d.model == "PI1004"
        and levels.get(d.level_id) == "01"
        and d.source_ref["kind"] == "bom_line"
    )
    assert "qty:bom≠riser" in d.conflicts if (d := pi1004) else False
    assert pi1004.source_ref["riser"]["qty"] == 2 and pi1004.qty == 1
    items = session.scalars(
        select(ReviewItem).where(
            ReviewItem.project_id == project_id, ReviewItem.kind == "source_conflict"
        )
    ).all()
    sensors = next(
        i for i in items if i.subject["level_code"] == "03" and i.subject["model"] == "P-DOC-C-LR"
    )
    assert {c["side"]: c["value"] for c in sensors.candidates} == {
        "riser": 13,
        "bom": 13,
        "master": 9,
    }
    assert sensors.level_id is not None and sensors.state == "open"
    deleted = session.scalars(
        select(DraftDevice).where(
            DraftDevice.project_id == project_id, DraftDevice.deleted_at.is_not(None)
        )
    ).all()
    assert {d.model for d in deleted} >= {"ERP24-FT-241P", "EBDK", "UFMP8"}
    assert all("Placed by the riser" in d.delete_reason for d in deleted)
    assert s["source_conflicts"] == len(items) <= 6


def test_bad_uploads_are_refused(session, store):
    project_id, _ = _project(session)
    with pytest.raises(runner.ImportError_, match="not a PDF"):
        riser.create_riser_batch(
            session, store, project_id=project_id, filename="x.pdf", data=b"hello", user=None
        )
    with pytest.raises(runner.ImportError_, match="unknown project"):
        riser.create_riser_batch(
            session, store, project_id=uuid7(), filename="x.pdf", data=b"%PDF", user=None
        )


@needs_fixture
def test_imports_route_queues_a_riser_batch(client, session, store):
    project_id, _ = _project(session)
    r = client.post(
        "/imports",
        headers={**HDR, "X-Survey-User": "Landry"},
        data={"project_id": str(project_id), "kind": "riser"},
        files={"file": ("riser.pdf", FIXTURE.read_bytes(), "application/pdf")},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert (
        body["kind"] == "riser" and body["job_state"] == "queued" and body["files"][0]["pages"] == 2
    )
    assert client.get(f"/imports/{body['id']}", headers=HDR).json()["kind"] == "riser"


def test_claude_cost_and_recording(tmp_path):
    assert claude_api.cost_of("claude-opus-5-5", 1_000_000, 100_000) == 6.0
    assert claude_api.cost_of("claude-fable-5-1", 100_000, 10_000) == 1.5
    assert claude_api.cost_of("something-else", 1, 1) is None
    rec = claude_api.Recorder(tmp_path / "rec.json", record=False)
    c = claude_api.Claude(api_key="", recorder=rec)
    assert c.available()  # a recording is a source of answers
    key = claude_api.request_key(c.model, "s", "p", {"type": "object"}, [b"img"])
    rec.put(
        key,
        {
            "label": "x",
            "model": c.model,
            "input_tokens": 1000,
            "output_tokens": 100,
            "data": {"ok": True},
        },
    )
    a = c.extract(system="s", prompt="p", schema={"type": "object"}, images=[b"img"], label="x")
    assert (
        a.data == {"ok": True}
        and a.replayed
        and a.cost_usd == claude_api.cost_of(c.model, 1000, 100)
    )
    assert c.totals()["calls"] == 1 and c.totals()["replayed"] == 1
    with pytest.raises(claude_api.ClaudeError, match="no recorded answer"):
        c.extract(system="s", prompt="other", schema={"type": "object"}, images=[], label="y")
    rec.save()
    assert json.loads((tmp_path / "rec.json").read_text())[key]["data"] == {"ok": True}
