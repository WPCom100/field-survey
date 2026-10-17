"""Project creation and listing (PLAN §8, Phase 3 §3.1; T41, D127).

`POST /projects` is how a project comes to exist. The `project` row is inserted first (every
push locks it, and numbering groups must exist before any op — PLAN §8), then everything the
project starts with is written as **trusted ops** through the push loop (`app.sync.Push`): the
project itself, one `numbering_group` per group of levels (06 and 06M share, D33), the levels
in floor order, and the copies the caller asked for — vocabulary, device-type library (the app
library always, D65), standing rulings, the rule parameters (the app-level defaults always, then
a source project's values; T102, D176) and, optionally, placeholders. An iPad therefore gets
the whole project, its own `project` row included, from its first pull, and a replay of the
op log reproduces it. Numbering-group counters live outside the log, so `materialise.replay`
leaves `project` and `numbering_group` rows in place.

Later edits to the project (name, parties, export settings) and to its levels (floor order,
in scope, split, sharing, new levels, "Add range") are ordinary client ops; this module only
makes the starting point.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ids import uuid7
from app.models import (
    Level,
    LibraryType,
    NumberingGroup,
    Placeholder,
    Project,
    RuleParam,
    Ruling,
    Suggestion,
    User,
    Vocab,
)
from app.rule_params import rule_param_id
from app.sync import SERVER_INSTALL_ID, OpIn, Push, PushError, jsonable

DEFAULT_EXPORT_TITLE = "ETC Lighting Controls Survey"
PARTY_KEYS = ("ec", "etc", "gc")
SETTING_KEYS = ("export_title", "disclaimer")
CHANGE_TYPE = "Master edit"


class ProjectError(Exception):
    def __init__(self, status: int, detail: Any):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------------ bodies


class LevelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: str
    in_scope: bool = True
    # Code of another level in this body whose numbering group this level shares (D33).
    share_with: str | None = None
    # Code of the level this one is a split of (06M of 06).
    split_of: str | None = None


class CopyFrom(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: uuid.UUID
    vocabulary: bool = True
    library: bool = True
    rulings: bool = True
    # T102: the source project's rule parameters, over the app-level defaults
    rule_params: bool = True
    placeholders: bool = False


class ProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    site: str | None = None
    parties: dict[str, str] | None = None
    settings: dict[str, str] | None = None
    copy_from: CopyFrom | None = None
    levels: list[LevelIn] = Field(default_factory=list)


class LevelOut(BaseModel):
    id: str
    level: str
    floor_order: int | None
    in_scope: bool
    numbering_group_id: str
    numbering_group_label: str | None
    split_of_id: str | None
    state: str


class ProjectOut(BaseModel):
    id: str
    name: str
    site: str | None
    parties: dict[str, Any] | None
    settings: dict[str, Any] | None
    copied_from_id: str | None
    created_at: datetime | None
    levels: list[LevelOut]


class CreatedOut(ProjectOut):
    server_seq: int
    copied: dict[str, int]


# ----------------------------------------------------------------- helpers


def norm_level(code: str) -> str:
    """`6` → `06`, `6m` → `06M`, `b2` → `B2`; the project's own codes (CLAUDE.md §3)."""
    code = code.strip().upper()
    return code.zfill(2) if code.isdigit() else code


def _clean_parties(parties: dict[str, str] | None) -> dict[str, str]:
    out = {k: "" for k in PARTY_KEYS}
    for k, v in (parties or {}).items():
        if k not in PARTY_KEYS:
            raise ProjectError(422, f"unknown party {k!r} (ec, etc, gc)")
        out[k] = (v or "").strip()
    return out


def _clean_settings(settings: dict[str, str] | None) -> dict[str, str]:
    out = {"export_title": DEFAULT_EXPORT_TITLE, "disclaimer": ""}
    for k, v in (settings or {}).items():
        if k not in SETTING_KEYS:
            raise ProjectError(422, f"unknown setting {k!r} (export_title, disclaimer)")
        out[k] = (v or "").strip()
    if not out["export_title"]:
        out["export_title"] = DEFAULT_EXPORT_TITLE
    return out


@dataclass
class _LevelPlan:
    code: str
    in_scope: bool
    split_of: str | None
    group_root: str  # code of the level whose group this one shares (itself when alone)


