"""DaVinci library import (T111, D196, D197): the trimmed golden
`fixtures/davinci-library-sample.json` (P-NSPS-D, EBDK, UHCI-WM, ERn2-W-120 Mk2, P-TS7-E, UH10002,
ERP-FT-LVD and what they reference) through the pure plan and the job — categories, cables,
accessories and expected quantities, the mapping workbook, re-runs by `typeId`, accepted types
left alone, the route."""

from __future__ import annotations

import io
import json
import uuid

import pytest
from conftest import HDR, SERVER_DIR
from openpyxl import Workbook
from sqlalchemy import select

from app import projects
from app.auth import upsert_user
from app.ids import uuid7
from app.jobs import davinci_library as dl
from app.jobs import runner
from app.models import ImportBatch, LibraryType, Op, Vocab

SAMPLE = SERVER_DIR.parent / "fixtures" / "davinci-library-sample.json"
CATEGORIES = SERVER_DIR.parent / "fixtures" / "DaVinci_categories.xlsx"
needs_sample = pytest.mark.skipif(
    not SAMPLE.exists(), reason=f"golden fixture missing: {SAMPLE} (CLAUDE.md §6)"
)
needs_categories = pytest.mark.skipif(
    not CATEGORIES.exists(), reason=f"golden fixture missing: {CATEGORIES} (CLAUDE.md §6)"
)

ANN = {**HDR, "X-Survey-User": "Ann"}
ELEVEN = {
    "Power Distribution",
    "Emergency Equipment",
    "Equipment",
    "Equipment Panels",
    "Equipment Rack",
    "Power Supplies",
    "Wall Plates",
    "Lighting Console",
    "Touchscreen",
    "Station",
    "Sensor",
}
# DaVinci type ids of the golden types (tests/make_davinci_sample.py)
NSPS = "ff6d4887-353a-4919-bcc2-50ad725ecc8d"
EBDK = "fbe5485b-d8c7-442e-aeb4-2e40a8bc3f25"
UHCI = "1649d29d-55b0-4cd6-ab9e-1b0fa45bd6cb"
ERN2 = "e1179d8b-2ba9-4401-80df-b8637d2f2ce0"
TS7 = "42d3aab8-fca8-43e5-a4f9-171e593cdacc"
UH10002 = "0df62e93-5094-4ef3-8e28-97611c11164e"
LVD = "d22fb480-10b7-4bb9-9b07-e5520d880ea1"
ERP24 = "e55eba99-a39f-453f-b94c-3560fa3af0ea"
FACEPLATE = "73007934-a2bb-4fce-9d6d-30d4dc12da74"


@pytest.fixture(scope="module")
def sample() -> bytes:
    if not SAMPLE.exists():
        pytest.skip(f"golden fixture missing: {SAMPLE}")
    return SAMPLE.read_bytes()


@pytest.fixture(scope="module")
def categories() -> bytes:
    if not CATEGORIES.exists():
        pytest.skip(f"golden fixture missing: {CATEGORIES}")
    return CATEGORIES.read_bytes()


@pytest.fixture(scope="module")
def plan(sample, categories) -> dl.Plan:
    return dl.build_plan(dl.read_library(sample), dl.read_categories(categories))


def by_type(plan: dl.Plan) -> dict[str, dict]:
    return {t.type_id: t.payload for t in plan.types}


def codes(payload: dict) -> list[tuple[str, int, bool]]:
    return [(c["code"], c["qty"], c["single_row"]) for c in (payload["default_cables"] or [])]


def mapping_xlsx(rows: list[tuple[str, str, str]], overrides=()) -> bytes:
    """A small mapping workbook in the fixture's layout."""
    wb = Workbook()
    ws = wb.active
    ws.title = dl.CATEGORIES_TAB
    ws.append(["DaVinci family", "DaVinci category", "Products", "Suggested", "Our category"])
    for fam, cat, ours in rows:
        ws.append([fam, cat, 1, "", ours])
    ts = wb.create_sheet(dl.TYPES_TAB)
    ts.append(
        ["DaVinci family", "DaVinci category", "Display name", "Model", "Override (optional)"]
    )
    for fam, cat, name, ov in overrides:
        ts.append([fam, cat, name, "", ov])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ------------------------------------------------------------- the mapping


