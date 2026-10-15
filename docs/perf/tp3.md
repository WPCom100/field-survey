# TP-3 — a project the size of a full tower (T32)

Phase 4 §4 TP-3: a synthetic project with **2,000 devices, 10,000 photos and 1,500 ops**. Pass
when, on the iPad: the plan opens in **< 3 s**, the device list scrolls smoothly, the thumbnails
of the assigned levels prefetch in **< 10 min on Wi-Fi**, and the export completes in **< 5 min**.
Storage at that size is ≈ 25 GB (10,000 × 2.5 MB full-size photos).

## 1. The generator

`server/app/jobs/synthetic.py` makes the project the way real data arrives, so an iPad pulls it
with the normal sync (details in its docstring):

```
# on the PC against the Docker dev stack (storage reached from the host)
cd server
S3_ENDPOINT=http://localhost:9000 uv run python -m app.jobs.synthetic --name "TP-3 synthetic"

# on the Droplet (creates a permanent project: projects have no delete yet)
docker compose cp ../fixtures/Level_06M_-_Lighting_Composite_vector.pdf worker:/tmp/06M.pdf
docker compose exec worker python -m app.jobs.synthetic --name "TP-3 synthetic" --sheet /tmp/06M.pdf
```

| Option | Default | |
|---|---|---|
| `--devices` / `--photos` / `--ops` | 2000 / 10000 / 1500 | TP-3's numbers |
| `--levels` | `B2,B1,01,02,03,04,06,06M` | 06M shares 06's numbering group (D33) |
| `--dense-level` / `--dense-share` | `06M` / 0.5 | one level carries half the devices: the worst case for opening a plan |
| `--sheet` / `--no-sheet` | the 06M composite fixture | every level's display sheet is this PDF (one blob) |
| `--seed` | 3 | same project every run |

What it writes: the project and levels (`POST /projects` code, D127); a display sheet per level;
devices with pins spread over the sheet; one cable with two ends per two devices; one punch item
per two devices; 3 missing parts per 20 devices; photos with **distinct 320×240 thumbnails**
(content-addressed blobs would otherwise dedupe them); then 1,500 field edits (status, notes,
punch tracking status) by the three team users with correct `base_op_id`s, pushed untrusted as
iPads would. Full-size photo bytes are **not** generated (`seed_thumbnail_only`, D40): the
25 GB storage figure is arithmetic, and uploading it would cost real R2 money and hours.

Tests: `server/tests/test_synthetic.py` (counts, numbering, distinct thumbnails, edits by three
users, export; chunk boundaries never split a cable from its ends).

## 2. Results on the PC (2026-10-12)

Windows 11 PC, Docker Desktop (Postgres 16, SeaweedFS), API under uvicorn on the host, client =
`app/src/perf/tp3.perf.test.ts` (core store on better-sqlite3, real `SyncEngine`, `HttpTransport`,
`BlobQueue` with 4 parallel downloads) over localhost. Project `TP-3 synthetic 2026-10-12`
(`01a12f33-b0db-7e22-852d-9a592cc5d1c9` in the local dev database).

| What | Size | Time | TP-3 target |
|---|---|---|---|
| Generate (thumbnails + push of all creates + edits) | 16,293 creates, 1,500 edits | 326 s (thumbnails 55 s, applying the creates 264 s) | — |
| First pull into a fresh store | 31,089 ops (creates, server `assign`s, edits) | 7.0 s | — |
| Plan read model of the dense level (`loadLevelPlan`) | 1,000 devices | 29–48 ms | plan open < 3 s (iPad) |
| Side lists of that level (`loadLevelLists`) | 1,000 ends, 500 punch, 143 parts | 16–26 ms | smooth scroll (iPad) |
| Search "Run" on that level (FTS5) | 469 hits | 2 ms | — |
| Prefetch: every in-scope sheet + thumbnail (no assignments, D97) | 10,001 files, ≈ 110 MB | 30.4 s | < 10 min on Wi-Fi (iPad) |
| Workbook export (all tabs, 10,000 pictures) | 34.0 MB; Devices 2,000, Connections 1,994, Punch 1,000, Parts 286, Photo Log 10,000 | 27.8 s | < 5 min |
| TP-5 pre-check of that workbook | | ok | — |

Run it again:

```
cd server && S3_ENDPOINT=http://localhost:9000 AUTH_MODE=token SURVEY_SHARED_TOKEN=tp3 uv run uvicorn app.main:app --port 8011
cd app && FIELD_SURVEY_TP3_URL=http://127.0.0.1:8011 FIELD_SURVEY_TP3_TOKEN=tp3 \
  FIELD_SURVEY_TP3_PROJECT=<project id> npx vitest run src/perf
cd server && S3_ENDPOINT=http://localhost:9000 uv run python -m app.jobs.exports <project id> --out tp3.xlsx
```

### Reading the PC numbers

- **Export:** 28 s on the PC is far inside 5 min. The Droplet has 2 vCPU and 3.8 GiB with swap;
  the job holds the 34 MB workbook and the pictures in memory, so expect a few times slower and
  re-measure there (§3) before calling the target met.
