#!/usr/bin/env python3
"""Stage times of a Maestro run (T49): the newest commands.json under DEBUG_DIR whose flow folder
matches NAME, each top-level `runFlow` with a label starting PREFIX (default `e2e:`) and its
duration, then the run's total. Prints a Markdown table; exits 1 when the run did not complete.

    stages.py DEBUG_DIR NAME [PREFIX]
"""

import json
import pathlib
import sys


def main() -> int:
    root, name = pathlib.Path(sys.argv[1]), sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else "e2e:"
    runs = sorted(
        (p for p in root.glob("**/commands.json") if name in p.parent.name),
        key=lambda p: p.stat().st_mtime,
    )
    if not runs:
        print(f"no commands.json for a flow named like {name!r} under {root}", file=sys.stderr)
        return 1
    commands = json.loads(runs[-1].read_text())
    rows, ok = [], True
    for c in commands:
        meta = c.get("metadata") or {}
        if meta.get("status") == "FAILED":  # WARNED is an optional step that did not match
            ok = False
        run = (c.get("command") or {}).get("runFlowCommand")
        if meta.get("depth") != 0 or not run:
            continue
        label = run.get("label") or ""
        if label.startswith(prefix):
            rows.append((label[len(prefix):].strip(), meta.get("duration") or 0, meta.get("status")))
    stamps = [(c.get("metadata") or {}).get("timestamp") for c in commands]
    stamps = [s for s in stamps if s]
    last = commands[-1].get("metadata") or {}
    total = ((last.get("timestamp") or 0) + (last.get("duration") or 0) - min(stamps)) / 1000 if stamps else 0
    print(f"| Stage | Time | Status |\n|---|---|---|")
    for label, ms, status in rows:
        print(f"| {label} | {fmt(ms / 1000)} | {status} |")
    print(f"| **whole run** (incl. launch and connect) | **{fmt(total)}** | {'COMPLETED' if ok else 'FAILED'} |")
    return 0 if ok else 1


def fmt(s: float) -> str:
    m, s = divmod(round(s), 60)
    return f"{m} min {s:02d} s" if m else f"{s} s"


if __name__ == "__main__":
    sys.exit(main())
