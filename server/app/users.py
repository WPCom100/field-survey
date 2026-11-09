"""Retire or restore people on the team (D269).

    python -m app.users list
    python -m app.users retire <name> [<name> ...]
    python -m app.users restore <name> [<name> ...]

A retired person leaves the team picker and Setup → Assignments but keeps their row, so every
edit they made still names them in History (nothing is deleted, CLAUDE.md §5). Adding the name
again in the picker, or signing in with Microsoft and adopting the row, restores them. Names
match as the picker does: trimmed, case-insensitive. System users (`import`, `export`) are
never listed or touched.
"""

import sys
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import is_system_user
from app.db import SessionLocal
from app.models import User


def _people(session: Session) -> list[User]:
    users = session.scalars(select(User).order_by(User.name, User.created_at)).all()
    return [u for u in users if not is_system_user(u)]


def _named(session: Session, name: str) -> list[User]:
    wanted = name.strip().lower()
    rows = session.scalars(select(User).where(func.lower(User.name) == wanted)).all()
    return [u for u in rows if not is_system_user(u)]


def set_retired(session: Session, names: list[str], retired: bool) -> list[str]:
    """Retire (or restore) every person with each name; returns one line per name. An unknown
    name is an error and nothing is changed."""
    found = {name: _named(session, name) for name in names}
    missing = [name for name, rows in found.items() if not rows]
    if missing:
        raise SystemExit(f"No such person: {', '.join(missing)}")
    now = datetime.now(UTC)
    lines = []
    for rows in found.values():
        for u in rows:
            was = u.retired_at is not None
            u.retired_at = (u.retired_at or now) if retired else None
            verb = "retired" if retired else "restored"
            lines.append(f"{u.name}: {verb}" if was != retired else f"{u.name}: already {verb}")
    session.commit()
    return lines


def listing(session: Session) -> list[str]:
    out = []
    for u in _people(session):
        state = f"retired {u.retired_at:%Y-%m-%d}" if u.retired_at else "active"
        signed = "signed in" if u.entra_oid else "team picker"
        out.append(f"{u.name}\t{state}\t{signed}\t{u.email or ''}".rstrip())
    return out


def main(argv: list[str]) -> None:
    with SessionLocal() as session:
        match argv:
            case ["list"]:
                lines = listing(session)
            case ["retire", *names] if names:
                lines = set_retired(session, names, True)
            case ["restore", *names] if names:
                lines = set_retired(session, names, False)
            case _:
                raise SystemExit(__doc__)
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1:])
