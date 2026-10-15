"""Export jobs at tower scale (T93, D166): one queued or running export per project and kind,
Cancel, the stage and counts a running job writes into `stats`, and a restart mid-job."""

import uuid
from datetime import UTC, datetime

import pytest
from conftest import HDR
from sqlalchemy import select
from test_seed_import import new_project

from app import projects
from app.auth import upsert_user
from app.config import settings
from app.ids import uuid7
from app.jobs import export_xlsx, exports
from app.models import Export, Level

LANDRY = {**HDR, "X-Survey-User": "Landry"}
ZACH = {**HDR, "X-Survey-User": "Zach"}


def post(client, project_id, headers=LANDRY, **body):
    return client.post("/exports", json={"project_id": str(project_id), **body}, headers=headers)


def fresh(session, export_id) -> Export:
    session.expire_all()
    return session.get(Export, export_id)


# ------------------------------------------------------- one at a time


def test_one_export_per_project_and_kind(client, session, store, factory):
    p1, p2 = new_project(session, "One"), new_project(session, "Two")
    first = post(client, p1)
    assert first.status_code == 202
    first = first.json()
    assert first["created_by"] == "Landry"

    # a second workbook of the same project, by anyone, is refused and names the running one
    again = post(client, p1, headers=ZACH)
    assert again.status_code == 409
    detail = again.json()["detail"]
    assert detail["error"] == "export_running"
    assert detail["export"]["id"] == first["id"] and detail["export"]["created_by"] == "Landry"

    # another kind on the same project, and the same kind on another project, may queue
    assert post(client, p1, kind="floor_pdf", params={"level": "06"}).status_code == 202
    assert post(client, p2).status_code == 202

    # once it is done, the next one queues
    assert exports.run_export(factory, store, uuid.UUID(first["id"])) == "done"
    assert post(client, p1).status_code == 202


def test_two_generates_at_the_same_moment(session, monkeypatch):
    """The partial unique index holds when both pre-checks miss (two API workers at once)."""
    project_id = new_project(session)
    first = exports.create_export(session, project_id=project_id, user=None)
    real = exports.active_export
    calls = iter([None])
    monkeypatch.setattr(exports, "active_export", lambda *a: next(calls, None) or real(*a))
    with pytest.raises(exports.ExportBusy) as e:
        exports.create_export(session, project_id=project_id, user=None)
    assert e.value.active.id == first.id


def test_daily_backup_waits_for_a_running_workbook(session, store, factory, monkeypatch):
    monkeypatch.setattr(settings, "backup_enabled", True)
    monkeypatch.setattr(settings, "backup_hour_utc", 0)
    monkeypatch.setattr(exports, "_daily_checked_on", None)
    project_id = new_project(session)
    mine = exports.create_export(session, project_id=project_id, user=upsert_user(session, "Zach"))
    mine_id = mine.id
    assert exports.daily_tick(factory, store) == []
    assert exports._daily_checked_on is None  # tried again next minute
    assert exports.run_export(factory, store, mine_id) == "done"
    assert exports.daily_tick(factory, store) == ["done"]


# --------------------------------------------------------------- Cancel


def test_cancel_a_queued_export(client, session, store, factory):
    project_id = new_project(session)
    queued = post(client, project_id).json()
    r = client.post(f"/exports/{queued['id']}/cancel", headers=ZACH)
    assert r.status_code == 200
    got = r.json()
    assert got["job_state"] == "cancelled" and got["cancelled_by"] == "Zach"
    assert got["cancel_requested_at"] and got["stats"]["finished_at"]
    assert exports.run_queued(factory, store) == []
    # the kind is free again; cancelling a finished export changes nothing
    assert post(client, project_id).status_code == 202
    assert client.post(f"/exports/{queued['id']}/cancel", headers=LANDRY).json()[
        "cancelled_by"
    ] == ("Zach")
    assert client.post(f"/exports/{uuid7()}/cancel", headers=LANDRY).status_code == 404


def test_cancel_stops_a_running_export(session, store, factory, monkeypatch):
    project_id = new_project(session)
    row = exports.create_export(session, project_id=project_id, user=None)
    export_id = row.id
    real_write = export_xlsx.write

    def press_cancel_while_writing(*a, **k):
        with factory() as s:
            assert exports.cancel_export(s, export_id, upsert_user(s, "Wiley")).job_state == (
                "running"
            )
        real_write(*a, **k)

    monkeypatch.setattr(export_xlsx, "write", press_cancel_while_writing)
    assert exports.run_export(factory, store, export_id) == "cancelled"
    row = fresh(session, export_id)
    assert row.job_state == "cancelled" and row.blob is None
    out = exports.export_out(row)
    assert out["cancelled_by"] == "Wiley"
    # the stages it got through are kept, with when it started and stopped
    assert set(row.stats["stage_seconds"]) >= {"Reading the records", "Writing the workbook"}
    assert row.stats["started_at"] and row.stats["finished_at"]


