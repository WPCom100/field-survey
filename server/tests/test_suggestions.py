"""Suggestion chips (T99, D174, D212): the `suggestion` table, app level only since T196
(D292 (9)) — on `/library/ops`, never in a project's stream — and project creation copying none
(every project reads the app library's)."""

import uuid
from datetime import UTC, datetime, timedelta

from conftest import HDR
from sqlalchemy import select

from app.ids import uuid7
from app.models import LibraryType, Op, Suggestion, User
from app.sync import LIBRARY_STREAM

ANN = {**HDR, "X-Survey-User": "Ann"}
T0 = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)


def push(client, path, body, status=200):
    r = client.post(path, json=body, headers=ANN)
    assert r.status_code == status, r.text
    return r.json()


def create_project(client, body):
    r = client.post("/projects", json=body, headers=ANN)
    assert r.status_code == 201, r.text
    return r.json()


def chip_op(user, stream, project_id, **row):
    eid = uuid7()
    payload = {"id": str(eid), "project_id": str(project_id) if project_id else None, **row}
    return eid, {
        "op_id": str(uuid7()),
        "project_id": str(stream),
        "user_id": str(user.id),
        "install_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ipad:Ann")),
        "client_ts": (T0 + timedelta(seconds=1)).isoformat(),
        "entity_kind": "suggestion",
        "entity_id": str(eid),
        "kind": "create",
        "change_type": "Master edit",
        "reason": "Suggestion",
        "payload": payload,
    }


def test_chips_live_in_the_app_library_only(client, session):
    user = User(id=uuid7(), name="Ann")
    session.add(user)
    session.commit()
    row = {
        "scope": "code",
        "ref": "X",
        "target": "connection_note",
        "text": "Missing DMX termination kit",
        "state": "draft",
    }
    eid, op = chip_op(user, LIBRARY_STREAM, None, **row)
    assert (
        push(client, "/library/ops", {"since": None, "ops": [op]})["results"][0]["outcome"]
        == "applied"
    )
    got = session.get(Suggestion, eid)
    assert (got.project_id, got.scope, got.ref, got.target, got.state) == (
        None,
        "code",
        "X",
        "connection_note",
        "draft",
    )
    # editing it is a library op too
    accept = {
        **op,
        "op_id": str(uuid7()),
        "kind": "set",
        "field": "state",
        "now": "accepted",
        "base_op_id": op["op_id"],
        "payload": None,
    }
    assert (
        push(client, "/library/ops", {"since": 1, "ops": [accept]})["results"][0]["outcome"]
        == "applied"
    )

    pid = create_project(client, {"name": "Tower", "levels": []})["id"]
    # in a project's stream every chip op is refused (T196): naming the project, naming none,
    # or setting the app chip
    _, mine = chip_op(user, pid, pid, **row)
    _, stray = chip_op(user, pid, None, **row)
    edit = {**accept, "op_id": str(uuid7()), "project_id": pid, "now": "rejected"}
    for bad in (mine, stray, edit):
        out = push(client, "/ops", {"project_id": pid, "ops": [bad]}, status=422)
        assert "library/ops" in str(out) and "never to a project" in str(out)
    # and an app chip naming a project is refused on the library stream
    _, owned = chip_op(user, LIBRARY_STREAM, pid, **row)
    push(client, "/library/ops", {"since": None, "ops": [owned]}, status=422)
    session.expire_all()
    assert session.get(Suggestion, eid).state == "accepted"
    assert session.scalars(select(Suggestion)).all() == [session.get(Suggestion, eid)]


def test_project_creation_copies_no_chips(client, session):
    source = create_project(client, {"name": "Source", "levels": []})
    sid = uuid.UUID(source["id"])
    assert "suggestions" not in source["copied"]
    app_type = LibraryType(
        id=uuid7(), project_id=None, model="PI1002", category="Station", state="accepted"
    )
    session.add(app_type)

    def chip(project_id, scope, ref, target, text):
        return Suggestion(
            id=uuid7(),
            project_id=project_id,
            scope=scope,
            ref=str(ref),
            target=target,
            text=text,
            state="accepted",
        )

    session.add_all(
        [
            chip(None, "type", app_type.id, "device_note", "Stuck buttons"),
            chip(None, "category", "Station", "device_note", "Empty box on wall."),
            chip(None, "code", "X", "punch_item", "Missing DMX termination kit"),
            # a source project's own chip (a row from before T196)
            chip(sid, "code", "0-10V", "connection_note", "Land 0-10V control wiring"),
        ]
    )
    session.commit()
    for body in ({"name": "Fresh"}, {"name": "Copy", "copy_from": {"project_id": str(sid)}}):
        out = create_project(client, body)
        pid = uuid.UUID(out["id"])
        assert "suggestions" not in out["copied"]
        assert session.scalars(select(Suggestion).where(Suggestion.project_id == pid)).all() == []
        ops = session.scalars(
            select(Op).where(
                Op.project_id == pid, Op.entity_kind.in_(("suggestion", "library_type"))
            )
        ).all()
        assert ops == []
