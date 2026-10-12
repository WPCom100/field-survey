"""Materialised state from the op log (T10).

The op log is the source of truth (PLAN §2.1); the entity tables are a projection of every op
in state `applied`, kept in step inside the push transaction and rebuildable with `replay`.
The projection mirrors the client store (D81) so a replayed server and a synced iPad agree:

| Kind | Effect | `version` / `head_seq` (records only) |
|---|---|---|
| `create` | INSERT the payload (`id` = `entity_id`); a replay never overwrites | `1` / `seq` |
| `set`, `assign` | `field = now` | `+1` / `max(head_seq, server_seq)` |
| `delete` | `deleted_at = server_ts`, `deleted_by_id`, `delete_reason = reason` | `+1` / max |
| `restore` | clears the three | `+1` / max |
| `link_add` | INSERT … ON CONFLICT (pk) DO UPDATE (revives a removed link) | — |
| `link_remove` | `deleted_at`, `deleted_by_id` on the link row | — |

Ops in state `review`, `superseded` or `rejected` are never materialised (the first-arrived value
stays official, A7). Setting `review_item.state` to `resolved`/`dismissed` settles the ops the item
held, as its `resolution` lists them (T15, D91). A `set`/`delete` whose row is missing is logged
as `materialise_orphan` and skipped; the log still holds the op.

Payload values arrive as JSON (UUIDs, dates and timestamps as strings) and are coerced to the
column's Python type here. Foreign keys are deferred (D76), so a push may create records in any
order; a reference the server has never seen fails the whole push at commit (409 from the route).
"""

import json
import logging
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    ARRAY,
    Boolean,
    Column,
    Date,
    DateTime,
    Float,
    Integer,
    Table,
    Uuid,
    func,
    select,
    update,
)
from sqlalchemy import delete as sa_delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db import Base
from app.models import Op

log = logging.getLogger("sync")

TABLES = Base.metadata.tables
LINK_OWNER = {"assignment": "level_id", "part_source": "missing_part_id"}

# ------------------------------------------------------------------- coercion


def coerce(column: Column, value: Any) -> Any:
    """A JSON value from an op payload → the column's Python type."""
    if value is None:
        return None
    t = column.type
    if isinstance(t, Uuid):
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    if isinstance(t, DateTime):
        return value if isinstance(value, datetime) else _datetime(value)
    if isinstance(t, Date):
        if isinstance(value, datetime):
            return value.date()
        return value if isinstance(value, date) else date.fromisoformat(str(value))
    if isinstance(t, Boolean):
        return bool(value)
    if isinstance(t, Integer):
        return int(value)
    if isinstance(t, Float):
        return float(value)
    if isinstance(t, ARRAY):
        return list(value)
    return value


def _datetime(value: Any) -> datetime:
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _values(table: Table, payload: dict[str, Any]) -> dict[str, Any]:
    return {name: coerce(table.c[name], value) for name, value in payload.items()}


def _is_record(table: Table) -> bool:
    return "version" in table.c


def _head_seq(table: Table, seq: int | None) -> Any:
    return func.greatest(func.coalesce(table.c.head_seq, 0), seq or 0)


# ------------------------------------------------------------------- applying


def materialise(session: Session, op: Op) -> bool:
    """Project one applied op onto its entity table. Returns False for an orphan (no row)."""
    table = TABLES[op.entity_kind]
    match op.kind:
        case "create":
            return _create(session, table, op)
        case "set" | "assign":
            return _set(session, table, op)
        case "delete":
            return _delete(session, table, op, True)
        case "restore":
            return _delete(session, table, op, False)
        case "link_add":
            return _link(session, table, op, True)
        case "link_remove":
            return _link(session, table, op, False)
    raise AssertionError(op.kind)


def _create(session: Session, table: Table, op: Op) -> bool:
    values = _values(table, {**(op.payload or {}), "id": op.entity_id})
    if _is_record(table):
        values["version"] = 1
        values["head_seq"] = op.server_seq
    session.execute(pg_insert(table).values(**values).on_conflict_do_nothing())
    return True


def _set(session: Session, table: Table, op: Op) -> bool:
    field = op.field or ""
    values: dict[str, Any] = {field: coerce(table.c[field], op.now)}
    if _is_record(table):
        values["version"] = table.c.version + 1
        values["head_seq"] = _head_seq(table, op.server_seq)
    pk = table.primary_key.columns.values()[0]
    result = session.execute(update(table).where(pk == op.entity_id).values(**values))
    found = _found(result.rowcount, op)
    if found and op.entity_kind == "review_item" and field == "state" and op.now in SETTLED:
        _settle_review(session, table, op.entity_id)
    return found


