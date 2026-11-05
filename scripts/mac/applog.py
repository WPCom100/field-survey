"""Reads the app's log lines for `rig.sh pickup` and `rig.sh scale` (T159). Stdlib only (the Mac's
python3). A log line is `<ISO time>Z <LEVEL> [<category>] <event> {json}` (app/src/log).

  applog.py latency <A dir> <B dir> <t0> <t1>
      B's last push in [t0, t1] and A's first pull after it; prints the seconds between them
  applog.py burst <A dir> <t0> <t1> <ops>
      A's pull of exactly <ops> ops in [t0, t1], then the rules runs it set off (until the next
      pull that brought ops): one per project, none for the library stream (T131, D223)
  applog.py scale <dir> <t0> <t1> <project id>
      the scale numbers as `key value` lines (rig.sh compares them with the ceilings): scale.yaml
      in [t0, t1], scale-demo.yaml after t1
"""

from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime

LIBRARY_STREAM = "00000000-0000-7000-8000-00000000a11b"  # packages/core/src/library-stream.ts


def parse_time(s: str) -> float:
    s = s.rstrip("Z")
    fmt = "%Y-%m-%dT%H:%M:%S.%f" if "." in s else "%Y-%m-%dT%H:%M:%S"
    return (datetime.strptime(s, fmt) - datetime(1970, 1, 1)).total_seconds()


def lines(folder: str, t0: str, t1: str | None = None) -> list[tuple[float, str, str, dict]]:
    """(time, category, event, data) of every line in [t0, t1], oldest first."""
    lo, hi = parse_time(t0), parse_time(t1) if t1 else float("inf")
    out = []
    for path in glob.glob(os.path.join(folder, "*.log")):
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                parts = raw.rstrip("\n").split(" ", 4)
                if len(parts) < 4 or not parts[2].startswith("["):
                    continue
                try:
                    t = parse_time(parts[0])
                except ValueError:
                    continue
                if not lo <= t <= hi:
                    continue
                try:
                    data = json.loads(parts[4]) if len(parts) > 4 else {}
                except ValueError:
                    data = {}
                out.append((t, parts[2].strip("[]"), parts[3], data))
    out.sort(key=lambda r: r[0])
    return out


def synced(rows):
    return [r for r in rows if r[1] == "sync" and r[2] == "synced"]


def iso(t: float) -> str:
    return datetime.utcfromtimestamp(t).strftime("%H:%M:%S.%f")[:-3]


def cmd_latency(a: str, b: str, t0: str, t1: str) -> None:
    pushes = [r for r in synced(lines(b, t0, t1)) if r[3].get("pushed", 0) > 0]
    if not pushes:
        sys.exit(f"no push on B between {t0} and {t1}")
    tb = pushes[-1][0]
    pulls = [r for r in synced(lines(a, t0)) if r[0] >= tb and r[3].get("pulled", 0) > 0]
    if not pulls:
        sys.exit(f"A pulled nothing after B's push at {iso(tb)}")
    print(f"B pushed {pushes[-1][3]['pushed']} at {iso(tb)}; A pulled {pulls[0][3]['pulled']} at {iso(pulls[0][0])}: {pulls[0][0] - tb:.1f} s")


def cmd_burst(a: str, t0: str, t1: str, ops: str) -> None:
    rows = lines(a, t0)
    hi = parse_time(t1)
    pulls = [r for r in synced(rows) if r[3].get("pulled", 0) > 0]
    hit = [r for r in pulls if r[3]["pulled"] == int(ops) and r[0] <= hi]
    if not hit:
        sys.exit(f"no pull of {ops} ops on A between {t0} and {t1}; pulls: " + ", ".join(f"{iso(r[0])} {r[3]['pulled']}" for r in pulls))
    t, _, _, d = hit[0]
    nxt = next((r[0] for r in pulls if r[0] > t), float("inf"))
    runs = [r for r in rows if r[1] == "rules" and r[2] == "run" and t <= r[0] < nxt]
    projects = [r[3].get("project") for r in runs]
    print(f"pull at {iso(t)}: {d['pulled']} ops, ms {d.get('ms')} · pull {d.get('pull_ms')} · apply {d.get('apply_ms')}, {d.get('projects')} projects synced")
    print(f"rules runs after it: {len(runs)} for {len(set(projects))} projects, slowest {max((r[3].get('ms', 0) for r in runs), default=0)} ms")
    if LIBRARY_STREAM in projects:
        sys.exit("a rules run on the library stream (T131: a stream change re-runs every project, never the stream)")
    if len(projects) != len(set(projects)):
        sys.exit("a project ran twice for one pull")
    # the synced line counts the library stream among its "projects" (D184)
    if d.get("projects") is not None and len(runs) != d["projects"] - 1:
        sys.exit(f"{len(runs)} rules runs for {d['projects'] - 1} projects (D223: a library change re-runs every project once)")


def cmd_scale(folder: str, t0: str, t1: str, project: str) -> None:
    """scale.yaml ran in [t0, t1] (a fresh store's download, the Sync screen, the scale 06M plan),
    scale-demo.yaml after t1 (the 500-pin demo plan, also level 06M)."""
    rows = lines(folder, t0, t1)
    after = lines(folder, t1)
    pulls = [r[3] for r in synced(rows) if r[3].get("pulled", 0) > 0]
    runs = [r[3] for r in rows if r[1] == "rules" and r[2] == "run" and r[3].get("project") == project]
    quiet = [r[3] for r in synced(rows) if r[3].get("pulled", 0) == 0 and r[3].get("pushed", 0) == 0]
    sheets = [r[3].get("ms", 0) for r in rows if r[1] == "plan" and r[2] == "sheet_loaded"]
    demo = [r[3].get("ms", 0) for r in after if r[1] == "plan" and r[2] == "sheet_loaded"]
    if pulls:
        # the fresh store's download: every cycle that brought ops (pages over several cycles)
        print(f"download_ops {sum(p['pulled'] for p in pulls)}")
        print(f"download_cycle_ms {max(p.get('ms', 0) for p in pulls)}")
        print(f"download_apply_ms {sum(p.get('apply_ms', 0) for p in pulls)}")
    if runs:
        print(f"rules_first_ms {runs[0].get('ms', 0)}")
        q = [r.get("ms", 0) for r in runs if r.get("ops", 0) == 0]
        if q:
            print(f"rules_quiet_ms {max(q)}")
    if quiet:
        print(f"quiet_cycle_ms {max(q.get('ms', 0) for q in quiet[-5:])}")
    if sheets:
        print(f"sheet_loaded_ms {sheets[-1]}")
    if demo:
        print(f"demo_sheet_loaded_ms {demo[-1]}")


if __name__ == "__main__":
    cmds = {"latency": cmd_latency, "burst": cmd_burst, "scale": cmd_scale}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
