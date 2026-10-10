"""`POST /ops` apply loop (T09): PLAN §3.2 steps 1–7, every row of §3.3, D37 ordering."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import HDR
from sqlalchemy import func, select

from app import sync
from app.ids import uuid7
from app.models import Cable, FieldHead, Level, NumberingGroup, Op, Project, ReviewItem, Sheet, User

T0 = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


class World:
    """A project with one numbering group shared by levels 06 and 06M (D33), two users."""

    def __init__(self, session):
        self.session = session
        self.project = Project(id=uuid7(), name="Houston Methodist Centennial Tower")
        self.group = NumberingGroup(id=uuid7(), project_id=self.project.id, label="06/06M")
        self.l06 = Level(
            id=uuid7(), project_id=self.project.id, level="06", numbering_group_id=self.group.id
        )
        self.l06m = Level(
            id=uuid7(), project_id=self.project.id, level="06M", numbering_group_id=self.group.id
        )
        self.ann = User(id=uuid7(), name="Ann")
        self.bob = User(id=uuid7(), name="Bob")
        # One display sheet so ink layers have something to reference (deferred FKs, D76).
        self.sheet = Sheet(id=uuid7(), level_id=self.l06.id, kind="display")
        session.add_all(
            [self.project, self.group, self.l06, self.l06m, self.ann, self.bob, self.sheet]
        )
        session.commit()
        self.clock = T0

    def cable(self) -> Cable:
        """A cable row for one end to hang off (ends are unique per cable and side)."""
        c = Cable(id=uuid7(), project_id=self.project.id, cable="X")
        self.session.add(c)
        self.session.commit()
        return c

    @staticmethod
    def install(user: User, n: int = 1) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ipad:{user.name}:{n}"))

    def op(self, user, kind, entity_kind, entity_id=None, *, install=None, ts=None, **kw):
        self.clock += timedelta(seconds=1)
        return {
            "op_id": str(uuid7()),
            "project_id": str(self.project.id),
            "user_id": str(user.id),
            "install_id": install or self.install(user),
            "client_ts": (ts or self.clock).isoformat(),
            "entity_kind": entity_kind,
            "entity_id": str(entity_id or uuid7()),
            "kind": kind,
            "change_type": "Field survey",
            "reason": "test",
            **kw,
        }

    def create(self, user, entity_kind, extra=None, **kw):
        eid = str(uuid7())
        l06 = str(self.l06.id)
        required = {
            # Carries its ID like an imported device; D93's server-assigned IDs: test_numbering.
            "device": lambda: {
                "level_id": l06,
                "display_id": "06-01",
                "status": "Installed, untested",
            },
            "cable": lambda: {"project_id": str(self.project.id), "cable": "X"},
            "cable_end": lambda: {"cable_id": str(self.cable().id), "side": "A", "level_id": l06},
            "punch_item": lambda: {"level_id": l06, "item": "Run X", "type": "Cable not run"},
            "missing_part": lambda: {"level_id": l06, "part": "LVD card"},
            "photo": lambda: {"level_id": l06},
            "ink_layer": lambda: {"sheet_id": str(self.sheet.id), "user_id": str(user.id)},
            "level": lambda: {"project_id": str(self.project.id), "level": "07"},
        }.get(entity_kind, dict)()
        payload = {"id": eid, **required, **(extra or {})}
        return self.op(user, "create", entity_kind, eid, payload=payload, **kw)

    def set(self, user, entity_kind, eid, field, now, base, **kw):
        return self.op(user, "set", entity_kind, eid, field=field, now=now, base_op_id=base, **kw)

    def push(self, client, ops, since=None, status=200):
        r = client.post(
            "/ops",
            json={"project_id": str(self.project.id), "since": since, "ops": ops},
            headers=HDR,
        )
        assert r.status_code == status, r.text
        return r.json() if status != 500 else r.text

    def head(self, eid, field):
        self.session.expire_all()
        row = self.session.get(FieldHead, (uuid.UUID(eid), field))
        return str(row.op_id) if row else None

    def stored(self, op_id) -> Op:
        self.session.expire_all()
        return self.session.get(Op, uuid.UUID(op_id))

    def review_items(self) -> list[ReviewItem]:
        self.session.expire_all()
        return list(self.session.scalars(select(ReviewItem).order_by(ReviewItem.id)))

    def op_count(self) -> int:
        return self.session.scalar(select(func.count()).select_from(Op))


@pytest.fixture
def w(session):
    return World(session)


def outcomes(res):
    return [r["outcome"] for r in res["results"]]


# ------------------------------------------------------------------ transport


def test_push_requires_token(client, w):
    r = client.post("/ops", json={"project_id": str(w.project.id), "ops": []})
    assert r.status_code == 401


def test_unknown_project_is_404(client, w):
    ghost = str(uuid7())
    body = {"project_id": ghost, "ops": [{**w.create(w.ann, "device"), "project_id": ghost}]}
    assert client.post("/ops", json=body, headers=HDR).status_code == 404
    assert w.op_count() == 0


@pytest.mark.parametrize(
    "make, message",
    [
        (lambda w: w.create(w.ann, "nope"), "unknown entity_kind"),
        (lambda w: w.op(w.ann, "assign", "punch_item", field="number", now=1), "server-only"),
        (lambda w: w.op(w.ann, "set", "device", now="Issue"), "needs a field"),
        (
            lambda w: w.set(w.ann, "punch_item", uuid7(), "number", 3, None),
            "assigned by the server",
        ),
        (lambda w: w.create(w.ann, "punch_item", {"number": 3}), "assigned by the server"),
        (lambda w: w.set(w.ann, "device", uuid7(), "status", "Installed untested", None), "one of"),
        (lambda w: w.create(w.ann, "punch_item", {"owner": "ETC/EC"}), "one of"),
        (lambda w: w.set(w.ann, "device", uuid7(), "version", 9, None), "not settable"),
        (lambda w: w.set(w.ann, "device", uuid7(), "colour", "red", None), "not settable"),
        (
            lambda w: w.op(w.ann, "set", "device", field="status", now="Issue", change_type="Edit"),
            "change_type",
        ),
        (lambda w: w.op(w.ann, "link_add", "device", payload={"user_id": "x"}), "not allowed"),
        (lambda w: w.op(w.ann, "delete", "assignment"), "not allowed"),
        (lambda w: w.create(w.ann, "assignment"), "not allowed"),
        (lambda w: w.op(w.ann, "link_add", "assignment", payload={}), "needs payload.user_id"),
        (lambda w: {**w.create(w.ann, "device"), "project_id": str(uuid7())}, "project_id"),
        (lambda w: {**w.create(w.ann, "device"), "user_id": str(uuid7())}, "unknown user"),
    ],
)
def test_malformed_op_rejects_the_whole_push(client, w, make, message):
    ops = [w.create(w.ann, "device"), make(w)]
    res = w.push(client, ops, status=422)
    assert res["detail"]["index"] == 1 and message in res["detail"]["error"]
    assert w.op_count() == 0


def test_more_than_500_ops_is_422(client, w):
    ops = [w.create(w.ann, "device") for _ in range(501)]
    w.push(client, ops, status=422)


# ---------------------------------------------------------- steps 1, 2 and 7


def test_push_is_idempotent_by_op_id(client, w):
    create = w.create(w.ann, "punch_item")
    edit = w.set(w.ann, "punch_item", create["entity_id"], "notes", "x", create["op_id"])
    first = w.push(client, [create, edit])
    assert outcomes(first) == ["applied", "applied"]
    assert [r["server_seq"] for r in first["results"]] == [1, 3]  # the assign op took seq 2
    assert [o["kind"] for o in first["server_ops"]] == ["assign"]
    n = w.op_count()

    again = w.push(client, [create, edit])
    assert outcomes(again) == ["duplicate", "duplicate"]
    assert [r["server_seq"] for r in again["results"]] == [1, 3]
    assert again["server_ops"] == first["server_ops"]  # the number is handed back, not re-assigned
    assert again["server_seq"] == first["server_seq"] == 3
    assert w.op_count() == n


def test_create_assigns_display_numbers_per_group(client, w):
    p1 = w.create(w.ann, "punch_item")
    p2 = w.create(w.bob, "punch_item", {"level_id": str(w.l06m.id)})  # 06M shares 06's group
    part = w.create(w.ann, "missing_part")
    photo = w.create(w.ann, "photo")
    e1 = w.create(w.ann, "cable_end")
    e2 = w.create(w.ann, "cable_end", {"level_id": str(w.l06m.id)})
    res = w.push(client, [p1, p2, part, photo, e1, e2])
    assert outcomes(res) == ["applied"] * 6

    assigned = {o["entity_id"]: o for o in res["server_ops"]}
    assert [
        (assigned[o["entity_id"]]["field"], assigned[o["entity_id"]]["now"]) for o in (p1, p2)
    ] == [
        ("number", 1),
        ("number", 2),
    ]
    assert assigned[part["entity_id"]]["now"] == 1
    assert assigned[photo["entity_id"]]["now"] == 1
    assert (assigned[e1["entity_id"]]["now"], assigned[e2["entity_id"]]["now"]) == ("C-01", "C-02")

    a = assigned[p1["entity_id"]]
    assert a["kind"] == "assign" and a["state"] == "applied" and a["was"] is None
    assert a["install_id"] == str(sync.SERVER_INSTALL_ID)
    assert a["base_op_id"] == p1["op_id"] and a["user_id"] == str(w.ann.id)
    assert a["change_type"] == "Field survey" and a["server_seq"] == 2
    assert w.head(p1["entity_id"], "number") == a["op_id"]
    assert w.head(p1["entity_id"], "item") == p1["op_id"]  # D81: create seeds every payload head

    w.session.refresh(w.group)
    assert (
        w.group.counter_punch,
        w.group.counter_part,
        w.group.counter_photo,
        w.group.counter_cable,
    ) == (
        2,
        1,
        1,
        2,
    )
    # A third item continues the sequence; a replayed create never renumbers (TP-10).
    p3 = w.create(w.bob, "punch_item")
    res = w.push(client, [p1, p3])
    assert outcomes(res) == ["duplicate", "applied"]
    assert sorted(o["now"] for o in res["server_ops"] if o["entity_id"] == p3["entity_id"]) == [3]
    assert [o["now"] for o in res["server_ops"] if o["entity_id"] == p1["entity_id"]] == [1]


def test_create_without_a_level_stays_unnumbered(client, w):
    e = w.create(w.ann, "cable_end", {"level_id": None})
    res = w.push(client, [e])
    assert outcomes(res) == ["applied"] and res["server_ops"] == []
    assert w.head(e["entity_id"], "display_id") is None


def test_create_referencing_an_unknown_level_fails_the_whole_push(client, w):
    """Materialised tables keep their (deferred) foreign keys: nothing is stored, 409 (T10)."""
    ok = w.create(w.ann, "device")
    p = w.create(w.ann, "punch_item", {"level_id": str(uuid7())})
    res = w.push(client, [ok, p], status=409)
    assert res["detail"]["error"] == "integrity"
    w.session.rollback()
    assert w.op_count() == 0


def test_level_created_by_an_op_resolves_its_group_from_the_log(client, w):
    lvl = w.create(w.ann, "level", {"numbering_group_id": str(w.group.id)})
    p = w.create(w.ann, "punch_item", {"level_id": lvl["entity_id"]})
    res = w.push(client, [lvl, p])
    assert outcomes(res) == ["applied", "applied"]
    assert [o["now"] for o in res["server_ops"]] == [1]


def test_server_seq_is_contiguous_across_pushes(client, w):
    d = w.create(w.ann, "device")
    w.push(client, [d])
    p = w.create(w.bob, "punch_item")
    res = w.push(client, [p, w.set(w.bob, "device", d["entity_id"], "notes", "n", d["op_id"])])
    seqs = sorted(w.session.scalars(select(Op.server_seq)))
    assert seqs == list(range(1, len(seqs) + 1)) and res["server_seq"] == seqs[-1]


# ------------------------------------------------------------------- step 3


def test_set_on_the_head_applies_and_moves_it(client, w):
    d = w.create(w.ann, "device")
    s1 = w.set(w.ann, "device", d["entity_id"], "status", "Issue", d["op_id"])
    s2 = w.set(w.bob, "device", d["entity_id"], "status", "No access", s1["op_id"])
    res = w.push(client, [d, s1, s2])
    assert outcomes(res) == ["applied"] * 3
    assert w.head(d["entity_id"], "status") == s2["op_id"]
    assert w.stored(s2["op_id"]).state == "applied"


ROWS = [
    # (row, entity_kind, create extra, field, value A, value B)
    ("enum", "device", {}, "status", "Issue", "No access"),
    ("free text", "device", {}, "notes", "Run, not terminated", "Not run"),
    ("number", "cable", {"qty": 1}, "qty", 2, 3),
    (
        "pin position",
        "device",
        {},
        "pin",
        {"sheet": "s", "x": 1, "y": 2},
        {"sheet": "s", "x": 3, "y": 4},
    ),
    ("neuron id", "device", {}, "neuron_id", "0123456789AB", "0123456789AC"),
]


@pytest.mark.parametrize("row, kind, extra, field, a, b", ROWS, ids=[r[0] for r in ROWS])
def test_different_values_from_different_users_go_to_review(
    client, w, row, kind, extra, field, a, b
):
    rec = w.create(w.ann, kind, extra)
    ann = w.set(w.ann, kind, rec["entity_id"], field, a, rec["op_id"])
    w.push(client, [rec, ann])
    bob = w.set(w.bob, kind, rec["entity_id"], field, b, rec["op_id"], ruling_id=str(uuid7()))
    res = w.push(client, [bob])

    assert outcomes(res) == ["review"]
    assert w.head(rec["entity_id"], field) == ann["op_id"]  # first-arrived value stays official
    assert w.stored(bob["op_id"]).state == "review"
    (item,) = w.review_items()
    assert str(item.id) == res["results"][0]["review_item_id"]
    assert (item.kind, item.state, str(item.op_a_id), str(item.op_b_id)) == (
        "sync_conflict",
        "open",
        ann["op_id"],
        bob["op_id"],
    )
    assert item.subject == {"entity_kind": kind, "entity_id": rec["entity_id"], "field": field} | (
        {"level_id": str(w.l06.id)} if kind == "device" else {}
    )
    assert item.level_id == (w.l06.id if kind == "device" else None)
    assert [(c["side"], c["value"]) for c in item.candidates] == [("A", a), ("B", b)]
    assert item.ruling is True  # step 6: a ruling op in the conflict flags the item
    # The item reaches the iPads as a server `create` op (D84).
    (create,) = res["server_ops"]
    assert (create["entity_kind"], create["kind"], create["entity_id"]) == (
        "review_item",
        "create",
        str(item.id),
    )
    assert create["payload"]["subject"] == item.subject and create["base_op_id"] == bob["op_id"]
    assert w.head(str(item.id), "state") == create["op_id"]


@pytest.mark.parametrize("row, kind, extra, field, a, b", ROWS, ids=[r[0] for r in ROWS])
def test_same_value_from_different_users_merges(client, w, row, kind, extra, field, a, b):
    rec = w.create(w.ann, kind, extra)
    ann = w.set(w.ann, kind, rec["entity_id"], field, a, rec["op_id"])
    bob = w.set(w.bob, kind, rec["entity_id"], field, a, rec["op_id"])
    res = w.push(client, [rec, ann, bob])
    assert outcomes(res) == ["applied"] * 3
    assert w.head(rec["entity_id"], field) == bob["op_id"]
    assert w.review_items() == [] and res["server_ops"] == []


def test_field_group_is_reviewed_as_one(client, w):
    p = w.create(w.ann, "punch_item")
    ann = w.set(w.ann, "punch_item", p["entity_id"], "tracking_status", "In progress", p["op_id"])
    w.push(client, [p, ann])
    gid = str(uuid7())
    close = w.set(
        w.bob, "punch_item", p["entity_id"], "tracking_status", "Closed", p["op_id"], group_id=gid
    )
    dated = w.set(
        w.bob, "punch_item", p["entity_id"], "date_closed", "2026-10-10", p["op_id"], group_id=gid
    )
    res = w.push(client, [close, dated])

    assert outcomes(res) == ["review", "review"]
    assert len({r["review_item_id"] for r in res["results"]}) == 1
    assert w.head(p["entity_id"], "tracking_status") == ann["op_id"]
    assert w.head(p["entity_id"], "date_closed") is None  # the non-conflicting half waits too
    (item,) = w.review_items()
    assert item.subject["group_id"] == gid and item.subject["fields"] == [
        "tracking_status",
        "date_closed",
    ]
    assert [(c["side"], c["field"]) for c in item.candidates] == [
        ("A", "tracking_status"),
        ("B", "tracking_status"),
        ("B", "date_closed"),
    ]


def test_group_without_conflict_applies_and_chains_heads(client, w):
    gid = str(uuid7())
    d = w.create(w.ann, "device", group_id=gid)
    s = w.set(w.ann, "device", d["entity_id"], "status", "Issue", d["op_id"], group_id=gid)
    n = w.set(w.ann, "device", d["entity_id"], "notes", "LVD missing", d["op_id"], group_id=gid)
    res = w.push(client, [d, s, n])
    assert outcomes(res) == ["applied"] * 3
    assert w.head(d["entity_id"], "status") == s["op_id"]
    assert w.head(d["entity_id"], "notes") == n["op_id"]
    assert outcomes(w.push(client, [d, s, n])) == ["duplicate"] * 3


def test_group_with_a_create_still_applies_the_create(client, w):
    d = w.create(w.ann, "device")
    ann = w.set(w.ann, "device", d["entity_id"], "status", "Issue", d["op_id"])
    w.push(client, [d, ann])
    gid = str(uuid7())
    bob = w.set(w.bob, "device", d["entity_id"], "status", "No access", d["op_id"], group_id=gid)
    p = w.create(w.bob, "punch_item", {"device_id": d["entity_id"]}, group_id=gid)
    res = w.push(client, [bob, p])
    assert outcomes(res) == ["review", "applied"]
    assert [o["kind"] for o in res["server_ops"]] == ["assign", "create"]


# ------------------------------------------------------------- step 3, D37


def test_same_user_on_two_ipads_never_reviews(client, w):
    d = w.create(w.ann, "device")
    w.push(client, [d])
    newer = w.set(
        w.ann,
        "device",
        d["entity_id"],
        "status",
        "Issue",
        d["op_id"],
        install=w.install(w.ann, 1),
        ts=T0 + timedelta(minutes=5),
    )
    older = w.set(
        w.ann,
        "device",
        d["entity_id"],
        "status",
        "No access",
        d["op_id"],
        install=w.install(w.ann, 2),
        ts=T0 + timedelta(minutes=2),
    )
    # The newer edit arrives first: the older one is superseded, nothing is reviewed.
    res = w.push(client, [newer])
    res2 = w.push(client, [older])
    assert outcomes(res) == ["applied"] and outcomes(res2) == ["superseded"]
    assert w.head(d["entity_id"], "status") == newer["op_id"]
    assert w.stored(older["op_id"]).state == "superseded"
    assert w.stored(older["op_id"]).server_seq is not None
    assert w.review_items() == []

    # Arriving in client_ts order, both apply and the newer one wins.
    d2 = w.create(w.ann, "device")
    w.push(client, [d2])
    a = w.set(
        w.ann, "device", d2["entity_id"], "notes", "first", d2["op_id"], install=w.install(w.ann, 2)
    )
    b = w.set(
        w.ann,
        "device",
        d2["entity_id"],
        "notes",
        "second",
        d2["op_id"],
        install=w.install(w.ann, 1),
    )
    assert outcomes(w.push(client, [a])) == ["applied"]
    assert outcomes(w.push(client, [b])) == ["applied"]
    assert w.head(d2["entity_id"], "notes") == b["op_id"]
    assert w.review_items() == []


def test_same_user_crossing_their_own_delete_applies(client, w):
    d = w.create(w.ann, "device")
    w.push(client, [d])
    gone = w.op(w.ann, "delete", "device", d["entity_id"], install=w.install(w.ann, 1))
    edit = w.set(
        w.ann, "device", d["entity_id"], "notes", "n", d["op_id"], install=w.install(w.ann, 2)
    )
    assert outcomes(w.push(client, [gone])) == ["applied"]
    assert outcomes(w.push(client, [edit], since=1)) == ["applied"]
    assert w.review_items() == []


# ------------------------------------------------------------------- step 4


def test_delete_vs_newer_edit_by_another_user_is_reviewed(client, w):
    d = w.create(w.ann, "device")
    first = w.push(client, [d])
    edit = w.set(w.bob, "device", d["entity_id"], "notes", "LVD missing", d["op_id"])
    edited = w.push(client, [edit])
    edit_seq = edited["results"][0]["server_seq"]

    # Ann deletes without having pulled Bob's edit (her cursor is before it).
    gone = w.op(w.ann, "delete", "device", d["entity_id"])
    res = w.push(client, [gone], since=first["server_seq"])
    assert outcomes(res) == ["review"]
    assert w.head(d["entity_id"], "deleted_at") is None
    (item,) = w.review_items()
    assert (str(item.op_a_id), str(item.op_b_id), item.subject["field"]) == (
        edit["op_id"],
        gone["op_id"],
        "deleted_at",
    )
    assert [(c["side"], c["field"], c["value"]) for c in item.candidates] == [
        ("A", "notes", "LVD missing"),
        ("B", "deleted_at", True),
    ]

    # Having pulled it, the same delete applies.
    gone2 = w.op(w.ann, "delete", "device", d["entity_id"])
    assert outcomes(w.push(client, [gone2], since=edit_seq)) == ["applied"]
    assert w.head(d["entity_id"], "deleted_at") == gone2["op_id"]


def test_delete_without_a_cursor_treats_every_other_edit_as_unseen(client, w):
    d = w.create(w.ann, "device")
    edit = w.set(w.bob, "device", d["entity_id"], "notes", "n", d["op_id"])
    w.push(client, [d, edit])
    assert outcomes(w.push(client, [w.op(w.ann, "delete", "device", d["entity_id"])])) == ["review"]


def test_edit_vs_existing_delete_is_reviewed(client, w):
    d = w.create(w.ann, "device")
    gone = w.op(w.ann, "delete", "device", d["entity_id"])
    w.push(client, [d, gone])
    edit = w.set(w.bob, "device", d["entity_id"], "status", "Issue", d["op_id"])
    res = w.push(client, [edit])
    assert outcomes(res) == ["review"]
    assert w.head(d["entity_id"], "status") == d["op_id"]
    (item,) = w.review_items()
    assert (str(item.op_a_id), str(item.op_b_id), item.subject["field"]) == (
        gone["op_id"],
        edit["op_id"],
        "status",
    )


def test_delete_vs_delete_merges(client, w):
    d = w.create(w.ann, "device")
    w.push(client, [d])
    a = w.op(w.ann, "delete", "device", d["entity_id"])
    b = w.op(w.bob, "delete", "device", d["entity_id"])
    assert outcomes(w.push(client, [a])) == ["applied"]
    assert outcomes(w.push(client, [b], since=2)) == ["applied"]
    assert w.head(d["entity_id"], "deleted_at") == b["op_id"]
    assert w.review_items() == []


def test_restore_keeps_history_and_crossing_delete_is_reviewed(client, w):
    d = w.create(w.ann, "device")
    gone = w.op(w.ann, "delete", "device", d["entity_id"])
    w.push(client, [d, gone])
    back = w.op(w.bob, "restore", "device", d["entity_id"], base_op_id=gone["op_id"])
    assert outcomes(w.push(client, [back])) == ["applied"]
    assert w.head(d["entity_id"], "deleted_at") == back["op_id"]
    assert [o.kind for o in w.session.scalars(select(Op).order_by(Op.server_seq))] == [
        "create",
        "delete",
        "restore",
    ]
    # Ann, on another iPad that never saw the restore, deletes again on the old base.
    again = w.op(w.ann, "delete", "device", d["entity_id"], base_op_id=gone["op_id"])
    res = w.push(client, [again], since=2)
    assert outcomes(res) == ["review"]
    (item,) = w.review_items()
    assert (str(item.op_a_id), str(item.op_b_id)) == (back["op_id"], again["op_id"])
    assert [(c["side"], c["value"]) for c in item.candidates] == [("A", False), ("B", True)]


# ------------------------------------------------------------------- step 5


def test_links_add_add_unions_and_remove_vs_newer_add_reviews(client, w):
    lvl = str(w.l06.id)
    key_bob = {"user_id": str(w.bob.id)}
    key_ann = {"user_id": str(w.ann.id)}
    add1 = w.op(w.ann, "link_add", "assignment", lvl, payload=key_bob)
    add2 = w.op(w.bob, "link_add", "assignment", lvl, payload=key_ann)
    res = w.push(client, [add1, add2])
    assert outcomes(res) == ["applied", "applied"]
    add2_seq = res["results"][1]["server_seq"]

    # Ann removes Bob's addition without having pulled it → review.
    rm = w.op(w.ann, "link_remove", "assignment", lvl, payload=key_ann)
    res = w.push(client, [rm], since=add2_seq - 1)
    assert outcomes(res) == ["review"]
    (item,) = w.review_items()
    assert (str(item.op_a_id), str(item.op_b_id)) == (add2["op_id"], rm["op_id"])
    assert item.subject["field"].startswith("link:") and item.candidates[0]["value"] == key_ann

    # After pulling it the removal applies; removing one's own link always applies.
    rm2 = w.op(w.ann, "link_remove", "assignment", lvl, payload=key_ann)
    assert outcomes(w.push(client, [rm2], since=add2_seq)) == ["applied"]
    own = w.op(w.ann, "link_remove", "assignment", lvl, payload=key_bob)
    assert outcomes(w.push(client, [own])) == ["applied"]
    # Re-adding after a removal is a plain add; removing an already removed link merges.
    readd = w.op(w.bob, "link_add", "assignment", lvl, payload=key_ann)
    assert outcomes(w.push(client, [readd])) == ["applied"]
    rm3 = w.op(w.ann, "link_remove", "assignment", lvl, payload=key_bob)
    assert outcomes(w.push(client, [rm3])) == ["applied"]


def test_part_source_link_key_is_matched_as_a_whole(client, w):
    part = w.create(w.ann, "missing_part")
    w.push(client, [part])
    t1 = {"target_kind": "punch", "target_id": str(uuid7())}
    t2 = {"target_kind": "device", "target_id": str(uuid7())}
    add = w.op(w.bob, "link_add", "part_source", part["entity_id"], payload=t1)
    res = w.push(client, [add])
    rm_other = w.op(w.ann, "link_remove", "part_source", part["entity_id"], payload=t2)
    rm_same = w.op(w.ann, "link_remove", "part_source", part["entity_id"], payload=t1)
    assert outcomes(w.push(client, [rm_other, rm_same], since=res["server_seq"] - 1)) == [
        "applied",
        "review",
    ]


# ----------------------------------------------------- attachments, ink layers


def test_attachments_and_ink_layers_never_conflict(client, w):
    photo = w.create(w.ann, "photo")
    ink = w.create(w.ann, "ink_layer")
    w.push(client, [photo, ink])
    a = w.set(w.ann, "photo", photo["entity_id"], "markup_blob", "aa" * 32, photo["op_id"])
    b = w.set(w.bob, "photo", photo["entity_id"], "markup_blob", "bb" * 32, photo["op_id"])
    ia = w.set(w.ann, "ink_layer", ink["entity_id"], "drawing_blob", "cc" * 32, ink["op_id"])
    ib = w.set(w.bob, "ink_layer", ink["entity_id"], "drawing_blob", "dd" * 32, ink["op_id"])
    res = w.push(client, [a, b, ia, ib])
    assert outcomes(res) == ["applied"] * 4
    assert w.head(photo["entity_id"], "markup_blob") == b["op_id"]
    assert w.head(ink["entity_id"], "drawing_blob") == ib["op_id"]
    assert w.review_items() == []
    # Other photo fields still conflict as free text.
    ca = w.set(w.ann, "photo", photo["entity_id"], "subject", "LVD", photo["op_id"])
    cb = w.set(w.bob, "photo", photo["entity_id"], "subject", "Panel", photo["op_id"])
    assert outcomes(w.push(client, [ca, cb])) == ["applied", "review"]


# ------------------------------------------------------------ one transaction


def test_push_is_one_transaction(client, w, monkeypatch):
    calls = {"n": 0}
    real = sync.Push.assign

    def flaky(self, create):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return real(self, create)

    monkeypatch.setattr(sync.Push, "assign", flaky)
    p1, p2 = w.create(w.ann, "punch_item"), w.create(w.ann, "punch_item")
    w.push(client, [p1, p2], status=500)
    w.session.rollback()
    assert w.op_count() == 0
    w.session.refresh(w.group)
    assert w.group.counter_punch == 0
    # The retry after the fault numbers from 1.
    monkeypatch.setattr(sync.Push, "assign", real)
    res = w.push(client, [p1, p2])
    assert outcomes(res) == ["applied", "applied"]
    assert [o["now"] for o in res["server_ops"]] == [1, 2]
