"""Server apply loop for `POST /ops` (PLAN §3.2 steps 1–7, §3.3; T09, D84) and the pull
query behind `GET /ops` (T10).

One push = one transaction, ops in arrival order. Decisions are made from the op log and
`field_head`; every op stored as `applied` is also projected onto its entity table by
`app.materialise` (T10). Outcomes per op:

- `applied`     stored with a `server_seq`, heads moved.
- `duplicate`   `op_id` already known; nothing written (the earlier `server_seq` is returned).
- `review`      stored in state `review`; the head value stays official (A7, D37) and a
                `review_item(sync_conflict)` is created, delivered as a server `create` op.
- `superseded`  same user, older `client_ts` than the head set from another iPad (D37):
                stored, never materialised.

Server-generated ops (`assign`, the review-item `create`) carry `install_id =
SERVER_INSTALL_ID` and `base_op_id` = the op that caused them, so a retried push can
return them again.
"""

import json
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import bindparam, func, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app import vocab
from app.db import Base
from app.ids import uuid7
from app.materialise import materialise
from app.models import FieldHead, Level, Op, Project, ReviewItem, User
from app.numbering import (
    NUMBERED,
    TAG_PREFIX,
    DeviceNumberCache,
    device_scheme,
    next_device_id,
    next_number,
    note_device_id,
    numbering_group_for_level,
    parse_number,
)

log = logging.getLogger("sync")

SERVER_INSTALL_ID = uuid.uuid5(uuid.NAMESPACE_URL, "field-survey:server")
MAX_OPS_PER_PUSH = 500
OP_INSERT_BATCH = 10

# ---------------------------------------------------------------- schema registry

TABLES = Base.metadata.tables
OP_TARGETS = frozenset(TABLES) - {"op", "field_head"}
PROTECTED = frozenset({"id", "version", "head_seq", "deleted_at", "deleted_by_id", "delete_reason"})
RECORDS = frozenset(t for t, tbl in TABLES.items() if "version" in tbl.c)
# link table → owning column (the op's `entity_id`); key = the other primary-key columns
LINK_OWNER = {
    "assignment": "level_id",
    "part_source": "missing_part_id",
    "photo_link": "photo_id",
}
LINK_KEY = {
    t: [c.name for c in TABLES[t].primary_key if c.name != owner] for t, owner in LINK_OWNER.items()
}
SERVER_ASSIGNED = frozenset((kind, f) for kind, (_, f) in NUMBERED.items())
CLIENT_OP_KINDS = frozenset(vocab.OP_KIND) - {"assign"}
# Attachments and ink layers never conflict (PLAN §3.3): last write wins.
LAST_WRITE_WINS_ENTITIES = frozenset({"ink_layer"})
LAST_WRITE_WINS_FIELDS = frozenset(
    {("photo", "image_blob"), ("photo", "thumb_blob"), ("photo", "markup_blob")}
)
ENUMS: dict[tuple[str, str], tuple[str, ...]] = {
    (t, c.info["column"]): c.info["values"]
    for t, tbl in TABLES.items()
    for c in tbl.constraints
    if c.info.get("values")
}

Outcome = Literal["applied", "duplicate", "review", "superseded"]


class PushError(Exception):
    def __init__(self, status: int, detail: Any):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------------ wire types


class OpIn(BaseModel):
    """An op as the client pushes it (PLAN §3.1, D76 names). Server-side fields are ignored."""

    model_config = ConfigDict(extra="ignore")

    op_id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    install_id: uuid.UUID
    client_ts: datetime
    entity_kind: str
    entity_id: uuid.UUID
    kind: str
    field: str | None = None
    was: Any = None
    now: Any = None
    payload: dict[str, Any] | None = None
    base_op_id: uuid.UUID | None = None
    group_id: uuid.UUID | None = None
    change_type: str
    reason: str | None = None
    ruling_id: uuid.UUID | None = None
    proposal_id: uuid.UUID | None = None


class PushIn(BaseModel):
    project_id: uuid.UUID
    # The install's pull cursor (`last_server_seq:<project>`) when the push was built: ops
    # above it are ones the install had not seen (D84). Null = treat every other user's
    # op as unseen.
    since: int | None = Field(default=None, ge=0)
    ops: list[OpIn] = Field(max_length=MAX_OPS_PER_PUSH)


class OpResult(BaseModel):
    op_id: uuid.UUID
    outcome: Outcome
    server_seq: int | None
    review_item_id: uuid.UUID | None = None