@needs_categories
def test_the_mapping_sheet_parses_with_every_row_assigned(categories):
    m = dl.read_categories(categories)
    assert len(m.rows) == 155 and m.unassigned == [] and m.overrides == {}
    assert m.categories == ELEVEN  # D196's eleven, spelled as the sheet spells them
    assert sum(1 for v in m.rows.values() if v == dl.IGNORE) == 103
    assert m.rows[("Paradigm", "Controllers")] == "Equipment"
    assert m.rows[("Emergency Lighting Control", "Emergency Bypass Detection Kit")] == (
        "Emergency Equipment"
    )
    assert m.rows[("Paradigm", "Accessories")] == dl.IGNORE


def test_overrides_and_unassigned_rows():
    data = mapping_xlsx(
        [("Paradigm", "Controllers", "Equipment"), ("Paradigm", "Accessories", "")],
        overrides=[("Paradigm", "Controllers", "NSPS", "Ignore")],
    )
    m = dl.read_categories(data)
    assert m.rows == {("Paradigm", "Controllers"): "Equipment"}
    assert m.unassigned == [("Paradigm", "Accessories")]
    assert m.overrides == {("Paradigm", "Controllers", "NSPS"): "Ignore"}
    with pytest.raises(dl.LibraryError):
        dl.read_categories(b"not a workbook")
    with pytest.raises(dl.LibraryError):
        dl.read_library(b"{}")


# ------------------------------------------------------------- the library


@needs_sample
def test_read_library_resolves_models_ports_slots_and_scripts(sample):
    lib = dl.read_library(sample)
    assert lib.timestamp == "2026-10-13T18:57:47.923Z" and len(lib.order) == 37
    uh = lib.types[UH10002]
    assert uh.model_pattern == "UH10002-{Heritage Color with TBD}" and uh.model == "UH10002"
    # power supplies (D198): by property + name (NSPS), by script (P-SPM-E), by description
    # (the ERn2 upgrade kit); not a relay panel with "Power Supply - Units", not the EBDK
    assert lib.types[NSPS].is_power_supply and lib.types[LVD].is_power_supply is False
    assert lib.types["77d22bee-a1bf-4023-a0a2-63869f002b40"].is_power_supply  # P-SPM-E
    assert lib.types["16a5dbc1-c0d3-4d02-bb79-8ee7717a5b5f"].is_power_supply  # ERn2-W-UPG
    assert not lib.types[ERP24].is_power_supply and not lib.types[EBDK].is_power_supply
    assert uh.variants[:2] == ("UH10002-X", "UH10002-3") and uh.part_numbers == ("7181B2005",)
    assert uh.family == "Paradigm" and uh.category == "Heritage Stations"
    assert [p.protocol for p in uh.ports] == ["LinkConnect"]
    forced = next(s for s in uh.slots if s.type_id == FACEPLATE)
    assert forced.user_definable is False and forced.max_quantity == 1
    ts7 = lib.types[TS7]
    assert ts7.model == "P-TS7-E" and ts7.classification == "Product"
    assert [g.label for g in ts7.groups] == ["backbox accessory"]
    assert ts7.groups[0].min_count == 1 and ts7.groups[0].max_count == 1
    assert "IP Address" in ts7.properties
    assert (
        ts7.datasheet_url == "https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737479944"
    )
    ern = lib.types[ERN2]
    assert [(g.label, g.min_count, g.max_count) for g in ern.groups] == [
        ("ERn Modules", 2, 2),
        ("ERn Accessories", 0, 1),
    ]
    assert dl._strip_pattern("97{Gridiron Junction Box Large}") == "97"
    assert dl._strip_pattern("{Gridiron Junction LV}") == ""


