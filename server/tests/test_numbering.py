"""TP-10 (T13): display numbers are never reused (PLAN §2.3, D25, D33).

Create, delete and create again across two iPads: deleted numbers stay retired, counters are
monotonic per numbering group, 06 and 06M share one group, a second group counts on its own,
and neither a duplicate push, a restore nor a replay of the log ever renumbers.

Device IDs of the `level_number` scheme (D93, T63) follow the same rules per level code.
"""

import time
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ops import World, outcomes

from app import materialise, numbering
from app.ids import uuid7
from app.models import Device, Level, NumberingGroup, Op, PunchItem

NUMBERED = [
    ("punch_item", "number", [1, 2, 3, 4]),
    ("missing_part", "number", [1, 2, 3, 4]),
    ("photo", "number", [1, 2, 3, 4]),
    ("cable_end", "display_id", ["C-01", "C-02", "C-03", "C-04"]),
]


@pytest.fixture
def w(session):
    world = World(session)
    # A second group (level 07) that must count on its own.
    world.group07 = NumberingGroup(id=uuid7(), project_id=world.project.id, label="07")
    world.l07 = Level(
        id=uuid7(), project_id=world.project.id, level="07", numbering_group_id=world.group07.id
    )
    session.add_all([world.group07, world.l07])
    session.commit()
    return world


def numbers(res, field):
    return {o["entity_id"]: o["now"] for o in res["server_ops"] if o["field"] == field}


@pytest.mark.parametrize(("kind", "field", "expected"), NUMBERED)
def test_create_delete_create_across_two_ipads_never_reuses(client, w, kind, field, expected):
    ann_ipad, bob_ipad = w.install(w.ann, 1), w.install(w.bob, 1)

    # Both iPads work offline; Ann's create on 06 and Bob's on 06M share one group (D33).
    a1 = w.create(w.ann, kind, install=ann_ipad)
    b1 = w.create(w.bob, kind, {"level_id": str(w.l06m.id)}, install=bob_ipad)
    got = numbers(w.push(client, [a1]), field) | numbers(w.push(client, [b1], since=0), field)
    assert [got[a1["entity_id"]], got[b1["entity_id"]]] == expected[:2]

    # Bob deletes the newest record; its number stays retired.
    gone = w.op(w.bob, "delete", kind, b1["entity_id"], install=bob_ipad)
    assert outcomes(w.push(client, [gone], since=4)) == ["applied"]
    a2 = w.create(w.ann, kind, install=ann_ipad)
    assert numbers(w.push(client, [a2], since=4), field) == {a2["entity_id"]: expected[2]}

    # Restoring the deleted record keeps its number; nothing is assigned again.
    back = w.op(w.ann, "restore", kind, b1["entity_id"], base_op_id=gone["op_id"])
    res = w.push(client, [back], since=7)
    assert outcomes(res) == ["applied"] and res["server_ops"] == []

    # Bob's iPad never heard back about its first push and sends it again with a new create.
    b2 = w.create(w.bob, kind, install=bob_ipad)
    res = w.push(client, [b1, b2], since=0)
    assert outcomes(res) == ["duplicate", "applied"]
    assert numbers(res, field) == {b1["entity_id"]: expected[1], b2["entity_id"]: expected[3]}

    w.session.expire_all()
    counter = numbering.NUMBERED[kind][0]
    assert getattr(w.session.get(NumberingGroup, w.group.id), counter) == 4
    assert getattr(w.session.get(NumberingGroup, w.group07.id), counter) == 0


def test_groups_count_independently_and_06_06m_share(client, w):
    ops = [
        w.create(w.ann, "punch_item"),  # 06 → 1
        w.create(w.ann, "punch_item", {"level_id": str(w.l07.id)}),  # 07 → 1
        w.create(w.bob, "punch_item", {"level_id": str(w.l06m.id)}),  # 06M → 2
        w.create(w.bob, "punch_item", {"level_id": str(w.l07.id)}),  # 07 → 2
        w.create(w.ann, "punch_item"),  # 06 → 3
    ]
    got = numbers(w.push(client, ops), "number")
    assert [got[o["entity_id"]] for o in ops] == [1, 1, 2, 2, 3]


