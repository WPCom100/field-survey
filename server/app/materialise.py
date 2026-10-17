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

import functools
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
    bindparam,
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
LINK_OWNER = {
    "assignment": "level_id",
    "part_source": "missing_part_id",
    "photo_link": "photo_id",
}

# ------------------------------------------------------- multi-row statements (T76)


@functools.lru_cache(maxsize=512)
def multirow_insert(table_name: str, columns: tuple[str, ...], n: int, conflict: str = ""):
    """A prebuilt `INSERT … VALUES (…), …` of `n` rows over `columns`, with typed bind
    parameters `<column>_<i>`, so SQLAlchemy compiles each shape once instead of on every
    execution (a 10-row VALUES compiled afresh cost about as much as its round trip, T76).
    `conflict`: "" plain, "nothing" ON CONFLICT DO NOTHING, or the comma-joined key columns of
    an upsert that overwrites every other column."""
    table = TABLES[table_name]
    stmt = pg_insert(table).values(
        [{c: bindparam(f"{c}_{i}", type_=table.c[c].type) for c in columns} for i in range(n)]
    )
    if conflict == "nothing":
        return stmt.on_conflict_do_nothing()
    if conflict:
        keys = conflict.split(",")
        return stmt.on_conflict_do_update(
            index_elements=keys,
            set_={c: stmt.excluded[c] for c in columns if c not in keys},
        )
    return stmt


def insert_rows(
    session: Session, table_name: str, rows: list[dict[str, Any]], conflict: str = ""
) -> None:
    """Execute `multirow_insert` for rows that all have the same keys."""
    columns = tuple(sorted(rows[0]))
    params = {f"{c}_{i}": row[c] for i, row in enumerate(rows) for c in columns}
    session.execute(multirow_insert(table_name, columns, len(rows), conflict), params)


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


class RowBuffer:
    """The rows one push creates, written up to `BATCH` per INSERT instead of one statement each
    (T76).

    Whether a create's row already exists is looked up once per push and table (`preload`), not
    per row. A `set`, `assign`, `delete` or `restore` on a row still pending is applied to it in
    memory with the values its UPDATE would write, so a numbered create and its `assign` cost one
    row of one INSERT. Anything that reads or updates an entity table by other means calls
    `flush` first (the push does it in `flush_ops`). The rows written are the ones a one-op-at-a-
    time projection gives, so `replay` (which uses no buffer) reproduces them exactly."""

    # Ten rows per statement: larger requests stall ~45 ms on a Windows ↔ Docker socket (T75, T76).
    BATCH = 10

    def __init__(self, session: Session):
        self.session = session
        self.checked: set[tuple[str, uuid.UUID]] = set()
        self.exists: set[tuple[str, uuid.UUID]] = set()
        self.pending: dict[tuple[str, uuid.UUID], dict[str, Any]] = {}

    def preload(self, entity_kind: str, ids: list[uuid.UUID]) -> None:
        """Which of these rows already exist, in one query."""
        ids = [i for i in ids if (entity_kind, i) not in self.checked]
        if not ids:
            return
        table = TABLES[entity_kind]
        found = self.session.scalars(select(table.c.id).where(table.c.id.in_(ids)))
        self.exists.update((entity_kind, i) for i in found)
        self.checked.update((entity_kind, i) for i in ids)

    def add(self, entity_kind: str, values: dict[str, Any]) -> bool:
        """Queue a created row; False when it already exists (a replayed create never
        overwrites)."""
        key = (entity_kind, values["id"])
        if key not in self.checked:
            self.preload(entity_kind, [values["id"]])
        if key in self.exists:
            return False
        if len(self.pending) >= self.BATCH:
            self.flush()  # before queueing, so the newest row stays pending for its `assign`
        self.exists.add(key)
        self.pending[key] = values
        return True

    def get(self, entity_kind: str, entity_id: uuid.UUID) -> dict[str, Any] | None:
        return self.pending.get((entity_kind, entity_id))

    def flush(self) -> None:
        """One INSERT per table and column set (a multi-row VALUES lists the same columns)."""
        if not self.pending:
            return
        groups: dict[tuple[str, tuple[str, ...]], list[dict[str, Any]]] = {}
        for (kind, _), values in self.pending.items():
            groups.setdefault((kind, tuple(sorted(values))), []).append(values)
        self.pending = {}
        for (kind, _), rows in groups.items():
            insert_rows(self.session, kind, rows, "nothing")


def materialise(session: Session, op: Op, rows: RowBuffer | None = None) -> bool:
    """Project one applied op onto its entity table. Returns False for an orphan (no row) or a
    `create` whose row already existed. A push passes its `rows` buffer (T76)."""
    table = TABLES[op.entity_kind]
    match op.kind:
        case "create":
            return _create(session, table, op, rows)
        case "set" | "assign":
            return _set(session, table, op, rows)
        case "delete":
            return _delete(session, table, op, True, rows)
        case "restore":
            return _delete(session, table, op, False, rows)
        case "link_add":
            return _link(session, table, op, True)
        case "link_remove":
            return _link(session, table, op, False)
    raise AssertionError(op.kind)


def _create(session: Session, table: Table, op: Op, rows: RowBuffer | None) -> bool:
    """True when the row was inserted; False when it already existed (a replayed create, which
    never overwrites) — the push loop uses that to skip the head lookup of a brand-new record."""
    values = _values(table, {**(op.payload or {}), "id": op.entity_id})
    if _is_record(table):
        values["version"] = 1
        values["head_seq"] = op.server_seq
    if rows is not None:
        return rows.add(op.entity_kind, values)
    # RETURNING tells inserted from skipped (psycopg reports no rowcount for this statement).
    stmt = pg_insert(table).values(**values).on_conflict_do_nothing().returning(table.c.id)
    return session.execute(stmt).first() is not None


def _set(session: Session, table: Table, op: Op, rows: RowBuffer | None) -> bool:
    field = op.field or ""
    value = coerce(table.c[field], op.now)
    pending = rows.get(op.entity_kind, op.entity_id) if rows is not None else None
    if pending is not None:
        pending[field] = value
        if _is_record(table):
            _bump(pending, op.server_seq)
        found = True
    else:
        values: dict[str, Any] = {field: value}
        if _is_record(table):
            values["version"] = table.c.version + 1
            values["head_seq"] = _head_seq(table, op.server_seq)
        pk = table.primary_key.columns.values()[0]
        result = session.execute(update(table).where(pk == op.entity_id).values(**values))
        found = _found(result.rowcount, op)
    if found and op.entity_kind == "review_item" and field == "state" and op.now in SETTLED:
        if rows is not None:
            rows.flush()
        _settle_review(session, table, op.entity_id)
    return found


def _bump(pending: dict[str, Any], seq: int | None) -> None:
    """What `version + 1, head_seq = greatest(head_seq, seq)` does, on a row not yet written."""
    pending["version"] = (pending.get("version") or 0) + 1
    pending["head_seq"] = max(pending.get("head_seq") or 0, seq or 0)


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


def _delete(session: Session, table: Table, op: Op, deleted: bool, rows: RowBuffer | None) -> bool:
    values: dict[str, Any] = {
        "deleted_at": (op.server_ts or op.client_ts) if deleted else None,
        "deleted_by_id": op.user_id if deleted else None,
        "delete_reason": op.reason if deleted else None,
    }
    pending = rows.get(op.entity_kind, op.entity_id) if rows is not None else None
    if pending is not None:
        pending.update(values)
        _bump(pending, op.server_seq)
        return True
    values["version"] = table.c.version + 1
    values["head_seq"] = _head_seq(table, op.server_seq)
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
