"""Workbook seed import (T27, PLAN §7.5): the master fixture end to end, a synthetic workbook
for the edge cases, the `/imports` routes, and the trusted-push numbering rules."""

import uuid
from datetime import date
from pathlib import Path

import openpyxl
import pytest
from conftest import HDR, SERVER_DIR
from sqlalchemy import func, select

from app import materialise, projects
from app.auth import system_user, upsert_user
from app.ids import uuid7
from app.jobs import runner, seed_import
from app.jobs.workbook import read_workbook
from app.models import (
    Blob,
    Cable,
    CableEnd,
    Device,
    Finding,
    ImportBatch,
    Level,
    MissingPart,
    NumberingGroup,
    Op,
    PartSource,
    Photo,
    PhotoLink,
    Placeholder,
    PunchItem,
    ReviewItem,
    Ruling,
)

FIXTURE = SERVER_DIR.parent / "fixtures" / "Lighting_Control_Survey_Master_B2-06_4.xlsx"
needs_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason=f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)"
)


def new_project(session, name="Tower") -> uuid.UUID:
    """A project with no levels (the import adds them), made as `POST /projects` would (T41)."""
    out = projects.create_project(
        session, projects.ProjectIn(name=name), upsert_user(session, "Landry")
    )
    return uuid.UUID(out.id)


def import_file(session, store, factory, path: Path, project_id=None, user_name="Landry"):
    """Create a project (unless given), queue the file and run it; returns (project_id, batch)."""
    if project_id is None:
        project_id = new_project(session, "Tower")
    user = upsert_user(session, user_name)
    batch = runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind="master_xlsx",
        filename=path.name,
        data=path.read_bytes(),
        user=user,
    )
    state = runner.run_batch(factory, store, batch.id)
    session.expire_all()
    batch = session.get(ImportBatch, batch.id)
    assert state == batch.job_state, batch.stats
    return project_id, batch


class View:
    """Lookups over the imported project."""

    def __init__(self, session, project_id):
        self.s = session
        self.project_id = project_id
        self.levels = {
            lv.level: lv
            for lv in session.scalars(select(Level).where(Level.project_id == project_id))
        }

    def device(self, display_id) -> Device | None:
        return self.s.scalars(
            select(Device)
            .join(Level)
            .where(Level.project_id == self.project_id, Device.display_id == display_id)
        ).first()

    def end(self, code, display_id) -> CableEnd:
        e = self.s.scalars(
            select(CableEnd).where(
                CableEnd.level_id == self.levels[code].id, CableEnd.display_id == display_id
            )
        ).first()
        assert e is not None, (code, display_id)
        return e

    def other_end(self, e: CableEnd) -> CableEnd:
        o = self.s.scalars(
            select(CableEnd).where(CableEnd.cable_id == e.cable_id, CableEnd.id != e.id)
        ).first()
        assert o is not None
        return o

    def punch(self, code, n) -> PunchItem:
        group = self.levels[code].numbering_group_id
        p = self.s.scalars(
            select(PunchItem)
            .join(Level)
            .where(Level.numbering_group_id == group, PunchItem.number == n)
        ).first()
        assert p is not None, (code, n)
        return p

    def part(self, code, n) -> MissingPart:
        group = self.levels[code].numbering_group_id
        p = self.s.scalars(
            select(MissingPart)
            .join(Level)
            .where(Level.numbering_group_id == group, MissingPart.number == n)
        ).first()
        assert p is not None, (code, n)
        return p

    def photo(self, code, n) -> Photo:
        group = self.levels[code].numbering_group_id
        p = self.s.scalars(
            select(Photo).join(Level).where(Level.numbering_group_id == group, Photo.number == n)
        ).first()
        assert p is not None, (code, n)
        return p

    def placeholder(self, label) -> Placeholder | None:
        return self.s.scalars(
            select(Placeholder).where(
                Placeholder.project_id == self.project_id, Placeholder.label == label
            )
        ).first()

    def group(self, code) -> NumberingGroup:
        return self.s.get(NumberingGroup, self.levels[code].numbering_group_id)

    def count(self, model, *where) -> int:
        q = select(func.count()).select_from(model)
        if model is CableEnd:  # far ends have no level: count through the cable
            q = q.join(Cable, Cable.id == CableEnd.cable_id).where(
                Cable.project_id == self.project_id
            )
        elif model in (Device, PunchItem, MissingPart, Photo):
            q = q.join(Level, Level.id == model.level_id).where(Level.project_id == self.project_id)
        elif hasattr(model, "project_id"):
            q = q.where(model.project_id == self.project_id)
        return self.s.scalar(q.where(*where))

    def reviews(self, kind) -> list[ReviewItem]:
        return list(
            self.s.scalars(
                select(ReviewItem).where(
                    ReviewItem.project_id == self.project_id, ReviewItem.kind == kind
                )
            )
        )

    def pair_of(self, code, display_id) -> tuple[str, str] | None:
        """(level, C-nn) of the numbered end sharing a cable with this one, if any."""
        o = self.other_end(self.end(code, display_id))
        if o.display_id is None:
            return None
        lv = self.s.get(Level, o.level_id)
        return (lv.level, o.display_id)


