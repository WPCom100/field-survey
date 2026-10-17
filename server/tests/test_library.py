"""`/library/ops` (T61, D65, D184): the app library's own op log — same op format, apply loop,
conflict review and history as a project's, stored without a project and numbered on its own;
a type promoted from project A is copied into a new project B."""

import uuid
from datetime import UTC, datetime, timedelta

from conftest import HDR
from sqlalchemy import select

from app.ids import uuid7
from app.models import LibraryType, Op, ReviewItem, User
from app.sync import LIBRARY_STREAM

ANN = {**HDR, "X-Survey-User": "Ann"}
T0 = datetime(2026, 10, 15, 9, 0, tzinfo=UTC)


class Lib:
    def __init__(self, session):
        self.session = session
        self.ann = User(id=uuid7(), name="Ann")
        self.bob = User(id=uuid7(), name="Bob")
        session.add_all([self.ann, self.bob])
        session.commit()
        self.clock = T0

    def op(self, user, kind, entity_id, *, stream=LIBRARY_STREAM, entity_kind="library_type", **kw):
        self.clock += timedelta(seconds=1)
        return {
            "op_id": str(uuid7()),
            "project_id": str(stream),
            "user_id": str(user.id),
            "install_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"ipad:{user.name}")),
            "client_ts": self.clock.isoformat(),
            "entity_kind": entity_kind,
            "entity_id": str(entity_id),
            "kind": kind,
            "change_type": "Master edit",
            "reason": "Device-type library",
            **kw,
        }

    def create(self, user, model, **payload):
        eid = uuid7()
        body = {"id": str(eid), "project_id": None, "model": model, "state": "draft", **payload}
        return eid, self.op(user, "create", eid, payload=body)

    def push(self, client, ops, since=None, status=200):
        r = client.post("/library/ops", json={"since": since, "ops": ops}, headers=ANN)
        assert r.status_code == status, r.text
        return r.json()

    def pull(self, client, since=0):
        r = client.get("/library/ops", params={"since": since}, headers=ANN)
        assert r.status_code == 200, r.text
        return r.json()


def test_library_ops_apply_number_on_their_own_and_pull_back(client, session):
    w = Lib(session)
    eid, create = w.create(w.ann, "P-NSPS-D-KIT", category="NSPS")
    out = w.push(client, [create])
    assert [r["outcome"] for r in out["results"]] == ["applied"] and out["server_seq"] == 1
    accept = w.op(w.ann, "set", eid, field="state", now="accepted", base_op_id=create["op_id"])
    assert w.push(client, [accept], since=1)["server_seq"] == 2
    session.expire_all()
    row = session.get(LibraryType, eid)
    assert row is not None and row.project_id is None and row.state == "accepted"
    stored = session.scalars(select(Op).where(Op.entity_id == eid).order_by(Op.server_seq)).all()
    assert [(o.project_id, o.server_seq) for o in stored] == [(None, 1), (None, 2)]
    pulled = w.pull(client)
    assert pulled["server_seq"] == 2 and not pulled["has_more"]
    assert [o["op_id"] for o in pulled["ops"]] == [create["op_id"], accept["op_id"]]
    assert {o["project_id"] for o in pulled["ops"]} == {str(LIBRARY_STREAM)}
    assert w.pull(client, since=2)["ops"] == []
    # a project's log numbers from 1 regardless (its own sequence)
    project = client.post(
        "/projects", json={"name": "Tower", "levels": [{"level": "06M"}]}, headers=ANN
    )
    assert project.status_code == 201, project.text
    assert project.json()["server_seq"] >= 1
    # the same push again is a duplicate: same seqs, nothing new
    again = w.push(client, [create, accept])
    assert [r["server_seq"] for r in again["results"]] == [1, 2] and again["server_seq"] == 2


