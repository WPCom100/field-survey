"""Suggestion chips (T99, D174, D212): the `suggestion` table at two scopes — the app library's
on `/library/ops`, a project's on `/ops` — and project creation copying the accepted ones, a
type's chips pointing at the type's copy."""

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


def test_app_chips_on_the_library_stream_and_project_chips_on_ops(client, session):
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

    pid = create_project(client, {"name": "Tower", "levels": []})["id"]
    # a project's chip names its project; an app chip is refused on /ops and vice versa
    _, stray = chip_op(user, pid, None, **row)
    assert "library/ops" in str(
        push(client, "/ops", {"project_id": pid, "ops": [stray]}, status=422)
    )
    _, owned = chip_op(user, LIBRARY_STREAM, pid, **row)
    push(client, "/library/ops", {"since": None, "ops": [owned]}, status=422)
    peid, mine = chip_op(user, pid, pid, **{**row, "state": "accepted"})
    assert (
        push(client, "/ops", {"project_id": pid, "ops": [mine]})["results"][0]["outcome"]
        == "applied"
    )
    assert session.get(Suggestion, peid).project_id == uuid.UUID(pid)


def test_project_creation_copies_accepted_chips_with_their_types(client, session):
    source = create_project(client, {"name": "Source", "levels": []})
    sid = uuid.UUID(source["id"])
    assert source["copied"]["suggestions"] == 0
    app_type = LibraryType(
        id=uuid7(), project_id=None, model="PI1002", category="Station", state="accepted"
    )
    src_type = LibraryType(
        id=uuid7(), project_id=sid, model="P-NSPS-D", category="Equipment", state="accepted"
    )
    session.add_all([app_type, src_type])

    def chip(project_id, scope, ref, target, text, state="accepted", deleted=False):
        return Suggestion(
            id=uuid7(),
            project_id=project_id,
            scope=scope,
            ref=str(ref),
            target=target,
            text=text,
            state=state,
            deleted_at=datetime.now(UTC) if deleted else None,
        )

    session.add_all(
        [
            chip(None, "type", app_type.id, "device_note", "Stuck buttons"),
            chip(None, "category", "Station", "device_note", "Empty box on wall."),
            chip(None, "code", "X", "punch_item", "Missing DMX termination kit"),
            chip(
                None, "code", "N", "connection_note", "Missing network termination", state="draft"
            ),
            chip(None, "code", "U", "connection_note", "Gone", deleted=True),
            chip(
                sid,
                "type",
                src_type.id,
                "device_note",
                "Lands in ERP; needs to be run down to the NSPS below it",
            ),
            chip(
                sid, "code", "x", "punch_item", "missing DMX termination kit "
            ),  # same chip as the app's
            chip(sid, "code", "0-10V", "connection_note", "Land 0-10V control wiring"),
        ]
    )
    session.commit()

    def chips(pid):
        rows = session.scalars(select(Suggestion).where(Suggestion.project_id == pid)).all()
        return {(r.scope, r.ref, r.target, r.text) for r in rows}, rows

    fresh = create_project(client, {"name": "Fresh", "levels": []})
    fid = uuid.UUID(fresh["id"])
    copied_type = session.scalars(select(LibraryType).where(LibraryType.project_id == fid)).one()
    got, rows = chips(fid)
    assert fresh["copied"]["suggestions"] == 3
    assert got == {
        ("type", str(copied_type.id), "device_note", "Stuck buttons"),
        ("category", "Station", "device_note", "Empty box on wall."),
        ("code", "X", "punch_item", "Missing DMX termination kit"),
    }
    assert all(r.state == "accepted" for r in rows)
    # they arrive as ops of the new project, so an iPad pulls them
    ops = session.scalars(
        select(Op).where(Op.project_id == fid, Op.entity_kind == "suggestion")
    ).all()
    assert len(ops) == 3

    copy = create_project(client, {"name": "Copy", "copy_from": {"project_id": str(sid)}})
    cid = uuid.UUID(copy["id"])
    nsps = session.scalars(
        select(LibraryType).where(LibraryType.project_id == cid, LibraryType.model == "P-NSPS-D")
    ).one()
    got, _ = chips(cid)
    assert copy["copied"]["suggestions"] == 5
    assert (
        "type",
        str(nsps.id),
        "device_note",
        "Lands in ERP; needs to be run down to the NSPS below it",
    ) in got
    assert ("code", "0-10V", "connection_note", "Land 0-10V control wiring") in got
    assert sum(1 for g in got if g[3].strip().casefold() == "missing dmx termination kit") == 1

    off = create_project(
        client, {"name": "Off", "copy_from": {"project_id": str(sid), "library": False}}
    )
    assert off["copied"]["suggestions"] == 3  # the app library's still come along