# A review item leaving `open` settles the ops it held (T15, D91).
SETTLED = ("resolved", "dismissed")


def _settle_review(session: Session, table: Table, item_id: uuid.UUID) -> None:
    """The ops a resolved item held in `review` leave it as its `resolution` says: the loser
    `rejected`, a winning side B `superseded` (its value was applied by the `Reconcile` op).
    Only ops still in `review` move, so a replay or a second resolution changes nothing; the
    client store does the same when it materialises this op, so every log agrees (D91)."""
    resolution = session.execute(
        select(table.c.resolution).where(table.c.id == item_id)
    ).scalar_one_or_none()
    if not isinstance(resolution, dict):
        return
    for state, key in (("rejected", "rejected_op_ids"), ("superseded", "superseded_op_ids")):
        ids = [uuid.UUID(str(i)) for i in resolution.get(key) or []]
        if ids:
            session.execute(
                update(Op).where(Op.op_id.in_(ids), Op.state == "review").values(state=state)
            )


def _delete(session: Session, table: Table, op: Op, deleted: bool) -> bool:
    values: dict[str, Any] = {
        "deleted_at": (op.server_ts or op.client_ts) if deleted else None,
        "deleted_by_id": op.user_id if deleted else None,
        "delete_reason": op.reason if deleted else None,
        "version": table.c.version + 1,
        "head_seq": _head_seq(table, op.server_seq),
    }
    result = session.execute(update(table).where(table.c.id == op.entity_id).values(**values))
    return _found(result.rowcount, op)


def _link(session: Session, table: Table, op: Op, add: bool) -> bool:
    owner = LINK_OWNER[op.entity_kind]
    skip = ("deleted_at", "deleted_by_id")
    payload = {k: v for k, v in (op.payload or {}).items() if k not in skip}
    values = _values(table, {**payload, owner: op.entity_id})
    pk_names = [c.name for c in table.primary_key.columns]
    key = {k: values[k] for k in pk_names}
    if add:
        updates = {k: v for k, v in values.items() if k not in pk_names}
        updates["deleted_at"] = None
        updates["deleted_by_id"] = None
        stmt = pg_insert(table).values(**values)
        session.execute(stmt.on_conflict_do_update(index_elements=pk_names, set_=updates))
        return True
    where = [table.c[k] == v for k, v in key.items()]
    result = session.execute(
        update(table)
        .where(*where)
        .values(deleted_at=op.server_ts or op.client_ts, deleted_by_id=op.user_id)
    )
    return _found(result.rowcount, op)


def _found(rowcount: int, op: Op) -> bool:
    if rowcount:
        return True
    log.warning(
        json.dumps(
            {
                "event": "materialise_orphan",
                "op_id": str(op.op_id),
                "kind": op.kind,
                "entity_kind": op.entity_kind,
                "entity_id": str(op.entity_id),
                "field": op.field,
            }
        )
    )
    return False


# --------------------------------------------------------------------- replay


def replay(session: Session, project_id: uuid.UUID, *, reset: bool = True) -> int:
    """Rebuild a project's materialised state from its op log, inside the caller's transaction.

    With `reset`, every row an op of this project created (and every link row its link ops
    touched) is deleted first, except `project` and `numbering_group` rows: `POST /projects`
    writes them as ops too (T41, D127), but the group counters live outside the log and the
    project row is what every push locks, so both stay and their creates re-apply as no-ops.
    `app_user` rows are never in the log. Then every op in state `applied` is projected again
    in `server_seq` order. Returns the number of ops replayed.
    """
    if reset:
        created = (
            select(Op.entity_id)
            .where(Op.project_id == project_id, Op.kind == "create", Op.state == "applied")
            .scalar_subquery()
        )
        for name, table in TABLES.items():
            if name in ("op", "field_head", "project", "numbering_group"):
                continue
            if name in LINK_OWNER:
                owners = (
                    select(Op.entity_id)
                    .where(Op.project_id == project_id, Op.entity_kind == name)
                    .scalar_subquery()
                )
                session.execute(sa_delete(table).where(table.c[LINK_OWNER[name]].in_(owners)))
            else:
                pk = table.primary_key.columns.values()[0]
                if isinstance(pk.type, Uuid):
                    session.execute(sa_delete(table).where(pk.in_(created)))
    ops = session.scalars(
        select(Op).where(Op.project_id == project_id, Op.state == "applied").order_by(Op.server_seq)
    )
    n = 0
    for op in ops:
        materialise(session, op)
        n += 1
    return n