# ------------------------------------------------------------- the master


@needs_fixture
def test_master_seed_import(session, store, factory, client):
    project_id, batch = import_file(session, store, factory, FIXTURE)
    assert batch.job_state == "done", batch.stats
    stats = batch.stats
    v = View(session, project_id)

    # --- the DoD counts
    assert v.count(Device) == 210
    assert v.count(CableEnd, CableEnd.display_id.is_not(None)) == 107
    assert v.count(PunchItem) == 215
    assert v.count(MissingPart) == 85
    assert v.count(Photo) == 76
    history = list(
        session.scalars(
            select(Op).where(
                Op.project_id == project_id,
                Op.install_id == seed_import.IMPORT_INSTALL_ID,
                Op.state == "superseded",
            )
        )
    )
    assert len(history) == 375
    assert stats["historical_ops"] == 375 and stats["devices"] == 210
    import_user = system_user(session, "import")
    assert all(h.user_id == import_user.id for h in history)
    assert {h.change_type for h in history} == {
        "Field survey",
        "Reconcile",
        "Ruling",
        "Riser cross-check",
        "Master edit",
        "MSS ruling",
        "Correction",
    }
    # a Change Log row lands on its record with the master's names in the payload
    dev = v.device("01-01")
    h = [o for o in history if o.entity_id == dev.id]
    assert any(o.field == "notes" and o.change_type == "MSS ruling" for o in h)
    assert any(o.field == "Photo" and o.now == "14" for o in h)  # no column: master name kept
    assert all(o.payload["sheet"] == "Devices" and o.payload["ref"] == "01-01" for o in h)
    # ranges (`#2-#27`) hang off the level
    assert stats["history_on_level"] == 2
    # historical ops are never materialised: the device keeps the master's current Notes
    assert dev.notes.startswith("Missing 1x ERP-RTO jumper") and "MSS 10/1" not in dev.notes
    # `(row added)` rows are historical creates
    added = [o for o in history if o.kind == "create"]
    assert len(added) == 22 and all(o.field is None for o in added)

    # --- levels from the Summary (T02 follow-up: ISO text dates)
    assert [lv.level for lv in sorted(v.levels.values(), key=lambda lv: lv.floor_order)] == [
        "B2",
        "B1",
        "01",
        "02",
        "03",
        "04",
        "06",
        "06M",
    ]
    assert v.levels["B2"].surveyed == date(2026, 10, 9) and v.levels["B2"].updated is None
    assert v.levels["01"].updated == date(2026, 10, 8)
    assert v.levels["06"].numbering_group_id == v.levels["06M"].numbering_group_id  # D33
    assert v.levels["01"].numbering_group_id != v.levels["02"].numbering_group_id
    assert all(lv.state == "setup" for lv in v.levels.values())

    # --- counters follow the master's numbers (PLAN §7.5 "set to max per tab")
    g = v.group("06M")
    assert (g.counter_punch, g.counter_part, g.counter_photo, g.counter_cable) == (18, 15, 6, 25)
    g = v.group("B2")
    assert (g.counter_punch, g.counter_part, g.counter_photo, g.counter_cable) == (9, 3, 4, 8)
    g = v.group("01")
    assert (g.counter_punch, g.counter_part, g.counter_photo, g.counter_cable) == (53, 20, 15, 25)

    # --- devices
    d = v.device("B2-01")
    assert (d.category, d.device, d.panel_name, d.status, d.origin) == (
        "Relay panel",
        "CTB2LCPB",
        "CTB2LCPB",
        "Issue",
        "import",
    )
    assert v.device("B2-02").panel_name == "CTB2LCPB"  # EBDK: panel from its Type
    assert v.device("06M-04").category == "Foundry panel"
    assert v.count(Device, Device.status.is_(None)) == 0
    # every value in the master is in its list: the only lint items are D148's unlinked punch rows
    assert {r.subject["lint_id"] for r in v.reviews("lint")} == {seed_import.PUNCH_DEVICE_LINT}

    # --- connections: single-row cables
    a = v.end("B2", "C-02")  # 0-10V
    cable = session.get(Cable, a.cable_id)
    assert cable.single_row and cable.cable == "0-10V" and cable.qty == 1
    assert a.device_id == v.device("B2-01").id and a.to_text == "Fixtures"
    b = v.other_end(a)
    assert b.display_id is None and b.placeholder_id == v.placeholder("Fixtures").id
    p = v.end("B2", "C-03")  # P → the panel's EBDK, never numbered
    pb = v.other_end(p)
    assert (
        pb.device_id == v.device("B2-02").id and pb.display_id is None and pb.level_id == p.level_id
    )
    pw = v.end(
        "B2", "C-04"
    )  # 120V: the row's endpoint is the NSPS, the far end the power placeholder
    assert pw.device_id == v.device("B2-03").id and pw.from_text == "120v Power"
    assert v.other_end(pw).placeholder_id == v.placeholder("120v Power").id
    # --- connections: pairs by level cross-reference and labels
    assert v.pair_of("B2", "C-01") == ("B1", "C-02")
    assert v.pair_of("01", "C-02") == ("01", "C-18")
    assert v.pair_of("01", "C-06") == ("01", "C-19")
    assert v.pair_of("04", "C-07") == ("06M", "C-18")
    assert v.pair_of("04", "C-01") == ("06M", "C-13")
    assert v.pair_of("B2", "C-06") == ("B1", "C-05")
    assert v.pair_of("06", "C-10") == ("06M", "C-15")
    assert v.pair_of("01", "C-15") == ("06M", "C-06")
    assert v.pair_of("03", "C-10") == ("04", "C-02")
    assert v.pair_of("02", "C-09") == ("02", "C-13")
    assert v.pair_of("01", "C-01") == ("02", "C-11")
    e = v.end("B2", "C-01")
    assert e.side == "A" and v.other_end(e).side == "B"  # lower floor is side A
    assert session.get(Cable, e.cable_id).endpoint_confirmed is False  # D6: reviewer confirms
    # the bus rows: endpoint is the placeholder, text renamed by the D50 ruling
    bus = v.end("B2", "C-07")
    assert bus.placeholder_id == v.placeholder("Stations & Sensors").id
    assert bus.from_text == "Stations & Sensors"
    renamed = session.scalars(
        select(CableEnd)
        .join(Level)
        .where(Level.project_id == project_id, CableEnd.from_text == "Stations & Sensors")
    ).all()
    assert len(renamed) == 7
    ruling = session.scalars(select(Ruling).where(Ruling.project_id == project_id)).one()
    assert ruling.op_count == 7 and ruling.standing
    assert sorted(ruling.filter["values"]) == [
        "PI1002 & P-DOC-C-LR stations",
        "Station & sensor",
        "Stations & sensor",
        "Stations & sensors",
    ]
    ruling_ops = session.scalars(
        select(Op).where(Op.ruling_id == ruling.id, Op.change_type == "Ruling")
    ).all()
    assert len(ruling_ops) == 7 and {o.was for o in ruling_ops} == set(ruling.filter["values"])
    # --- connections: far ends the To text names, no review needed
    far = v.other_end(v.end("06M", "C-20"))
    assert far.placeholder_id == v.placeholder("Level 09").id and far.display_id is None
    assert v.other_end(v.end("06M", "C-04")).placeholder_id == v.placeholder("Level 16").id
    assert (
        v.other_end(v.end("01", "C-13")).placeholder_id
        == v.placeholder("Walter Tower ETC P-CCS").id
    )
    assert v.other_end(v.end("01", "C-09")).placeholder_id == v.placeholder("B3A Canyon").id
    assert (
        v.other_end(v.end("03", "C-13")).placeholder_id
        == v.placeholder("Missing DMX run (one per UFMP4)").id
    )
    # --- connections: ambiguous and unpaired ends → import_pair review items with candidates
    pairs = v.reviews("import_pair")
    by_end = {uuid.UUID(r.subject["entity_id"]): r for r in pairs}
    amb = by_end[v.end("02", "C-01").id]
    assert {(c["level"], c["display_id"]) for c in amb.candidates} == {
        ("03", "C-02"),
        ("03", "C-07"),
    }
    assert all(0.4 <= c["confidence"] < 0.8 for c in amb.candidates)
    assert v.other_end(v.end("02", "C-01")).endpoint_kind is None
    lone = by_end[v.end("03", "C-05").id]
    assert lone.candidates == []
    assert v.pair_of("06M", "C-12") == ("06M", "C-14")
    assert stats["pairs"] == 27 and stats["unpaired_ends"] == len(pairs) == 8
    assert stats["cables"] == 107 - 27 == 80
    # every cable has two ends: 28 single-row + 17 placeholder + 8 unresolved far ends
    assert stats["far_ends"] == 53 and v.count(CableEnd) == 107 + 53
    assert v.count(Finding, Finding.lint_id == "import.endpoint") == 4  # `UFMP4 #1, #2` labels

    # --- punch list
    assert v.punch("B2", 3).device_id == v.device("B2-03").id
    assert v.punch("01", 18).device_id == v.device("01-S2").id
    assert v.punch("01", 12).device_id == v.device("01-08").id  # `UFMP4 - BH OBS RM 47` by room
    assert v.punch("01", 12).device_text == "UFMP4 - BH OBS RM 47"  # kept verbatim (D136)
    assert v.punch("B1", 6).device_id == v.device("B1-02").id  # `EBDK (CTB1LCPB)`
    assert v.punch("06", 13).device_id == v.device("06-S2").id  # `PI1002 #2 � Corridor…`
    assert v.punch("03", 11).device_id == v.device("03-07").id  # `UFMP4 #2`
    neuron = v.punch("B2", 9)
    assert neuron.sort_last and neuron.device_id is None and neuron.type == "Information"
    assert v.count(PunchItem, PunchItem.sort_last.is_(True)) == 7  # one per numbering group
    closed = v.punch("01", 2)
    assert closed.tracking_status == "Closed" and closed.date_closed == date(2026, 10, 8)
    assert v.punch("04", 22).device_id is None  # a room, not a device
    # D148: every row linked to no device waits on Needs review with the master's text, the
    # Neuron ID rows (one per group, D49) left out
    unlinked = {
        (r.subject["level_id"], r.subject["entity_id"]): r.candidates[0]["value"]
        for r in v.reviews("lint")
        if r.subject["lint_id"] == seed_import.PUNCH_DEVICE_LINT
    }
    assert sorted(unlinked.values()) == [
        "Conf XX04-3108A/B",
        "Elec XX04-1E01",
        "Elec XX04-1E01",
        "PI1002 S15, S16 - Corridor XX03-C014",
        "PI1002 stations",
        "PI1004 S18, PI1104 S20",
        "PI1104 S3, P-DOC-SM2 D6, P-LS D7",
        "PI1104 S8-S12 - BH OBS passageway",
        "Stations & sensors",
        "Stations & sensors",
        "Stations & sensors",
        "UFMP4 #1, #2",
        "Walter Tower east wing",
    ]
    assert len(unlinked) == stats["punch_device_unmatched"] == 13
    assert (str(v.levels["04"].id), str(v.punch("04", 22).id)) in unlinked
    assert unlinked[(str(v.levels["04"].id), str(v.punch("04", 22).id))] == "Elec XX04-1E01"
    assert all(
        r.state == "open"
        and r.subject["field"] == "device_id"
        and r.subject["entity_kind"] == "punch_item"
        for r in v.reviews("lint")
    )
    assert str(neuron.id) not in {e for _, e in unlinked}
    assert v.punch("01", 37).device_id is None  # two stations named

    # --- missing parts and part_source
    def sources(part):
        return {
            (ps.target_kind, ps.target_id)
            for ps in session.scalars(
                select(PartSource).where(PartSource.missing_part_id == part.id)
            )
        }

    b1_4 = v.part("B1", 4)
    assert b1_4.device_id is None and b1_4.device_location == "S3-S9"
    assert sources(b1_4) == {("punch", v.punch("B1", n).id) for n in range(8, 15)}
    assert sources(v.part("06M", 7)) == {("cable_end", v.end("06M", "C-06").id)}
    assert sources(v.part("06", 14)) == {
        ("punch", v.punch("06", 14).id),
        ("device", v.device("06-S3").id),
    }
    assert sources(v.part("01", 16)) == {
        ("punch", v.punch("01", n).id) for n in (22, 23, 24, 25, 26, 27, 28, 30, 31, 33, 52)
    }
    assert v.part("B2", 2).device_id == v.device("B2-S1").id
    assert v.part("01", 2).device_id is None  # `CT01LCPB, CT01LCPA`
    assert v.part("04", 12).qty is None
    assert v.count(Finding, Finding.lint_id == "import.part_source") == 0

    # --- photos: thumbnails as complete blobs, links to device and punch item
    ph = v.photo("B1", 1)
    assert ph.device_id == v.device("B1-01").id and ph.seed_thumbnail_only
    blob = session.get(Blob, ph.thumb_blob)
    assert blob.upload_state == "complete" and (blob.width, blob.height) == (320, 240)
    assert store.read(f"blobs/{ph.thumb_blob}") == blob_bytes(FIXTURE, ph.thumb_blob)
    assert v.count(Photo, Photo.thumb_blob.is_(None)) == 0
    assert (
        session.scalar(select(func.count()).select_from(Blob)) == 76 and stats["blobs_stored"] == 76
    )
    six = v.photo("01", 6)
    assert six.device_id == v.device("01-S8").id  # `01-S8 to 01-S12` → the first
    assert six.punch_item_id == v.punch("01", 24).id  # the first item listing photo 6
    assert v.photo("01", 12).punch_item_id == v.punch("01", 46).id
    assert stats["photos_with_several_devices"] == 10

    # D128 (T65): the other devices and punch items naming a photo are links
    def photo_links(ph):
        rows = session.scalars(select(PhotoLink).where(PhotoLink.photo_id == ph.id)).all()
        return {(r.target_kind, r.target_id) for r in rows}

    six_links = photo_links(six)
    assert {t for k, t in six_links if k == "device"} == {
        v.device(f"01-S{n}").id for n in (9, 10, 11, 12)
    }  # `01-S8 to 01-S12`: the first is device_id, the rest links
    assert sum(1 for k, _ in six_links if k == "punch") == 5  # six more punch rows cite photo 6
    assert photo_links(v.photo("B1", 1)) == {("device", v.device("B1-02").id)}  # `B1-01, B1-02`
    assert stats["photo_links"] == 28

    # --- the import is ops: replaying the log reproduces the tables
    before = (v.count(Device), v.count(CableEnd), v.count(PunchItem), v.count(Photo))
    materialise.replay(session, project_id)
    session.commit()
    session.expire_all()
    assert before == (v.count(Device), v.count(CableEnd), v.count(PunchItem), v.count(Photo))
    assert v.device("B2-01").notes == d.notes

    # --- the `import` user is not on the team picker
    names = [m["name"] for m in client.get("/team", headers=HDR).json()]
    assert "Landry" in names and "import" not in names

    # --- the same file again is not imported twice
    _, again = import_file(session, store, factory, FIXTURE, project_id=project_id)
    assert again.job_state == "skipped" and again.stats["earlier_batch"] == str(batch.id)
    assert v.count(Device) == 210