# ------------------------------------------------------------- progress


def add_photos(session, project_id, n):
    from test_export import exports_body

    from app.sync import OpIn, Push

    user = upsert_user(session, "Landry")
    level = session.scalars(select(Level).where(Level.project_id == project_id)).first()
    ops = []
    for i in range(n):
        pid = uuid7()
        ops.append(
            OpIn(
                op_id=uuid7(),
                project_id=project_id,
                user_id=user.id,
                install_id=uuid7(),
                client_ts=datetime.now(UTC),
                entity_kind="photo",
                entity_id=pid,
                kind="create",
                change_type="Field survey",
                reason="Field survey",
                payload={"id": str(pid), "level_id": str(level.id), "subject": f"P{i}"},
            )
        )
    Push(session, exports_body(project_id)).run(ops)
    session.commit()


def test_the_job_reports_its_stage_and_counts(session, store, factory, monkeypatch):
    user = upsert_user(session, "Landry")
    out = projects.create_project(
        session, projects.ProjectIn(name="Big", levels=[projects.LevelIn(level="06")]), user
    )
    project_id = uuid.UUID(out.id)
    add_photos(session, project_id, 3)
    row = exports.create_export(session, project_id=project_id, user=user)
    export_id = row.id

    seen = []
    real_call = exports.Progress.__call__

    def watch(self, stage, done=None, total=None, unit=None):
        self.every = 0  # write every report, so the test sees each one
        try:
            real_call(self, stage, done, total, unit)
        finally:
            with factory() as s:
                st = s.get(Export, export_id).stats
                seen.append((st.get("stage"), st.get("done"), st.get("total"), st.get("unit")))
                assert st["started_at"]

    monkeypatch.setattr(exports.Progress, "__call__", watch)
    assert exports.run_export(factory, store, export_id) == "done"
    assert ("Photo Log", 0, 3, "pictures") in seen and ("Photo Log", 2, 3, "pictures") in seen
    stages = [s[0] for s in seen]
    assert stages.index("Reading the records") < stages.index("Photo Log")
    assert stages.index("Photo Log") < stages.index("Writing the workbook")
    assert stages.index("Writing the workbook") < stages.index("Saving the file")
    row = fresh(session, export_id)
    # the finished row keeps when it started and how long each stage took (T94 measures them)
    assert row.stats["started_at"] < row.stats["finished_at"]
    assert set(row.stats["stage_seconds"]) == {
        "Starting",
        "Reading the records",
        "Photo Log",
        "Writing the workbook",
        "Saving the file",
    }
    assert row.stats["filename"] and row.stats["rows"]["Photo Log"] == 3


def test_progress_writes_at_most_once_a_second(session, factory):
    project_id = new_project(session)
    row = exports.create_export(session, project_id=project_id, user=None)
    export_id = row.id
    t = [100.0]
    p = exports.Progress(factory, export_id, "2026-10-14T12:00:00+00:00", clock=lambda: t[0])
    p("Photo Log", 0, 10, "pictures")
    p("Photo Log", 1, 10, "pictures")  # same stage, same second: not written
    assert fresh(session, export_id).stats["done"] == 0
    t[0] += 1.5
    p("Photo Log", 7, 10, "pictures")
    st = fresh(session, export_id).stats
    assert (st["stage"], st["done"], st["total"], st["unit"]) == ("Photo Log", 7, 10, "pictures")
    p("Writing the workbook")  # a new stage is always written, with the last one's time
    st = fresh(session, export_id).stats
    assert st["stage"] == "Writing the workbook" and "total" not in st
    assert st["stage_seconds"] == {"Photo Log": 1.5}


# --------------------------------------------------------------- restart


def test_a_restart_queues_a_running_export_again(session, store, factory):
    p1, p2 = new_project(session, "One"), new_project(session, "Two")
    a = exports.create_export(session, project_id=p1, user=None)
    b = exports.create_export(session, project_id=p2, user=None)
    a_id, b_id = a.id, b.id
    for row in (a, b):
        row.job_state = "running"
        row.stats = {"started_at": "2026-10-14T12:00:00+00:00", "stage": "Photo Log"}
    b.cancel_requested_at = datetime.now(UTC)
    session.commit()
    assert sorted(exports.recover_interrupted(factory)) == sorted(
        [f"{a_id}:queued", f"{b_id}:cancelled"]
    )
    assert fresh(session, a_id).stats.get("restarted_at")
    assert exports.run_queued(factory, store) == ["done"]