def plan_levels(levels: list[LevelIn]) -> list[_LevelPlan]:
    """Validate the level list and resolve sharing: every level maps to a root code; levels
    with the same root share one numbering group (D33). Order = floor order."""
    codes = [norm_level(lv.level) for lv in levels]
    if any(not c for c in codes):
        raise ProjectError(422, "a level code is empty")
    if len(set(codes)) != len(codes):
        raise ProjectError(422, "level codes must be distinct")
    share = {}
    for code, lv in zip(codes, levels, strict=True):
        if lv.share_with is None:
            continue
        target = norm_level(lv.share_with)
        if target == code:
            raise ProjectError(422, f"level {code} cannot share with itself")
        if target not in codes:
            raise ProjectError(422, f"level {code} shares with unknown level {target}")
        share[code] = target

    def root(code: str) -> str:
        seen = {code}
        while code in share:
            code = share[code]
            if code in seen:
                raise ProjectError(422, f"numbering sharing loops at level {code}")
            seen.add(code)
        return code

    out = []
    for code, lv in zip(codes, levels, strict=True):
        split_of = norm_level(lv.split_of) if lv.split_of else None
        if split_of is not None and split_of not in codes:
            raise ProjectError(422, f"level {code} is a split of unknown level {split_of}")
        if split_of == code:
            raise ProjectError(422, f"level {code} cannot be a split of itself")
        out.append(_LevelPlan(code, lv.in_scope, split_of, root(code)))
    return out


class _Body:
    project_id: uuid.UUID
    since: int | None = None

    def __init__(self, project_id: uuid.UUID):
        self.project_id = project_id


class _Ops:
    """Trusted creates stamped by the requesting user from the server's install (D127)."""

    def __init__(self, project_id: uuid.UUID, user_id: uuid.UUID, reason: str):
        self.project_id = project_id
        self.user_id = user_id
        self.reason = reason
        self.ts = datetime.now(UTC)
        self.ops: list[Any] = []

    def create(self, entity_kind: str, payload: dict[str, Any]) -> uuid.UUID:
        eid = payload.get("id") or uuid7()
        self.ts += timedelta(microseconds=1)
        self.ops.append(
            OpIn(
                op_id=uuid7(),
                project_id=self.project_id,
                user_id=self.user_id,
                install_id=SERVER_INSTALL_ID,
                client_ts=self.ts,
                entity_kind=entity_kind,
                entity_id=eid,
                kind="create",
                payload=jsonable({"id": eid, **payload}),
                change_type=CHANGE_TYPE,
                reason=self.reason,
            )
        )
        return eid


# ------------------------------------------------------------------ create


def create_project(session: Session, body: ProjectIn, user: User) -> CreatedOut:
    """Insert the project row, then write the project, groups, levels and copies as ops."""
    name = body.name.strip()
    if not name:
        raise ProjectError(422, "project name must not be empty")
    parties = _clean_parties(body.parties)
    settings = _clean_settings(body.settings)
    levels = plan_levels(body.levels)
    source: Project | None = None
    if body.copy_from is not None:
        source = session.get(Project, body.copy_from.project_id)
        if source is None or source.deleted_at is not None:
            raise ProjectError(404, f"unknown project {body.copy_from.project_id}")

    now = datetime.now(UTC)
    project = Project(
        id=uuid7(),
        name=name,
        site=(body.site or "").strip() or None,
        parties=parties,
        settings=settings,
        copied_from_id=source.id if source else None,
        created_at=now,
    )
    session.add(project)
    session.flush()

    reason = f"Project created by {user.name}" + (f", copied from {source.name}" if source else "")
    ops = _Ops(project.id, user.id, reason)
    ops.create(
        "project",
        {
            "id": project.id,
            "name": name,
            "site": project.site,
            "parties": parties,
            "settings": settings,
            "copied_from_id": project.copied_from_id,
            "created_at": now,
        },
    )

    # Numbering groups: one per root, labelled with its members in floor order (`06/06M`).
    members: dict[str, list[str]] = {}
    for lv in levels:
        members.setdefault(lv.group_root, []).append(lv.code)
    group_ids: dict[str, uuid.UUID] = {}
    group_labels: dict[uuid.UUID, str] = {}
    for root_code, codes in members.items():
        label = "/".join(codes)
        gid = ops.create("numbering_group", {"project_id": project.id, "label": label})
        group_ids[root_code] = gid
        group_labels[gid] = label

    level_ids = {lv.code: uuid7() for lv in levels}
    level_rows: list[LevelOut] = []
    for order, lv in enumerate(levels, start=1):
        gid = group_ids[lv.group_root]
        split_id = level_ids[lv.split_of] if lv.split_of else None
        ops.create(
            "level",
            {
                "id": level_ids[lv.code],
                "project_id": project.id,
                "level": lv.code,
                "floor_order": order,
                "numbering_group_id": gid,
                "in_scope": lv.in_scope,
                "split_of_id": split_id,
                "state": "setup",
            },
        )
        level_rows.append(
            LevelOut(
                id=str(level_ids[lv.code]),
                level=lv.code,
                floor_order=order,
                in_scope=lv.in_scope,
                numbering_group_id=str(gid),
                numbering_group_label=group_labels[gid],
                split_of_id=str(split_id) if split_id else None,
                state="setup",
            )
        )

    copied = _copy(session, ops, project.id, user, source, body.copy_from)

    push = Push(session, _Body(project.id), trusted=True)
    try:
        out = push.run(ops.ops)
    except PushError as e:  # a bug in this module, never the caller's input
        raise ProjectError(500, e.detail) from e
    bad = [r for r in out.results if r.outcome != "applied"]
    if bad:
        raise ProjectError(500, f"{len(bad)} project ops did not apply")
    # The row existed before its create op (the push locks it); give it the op's version.
    project.version = 1
    project.head_seq = out.results[0].server_seq
    session.commit()
    return CreatedOut(
        **project_out(session, project).model_dump(),
        server_seq=out.server_seq,
        copied=copied,
    )


