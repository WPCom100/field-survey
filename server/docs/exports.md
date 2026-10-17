# Excel export: the master workbook (T29)

How the project's records become the master workbook (PLAN §7.6), the job around it (PLAN §8
`/exports`) and the TP-4 round-trip check. Normative: PLAN §7.6 (every format detail),
§2.2 (which columns are generated at export), §8 (routes). Decisions: D16, D17, D25, D32, D33,
D50, D51, D67, D94, D110, D128, D136–D139, D148–D152.

## Files

| File | What |
|---|---|
| `app/jobs/export_xlsx.py` | `load()` reads the materialised tables into rows per tab (sorting, generated columns, pictures with markup flattened); `write()` writes the workbook with XlsxWriter, modelled on `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx`. No job rows. |
| `app/jobs/markup.py` | Flattens a photo's `markup_blob` (stroke list, `packages/core/docs/strokes.md`) onto its JPEG with Pillow; a photo without markup is passed through byte for byte. T59 reuses it. |
| `app/jobs/exports.py` | The `export` row's lifecycle (`create_export`, `build`, `run_export`, `run_queued`), the `diff_summary` against the previous export, the daily export backup and its pruning (`daily_tick`, `prune_backups`, D149, D152), the CLI. |
| `app/api/exports.py` | `POST /exports`, `GET /exports/{id}`, `GET /exports/{id}/file`, `GET /exports?project_id`. |
| `app/worker.py` | Runs queued exports after queued imports every 5 s; `daily_tick` with the backup tick once a minute. |
| `tests/xlsx_diff.py` | TP-4: the cell-by-cell diff of two workbooks, with the documented differences tagged. Also a CLI. |
| `tests/test_export.py` | TP-4 on the master, the routes, the job states, the daily export backup and its pruning, markup, an empty project. |

## Running one

```
POST /exports            Authorization: Bearer <token> · X-Survey-User: <name>
                         {"project_id": "<uuid>", "kind": "xlsx", "params": {"levels": ["B2", "B1"]}}
202 {"id", "project_id", "kind", "params", "job_state": "queued", "blob": null, "filename": null, …}
409 {"detail": {"error": "export_running", "export": {…the queued or running one…}}}   (D166)
GET  /exports/{id}       → job_state ∈ queued · running · done · failed · cancelled; stats; blob;
                           filename; diff_summary; created_by; cancel_requested_at; cancelled_by
POST /exports/{id}/cancel → queued: cancelled at once; running: stops at its next progress report;
                           finished: unchanged (anyone may cancel, D166)
GET  /exports/{id}/file  → the workbook, Content-Disposition with its filename (409 until done)
GET  /blobs/{blob}/content → the same bytes, as any blob (the iPad's download path)
GET  /exports?project_id → history, newest first
```

`params.levels` narrows the export to those level codes; without it every **in-scope** level is
exported. `params.tabs` (D141) narrows the data tabs (`Devices`, `Connections`, `Punch List`,
`Missing Parts`, `Photo Log`, written in that order); Summary and Lists are always written, and a
Summary table is left out with its source tab so no formula names a missing sheet. `kind` is `xlsx` or `floor_pdf` (see Floor PDF below). The worker picks the row up within
5 s. From the server shell:

```
docker compose exec worker python -m app.jobs.exports <project_id> --out /tmp/master.xlsx --user Landry
```

The iPad side (T31) must only offer *Start* while synced with an empty outbox (D94): the export
reads the server's tables, never the local store.

### What the job records

| Field | |
|---|---|
| `export.blob` | SHA-256 of the file; the bytes live at `blobs/<sha>` with a complete `blob` row (MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) |
| `export.stats` | `filename`, `levels`, `rows` per tab, `images`, `images_missing`, `markup_flattened`, `strokes_skipped`, `bytes`, `seconds`, `checks_list`, `previous_export`; on failure `error` (+ `traceback` for a crash) |
| `export.diff_summary` | against the project's previous done xlsx export: per data tab `rows`, `added`, `removed`, `changed` (by Level + ID / #) and up to five `examples`; `null` for the first export |
| `export.job_state` | `queued → running → done`, `failed` or `cancelled` (D137, D166; `failed` rows are retried by `run_export` only on request) |
| `export.stats` while running | `started_at`, `stage`, and for a counted stage `done` / `total` / `unit` (`Photo Log 3,200 / 10,000 pictures`), plus `stage_seconds` of the stages finished; written by `Progress` at each new stage and at most once a second. The finished row keeps `started_at`, `stage_seconds` and adds `finished_at` (T94 measures with them) |
| `export.cancel_requested_at`, `cancelled_by_id` | Cancel (D166); a running job reads them on each progress write |

