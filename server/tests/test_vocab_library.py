"""App-level vocabulary and pin shapes (T104, D214): `vocab` rows with no project on
`/library/ops`, project creation copying the accepted ones (canonical / variant pairs kept), and
the app library's shape per role that the floor PDF draws."""

import uuid
from datetime import UTC, datetime, timedelta

from conftest import HDR
from PIL import Image, ImageDraw
from sqlalchemy import select

from app.ids import uuid7
from app.jobs.floor_pdf import draw_pin
from app.models import RuleParam, User, Vocab
from app.roles import DEFAULT_PIN_SHAPE, pin_shapes
from app.sync import LIBRARY_STREAM

ANN = {**HDR, "X-Survey-User": "Ann"}
T0 = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)


def push(client, path, body, status=200):
    r = client.post(path, json=body, headers=ANN)
    assert r.status_code == status, r.text
    return r.json()


def create_project(client, body):
    r = client.post("/projects", json=body, headers=ANN)
    assert r.status_code == 201, r.text
    return r.json()


def vocab_op(user, stream, project_id, **row):
    eid = uuid7()
    payload = {"id": str(eid), "project_id": str(project_id) if project_id else None, **row}
    return eid, {
        "op_id": str(uuid7()),
        "project_id": str(stream),
        "user_id": str(user.id),
        "install_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ipad:Ann")),
        "client_ts": (T0 + timedelta(seconds=1)).isoformat(),
        "entity_kind": "vocab",
        "entity_id": str(eid),
        "kind": "create",
        "change_type": "Master edit",
        "reason": "Vocabulary",
        "payload": payload,
    }


def test_app_vocabulary_on_the_library_stream_and_project_vocabulary_on_ops(client, session):
    user = User(id=uuid7(), name="Ann")
    session.add(user)
    session.commit()
    row = {"list": "type", "value": "Echo relay panel", "state": "draft"}
    eid, op = vocab_op(user, LIBRARY_STREAM, None, **row)
    out = push(client, "/library/ops", {"since": None, "ops": [op]})
    assert out["results"][0]["outcome"] == "applied"
    got = session.get(Vocab, eid)
    assert (got.project_id, got.list, got.value, got.state) == (
        None,
        "type",
        "Echo relay panel",
        "draft",
    )
    pid = create_project(client, {"name": "Tower", "levels": []})["id"]
    _, stray = vocab_op(user, pid, None, **row)
    assert "library/ops" in str(
        push(client, "/ops", {"project_id": pid, "ops": [stray]}, status=422)
    )
    _, owned = vocab_op(user, LIBRARY_STREAM, pid, **row)
    push(client, "/library/ops", {"since": None, "ops": [owned]}, status=422)
    peid, mine = vocab_op(user, pid, pid, **row)
    out = push(client, "/ops", {"project_id": pid, "ops": [mine]})
    assert out["results"][0]["outcome"] == "applied"
    assert session.get(Vocab, peid).project_id == uuid.UUID(pid)


def test_project_creation_copies_accepted_app_vocabulary_with_its_pairs(client, session):
    source = create_project(client, {"name": "Source", "levels": []})
    sid = uuid.UUID(source["id"])

    def v(project_id, list_, value, canonical=None, state="accepted", deleted=False):
        row = Vocab(
            id=uuid7(),
            project_id=project_id,
            list=list_,
            value=value,
            canonical_of_id=canonical.id if canonical else None,
            state=state,
            deleted_at=datetime.now(UTC) if deleted else None,
        )
        session.add(row)
        session.flush()
        return row

    doc = v(None, "model_map", "P-DOC-W")
    v(None, "model_map", "P-DOC-W-WD", doc)
    draft = v(None, "model_map", "P-XYZ", state="draft")
    v(None, "model_map", "P-XYZ-1", draft)  # its canonical is a draft: not copied
    v(None, "type", "Echo relay panel")
    v(None, "type", "Gone", deleted=True)
    v(None, "type", "Rejected", state="rejected")
    # the source's own: one duplicate of an app value, one variant of the app's canonical
    sdoc = v(sid, "model_map", "p-doc-w")
    v(sid, "model_map", "P-DOC-W-4Z", sdoc)
    v(sid, "level_alias", "06M")
    session.commit()

    def rows(pid):
        got = session.scalars(select(Vocab).where(Vocab.project_id == pid)).all()
        by_id = {r.id: r for r in got}
        return {
            (
                r.list,
                r.value,
                by_id[r.canonical_of_id].value if r.canonical_of_id else None,
            )
            for r in got
        }

    fresh = create_project(client, {"name": "Fresh", "levels": []})
    assert fresh["copied"]["vocab"] == 3
    assert rows(uuid.UUID(fresh["id"])) == {
        ("model_map", "P-DOC-W", None),
        ("model_map", "P-DOC-W-WD", "P-DOC-W"),
        ("type", "Echo relay panel", None),
    }

    copy = create_project(client, {"name": "Copy", "copy_from": {"project_id": str(sid)}})
    assert copy["copied"]["vocab"] == 5
    assert rows(uuid.UUID(copy["id"])) == {
        ("model_map", "P-DOC-W", None),
        ("model_map", "P-DOC-W-WD", "P-DOC-W"),
        ("model_map", "P-DOC-W-4Z", "P-DOC-W"),  # points at the app value's copy
        ("type", "Echo relay panel", None),
        ("level_alias", "06M", None),
    }


def test_pin_shapes_follow_the_app_library(session):
    assert pin_shapes(session) == DEFAULT_PIN_SHAPE
    assert DEFAULT_PIN_SHAPE["station"] == "circle" and DEFAULT_PIN_SHAPE["other"] == "octagon"
    session.add(
        RuleParam(
            id=uuid7(),
            project_id=None,
            rule_id="pin",
            key="shape",
            value={"station": "square", "sensor": "blob", "nobody": "circle"},
            state="accepted",
        )
    )
    session.commit()
    shapes = pin_shapes(session)
    assert shapes["station"] == "square"
    assert shapes["sensor"] == "diamond"  # an unknown shape is ignored
    assert "nobody" not in shapes

    def corner_drawn(shapes):
        img = Image.new("RGB", (40, 40), (0, 0, 0))
        draw_pin(ImageDraw.Draw(img), 20, 20, "station", "Complete", 20, shapes=shapes)
        return img.getpixel((12, 12)) != (0, 0, 0)  # inside the square, outside the circle

    assert not corner_drawn(None)
    assert corner_drawn(shapes)


def test_pin_shapes_are_not_copied_into_a_new_project(client, session):
    session.add(
        RuleParam(
            id=uuid7(),
            project_id=None,
            rule_id="pin",
            key="shape",
            value={"station": "square"},
            state="accepted",
        )
    )
    session.commit()
    pid = uuid.UUID(create_project(client, {"name": "Tower", "levels": []})["id"])
    assert not session.scalars(select(RuleParam).where(RuleParam.project_id == pid)).all()
