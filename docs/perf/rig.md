# Scale on the Mac rig — regression numbers (T159, rig plan wave 5)

`rig.sh scale-check` runs `scale.yaml` and `scale-demo.yaml` on simulator A against the TP-3
synthetic project **Maestro scale** (`rig.sh scale`: 2,000 devices, 1,000 of them on 06M, 1,000
cables, 1,000 punch items, 10,000 photos with thumbnails only; `docs/perf/tp3.md`) and reads the
numbers from the app's log. They are **simulator numbers on the Mac** (Apple silicon, 16 GB, Debug
dev client loading JS from Metro, Hermes, expo-sqlite): they do not transfer to the iPad
(`docs/ops.md` §6.4) but a doubling shows up. A run over a ceiling in
`scripts/mac/scale-ceilings.txt` fails.

## What is measured

Each run starts from a **fresh store** (`_launch` clears it), so each run measures the same thing:
Projects → Refresh downloads every project on the rig server, Maestro scale among them.

| Key | Log line | What |
|---|---|---|
| `download_cycle_ms` | `[sync] synced` `ms` | the slowest cycle that pulled ops (the whole download fits in one) |
| `download_apply_ms` | `[sync] synced` `apply_ms` | applying the pulled ops, summed over those cycles |
| `rules_first_ms` | `[rules] run` `ms` on Maestro scale | the first rules run after the download |
| `rules_quiet_ms` | the same, `ops` 0 | a run that writes nothing (printed, no ceiling: it is the first run except on a new scale project) |
| `quiet_cycle_ms` | `[sync] synced` `ms`, 0 pushed and 0 pulled | the slowest of the last five quiet cycles, every project on the iPad |
| `sheet_loaded_ms` | `[plan] sheet_loaded` | Maestro scale's 06M plan (the 06M composite, 1,000 pins) |
| `demo_sheet_loaded_ms` | `[plan] sheet_loaded` after `scale-demo.yaml` | the demo plan with 500 pins (`500 pins →`) |

The flow also asserts the Sync screen's timing line on a quiet cycle (`Last cycle … · 0 pushed,
0 pulled …`, testID `sync.timing`) and `Devices 1000` on the 06M plan.

## Results

2026-11-05, rig server with 19 other projects (pickup and wave 2 runs, the seed and the pipeline
projects), so the download is 55–59 thousand ops of which Maestro scale is most.

| Key | Run 1 (ceilings set from it) | Run 2 | Ceiling |
|---|---|---|---|
| download (ops) | 58,070 | 58,917 | — |
| `download_cycle_ms` | 99,100 | 104,982 | 200,000 |
| `download_apply_ms` | 96,004 | 99,945 | 200,000 |
| `rules_first_ms` | 6,617 (1,612 ops: the project's first ever run writes its 526 proposals and 1,086 findings) | 714 (0 ops: run 1's were pulled down) | 15,000 |
| `quiet_cycle_ms` | 769 | 842 | 2,000 |
| `sheet_loaded_ms` (06M, 1,000 pins) | 1,243 | 1,247 | 3,000 |
| `demo_sheet_loaded_ms` (500 pins) | 971 | 424 | 2,500 |

A whole run takes about 4 minutes. What it tells you:

- **Applying a pull costs ~1.7 ms per op on the simulator** (96 s for 55,439 ops in the first
  cycle) against 0.23 ms in Node (`tp3.md`: 31,089 ops in 7.0 s). A first sign-in to a full tower
  on the iPad is minutes, not seconds; T131's chunking keeps the screens answering meanwhile.
- **The first rules run on a new project of this size** writes ~1,600 proposals and findings in
  6.6 s on the simulator, then pushes them (the next cycle: 2,202 pushed in 11 s). Every later
  store reads them instead and its run is under a second.
- **A quiet cycle with 20 projects** stays under a second; the 06M composite with 1,000 pins opens
  in about 1.2 s, the 500-pin demo in 0.4–1.0 s.

## The export of Maestro scale (T165)

`rig.sh long-export` ends with one workbook of Maestro scale (all levels, all tabs) at full speed and
prints the server's `stats.stage_seconds`; the worker is the rig's (Colima, 4 CPUs, SeaweedFS on
localhost, so each picture read is ~1 ms instead of the Droplet's ~110 ms to R2). No ceiling: a
regression number beside T94's Droplet one (`docs/perf/tp3.md`), not a substitute.

| Workbook of Maestro scale (10,000 pictures, 34.0 MB) | Reading | Photo Log | Writing | Comparing | Total |
|---|---|---|---|---|---|
| first export, nothing to compare (API, 2026-11-07) | 0.4 s | 5.5 s | 9.9 s | — | **16 s** |
| `rig.sh long-export` run 1 (a previous export to compare) | 0.4 s | 6.3 s | 10.6 s | 23.8 s | **41 s** |
| `rig.sh long-export` run 2 | 0.4 s | 6.0 s | 10.4 s | 23.6 s | **40 s** |
| worker at 0.1 CPU (`RIG_EXPORT_CPUS`, D259; cancelled in Photo Log) | 12–18 s | ~22 pictures/s | — | — | ~9 min (estimated) |

"Comparing with the last export" (the diff against the previous workbook) now costs more than the
rest of the job together on this project, and it reports no progress, so Cancel does not stop it
(T170).

## Keeping it useful

- Make Maestro scale only in the session that needs it, and `server reset` (then `seed`,
  `pipeline`) afterwards (`docs/ops.md` §6.2): while it is on the server every fresh store pulls
  it, and a flow's first sync takes minutes.
- Raise a ceiling only with a reason written here (a heavier fixture, more rig projects), never to
  make a red run green.