def blob_bytes(path: Path, sha: str) -> bytes:
    wb = read_workbook(path)
    return next(i.data for i in wb.images.values() if i.sha256 == sha)


# -------------------------------------------------------- synthetic workbook


def write_workbook(path: Path, *, notes_header="Notes") -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "ETC Lighting Controls Survey"
    ws.append([])
    ws.append([])
    ws.append([])
    ws.append([])
    ws.append(["Device status by floor"])
    ws.append(["Floor", "Surveyed", "Updated"])
    ws.append(["B2", "2026-10-09", None])
    ws.append(["Total", None, None])

    def tab(name, headers, rows):
        t = wb.create_sheet(name)
        t.append([name])
        t.append(["Levels B2-B2"])
        t.append(headers)
        for r in rows:
            t.append(r)

    tab(
        "Devices",
        [
            "Level",
            "ID",
            "Category",
            "Device",
            "Type",
            "Room / Location",
            "Drawing Position",
            "Status",
            notes_header,
            "Photo",
            "Floor Order",
        ],
        [
            [
                "B2",
                "B2-01",
                "Relay panel",
                "CTB2LCPB",
                "Echo ERP",
                "Elec 1",
                "Grid A",
                "Unsurveyed",
                "a note",
                "1",
                1,
            ],
            [
                "B2",
                "B2-02",
                "EBDK",
                "EBDK",
                "Kit (CTB2LCPB)",
                "Elec 1",
                None,
                "Istalled",
                None,
                None,
                1,
            ],
            ["B2", "B2-S1", "Station", "PI1002", "Station", "Lobby", None, "Issue", None, None, 1],
        ],
    )
    tab(
        "Connections",
        ["Level", "ID", "From", "Cable", "To", "Qty", "Status", "Note", "Floor Order"],
        [
            ["B2", "C-01", "CTB2LCPB", "X", "DMX to Level 09", 1, "Issue", "Run", 1],
            ["B2", "C-02", "Mystery box", "N", "somewhere", 1, "Not installed", None, 1],
            ["B2", "C-03", "CTB2LCPB", "P", "EBDK panic wire", 1, "Installed, untested", None, 1],
        ],
    )
    tab(
        "Punch List",
        [
            "Level",
            "#",
            "Device",
            "Item",
            "Type",
            "Photo",
            "Owner",
            "Tracking status",
            "Date closed",
            "Notes",
            "Floor Order",
        ],
        [
            ["B2", 1, "CTB2LCPB", "Fix it", "Loose wire", None, "EC", "Open", None, None, 1],
            [
                "B2",
                2,
                "All devices",
                "Missing all Device Neuron IDs",
                "Information",
                None,
                "EC",
                "Open",
                None,
                None,
                1,
            ],
        ],
    )
    tab(
        "Missing Parts",
        [
            "Level",
            "#",
            "Device / Location",
            "Part",
            "Part no.",
            "Qty",
            "Owner",
            "Source",
            "Part status",
            "Notes",
            "Floor Order",
        ],
        [
            ["B2", 1, "CTB2LCPB", "Jumper", None, 1, "EC", "see notes", "Needed", None, 1],
            ["B2", 2, "S1", "Cover", None, 1, "EC", "Punch #1", "Needed", None, 1],
        ],
    )
    tab(
        "Photo Log",
        [
            "Level",
            "Photo",
            "Location",
            "Subject",
            "What it shows",
            "Device ID",
            "Floor Order",
            "Image",
        ],
        [["B2", 1, "Elec 1", "CTB2LCPB", "Panel open", "B2-01", 1, None]],
    )
    wb.save(path)