def _copy(
    session: Session,
    ops: _Ops,
    project_id: uuid.UUID,
    user: User,
    source: Project | None,
    flags: CopyFrom | None,
) -> dict[str, int]:
    """Copies as new rows (new ids, `canonical_of` remapped); counts per kind."""
    counts = {
        "vocab": 0,
        "library_types": 0,
        "suggestions": 0,
        "rulings": 0,
        "rule_params": 0,
        "placeholders": 0,
    }
    now = datetime.now(UTC)

    # The app library (D65) always seeds the project's library; a source project's accepted
    # types follow, unless the same model is already in.
    models: set[str] = set()
    types = list(
        session.scalars(
            select(LibraryType).where(
                LibraryType.project_id.is_(None),
                LibraryType.state == "accepted",
                LibraryType.deleted_at.is_(None),
            )
        )
    )
    if source is not None and flags is not None and flags.library:
        types += list(
            session.scalars(
                select(LibraryType).where(
                    LibraryType.project_id == source.id,
                    LibraryType.state == "accepted",
                    LibraryType.deleted_at.is_(None),
                )
            )
        )
    type_ids: dict[uuid.UUID, uuid.UUID] = {}  # source type -> its copy (T99: chips follow)
    for t in types:
        key = t.model.casefold()
        if key in models:
            continue
        models.add(key)
        type_ids[t.id] = ops.create(
            "library_type",
            {
                "project_id": project_id,
                "model": t.model,
                "aliases": t.aliases,
                "category": t.category,
                "id_scheme": t.id_scheme,
                "default_cables": t.default_cables,
                "optional_cables": t.optional_cables,
                "optional_accessories": t.optional_accessories,
                "needs_neuron_id": t.needs_neuron_id,
                "role": t.role,  # T112
                "state": "accepted",
                "created_by_id": user.id,
            },
        )
        counts["library_types"] += 1

    with_source = source is not None and flags is not None and flags.library
    counts["suggestions"] = _copy_suggestions(
        session, ops, project_id, user, source if with_source else None, type_ids
    )

    _copy_rule_params(session, ops, project_id, source if flags and flags.rule_params else None)
    counts["rule_params"] = sum(1 for o in ops.ops if o.entity_kind == "rule_param")

    if source is None or flags is None:
        return counts

    if flags.vocabulary:
        rows = list(
            session.scalars(
                select(Vocab).where(Vocab.project_id == source.id, Vocab.deleted_at.is_(None))
            )
        )
        new_ids = {v.id: uuid7() for v in rows}
        # Canonicals before their variants, so `canonical_of` always points at an existing row.
        for v in sorted(rows, key=lambda v: v.canonical_of_id is not None):
            canonical = new_ids.get(v.canonical_of_id) if v.canonical_of_id else None
            ops.create(
                "vocab",
                {
                    "id": new_ids[v.id],
                    "project_id": project_id,
                    "list": v.list,
                    "value": v.value,
                    "canonical_of_id": canonical,
                },
            )
            counts["vocab"] += 1

    if flags.rulings:
        for r in session.scalars(
            select(Ruling).where(
                Ruling.project_id == source.id,
                Ruling.standing.is_(True),
                Ruling.deleted_at.is_(None),
            )
        ):
            # Scope levels belong to the old project; a standing ruling starts project-wide.
            ops.create(
                "ruling",
                {
                    "project_id": project_id,
                    "text": r.text,
                    "scope_levels": None,
                    "filter": r.filter,
                    "action": r.action,
                    "standing": True,
                    "created_by_id": user.id,
                    "created_at": now,
                },
            )
            counts["rulings"] += 1

    if flags.placeholders:
        for p in session.scalars(
            select(Placeholder).where(
                Placeholder.project_id == source.id,
                Placeholder.level_id.is_(None),  # level-bound ones name the old levels
                Placeholder.deleted_at.is_(None),
            )
        ):
            ops.create("placeholder", {"project_id": project_id, "label": p.label, "kind": p.kind})
            counts["placeholders"] += 1

    return counts


