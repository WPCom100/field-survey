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
    group: NumberingGroup
    field: str
    value: int | str


def numbering_group_for_level(
    session: Session, level_id: uuid.UUID, head_value
) -> NumberingGroup | None:
    """The level's group: from the `level` row when it exists, else from the op log head
    (levels created by ops are not materialised until T10)."""
    level = session.get(Level, level_id)
    group_id = (
        level.numbering_group_id
        if level is not None
        else head_value(level_id, "numbering_group_id")
    )
    if group_id is None:
        return None
    if isinstance(group_id, str):
        group_id = uuid.UUID(group_id)
    return session.scalars(
        select(NumberingGroup).where(NumberingGroup.id == group_id).with_for_update()
    ).first()


def next_number(
    session: Session, entity_kind: str, level_id: uuid.UUID, head_value
) -> Assigned | None:
    """Move the group's counter for this entity kind and return the new value, or None when
    the level or its group is unknown (the record stays `NEW` until T13's lint catches it)."""
    counter, field = NUMBERED[entity_kind]
    group = numbering_group_for_level(session, level_id, head_value)
    if group is None:
        return None
    n = getattr(group, counter) + 1
    setattr(group, counter, n)
    session.flush()
    return Assigned(group=group, field=field, value=display_value(entity_kind, n))


# ------------------------------------------------------------------ device IDs (D93)

# Categories whose default scheme is `level_tag`, with their ID letter (stations S, sensors D).
TAG_PREFIX = {"Station": "S", "Sensor": "D"}
TAG_CATEGORIES = frozenset(TAG_PREFIX)


def device_scheme(session: Session, payload: dict, head_value) -> str:
    """`level_number` or `level_tag` for a device create: the library type's `id_scheme`
    wins (from its row, else from the op log), else Station/Sensor → `level_tag`, everything
    else (category unknown included) → `level_number`. Mirrors `defaultIdScheme` in core."""
    type_id = payload.get("library_type_id")
    if type_id:
        type_id = uuid.UUID(str(type_id))
        lt = session.get(LibraryType, type_id)
        scheme = lt.id_scheme if lt is not None else head_value(type_id, "id_scheme")
        if scheme:
            return scheme
    return "level_tag" if payload.get("category") in TAG_CATEGORIES else "level_number"


def level_code(session: Session, level_id: uuid.UUID, head_value) -> str | None:
    level = session.get(Level, level_id)
    return level.level if level is not None else head_value(level_id, "level")


def used_device_numbers(
    session: Session, project_id: uuid.UUID, code: str, prefix: str = ""
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


DeviceNumberCache = dict[tuple[str, str], int]


def next_device_id(
    session: Session,
    project_id: uuid.UUID,
    level_id: uuid.UUID,
    head_value,
    prefix: str = "",
    cache: DeviceNumberCache | None = None,
) -> str | None:
    """`<code>-<nn>` = highest number ever used on that level code + 1, two digits (then as
    many as needed); with a prefix (D118: stations `S`, sensors `D`) `<code>-S<n>`, no padding,
    counted per prefix. Per level code, not per numbering group: 06 and 06M count separately.
    Called inside the push, which holds the project lock, so two pushes never race. None when
    the level is unknown.

    `cache` (T75, D146) holds the highest number per `(code, prefix)` for the length of one
    push: the log is scanned once per level code, then each assignment counts on from the cache,
    so 500 device creates in one push cost one scan each per level, not 500."""
    code = level_code(session, level_id, head_value)
    if not code:
        return None
    key = (code, prefix)
    if cache is None or key not in cache:
        n = max(used_device_numbers(session, project_id, code, prefix), default=0)
        if cache is not None:
            cache[key] = n
    else:
        n = cache[key]
    n += 1
    if cache is not None:
        cache[key] = n
    return f"{code}-{prefix}{n}" if prefix else f"{code}-{n:02d}"


def note_device_id(cache: DeviceNumberCache, display_id: str) -> None:
    """A carried ID applied mid-push (seed import, copied floor) raises the cache for its level
    code and prefix so a later assignment in the same push counts past it."""
    m = re.fullmatch(r"(.+)-([SD]?)(\d+)", display_id)
    if m is None:
        return
    key = (m[1], m[2])
    cache[key] = max(cache.get(key, 0), int(m[3]))