# ----------------------------------------------------------------- the plan


@needs_sample
@needs_categories
def test_plan_categories_cables_and_neuron_ids(plan):
    p = by_type(plan)
    assert plan.stats["placeable"] == 8 and plan.stats["accessory_only"] == 29
    assert plan.stats["by_category"] == {
        "Emergency Equipment": 1,
        "Equipment": 3,
        "Power Distribution": 1,
        "Sensor": 1,
        "Station": 1,
        "Touchscreen": 1,
    }
    nsps = p[NSPS]
    assert nsps["model"] == "P-NSPS-D" and nsps["category"] == "Equipment"
    assert nsps["aliases"] == ["NSPS", "7182A1711"]
    # Ethernet → N off a station; 48 V aux → UV (D199); a power supply needs its 120 V feed (D198)
    assert codes(nsps) == [("U", 1, False), ("N", 1, False), ("UV", 1, False), ("120V", 1, True)]
    assert nsps["needs_neuron_id"] is True  # IP / subnet / gateway properties
    assert nsps["description"] == "Paradigm Network Station Power Supply"
    assert nsps["datasheet_url"].startswith("https://www.etcconnect.com/")
    assert nsps["accessory_only"] is None and nsps["optional_accessories"] is None
    ref = nsps["source_ref"]
    assert ref["kind"] == "davinci" and ref["type_id"] == NSPS and ref["mapped_to"] == "Equipment"
    assert ref["family"] == "Paradigm" and ref["category"] == "Controllers"
    assert ref["power_supply"] == {"self": True, "accessories": []}
    assert {"protocol": "48vdc Auxiliary Power", "direction": "Bus", "count": 1} in ref["ports"]

    ebdk = p[EBDK]
    assert ebdk["category"] == "Emergency Equipment" and ebdk["aliases"] == ["7180A1200"]
    # three panic buses in one row; the Sense wire is 120V (D199)
    assert codes(ebdk) == [("120V", 1, True), ("P", 3, True)]
    assert ebdk["needs_neuron_id"] is None

    uhci = p[UHCI]
    # Unison bus, aux power in → UV (D199)
    assert uhci["category"] == "Sensor" and codes(uhci) == [("U", 1, False), ("UV", 1, False)]
    assert uhci["aliases"] == ["Wall-Mount Contact Interface", "7181A1022"]

    ts7 = p[TS7]
    assert ts7["category"] == "Touchscreen" and codes(ts7) == [("NG", 1, False)]
    assert ts7["model"] == "P-TS7-E" and "P-TS7-E-4" in ts7["aliases"]
    assert ts7["needs_neuron_id"] is True

    uh = p[UH10002]
    assert uh["category"] == "Station" and uh["model"] == "UH10002"
    assert uh["aliases"][:3] == ["2-Button Heritage Station", "7181B2005", "UH10002-X"]
    assert codes(uh) == [("U", 1, False)]

    erp = p[ERP24]
    assert erp["category"] == "Power Distribution" and erp["model"] == "ERP Feedthrough 24"
    # its 24 Power Output ports are load circuits, not cables; the panel's feed is by others;
    # EchoConnect is a Unison-style bus → U (D199)
    assert codes(erp) == [
        ("N", 1, False),
        ("X", 1, False),
        ("X", 1, False),
        ("U", 1, False),
        ("P", 1, True),
    ]
    # the DALI option kit: 24 loops as one D row (D199)
    dali = next(t for t in plan.types if t.payload["model"] == "ERP-FT-DALI")
    assert codes(dali.payload) == [("D", 24, True)]
    assert "power_supply" not in erp["source_ref"]
    # the ERn2 enclosure has no mapped port, but carries power-supply modules → a 120V feed
    ern = p[ERN2]
    assert codes(ern) == [("120V", 1, True)]
    assert ern["source_ref"]["power_supply"] == {
        "self": False,
        "accessories": ["P-SPM-E", "ERn2-W-UPG"],
    }
    # NSPS, NSPS-KIT, ERn2 (by its modules), P-SPM-E and the upgrade kit; the ERP's 24 outputs
    assert plan.stats["power_supplies"] == 5 and plan.stats["load_outputs"] == 24
    # protocols Landry ruled not surveyed (D200): no row, no draft, counted
    assert plan.not_surveyed_protocols["Contact"] == 4
    assert plan.not_surveyed_protocols["EBDK Switch"] == 1
    assert plan.unmapped_protocols == {}  # every protocol in the sample has a ruling
    assert "Sense" not in plan.not_surveyed_protocols


