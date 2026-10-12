"""`GET /ops` pull with paging and the materialised tables (T10): replay == state, no gaps."""

import threading
import uuid
from datetime import UTC, datetime

import pytest
from conftest import HDR
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from test_ops import World, outcomes

from app import materialise, sync
from app.ids import uuid7
from app.models import (
    Assignment,
    CableEnd,
    Device,
    Level,
    NumberingGroup,
    Op,
    PhotoLink,
    PunchItem,
    ReviewItem,
)


@pytest.fixture
def w(session):
    return World(session)


def pull(client, w, since=0, limit=None, status=200):
    params = {"project_id": str(w.project.id), "since": since}
    if limit is not None:
        params["limit"] = limit
    r = client.get("/ops", params=params, headers=HDR)
    assert r.status_code == status, r.text
    return r.json()


def snapshot(session: Session) -> dict[str, list[tuple]]:
    """Every materialised table as sorted rows (op log and heads excluded)."""
    session.expire_all()
    out = {}
    for name, table in materialise.TABLES.items():
        if name in ("op", "field_head"):
            continue
        rows = session.execute(select(table).order_by(*table.primary_key.columns)).all()
        out[name] = [tuple(_norm(v) for v in row) for row in rows]
    return out


def _norm(v):
    if isinstance(v, (dict, list)):
        return repr(v)
    return v


# ------------------------------------------------------------------- scenario


def survey_a_floor(client, w) -> dict:
    """Every op kind and outcome once: creates with numbering, sets of every column type,
    delete/restore, links, a conflict (review + review_item create), a superseded op, a group."""
    ids = {}
    d = w.create(w.ann, "device", {"pin": {"sheet": str(w.sheet.id), "x": 1.5, "y": 2}})
    lvl = w.create(w.ann, "level", {"numbering_group_id": str(w.group.id), "floor_order": 7})
    p = w.create(w.ann, "punch_item", {"device_id": d["entity_id"]})
    e = w.create(w.ann, "cable_end")
    res = w.push(client, [d, lvl, p, e])
    assert outcomes(res) == ["applied"] * 4
    ids.update(
        device=d["entity_id"], level=lvl["entity_id"], punch=p["entity_id"], end=e["entity_id"]
    )

    status = w.set(w.ann, "device", d["entity_id"], "status", "Issue", d["op_id"])
    pin = w.set(w.ann, "device", d["entity_id"], "pin", {"sheet": "s", "x": 3, "y": 4}, d["op_id"])
    gid = str(uuid7())
    closed = w.set(
        w.ann, "punch_item", p["entity_id"], "tracking_status", "Closed", p["op_id"], group_id=gid
    )
    dated = w.set(
        w.ann, "punch_item", p["entity_id"], "date_closed", "2026-10-10", p["op_id"], group_id=gid
    )
    last = w.set(w.ann, "punch_item", p["entity_id"], "sort_last", True, p["op_id"])
    add = w.op(w.ann, "link_add", "assignment", str(w.l06.id), payload={"user_id": str(w.bob.id)})
    res = w.push(client, [status, pin, closed, dated, last, add], since=res["server_seq"])
    assert outcomes(res) == ["applied"] * 6
    ids["status_op"] = status["op_id"]

    # Bob, on an old base, disagrees on status → review; same value on notes → merge.
    bob = w.set(w.bob, "device", d["entity_id"], "status", "No access", d["op_id"])
    res = w.push(client, [bob])
    assert outcomes(res) == ["review"]
    ids["review_op"] = bob["op_id"]
    ids["review_item"] = res["results"][0]["review_item_id"]

    # Ann's second iPad sends an older edit → superseded.
    older = w.set(
        w.ann,
        "device",
        d["entity_id"],
        "notes",
        "stale",
        d["op_id"],
        install=w.install(w.ann, 2),
        ts=datetime(2026, 10, 10, 11, 0, tzinfo=UTC),
    )
    newer = w.set(w.ann, "device", d["entity_id"], "notes", "fresh", d["op_id"])
    res = w.push(client, [newer, older])
    assert outcomes(res) == ["applied", "superseded"]
    ids["superseded_op"] = older["op_id"]

    gone = w.op(w.ann, "delete", "device", d["entity_id"], reason="duplicate pin")
    res = w.push(client, [gone], since=res["server_seq"])
    assert outcomes(res) == ["applied"]
    back = w.op(w.bob, "restore", "device", d["entity_id"], base_op_id=gone["op_id"])
    rm = w.op(w.ann, "link_remove", "assignment", str(w.l06.id), payload={"user_id": str(w.bob.id)})
    res = w.push(client, [back, rm], since=res["server_seq"])
    assert outcomes(res) == ["applied", "applied"]
    ids["delete_op"] = gone["op_id"]
    ids["last_seq"] = res["server_seq"]
    return ids


