"""Display numbers from numbering-group counters (PLAN §2.3, D25, D33).

Punch `#`, part `#`, photo number and `C-nn` are assigned by the server on first receipt of
the `create` op, monotonic per numbering group, never reused. A level points at its group;
06 and 06M share one (D33). Counters hold the last number handed out and only move here,
inside the push transaction (the project row is locked for the whole push, so two pushes
never race on a counter).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Level, NumberingGroup

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