@needs_sample
@needs_categories
def test_plan_accessories_and_expected_quantities(plan):
    p = by_type(plan)
    ern = {a["model"]: a for a in p[ERN2]["optional_accessories"]}
    assert ern["P-ACP-E Mk2"] == {
        "model": "P-ACP-E Mk2",
        "expected_qty": 1,  # userDefinable = false: forced
        "max_quantity": 1,
        "group": {"label": "ERn Modules", "min": 2, "max": 2},
    }
    assert ern["ERn-BM"]["expected_qty"] is None and ern["ERn-BM"]["group"]["min"] == 2
    assert ern["ERn-Net"]["group"] == {"label": "ERn Accessories", "min": 0, "max": 1}
    assert "group" not in ern["URTO Mk2"]
    ts7 = {a["model"]: a for a in p[TS7]["optional_accessories"]}
    boxes = [m for m, a in ts7.items() if a.get("group", {}).get("label") == "backbox accessory"]
    assert sorted(boxes) == ["P-LCD-FBB", "P-LCD-SBB", "P-LCD-SBB-5", "P-LCD-SLBB"]
    assert all(ts7[m]["group"] == {"label": "backbox accessory", "min": 1, "max": 1} for m in boxes)
    assert all(ts7[m]["expected_qty"] is None for m in boxes)
    uh = {a["model"]: a for a in p[UH10002]["optional_accessories"]}
    assert uh["Heritage 2 Button Faceplate"]["expected_qty"] == 1
    assert uh["SBB1"] == {"model": "SBB1", "expected_qty": None, "max_quantity": 1}
    uhci = {a["model"]: a["max_quantity"] for a in p[UHCI]["optional_accessories"]}
    assert uhci == {"AD-ST18A": 16, "AD-C18E-00-2A": 8, "AD-C18R-0P-2A": 8}

    # accessories of kept types are imported from Ignore rows, as accessories only
    lvd = p[LVD]
    assert lvd["accessory_only"] is True and lvd["category"] is None
    assert lvd["model"] == "ERP-FT-LVD" and codes(lvd) == [("0-10V", 24, True)]
    assert lvd["aliases"] == ["0-10V Option Kit - FT (24 CH)", "7123K1204"]
    assert p[FACEPLATE]["accessory_only"] is True
    # the faceplate's stripped model is the station's: it takes its display name instead
    assert p[FACEPLATE]["model"] == "Heritage 2 Button Faceplate"
    assert plan.stats["renamed"] == [
        {"type_id": FACEPLATE, "model": "UH10002", "as": "Heritage 2 Button Faceplate"}
    ]
    # models and aliases are unique across the plan (spaces and case ignored)
    seen: set[str] = set()
    for t in plan.types:
        for name in (t.payload["model"], *(t.payload["aliases"] or [])):
            assert dl.model_key(name) not in seen, name
            seen.add(dl.model_key(name))