def test_two_users_on_one_field_raise_a_library_review_item(client, session):
    w = Lib(session)
    eid, create = w.create(w.ann, "PI1002", category="Station")
    w.push(client, [create])
    a = w.op(w.ann, "set", eid, field="aliases", now=["PI-1002"], base_op_id=create["op_id"])
    b = w.op(w.bob, "set", eid, field="aliases", now=["PI1002-W"], base_op_id=create["op_id"])
    w.push(client, [a], since=1)
    out = w.push(client, [b], since=1)
    assert out["results"][0]["outcome"] == "review"
    session.expire_all()
    items = session.scalars(select(ReviewItem)).all()
    assert len(items) == 1 and items[0].project_id is None and items[0].kind == "sync_conflict"
    assert (
        items[0].subject["entity_kind"] == "library_type" and items[0].subject["field"] == "aliases"
    )
    assert session.get(LibraryType, eid).aliases == ["PI-1002"]  # first arrived is official
    # the review item's create op is in the library log, so every iPad pulls it
    made = [o for o in w.pull(client)["ops"] if o["entity_kind"] == "review_item"]
    assert len(made) == 1 and made[0]["kind"] == "create"
    # on the wire (and on the iPad) the item belongs to the stream, in Postgres to no project
    assert made[0]["project_id"] == made[0]["payload"]["project_id"] == str(LIBRARY_STREAM)
    # resolving it from an iPad is a Reconcile set on the item, which the library log takes
    item = str(items[0].id)
    done = w.op(
        w.bob,
        "set",
        item,
        entity_kind="review_item",
        field="state",
        now="resolved",
        base_op_id=made[0]["op_id"],
    )
    done["change_type"] = "Reconcile"
    assert w.push(client, [done])["results"][0]["outcome"] == "applied"
    session.expire_all()
    assert session.get(ReviewItem, items[0].id).state == "resolved"


def test_the_library_log_takes_app_library_types_only(client, session):
    w = Lib(session)
    # not a library record (vocab rides the library stream since T104)
    w.push(client, [w.op(w.ann, "create", uuid7(), entity_kind="device", payload={})], status=422)
    # a library type naming a project
    eid = uuid7()
    owned = {"id": str(eid), "project_id": str(uuid7()), "model": "X", "state": "draft"}
    w.push(client, [w.op(w.ann, "create", eid, payload=owned)], status=422)
    # an op naming a project instead of the stream
    _, create = w.create(w.ann, "Y")
    w.push(client, [{**create, "project_id": str(uuid7())}], status=422)
    # and /ops refuses both the stream id and app-library types in a project push
    r = client.post("/ops", json={"project_id": str(LIBRARY_STREAM), "ops": [create]}, headers=ANN)
    assert r.status_code == 422 and "library/ops" in r.text
    assert session.scalars(select(Op)).all() == []
    project = client.post("/projects", json={"name": "Tower", "levels": []}, headers=ANN).json()
    stray = {**create, "project_id": project["id"]}
    r = client.post("/ops", json={"project_id": project["id"], "ops": [stray]}, headers=ANN)
    assert r.status_code == 422 and "library/ops" in r.text


def test_a_type_promoted_from_project_a_appears_in_new_project_b(client, session):
    w = Lib(session)
    a = client.post(
        "/projects", json={"name": "A", "levels": [{"level": "06M"}]}, headers=ANN
    ).json()
    # project A accepts its own type
    tid = uuid7()
    ptype = {
        "id": str(tid),
        "project_id": a["id"],
        "model": "P-TS18-E",
        "category": "Touchscreen",
        "id_scheme": "level_number",
        "default_cables": [{"code": "N", "to": "switch", "far": None, "single_row": False}],
        "state": "accepted",
    }
    r = client.post(
        "/ops",
        json={
            "project_id": a["id"],
            "ops": [w.op(w.ann, "create", tid, stream=a["id"], payload=ptype)],
        },
        headers=ANN,
    )
    assert r.status_code == 200 and r.json()["results"][0]["outcome"] == "applied", r.text
    # Promote: a new app-library row pointing back at the project's type
    lid, promote = w.create(
        w.ann,
        "P-TS18-E",
        category="Touchscreen",
        id_scheme="level_number",
        default_cables=ptype["default_cables"],
        state="accepted",
        promoted_from_id=str(tid),
    )
    w.push(client, [promote])
    session.expire_all()
    assert session.get(LibraryType, lid).promoted_from_id == tid
    # a new project copies the app library's accepted types
    b = client.post(
        "/projects", json={"name": "B", "levels": [{"level": "01"}]}, headers=ANN
    ).json()
    assert b["copied"]["library_types"] == 1
    pulled = client.get("/ops", params={"project_id": b["id"]}, headers=ANN).json()["ops"]
    copies = [o for o in pulled if o["entity_kind"] == "library_type"]
    assert len(copies) == 1
    assert (
        copies[0]["payload"]["model"] == "P-TS18-E"
        and copies[0]["payload"]["project_id"] == b["id"]
    )
    assert copies[0]["payload"]["default_cables"] == ptype["default_cables"]
    assert copies[0]["payload"]["state"] == "accepted"
