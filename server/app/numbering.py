"""Display numbers from numbering-group counters (PLAN §2.3, D25, D33), and device IDs of the
`level_number` scheme (D93).

Punch `#`, part `#`, photo number and `C-nn` are assigned by the server on first receipt of
the `create` op, monotonic per numbering group, never reused. A level points at its group;
06 and 06M share one (D33). Counters hold the last number handed out and only move here,
inside the push transaction (the project row is locked for the whole push, so two pushes
never race on a counter).
"""

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Device, Level, LibraryType, NumberingGroup, Op
from app.roles import is_role, role_of_category

# entity_kind → (counter attribute, display field, formatter)
NUMBERED: dict[str, tuple[str, str]] = {
    "punch_item": ("counter_punch", "number"),
    "missing_part": ("counter_part", "number"),
    "photo": ("counter_photo", "number"),
    "cable_end": ("counter_cable", "display_id"),
}


def display_value(entity_kind: str, n: int) -> int | str:
    """Integers for punch/part/photo; `C-07` for cable ends (two digits, then as many as needed)."""
    return f"C-{n:02d}" if entity_kind == "cable_end" else n


def parse_number(entity_kind: str, value) -> int | None:
    """The inverse of `display_value` for a number a trusted create carries; None if malformed."""
    if entity_kind == "cable_end":
        m = re.fullmatch(r"C-(\d+)", str(value))
        return int(m.group(1)) if m else None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class Assigned:
    label: str  # the numbering group's label, for the assign op's reason
    field: str
    value: int | str


# Roles whose default scheme is `level_tag`, with their ID letter (stations S, sensors D) — T112.
TAG_PREFIX = {"station": "S", "sensor": "D"}

DeviceNumberCache = dict[tuple[str, str], int]