def test_synthetic_workbook_checks(session, store, factory, tmp_path):
    path = tmp_path / "Floor_B2.xlsx"
    write_workbook(path)
    project_id, batch = import_file(session, store, factory, path)
    assert batch.job_state == "done", batch.stats
    v = View(session, project_id)
    stats = batch.stats
    # Unsurveyed → empty status, no review (D110); a typo → empty + lint review item
    assert v.device("B2-01").status is None and v.device("B2-01").notes == "a note"
    assert v.device("B2-02").status is None
    lint = v.reviews("lint")
    assert {(r.subject["entity_kind"], r.subject["field"]) for r in lint} == {
        ("device", "status"),
        ("punch_item", "type"),
    }
    typo = next(r for r in lint if r.subject["entity_kind"] == "device")
    assert typo.candidates[0]["value"] == "Istalled" and typo.level_id == v.levels["B2"].id
    assert v.punch("B2", 1).type is None and v.punch("B2", 1).owner == "EC"
    # a From label nobody recognises: finding, open import_pair item, far end unresolved
    e = v.end("B2", "C-02")
    assert e.endpoint_kind is None and e.device_id is None
    findings = {
        f.lint_id: f
        for f in session.scalars(select(Finding).where(Finding.project_id == project_id))
    }
    assert "import.endpoint" in findings and "Mystery box" in findings["import.endpoint"].message
    assert len(v.reviews("import_pair")) == 1 and v.other_end(e).endpoint_kind is None
    # an out-of-scope level names its far end without a review
    assert v.other_end(v.end("B2", "C-01")).placeholder_id == v.placeholder("Level 09").id
    # P → the panel's EBDK
    assert v.other_end(v.end("B2", "C-03")).device_id == v.device("B2-02").id
    # Source text nobody understands → finding; a good one → link
    assert "see notes" in findings["import.part_source"].message
    links = session.scalars(
        select(PartSource).where(PartSource.missing_part_id == v.part("B2", 2).id)
    ).all()
    assert [(ps.target_kind, ps.target_id) for ps in links] == [("punch", v.punch("B2", 1).id)]
    # photo row without a picture keeps its record and a check
    ph = v.photo("B2", 1)
    assert ph.thumb_blob is None and ph.device_id == v.device("B2-01").id
    assert stats["photos_without_image"] == 1
    assert any("Change Log" in c for c in stats["checks_list"])
    assert stats["historical_ops"] == 0
    g = v.group("B2")
    assert (g.counter_punch, g.counter_part, g.counter_photo, g.counter_cable) == (2, 2, 1, 3)