def test_counters_only_move_forward_and_replay_never_renumbers(client, w):
    ops = [w.create(w.ann, "punch_item") for _ in range(3)]
    w.push(client, ops)
    for o in ops:
        w.push(client, [w.op(w.ann, "delete", "punch_item", o["entity_id"])], since=6)
    w.session.expire_all()
    assert w.session.get(NumberingGroup, w.group.id).counter_punch == 3

    before = {str(p.id): p.number for p in w.session.scalars(select(PunchItem))}
    with Session(w.session.get_bind()) as s, s.begin():
        materialise.replay(s, w.project.id)
    w.session.expire_all()
    assert {str(p.id): p.number for p in w.session.scalars(select(PunchItem))} == before
    assert w.session.get(NumberingGroup, w.group.id).counter_punch == 3
    assigns = w.session.scalars(select(Op).where(Op.kind == "assign")).all()
    assert len(assigns) == 3

    nxt = w.create(w.bob, "punch_item")
    assert numbers(w.push(client, [nxt], since=9), "number") == {nxt["entity_id"]: 4}


def test_a_client_can_never_set_a_number(client, w):
    p = w.create(w.ann, "punch_item")
    w.push(client, [p])
    forged = w.set(w.ann, "punch_item", p["entity_id"], "number", 1, None)
    w.push(client, [forged], status=422)
    preset = w.create(w.ann, "punch_item", {"number": 99})
    w.push(client, [preset], status=422)


def test_a_new_project_starts_numbering_over(client, w):
    """D88 (approved): numbering is per project; a second project's groups start at 1."""
    w.push(client, [w.create(w.ann, "punch_item") for _ in range(3)])

    other = World(w.session)
    p = other.create(other.ann, "punch_item")
    e = other.create(other.ann, "cable_end")
    got = numbers(other.push(client, [p]), "number") | numbers(
        other.push(client, [e]), "display_id"
    )
    assert got == {p["entity_id"]: 1, e["entity_id"]: "C-01"}


# --------------------------------------------------------- device IDs (D93, T63)


def new_device(w, user, level, install=None, **extra):
    """A field-added device: no `display_id` (the iPad shows `<level>-?` + NEW)."""
    op = w.create(user, "device", {"level_id": str(level.id), **extra}, install=install)
    del op["payload"]["display_id"]
    return op


def ids(res):
    return numbers(res, "display_id")


def test_two_ipads_adding_devices_offline_on_one_level_get_distinct_ids(client, w):
    # An imported panel already holds 06M-03 (T27 keeps imported IDs).
    imported = w.create(w.ann, "device", {"level_id": str(w.l06m.id), "display_id": "06M-03"})
    w.push(client, [imported])

    ann_ipad, bob_ipad = w.install(w.ann, 1), w.install(w.bob, 1)
    a1 = new_device(w, w.ann, w.l06m, ann_ipad, category="Touchscreen")
    a2 = new_device(w, w.ann, w.l06m, ann_ipad, category="NSPS")
    b1 = new_device(w, w.bob, w.l06m, bob_ipad, category="Touchscreen")
    # Bob's push arrives first: arrival order decides, not client_ts.
    got = ids(w.push(client, [b1], since=1)) | ids(w.push(client, [a1, a2], since=1))
    assert [got[b1["entity_id"]], got[a1["entity_id"]], got[a2["entity_id"]]] == [
        "06M-04",
        "06M-05",
        "06M-06",
    ]
    w.session.expire_all()
    assigns = w.session.scalars(select(Op).where(Op.kind == "assign")).all()
    assert {o.field for o in assigns} == {"display_id"}
    assert all(o.base_op_id is not None for o in assigns)
    assert {d.display_id for d in w.session.scalars(select(Device))} == {
        "06M-03",
        "06M-04",
        "06M-05",
        "06M-06",
    }


def test_06_and_06m_count_device_ids_separately(client, w):
    ops = [
        new_device(w, w.ann, w.l06),
        new_device(w, w.ann, w.l06m),
        new_device(w, w.bob, w.l06),
        new_device(w, w.bob, w.l07),
    ]
    got = ids(w.push(client, ops))
    assert [got[o["entity_id"]] for o in ops] == ["06-01", "06M-01", "06-02", "07-01"]


