"""The one-off wipe (T198, D287 (7), D292 (5)): every project's data and the device-type library go;
users, installs, the app-level vocabulary and rule defaults and their library ops stay; the dry run
changes nothing; blobs go with their objects unless a kept op names them; the server works after."""

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from test_library import ANN, Lib
from test_suggestions import chip_op
from test_vocab_library import vocab_op

from app import wipe
from app.ids import uuid7
from app.models import (
    Blob,
    Device,
    FieldHead,
    Install,
    LibraryType,
    Op,
    Photo,
    Project,
    ReviewItem,
    RuleParam,
    Suggestion,
    User,
    Vocab,
)
from app.storage import MemoryObjectStore
from app.sync import LIBRARY_STREAM

SHA_PHOTO, SHA_PART, SHA_KEPT = "a" * 64, "b" * 64, "c" * 64


def build(client, session):
    """A small server: a library type with a conflict, a chip, app and project vocabulary, a
    project with a device of that type and a photo, three blobs, an install."""
    w = Lib(session)
    tid, create = w.create(w.ann, "PI1002", category="Station")
    w.push(client, [create])
    a = w.op(w.ann, "set", tid, field="aliases", now=["PI-1002"], base_op_id=create["op_id"])
    b = w.op(w.bob, "set", tid, field="aliases", now=["PI1002-W"], base_op_id=create["op_id"])
    w.push(client, [a], since=1)
    assert w.push(client, [b], since=1)["results"][0]["outcome"] == "review"
    chip = {"scope": "code", "ref": "X", "target": "connection_note", "text": "Not run"}
    _, op = chip_op(w.ann, LIBRARY_STREAM, None, **chip, state="accepted")
    w.push(client, [op])
    # app vocabulary (kept): one copied into the project, one naming a blob
    vid, op = vocab_op(w.ann, LIBRARY_STREAM, None, list="category", value="Station")
    w.push(client, [{**op, "payload": {**op["payload"], "state": "accepted"}}])
    _, op = vocab_op(w.ann, LIBRARY_STREAM, None, list="type", value=f"logo {SHA_KEPT}")
    w.push(client, [op])
    session.add(RuleParam(id=uuid7(), project_id=None, rule_id="R3", key="owner", value="EC"))
    r = client.post("/projects", json={"name": "Tower", "levels": [{"level": "06M"}]}, headers=ANN)
    assert r.status_code == 201, r.text
    project = r.json()
    level = uuid.UUID(project["levels"][0]["id"])
    dev = Device(id=uuid7(), level_id=level, category="Station", library_type_id=tid)
    session.add(dev)
    session.add(Photo(id=uuid7(), level_id=level, device_id=dev.id, image_blob=SHA_PHOTO))
    session.add_all(
        [
            Blob(sha256=SHA_PHOTO, size=3, mime="image/jpeg", upload_state="complete"),
            Blob(
                sha256=SHA_PART,
                size=3,
                mime="image/jpeg",
                upload_state="partial",
                chunks_received=[0],
            ),
            Blob(sha256=SHA_KEPT, size=3, mime="image/png", upload_state="complete"),
            Install(id=uuid7(), label="iPad 1", user_id=w.ann.id),
        ]
    )
    session.commit()
    store = MemoryObjectStore()
    for key in (
        f"blobs/{SHA_PHOTO}",
        f"blobs/.chunks/{SHA_PART}/00000",
        f"blobs/{SHA_KEPT}",
        "backups/pg/survey-2026-11-18T000000Z.dump",
    ):
        store.put_bytes(key, b"x")
    return w, project, vid, store


def count(session, model, *where):
    return session.scalar(select(func.count()).select_from(model).where(*where))


def test_every_table_is_classified():
    assert wipe.check_classified() == []


def test_the_dry_run_counts_and_changes_nothing(client, session, engine):
    _, project, _, store = build(client, session)
    ops_before = count(session, Op)
    p = wipe.run(engine, store, apply=False)
    assert p.gone["project"] == 1 and p.gone["device"] == 1 and p.gone["photo"] == 1
    assert p.gone["library_type"] == 1 and p.gone["suggestion"] == 1
    assert p.gone["review_item"] == 1 and p.kept["review_item"] == 0
    assert p.gone["vocab"] >= 1 and p.kept["vocab"] == 2  # the project's copy goes
    assert p.kept["app_user"] >= 2 and p.kept["install"] == 1
    assert p.gone["blob"] == 2 and p.kept["blob"] == 1
    assert any(line.startswith("project ") for line in p.lines())
    session.expire_all()
    assert count(session, Op) == ops_before and count(session, Project) == 1
    assert len(store.objects) == 4