@needs_sample
def test_plan_with_overrides_and_reserved_models(sample):
    lib = dl.read_library(sample)
    m = dl.read_categories(
        mapping_xlsx(
            [
                ("Paradigm", "Controllers", "Equipment"),
                ("Paradigm", "Touchscreen Stations", "Touchscreen"),
            ],
            overrides=[("Paradigm", "Controllers", "NSPS", "Ignore")],
        )
    )
    # the override drops P-NSPS-D; an unlisted family / category pair is ignored and reported
    plan = dl.build_plan(lib, m, reserved={dl.model_key("P-TS7-E"): None})
    p = by_type(plan)
    assert NSPS not in p and "1d37a7d1-f519-4710-8a37-46930085cff6" in p  # the kit stays
    assert (
        "Emergency Lighting Control / Emergency Bypass Detection Kit"
        in (plan.stats["rows_not_in_mapping"])
    )
    # a protocol nobody has ruled on (a newer library) still becomes a draft candidate
    kit = lib.types["1d37a7d1-f519-4710-8a37-46930085cff6"]  # the NSPS kit is kept here
    kit.ports = (*kit.ports, dl.Port("Telepathy", "Bus", ""))
    plan2 = dl.build_plan(lib, m)
    assert plan2.unmapped_protocols == {"Telepathy": 1}
    # a hand-made type holds P-TS7-E: the DaVinci type is a clash, left out and reported
    assert TS7 not in p
    assert plan.stats["clashes"] == [{"type_id": TS7, "model": "P-TS7-E", "held_by": None}]
    # its accessories are still imported (the rack-mount kit's back boxes are its own slots)
    assert "eafb8d33-b707-491b-ad1a-3e97961cc9d3" in p  # P-LCD-FBB


# ------------------------------------------------------------------ the job


def _project(session) -> uuid.UUID:
    out = projects.create_project(
        session,
        projects.ProjectIn(name="Tower", levels=[projects.LevelIn(level="06M")]),
        upsert_user(session, "Landry"),
    )
    return uuid.UUID(out.id)


def _run(session, store, factory, project_id, library, categories, name="library.json"):
    batch = dl.create_davinci_batch(
        session,
        store,
        project_id=project_id,
        library=(name, library),
        categories=("DaVinci_categories.xlsx", categories) if categories else None,
        user=upsert_user(session, "Landry"),
    )
    state = runner.run_batch(factory, store, batch.id, job=dl.import_davinci)
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state, batch.stats
    return batch


def _app_types(session) -> dict[str, LibraryType]:
    rows = session.scalars(
        select(LibraryType).where(
            LibraryType.project_id.is_(None), LibraryType.deleted_at.is_(None)
        )
    ).all()
    return {r.source_ref["type_id"]: r for r in rows if r.source_ref}


@needs_sample
@needs_categories
def test_job_writes_app_library_drafts_and_vocab_drafts(
    session, store, factory, sample, categories
):
    pid = _project(session)
    batch = _run(session, store, factory, pid, sample, categories)
    assert batch.job_state == "done", batch.stats
    s = batch.stats
    assert s["created"] == 37 and s["updated"] == 0 and s["clashes"] == []
    assert s["placeable"] == 8 and s["accessory_only"] == 29 and s["vocab_drafts"] == 0
    assert s["library_timestamp"] == "2026-10-13T18:57:47.923Z"
    assert s["categories_file"] == "DaVinci_categories.xlsx" and s["categories_reused_from"] is None
    types = _app_types(session)
    assert len(types) == 37 and all(
        t.state == "draft" and t.project_id is None for t in types.values()
    )
    nsps = types[NSPS]
    assert nsps.model == "P-NSPS-D" and nsps.category == "Equipment"
    assert nsps.needs_neuron_id is True and nsps.accessory_only is None
    assert nsps.description == "Paradigm Network Station Power Supply"
    assert [c["code"] for c in nsps.default_cables] == ["U", "N", "UV", "120V"]
    assert types[LVD].accessory_only is True and types[LVD].category is None
    assert types[ERN2].optional_accessories[4]["group"]["min"] == 2
    # the ops are in the app library's log, so every iPad pulls them
    ops = session.scalars(select(Op).where(Op.entity_kind == "library_type")).all()
    assert len(ops) == 37 and all(o.project_id is None and o.kind == "create" for o in ops)
    assert all(o.reason == "DaVinci library import" and o.state == "applied" for o in ops)
    # the unmapped protocols are vocab(cable_code) drafts in the uploading project
    vocab = session.scalars(
        select(Vocab).where(Vocab.project_id == pid, Vocab.list == "cable_code")
    ).all()
    assert vocab == []  # Contact and EBDK Switch are not surveyed (D200): no draft
    assert s["not_surveyed_protocols"] == {"Contact": 4, "EBDK Switch": 1}
    # the same pair of files again is skipped
    again = _run(session, store, factory, pid, sample, categories)
    assert again.job_state == "skipped" and again.stats["earlier_batch"] == str(batch.id)


