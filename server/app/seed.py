"""Seed a project and its numbering groups from the command line (T14, D89).

Until T41 adds `POST /projects`, nothing creates the `project` row a push locks on, nor the
`numbering_group` rows levels point at. The twin-client harness (and anyone setting up a
scratch server) runs

    python -m app.seed project "Tower" "06/06M" "07"

which inserts one project and one numbering group per label and prints their ids as JSON:

    {"project_id": "…", "groups": {"06/06M": "…", "07": "…"}}

Levels are then created by the clients as ordinary `level` create ops referencing a group id.
Users come from `POST /team` (T60). Nothing here is reachable over HTTP.
"""

import argparse
import json
import sys
from typing import Any

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.ids import uuid7
from app.models import NumberingGroup, Project


def seed_project(session: Session, name: str, group_labels: list[str]) -> dict[str, Any]:
    """Insert a project and one numbering group per label; returns the ids as plain strings."""
    if not name.strip():
        raise ValueError("project name must not be empty")
    labels = [g.strip() for g in group_labels if g.strip()]
    if len(set(labels)) != len(labels):
        raise ValueError("numbering group labels must be distinct")
    project = Project(id=uuid7(), name=name.strip())
    groups = [NumberingGroup(id=uuid7(), project_id=project.id, label=label) for label in labels]
    session.add(project)
    session.add_all(groups)
    session.commit()
    return {"project_id": str(project.id), "groups": {g.label: str(g.id) for g in groups}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("project", help="create a project and its numbering groups")
    p.add_argument("name")
    p.add_argument("groups", nargs="+", metavar="GROUP_LABEL")
    args = parser.parse_args(argv)
    try:
        with SessionLocal() as session:
            out = seed_project(session, args.name, args.groups)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
