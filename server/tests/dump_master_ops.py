"""Dump the seeded master as the op log a client pulls (T35, TP-8).

Imports `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx` into a fresh `<db>_golden`
database exactly as `POST /imports` + the worker would (`runner.create_batch` + `run_batch`),
then pages the project's ops through `pull_ops` (what `GET /ops` returns) and writes them to
`fixtures/master-ops.json`:

    {"project_id": "...", "server_seq": n, "ops": [ ...op_to_json rows, oldest first... ]}

`packages/rules/src/golden/master.test.ts` replays that file into a Node store with
`Store.applyRemoteMany` (the pull path) and runs the rule engine over it. Regenerate the file
whenever the seed import changes:

    cd server && .venv/Scripts/python.exe tests/dump_master_ops.py        # Windows
    cd server && uv run python tests/dump_master_ops.py                   # elsewhere

Needs Postgres (`docker compose up -d postgres`). Record ids are fresh UUIDs on every run, so
the file changes on every regeneration; the golden test compares content, never ids.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))
sys.path.insert(0, str(SERVER_DIR / "tests"))

import uuid  # noqa: E402

from conftest import alembic_config  # noqa: E402

from app import projects  # noqa: E402
from app.auth import upsert_user  # noqa: E402
from app.config import settings  # noqa: E402
from app.jobs import runner  # noqa: E402
from app.models import ImportBatch  # noqa: E402
from app.storage import MemoryObjectStore  # noqa: E402
from app.sync import MAX_OPS_PER_PULL, pull_ops  # noqa: E402

FIXTURE = SERVER_DIR.parent / "fixtures" / "Lighting_Control_Survey_Master_B2-06_4.xlsx"
OUT = SERVER_DIR.parent / "fixtures" / "master-ops.json"


def main(out: Path = OUT) -> int:
    if not FIXTURE.exists():
        print(f"golden fixture missing: {FIXTURE} (CLAUDE.md §6)")
        return 2
    base = make_url(settings.database_url)
    url = base.set(database=f"{base.database}_golden")
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{url.database}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{url.database}"'))
    admin.dispose()
    url_s = url.render_as_string(hide_password=False)
    command.upgrade(alembic_config(url_s), "head")
    engine = create_engine(url_s)
    store = MemoryObjectStore()
    try:
        with Session(engine) as s:
            landry = upsert_user(s, "Landry")
            project_id = uuid.UUID(
                projects.create_project(s, projects.ProjectIn(name="Tower"), landry).id
            )
            batch = runner.create_batch(
                s,
                store,
                project_id=project_id,
                kind="master_xlsx",
                filename=FIXTURE.name,
                data=FIXTURE.read_bytes(),
                user=landry,
            )
            s.commit()
            batch_id = batch.id
        state = runner.run_batch(lambda: Session(engine), store, batch_id)
        with Session(engine) as s:
            batch = s.get(ImportBatch, batch_id)
            assert batch is not None
            if state != "done":
                print(f"import {state}: {json.dumps(batch.stats, indent=2)[:4000]}")
                return 1
            stats = {k: v for k, v in (batch.stats or {}).items() if k != "checks_list"}
            ops: list[dict] = []
            since = 0
            while True:
                page = pull_ops(s, project_id, since, MAX_OPS_PER_PULL)
                ops.extend(page.ops)
                if not page.ops or not page.has_more:
                    top = page.server_seq
                    break
                since = page.ops[-1]["server_seq"]
        out.write_text(
            json.dumps(
                {"project_id": str(project_id), "server_seq": top, "stats": stats, "ops": ops},
                indent=None,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"wrote {out} — {len(ops)} ops, server_seq {top}")
        print(json.dumps(stats, indent=2)[:2000])
        return 0
    finally:
        engine.dispose()
        admin = create_engine(base, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{url.database}" WITH (FORCE)'))
        admin.dispose()


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT))