def _copy_suggestions(
    session: Session,
    ops: "_Ops",
    project_id: uuid.UUID,
    user: User,
    source: Project | None,
    type_ids: dict[uuid.UUID, uuid.UUID],
) -> int:
    """The new project's suggestion chips (T99, D212): the accepted ones of the app library, then
    of the source project — a type's chips only when the type itself was copied (pointing at the
    copy), every category and cable-code chip. One chip per (scope, what, where, text)."""
    scopes = [Suggestion.project_id.is_(None)]
    if source is not None:
        scopes.append(Suggestion.project_id == source.id)
    seen: set[tuple[str, str, str, str]] = set()
    n = 0
    for where in scopes:
        rows = session.scalars(
            select(Suggestion)
            .where(where, Suggestion.state == "accepted", Suggestion.deleted_at.is_(None))
            .order_by(Suggestion.id)
        )
        for r in rows:
            ref = r.ref
            if r.scope == "type":
                try:
                    copied = type_ids.get(uuid.UUID(r.ref))
                except ValueError:
                    copied = None
                if copied is None:
                    continue
                ref = str(copied)
            key = (r.scope, ref.casefold(), r.target, r.text.strip().casefold())
            if key in seen:
                continue
            seen.add(key)
            ops.create(
                "suggestion",
                {
                    "project_id": project_id,
                    "scope": r.scope,
                    "ref": ref,
                    "target": r.target,
                    "text": r.text,
                    "state": "accepted",
                    "created_by_id": user.id,
                },
            )
            n += 1
    return n


def _copy_rule_params(
    session: Session, ops: "_Ops", project_id: uuid.UUID, source: Project | None
) -> None:
    """The new project's rule parameters (T102, D176 (2)): every accepted app-level default that
    sets a value, then the source project's own values over them. A parameter on its built-in
    default (`value` null) is not copied: no row reads as the default. Ids hash (project, rule,
    key) like the iPad's, so a later edit on an iPad sets the copied row."""
    values: dict[tuple[str, str], Any] = {}
    scopes = [RuleParam.project_id.is_(None)]
    if source is not None:
        scopes.append(RuleParam.project_id == source.id)
    for where in scopes:
        rows = session.scalars(
            select(RuleParam)
            .where(where, RuleParam.state == "accepted", RuleParam.deleted_at.is_(None))
            .order_by(RuleParam.rule_id, RuleParam.key)
        )
        for r in rows:
            if r.value is not None:
                values[(r.rule_id, r.key)] = r.value
    for (rule_id, key), value in values.items():
        ops.create(
            "rule_param",
            {
                "id": rule_param_id(project_id, rule_id, key),
                "project_id": project_id,
                "rule_id": rule_id,
                "key": key,
                "value": value,
                "state": "accepted",
            },
        )


# -------------------------------------------------------------------- read


def project_out(session: Session, project: Project) -> ProjectOut:
    levels = session.scalars(
        select(Level)
        .where(Level.project_id == project.id, Level.deleted_at.is_(None))
        .order_by(Level.floor_order, Level.level)
    ).all()
    labels = {
        g.id: g.label
        for g in session.scalars(
            select(NumberingGroup).where(NumberingGroup.project_id == project.id)
        )
    }
    return ProjectOut(
        id=str(project.id),
        name=project.name,
        site=project.site,
        parties=project.parties,
        settings=project.settings,
        copied_from_id=str(project.copied_from_id) if project.copied_from_id else None,
        created_at=project.created_at,
        levels=[
            LevelOut(
                id=str(lv.id),
                level=lv.level,
                floor_order=lv.floor_order,
                in_scope=lv.in_scope,
                numbering_group_id=str(lv.numbering_group_id),
                numbering_group_label=labels.get(lv.numbering_group_id),
                split_of_id=str(lv.split_of_id) if lv.split_of_id else None,
                state=lv.state,
            )
            for lv in levels
        ],
    )


def list_projects(session: Session) -> list[ProjectOut]:
    rows = session.scalars(
        select(Project).where(Project.deleted_at.is_(None)).order_by(Project.created_at)
    ).all()
    return [project_out(session, p) for p in rows]