**One at a time (T93, D166).** At most one queued or running export per project and kind (the
partial unique index `ux_export_active`): a second `POST` is refused with 409 naming the active
one, so the iPad shows that card instead. Stages: workbook `Starting` → `Reading the records` →
`Photo Log` (counted, only with the Photo Log tab) → `Writing the workbook` → `Saving the file`
→ `Comparing with the last export`; floor PDF `Reading the records` → `Devices` (counted) →
`Plan snapshot` → `Photos` (counted) → `Rendering the PDF` → `Saving the file`. A worker restart
(a deploy) puts a `running` export back to `queued` (or `cancelled` when Cancel was pressed) and it
runs again from the start. The daily backup skips a project whose workbook is queued or running
and tries again the next minute.

**Pictures in parallel (T94).** The Photo Log reads its thumbnails (and markup) through
`app.storage.read_ordered`: `READ_WORKERS` (16) reads at once, at most 64 ahead (`ahead`), handed back in
Photo Log order; a picture not in storage is still a `checks` line, any other storage error fails
the export as before, and Cancel drops the reads not started. One R2 GET from the Droplet costs
≈ 0.1 s, so 10,000 pictures one at a time took 18–23 min; 16 at a time is ≈ 70 s
(`docs/perf/tp3.md` §3). The boto3 client keeps `POOL_CONNECTIONS` (32) connections for it.

Filename: `Lighting_Control_Survey_Master_<first>-<last>_<n>.xlsx` — Landry's convention for the
fixture (`…_B2-06_4.xlsx`): first and last level by floor order (`06M` folds into `06`, D33), `n`
the project's count of finished xlsx exports.

### The daily export backup (D149, D152)

`exports.daily_tick()` runs with the backup tick, checked once a day from `BACKUP_HOUR_UTC` and gated
by `BACKUP_ENABLED`. For each project it queues and runs one xlsx export by the `export` system user,
`params = {"scheduled": true, "server_seq": <the project's newest op>}`, unless

- the project has a scheduled export from the last 20 hours (a worker restart never doubles a day), or
- **nothing changed** since its last finished one: same `server_seq` (every edit, import and ID
  assignment is an op) and no picture missing from it (a backup taken while a photo was still
  uploading is taken again). Logged as `export_daily_unchanged`.

The file lands in R2 as any export, so the nightly dump and the weekly bucket copy carry it, and it
shows in the export history. Then `exports.prune_backups()` deletes the files of scheduled exports
older than `EXPORT_BACKUP_RETENTION_DAYS` (183 ≈ six months), **always keeping each project's newest
one** (with skip-unchanged it can be months old and still current) and any file another export row
uses. The row stays in the history with `stats.pruned_at`; `GET /exports/{id}/file` then answers 404
`not_available`. The copy bucket keeps every file it ever received (rclone copy, never sync).
Logs: `export_daily_unchanged`, `export_backup_pruned`, `export_daily_failed`.

## What is written

