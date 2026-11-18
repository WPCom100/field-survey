"""Dump the DaVinci sample as the library types the import plans (T199, TP-8).

Reads `fixtures/davinci-library-sample.json` and `fixtures/DaVinci_categories.xlsx`, runs the
import's own planning (`app.jobs.davinci_library.build_plan`: no database, no ops) and writes the
planned `library_type` payloads to `fixtures/davinci-library-types.json`:

    {"source": "...", "types": [ {"type_id": ..., "role": ..., ...payload}, ... ]}

`packages/rules/src/golden/master.test.ts` loads that file as the app library and checks which of
the master's rows the library produces (a device's cables come from its type and the accessories
it carries, D288 / D290). `test_davinci_library.py` fails when the file is not what the import
plans, so regenerate it whenever the import's planning changes:

    cd server && uv run python tests/dump_davinci_types.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from app.jobs import davinci_library as dl  # noqa: E402

FIXTURES = SERVER_DIR.parent / "fixtures"
SAMPLE = FIXTURES / "davinci-library-sample.json"
CATEGORIES = FIXTURES / "DaVinci_categories.xlsx"
OUT = FIXTURES / "davinci-library-types.json"


def dump(plan: dl.Plan) -> dict[str, Any]:
    """The plan as the fixture holds it: each type's payload with its DaVinci id and its role."""
    return {
        "source": (
            "fixtures/davinci-library-sample.json + fixtures/DaVinci_categories.xlsx as "
            "app.jobs.davinci_library.build_plan plans them (server/tests/dump_davinci_types.py)"
        ),
        "types": [{"type_id": t.type_id, "role": t.role, **t.payload} for t in plan.types],
    }


def main() -> int:
    for path in (SAMPLE, CATEGORIES):
        if not path.exists():
            print(f"golden fixture missing: {path}", file=sys.stderr)
            return 2
    plan = dl.build_plan(
        dl.read_library(SAMPLE.read_bytes()), dl.read_categories(CATEGORIES.read_bytes())
    )
    OUT.write_text(json.dumps(dump(plan), indent=1) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(plan.types)} types")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