def test_a_carried_id_ahead_of_the_first_assignment_still_counts_past_the_log(client, w):
    """T76: a carried ID applied before the push's first assignment on its level code used to
    seed the count, so the log scan was skipped and an earlier push's higher ID was missed."""
    w.push(
        client, [w.create(w.ann, "device", {"level_id": str(w.l06m.id), "display_id": "06M-05"})]
    )
    carried = w.create(w.ann, "device", {"level_id": str(w.l06m.id), "display_id": "06M-02"})
    fresh = new_device(w, w.ann, w.l06m)
    assert ids(w.push(client, [carried, fresh])) == {fresh["entity_id"]: "06M-06"}


def test_deleted_and_renamed_ids_stay_used_and_restore_keeps_the_id(client, w):
    d1, d2 = new_device(w, w.ann, w.l06m), new_device(w, w.ann, w.l06m)
    got = ids(w.push(client, [d1, d2]))
    assert [got[d1["entity_id"]], got[d2["entity_id"]]] == ["06M-01", "06M-02"]

    gone = w.op(w.bob, "delete", "device", d2["entity_id"])
    assert outcomes(w.push(client, [gone], since=4)) == ["applied"]
    d3 = new_device(w, w.ann, w.l06m)
    assert ids(w.push(client, [d3], since=5)) == {d3["entity_id"]: "06M-03"}

    back = w.op(w.bob, "restore", "device", d2["entity_id"], base_op_id=gone["op_id"])
    res = w.push(client, [back], since=7)
    assert outcomes(res) == ["applied"] and res["server_ops"] == []
    w.session.expire_all()
    assert w.session.get(Device, uuid.UUID(d2["entity_id"])).display_id == "06M-02"

    # A rename at review retires the new number too (highest *ever* used + 1).
    head = w.head(d3["entity_id"], "display_id")
    rename = w.set(w.ann, "device", d3["entity_id"], "display_id", "06M-09", head)
    assert outcomes(w.push(client, [rename], since=8)) == ["applied"]
    d4 = new_device(w, w.bob, w.l06m)
    assert ids(w.push(client, [d4], since=9)) == {d4["entity_id"]: "06M-10"}


def test_replay_never_renumbers_a_device(client, w):
    ipad = w.install(w.bob, 1)
    d1 = new_device(w, w.bob, w.l06m, ipad)
    first = ids(w.push(client, [d1]))
    # The iPad never heard back and pushes again with another device.
    d2 = new_device(w, w.bob, w.l06m, ipad)
    res = w.push(client, [d1, d2], since=0)
    assert outcomes(res) == ["duplicate", "applied"]
    assert ids(res) == first | {d2["entity_id"]: "06M-02"}

    before = {str(d.id): d.display_id for d in w.session.scalars(select(Device))}
    with Session(w.session.get_bind()) as s, s.begin():
        materialise.replay(s, w.project.id)
    w.session.expire_all()
    assert {str(d.id): d.display_id for d in w.session.scalars(select(Device))} == before
    assert len(w.session.scalars(select(Op).where(Op.kind == "assign")).all()) == 2


def test_stations_and_sensors_are_numbered_by_the_server_per_letter(client, w):
    """D118: a station/sensor created without an ID gets `<level>-S<n>` / `<level>-D<n>` (highest
    ever used for that letter on the level code + 1, no padding); one that carries its ID (seed
    import, an older app's typed tag) keeps it."""
    station = w.create(
        w.ann,
        "device",
        {"level_id": str(w.l06m.id), "display_id": "06M-S15", "category": "Station"},
    )
    res = w.push(client, [station])
    assert outcomes(res) == ["applied"] and res["server_ops"] == []

    panel = new_device(w, w.ann, w.l06m)
    sensor = new_device(w, w.ann, w.l06m, category="Sensor")
    s2 = new_device(w, w.bob, w.l06m, category="Station")
    s3 = new_device(w, w.bob, w.l06m, category="Station")
    other = new_device(w, w.bob, w.l07, category="Station")
    got = ids(w.push(client, [panel, sensor, s2, s3, other], since=1))
    assert [got[o["entity_id"]] for o in (panel, sensor, s2, s3, other)] == [
        "06M-01",
        "06M-D1",
        "06M-S16",
        "06M-S17",
        "07-S1",
    ]


