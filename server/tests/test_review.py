"""Review resolution on the server (T15, PLAN §3.3, D91): the resolver's group of `Reconcile` op(s)
plus the review item's `resolution`/`resolved_by_id`/`resolved_at`/`state` applies like any
other push; `state = resolved` settles the ops the item held (loser `rejected`, winning B
`superseded`); a `Reconcile` set on a record whose delete the resolver has seen is not reviewed
again; replay reproduces it all."""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_ops import World, outcomes
from test_pull_materialise import pull, snapshot

from app import materialise
from app.ids import uuid7
from app.models import Device, ReviewItem, User


@pytest.fixture
def w(session):
    world = World(session)
    world.cat = User(id=uuid7(), name="Cat")
    session.add(world.cat)
    session.commit()
    return world


def reconcile(w, user, kind, eid, **kw):
    return w.op(user, kind, "device", eid, change_type="Reconcile", reason="Review: chose …", **kw)


def resolution_group(w, user, item: ReviewItem, subject_ops, choice, *, rejected=(), superseded=()):
    """What `resolveReview` in packages/core sends: subject ops, then the item's four fields."""
    group = str(uuid7())
    item_id = str(item.id)
    resolution = {
        "choice": choice,
        "reason": "Review: chose …",
        "reconcile_op_ids": [o["op_id"] for o in subject_ops],
        "rejected_op_ids": list(rejected),
        "superseded_op_ids": list(superseded),
    }
    create_op = w.session.scalars(
        select(materialise.Op).where(
            materialise.Op.entity_id == item.id, materialise.Op.kind == "create"
        )
    ).one()
    fields = [
        ("resolution", resolution, None),
        ("resolved_by_id", str(user.id), None),
        ("resolved_at", w.clock.isoformat(), None),
        ("state", "resolved", str(create_op.op_id)),
    ]
    item_ops = [
        w.op(
            user,
            "set",
            "review_item",
            item_id,
            field=f,
            now=v,
            base_op_id=base,
            change_type="Reconcile",
            reason="Review: chose …",
        )
        for f, v, base in fields
    ]
    return [{**o, "group_id": group} for o in [*subject_ops, *item_ops]]


def notes_conflict(client, w):
    """Bob's note arrives first (official); Ann's goes to review (TP-1)."""
    d = w.create(w.ann, "device", {"notes": "as found"})
    w.push(client, [d])
    bob = w.set(w.bob, "device", d["entity_id"], "notes", "Cover plate loose", d["op_id"])
    ann = w.set(w.ann, "device", d["entity_id"], "notes", "LVD card missing", d["op_id"])
    w.push(client, [bob], since=1)
    res = w.push(client, [ann], since=1)
    assert outcomes(res) == ["review"]
    (item,) = w.review_items()
    return d, bob, ann, item


def test_resolve_a_rejects_the_loser_and_closes_the_item(client, w):
    d, bob, ann, item = notes_conflict(client, w)
    eid = d["entity_id"]
    top = pull(client, w)["server_seq"]
    keep = reconcile(
        w, w.cat, "set", eid, field="notes", now="Cover plate loose", base_op_id=bob["op_id"]
    )
    group = resolution_group(w, w.cat, item, [keep], "A", rejected=[ann["op_id"]])
    res = w.push(client, group, since=top)
    assert outcomes(res) == ["applied"] * 5

    (item,) = w.review_items()
    assert item.state == "resolved"
    assert item.resolved_by_id == w.cat.id
    assert item.resolution["rejected_op_ids"] == [ann["op_id"]]
    assert w.stored(ann["op_id"]).state == "rejected"
    assert w.stored(bob["op_id"]).state == "applied"
    assert w.head(eid, "notes") == keep["op_id"]
    w.session.expire_all()
    assert w.session.get(Device, uuid.UUID(eid)).notes == "Cover plate loose"
    # A device pulling from scratch sees the settled state of Ann's op.
    states = {o["op_id"]: o["state"] for o in pull(client, w)["ops"]}
    assert states[ann["op_id"]] == "rejected"


def test_resolve_b_supersedes_the_reviewed_op_and_applies_its_value(client, w):
    d, bob, ann, item = notes_conflict(client, w)
    eid = d["entity_id"]
    top = pull(client, w)["server_seq"]
    take = reconcile(
        w, w.ann, "set", eid, field="notes", now="LVD card missing", base_op_id=bob["op_id"]
    )
    res = w.push(
        client, resolution_group(w, w.ann, item, [take], "B", superseded=[ann["op_id"]]), since=top
    )
    assert outcomes(res) == ["applied"] * 5
    assert w.stored(ann["op_id"]).state == "superseded"
    w.session.expire_all()
    assert w.session.get(Device, uuid.UUID(eid)).notes == "LVD card missing"


