"""Device roles (T112, D196 (2), D201) — the server mirror of `packages/core/src/roles.ts`.

What a device **is** in the installation, read by the ID scheme (`numbering.py`), the Punch
List Device text (`export_xlsx.py`) and the floor PDF's pin shapes (`floor_pdf.py`) instead of
the master's category strings (`NSPS`, `Relay panel`, …, D1), which the D196 eleven replaced.

- `library_type.role` carries it; the DaVinci import sets it on a type it creates (D199 (3)).
- `role_of(type, device)`: the type's role, else the role its category implies, else the
  device's own category's, through `role_of_category`.
- `role_of_category`: the master's eight imply one role each; of the eleven, only
  `Emergency Equipment` (ebdk), `Equipment Panels` / `Equipment Rack` (equipment_rack),
  `Touchscreen`, `Station` and `Sensor`. `Power Distribution` and `Equipment` name several
  roles, so a device of those categories with no type is `other`: the type carries the role.
- `DeviceRoles` resolves a project's devices against its live types (its own and the app
  library's) once: by `library_type_id`, else by Device text = model or alias, spaces and case
  ignored (D183 (4)).
"""

from __future__ import annotations

import uuid
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Device, LibraryType, RuleParam

ROLES = (
    "relay_panel",
    "foundry_panel",
    "ebdk",
    "equipment_rack",
    "nsps",
    "touchscreen",
    "station",
    "sensor",
    "other",
)

# The role as the rules name it in messages (the master's own words, D1).
ROLE_LABEL = {
    "relay_panel": "Relay panel",
    "foundry_panel": "Foundry panel",
    "ebdk": "EBDK",
    "equipment_rack": "Equipment rack",
    "nsps": "NSPS",
    "touchscreen": "Touchscreen",
    "station": "Station",
    "sensor": "Sensor",
    "other": "Other",
}

# Pin shapes (D64, T104, D214): one per role by default; the app library's `rule_param`
# (`pin`, `shape`, project null) maps a role to another shape, for every project at once.
PIN_SHAPES = (
    "square",
    "rounded_square",
    "wide_rectangle",
    "hexagon",
    "pentagon",
    "triangle",
    "circle",
    "diamond",
    "octagon",
)
DEFAULT_PIN_SHAPE = dict(zip(ROLES, PIN_SHAPES, strict=True))
PIN_SHAPE_RULE, PIN_SHAPE_KEY = "pin", "shape"


def pin_shapes(session: Session) -> dict[str, str]:
    """Role -> shape: the defaults with the app library's accepted overrides over them."""
    shapes = dict(DEFAULT_PIN_SHAPE)
    row = session.scalars(
        select(RuleParam).where(
            RuleParam.project_id.is_(None),
            RuleParam.rule_id == PIN_SHAPE_RULE,
            RuleParam.key == PIN_SHAPE_KEY,
            RuleParam.state == "accepted",
            RuleParam.deleted_at.is_(None),
        )
    ).first()
    if row is not None and isinstance(row.value, dict):
        for role, shape in row.value.items():
            if role in shapes and shape in PIN_SHAPES:
                shapes[role] = shape
    return shapes


# `vocab(category)` as seeded (D196; CLAUDE.md §3).
DEVICE_CATEGORIES = (
    "Power Distribution",
    "Emergency Equipment",
    "Equipment",
    "Equipment Panels",
    "Equipment Rack",
    "Power Supplies",
    "Wall Plates",
    "Lighting Console",
    "Touchscreen",
    "Station",
    "Sensor",
)

# The master's categories the eleven renamed, old → new (the rename ruling's table).
MASTER_CATEGORY_RENAME = {
    "Relay panel": "Power Distribution",
    "Foundry panel": "Power Distribution",
    "EBDK": "Emergency Equipment",
    "NSPS": "Equipment",
    "Equipment rack": "Equipment Panels",
}

# The D196 category an extraction writes for a role it read (T115, D201 (3)): the master's
# spelling of the role, renamed — `Relay panel` → `Power Distribution`, `Equipment rack` →
# `Equipment Panels` (the rename ruling's table). `other` names no category.
ROLE_CATEGORY = {
    r: MASTER_CATEGORY_RENAME.get(ROLE_LABEL[r], ROLE_LABEL[r]) for r in ROLES if r != "other"
}

_ROLE_OF_CATEGORY = {
    # the master's eight (D1): one role each
    "Relay panel": "relay_panel",
    "Foundry panel": "foundry_panel",
    "EBDK": "ebdk",
    "Equipment rack": "equipment_rack",
    "NSPS": "nsps",
    "Touchscreen": "touchscreen",
    "Station": "station",
    "Sensor": "sensor",
    # of the eleven (D196), those that name one role
    "Emergency Equipment": "ebdk",
    "Equipment Panels": "equipment_rack",
    "Equipment Rack": "equipment_rack",
}


def is_role(v: object) -> bool:
    return isinstance(v, str) and v in ROLES


def canonical_category(category: str | None) -> str | None:
    """The D196 spelling of `category`: the master's renamed five map to their new value."""
    if not category:
        return None
    return MASTER_CATEGORY_RENAME.get(category, category)


def role_of_category(category: str | None) -> str:
    """The role a category implies for a device with no type; `other` when none or several."""
    return _ROLE_OF_CATEGORY.get(category or "", "other")


def role_of(type_: LibraryType | None, category: str | None) -> str:
    """The device's role: its type's `role`, else the type's category's, else `category`'s."""
    if type_ is not None and is_role(type_.role):
        return type_.role  # type: ignore[return-value]
    return role_of_category(type_.category if type_ is not None and type_.category else category)


def model_key(s: str) -> str:
    return "".join(s.split()).upper()


class DeviceRoles:
    """The roles of a project's devices, resolved against its live types once (D183 (4))."""

    def __init__(self, types: Iterable[LibraryType]):
        self.by_id: dict[uuid.UUID, LibraryType] = {}
        self.by_name: dict[str, LibraryType] = {}
        rows = sorted(types, key=lambda t: (t.project_id is None, str(t.id)))
        for t in rows:
            self.by_id[t.id] = t
            if t.state == "rejected":
                continue
            for name in (t.model, *(t.aliases or [])):
                if isinstance(name, str) and name:
                    # the project's type before the app library's (sorted above)
                    self.by_name.setdefault(model_key(name), t)

    @classmethod
    def load(cls, session: Session, project_id: uuid.UUID) -> "DeviceRoles":
        rows = session.scalars(
            select(LibraryType).where(
                (LibraryType.project_id == project_id) | (LibraryType.project_id.is_(None)),
                LibraryType.deleted_at.is_(None),
            )
        ).all()
        return cls(rows)

    def type_of(self, dev: Device) -> LibraryType | None:
        if dev.library_type_id is not None:
            return self.by_id.get(dev.library_type_id)
        if dev.device:
            return self.by_name.get(model_key(dev.device))
        return None

    def role_of(self, dev: Device | None) -> str:
        if dev is None:
            return "other"
        return role_of(self.type_of(dev), dev.category)