class Numbering:
    """The numbering state of one push (T76): level, library-type and group rows read once,
    group counters moved in memory and written back by `write` at the end of the push.

    The push holds the project lock, so nothing else moves a counter meanwhile, and each group
    row is locked (`FOR UPDATE`) the first time this push numbers from it. Rows are read after
    `before_read` (the push writes what it has pending), so a level created earlier in the same
    push is seen; a row not in its table falls back to the op log (`head_value`). `forget` drops
    a cached row when an applied op changes it."""

    def __init__(self, session: Session, project_id: uuid.UUID | None, head_value, before_read):
        self.session = session
        self.project_id = project_id
        self.head_value = head_value
        self.before_read = before_read
        self.rows: dict[uuid.UUID, dict | None] = {}
        self.groups: dict[uuid.UUID, NumberingGroup] = {}
        self.counters: dict[tuple[uuid.UUID, str], int] = {}
        # Highest device number per (level code, prefix) seen so far in this push (T75, D146).
        self.device_numbers: DeviceNumberCache = {}

    # ---------------------------------------------------------------- reads

    def value(self, model, entity_id: uuid.UUID, field: str):
        """`field` of the `model` row, else of the op log head (a record not materialised)."""
        if entity_id not in self.rows:
            self.before_read()
            obj = self.session.get(model, entity_id)
            self.rows[entity_id] = (
                None if obj is None else {c.key: getattr(obj, c.key) for c in obj.__mapper__.c}
            )
        row = self.rows[entity_id]
        return row[field] if row is not None else self.head_value(entity_id, field)

    def forget(self, entity_id: uuid.UUID) -> None:
        self.rows.pop(entity_id, None)

    def level_code(self, level_id: uuid.UUID) -> str | None:
        return self.value(Level, level_id, "level")

    def group(self, level_id: uuid.UUID) -> NumberingGroup | None:
        """The level's group (06 and 06M share one, D33), locked on first use in this push."""
        group_id = self.value(Level, level_id, "numbering_group_id")
        if group_id is None:
            return None
        if isinstance(group_id, str):
            group_id = uuid.UUID(group_id)
        if group_id not in self.groups:
            self.before_read()
            group = self.session.scalars(
                select(NumberingGroup).where(NumberingGroup.id == group_id).with_for_update()
            ).first()
            if group is None:
                return None
            self.groups[group_id] = group  # held: `write` sets the counters on it
        return self.groups[group_id]

    # ------------------------------------------------------------- counters

    def _counter(self, group: NumberingGroup, counter: str) -> int:
        return self.counters.get((group.id, counter), getattr(group, counter))

    def next_number(self, entity_kind: str, level_id: uuid.UUID) -> Assigned | None:
        """Move the group's counter for this entity kind and return the new value, or None when
        the level or its group is unknown (the record stays `NEW` until T13's lint catches it)."""
        counter, field = NUMBERED[entity_kind]
        group = self.group(level_id)
        if group is None:
            return None
        n = self._counter(group, counter) + 1
        self.counters[(group.id, counter)] = n
        return Assigned(label=group.label, field=field, value=display_value(entity_kind, n))

    def catch_up(self, entity_kind: str, level_id: uuid.UUID, n: int) -> None:
        """A trusted create keeps its number (seed import, D25); the counter catches up so the
        next field addition continues after it (PLAN §7.5 "counters set to max")."""
        counter, _ = NUMBERED[entity_kind]
        group = self.group(level_id)
        if group is not None and n > self._counter(group, counter):
            self.counters[(group.id, counter)] = n

    def write(self) -> None:
        """The moved counters onto their group rows: one UPDATE per group per push."""
        for (group_id, counter), n in self.counters.items():
            setattr(self.groups[group_id], counter, n)
        if self.counters:
            self.session.flush()

    # ----------------------------------------------------------- device IDs (D93)

    def device_role(self, payload: dict) -> str:
        """The created device's role (T112, D201): its library type's `role` (from its row, else
        from the op log), else the type's category's, else its own category's. Mirrors `roleOf`
        in core."""
        type_id = payload.get("library_type_id")
        type_category = None
        if type_id:
            type_id = uuid.UUID(str(type_id))
            role = self.value(LibraryType, type_id, "role")
            if is_role(role):
                return role
            type_category = self.value(LibraryType, type_id, "category")
        return role_of_category(type_category or payload.get("category"))

    def device_scheme(self, payload: dict) -> str:
        """`level_number` or `level_tag` for a device create: the library type's `id_scheme`
        wins (from its row, else from the op log), else the device's role: station / sensor →
        `level_tag`, everything else (category unknown included) → `level_number`. Mirrors
        `deviceIdFor` in core."""
        type_id = payload.get("library_type_id")
        if type_id:
            scheme = self.value(LibraryType, uuid.UUID(str(type_id)), "id_scheme")
            if scheme:
                return scheme
        return "level_tag" if self.device_role(payload) in TAG_PREFIX else "level_number"

    def next_device_id(self, level_id: uuid.UUID, prefix: str = "") -> str | None:
        """`<code>-<nn>` = highest number ever used on that level code + 1, two digits (then as
        many as needed); with a prefix (D118: stations `S`, sensors `D`) `<code>-S<n>`, no
        padding, counted per prefix. Per level code, not per numbering group: 06 and 06M count
        separately. None when the level is unknown.

        The log is scanned once per `(code, prefix)` per push (T75, D146); each assignment then
        counts on from `device_numbers`, so 500 device creates cost one scan per level."""
        code = self.level_code(level_id)
        if not code:
            return None
        key = (code, prefix)
        if key not in self.device_numbers:
            self.before_read()
            self.device_numbers[key] = max(
                used_device_numbers(self.session, self.project_id, code, prefix), default=0
            )
        n = self.device_numbers[key] + 1
        self.device_numbers[key] = n
        return f"{code}-{prefix}{n}" if prefix else f"{code}-{n:02d}"

    def note_device_id(self, display_id: str) -> None:
        """A carried ID applied mid-push (seed import, copied floor) raises the count for its
        level code and prefix so a later assignment in the same push counts past it."""
        m = re.fullmatch(r"(.+)-([SD]?)(\d+)", display_id)
        if m is None:
            return
        key = (m[1], m[2])
        if key in self.device_numbers:
            self.device_numbers[key] = max(self.device_numbers[key], int(m[3]))
        # Not counted yet: the first assignment on that code scans the log, this op included
        # (T76: seeding the count here skipped the scan and missed earlier pushes' numbers).


def used_device_numbers(
    session: Session, project_id: uuid.UUID | None, code: str, prefix: str = ""
) -> set[int]:
    """Every `<code>-<prefix><n>` ever used in the project (prefix `S`/`D` for stations and
    sensors, empty for the numbered devices): any device `display_id` in the op log
    (creates, sets, assigns — deleted, renamed, reviewed or superseded included) plus the
    device table (rows that never came through an op). Once used, a number is retired."""
    pattern = re.compile(rf"^{re.escape(code)}-{re.escape(prefix)}(\d+)$")
    values: list = list(
        session.scalars(
            select(Op.payload["display_id"].astext).where(
                Op.project_id == project_id, Op.entity_kind == "device", Op.kind == "create"
            )
        )
    )
    values += session.scalars(
        select(Op.now).where(
            Op.project_id == project_id,
            Op.entity_kind == "device",
            Op.kind.in_(("set", "assign")),
            Op.field == "display_id",
        )
    )
    values += session.scalars(
        select(Device.display_id)
        .join(Level, Level.id == Device.level_id)
        .where(Level.project_id == project_id)
    )
    return {int(m[1]) for v in values if isinstance(v, str) and (m := pattern.match(v))}