- **Prefetch:** 330 files/s on localhost means the server side is not the limit. On Wi-Fi to the
  Droplet each request costs a round trip (~50–100 ms) plus R2 streamed through the API (D87); with
  4 parallel downloads that is roughly 40–80 files/s, so 10,000 thumbnails in about 2–4 min. The
  iPad run decides; if it misses 10 min, the T12 → T32 follow-up applies (presigned R2 URLs or
  more parallel downloads).
- **Plan and lists:** the read models are well under 0.1 s for 1,000 devices in Node; on the iPad
  expo-sqlite and Hermes are slower and the PDF itself takes 1–2 s to draw (TP-6), so the 3 s
  target is about the sheet plus the pins; the iPad run decides.
- **First pull:** 31,089 ops in 7 s here. On an iPad the first sync of a tower-sized project will
  take noticeably longer (expo-sqlite writes, Wi-Fi). It is a one-time cost per iPad and editing
  is never blocked by it, but it is worth timing (§3).

### Hot spots found

| Where | What | Action |
|---|---|---|
| Server push loop | Applying 16,293 trusted creates took 264 s on the PC, ≈ 16 ms per op. Normal iPad pushes are ≤ 500 ops (≈ 8 s at that rate) and imports are ~1,500 ops, so nothing breaks today, but a seed import or a copied floor at tower size would be slow, and the project lock is held for the whole push | Follow-up task **T76** (profile `Push.run`, batch the per-op queries). *T75 (2026-10-12) already took the first step: 500 device creates in one push went from 5.0 s to 1.6 s on the PC (per-push caches for field heads, duplicates and device numbers; op rows inserted ten per statement) — see T75 in TASKS.md* |
| Local dev database | It was still on migration 0001 (0002/0003 never applied locally), so the first export attempt failed | Upgraded with `alembic upgrade head`; nothing to change in code |

No client hot spot showed on the PC. The iPad numbers may add some (§3).

### On the Droplet (2026-10-14)

Generated on production (D161) with `python -m app.jobs.synthetic --name "TP-3 synthetic" --sheet /tmp/06M.pdf`,
project `01a13851-9b1d-71d9-8444-45acae2867f2`: 8 levels (06M 1,000 devices, the rest 142–143), 2,000 devices,
997 cables / 1,994 ends, 1,000 punch items, 286 parts, 10,000 photos, 16,293 creates + 1,500 edits = 31,089 ops
(`server_seq` up to 31,089 in the project). Checked in Postgres afterwards: 31,089 ops, 2,000 devices, 10,000 photos.

| Step | Droplet | PC |
|---|---|---|
| Thumbnails written to storage (10,001 objects, one PUT each to R2) | 3,284 s (≈ 55 min, ≈ 3 per second) | seconds (MinIO on localhost) |
| Creates + edits applied through `Push` (31,089 ops) | 225 s | 264 s (16,293 creates) |
| Total | 3,521 s | — |

The R2 round trip per thumbnail dominates; it only matters for this generator and for a seed import with
thousands of pictures (T27 writes thumbnails the same way). Not a field-path cost: iPads upload their own
photos in the background. No task filed; revisit if a tower-size seed import is slow.

## 3. On the iPad (2026-10-14)

Run by Landry on the M3 close-out sheet, Part G (steps also in `docs/ON_DEVICE_CHECKLIST.md` under
T32), against "TP-3 synthetic" on the Droplet. Where only pass/fail was recorded, the number is blank.

| What | Target | iPad Air result | Pass? |
|---|---|---|---|
| First sync of the project (Projects → Refresh → open it) | — (record it) | 1 min | — |
| Open 06M (1,000 pins) from the Levels list until pins show | < 3 s | 2 s | pass |
| Scroll the Devices tab of 06M top to bottom, then Conns and Punch; search `Run` | smooth | smooth | pass |
| Sync screen "Download assigned levels" until 10,000 thumbnails are cached | < 10 min on Wi-Fi | under target, time not recorded | pass |
| Export screen: Generate workbook until Ready (server time) | < 5 min | "much longer than 5 min" | **fail** |
| RAM after opening 06M and scrolling (dev build Perf Monitor) | < 600 MB (TP-6 rule) | under target, value not recorded | pass |

**Export (G-4).** Landry: "Took much longer than 5 mins (but that is expected with the huge size of the
document). There is no indication of status for the export. Also leaving the export screen while an
export is running, and then coming back loses my export, and I can no longer see the current export. I
have to restart and it gets stuck in queue because the export that was already running is still going in
the background." The PC took 27.8 s for the same project; the Droplet's R2 round trip per picture (≈ 3 per
second for the generator's PUTs, §2) over 10,000 Photo Log pictures is the first suspect. Follow-ups:
**T93** (stage and counts on the card, re-attach to a running export, one per project and kind) and
**T94** (measure on the Droplet, then bring it under 5 min). The flash-list question (T19 follow-up) is
closed: the plain lists scrolled smoothly at 1,000 rows.