def test_column_mapping_override(session, store, factory, tmp_path):
    path = tmp_path / "renamed.xlsx"
    write_workbook(path, notes_header="Comments")
    project_id = new_project(session, "Tower")
    user = upsert_user(session, "Landry")
    batch = runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind="floor_xlsx",
        filename=path.name,
        data=path.read_bytes(),
        user=user,
        mapping={"Devices": {"notes": "Comments"}},
    )
    assert runner.run_batch(factory, store, batch.id) == "done"
    assert View(session, project_id).device("B2-01").notes == "a note"
    # without the mapping the column is reported missing and the notes are empty
    batch2 = runner.create_batch(
        session,
        store,
        project_id=new_project(session, "T2"),
        kind="floor_xlsx",
        filename="again.xlsx",
        data=path.read_bytes(),
        user=user,
    )
    assert runner.run_batch(factory, store, batch2.id) == "done"
    session.expire_all()
    stats = session.get(ImportBatch, batch2.id).stats
    assert any("'Notes' not found" in c for c in stats["checks_list"])


def test_bad_file_fails_the_batch_and_leaves_the_project_untouched(session, store, factory):
    project_id = new_project(session, "Tower")
    batch = runner.create_batch(
        session,
        store,
        project_id=project_id,
        kind="master_xlsx",
        filename="x.xlsx",
        data=b"not a workbook",
        user=None,
    )
    assert runner.run_batch(factory, store, batch.id) == "failed"
    session.expire_all()
    assert "not an .xlsx" in session.get(ImportBatch, batch.id).stats["error"]
    # Only the project's own create op (T41) is in the log: nothing from the import.
    assert (
        session.scalar(select(func.count()).select_from(Op).where(Op.project_id == project_id)) == 1
    )