class PushOut(BaseModel):
    results: list[OpResult]
    # `assign` ops and review-item `create` ops caused by this push (or by the duplicates in it).
    server_ops: list[dict[str, Any]]
    # Highest `server_seq` in the project after the push.
    server_seq: int


class PullOut(BaseModel):
    """`GET /ops?project_id&since&limit`: ops with `server_seq > since`, oldest first, every
    state included (the client acknowledges its own echoes and records reviewed ones, D81)."""

    ops: list[dict[str, Any]]
    # Highest `server_seq` in the project (not of this page): the client is caught up when the
    # cursor reaches it.
    server_seq: int
    has_more: bool


MAX_OPS_PER_PULL = 500


def pull_ops(session: Session, project_id: uuid.UUID, since: int, limit: int) -> PullOut:
    """The top sequence is read **before** the page (T74, D144): a push committing between the
    two statements (READ COMMITTED: each sees its own snapshot) can then only add ops to the page,
    never raise the top above a page that misses them. The client treats an empty page under a
    higher top as a gap and keeps its cursor; this ordering means it never sees one."""
    if session.get(Project, project_id) is None:
        raise PushError(404, f"unknown project {project_id}")
    limit = max(1, min(limit, MAX_OPS_PER_PULL))
    top = _pull_top(session, project_id)
    rows = _pull_page(session, project_id, since, limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    if rows:
        top = max(top, rows[-1].server_seq or 0)
    return PullOut(ops=[op_to_json(o) for o in rows], server_seq=top, has_more=has_more)


def _pull_top(session: Session, project_id: uuid.UUID) -> int:
    return session.scalar(select(func.max(Op.server_seq)).where(Op.project_id == project_id)) or 0


def _pull_page(session: Session, project_id: uuid.UUID, since: int, n: int) -> list[Op]:
    return list(
        session.scalars(
            select(Op)
            .where(Op.project_id == project_id, Op.server_seq > since)
            .order_by(Op.server_seq)
            .limit(n)
        )
    )


# ----------------------------------------------------------------- validation


def _check_enum(kind: str, column: str, value: Any, where: str) -> None:
    allowed = ENUMS.get((kind, column))
    if value is not None and allowed and value not in allowed:
        raise ValueError(f"{where}: {kind}.{column} must be one of {' · '.join(allowed)}")


def validate_op(op: OpIn, project_id: uuid.UUID, *, trusted: bool = False) -> None:
    """Shape checks the client already made (T07/T08); a failure means a client bug → 422.

    A `trusted` producer (the seed import, T27) may carry display numbers in a `create`
    payload: the master's `#`, photo numbers, `C-nn` and device IDs are kept, never renumbered
    (D25). A `set` on a server-assigned field is refused either way."""
    if op.project_id != project_id:
        raise ValueError("op.project_id differs from the push's project_id")
    if op.entity_kind not in OP_TARGETS:
        raise ValueError(f"unknown entity_kind {op.entity_kind!r}")
    if op.kind not in CLIENT_OP_KINDS:
        raise ValueError(f"bad op kind {op.kind!r} (assign is server-only)")
    if op.change_type not in vocab.CHANGE_TYPE:
        raise ValueError(f"bad change_type {op.change_type!r}")
    table = TABLES[op.entity_kind]
    is_link = op.entity_kind in LINK_OWNER
    if (op.kind in ("link_add", "link_remove")) != is_link:
        raise ValueError(f"{op.kind} is not allowed on {op.entity_kind}")
    if op.kind in ("delete", "restore") and op.entity_kind not in RECORDS:
        raise ValueError(f"{op.kind} is not allowed on {op.entity_kind}")
    if op.kind == "set":
        if not op.field:
            raise ValueError("set needs a field")
        if (
            op.field not in table.c
            or op.field in PROTECTED
            or op.field in table.primary_key.columns
        ):
            raise ValueError(f"{op.entity_kind}.{op.field} is not settable")
        if (op.entity_kind, op.field) in SERVER_ASSIGNED:
            raise ValueError(f"{op.entity_kind}.{op.field} is assigned by the server")
        _check_enum(op.entity_kind, op.field, op.now, "set")
    elif op.kind == "create":
        if op.payload is None:
            raise ValueError("create needs a payload")
        for name, value in op.payload.items():
            if name not in table.c:
                raise ValueError(f"unknown column {op.entity_kind}.{name}")
            if name == "id":
                if str(value) != str(op.entity_id):
                    raise ValueError("payload.id does not match entity_id")
            elif name in PROTECTED:
                raise ValueError(f"{op.entity_kind}.{name} is not settable")
            if (op.entity_kind, name) in SERVER_ASSIGNED and value is not None and not trusted:
                raise ValueError(f"{op.entity_kind}.{name} is assigned by the server")
            _check_enum(op.entity_kind, name, value, "create")
    elif is_link:
        payload = op.payload or {}
        for name in LINK_KEY[op.entity_kind]:
            if payload.get(name) is None:
                raise ValueError(f"{op.kind} on {op.entity_kind} needs payload.{name}")
        for name, value in payload.items():
            if name not in table.c or name in (
                LINK_OWNER[op.entity_kind],
                "deleted_at",
                "deleted_by_id",
            ):
                raise ValueError(f"{op.entity_kind}.{name} is not part of the link")
            _check_enum(op.entity_kind, name, value, op.kind)


# ------------------------------------------------------------------- helpers


def jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


OP_COLUMNS = [c.name for c in TABLES["op"].c]
# The one-head upsert is prebuilt (compiled once, prepared by psycopg): it runs once or twice
# per op, so its build cost shows at 500 ops per push (T75).
_HEAD = pg_insert(TABLES["field_head"]).values(
    entity_id=bindparam("entity_id"), field=bindparam("field"), op_id=bindparam("op_id")
)
UPSERT_HEAD = _HEAD.on_conflict_do_update(
    index_elements=["entity_id", "field"], set_={"op_id": _HEAD.excluded.op_id}
)


def op_to_json(op: Op) -> dict[str, Any]:
    return {c: jsonable(getattr(op, c)) for c in OP_COLUMNS}


def value_of(head: Op, field: str) -> Any:
    """The official value a head op gives its field."""
    if head.kind == "create":
        return (head.payload or {}).get(field)
    if head.kind in ("set", "assign"):
        return head.now
    if head.kind in ("delete", "restore"):
        return head.kind == "delete"
    return None


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


@dataclass
class Decision:
    outcome: Outcome
    # The op the decision was made against (official side of a review).
    head: Op | None = None
    # Fields whose head moves to this op when applied.
    heads: list[str] = dc_field(default_factory=list)


Overlay = dict[tuple[uuid.UUID, str], Op]


class Push:
    def __init__(self, session: Session, body: PushIn, *, trusted: bool = False):
        self.session = session
        self.project_id = body.project_id
        self.since = body.since
        self.now = datetime.now(UTC)
        self.seq = 0
        self.server_ops: list[Op] = []
        self.duplicates: list[uuid.UUID] = []
        # Server-side producers (the seed import) may carry display numbers; see `validate_op`.
        self.trusted = trusted
        # Highest device number per (level code, prefix) seen so far in this push (T75, D146).
        self.device_numbers: DeviceNumberCache = {}
        # Ops of this push the log already holds (duplicates), looked up once per push.
        self.known: dict[uuid.UUID, Op] = {}
        # Head op per (entity, field) seen in this push (None = known absent) and the entities
        # whose heads were loaded whole: a create's heads cost one query and one upsert, not one
        # `get` + flush per field (T75; `field_head` is written with Core statements, see
        # `set_heads`).
        self.head_ids: dict[tuple[uuid.UUID, str], uuid.UUID | None] = {}
        self.heads_loaded: set[uuid.UUID] = set()
        # Ops this push wrote, and the rows not yet written to the `op` table: they go out in
        # multi-row INSERTs (`flush_ops`) before anything reads the table and at the end of the
        # push — one statement per hundred ops instead of one ORM flush each (T75).
        self.stored: dict[uuid.UUID, Op] = {}
        self.pending_ops: list[dict[str, Any]] = []

    # ------------------------------------------------------------- entry point

    def run(self, ops: list[OpIn]) -> PushOut:
        for i, op in enumerate(ops):
            try:
                validate_op(op, self.project_id, trusted=self.trusted)
            except ValueError as e:
                raise PushError(422, {"index": i, "op_id": str(op.op_id), "error": str(e)}) from e
        known = set(
            self.session.scalars(select(User.id).where(User.id.in_({o.user_id for o in ops})))
        )
        for i, op in enumerate(ops):
            if op.user_id not in known:
                raise PushError(
                    422, {"index": i, "op_id": str(op.op_id), "error": f"unknown user {op.user_id}"}
                )

        # Serialises pushes per project: server_seq has no gaps and counters never race.
        project = self.session.scalars(
            select(Project).where(Project.id == self.project_id).with_for_update()
        ).first()
        if project is None:
            raise PushError(404, f"unknown project {self.project_id}")
        self.seq = (
            self.session.scalar(
                select(func.max(Op.server_seq)).where(Op.project_id == self.project_id)
            )
            or 0
        )

        self.known = {
            o.op_id: o
            for o in self.session.scalars(select(Op).where(Op.op_id.in_([o.op_id for o in ops])))
        }
        results: list[OpResult | None] = [None] * len(ops)
        groups: dict[uuid.UUID, list[int]] = defaultdict(list)
        for i, op in enumerate(ops):
            if op.group_id is not None:
                groups[op.group_id].append(i)
        done: set[int] = set()
        for i, op in enumerate(ops):
            if i in done:
                continue
            members = groups[op.group_id] if op.group_id is not None else [i]
            if len(members) > 1:
                for j, r in zip(members, self.apply_group([ops[j] for j in members]), strict=True):
                    results[j] = r
                done.update(members)
            else:
                results[i] = self.apply_one(op)

        self.flush_ops()
        server_ops = [op_to_json(o) for o in self.server_ops]
        if self.duplicates:
            earlier = self.session.scalars(
                select(Op)
                .where(Op.install_id == SERVER_INSTALL_ID, Op.base_op_id.in_(self.duplicates))
                .order_by(Op.server_seq)
            )
            server_ops += [op_to_json(o) for o in earlier]
        counts: dict[str, int] = defaultdict(int)
        for r in results:
            counts[r.outcome] += 1  # type: ignore[union-attr]
        log.info(
            json.dumps(
                {
                    "event": "push",
                    "project": str(self.project_id),
                    "ops": len(ops),
                    "server_ops": len(self.server_ops),
                    "last_seq": self.seq,
                    **counts,
                }
            )
        )
        return PushOut(results=results, server_ops=server_ops, server_seq=self.seq)  # type: ignore[arg-type]

    # ------------------------------------------------------------- single op

    def apply_one(self, op: OpIn) -> OpResult:
        existing = self.known.get(op.op_id)
        if existing is not None:
            self.duplicates.append(op.op_id)
            return OpResult(op_id=op.op_id, outcome="duplicate", server_seq=existing.server_seq)
        row = self.build(op)
        return self.commit(row, self.decide(row, {}))

    def commit(self, row: Op, d: Decision) -> OpResult:
        if d.outcome == "applied":
            self.store(row, "applied")
            if row.kind == "create":
                self.load_heads(row.entity_id)  # one query for every field of the new record
            self.set_heads([(row.entity_id, f, row.op_id) for f in d.heads])
            if row.kind == "create":
                self.assign(row)
            return OpResult(op_id=row.op_id, outcome="applied", server_seq=row.server_seq)
        if d.outcome == "superseded":
            self.store(row, "superseded")
            return OpResult(op_id=row.op_id, outcome="superseded", server_seq=row.server_seq)
        self.store(row, "review")
        item = self.review([(row, d.head)])
        return OpResult(
            op_id=row.op_id, outcome="review", server_seq=row.server_seq, review_item_id=item.id
        )

    # ----------------------------------------------------------------- groups

    def apply_group(self, members: list[OpIn]) -> list[OpResult]:
        """Grouped edits (one `group_id`) are decided together with an overlay of their own
        heads, then reviewed as one (PLAN §3.3 field groups): if any member conflicts, every
        member that would have applied goes to review under one review item. `create` and
        `link_add` never conflict and still apply."""
        overlay: Overlay = {}
        rows: list[Op | None] = []
        decisions: list[Decision | None] = []
        for m in members:
            existing = self.known.get(m.op_id)
            if existing is not None:
                self.duplicates.append(m.op_id)
                rows.append(None)
                decisions.append(None)
                continue
            row = self.build(m)
            d = self.decide(row, overlay)
            if d.outcome == "applied":
                for f in d.heads:
                    overlay[(row.entity_id, f)] = row
            rows.append(row)
            decisions.append(d)

        conflicts = [
            (r, d) for r, d in zip(rows, decisions, strict=True) if d and d.outcome == "review"
        ]
        if not conflicts:
            return [
                OpResult(
                    op_id=m.op_id,
                    outcome="duplicate",
                    server_seq=self.known[m.op_id].server_seq,
                )
                if r is None
                else self.commit(r, d)
                for m, r, d in zip(members, rows, decisions, strict=True)
            ]

        results: list[OpResult] = []
        reviewed: list[tuple[Op, Op | None]] = []
        for m, r, d in zip(members, rows, decisions, strict=True):
            if r is None or d is None:
                results.append(
                    OpResult(
                        op_id=m.op_id,
                        outcome="duplicate",
                        server_seq=self.known[m.op_id].server_seq,
                    )
                )
            elif d.outcome == "review" or (
                d.outcome == "applied" and r.kind not in ("create", "link_add")
            ):
                self.store(r, "review")
                reviewed.append((r, d.head))
                results.append(OpResult(op_id=r.op_id, outcome="review", server_seq=r.server_seq))
            else:
                results.append(self.commit(r, d))
        item = self.review(reviewed)
        for res in results:
            if res.outcome == "review":
                res.review_item_id = item.id
        return results

    # -------------------------------------------------------------- decisions

    def decide(self, op: Op, overlay: Overlay) -> Decision:
        match op.kind:
            case "create":
                heads = [
                    f
                    for f in (op.payload or {})
                    if f not in PROTECTED and (op.entity_kind, f) not in SERVER_ASSIGNED
                ]
                return Decision("applied", heads=heads)
            case "set":
                return self.decide_set(op, overlay)
            case "delete" | "restore":
                return self.decide_delete(op, overlay)
            case "link_add":
                return Decision("applied")
            case "link_remove":
                return self.decide_unlink(op)
        raise AssertionError(op.kind)

    def decide_set(self, op: Op, overlay: Overlay) -> Decision:
        field = op.field or ""
        # Step 4: set vs an existing delete by someone else → review. A `Reconcile` set made
        # after the resolver saw the delete is the resolution of that very review (D91).
        deleted = self.head(op.entity_id, "deleted_at", overlay)
        if (
            deleted is not None
            and deleted.kind == "delete"
            and deleted.user_id != op.user_id
            and not (
                op.change_type == "Reconcile"
                and deleted.server_seq is not None
                and not self.unseen(deleted)
            )
        ):
            return Decision("review", head=deleted)
        head = self.head(op.entity_id, field, overlay)
        if head is None or head.op_id == op.base_op_id:
            return Decision("applied", heads=[field])
        if head.user_id == op.user_id:  # D37: one person's iPads never review against each other
            if _aware(op.client_ts) >= _aware(head.client_ts):
                return Decision("applied", heads=[field])
            return Decision("superseded", head=head)
        if (
            op.entity_kind in LAST_WRITE_WINS_ENTITIES
            or (op.entity_kind, field) in LAST_WRITE_WINS_FIELDS
        ):
            return Decision("applied", heads=[field])
        if value_of(head, field) == op.now:  # identical value → merge silently
            return Decision("applied", heads=[field])
        return Decision("review", head=head)

    def decide_delete(self, op: Op, overlay: Overlay) -> Decision:
        want_deleted = op.kind == "delete"
        head = self.head(op.entity_id, "deleted_at", overlay)
        if head is None or head.op_id == op.base_op_id:
            d = Decision("applied", heads=["deleted_at"])
        elif head.user_id == op.user_id:
            if _aware(op.client_ts) >= _aware(head.client_ts):
                d = Decision("applied", heads=["deleted_at"])
            else:
                d = Decision("superseded", head=head)
        elif (
            head.kind == "delete"
        ) == want_deleted:  # delete vs delete, restore vs restore → merge
            d = Decision("applied", heads=["deleted_at"])
        else:
            d = Decision("review", head=head)
        if want_deleted and d.outcome == "applied":
            # Step 4: delete vs a newer set by another user → review.
            newer = self.unseen_op_by_others(op, kinds=("set",))
            if newer is not None:
                return Decision("review", head=newer)
        return d

    def decide_unlink(self, op: Op) -> Decision:
        key = {k: (op.payload or {})[k] for k in LINK_KEY[op.entity_kind]}
        self.flush_ops()
        last = self.session.scalars(
            select(Op)
            .where(
                Op.entity_id == op.entity_id,
                Op.entity_kind == op.entity_kind,
                Op.kind.in_(("link_add", "link_remove")),
                Op.state == "applied",
                Op.payload.contains(key),
            )
            .order_by(Op.server_seq.desc())
        ).first()
        # Step 5: remove vs a newer add by another user → review.
        if (
            last is not None
            and last.kind == "link_add"
            and last.user_id != op.user_id
            and self.unseen(last)
        ):
            return Decision("review", head=last)
        return Decision("applied")

    def unseen(self, other: Op) -> bool:
        return self.since is None or (other.server_seq or 0) > self.since

    def unseen_op_by_others(self, op: Op, kinds: tuple[str, ...]) -> Op | None:
        self.flush_ops()
        q = select(Op).where(
            Op.entity_id == op.entity_id,
            Op.kind.in_(kinds),
            Op.state == "applied",
            Op.user_id != op.user_id,
        )
        if self.since is not None:
            q = q.where(Op.server_seq > self.since)
        return self.session.scalars(q.order_by(Op.server_seq.desc())).first()

    # ------------------------------------------------------------ heads & log

    def head(self, entity_id: uuid.UUID, field: str, overlay: Overlay) -> Op | None:
        if (entity_id, field) in overlay:
            return overlay[(entity_id, field)]
        key = (entity_id, field)
        if key in self.head_ids or entity_id in self.heads_loaded:
            op_id = self.head_ids.get(key)
            if op_id is None:
                return None
            return self.stored.get(op_id) or self.session.get(Op, op_id)
        self.flush_ops()
        head = self.session.scalars(
            select(Op)
            .join(FieldHead, FieldHead.op_id == Op.op_id)
            .where(FieldHead.entity_id == entity_id, FieldHead.field == field)
        ).first()
        self.head_ids[key] = None if head is None else head.op_id
        return head

    def head_value(self, entity_id: uuid.UUID, field: str) -> Any:
        head = self.head(entity_id, field, {})
        return None if head is None else value_of(head, field)

    def load_heads(self, entity_id: uuid.UUID) -> None:
        """Every head of one entity in one query; fields not returned are known absent."""
        if entity_id in self.heads_loaded:
            return
        for field, op_id in self.session.execute(
            select(FieldHead.field, FieldHead.op_id).where(FieldHead.entity_id == entity_id)
        ):
            self.head_ids[(entity_id, field)] = op_id
        self.heads_loaded.add(entity_id)

    def set_head(self, entity_id: uuid.UUID, field: str, op_id: uuid.UUID) -> None:
        self.set_heads([(entity_id, field, op_id)])

    def set_heads(self, heads: list[tuple[uuid.UUID, str, uuid.UUID]]) -> None:
        """Move several heads in one upsert statement. One statement per record, not one ORM
        row per field: an ORM flush of several new rows goes through `executemany`, which on a
        Windows ↔ Docker socket costs ~45 ms per call (delayed ACK), while one multi-row INSERT
        is a millisecond (T75 profile)."""
        if not heads:
            return
        if len(heads) == 1:
            e, f, o = heads[0]
            self.session.execute(UPSERT_HEAD, {"entity_id": e, "field": f, "op_id": o})
        else:
            stmt = pg_insert(FieldHead.__table__).values(
                [{"entity_id": e, "field": f, "op_id": o} for e, f, o in heads]
            )
            self.session.execute(
                stmt.on_conflict_do_update(
                    index_elements=["entity_id", "field"], set_={"op_id": stmt.excluded.op_id}
                )
            )
        for e, f, o in heads:
            self.head_ids[(e, f)] = o

    def build(self, op: OpIn) -> Op:
        return Op(
            op_id=op.op_id,
            project_id=op.project_id,
            user_id=op.user_id,
            install_id=op.install_id,
            client_ts=_aware(op.client_ts),
            entity_kind=op.entity_kind,
            entity_id=op.entity_id,
            kind=op.kind,
            field=op.field,
            was=op.was,
            now=op.now,
            payload=op.payload,
            base_op_id=op.base_op_id,
            group_id=op.group_id,
            change_type=op.change_type,
            reason=op.reason,
            ruling_id=op.ruling_id,
            proposal_id=op.proposal_id,
        )

    def store(self, row: Op, state: str) -> Op:
        self.seq += 1
        row.server_seq = self.seq
        row.server_ts = self.now
        row.state = state
        self.pending_ops.append({c: getattr(row, c) for c in OP_COLUMNS})
        self.stored[row.op_id] = row
        if len(self.pending_ops) >= OP_INSERT_BATCH or row.entity_kind == "review_item":
            self.flush_ops()  # settling a review item updates op rows (`_settle_review`)
        if state == "applied":
            # T10: tables follow the log inside the transaction. A create that inserted its row
            # proves the record is new: no head of it can exist, so none is looked up.
            fresh = materialise(self.session, row)
            if fresh and row.kind == "create":
                self.heads_loaded.add(row.entity_id)
            if row.entity_kind == "device":
                carried = None
                if row.kind == "create":
                    carried = (row.payload or {}).get("display_id")
                elif row.kind in ("set", "assign") and row.field == "display_id":
                    carried = row.now
                if isinstance(carried, str):
                    note_device_id(self.device_numbers, carried)
        return row

    def flush_ops(self) -> None:
        """Write the ops stored since the last flush to the `op` table in one INSERT."""
        if self.pending_ops:
            self.session.execute(insert(TABLES["op"]).values(self.pending_ops))
            self.pending_ops = []

    def server_op(
        self,
        cause: Op,
        *,
        entity_kind: str,
        entity_id: uuid.UUID,
        kind: str,
        reason: str,
        **values: Any,
    ) -> Op:
        row = Op(
            op_id=uuid7(),
            project_id=cause.project_id,
            user_id=cause.user_id,
            install_id=SERVER_INSTALL_ID,
            client_ts=self.now,
            entity_kind=entity_kind,
            entity_id=entity_id,
            kind=kind,
            base_op_id=cause.op_id,
            change_type=cause.change_type,
            reason=reason,
            **values,
        )
        self.store(row, "applied")
        self.server_ops.append(row)
        return row

    # --------------------------------------------------------------- numbering

    def assign(self, create: Op) -> None:
        """Step 2: a numbered record gets its display number on first receipt (PLAN §2.3)."""
        if create.entity_kind == "device":
            self.assign_device(create)
            return
        if create.entity_kind not in NUMBERED:
            return
        counter, field = NUMBERED[create.entity_kind]
        if self.head(create.entity_id, field, {}) is not None:
            return  # a replayed create never renumbers
        payload = create.payload or {}
        level_id = payload.get("level_id")
        carried = payload.get(field)
        if carried is not None:
            # A trusted create keeps its number (seed import, D25); the counter catches up so
            # the next field addition continues after it (PLAN §7.5 "counters set to max").
            self.set_head(create.entity_id, field, create.op_id)
            n = parse_number(create.entity_kind, carried)
            group = (
                numbering_group_for_level(self.session, uuid.UUID(str(level_id)), self.head_value)
                if level_id
                else None
            )
            if group is not None and n is not None and n > getattr(group, counter):
                setattr(group, counter, n)
                self.session.flush()
            return
        if create.entity_kind == "cable_end" and payload.get("side") == "B":
            # The far end of a single-row cable (`P`, `0-10V`, `120V`: PLAN §6 R2) is never a
            # Connections row, so it gets no `C-nn`.
            cable_id = payload.get("cable_id")
            if cable_id and self.head_value(uuid.UUID(str(cable_id)), "single_row"):
                return
        assigned = (
            next_number(self.session, create.entity_kind, uuid.UUID(str(level_id)), self.head_value)
            if level_id
            else None
        )
        if assigned is None:
            # A cable end without a level is a far end (placeholder, out-of-scope level): no row,
            # no number, by design. Anything else unnumbered is worth a warning (T13's lint).
            expected = create.entity_kind == "cable_end" and not level_id
            (log.info if expected else log.warning)(
                json.dumps(
                    {
                        "event": "assign_skipped",
                        "entity_kind": create.entity_kind,
                        "entity_id": str(create.entity_id),
                        "level_id": jsonable(level_id),
                    }
                )
            )
            return
        op = self.server_op(
            create,
            entity_kind=create.entity_kind,
            entity_id=create.entity_id,
            kind="assign",
            field=field,
            now=assigned.value,
            reason=f"Numbered from group {assigned.group.label}",
        )
        self.set_head(create.entity_id, field, op.op_id)

    def level_code_of(self, level_id: Any) -> str | None:
        if not level_id:
            return None
        lid = uuid.UUID(str(level_id))
        level = self.session.get(Level, lid)
        return level.level if level is not None else self.head_value(lid, "level")

    def assign_device(self, create: Op) -> None:
        """D93/D118: a device created without `display_id` gets its ID from the server as an
        `assign` op: `<level>-<nn>` (highest ever used on that level code + 1), or for stations and
        sensors (`level_tag`) `<level>-S<n>` / `<level>-D<n>` counted the same way per letter. A
        create carrying an ID (seed import, copied floor, an older app's typed tag) keeps it."""
        payload = create.payload or {}
        if self.head_value(create.entity_id, "display_id") is not None:
            return  # carries its ID, or a replayed create: never renumber
        prefix = ""
        if device_scheme(self.session, payload, self.head_value) == "level_tag":
            prefix = TAG_PREFIX.get(payload.get("category"), "")
        level_id = payload.get("level_id")
        if (self.level_code_of(level_id), prefix) not in self.device_numbers:
            self.flush_ops()  # the first assignment per level code scans the op log
        display_id = (
            next_device_id(
                self.session,
                self.project_id,
                uuid.UUID(str(level_id)),
                self.head_value,
                prefix,
                self.device_numbers,
            )
            if level_id
            else None
        )
        if display_id is None:
            log.warning(
                json.dumps(
                    {
                        "event": "assign_skipped",
                        "entity_kind": "device",
                        "entity_id": str(create.entity_id),
                        "level_id": jsonable(level_id),
                    }
                )
            )
            return
        op = self.server_op(
            create,
            entity_kind="device",
            entity_id=create.entity_id,
            kind="assign",
            field="display_id",
            now=display_id,
            reason="Device ID assigned by the server (D93)",
        )
        self.set_head(create.entity_id, "display_id", op.op_id)

    # ------------------------------------------------------------------ review

    def review(self, pairs: list[tuple[Op, Op | None]]) -> ReviewItem:
        """One `review_item(sync_conflict)`: side A = the heads (official), side B = the
        incoming ops. Several pairs = a field group reviewed as one."""
        incoming = [p[0] for p in pairs]
        heads = [p[1] for p in pairs if p[1] is not None]
        first = incoming[0]
        fields = [self.subject_field(o) for o in incoming]
        subject: dict[str, Any] = {
            "entity_kind": first.entity_kind,
            "entity_id": str(first.entity_id),
            "field": fields[0],
        }
        if len(incoming) > 1:
            subject["group_id"] = str(first.group_id)
            subject["fields"] = fields
        candidates = [self.candidate("A", h, self.subject_field(h)) for h in heads] + [
            self.candidate("B", o, f) for o, f in zip(incoming, fields, strict=True)
        ]
        level_id = self.head_value(first.entity_id, "level_id")
        if level_id:
            level_id = uuid.UUID(str(level_id))
            subject["level_id"] = str(level_id)
            # The row's FK needs a known level; the subject keeps it regardless.
            if self.session.get(Level, level_id) is None:
                level_id = None
        item_id = uuid7()
        payload = {
            "id": item_id,
            "project_id": self.project_id,
            "level_id": level_id or None,
            "kind": "sync_conflict",
            "subject": subject,
            "op_a_id": heads[0].op_id if heads else None,
            "op_b_id": first.op_id,
            "candidates": candidates,
            "ruling": any(o.ruling_id is not None for o in incoming + heads),  # step 6
            "state": "open",
        }
        # The row itself is written by materialising this create op (T10): the log stays the
        # only write path on the server too, and a replay reproduces the item exactly.
        op = self.server_op(
            first,
            entity_kind="review_item",
            entity_id=item_id,
            kind="create",
            payload=jsonable(payload),
            reason=f"Sync conflict on {first.entity_kind}.{', '.join(fields)}",
        )
        for f in payload:
            if f != "id":
                self.set_head(item_id, f, op.op_id)
        item = self.session.get(ReviewItem, item_id)
        assert item is not None
        return item

    @staticmethod
    def subject_field(op: Op) -> str:
        if op.kind in ("delete", "restore"):
            return "deleted_at"
        if op.kind in ("link_add", "link_remove"):
            return f"link:{json.dumps(jsonable(op.payload), sort_keys=True)}"
        return op.field or ""

    @staticmethod
    def candidate(side: str, op: Op, field: str) -> dict[str, Any]:
        return jsonable(
            {
                "side": side,
                "op_id": op.op_id,
                "user_id": op.user_id,
                "install_id": op.install_id,
                "client_ts": op.client_ts,
                "entity_kind": op.entity_kind,
                "entity_id": op.entity_id,
                "field": field,
                "kind": op.kind,
                "value": value_of(op, field)
                if op.kind not in ("link_add", "link_remove")
                else op.payload,
            }
        )


def apply_push(session: Session, body: PushIn) -> PushOut:
    """Run the whole push inside the caller's transaction; the caller commits or rolls back."""
    return Push(session, body).run(body.ops)
