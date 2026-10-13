"""Model round-trip tests (T02): every column of every table survives insert → reload."""

import re
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import ARRAY, CheckConstraint, String, inspect, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, vocab
from app.db import Base
from app.ids import uuid7

PLAN_ENTITIES = {
    "project",
    "level",
    "numbering_group",
    "sheet",
    "app_user",
    "assignment",
    "device",
    "accessory",
    "cable",
    "cable_end",
    "placeholder",
    "punch_item",
    "missing_part",
    "part_source",
    "photo_link",
    "photo",
    "ink_layer",
    "blob",
    "op",
    "review_item",
    "ruling",
    "proposal",
    "finding",
    "import_batch",
    "draft_device",
    "draft_cable",
    "library_type",
    "vocab",
    "export",
    "install",
    "field_head",
}
MAPPERS = {m.local_table.name: m for m in Base.registry.mappers}
WHEN = datetime(2026, 10, 9, 22, 3, 7, 123456, tzinfo=timezone(timedelta(hours=-5)))


def allowed_values(table) -> dict[str, list[str]]:
    out = {}
    for c in table.constraints:
        if isinstance(c, CheckConstraint):
            sql = str(c.sqltext)
            column = sql.split(" IN ", 1)[0]
            out[column] = [v.replace("''", "'") for v in re.findall(r"'((?:[^']|'')*)'", sql)]
    return out


def sample(table, column):
    """A non-default, non-null value of the column's type, valid for its CHECK constraint."""
    allowed = allowed_values(table).get(column.name)
    if allowed:
        return allowed[-1]
    t = column.type
    if isinstance(t, ARRAY):
        return [0, 2, 5]
    if isinstance(t, JSONB):
        if column.name in ("was", "now"):
            return "Installed, untested"
        return {"k": [1, "Run, not terminated; no term kit", None], "nested": {"x": 1.5}}
    if isinstance(t, String) and t.length == 64:
        return "ab" * 32
    if isinstance(t, String) and t.length == 12:
        return "0123456789AB"
    py = t.python_type
    if py is str:
        return f'{table.name}.{column.name} — "Stations & Sensors"; C-07'
    if py is bool:
        return not (column.default.arg if column.default is not None else False)
    if py is int:
        return 7
    if py is float:
        return 0.93
    if py is datetime:
        return WHEN
    if py is date:
        return date(2026, 10, 9)
    if py is uuid.UUID:
        return uuid7()
    raise AssertionError(f"no sample for {table.name}.{column.name} ({t!r})")


def full_graph() -> list:
    """One fully populated row per table, every FK pointing at another row of the graph."""
    keys: dict[tuple[str, str], object] = {}
    for name, mapper in MAPPERS.items():
        for col in mapper.local_table.primary_key:
            if not col.foreign_keys:
                keys[(name, col.name)] = sample(mapper.local_table, col)
    rows = []
    for name, mapper in MAPPERS.items():
        table = mapper.local_table
        values = {}
        for col in table.columns:
            if (name, col.name) in keys:
                values[col.name] = keys[(name, col.name)]
            elif col.foreign_keys:
                ref = next(iter(col.foreign_keys)).column
                values[col.name] = keys[(ref.table.name, ref.name)]
            else:
                values[col.name] = sample(table, col)
        attrs = {mapper.get_property_by_column(table.c[k]).key: v for k, v in values.items()}
        rows.append(mapper.class_(**attrs))
    return rows


def snapshot(obj) -> dict:
    return {a.key: a.value for a in inspect(obj).attrs}


def test_every_plan_entity_has_a_table():
    assert set(MAPPERS) == PLAN_ENTITIES


def test_round_trip_every_column(session: Session, engine):
    rows = full_graph()
    expected = [(type(r), snapshot(r)) for r in rows]
    session.add_all(rows)
    session.commit()  # deferred FKs (incl. the circular ones) are checked here

    with Session(engine) as fresh:
        for cls, want in expected:
            pk = tuple(want[c.key] for c in inspect(cls).primary_key)
            got = fresh.get(cls, pk if len(pk) > 1 else pk[0])
            assert got is not None, cls.__name__
            assert snapshot(got) == want, cls.__name__


def test_library_type_project_is_nullable(session: Session):
    """D65: project null = app-level library."""
    session.add(models.LibraryType(model="PI1104", category="Station", state="accepted"))
    session.commit()
    app_level = session.scalars(
        select(models.LibraryType).where(models.LibraryType.project_id.is_(None))
    ).all()
    assert [t.model for t in app_level] == ["PI1104"]
    assert app_level[0].id.version == 7


def _project(session: Session) -> models.Level:
    p = models.Project(id=uuid7(), name="Houston Methodist Centennial Tower")
    g = models.NumberingGroup(id=uuid7(), project_id=p.id, label="06/06M")
    lvl = models.Level(id=uuid7(), project_id=p.id, level="06M", numbering_group_id=g.id)
    session.add_all([p, g, lvl])
    session.flush()
    return lvl


def test_defaults(session: Session):
    lvl = _project(session)
    session.commit()
    session.refresh(lvl)
    assert (lvl.state, lvl.in_scope, lvl.version, lvl.deleted_at) == ("setup", True, 0, None)


@pytest.mark.parametrize(
    "model, field, bad",
    [
        (models.Device, "status", "Installed untested"),
        (models.PunchItem, "owner", "ETC/EC"),
        (models.PunchItem, "type", "Missing Part"),
        (models.CableEnd, "status", "not started"),
    ],
)
def test_fixed_lists_reject_paraphrases(session: Session, model, field, bad):
    lvl = _project(session)
    extra = {"level_id": lvl.id}
    if model is models.CableEnd:
        cable = models.Cable(id=uuid7(), project_id=lvl.project_id, cable="X")
        session.add(cable)
        extra = {"cable_id": cable.id, "side": "A"}
    session.add(model(**extra, **{field: bad}))
    with pytest.raises(IntegrityError):
        session.flush()
    session.rollback()


def test_fixed_lists_accept_exact_strings(session: Session):
    lvl = _project(session)
    for status in vocab.DEVICE_STATUS:
        session.add(models.Device(level_id=lvl.id, status=status))
    for owner in vocab.OWNER:
        session.add(models.PunchItem(level_id=lvl.id, owner=owner, type="Information"))
    session.commit()


def test_soft_delete_keeps_the_row(session: Session):
    lvl = _project(session)
    d = models.Device(level_id=lvl.id, display_id="06M-04", status="Issue")
    session.add(d)
    session.commit()
    d.deleted_at, d.delete_reason = WHEN, "Duplicate pin"
    session.commit()
    assert session.get(models.Device, d.id).delete_reason == "Duplicate pin"


def test_uuid7_is_time_ordered():
    ids = [uuid7() for _ in range(50)]
    assert all(i.version == 7 and i.variant == uuid.RFC_4122 for i in ids)
    ms = [i.int >> 80 for i in ids]
    assert ms == sorted(ms)