def test_the_wipe_keeps_users_and_the_app_vocabulary_and_nothing_else(client, session, engine):
    w, project, vid, store = build(client, session)
    library_seq = w.pull(client)["server_seq"]
    p = wipe.run(engine, store, apply=True)
    session.expire_all()
    for model in (Project, Device, Photo, LibraryType, Suggestion, ReviewItem):
        assert count(session, model) == 0, model
    assert count(session, Op, Op.project_id.is_not(None)) == 0
    left = session.scalars(select(Op)).all()
    assert {o.entity_kind for o in left} == {"vocab"}  # type, chip, review-item ops gone
    assert count(session, Vocab, Vocab.project_id.is_not(None)) == 0
    assert session.get(Vocab, vid).value == "Station"
    assert count(session, RuleParam, RuleParam.project_id.is_(None)) == 1
    assert count(session, RuleParam, RuleParam.project_id.is_not(None)) == 0
    assert {o.op_id for o in left} >= set(session.scalars(select(FieldHead.op_id)))
    assert count(session, User) == p.kept["app_user"] and count(session, Install) == 1
    assert [b.sha256 for b in session.scalars(select(Blob))] == [SHA_KEPT]
    assert sorted(store.objects) == [
        "backups/pg/survey-2026-11-18T000000Z.dump",
        f"blobs/{SHA_KEPT}",
    ]
    # the library log keeps its kept ops and numbers on from them; the server works after
    pulled = w.pull(client)
    assert [o["entity_kind"] for o in pulled["ops"]] == ["vocab", "vocab"]
    assert pulled["server_seq"] <= library_seq
    tid, create = w.create(w.ann, "PI1002", category="Station")
    assert (
        w.push(client, [create], since=pulled["server_seq"])["results"][0]["outcome"] == "applied"
    )
    r = client.post("/projects", json={"name": "Tower", "levels": [{"level": "06M"}]}, headers=ANN)
    assert r.status_code == 201, r.text
    assert r.json()["copied"]["vocab"] >= 1
    # a second run finds the new data only
    again = wipe.run(engine, store, apply=False)
    assert again.gone["project"] == 1 and again.gone["library_type"] == 1


def test_an_app_value_naming_a_project_spelling_loses_the_link(client, session, engine):
    _, project, vid, store = build(client, session)
    theirs = session.scalars(
        select(Vocab).where(Vocab.project_id == uuid.UUID(project["id"]))
    ).first()
    session.get(Vocab, vid).canonical_of_id = theirs.id
    session.commit()
    wipe.run(engine, store, apply=True)
    session.expire_all()
    assert session.get(Vocab, vid).canonical_of_id is None


def test_a_kept_row_naming_a_gone_one_fails_the_whole_wipe(client, session, engine, monkeypatch):
    """Foreign keys are deferred: a row left pointing at a gone one fails the commit, and nothing
    changes (here: devices left behind under gone levels)."""
    _, _, _, store = build(client, session)
    tables = tuple(t for t in wipe.PROJECT_TABLES if t not in ("device", "photo"))
    monkeypatch.setattr(wipe, "PROJECT_TABLES", tables)
    with pytest.raises(IntegrityError):
        wipe.run(engine, store, apply=True)
    session.expire_all()
    assert count(session, Project) == 1 and count(session, LibraryType) == 1
    assert len(store.objects) == 4


def test_all_empties_every_table_and_the_bucket_but_the_backups(client, session, engine):
    """`--all` (Landry, 2026-11-18): users, the app vocabulary and rule defaults go too."""
    _, _, _, store = build(client, session)
    p = wipe.run(engine, store, apply=False, everything=True)
    assert p.gone["app_user"] >= 2 and p.gone["vocab"] >= 3 and p.gone["blob"] == 3
    assert set(p.kept.values()) == {0}
    wipe.run(engine, store, apply=True, everything=True)
    session.expire_all()
    for model in (User, Install, Vocab, RuleParam, Op, Project, LibraryType, Blob):
        assert count(session, model) == 0, model
    assert sorted(store.objects) == ["backups/pg/survey-2026-11-18T000000Z.dump"]
    # the server starts again from nothing
    r = client.post("/projects", json={"name": "Tower", "levels": [{"level": "06M"}]}, headers=ANN)
    assert r.status_code == 201, r.text