# ---------------------------------------------------------------- the API


def test_imports_api(client, session, store, factory, tmp_path):
    path = tmp_path / "Floor_B2.xlsx"
    write_workbook(path)
    project_id = str(new_project(session))
    headers = {**HDR, "X-Survey-User": "Landry"}
    files = {"file": (path.name, path.read_bytes(), runner.XLSX_MIME)}

    assert client.post("/imports", data={"project_id": project_id}, files=files).status_code == 401
    assert (
        client.post(
            "/imports", data={"project_id": project_id}, files=files, headers=HDR
        ).status_code
        == 400
    )
    r = client.post("/imports", data={"project_id": str(uuid7())}, files=files, headers=headers)
    assert r.status_code == 404
    r = client.post(
        "/imports", data={"project_id": project_id, "kind": "bom"}, files=files, headers=headers
    )
    assert r.status_code == 422
    r = client.post(
        "/imports",
        data={"project_id": project_id, "mapping": "not json"},
        files=files,
        headers=headers,
    )
    assert r.status_code == 422

    r = client.post("/imports", data={"project_id": project_id}, files=files, headers=headers)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["job_state"] == "queued" and body["files"][0]["name"] == "Floor_B2.xlsx"
    assert "key" not in body["files"][0]
    assert client.get(f"/imports/{body['id']}", headers=HDR).json()["job_state"] == "queued"

    assert runner.run_queued(factory, store) == ["done"]
    got = client.get(f"/imports/{body['id']}", headers=HDR).json()
    assert got["job_state"] == "done" and got["stats"]["devices"] == 3
    listed = client.get("/imports", params={"project_id": project_id}, headers=HDR).json()
    assert [b["id"] for b in listed] == [body["id"]]
    assert client.get(f"/imports/{uuid7()}", headers=HDR).status_code == 404

    # the same workbook again: queued, then skipped
    r = client.post("/imports", data={"project_id": project_id}, files=files, headers=headers)
    assert runner.run_queued(factory, store) == ["skipped"]
    assert (
        client.get(f"/imports/{r.json()['id']}", headers=HDR).json()["stats"]["earlier_batch"]
        == body["id"]
    )
    assert runner.run_queued(factory, store) == []