def test_the_library_type_scheme_wins_over_the_category(client, w):
    lt = lambda scheme: w.create(  # noqa: E731
        w.ann,
        "library_type",
        {"project_id": str(w.project.id), "model": f"m-{scheme}", "id_scheme": scheme},
    )
    tag_type, number_type = lt("level_tag"), lt("level_number")
    w.push(client, [tag_type, number_type])

    sensor_numbered = new_device(
        w, w.ann, w.l06m, category="Sensor", library_type_id=number_type["entity_id"]
    )
    assert ids(w.push(client, [sensor_numbered], since=2)) == {
        sensor_numbered["entity_id"]: "06M-01"
    }
    # a tag-scheme type on a category with no ID letter is simply numbered
    panel_tagged = new_device(
        w, w.ann, w.l06m, category="Relay panel", library_type_id=tag_type["entity_id"]
    )
    assert ids(w.push(client, [panel_tagged], since=4)) == {panel_tagged["entity_id"]: "06M-02"}


def test_the_library_type_role_gives_the_tag_letter_when_the_category_names_none(client, w):
    """T112 (D201): a station type filed under the D196 `Equipment` category still tags its
    devices `S<n>`, by its role; the category alone (no type) names no role and is numbered."""
    station_type = w.create(
        w.ann,
        "library_type",
        {
            "project_id": str(w.project.id),
            "model": "UH10002",
            "category": "Equipment",
            "role": "station",
        },
    )
    w.push(client, [station_type])
    typed = new_device(
        w, w.ann, w.l06m, category="Equipment", library_type_id=station_type["entity_id"]
    )
    loose = new_device(w, w.ann, w.l06m, category="Equipment")
    by_text = new_device(w, w.bob, w.l06m, category="Equipment", device="UH10002")
    renamed = new_device(w, w.bob, w.l06m, category="Equipment Panels")
    got = ids(w.push(client, [typed, loose, by_text, renamed], since=1))
    # by link: S; a bare category: numbered (the server does not match by Device text on create)
    assert [got[o["entity_id"]] for o in (typed, loose, by_text, renamed)] == [
        "06M-S1",
        "06M-01",
        "06M-02",
        "06M-03",
    ]


def test_a_level_created_by_an_op_gives_its_code_from_the_log(client, w):
    lvl = w.create(w.ann, "level", {"numbering_group_id": str(w.group07.id), "level": "08"})
    d = new_device(w, w.ann, w.l06m)
    d["payload"]["level_id"] = lvl["entity_id"]
    assert ids(w.push(client, [lvl, d])) == {d["entity_id"]: "08-01"}


# ---------------------------------------------------------- T75 (D146): one scan per push


def test_500_device_creates_in_one_push_count_from_one_scan(client, w):
    """The log is scanned once per level code per push, then the cache counts on; the index
    `(project_id, entity_kind, kind)` keeps that scan cheap. Target: < 2 s against Docker."""
    ops = [new_device(w, w.ann, w.l06m) for _ in range(500)]
    t0 = time.perf_counter()
    res = w.push(client, ops)
    elapsed = time.perf_counter() - t0
    assert outcomes(res) == ["applied"] * 500
    got = ids(res)
    assert [got[o["entity_id"]] for o in ops] == [f"06M-{n:02d}" for n in range(1, 501)]
    assert elapsed < 2.0, f"500 device creates took {elapsed:.2f} s"


def test_carried_and_renamed_ids_in_the_same_push_are_counted_past(client, w):
    """A trusted-style carried ID, a rename and a server-assigned ID in one push: the cache
    sees every ID the push itself applies (not only the log before it)."""
    carried = w.create(w.ann, "device", {"level_id": str(w.l06m.id), "display_id": "06M-07"})
    fresh1 = new_device(w, w.ann, w.l06m)
    res = w.push(client, [carried, fresh1])
    assert ids(res)[fresh1["entity_id"]] == "06M-08"

    assign_op = next(o["op_id"] for o in res["server_ops"] if o["field"] == "display_id")
    rename = w.set(w.ann, "device", fresh1["entity_id"], "display_id", "06M-20", assign_op)
    fresh2 = new_device(w, w.ann, w.l06m)
    station = new_device(w, w.ann, w.l06m, category="Station")
    res = w.push(client, [rename, fresh2, station])
    assert outcomes(res) == ["applied"] * 3
    assert ids(res)[fresh2["entity_id"]] == "06M-21"  # counts past the rename in the same push
    assert ids(res)[station["entity_id"]] == "06M-S1"
