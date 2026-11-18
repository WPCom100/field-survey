"""One-off removal of every project's data and the device-type library (T198, D287 (7), D292 (5)).

    python -m app.wipe          # dry run: what would go and what stays, per table; nothing changes
    python -m app.wipe --yes    # delete, in one transaction, then the gone blobs' objects
    python -m app.wipe --all [--yes]   # every row of every table (users too) and every blob

Run it through `server/deploy/wipe-projects.sh`, which takes the backups first and stops the API and
the worker around the delete (docs/ops.md §4.4). It runs once, on the Droplet, after every iPad has
synced and cold-launched onto the one-library update; each iPad's local data is reset afterwards.

What goes: every project and everything under it (levels, sheets, devices, cables and their ends,
placeholders, punch items, parts, photos, ink, rulings, proposals, findings, imports, drafts,
exports), the project-scoped vocabulary and rule parameters, every project op and review item,
every `library_type` and `suggestion` row (D292 (5): the DaVinci library is imported again from
Sources afterwards), the library log's ops on them, the library review items about them (and the ops
on those items), the field heads of every gone op, and every blob no kept op names (rows and
objects). What stays: users, installs, the app-level vocabulary (categories, cable codes, pin
shapes, …) and rule defaults, and their ops on the library log.

This is the one hard delete in the repo (CLAUDE.md §5 soft-deletes everything else), so the script
refuses nothing quietly: every table in the schema is classified below (a test fails on a new one),
and every foreign key is deferred, so a kept row still pointing at a gone one fails the commit and
leaves the database as it was.
"""

import json
import sys
from dataclasses import dataclass, field

from sqlalchemy import Connection, text

from app.blobs import chunk_key, object_key
from app.db import Base, engine
from app.storage import ObjectStore, S3ObjectStore

# Every row belongs to a project: all of them go.
PROJECT_TABLES = (
    "project",
    "numbering_group",
    "level",
    "sheet",
    "assignment",
    "device",
    "accessory",
    "cable",
    "cable_end",
    "placeholder",
    "punch_item",
    "missing_part",
    "part_source",
    "photo",
    "photo_link",
    "ink_layer",
    "ruling",
    "proposal",
    "finding",
    "import_batch",
    "draft_device",
    "draft_cable",
    "export",
)
# The device-type library and its chips (app-level only since T196): all of them go (D292 (5)).
LIBRARY_TABLES = ("library_type", "suggestion")
LIBRARY_KINDS = LIBRARY_TABLES
_KINDS = "(" + ", ".join(f"'{k}'" for k in LIBRARY_KINDS) + ")"
# A project op or one on a library type or chip: the ops that go, before the review items' own.
_BASE_OP = f"SELECT op_id FROM op WHERE project_id IS NOT NULL OR entity_kind IN {_KINDS}"
# Project rows and app-level rows side by side: the project rows (and what hangs off them) go.
MIXED_TABLES = ("op", "field_head", "review_item", "vocab", "rule_param")
# Untouched.
KEPT_TABLES = ("app_user", "install")
# Rows go when no kept op names them; their objects with them.
BLOB_TABLE = "blob"
ALL_TABLES = PROJECT_TABLES + LIBRARY_TABLES + MIXED_TABLES + KEPT_TABLES + (BLOB_TABLE,)

# The temp tables the plan fills; every count and delete reads them.
_PLAN = (
    f"""CREATE TEMP TABLE wipe_review ON COMMIT DROP AS
       SELECT id FROM review_item
        WHERE project_id IS NOT NULL
           OR subject->>'entity_kind' IN {_KINDS}
           OR op_a_id IN ({_BASE_OP})
           OR op_b_id IN ({_BASE_OP})""",
    f"""CREATE TEMP TABLE wipe_op ON COMMIT DROP AS
       SELECT op_id FROM op
        WHERE project_id IS NOT NULL
           OR entity_kind IN {_KINDS}
           OR (entity_kind = 'review_item' AND entity_id IN (SELECT id FROM wipe_review))""",
)
_GONE = {
    "op": "op_id IN (SELECT op_id FROM wipe_op)",
    "field_head": "op_id IN (SELECT op_id FROM wipe_op)",
    "review_item": "id IN (SELECT id FROM wipe_review)",
    "vocab": "project_id IS NOT NULL",
    "rule_param": "project_id IS NOT NULL",
}


@dataclass
class Plan:
    gone: dict[str, int] = field(default_factory=dict)
    kept: dict[str, int] = field(default_factory=dict)
    blobs: list[tuple[str, str, list[int]]] = field(default_factory=list)  # sha, state, chunks

    def lines(self) -> list[str]:
        width = max(len(t) for t in self.gone)
        out = [f"{'table':<{width}}  {'gone':>8}  {'kept':>8}"]
        for t in sorted(self.gone):
            out.append(f"{t:<{width}}  {self.gone[t]:>8}  {self.kept[t]:>8}")
        return out