@needs_sample
@needs_categories
def test_rerun_updates_drafts_by_type_id_and_leaves_accepted_types(
    session, store, factory, sample, categories
):
    pid = _project(session)
    first = _run(session, store, factory, pid, sample, categories)
    assert first.job_state == "done", first.stats
    types = _app_types(session)
    # Landry accepts the NSPS (with her own edits) and rejects the EBDK
    types[NSPS].state = "accepted"
    types[NSPS].aliases = ["NSPS", "7182A1711", "P-NSPS-D-DIN"]
    types[EBDK].state = "rejected"
    session.commit()
    # a newer library: the touchscreen's description changed, the NSPS's too, a type is new
    doc = json.loads(sample)
    doc["timestamp"] = "2026-11-01T00:00:00.000Z"
    for t in doc["types"]:
        if t["typeId"] == TS7:
            t["typeInformation"]["description"] = 'Paradigm 7" Wall-mount Touchscreen (Mk2)'
        if t["typeId"] == NSPS:
            t["typeInformation"]["description"] = "changed"
    new = json.loads(json.dumps(next(t for t in doc["types"] if t["typeId"] == EBDK)))
    new["typeId"] = str(uuid7())
    new["typeInformation"]["displayName"] = "EBDK-2"
    new["modelInformation"]["generatorData"]["items"] = [{"type": "string", "value": "EBDK-2"}]
    new["partInformation"]["generatorData"]["lookupData"] = []
    doc["types"].append(new)
    second = _run(
        session, store, factory, pid, json.dumps(doc).encode(), None, name="library2.json"
    )
    assert second.job_state == "done", second.stats
    s = second.stats
    assert s["categories_reused_from"] == str(first.id)  # the mapping was not uploaded again
    assert s["created"] == 1 and s["kept_accepted"] == 1 and s["kept_rejected"] == 1
    # every draft's source_ref carries the new timestamp, so all 35 drafts are "updated"
    assert s["updated"] == 35 and s["unchanged"] == 0
    assert s["vocab_drafts"] == 0
    session.expire_all()
    types = _app_types(session)
    assert types[TS7].description == 'Paradigm 7" Wall-mount Touchscreen (Mk2)'
    assert types[TS7].state == "draft" and types[TS7].source_ref["library_timestamp"].startswith(
        "2026-11"
    )
    assert types[NSPS].description == "Paradigm Network Station Power Supply"  # accepted: untouched
    assert types[NSPS].aliases == ["NSPS", "7182A1711", "P-NSPS-D-DIN"]
    assert types[EBDK].state == "rejected" and types[new["typeId"]].model == "EBDK-2"
    sets = session.scalars(
        select(Op).where(
            Op.entity_kind == "library_type", Op.kind == "set", Op.entity_id == types[TS7].id
        )
    ).all()
    assert {o.field for o in sets} == {"description", "source_ref"}
    assert all(o.base_op_id is not None and o.state == "applied" for o in sets)


@needs_sample
@needs_categories
def test_a_hand_made_model_is_a_clash_never_overwritten(
    session, store, factory, sample, categories
):
    pid = _project(session)
    hand = LibraryType(
        id=uuid7(), project_id=None, model="p-nsps-d", category="NSPS", state="accepted"
    )
    session.add(hand)
    session.commit()
    batch = _run(session, store, factory, pid, sample, categories)
    assert batch.job_state == "done", batch.stats
    assert batch.stats["created"] == 36
    assert batch.stats["clashes"] == [{"type_id": NSPS, "model": "P-NSPS-D", "held_by": None}]
    session.expire_all()
    assert session.get(LibraryType, hand.id).model == "p-nsps-d"
    assert NSPS not in _app_types(session)