# ------------------------------------------------- trusted push numbering


def test_trusted_create_keeps_its_number_and_moves_the_counter(session):
    from test_ops import World

    from app.sync import OpIn, Push, PushError

    w = World(session)
    user = w.ann

    def op(entity_kind, payload, **kw):
        return OpIn(**w.op(user, "create", entity_kind, payload["id"], payload=payload, **kw))

    carried = op(
        "punch_item",
        {"id": str(uuid7()), "level_id": str(w.l06.id), "number": 7, "item": "Imported"},
    )
    push = Push(session, runner._Body(w.project.id), trusted=True)
    out = push.run([carried])
    assert out.results[0].outcome == "applied" and out.server_ops == []
    session.commit()
    session.expire_all()
    assert session.get(PunchItem, uuid.UUID(carried.payload["id"])).number == 7
    assert session.get(NumberingGroup, w.group.id).counter_punch == 7
    # the next ordinary create continues after the imported numbers
    fresh = op("punch_item", {"id": str(uuid7()), "level_id": str(w.l06.id), "item": "New"})
    out = Push(session, runner._Body(w.project.id)).run([fresh])
    session.commit()
    assert out.server_ops[0]["now"] == 8
    # an untrusted push still may not carry a number
    with pytest.raises(PushError) as e:
        Push(session, runner._Body(w.project.id)).run(
            [op("punch_item", {"id": str(uuid7()), "level_id": str(w.l06.id), "number": 9})]
        )
    assert e.value.status == 422


