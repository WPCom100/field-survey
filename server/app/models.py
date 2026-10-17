"""Server tables for every entity in PLAN §2.2 (D76 names the columns).

Column names are the snake_case of the master header (`Room / Location` → `room_location`)
except `ID` → `display_id`, `#`/`Photo` number → `number`, `From`/`To` → `from_text`/`to_text`;
references are `<entity>_id`. Op `field` names are these attribute names.

Business uniqueness (device ID, Neuron ID, one ink layer per sheet+user…) is a lint, not a
constraint: ops created offline must always apply. Blob references are plain SHA-256 text
because a record syncs before its bytes (PLAN §3.4).
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    ARRAY,
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app import vocab
from app.db import Base
from app.ids import uuid7


def fk(target: str, use_alter: bool = False) -> ForeignKey:
    # Deferred so one push may create records in any order inside its transaction.
    return ForeignKey(target, deferrable=True, initially="DEFERRED", use_alter=use_alter)


def one_of(column: str, values: tuple[str, ...]) -> CheckConstraint:
    quoted = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    # `info` lets the apply loop validate op values against the same list (T09).
    return CheckConstraint(
        f"{column} IN ({quoted})", name=column, info={"column": column, "values": values}
    )


class Id:
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)


class Synced:
    """A record materialised from ops: versioned and soft-deleted (PLAN §2.1)."""

    version: Mapped[int] = mapped_column(default=0, server_default="0")
    head_seq: Mapped[int | None] = mapped_column(BigInteger)
    deleted_at: Mapped[datetime | None]
    deleted_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    delete_reason: Mapped[str | None]


class Removable:
    """A link row: `link_remove` soft-deletes it."""

    deleted_at: Mapped[datetime | None]
    deleted_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))


class User(Id, Base):
    # `user` is reserved in Postgres.
    __tablename__ = "app_user"

    entra_oid: Mapped[str | None] = mapped_column(unique=True)
    name: Mapped[str]
    email: Mapped[str | None]
    last_seen: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Project(Id, Synced, Base):
    __tablename__ = "project"

    name: Mapped[str]
    site: Mapped[str | None]
    parties: Mapped[dict[str, Any] | None]
    settings: Mapped[dict[str, Any] | None]
    copied_from_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Install(Id, Synced, Base):
    """One iPad (`id` = install id) and the label typed on its Sync screen (T86, D155)."""

    __tablename__ = "install"

    label: Mapped[str | None]
    user_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    updated_at: Mapped[datetime | None]


class NumberingGroup(Id, Base):
    """Counters hold the last number handed out; only the server moves them."""

    __tablename__ = "numbering_group"

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    label: Mapped[str]
    counter_punch: Mapped[int] = mapped_column(default=0, server_default="0")
    counter_part: Mapped[int] = mapped_column(default=0, server_default="0")
    counter_photo: Mapped[int] = mapped_column(default=0, server_default="0")
    counter_cable: Mapped[int] = mapped_column(default=0, server_default="0")


class Level(Id, Synced, Base):
    __tablename__ = "level"
    __table_args__ = (one_of("state", vocab.LEVEL_STATE),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    level: Mapped[str]
    floor_order: Mapped[int | None]
    numbering_group_id: Mapped[uuid.UUID] = mapped_column(fk("numbering_group.id"))
    in_scope: Mapped[bool] = mapped_column(default=True, server_default="true")
    split_of_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    surveyed: Mapped[date | None]
    updated: Mapped[date | None]
    state: Mapped[str] = mapped_column(default="setup", server_default="setup")
    baseline_locked_at: Mapped[datetime | None]
    baseline_locked_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    display_sheet_id: Mapped[uuid.UUID | None] = mapped_column(fk("sheet.id", use_alter=True))


class Sheet(Id, Synced, Base):
    __tablename__ = "sheet"
    __table_args__ = (one_of("kind", vocab.SHEET_KIND),)

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), index=True)
    kind: Mapped[str]
    blob: Mapped[str | None] = mapped_column(String(64))
    page: Mapped[int | None]
    title: Mapped[str | None]
    width_pt: Mapped[float | None]
    height_pt: Mapped[float | None]
    grid_sets: Mapped[list[Any] | None]
    # The text pass (T45, D147): rooms, tags, loose bubbles, source-sheet boundaries.
    features: Mapped[dict[str, Any] | None]
    revision: Mapped[str | None]


class Assignment(Removable, Base):
    __tablename__ = "assignment"

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(fk("app_user.id"), primary_key=True)
    assigned_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    assigned_at: Mapped[datetime | None]


class Device(Id, Synced, Base):
    __tablename__ = "device"
    __table_args__ = (
        one_of("status", vocab.DEVICE_STATUS),
        one_of("neuron_method", vocab.NEURON_METHOD),
        one_of("origin", vocab.ORIGIN),
    )

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), index=True)
    display_id: Mapped[str | None]
    category: Mapped[str | None]
    device: Mapped[str | None]
    type: Mapped[str | None]
    room_location: Mapped[str | None]
    drawing_position: Mapped[str | None]
    status: Mapped[str | None]
    notes: Mapped[str | None]
    pin: Mapped[dict[str, Any] | None]
    neuron_id: Mapped[str | None] = mapped_column(String(12), index=True)
    neuron_evidence_photo_id: Mapped[uuid.UUID | None] = mapped_column(
        fk("photo.id", use_alter=True)
    )
    neuron_method: Mapped[str | None]
    origin: Mapped[str | None]
    found_on_site: Mapped[bool | None]
    baseline_ref_id: Mapped[uuid.UUID | None] = mapped_column(fk("draft_device.id"))
    panel_name: Mapped[str | None]
    library_type_id: Mapped[uuid.UUID | None] = mapped_column(fk("library_type.id"))


class Accessory(Id, Synced, Base):
    __tablename__ = "accessory"

    device_id: Mapped[uuid.UUID] = mapped_column(fk("device.id"), index=True)
    model: Mapped[str | None]
    expected_qty: Mapped[int | None]
    found_qty: Mapped[int | None]
    notes: Mapped[str | None]
    source_ref: Mapped[dict[str, Any] | None]


class Cable(Id, Synced, Base):
    __tablename__ = "cable"
    __table_args__ = (one_of("origin", vocab.CABLE_ORIGIN),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    cable: Mapped[str | None]
    qty: Mapped[int | None]
    origin: Mapped[str | None]
    single_row: Mapped[bool] = mapped_column(default=False, server_default="false")
    riser_ref: Mapped[dict[str, Any] | None]
    riser_to_label: Mapped[str | None]
    vertical: Mapped[str | None]
    end_a_id: Mapped[uuid.UUID | None] = mapped_column(fk("cable_end.id", use_alter=True))
    end_b_id: Mapped[uuid.UUID | None] = mapped_column(fk("cable_end.id", use_alter=True))
    endpoint_confirmed: Mapped[bool] = mapped_column(default=False, server_default="false")
    # Takes termination kits over the code's R4b.kit rule parameter; null = the code's (D213).
    term_kit: Mapped[bool | None]


class CableEnd(Id, Synced, Base):
    __tablename__ = "cable_end"
    __table_args__ = (
        UniqueConstraint("cable_id", "side"),
        one_of("side", vocab.CABLE_SIDE),
        one_of("endpoint_kind", vocab.ENDPOINT_KIND),
        one_of("status", vocab.CONNECTION_STATUS),
        one_of("status_source", vocab.STATUS_SOURCE),
    )

    cable_id: Mapped[uuid.UUID] = mapped_column(fk("cable.id"))
    side: Mapped[str] = mapped_column(String(1))
    endpoint_kind: Mapped[str | None]
    device_id: Mapped[uuid.UUID | None] = mapped_column(fk("device.id"), index=True)
    placeholder_id: Mapped[uuid.UUID | None] = mapped_column(fk("placeholder.id"))
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"), index=True)
    display_id: Mapped[str | None]
    from_text: Mapped[str | None]
    to_text: Mapped[str | None]
    status: Mapped[str | None]
    note: Mapped[str | None]
    surveyed_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    surveyed_at: Mapped[datetime | None]
    status_source: Mapped[str | None]


class Placeholder(Id, Synced, Base):
    __tablename__ = "placeholder"
    __table_args__ = (one_of("kind", vocab.PLACEHOLDER_KIND),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    label: Mapped[str]
    kind: Mapped[str]
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))


class PunchItem(Id, Synced, Base):
    __tablename__ = "punch_item"
    __table_args__ = (
        one_of("type", vocab.PUNCH_TYPE),
        one_of("owner", vocab.OWNER),
        one_of("tracking_status", vocab.TRACKING_STATUS),
    )

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), index=True)
    number: Mapped[int | None]
    device_id: Mapped[uuid.UUID | None] = mapped_column(fk("device.id"), index=True)
    cable_end_id: Mapped[uuid.UUID | None] = mapped_column(fk("cable_end.id"))
    # The master's **Device** text, kept verbatim by the import and exported as stored (D136);
    # generated from the linked device when empty.
    device_text: Mapped[str | None]
    item: Mapped[str | None]
    type: Mapped[str | None]
    owner: Mapped[str | None]
    tracking_status: Mapped[str | None]
    date_closed: Mapped[date | None]
    notes: Mapped[str | None]
    rule_id: Mapped[str | None]
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(fk("proposal.id"))
    sort_last: Mapped[bool] = mapped_column(default=False, server_default="false")


class MissingPart(Id, Synced, Base):
    __tablename__ = "missing_part"
    __table_args__ = (
        one_of("owner", vocab.OWNER),
        one_of("part_status", vocab.PART_STATUS),
    )

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), index=True)
    number: Mapped[int | None]
    device_id: Mapped[uuid.UUID | None] = mapped_column(fk("device.id"), index=True)
    device_location: Mapped[str | None]
    part: Mapped[str | None]
    part_no: Mapped[str | None]
    qty: Mapped[int | None]
    owner: Mapped[str | None]
    part_status: Mapped[str | None]
    notes: Mapped[str | None]
    rule_id: Mapped[str | None]
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(fk("proposal.id"))


class PartSource(Removable, Base):
    """Target is polymorphic (`target_kind`), so `target_id` has no foreign key."""

    __tablename__ = "part_source"
    __table_args__ = (one_of("target_kind", vocab.PART_SOURCE_TARGET),)

    missing_part_id: Mapped[uuid.UUID] = mapped_column(fk("missing_part.id"), primary_key=True)
    target_kind: Mapped[str] = mapped_column(primary_key=True)
    target_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)


class Photo(Id, Synced, Base):
    __tablename__ = "photo"

    level_id: Mapped[uuid.UUID] = mapped_column(fk("level.id"), index=True)
    number: Mapped[int | None]
    location: Mapped[str | None]
    subject: Mapped[str | None]
    what_it_shows: Mapped[str | None]
    device_id: Mapped[uuid.UUID | None] = mapped_column(fk("device.id"), index=True)
    punch_item_id: Mapped[uuid.UUID | None] = mapped_column(fk("punch_item.id"))
    cable_end_id: Mapped[uuid.UUID | None] = mapped_column(fk("cable_end.id"))
    image_blob: Mapped[str | None] = mapped_column(String(64))
    thumb_blob: Mapped[str | None] = mapped_column(String(64))
    markup_blob: Mapped[str | None] = mapped_column(String(64))
    taken_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    taken_at: Mapped[datetime | None]
    seed_thumbnail_only: Mapped[bool] = mapped_column(default=False, server_default="false")


class PhotoLink(Removable, Base):
    """D128 (T65): a photo linked to further devices, connection ends and punch items.
    Target is polymorphic (`target_kind`), so `target_id` has no foreign key."""

    __tablename__ = "photo_link"
    __table_args__ = (
        one_of("target_kind", vocab.PHOTO_LINK_TARGET),
        Index(None, "target_kind", "target_id"),
    )

    photo_id: Mapped[uuid.UUID] = mapped_column(fk("photo.id"), primary_key=True)
    target_kind: Mapped[str] = mapped_column(primary_key=True)
    target_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)


class InkLayer(Id, Synced, Base):
    __tablename__ = "ink_layer"
    __table_args__ = (Index(None, "sheet_id", "user_id"),)

    sheet_id: Mapped[uuid.UUID] = mapped_column(fk("sheet.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(fk("app_user.id"))
    drawing_blob: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime | None]


class Blob(Base):
    __tablename__ = "blob"
    __table_args__ = (one_of("upload_state", vocab.UPLOAD_STATE),)

    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    size: Mapped[int] = mapped_column(BigInteger)
    mime: Mapped[str]
    width: Mapped[int | None]
    height: Mapped[int | None]
    upload_state: Mapped[str] = mapped_column(default="local", server_default="local")
    chunks_received: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), default=list, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Op(Base):
    """Append-only op log (PLAN §3.1). References into materialised tables are plain ids so
    the log stands alone and can be replayed."""

    __tablename__ = "op"
    __table_args__ = (
        UniqueConstraint("project_id", "server_seq"),
        Index(None, "entity_id", "field"),
        # Device-ID assignment scans a project's device creates/sets/assigns (T75, D146).
        Index(None, "project_id", "entity_kind", "kind"),
        # The app-library log (project_id null, T61/D184) has its own sequence.
        Index(
            "uq_op_library_server_seq",
            "server_seq",
            unique=True,
            postgresql_where=text("project_id IS NULL"),
        ),
        one_of("kind", vocab.OP_KIND),
        one_of("change_type", vocab.CHANGE_TYPE),
        one_of("state", vocab.OP_STATE),
    )

    op_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    # Null = the app-library log (`/library/ops`, D184).
    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(fk("app_user.id"))
    install_id: Mapped[uuid.UUID]
    client_ts: Mapped[datetime]
    server_seq: Mapped[int | None] = mapped_column(BigInteger)
    server_ts: Mapped[datetime | None]
    entity_kind: Mapped[str]
    entity_id: Mapped[uuid.UUID]
    kind: Mapped[str]
    field: Mapped[str | None]
    was: Mapped[Any | None] = mapped_column(JSONB)
    now: Mapped[Any | None] = mapped_column(JSONB)
    payload: Mapped[dict[str, Any] | None]
    base_op_id: Mapped[uuid.UUID | None]
    group_id: Mapped[uuid.UUID | None]
    change_type: Mapped[str]
    reason: Mapped[str | None]
    ruling_id: Mapped[uuid.UUID | None]
    proposal_id: Mapped[uuid.UUID | None]
    state: Mapped[str] = mapped_column(default="pending", server_default="pending")


class FieldHead(Base):
    """The op that last set each field (PLAN §2.1)."""

    __tablename__ = "field_head"

    entity_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    field: Mapped[str] = mapped_column(primary_key=True)
    op_id: Mapped[uuid.UUID] = mapped_column(fk("op.op_id"))


class ReviewItem(Id, Synced, Base):
    __tablename__ = "review_item"
    __table_args__ = (
        one_of("kind", vocab.REVIEW_KIND),
        one_of("state", vocab.REVIEW_STATE),
    )

    # Null = a conflict in the app library (D184).
    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"), index=True)
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    kind: Mapped[str]
    subject: Mapped[dict[str, Any] | None]
    op_a_id: Mapped[uuid.UUID | None] = mapped_column(fk("op.op_id"))
    op_b_id: Mapped[uuid.UUID | None] = mapped_column(fk("op.op_id"))
    candidates: Mapped[list[Any] | None]
    ruling: Mapped[bool] = mapped_column(default=False, server_default="false")
    state: Mapped[str] = mapped_column(default="open", server_default="open")
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    resolved_at: Mapped[datetime | None]
    resolution: Mapped[dict[str, Any] | None]


class Ruling(Id, Synced, Base):
    __tablename__ = "ruling"

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    text: Mapped[str]
    scope_levels: Mapped[list[Any] | None]
    filter: Mapped[dict[str, Any] | None]
    action: Mapped[dict[str, Any] | None]
    standing: Mapped[bool] = mapped_column(default=False, server_default="false")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    created_at: Mapped[datetime | None]
    applied_at: Mapped[datetime | None]
    op_count: Mapped[int | None]


class Proposal(Id, Synced, Base):
    __tablename__ = "proposal"
    __table_args__ = (
        Index(None, "project_id", "rule_id", "discriminator"),
        one_of("kind", vocab.PROPOSAL_KIND),
        one_of("state", vocab.PROPOSAL_STATE),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"))
    rule_id: Mapped[str]
    subject: Mapped[dict[str, Any] | None]
    discriminator: Mapped[str | None]
    kind: Mapped[str]
    payload: Mapped[dict[str, Any] | None]
    inputs_hash: Mapped[str | None]
    state: Mapped[str] = mapped_column(default="proposed", server_default="proposed")
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    decided_at: Mapped[datetime | None]


class Finding(Id, Synced, Base):
    __tablename__ = "finding"
    __table_args__ = (one_of("state", vocab.FINDING_STATE),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    lint_id: Mapped[str]
    subject: Mapped[dict[str, Any] | None]
    message: Mapped[str | None]
    state: Mapped[str] = mapped_column(default="open", server_default="open")
    dismissed_reason: Mapped[str | None]


class ImportBatch(Id, Base):
    __tablename__ = "import_batch"
    __table_args__ = (one_of("kind", vocab.IMPORT_KIND),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    kind: Mapped[str]
    files: Mapped[list[Any] | None]
    job_state: Mapped[str | None]
    stats: Mapped[dict[str, Any] | None]
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class DraftDevice(Id, Synced, Base):
    """Phase 1f `device_drafts` row."""

    __tablename__ = "draft_device"
    __table_args__ = (one_of("state", vocab.DRAFT_STATE), one_of("role", vocab.LIBRARY_ROLE))

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(fk("import_batch.id"))
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    model: Mapped[str | None]
    model_raw: Mapped[str | None]
    candidates: Mapped[list[Any] | None]
    name: Mapped[str | None]
    category: Mapped[str | None]
    role: Mapped[str | None]  # T115: what the extraction read the device as (D201)
    qty: Mapped[int | None]
    accessories: Mapped[list[Any] | None]
    source_ref: Mapped[dict[str, Any] | None]
    level_basis: Mapped[str | None]
    extraction: Mapped[str | None]
    confidence: Mapped[float | None]
    conflicts: Mapped[list[Any] | None]
    state: Mapped[str] = mapped_column(default="proposed", server_default="proposed")
    placed: Mapped[bool] = mapped_column(default=False, server_default="false")
    not_on_sheet: Mapped[bool] = mapped_column(default=False, server_default="false")


class DraftCable(Id, Synced, Base):
    """Phase 1f `cable_drafts` row."""

    __tablename__ = "draft_cable"
    __table_args__ = (one_of("state", vocab.DRAFT_STATE),)

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(fk("import_batch.id"))
    level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    code: Mapped[str | None]
    qty: Mapped[int | None]
    from_label: Mapped[str | None]
    to_label: Mapped[str | None]
    to_level_id: Mapped[uuid.UUID | None] = mapped_column(fk("level.id"))
    origin: Mapped[str | None]
    candidates: Mapped[list[Any] | None]
    source_ref: Mapped[dict[str, Any] | None]
    level_basis: Mapped[str | None]
    extraction: Mapped[str | None]
    confidence: Mapped[float | None]
    conflicts: Mapped[list[Any] | None]
    state: Mapped[str] = mapped_column(default="proposed", server_default="proposed")
    placed: Mapped[bool] = mapped_column(default=False, server_default="false")
    not_on_sheet: Mapped[bool] = mapped_column(default=False, server_default="false")


class LibraryType(Id, Synced, Base):
    """`project_id` null = app-level library (D65)."""

    __tablename__ = "library_type"
    __table_args__ = (
        one_of("id_scheme", vocab.ID_SCHEME),
        one_of("state", vocab.LIBRARY_STATE),
        one_of("role", vocab.LIBRARY_ROLE),
    )

    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"), index=True)
    model: Mapped[str]
    aliases: Mapped[list[Any] | None]
    category: Mapped[str | None]
    id_scheme: Mapped[str | None]
    default_cables: Mapped[list[Any] | None]
    optional_cables: Mapped[list[Any] | None]
    optional_accessories: Mapped[list[Any] | None]
    # Whether its devices carry a Neuron ID; null = the category's default (T68, D185).
    needs_neuron_id: Mapped[bool | None]
    state: Mapped[str] = mapped_column(default="draft", server_default="draft")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    # Provenance across op streams (a project type promoted to the app library, D184): a plain
    # id, no foreign key, so the library push never waits on the project's.
    promoted_from_id: Mapped[uuid.UUID | None]
    # T111 (D197): what a catalogue import keeps on the type. `source_ref` = `{kind: "davinci",
    # type_id, …}` (re-runs match by it); `accessory_only` = imported as another type's accessory,
    # never offered as a device (null = placeable).
    description: Mapped[str | None]
    datasheet_url: Mapped[str | None]
    source_ref: Mapped[dict[str, Any] | None]
    accessory_only: Mapped[bool | None]
    # T112 (D201): what its devices are (`app/roles.py`); null = the category's role. The ID
    # scheme, the Punch List Device text and the floor PDF's pin shapes read it.
    role: Mapped[str | None]


class RuleParam(Id, Synced, Base):
    """A rule's setting — an owner, a wording, a status (T102, D176, D211). `project_id` null = the
    app-level default (a `draft` until accepted; project creation copies the accepted ones), else
    the project's own value. `value` null = the built-in default (`PARAMS` in packages/rules). The
    id is a hash of (scope, rule_id, key) (`app/rule_params.py`), the same on every iPad."""

    __tablename__ = "rule_param"
    __table_args__ = (one_of("state", vocab.LIBRARY_STATE),)

    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"), index=True)
    rule_id: Mapped[str]
    key: Mapped[str]
    value: Mapped[Any | None] = mapped_column(JSONB)
    state: Mapped[str] = mapped_column(default="accepted", server_default="accepted")


class Suggestion(Id, Synced, Base):
    """A suggestion chip (T99, D174, D212), one row per phrase, at the device-type library's two
    scopes (D65): `project_id` null = the app library. `scope` + `ref` name what it hangs off — a
    `library_type` id, a category, a cable code — and `target` where it is offered (device Notes,
    end Note, a punch item's Item, a part's Part). Copied with the type and at project creation."""

    __tablename__ = "suggestion"
    __table_args__ = (
        one_of("scope", vocab.SUGGESTION_SCOPE),
        one_of("target", vocab.SUGGESTION_TARGET),
        one_of("state", vocab.LIBRARY_STATE),
    )

    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"), index=True)
    scope: Mapped[str]
    ref: Mapped[str] = mapped_column(index=True)
    target: Mapped[str]
    text: Mapped[str]
    state: Mapped[str] = mapped_column(default="draft", server_default="draft")
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    promoted_from_id: Mapped[uuid.UUID | None]


class Vocab(Id, Synced, Base):
    __tablename__ = "vocab"
    __table_args__ = (one_of("list", vocab.VOCAB_LIST), one_of("state", vocab.LIBRARY_STATE))

    # null = the app library's value (T104, D214), on `/library/ops` like suggestions
    project_id: Mapped[uuid.UUID | None] = mapped_column(fk("project.id"), index=True)
    list: Mapped[str]
    value: Mapped[str]
    canonical_of_id: Mapped[uuid.UUID | None] = mapped_column(fk("vocab.id"))
    state: Mapped[str] = mapped_column(default="accepted", server_default="accepted")


class Export(Id, Base):
    __tablename__ = "export"
    __table_args__ = (
        one_of("kind", vocab.EXPORT_KIND),
        # one queued or running export per project and kind (T93, D166)
        Index(
            "ux_export_active",
            "project_id",
            "kind",
            unique=True,
            postgresql_where=text("job_state IN ('queued', 'running')"),
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(fk("project.id"), index=True)
    kind: Mapped[str]
    params: Mapped[dict[str, Any] | None]
    blob: Mapped[str | None] = mapped_column(String(64))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    diff_summary: Mapped[dict[str, Any] | None]
    # Job lifecycle (T29, D137, T93): queued → running → done | failed | cancelled; `stats` holds
    # the stage and counts while running, then the filename, row counts, timings or the error.
    job_state: Mapped[str | None]
    stats: Mapped[dict[str, Any] | None]
    # Cancel (D166): the API stamps these; the job stops at its next progress report
    cancel_requested_at: Mapped[datetime | None]
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column(fk("app_user.id"))