# ----------------------------------------------------------------------- pull


def test_pull_requires_token_and_a_known_project(client, w):
    assert client.get("/ops", params={"project_id": str(w.project.id)}).status_code == 401
    r = client.get("/ops", params={"project_id": str(uuid7())}, headers=HDR)
    assert r.status_code == 404


def test_pull_pages_in_server_seq_order_and_carries_every_state(client, w):
    ids = survey_a_floor(client, w)
    top = ids["last_seq"]

    pages, since, n = [], 0, 0
    while True:
        page = pull(client, w, since=since, limit=4)
        assert page["server_seq"] == top
        assert len(page["ops"]) <= 4
        pages.append(page)
        n += 1
        if not page["has_more"]:
            break
        assert len(page["ops"]) == 4
        since = page["ops"][-1]["server_seq"]
    ops = [o for p in pages for o in p["ops"]]
    seqs = [o["server_seq"] for o in ops]
    assert seqs == list(range(1, top + 1))  # contiguous, oldest first, nothing skipped
    assert n == -(-top // 4)

    by_id = {o["op_id"]: o for o in ops}
    assert by_id[ids["review_op"]]["state"] == "review"
    assert by_id[ids["superseded_op"]]["state"] == "superseded"
    assert by_id[ids["status_op"]]["state"] == "applied"
    kinds = {o["kind"] for o in ops}
    assert kinds == {"create", "set", "delete", "restore", "link_add", "link_remove", "assign"}
    server_made = [o for o in ops if o["install_id"] == str(sync.SERVER_INSTALL_ID)]
    assert sorted(o["kind"] for o in server_made) == ["assign", "assign", "create"]

    # Caught up: nothing after the top; a cursor in the middle resumes exactly there.
    assert pull(client, w, since=top) == {"ops": [], "server_seq": top, "has_more": False}
    tail = pull(client, w, since=top - 2)
    assert [o["server_seq"] for o in tail["ops"]] == [top - 1, top] and not tail["has_more"]


def test_a_push_landing_between_the_pull_reads_is_never_skipped(client, w, engine, monkeypatch):
    """T74 (D144): the top sequence is read before the page. A push committing in between can
    only add ops to the page; the client never sees an empty page under a higher top (which its
    old catch-up branch turned into a skipped op)."""
    first = w.push(client, [w.create(w.ann, "device")])
    cursor = first["server_seq"]  # the client is caught up
    landed = w.create(w.bob, "device", {"display_id": "06-02"})

    real_page = sync._pull_page

    def page_after_bobs_push(session, project_id, since, n):
        with Session(engine) as other:  # another request commits Bob's push between the reads
            out = sync.Push(other, sync.PushIn(project_id=project_id, ops=[sync.OpIn(**landed)]))
            out.run([sync.OpIn(**landed)])
            other.commit()
        return real_page(session, project_id, since, n)

    monkeypatch.setattr(sync, "_pull_page", page_after_bobs_push)
    page = pull(client, w, since=cursor)
    monkeypatch.setattr(sync, "_pull_page", real_page)

    # The invariant the client relies on: an empty page never comes with a higher top.
    assert not (page["ops"] == [] and page["server_seq"] > cursor)
    # Bob's create (and its assign) are in the page, in order; the top is at least the last op.
    assert [o["op_id"] for o in page["ops"]][0] == landed["op_id"]
    assert page["server_seq"] >= page["ops"][-1]["server_seq"]
    assert not page["has_more"]
    # Following the client's rule (cursor = last op's seq) nothing is missed afterwards either.
    after = pull(client, w, since=page["ops"][-1]["server_seq"])
    assert after["ops"] == [] and after["server_seq"] == page["ops"][-1]["server_seq"]


def test_pull_limit_is_capped_and_validated(client, w):
    survey_a_floor(client, w)
    pull(client, w, limit=0, status=422)
    pull(client, w, limit=501, status=422)
    assert client.get("/ops", params={"project_id": "nope"}, headers=HDR).status_code == 422


# -------------------------------------------------------------- materialised


def test_materialised_rows_follow_applied_ops_only(client, w):
    ids = survey_a_floor(client, w)
    s = w.session
    s.expire_all()

    dev = s.get(Device, uuid.UUID(ids["device"]))
    assert dev.status == "Issue"  # Bob's reviewed "No access" never landed (A7)
    assert dev.notes == "fresh"  # the superseded op never landed (D37)
    assert dev.pin == {"sheet": "s", "x": 3, "y": 4}
    assert dev.deleted_at is None and dev.deleted_by_id is None and dev.delete_reason is None
    # create(1) + status + pin + notes + delete + restore = 6; every applied op on it bumps.
    assert dev.version == 6
    assert dev.head_seq == s.get(Op, uuid.UUID(ids["delete_op"])).server_seq + 1  # the restore
    assert dev.level_id == w.l06.id

    lvl = s.get(Level, uuid.UUID(ids["level"]))
    assert (lvl.level, lvl.floor_order, lvl.numbering_group_id, lvl.in_scope, lvl.state) == (
        "07",
        7,
        w.group.id,
        True,
        "setup",
    )

    p = s.get(PunchItem, uuid.UUID(ids["punch"]))
    assert p.number == 1  # the assign op is materialised like a set
    assert p.tracking_status == "Closed" and str(p.date_closed) == "2026-10-10"
    assert p.sort_last is True and p.device_id == dev.id
    assert p.version == 5  # create, assign, closed, dated, sort_last

    end = s.get(CableEnd, uuid.UUID(ids["end"]))
    assert end.display_id == "C-01" and end.version == 2

    item = s.get(ReviewItem, uuid.UUID(ids["review_item"]))
    assert item.kind == "sync_conflict" and item.state == "open" and item.version == 1
    assert item.level_id == w.l06.id and str(item.op_b_id) == ids["review_op"]
    assert item.head_seq == s.scalar(
        select(Op.server_seq).where(Op.entity_id == item.id, Op.kind == "create")
    )

    link = s.get(Assignment, (w.l06.id, w.bob.id))
    assert link.deleted_at is not None and link.deleted_by_id == w.ann.id

    gone = s.get(Op, uuid.UUID(ids["delete_op"]))
    assert gone.state == "applied" and gone.reason == "duplicate pin"


def test_delete_materialises_who_when_why(client, w):
    d = w.create(w.ann, "device")
    gone = w.op(w.ann, "delete", "device", d["entity_id"], reason="placed twice")
    res = w.push(client, [d, gone])
    assert outcomes(res) == ["applied", "applied"]
    w.session.expire_all()
    dev = w.session.get(Device, uuid.UUID(d["entity_id"]))
    op = w.session.get(Op, uuid.UUID(gone["op_id"]))
    assert (dev.deleted_at, dev.deleted_by_id, dev.delete_reason) == (
        op.server_ts,
        w.ann.id,
        "placed twice",
    )
    assert (dev.version, dev.head_seq) == (2, op.server_seq)


def test_link_add_revives_a_removed_link(client, w):
    lvl = str(w.l06.id)
    key = {"user_id": str(w.bob.id)}
    add = w.op(
        w.ann, "link_add", "assignment", lvl, payload={**key, "assigned_by_id": str(w.ann.id)}
    )
    rm = w.op(w.ann, "link_remove", "assignment", lvl, payload=key)
    again = w.op(w.bob, "link_add", "assignment", lvl, payload=key)
    assert outcomes(w.push(client, [add, rm])) == ["applied", "applied"]
    w.session.expire_all()
    assert w.session.get(Assignment, (w.l06.id, w.bob.id)).deleted_at is not None
    assert outcomes(w.push(client, [again])) == ["applied"]
    w.session.expire_all()
    link = w.session.get(Assignment, (w.l06.id, w.bob.id))
    assert link.deleted_at is None and link.assigned_by_id == w.ann.id


def test_photo_links_materialise_and_replay(client, w):
    """D128 (T65): a photo linked to two devices and a connection end; one link removed; a
    caption edit by someone else alongside never conflicts with the links; replay rebuilds them."""
    d1, d2, e = w.create(w.ann, "device"), w.create(w.ann, "device"), w.create(w.ann, "cable_end")
    photo = w.create(w.ann, "photo", {"device_id": d1["entity_id"]})
    pid = photo["entity_id"]
    keys = [
        {"target_kind": "device", "target_id": d2["entity_id"]},
        {"target_kind": "cable_end", "target_id": e["entity_id"]},
    ]
    gid = str(uuid7())
    adds = [w.op(w.ann, "link_add", "photo_link", pid, payload=k, group_id=gid) for k in keys]
    assert outcomes(w.push(client, [d1, d2, e, photo, *adds])) == ["applied"] * 6
    caption = w.set(w.bob, "photo", pid, "subject", "ERP interior", photo["op_id"])
    rm = w.op(w.ann, "link_remove", "photo_link", pid, payload=keys[0])
    assert outcomes(w.push(client, [caption, rm])) == ["applied", "applied"]

    def live():
        w.session.expire_all()
        rows = w.session.scalars(select(PhotoLink).where(PhotoLink.deleted_at.is_(None))).all()
        return {(r.target_kind, str(r.target_id)) for r in rows}

    assert live() == {("cable_end", e["entity_id"])}
    before = snapshot(w.session)
    with Session(w.session.get_bind()) as s, s.begin():
        materialise.replay(s, w.project.id)
    assert snapshot(w.session) == before and live() == {("cable_end", e["entity_id"])}


def test_replayed_create_never_overwrites(client, w):
    d = w.create(w.ann, "device")
    s1 = w.set(w.ann, "device", d["entity_id"], "status", "Issue", d["op_id"])
    w.push(client, [d, s1])
    assert outcomes(w.push(client, [d])) == ["duplicate"]
    w.session.expire_all()
    assert w.session.get(Device, uuid.UUID(d["entity_id"])).status == "Issue"


def test_set_on_an_unknown_record_is_an_orphan_not_a_failure(client, w, caplog):
    ghost = str(uuid7())
    s1 = w.set(w.ann, "device", ghost, "notes", "x", None)
    with caplog.at_level("WARNING", logger="sync"):
        res = w.push(client, [s1])
    assert outcomes(res) == ["applied"]
    assert any("materialise_orphan" in r.message for r in caplog.records)
    assert w.session.get(Device, uuid.UUID(ghost)) is None


# --------------------------------------------------------------------- replay


def test_replay_of_the_op_log_equals_the_materialised_state(client, w):
    ids = survey_a_floor(client, w)
    before = snapshot(w.session)
    assert before["device"] and before["review_item"] and before["assignment"] and before["level"]

    with Session(w.session.get_bind()) as s, s.begin():
        n = materialise.replay(s, w.project.id)
    assert n == w.session.scalar(select(func.count()).select_from(Op).where(Op.state == "applied"))
    assert n == ids["last_seq"] - 2  # one review op and one superseded op are skipped

    after = snapshot(w.session)
    assert after == before


def test_replay_rebuilds_from_empty_tables(client, w):
    """Wipe what the ops built, replay, and the rows come back identical."""
    survey_a_floor(client, w)
    before = snapshot(w.session)
    created = {
        t: n
        for t, n in ((t, len(rows)) for t, rows in before.items())
        if t in ("device", "level", "punch_item", "cable_end", "review_item", "assignment")
    }
    assert all(created.values())

    tables = materialise.TABLES
    with Session(w.session.get_bind()) as s, s.begin():
        for name in ("assignment", "review_item", "punch_item", "cable_end", "device"):
            s.execute(delete(tables[name]))
        s.execute(delete(tables["level"]).where(tables["level"].c.level == "07"))
    gutted = snapshot(w.session)
    assert gutted["device"] == [] and gutted["review_item"] == [] and len(gutted["level"]) == 2
    with Session(w.session.get_bind()) as s, s.begin():
        materialise.replay(s, w.project.id, reset=False)
    assert snapshot(w.session) == before


# -------------------------------------------------------------- concurrency


def test_concurrent_pushes_leave_no_gaps_in_server_seq(w):
    """TP-7 (partial): eight installs push at once; `server_seq` is 1..n with no gap or
    duplicate and every punch item gets a distinct number."""
    engine = w.session.get_bind()
    threads, errors = [], []
    pushes_per_thread, ops_per_push = 4, 3

    def worker(user, n):
        try:
            for _ in range(pushes_per_thread):
                ops = [
                    sync.OpIn(**w.create(user, "punch_item", install=w.install(user, n)))
                    for _ in range(ops_per_push)
                ]
                with Session(engine) as s, s.begin():
                    sync.apply_push(s, sync.PushIn(project_id=w.project.id, since=None, ops=ops))
        except Exception as e:  # pragma: no cover - surfaced below
            errors.append(e)

    for n in range(8):
        t = threading.Thread(target=worker, args=(w.ann if n % 2 else w.bob, n))
        threads.append(t)
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []

    w.session.expire_all()
    seqs = sorted(w.session.scalars(select(Op.server_seq)))
    creates = 8 * pushes_per_thread * ops_per_push
    assert len(seqs) == 2 * creates  # one assign per create
    assert seqs == list(range(1, len(seqs) + 1))
    numbers = sorted(w.session.scalars(select(PunchItem.number)))
    assert numbers == list(range(1, creates + 1))
    assert w.session.get(NumberingGroup, w.group.id).counter_punch == creates