def test_single_row_far_end_is_never_numbered(session):
    from test_ops import World

    from app.sync import OpIn, Push

    w = World(session)
    cable_id, a_id, b_id = uuid7(), uuid7(), uuid7()
    ops = [
        OpIn(
            **w.op(
                w.ann,
                "create",
                "cable",
                cable_id,
                payload={
                    "id": str(cable_id),
                    "project_id": str(w.project.id),
                    "cable": "P",
                    "single_row": True,
                    "end_a_id": str(a_id),
                    "end_b_id": str(b_id),
                },
            )
        ),
        OpIn(
            **w.op(
                w.ann,
                "create",
                "cable_end",
                a_id,
                payload={
                    "id": str(a_id),
                    "cable_id": str(cable_id),
                    "side": "A",
                    "level_id": str(w.l06.id),
                },
            )
        ),
        OpIn(
            **w.op(
                w.ann,
                "create",
                "cable_end",
                b_id,
                payload={
                    "id": str(b_id),
                    "cable_id": str(cable_id),
                    "side": "B",
                    "level_id": str(w.l06.id),
                },
            )
        ),
    ]
    out = Push(session, runner._Body(w.project.id)).run(ops)
    session.commit()
    assigned = {
        uuid.UUID(o["entity_id"]): o["now"] for o in out.server_ops if o["kind"] == "assign"
    }
    assert assigned == {a_id: "C-01"}
    assert session.get(NumberingGroup, w.group.id).counter_cable == 1


def test_imports_preview(client, tmp_path):
    """T28: the preview reads headers and matches, stores nothing; a mapping moves a match."""
    path = tmp_path / "Floor_B2.xlsx"
    write_workbook(path)
    files = {"file": (path.name, path.read_bytes(), runner.XLSX_MIME)}
    assert client.post("/imports/preview", files=files).status_code == 401
    r = client.post("/imports/preview", files=files, headers=HDR)
    assert r.status_code == 200, r.text
    body = r.json()
    devices = next(t for t in body["tabs"] if t["tab"] == "Devices")
    assert devices["found"] and devices["rows"] == 3 and "Room / Location" in devices["headers"]
    assert {f["field"]: f["header"] for f in devices["fields"]}["status"] == "Status"
    assert next(t for t in body["tabs"] if t["tab"] == "Change Log")["found"] is False
    assert body["levels"]

    mapped = client.post(
        "/imports/preview",
        data={"mapping": '{"Devices": {"status": "Notes"}}'},
        files=files,
        headers=HDR,
    ).json()
    d2 = next(t for t in mapped["tabs"] if t["tab"] == "Devices")
    assert {f["field"]: f["header"] for f in d2["fields"]}["status"] == "Notes"
    bad = client.post(
        "/imports/preview", files={"file": ("x.xlsx", b"nope", runner.XLSX_MIME)}, headers=HDR
    )
    assert bad.status_code == 422
    assert (
        client.post(
            "/imports/preview", data={"mapping": "[]"}, files=files, headers=HDR
        ).status_code
        == 422
    )
