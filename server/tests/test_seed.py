"""`python -m app.seed project` (T14, D89): the harness's way to a project before T41."""

import json

import pytest
from conftest import HDR
from sqlalchemy import select

from app import seed
from app.models import NumberingGroup, Project


def test_seed_project_creates_project_and_groups(session):
    out = seed.seed_project(session, "Tower", ["06/06M", "07"])
    project = session.get(Project, out["project_id"])
    assert project is not None and project.name == "Tower"
    groups = session.scalars(
        select(NumberingGroup).where(NumberingGroup.project_id == project.id)
    ).all()
    assert {g.label: str(g.id) for g in groups} == out["groups"]
    assert all(
        (g.counter_punch, g.counter_part, g.counter_photo, g.counter_cable) == (0, 0, 0, 0)
        for g in groups
    )
    # Round-trips through JSON (the CLI prints exactly this).
    assert json.loads(json.dumps(out)) == out


def test_seed_project_rejects_bad_input(session):
    with pytest.raises(ValueError, match="empty"):
        seed.seed_project(session, "  ", ["06"])
    with pytest.raises(ValueError, match="distinct"):
        seed.seed_project(session, "Tower", ["06", "06"])


def test_seeded_project_accepts_a_push(client, session):
    """The seeded rows are enough for `POST /ops`: a level create referencing the group applies."""
    out = seed.seed_project(session, "Tower", ["06/06M"])
    user = client.post("/team", json={"name": "Ann"}, headers=HDR).json()
    level_id = "01999999-0000-7000-8000-000000000001"
    op = {
        "op_id": "01999999-0000-7000-8000-0000000000aa",
        "project_id": out["project_id"],
        "user_id": user["id"],
        "install_id": "01999999-0000-7000-8000-0000000000bb",
        "client_ts": "2026-10-10T12:00:00+00:00",
        "entity_kind": "level",
        "entity_id": level_id,
        "kind": "create",
        "payload": {
            "id": level_id,
            "project_id": out["project_id"],
            "level": "06M",
            "numbering_group_id": out["groups"]["06/06M"],
        },
        "change_type": "Master edit",
        "reason": "seed",
    }
    res = client.post(
        "/ops", json={"project_id": out["project_id"], "since": 0, "ops": [op]}, headers=HDR
    )
    assert res.status_code == 200, res.text
    assert [r["outcome"] for r in res.json()["results"]] == ["applied"]


def test_cli_main_prints_json(session, monkeypatch, capsys):
    monkeypatch.setattr(seed, "SessionLocal", lambda: session)
    assert seed.main(["project", "Tower", "06/06M", "07"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert set(out) == {"project_id", "groups"}
    assert set(out["groups"]) == {"06/06M", "07"}
    assert seed.main(["project", "Tower", "x", "x"]) == 2
