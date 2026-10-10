"""TP-10 (T13): display numbers are never reused (PLAN §2.3, D25, D33).

Create, delete and create again across two iPads: deleted numbers stay retired, counters are
monotonic per numbering group, 06 and 06M share one group, a second group counts on its own,
and neither a duplicate push, a restore nor a replay of the log ever renumbers.
"""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ops import World, outcomes

from app import materialise, numbering
from app.ids import uuid7
from app.models import Level, NumberingGroup, Op, PunchItem

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
