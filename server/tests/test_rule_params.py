"""Rule parameters (T102, D176, D211): the `rule_param` table at two scopes — app-level defaults
on `/library/ops`, a project's own values on `/ops` — and project creation copying the accepted
defaults, then a source project's values, under ids every iPad computes the same way."""

import uuid
from datetime import UTC, datetime, timedelta

from conftest import HDR
from sqlalchemy import select

from app.ids import uuid7
from app.models import Op, RuleParam, User
from app.rule_params import rule_param_id
from app.sync import LIBRARY_STREAM

ANN = {**HDR, "X-Survey-User": "Ann"}
T0 = datetime(2026, 10, 16, 9, 0, tzinfo=UTC)


def test_ids_match_the_ipad():
    # the same values as `ruleParamId` in packages/rules/src/params.test.ts
    pid = "0190a5f0-0000-7000-8000-00000000bb01"
    assert str(rule_param_id(pid, "R3a", "run.owner")) == "289c65cf-65d0-8258-9abf-13498da2d220"
    assert str(rule_param_id(None, "R3b", "owner")) == "08f01162-46c8-8102-855c-96f79160e687"
    assert rule_param_id(uuid.UUID(pid), "R3a", "run.owner") == rule_param_id(
        pid, "R3a", "run.owner"
    )


class Ipad:
    def __init__(self, session):
        self.user = User(id=uuid7(), name="Ann")
        session.add(self.user)
        session.commit()
        self.clock = T0

    def op(self, stream, kind, entity_id, **kw):
        self.clock += timedelta(seconds=1)
        return {
            "op_id": str(uuid7()),
            "project_id": str(stream),
            "user_id": str(self.user.id),
            "install_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ipad:Ann")),
            "client_ts": self.clock.isoformat(),
            "entity_kind": "rule_param",
            "entity_id": str(entity_id),
            "kind": kind,
            "change_type": "Master edit",
            "reason": "Rule parameter",
            **kw,
        }

    def create(self, stream, project_id, rule_id, key, value, state):
        eid = rule_param_id(project_id, rule_id, key)
        payload = {
            "id": str(eid),
            "project_id": str(project_id) if project_id else None,
            "rule_id": rule_id,
            "key": key,
            "value": value,
            "state": state,
        }
        return eid, self.op(stream, "create", eid, payload=payload)


def push_library(client, ops, status=200):
    r = client.post("/library/ops", json={"since": None, "ops": ops}, headers=ANN)
    assert r.status_code == status, r.text
    return r.json()


def push_project(client, project_id, ops, status=200):
    r = client.post("/ops", json={"project_id": project_id, "ops": ops}, headers=ANN)
    assert r.status_code == status, r.text
    return r.json()


def create_project(client, body):
    r = client.post("/projects", json=body, headers=ANN)
    assert r.status_code == 201, r.text
    return r.json()


def test_defaults_live_in_the_library_stream_and_values_in_the_project(client, session):
    ipad = Ipad(session)
    eid, op = ipad.create(LIBRARY_STREAM, None, "R3a", "run.owner", {"*": "ETC"}, "draft")
    assert push_library(client, [op])["results"][0]["outcome"] == "applied"
    row = session.get(RuleParam, eid)
    assert (row.project_id, row.state, row.value) == (None, "draft", {"*": "ETC"})
    accept = ipad.op(LIBRARY_STREAM, "set", eid, field="state", was="draft", now="accepted")
    accept["base_op_id"] = op["op_id"]
    assert push_library(client, [accept])["results"][0]["outcome"] == "applied"
    session.expire_all()
    assert session.get(RuleParam, eid).state == "accepted"

    project = create_project(client, {"name": "Tower", "levels": []})
    pid = project["id"]
    # a project's row names its project; an app-level one is refused on /ops and vice versa
    _, stray = ipad.create(pid, None, "R3b", "owner", "ETC", "accepted")
    assert "library/ops" in str(push_project(client, pid, [stray], status=422))
    _, owned = ipad.create(LIBRARY_STREAM, uuid.UUID(pid), "R3b", "owner", "ETC", "draft")
    push_library(client, [owned], status=422)
    peid, mine = ipad.create(pid, uuid.UUID(pid), "R3b", "owner", "ETC", "accepted")
    assert push_project(client, pid, [mine])["results"][0]["outcome"] == "applied"
    assert session.get(RuleParam, peid).project_id == uuid.UUID(pid)


def test_project_creation_copies_accepted_defaults_then_the_source_values(client, session):
    def param(project_id, rule_id, key, value, state="accepted", deleted=False):
        return RuleParam(
            id=rule_param_id(project_id, rule_id, key),
            project_id=project_id,
            rule_id=rule_id,
            key=key,
            value=value,
            state=state,
            deleted_at=datetime.now(UTC) if deleted else None,
        )

    source = create_project(client, {"name": "Source", "levels": []})
    sid = uuid.UUID(source["id"])
    assert source["copied"]["rule_params"] == 0
    session.add_all(
        [
            param(None, "R3a", "run.owner", {"*": "ETC"}),
            param(None, "R3b", "owner", "ETC"),
            param(None, "R3c", "owner", "ETC", state="draft"),  # not accepted: not copied
            param(None, "R3c", "item", None),  # back on the built-in default: not copied
            param(None, "R5", "enabled", False, deleted=True),
            param(sid, "R3b", "owner", "EC"),  # the source's own value wins over the default
            param(sid, "R2f", "status", "No access"),
            param(sid, "E6", "owner", "EC", state="draft"),
        ]
    )
    session.commit()

    fresh = create_project(client, {"name": "Fresh", "levels": []})
    fid = uuid.UUID(fresh["id"])
    rows = session.scalars(select(RuleParam).where(RuleParam.project_id == fid)).all()
    assert fresh["copied"]["rule_params"] == 2
    assert {(r.rule_id, r.key): r.value for r in rows} == {
        ("R3a", "run.owner"): {"*": "ETC"},
        ("R3b", "owner"): "ETC",
    }
    assert all(r.state == "accepted" and r.id == rule_param_id(fid, r.rule_id, r.key) for r in rows)
    # they arrive as ops of the new project, so an iPad pulls them
    ops = session.scalars(select(Op).where(Op.project_id == fid, Op.entity_kind == "rule_param"))
    assert sorted(o.payload["key"] for o in ops) == ["owner", "run.owner"]

    copy = create_project(client, {"name": "Copy", "copy_from": {"project_id": str(sid)}})
    cid = uuid.UUID(copy["id"])
    rows = session.scalars(select(RuleParam).where(RuleParam.project_id == cid)).all()
    assert {(r.rule_id, r.key): r.value for r in rows} == {
        ("R3a", "run.owner"): {"*": "ETC"},
        ("R3b", "owner"): "EC",
        ("R2f", "status"): "No access",
    }
    off = create_project(
        client, {"name": "Off", "copy_from": {"project_id": str(sid), "rule_params": False}}
    )
    assert off["copied"]["rule_params"] == 2  # the app-level defaults still come along

    # an iPad that sets a copied parameter creates the same id: one row, applied (D169)
    ipad = Ipad(session)
    _, again = ipad.create(str(cid), cid, "R3b", "owner", "ETC", "accepted")
    assert push_project(client, str(cid), [again])["results"][0]["outcome"] == "applied"
    session.expire_all()
    assert session.get(RuleParam, rule_param_id(cid, "R3b", "owner")).value == "EC"