def test_a_stale_resolution_is_reviewed_as_one_and_the_item_stays_open(client, w):
    """A third user's edit the resolver had not pulled: nothing is overwritten (PLAN §3.2)."""
    d, bob, ann, item = notes_conflict(client, w)
    eid = d["entity_id"]
    top = pull(client, w)["server_seq"]
    late = w.set(w.bob, "device", eid, "notes", "Cover plate fixed", bob["op_id"])
    w.push(client, [late], since=top)
    keep = reconcile(
        w, w.cat, "set", eid, field="notes", now="Cover plate loose", base_op_id=bob["op_id"]
    )
    res = w.push(
        client, resolution_group(w, w.cat, item, [keep], "A", rejected=[ann["op_id"]]), since=top
    )
    assert outcomes(res) == ["review"] * 5
    w.session.expire_all()
    first = w.session.get(ReviewItem, item.id)
    assert first.state == "open"
    assert w.stored(ann["op_id"]).state == "review"
    assert w.session.get(Device, uuid.UUID(eid)).notes == "Cover plate fixed"
    assert len(w.review_items()) == 2


def test_reconcile_set_on_a_seen_delete_applies_but_an_ordinary_one_is_reviewed(client, w):
    """TP-11 (2), keep deleted: the editing iPad's note goes back to the official value."""
    d = w.create(w.ann, "device", {"notes": "as found"})
    gone = w.op(w.ann, "delete", "device", d["entity_id"])
    w.push(client, [d, gone])
    edit = w.set(w.bob, "device", d["entity_id"], "notes", "Neuron ID read", d["op_id"])
    assert outcomes(w.push(client, [edit], since=1)) == ["review"]
    (item,) = w.review_items()
    top = pull(client, w)["server_seq"]

    # The resolver had not pulled the delete: still reviewed.
    blind = reconcile(
        w, w.bob, "set", d["entity_id"], field="notes", now="as found", base_op_id=d["op_id"]
    )
    assert outcomes(w.push(client, [blind], since=1)) == ["review"]
    # An ordinary edit after seeing the delete: still reviewed (PLAN §3.2 step 4).
    plain = w.set(w.bob, "device", d["entity_id"], "notes", "as found", d["op_id"])
    assert outcomes(w.push(client, [plain], since=top + 1)) == ["review"]

    top = pull(client, w)["server_seq"]
    keep = reconcile(
        w, w.bob, "set", d["entity_id"], field="notes", now="as found", base_op_id=d["op_id"]
    )
    group = resolution_group(w, w.bob, item, [keep], "A", rejected=[edit["op_id"]])
    assert outcomes(w.push(client, group, since=top)) == ["applied"] * 5
    assert w.stored(edit["op_id"]).state == "rejected"
    w.session.expire_all()
    dev = w.session.get(Device, uuid.UUID(d["entity_id"]))
    assert dev.deleted_at is not None and dev.notes == "as found"


def test_restore_with_the_edit_applies_as_one_group(client, w):
    """TP-11 (2), choose B: restore, then the reviewed note."""
    d = w.create(w.ann, "device", {"notes": "as found"})
    gone = w.op(w.ann, "delete", "device", d["entity_id"])
    w.push(client, [d, gone])
    edit = w.set(w.bob, "device", d["entity_id"], "notes", "Neuron ID read", d["op_id"])
    w.push(client, [edit], since=2)
    (item,) = w.review_items()
    top = pull(client, w)["server_seq"]
    back = reconcile(w, w.ann, "restore", d["entity_id"], base_op_id=gone["op_id"])
    note = reconcile(
        w, w.ann, "set", d["entity_id"], field="notes", now="Neuron ID read", base_op_id=d["op_id"]
    )
    group = resolution_group(w, w.ann, item, [back, note], "B", superseded=[edit["op_id"]])
    assert outcomes(w.push(client, group, since=top)) == ["applied"] * 6
    assert w.stored(edit["op_id"]).state == "superseded"
    w.session.expire_all()
    dev = w.session.get(Device, uuid.UUID(d["entity_id"]))
    assert dev.deleted_at is None and dev.notes == "Neuron ID read"


def test_replay_reproduces_a_resolution(client, w):
    d, bob, ann, item = notes_conflict(client, w)
    top = pull(client, w)["server_seq"]
    keep = reconcile(
        w,
        w.cat,
        "set",
        d["entity_id"],
        field="notes",
        now="Cover plate loose",
        base_op_id=bob["op_id"],
    )
    w.push(
        client, resolution_group(w, w.cat, item, [keep], "A", rejected=[ann["op_id"]]), since=top
    )
    before = snapshot(w.session)
    with Session(w.session.get_bind()) as s, s.begin():
        materialise.replay(s, w.project.id)
    assert snapshot(w.session) == before
    assert w.stored(ann["op_id"]).state == "rejected"