| Tab | Rows and order | Generated columns |
|---|---|---|
| Summary | title (`project.settings.export_title`, default `ETC Lighting Controls Survey`), `Levels <first>-<last>`, `Surveyed <min> to <max>` of the levels' Surveyed dates, the disclaimer (`settings.disclaimer`, default the master's); four tables with `SUMPRODUCT` formulas over rows 4–2000 (or to the last data row when longer) **with the computed counts as cached values**, so Excel shows numbers before it recalculates; a stacked column chart per table right of it (none for a table without rows) | Surveyed / Updated as ISO **text** (T02 follow-up) |
| Devices | by floor order, then ID (`06M-01` < `06M-S1` < `06M-D1`, numeric) | Status empty → `Unsurveyed` (D110); **Photo** = numbers of the photos whose `device_id` or `photo_link` is the device, ascending, `, `-joined, stored as text; Floor Order |
| Connections | one row per numbered `cable_end` on the exported levels, by floor then `C-nn` | From/To verbatim (D32); Cable and Qty from the cable; Status empty → `Unsurveyed` (D138) |
| Punch List | by floor, then (`sort_last`, #) | **Device** derived from the linked device (D148, D151: `PI1002 S3 - Corridor …` for stations, sensors and other field devices, `UFMP4 - <room>` for a Foundry panel without a panel name, `CTB2LCPB` for a named panel, `EBDK (CTB2LCPB)`, the model alone for a rack or NSPS), so a rename shows with no punch op; an item linked to no device writes the master's `device_text` (D150: the room, `All devices`); **Photo** from `punch_item_id` + links; Date closed as a date cell `yyyy-mm-dd` |
| Missing Parts | by floor, then # | **Source** from `part_source`: `Punch #8-14, #19; Devices 06-S3; Connections C-06` (runs of ≥ 3 collapse) |
| Photo Log | by floor, then Photo | **Device ID** = the photo's device, then its linked devices (D128); the picture in H at its pixel size (320×240 for seed and T21 thumbnails), markup flattened, row height `px × 0.75 + 6` |
| Lists | the four fixed lists | |

Format, as the master: Arial 10, wrap, top-aligned, thin borders; headers bold white on `#1F3864`,
30 pt; titles Arial 14 bold merged `A:B`; Tables `Devices` · `Connections` · `PunchList` ·
`MissingParts` · `PhotoLog` in `TableStyleLight1` without stripes, autofilter; freeze panes C4;
list validation on the status columns (no error pop-up, like the master) and conditional fills per
status; `#FFF2CC` on the EC/ETC columns (Punch List G–J, Missing Parts I–J); landscape, one page
wide, row 3 repeated. Row heights are estimated from the text (16.5 pt per line, Arial 10 ≈ 1.15
characters per width unit); the master's heights match on ≥ 97 % of rows.

Soft-deleted records, levels and links are left out. A device without an ID yet (`NEW`, D93)
would export with an empty ID; D94 keeps that from happening (export only when synced).

## TP-4: the round trip

`tests/test_export.py::test_tp4_master_round_trip` imports the master (T27), exports it, and runs
`tests/xlsx_diff.py` over the two files: every cell value and style of every tab, widths, freeze
panes, Tables, validations, conditional formats, merged ranges, page setup, charts (type, series
refs and colours, anchor, size) and pictures (anchor, size, media SHA-256). The result must be
**empty except these documented differences**:

| Reason | Cells | What |
|---|---|---|
| D51 | 1 tab | no Change Log tab |
| D50 | 7 | the four Unison bus spellings in Connections!From read `Stations & Sensors` |
| photo list spacing | 2 | Devices!Photo `1,5` / `12,13` → `1, 5` / `12, 13` |
| device ID range | 1 | Photo Log!Device ID `01-S8 to 01-S12` → the five IDs |
| Source parenthetical | 3 | `Connections C-06 (fiber to Level 01)` → `Connections C-06` |
| allow (master quirk) | 1 | Devices!Photo of 03-01 names photo 2, whose Photo Log row names 03-02 only; the import links the photo to 03-02 |
| allow (master quirk) | 1 | Connections!Qty of B1 C-05: the master set Qty on B2 C-06 and left this end blank; Qty is the cable's |
| D110 / D138 | 0 on the master | an empty status → `Unsurveyed` |
| D148 | 87 | Punch List!Device of a linked item is derived from its device, not the master's spelling (below) |

The 87 D148 cells, by kind: the device's Room / Location is fuller than the master's shorthand
(`PI1002 S3 - Corridor XXB1-C005, north` for `… XXB1-C005 north`, `UFMP4 - BH OBS RM 47 WT01-2027`
for `UFMP4 - BH OBS RM 47`, a room the master left off or shortened); the rack and NSPS are named by
their model (`Equipment Rack 18U` for `Equipment rack`, `P-NSPS-D-KIT` for `P-NSPS-D`); `UFMP4 #1` /
`#2` read `UFMP4 - <room>`; level 06's `PI1002 #2 – …` reads `PI1002 S2 - …`. Renaming a device on
the iPad changes these rows; no punch op is needed. The 13 rows the import could not link to one
device (a room, `Stations & sensors`, `S8-S12`, several devices) wait on Needs review and export
the master's text until linked (D150); the eight Neuron ID rows (`All devices`) are not raised.

Row heights are reported, not failed (≤ 3 % of rows differ), on rows whose values match (a row
whose text differs, as D148's do, wraps differently by design). Run it by hand:

```
uv run python tests/xlsx_diff.py ../fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx export.xlsx
```

## Floor PDF (T59)

`app/jobs/floor_pdf.py` (+ `floor_pdf.css`) builds one level's report, PLAN §7.7, D56, D66,
D120, D143. Ask for it like a workbook:

```
POST /exports {"project_id": "<uuid>", "kind": "floor_pdf",
               "params": {"level": "06M", "sections": ["plan", "findings", "punch"]}}
```

`params.level` (one level code) is required; `params.sections` narrows the report to some of
`plan` · `findings` · `connections` · `punch` · `parts` · `photos` (default all). The file is a
blob like the workbook (MIME `application/pdf`), downloadable through `GET /exports/{id}/file`;
filename `ETC_Lighting_Controls_Survey_Level_<code>_<n>.pdf` with `n` that level's finished
floor PDFs. No `diff_summary`. `stats.rows` counts devices, findings, connections, punch items,
parts and photos; `stats.checks_list` names anything left out (a sheet or picture not in storage,
strokes not drawn).

| Part | What |
|---|---|
| Header | every page but the cover: `ETC Lighting Controls Survey — Level 06M · Surveyed 2026-10-08` — the survey date only, never a company or project name (R7); page n of m bottom right |
| Cover | the title, `Surveyed <date>`, the status counts (five statuses + Unsurveyed + total) and the plan snapshot: the display sheet rasterised with pdfium in sheet coordinates, **every user's ink layer** drawn over it with the `strokes.md` rules (`markup.draw_strokes`), then every pinned device — shape = category, fill = status, glyph inside (D64, `pins.ts`), labelled with the device **type** (Type, else Device, else category, 22 characters — `pinLabel`, D120) |
| Findings | devices whose status is not `Installed, untested` (Unsurveyed included), by ID; each a block that never splits: ● status colour, `ID — Device`, `Status \| Owner \| Category` (owners of open punch items and parts), Room / Location, Type, Notes, open punch items, up to four thumbnails, and a 300 × 200 pt crop of the plan around its pin with the neighbours drawn and the device ringed. Four per Letter page in practice |
| Connections · Punch list · Missing parts | tables with the workbook's rows for this level (the same generated texts: From/To verbatim, Device text, Source); the punch list by (`sort_last`, #) |
| Photos | the level's photos by number in a 2 × 3 grid (two columns, three rows per page), the full JPEG when the server has it, else the thumbnail, markup flattened, scaled to ≤ 1,100 px; caption `Photo n — <Subject> — <Device IDs>` |

**Pictures in parallel (T98).** Like the Photo Log, the findings' thumbnails (in device order) and
the Photos section's pictures (full JPEG else thumbnail, plus markup, by number) are read through
`app.storage.read_ordered`, 16 at a time. The photos keep at most `PHOTOS_AHEAD` (25) read and not
yet drawn, so ≈ 2.5 MB full-size pictures hold ≤ 64 MB at once on the 2 GB Droplet; markup is
flattened and the picture shrunk one at a time as before. A picture not in storage is still left
out, any other storage error fails the export, Cancel drops the reads not started. 06M of
"TP-3 synthetic" (1,000 devices, 5,000 photos, 3,140 thumbnails — 8,141 reads) with 0.11 s added to
every read: load 59 s + render 35 s against ≈ 15 min one at a time (`docs/perf/tp3.md` §3).

Sections follow one another without forced page breaks (D66); only the cover ends its page.
Rendering is WeasyPrint, which needs Pango: the server image installs `libpango-1.0-0`,
`libpangoft2-1.0-0`, `libharfbuzz-subset0`, and so does CI. On a Windows host WeasyPrint does not
load, so the rendering test skips there with the reason; run it in the image:

```
docker compose build api
MSYS_NO_PATHCONV=1 docker run --rm --network server_default -v "<repo>:/repo" -w /repo/server \
  -e UV_PROJECT_ENVIRONMENT=/tmp/venv -e DATABASE_URL=postgresql+psycopg://survey:change-me@postgres:5432/survey \
  server-api sh -c "uv sync --frozen -q && uv run --frozen pytest -q tests/test_floor_pdf.py"
```

Speed: level 01 of the TP-3 project (143 devices, 113 findings, 715 photos → 151 pages, 6.3 MB)
in 36 s in the image on the PC.

## TP-5: Excel opens it (T30)

`docs/test/tp5.md` is the manual checklist (Excel Online, Excel for Windows, Excel for Mac when a
Mac is available, D72) and records the file under test. `tests/tp5_precheck.py` is its automated
part: it looks for the package mistakes that make Excel offer a repair (untyped or broken parts,
table headers that differ from their cells, overlapping tables or merges, bad names, style
indexes out of range, over-long strings or formulas, impossible row heights or widths, chart
series on missing sheets). The TP-4 test runs it on every export; run it by hand on any file:

```
uv run python tests/tp5_precheck.py export.xlsx
TP5_OUT=../docs/test/tp5/tp5_export.xlsx uv run pytest -q -k tp4   # remake the TP-5 file
```
