"""`POST /projects` · `GET /projects` (T41, D127): the project, its numbering groups, its levels
and the copies arrive as ops; numbering works at once; replay keeps the groups."""

from datetime import UTC, datetime

import pytest
from conftest import HDR
from sqlalchemy import select

from app.ids import uuid7
from app.materialise import replay
from app.models import (
    FieldHead,
    Level,
    LibraryType,
    NumberingGroup,
    Op,
    Placeholder,
    Project,
    Ruling,
    User,
    Vocab,
)
from app.projects import DEFAULT_EXPORT_TITLE
from app.sync import SERVER_INSTALL_ID

ANN = {**HDR, "X-Survey-User": "Ann"}

TOWER = {
    "name": "Houston Methodist Centennial Tower",
    "site": "Houston, TX",
    "parties": {"ec": "Acme Electric", "etc": "ETC Field Service"},
    "settings": {"disclaimer": "Based on submittal drawings rev F"},
    "levels": [
        {"level": "b2"},
        {"level": "B1"},
        {"level": "1"},
        {"level": "06"},
        {"level": "06M", "share_with": "06", "split_of": "06"},
        {"level": "09", "in_scope": False},
    ],
}


def create(client, body=TOWER, headers=ANN):
    res = client.post("/projects", json=body, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


def test_create_project_rows_and_ops(client, session):
    out = create(client)
    assert out["name"] == TOWER["name"] and out["site"] == "Houston, TX"
    assert out["parties"] == {"ec": "Acme Electric", "etc": "ETC Field Service", "gc": ""}
    assert out["settings"] == {
        "export_title": DEFAULT_EXPORT_TITLE,
        "disclaimer": "Based on submittal drawings rev F",
    }
    assert out["copied"] == {
        "vocab": 0,
        "library_types": 0,
        "rulings": 0,
        "rule_params": 0,
        "placeholders": 0,
    }
    levels = out["levels"]
    assert [lv["level"] for lv in levels] == ["B2", "B1", "01", "06", "06M", "09"]
    assert [lv["floor_order"] for lv in levels] == [1, 2, 3, 4, 5, 6]
    assert [lv["in_scope"] for lv in levels] == [True] * 5 + [False]
    by_code = {lv["level"]: lv for lv in levels}
    assert by_code["06"]["numbering_group_id"] == by_code["06M"]["numbering_group_id"]
    assert by_code["06"]["numbering_group_label"] == "06/06M"
    assert by_code["B2"]["numbering_group_label"] == "B2"
    assert by_code["06M"]["split_of_id"] == by_code["06"]["id"]
    assert all(lv["state"] == "setup" for lv in levels)

    project = session.get(Project, out["id"])
    assert project is not None and project.version == 1 and project.head_seq == 1
    groups = session.scalars(
        select(NumberingGroup).where(NumberingGroup.project_id == project.id)
    ).all()
    assert sorted(g.label for g in groups) == ["01", "06/06M", "09", "B1", "B2"]
    assert all((g.counter_punch, g.counter_cable) == (0, 0) for g in groups)
    rows = session.scalars(select(Level).where(Level.project_id == project.id)).all()
    assert len(rows) == 6 and all(r.version == 1 for r in rows)

    # Everything is in the op log, in order, applied, from the server's install, by Ann.
    ops = session.scalars(
        select(Op).where(Op.project_id == project.id).order_by(Op.server_seq)
    ).all()
    kinds = [o.entity_kind for o in ops]
    assert kinds[0] == "project" and ops[0].entity_id == project.id
    assert kinds.count("numbering_group") == 5 and kinds.count("level") == 6
    assert kinds.index("level") > kinds.index("numbering_group")
    assert [o.server_seq for o in ops] == list(range(1, len(ops) + 1))
    assert all(o.state == "applied" and o.install_id == SERVER_INSTALL_ID for o in ops)
    ann = session.scalars(select(User).where(User.name == "Ann")).one()
    assert all(o.user_id == ann.id and o.change_type == "Master edit" for o in ops)
    assert ops[0].reason == "Project created by Ann"
    assert out["server_seq"] == len(ops)
    # Field heads exist for the project's columns (D81), so a later `set` has a base.
    heads = session.scalars(select(FieldHead).where(FieldHead.entity_id == project.id)).all()
    assert {h.field for h in heads} >= {"name", "site", "parties", "settings"}


def test_pull_delivers_the_project_first(client):
    out = create(client)
    res = client.get("/ops", params={"project_id": out["id"], "since": 0}, headers=ANN)
    assert res.status_code == 200, res.text
    pulled = res.json()["ops"]
    assert pulled[0]["entity_kind"] == "project" and pulled[0]["kind"] == "create"
    assert pulled[0]["payload"]["name"] == TOWER["name"]
    assert pulled[0]["payload"]["settings"]["export_title"] == DEFAULT_EXPORT_TITLE
    groups = [o for o in pulled if o["entity_kind"] == "numbering_group"]
    assert {g["payload"]["label"] for g in groups} == {"B2", "B1", "01", "06/06M", "09"}
    assert all(g["payload"].get("counter_punch") is None for g in groups)


def test_numbering_works_at_once_and_06_shares_with_06m(client, session):
    out = create(client)
    ann = session.scalars(select(User).where(User.name == "Ann")).one()
    levels = {lv["level"]: lv["id"] for lv in out["levels"]}

    def punch(level):
        eid = str(uuid7())
        return {
            "op_id": str(uuid7()),
            "project_id": out["id"],
            "user_id": str(ann.id),
            "install_id": str(uuid7()),
            "client_ts": datetime.now(UTC).isoformat(),
            "entity_kind": "punch_item",
            "entity_id": eid,
            "kind": "create",
            "payload": {"id": eid, "level_id": level, "item": "Run X", "type": "Cable not run"},
            "change_type": "Field survey",
            "reason": "test",
        }

    res = client.post(
        "/ops",
        json={
            "project_id": out["id"],
            "since": out["server_seq"],
            "ops": [punch(levels["06M"]), punch(levels["06"]), punch(levels["B2"])],
        },
        headers=ANN,
    )
    assert res.status_code == 200, res.text
    assert [r["outcome"] for r in res.json()["results"]] == ["applied"] * 3
    assigns = [o for o in res.json()["server_ops"] if o["kind"] == "assign"]
    assert [a["now"] for a in assigns] == [1, 2, 1]


def test_replay_keeps_project_and_counters(client, session):
    out = create(client)
    project = session.get(Project, out["id"])
    shared = session.scalars(select(NumberingGroup).where(NumberingGroup.label == "06/06M")).one()
    shared.counter_punch = 7
    session.commit()
    n = replay(session, project.id)
    session.commit()
    assert n >= 12
    assert session.get(Project, project.id) is not None
    session.refresh(shared)
    assert shared.counter_punch == 7
    assert len(session.scalars(select(Level).where(Level.project_id == project.id)).all()) == 6


def test_list_projects(client):
    assert client.get("/projects", headers=HDR).json() == []
    a = create(client, {"name": "A", "levels": [{"level": "01"}]})
    b = create(client, {"name": "B"})
    listed = client.get("/projects", headers=HDR).json()
    assert [p["id"] for p in listed] == [a["id"], b["id"]]
    assert listed[0]["levels"][0]["level"] == "01" and listed[1]["levels"] == []
    assert "server_seq" not in listed[0]


def test_copy_from(client, session):
    source = create(client, {"name": "Source", "levels": [{"level": "01"}]})
    sid = source["id"]
    lvl = source["levels"][0]["id"]

    def lt(project_id, model, state="accepted", category=None, needs_neuron_id=None, role=None):
        return LibraryType(
            id=uuid7(),
            project_id=project_id,
            model=model,
            category=category,
            state=state,
            needs_neuron_id=needs_neuron_id,
            role=role,
        )

    canonical = Vocab(id=uuid7(), project_id=sid, list="device_note", value="Not run")
    variant = Vocab(
        id=uuid7(),
        project_id=sid,
        list="device_note",
        value="not run",
        canonical_of_id=canonical.id,
    )
    gone = Vocab(
        id=uuid7(), project_id=sid, list="punch_note", value="old", deleted_at=datetime.now(UTC)
    )
    standing = Ruling(
        id=uuid7(), project_id=sid, text="Wagos everywhere", standing=True, scope_levels=["01"]
    )
    once = Ruling(id=uuid7(), project_id=sid, text="One-off", standing=False)
    ph = Placeholder(id=uuid7(), project_id=sid, label="Fixtures", kind="fixtures")
    ph_level = Placeholder(
        id=uuid7(), project_id=sid, label="Level 01 spare", kind="spare", level_id=lvl
    )
    session.add_all(
        [
            variant,
            canonical,
            gone,
            lt(None, "P-NSPS-D", category="NSPS"),
            lt(None, "X-DRAFT", state="draft"),
            lt(sid, "PI1002", category="Station", needs_neuron_id=False, role="station"),
            lt(sid, "p-nsps-d", category="NSPS"),
            lt(sid, "ERP-XYZ", state="draft"),
            standing,
            once,
            ph,
            ph_level,
        ]
    )
    session.commit()

    out = create(
        client,
        {
            "name": "Copy",
            "copy_from": {"project_id": sid, "placeholders": True},
            "levels": [{"level": "02"}],
        },
    )
    assert out["copied"] == {
        "vocab": 2,
        "library_types": 2,
        "rulings": 1,
        "rule_params": 0,
        "placeholders": 1,
    }
    assert out["copied_from_id"] == sid
    pid = out["id"]
    vocab = session.scalars(select(Vocab).where(Vocab.project_id == pid)).all()
    by_value = {v.value: v for v in vocab}
    assert set(by_value) == {"Not run", "not run"}
    assert by_value["not run"].canonical_of_id == by_value["Not run"].id
    assert by_value["Not run"].id != canonical.id
    types = session.scalars(select(LibraryType).where(LibraryType.project_id == pid)).all()
    assert sorted(t.model for t in types) == ["P-NSPS-D", "PI1002"]
    assert all(t.state == "accepted" and t.promoted_from_id is None for t in types)
    # The Neuron ID flag comes along; null stays null (the category's default, T68 / D185).
    assert {t.model: t.needs_neuron_id for t in types} == {"P-NSPS-D": None, "PI1002": False}
    assert {t.model: t.role for t in types} == {"P-NSPS-D": None, "PI1002": "station"}  # T112
    rulings = session.scalars(select(Ruling).where(Ruling.project_id == pid)).all()
    assert [r.text for r in rulings] == ["Wagos everywhere"]
    assert rulings[0].standing and rulings[0].scope_levels is None and rulings[0].applied_at is None
    phs = session.scalars(select(Placeholder).where(Placeholder.project_id == pid)).all()
    assert [(p.label, p.kind, p.level_id) for p in phs] == [("Fixtures", "fixtures", None)]
    # Copies are ops of the new project, so an iPad pulls them.
    kinds = [o.entity_kind for o in session.scalars(select(Op).where(Op.project_id == pid))]
    assert kinds.count("vocab") == 2 and kinds.count("library_type") == 2
    assert kinds.count("ruling") == 1 and kinds.count("placeholder") == 1

    # Flags off: only the app library comes along.
    plain = create(
        client,
        {
            "name": "Plain",
            "copy_from": {
                "project_id": sid,
                "vocabulary": False,
                "library": False,
                "rulings": False,
            },
        },
    )
    assert plain["copied"] == {
        "vocab": 0,
        "library_types": 1,
        "rulings": 0,
        "rule_params": 0,
        "placeholders": 0,
    }
    # No copy-from at all: the app library still seeds the project (D65).
    fresh = create(client, {"name": "Fresh"})
    assert fresh["copied"]["library_types"] == 1


@pytest.mark.parametrize(
    ("body", "status", "text"),
    [
        ({"name": "  "}, 422, "empty"),
        ({"name": "X", "levels": [{"level": "06"}, {"level": "6"}]}, 422, "distinct"),
        ({"name": "X", "levels": [{"level": ""}]}, 422, "empty"),
        ({"name": "X", "levels": [{"level": "06M", "share_with": "06"}]}, 422, "unknown level"),
        ({"name": "X", "levels": [{"level": "06", "share_with": "06"}]}, 422, "itself"),
        (
            {
                "name": "X",
                "levels": [{"level": "A", "share_with": "B"}, {"level": "B", "share_with": "A"}],
            },
            422,
            "loops",
        ),
        ({"name": "X", "levels": [{"level": "06M", "split_of": "06"}]}, 422, "unknown level"),
        ({"name": "X", "parties": {"owner": "x"}}, 422, "unknown party"),
        ({"name": "X", "settings": {"font": "x"}}, 422, "unknown setting"),
        ({"name": "X", "copy_from": {"project_id": str(uuid7())}}, 404, "unknown project"),
        ({"name": "X", "bogus": 1}, 422, "bogus"),
    ],
)
def test_create_rejects_bad_input(client, session, body, status, text):
    res = client.post("/projects", json=body, headers=ANN)
    assert res.status_code == status, res.text
    assert text in res.text
    assert session.scalars(select(Project)).all() == []


def test_sharing_resolves_through_chains(client):
    out = create(
        client,
        {
            "name": "Chain",
            "levels": [
                {"level": "06"},
                {"level": "06M", "share_with": "06"},
                {"level": "06X", "share_with": "06M"},
                {"level": "07"},
            ],
        },
    )
    groups = {lv["level"]: lv["numbering_group_label"] for lv in out["levels"]}
    assert groups == {"06": "06/06M/06X", "06M": "06/06M/06X", "06X": "06/06M/06X", "07": "07"}


def test_requires_token(client):
    assert client.get("/projects").status_code == 401
    assert client.post("/projects", json={"name": "X"}).status_code == 401
