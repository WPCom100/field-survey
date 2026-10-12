# Excel export: the master workbook (T29)

How the project's records become the master workbook (PLAN §7.6), the job around it (PLAN §8
`/exports`) and the TP-4 round-trip check. Normative: PLAN §7.6 (every format detail),
§2.2 (which columns are generated at export), §8 (routes). Decisions: D16, D17, D25, D32, D33,
D50, D51, D67, D94, D110, D128, D136–D139.

## Files

| File | What |
|---|---|
| `app/jobs/export_xlsx.py` | `load()` reads the materialised tables into rows per tab (sorting, generated columns, pictures with markup flattened); `write()` writes the workbook with XlsxWriter, modelled on `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx`. No job rows. |
| `app/jobs/markup.py` | Flattens a photo's `markup_blob` (stroke list, `packages/core/docs/strokes.md`) onto its JPEG with Pillow; a photo without markup is passed through byte for byte. T59 reuses it. |
| `app/jobs/exports.py` | The `export` row's lifecycle (`create_export`, `build`, `run_export`, `run_queued`), the `diff_summary` against the previous export, the weekly master export (`weekly_tick`, D67), the CLI. |
| `app/api/exports.py` | `POST /exports`, `GET /exports/{id}`, `GET /exports/{id}/file`, `GET /exports?project_id`. |
| `app/worker.py` | Runs queued exports after queued imports every 5 s; `weekly_tick` with the backup tick once a minute. |
| `tests/xlsx_diff.py` | TP-4: the cell-by-cell diff of two workbooks, with the documented differences tagged. Also a CLI. |
| `tests/test_export.py` | TP-4 on the master, the routes, the job states, the weekly export, markup, an empty project. |

## Running one

```
POST /exports            Authorization: Bearer <token> · X-Survey-User: <name>
                         {"project_id": "<uuid>", "kind": "xlsx", "params": {"levels": ["B2", "B1"]}}
202 {"id", "project_id", "kind", "params", "job_state": "queued", "blob": null, "filename": null, …}
GET  /exports/{id}       → job_state ∈ queued · running · done · failed; stats; blob; filename; diff_summary
GET  /exports/{id}/file  → the workbook, Content-Disposition with its filename (409 until done)
GET  /blobs/{blob}/content → the same bytes, as any blob (the iPad's download path)
GET  /exports?project_id → history, newest first
```

`params.levels` narrows the export to those level codes; without it every **in-scope** level is
exported. `params.tabs` (D141) narrows the data tabs (`Devices`, `Connections`, `Punch List`,
`Missing Parts`, `Photo Log`, written in that order); Summary and Lists are always written, and a
Summary table is left out with its source tab so no formula names a missing sheet. `kind` is `xlsx` only until T59 adds `floor_pdf`. The worker picks the row up within
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
| `export.job_state` | `queued → running → done` or `failed` (D137; `failed` rows are retried by `run_export` only on request) |

Filename: `Lighting_Control_Survey_Master_<first>-<last>_<n>.xlsx` — Landry's convention for the
fixture (`…_B2-06_4.xlsx`): first and last level by floor order (`06M` folds into `06`, D33), `n`
the project's count of finished xlsx exports.

### The weekly export (D67)

`exports.weekly_tick()` runs with the backup tick: on `EXPORT_WEEKLY_WEEKDAY` (ISO, default 7 =
Sunday) from `BACKUP_HOUR_UTC`, gated by `BACKUP_ENABLED`, it queues and runs one xlsx export per
project that has none by the `export` system user in the last six days (`params.scheduled: true`).
The file lands in R2 as any export, so the nightly dump + weekly bucket copy carry it.

## What is written

| Tab | Rows and order | Generated columns |
|---|---|---|
| Summary | title (`project.settings.export_title`, default `ETC Lighting Controls Survey`), `Levels <first>-<last>`, `Surveyed <min> to <max>` of the levels' Surveyed dates, the disclaimer (`settings.disclaimer`, default the master's); four tables with `SUMPRODUCT` formulas over rows 4–2000 (or to the last data row when longer) **with the computed counts as cached values**, so Excel shows numbers before it recalculates; a stacked column chart per table right of it (none for a table without rows) | Surveyed / Updated as ISO **text** (T02 follow-up) |
| Devices | by floor order, then ID (`06M-01` < `06M-S1` < `06M-D1`, numeric) | Status empty → `Unsurveyed` (D110); **Photo** = numbers of the photos whose `device_id` or `photo_link` is the device, ascending, `, `-joined, stored as text; Floor Order |
| Connections | one row per numbered `cable_end` on the exported levels, by floor then `C-nn` | From/To verbatim (D32); Cable and Qty from the cable; Status empty → `Unsurveyed` (D138) |
| Punch List | by floor, then (`sort_last`, #) | **Device** = `device_text` (D136), else from the linked device (`PI1002 S3 - Corridor …` / `CTB2LCPB`); **Photo** from `punch_item_id` + links; Date closed as a date cell `yyyy-mm-dd` |
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

Row heights are reported, not failed (≤ 3 % of rows differ). Run it by hand:

```
uv run python tests/xlsx_diff.py ../fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx export.xlsx
```

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