def _count(conn: Connection, table: str, where: str | None = None) -> int:
    sql = f'SELECT count(*) FROM "{table}"' + (f" WHERE {where}" if where else "")
    return conn.execute(text(sql)).scalar_one()


def plan(conn: Connection, everything: bool = False) -> Plan:
    """Fill the temp tables and count; the caller's transaction decides whether anything goes.
    `everything`: every row of every table goes, users and the app vocabulary too (Landry,
    2026-11-18: "wiping the droplet clean of all users, projects, libraries")."""
    if everything:
        p = Plan()
        for t in ALL_TABLES:
            p.gone[t], p.kept[t] = _count(conn, t), 0
        rows = conn.execute(text("SELECT sha256, upload_state, chunks_received FROM blob")).all()
        p.blobs = [(sha, state, list(chunks or [])) for sha, state, chunks in rows]
        return p
    for sql in _PLAN:
        conn.execute(text(sql))
    p = Plan()
    for t in PROJECT_TABLES + LIBRARY_TABLES:
        p.gone[t], p.kept[t] = _count(conn, t), 0
    for t, where in _GONE.items():
        p.gone[t] = _count(conn, t, where)
        p.kept[t] = _count(conn, t) - p.gone[t]
    for t in KEPT_TABLES:
        p.gone[t], p.kept[t] = 0, _count(conn, t)
    kept_text = "\n".join(
        json.dumps(list(row))
        for row in conn.execute(
            text("SELECT now, was, payload FROM op WHERE op_id NOT IN (SELECT op_id FROM wipe_op)")
        )
    )
    rows = conn.execute(text("SELECT sha256, upload_state, chunks_received FROM blob")).all()
    p.blobs = [
        (sha, state, list(chunks or [])) for sha, state, chunks in rows if sha not in kept_text
    ]
    p.gone[BLOB_TABLE], p.kept[BLOB_TABLE] = len(p.blobs), len(rows) - len(p.blobs)
    return p


def delete(conn: Connection, p: Plan, everything: bool = False) -> None:
    """Delete what `plan` counted. Foreign keys are deferred (`app/models.fk`), so the order does
    not matter; a kept row naming a gone one fails at commit."""
    if everything:
        conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in ALL_TABLES)))
        return
    # A kept app-level value may name a gone project value as its canonical spelling.
    conn.execute(
        text(
            "UPDATE vocab SET canonical_of_id = NULL WHERE project_id IS NULL AND canonical_of_id"
            " IN (SELECT id FROM vocab WHERE project_id IS NOT NULL)"
        )
    )
    for t, where in reversed(list(_GONE.items())):
        conn.execute(text(f'DELETE FROM "{t}" WHERE {where}'))
    for t in PROJECT_TABLES + LIBRARY_TABLES:
        conn.execute(text(f'DELETE FROM "{t}"'))
    if p.blobs:
        conn.execute(
            text("DELETE FROM blob WHERE sha256 = ANY(:shas)"), {"shas": [b[0] for b in p.blobs]}
        )


def object_keys(p: Plan) -> list[str]:
    keys: list[str] = []
    for sha, state, chunks in p.blobs:
        keys.append(object_key(sha))
        keys.extend(chunk_key(sha, n) for n in chunks if state != "complete")
    return keys


def run(
    conn_factory=None, store: ObjectStore | None = None, *, apply: bool, everything: bool = False
) -> Plan:
    """Count (and with `apply`, delete) in one transaction; objects go only after the commit."""
    eng = conn_factory or engine
    with eng.connect() as conn:
        tx = conn.begin()
        try:
            p = plan(conn, everything)
            if apply:
                delete(conn, p, everything)
                tx.commit()
            else:
                tx.rollback()
        except BaseException:
            if tx.is_active:
                tx.rollback()
            raise
    if apply and p.blobs:
        (store or S3ObjectStore()).delete_many(object_keys(p))
    return p


def check_classified() -> list[str]:
    """Tables in the schema this script does not name (a test keeps it empty)."""
    named = set(ALL_TABLES)
    return sorted(set(Base.metadata.tables) - named)


def main(argv: list[str]) -> None:
    import app.models  # noqa: F401  (registers every table on Base.metadata)

    unnamed = check_classified()
    if unnamed:
        raise SystemExit(f"wipe: tables not classified: {', '.join(unnamed)}")
    everything = "--all" in argv
    rest = [a for a in argv if a != "--all"]
    if rest not in ([], ["--yes"]):
        raise SystemExit("usage: python -m app.wipe [--all] [--yes]")
    apply = rest == ["--yes"]
    p = run(apply=apply, everything=everything)
    print("\n".join(p.lines()))
    if apply:
        print(f"wipe: done — {sum(p.gone.values())} rows and {len(object_keys(p))} objects removed")
    else:
        print("wipe: dry run — nothing changed (add --yes to delete)")


if __name__ == "__main__":
    main(sys.argv[1:])