@needs_sample
@needs_categories
def test_retire_hand_made_types_soft_deletes_them_first(
    session, store, factory, sample, categories
):
    """D199: with `retire_hand_made` the hand-made app-library types are soft-deleted (history
    keeps them), so the catalogue's types take their place; project copies stay."""
    pid = _project(session)
    hand = LibraryType(
        id=uuid7(), project_id=None, model="P-NSPS-D", category="NSPS", state="accepted"
    )
    other = LibraryType(id=uuid7(), project_id=None, model="Hand-made", state="draft")
    copy = LibraryType(
        id=uuid7(), project_id=pid, model="P-NSPS-D", category="NSPS", state="accepted"
    )
    session.add_all([hand, other, copy])
    session.commit()
    batch = dl.create_davinci_batch(
        session,
        store,
        project_id=pid,
        library=("library.json", sample),
        categories=("DaVinci_categories.xlsx", categories),
        user=upsert_user(session, "Landry"),
        retire_hand_made=True,
    )
    assert batch.files[0]["retire_hand_made"] is True
    state = runner.run_batch(factory, store, batch.id, job=dl.import_davinci)
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state == "done", batch.stats
    assert sorted(batch.stats["retired"]) == ["Hand-made", "P-NSPS-D"]
    assert batch.stats["created"] == 37 and batch.stats["clashes"] == []
    assert session.get(LibraryType, hand.id).deleted_at is not None
    assert session.get(LibraryType, other.id).deleted_at is not None
    assert session.get(LibraryType, copy.id).deleted_at is None  # the project's copy stays
    assert _app_types(session)[NSPS].model == "P-NSPS-D"
    deletes = session.scalars(
        select(Op).where(Op.entity_kind == "library_type", Op.kind == "delete")
    ).all()
    assert len(deletes) == 2 and all(o.project_id is None for o in deletes)
    assert all(o.reason == "Replaced by the DaVinci library import" for o in deletes)
    # a second run with the flag retires nothing more (only DaVinci types are left)
    again = _run(session, store, factory, pid, sample, categories)
    assert again.job_state == "skipped"


@needs_sample
@needs_categories
def test_imports_route_takes_the_library_and_the_mapping(
    client, session, store, sample, categories
):
    pid = _project(session)
    r = client.post(
        "/imports",
        data={"project_id": str(pid), "kind": "davinci"},
        files={"file": ("library.json", sample, "application/json")},
        headers=ANN,
    )
    assert r.status_code == 422 and "no category mapping" in r.text
    r = client.post(
        "/imports",
        data={"project_id": str(pid), "kind": "davinci"},
        files={
            "file": ("library.json", sample, "application/json"),
            "categories": ("DaVinci_categories.xlsx", categories, runner.XLSX_MIME),
        },
        headers=ANN,
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["kind"] == "davinci" and body["job_state"] == "queued"
    assert [f["role"] for f in body["files"]] == ["library", "categories"]
    assert all("key" not in f for f in body["files"])
    # the next upload needs the library only
    r = client.post(
        "/imports",
        data={"project_id": str(pid), "kind": "davinci"},
        files={"file": ("library.json", sample, "application/json")},
        headers=ANN,
    )
    assert r.status_code == 202, r.text
    assert r.json()["files"][1]["reused_from"] == body["id"]
    # not a library
    r = client.post(
        "/imports",
        data={"project_id": str(pid), "kind": "davinci"},
        files={"file": ("x.json", b'{"types": "no"}', "application/json")},
        headers=ANN,
    )
    assert r.status_code == 422 and "not a DaVinci library" in r.text
    assert r.status_code == 422
    listed = client.get("/imports", params={"project_id": str(pid)}, headers=ANN).json()
    assert [b["kind"] for b in listed] == ["davinci", "davinci"]
