# Plan sheets and grid calibration (T45, PLAN §7.4, D7, D29, D47, D100, D147)

How a level's floor plan gets onto every iPad with its grid calibrated, and what the stored data
looks like. Code: `app/jobs/plan_analysis.py` (the text pass, pure), `app/jobs/plans.py` (the
job), `app/api/imports.py` (`kind=plans`). Client twin: `packages/core/src/grid.ts`
(`packages/core/docs/grid.md`).

## Flow

```
iPad: Setup ▸ 3 Sources ▸ Floor plans ▸ Choose… (a PDF from Files)
  → POST /imports  multipart: project_id, kind=plans, level_id, sheet_kind=display|source, file
  → import_batch(kind="plans", job_state="queued"); the PDF is kept at imports/<batch>/<name>
worker: plans.run_queued() → runner.run_batch(job=plans.import_sheets)
  → plan_analysis.analyse_sheet() per page
  → blob: the display PDF rewritten with the boundary OCG off (D100), or the source PDF as is;
       a display sheet over 400,000 page objects: its raster, the vector PDF kept beside it (T141)
  → ops through Push (trusted, the requesting user, change type Master edit, reason "Plan sheet upload"):
       create sheet {level_id, kind, blob, page, title, width_pt, height_pt, grid_sets, features}
       display only: set level.display_sheet_id (base_op_id = the field head), delete the old display sheet
  → batch done with stats; GET /imports/{id} is what the iPad polls
iPad: the next pull materialises the sheet; the blob queue prefetches display sheets (D87/D97);
      the plan opens with pins, boundaries (Layers ▸ Boundaries) and the ⌗ Grid panel
```

One batch is one PDF. **Display**: the first page only; the previous display sheet is soft-deleted
(pins placed on it keep its id and show as "elsewhere" until moved — a follow-up carries them over).
**Source**: one `sheet` per page, all on the same blob, text pass only. The same file (SHA-256) for
the same level and kind is `skipped`. Everything is one transaction; a failure records the error
on the batch and leaves the project untouched. CLI: `python -m app.jobs.plans <project> <level>
<pdf> [--kind display|source] [--user NAME]`.

**Re-reading the tags** (T140): `python -m app.jobs.plans retag <project> [--user NAME]` runs the
tag pass again over every live sheet of the project from its stored PDF, with the project's
patterns and library as they are now — after the tag pass or the library changes, since the same
file is never uploaded twice and a replaced display sheet leaves its pins behind (until T77). A
sheet whose tags changed gets one `set` of `features` (change type Master edit, reason "Plan sheet
tags re-read") with only `tags` replaced; the rest of `features`, the grid sets and the pins stay.
It prints what changed per sheet (`before` / `after` tag counts); a second run changes nothing.
On the Droplet: `docker compose exec -T worker python -m app.jobs.plans retag <project_id>`
(minutes per composite: the pass reads every word of the page).

## Rasterised display sheets (T141, D233, D242)

PDFKit walks every object of a vector page for each tile it draws, at every zoom: the Level 03
composite (2.0 million page objects, 12.8 × the 06M sheet that passed TP-6) loads slowly and lags
while panning. So a **display** sheet whose page draws more than `RASTER_MIN_OBJECTS` = 400,000
page objects (paths, text runs, images, shadings, form contents — `plan_raster.page_objects`) is
stored as a **raster**: `plan_raster.rasterise` renders the OCG-off display PDF with pdfium at
`RASTER_DPI` = 200 (lowered so the image stays within `RASTER_MAX_PIXELS` = 250 MP: Level 02 at
159 dpi) in bands of 2,048 rows, cuts 512-px JPEG tiles (quality 75, each with one pixel of its
right and bottom neighbours so no seam shows), and writes a one-page PDF of those image XObjects
whose MediaBox and CropBox are the vector page's CropBox and whose /Rotate is the same. The sheet's
size, sheet coordinates, pins, ink and grid sets are therefore unchanged, and the viewer stays
PDFKit. Measurements: `docs/perf/t141.md` (03: 24 MB, made in ~13 s on the PC, ~1 GB peak; pdfium
draws it at fit in 0.5 s against 7.4 s for the vector page).

- `sheet.blob` is the raster — what the iPads download and open. The vector PDF is stored too, as
  `features.raster = {"vector_blob": <sha>, "dpi": 200.0, "objects": 1999744}`;
  `plan_raster.vector_blob(sheet.blob, sheet.features)` is how the server reads the vector page:
  `retag` and the floor PDF's plan snapshot and crops do. The text pass of an upload runs on the
  vector PDF before any raster is made. Source sheets are never rasterised.
- The batch stats carry, per sheet, `objects` and `raster` (`dpi`, `px`, `tiles`, `bytes`,
  `vector_bytes`, or `null` for a vector sheet); a PDF pdfium cannot render keeps its vector sheet
  with `raster_error`.
- **Sheets stored before T141**: `python -m app.jobs.plans rasterise <project> [--user NAME]` does
  the same for every live display sheet of the project not yet rasterised: one `set` of `blob` and
  one of `features` (`raster` added; change type Master edit, reason "Plan sheet rasterised"), so
  the iPads pull the change and prefetch the new sheet (until it is down, the plan offers "⤓
  Download plan now"). Pins stay where they are. A second run changes nothing; a sheet under the
  threshold is listed as `kept` with its count. On the Droplet: `docker compose exec -T worker
  python -m app.jobs.plans rasterise <project_id>`.

## The text pass (`plan_analysis.analyse_sheet`)

Vector sheets only (A11): pdfplumber words with font size and position, pdfplumber curves /
lines / rects for the bubble rings, pypdf for the content stream and the rewrite.

**Memory (T124, D226).** One pdfminer pass reads the page (`_read_page`): characters go into
pdfplumber's layout as usual, but every painted path is handed to `Rings` as it is painted and
then dropped (`_PathSink`), keeping only a circle's box or a short segment's midpoint. Before,
pdfplumber kept a dict per curve, line and rect: the 14 MB `Level 02 Concourse - Composite
(vector).pdf` (143,000 characters, 1.33 million lines) took 4.9 GB on the PC and ran the Droplet's
worker out of memory on 2026-10-19. Now it peaks at 600 MB (06M: 600 → 94 MB) with byte-identical
output; most of what is left is the characters. A page drawing more than `MAX_CHARS` = 500,000
characters fails the batch with "the sheet draws more than … characters" (`SheetTooLarge`), and the
worker container has a 2 GB cap (`docker-compose.prod.yml`), so a sheet that still outgrows it
kills the worker alone; the batch then fails on its second try (`imports.md`). Coordinates are
**sheet** coordinates (CropBox top-left origin, y down, PDF points — `app/src/plan/viewport.ts`).
The composite overlays its source sheets, so text is often printed twice a point apart; words are
deduplicated by (text, position within 1.5 pt).

**Grid bubbles.** A candidate label is a word matching `LABEL_RE`: one letter (`A`), a doubled
letter (`AA`), a letter with a fraction (`G.9`), a one- or two-digit number with an optional
fraction (`9`, `13.5`), each optionally followed by the dotted Walter Tower style `.` (`C.`,
`6.`). Two different letters (`OF`, `TO`) are words in notes, never bubbles. A bubble must sit in a
**ring**: a circle-like curve 8–60 pt across, or at least three short line/rect segments within
22 pt (the Walter Tower rings are polygons of lines). Candidates form **families** by (kind
letters/numbers, style plain/dotted, font size).

Per family, **grid-line directions** come from pairs of bubbles with the same label (a column
letter is printed at the top and bottom edge, a row number at the left and right), clustered at
4°. For each direction, bubbles of one label that agree on a line (within 6 pt) form a label with
a mean position along the line normal; the labels are sorted by position and the **longest run in
natural order** (A < B < … < Z < AA; 9 < 9.5 < 13.5, ascending or descending) is one axis — a
stray circled detail number breaks the order and falls out; what is left may hold a second tower's
own A…H. An axis needs `MIN_LABELS` = 3 labels and a median spacing ≥ 40 pt (smaller is a key plan).
Labels printed once (one edge only) are adopted afterwards when they sit on one of the axis's
edges, in order, and are ringed like the rest.

**Sets** (D47) pair a lettered axis with a numbered one of the same style and size, with normals
within 60° of perpendicular, each axis spanning at least half the other's bubbles (plus 1.5
spacings); best score first, each axis used once. Columns count eastward (+x), rows southward
(+y): the master's "Grid B-C / 9-8" lists columns west → east and rows north → south (numbers
grow northward on these plans). The **residual** is the RMS distance of every bubble from its
label's line; `auto` below `AUTO_RESIDUAL_PT` = 2, else `none` until the iPad calibrates it by
hand (`manual`). On the 06M composite: `A–H / 13.5–5` (Centennial, 0.18 pt), `A.–F. / 15.–5.`
(Walter Tower, 0.00 pt) and `R.–K. / 16.–13. (+22°)` (a wing rotated 22°, 0.03 pt).

**Patterns** (T79, D240): what counts as a room code or a tag is the project's vocabulary —
`vocab(room_code_pattern)` and `vocab(tag_pattern)`, one regular expression per row (Python `re`),
each matched against a whole word (`re.fullmatch`). Drafts count, rejected rows do not; a list with
no rows reads as the Tower's built-in patterns (`DEFAULT_ROOM_CODE_PATTERNS`,
`DEFAULT_TAG_PATTERNS`, which "Load standard" on the iPad seeds as the same strings). A pattern
that does not compile is skipped and listed in the batch's stats (`bad_patterns`, beside
`patterns: {list: project | default}`); the iPad's job line names it.
**Rooms**: words matching a room-code pattern (`XX06M-1E05`) with the name printed above them in
the same font (one or two lines), title-cased (`Elevator Machine Room`; `IDF`, `C16`, `(FSAE)`
stay). **Tags** — what T46's pre-placement proposals read (`app/src/placement/model.ts`
`tagProposals`): words matching a tag pattern (`CT06LCPA`, `EBDK`, `UFMP8`, `ERP`, `NSPS`,
`P-ACP`…) and, since T140 (D234, D241), every word that is a **model or alias of a library type**
— the project's live types and the app library's, rejected ones not (`plans.library_names` →
`plan_analysis.name_keys`): `PI1104`, `P-LS`, `UFMP4`, `ERP24-FT241P`. A variant alias cut short
counts too: the catalogue has `P-DOC-C-LR-X` as an alias of `P-DOC-C`, the drawings print
`P-DOC-C-LR`. Names under 4 characters (`NET`, `UPS`, `TBD`) are ordinary words on a sheet and are
not kept. Then:
- **joined**: fragments of one word that touch (the 03 composite draws `P-DOC` as `P` `-D` `O`
  `C`), and a type printed over two lines when the two, run together with or without a `-`, are a
  library name (`P-DOC` / `C-LR` → `P-DOC-C-LR`, `ERP24-FT` / `241P` → `ERP24-FT241P`);
- **left out**: text under 4 pt (legend symbols at 1–2.3 pt, rack elevations' hairline text — the
  labels beside devices are 5.5 pt on the 06M, 02 and 03 composites), a word in a sentence of a
  note (a plain word of the same size on its line within 0.8 em: `… SYSTEM EBDK LOCATION IN …`)
  and a **legend table's device column** (3+ words of one size centred on one x, rows ≤ 4.5 em
  apart, two kept words in it — or any column under a `Description` header). The composites repeat
  each source sheet's legend; a legend word is never a device on the plan. **Bubbles**: ringed labels no set claimed (detail callouts) — what the
manual calibration snaps a tap to.

**Boundaries** (D100): the page's optional-content groups whose name contains "boundar" (or the
only group). The content stream is walked with the CTM; path operators inside `/OC /name BDC … EMC`
become segments, chained end to end and straightened (Douglas–Peucker, 10 pt — the composite traces
each source sheet's outline in 8-pt steps); text inside the group (`Ef.106.5.A`) becomes
`boundary_labels`. `write_display_pdf` clones the file and moves those groups from `/D /ON` to
`/D /OFF`; pdfium (and PDFKit) honour the default configuration, so the magenta is gone from the
display sheet and Skia draws the lines instead (`app/src/plan/drawLayers.ts`).

## Stored JSON

`sheet.grid_sets` — a list:

```json
{
  "name": "A–H / 13.5–5",            // editable; "(+22°)" appended when rotated
  "prefix": "",                       // leads Drawing Position: "WT" → "WT Grid …" (D47)
  "mode": "auto",                     // auto | manual | none
  "residual": 0.18, "max_residual": 0.96, "angle": 0.0,
  "affine": {"a": 1, "c": 0, "tx": 0, "b": 0, "d": 1, "ty": 0},   // sheet → (s, t), viewport.ts column convention
  "col_labels": [{"label": "A", "pos": 653.8}, …],                // sorted west → east, pos = s (pt)
  "row_labels": [{"label": "13.5", "pos": 676.5}, …],             // sorted north → south, pos = t (pt)
  "bubbles": [{"label": "A", "axis": "col", "x": 653.8, "y": 416.5}, …]
}
```

`sheet.features` (D147):

```json
{
  "rooms": [{"code": "XX06M-2SV01", "name": "Stair A Vestibule", "x": 1299.6, "y": 790.8}],
  "tags": [{"text": "CT06LCPA", "x": 1650.0, "y": 1459.2, "size": 6.0},
           {"text": "P-DOC-C-LR", "x": 3045.9, "y": 1306.6, "size": 5.5}],
  "bubbles": [{"text": "22", "x": 1671.6, "y": 1931.3}],
  "boundaries": [{"points": [[1596, 186], [2732, 186], …]}],
  "boundary_labels": [{"text": "Ef.106.5.A", "x": 1090.8, "y": 1108.3}]
}
```

## Drawing Position (`drawing_position`, twin of `grid.ts`)

For a sheet point, the set whose grid (plus 1.5 spacings) holds it — where two overlap, the one
the point sits deeper in; else the nearest within two more spacings; else nothing. On each axis:
within 8 % of the local spacing of a line → that label (`E`); between two → `B-C`; before the
first → `West of A` / `North of 13.5`; beyond the last → `East of H` / `South of 5`. Text:
`<prefix> Grid <cols> / <rows>` — `Grid B-C / 9-8`, `Grid E / 7.5`, `Grid East of H / 9-8`,
`WT Grid C.-D. / 6.-5.` (labels verbatim). An editable default: the iPad fills it when a device
is added at a long-press and keeps it following a moved pin until someone types their own.

## Tests

`tests/test_plans.py`: the 06M composite (skipped with a reason when the fixture is missing) —
three auto sets under 2 pt with their labels and frames, the wording cases above, rooms / tags /
loose bubbles, boundaries + the OCG-off display PDF (pdfium renders no magenta pixels), the job
(display sheet → blob + sheet create + level set, idempotent by file, replacement soft-deletes the
old sheet, a source PDF → one sheet per page), refused uploads, the `/imports` route.
`tests/test_plan_tags.py` (T140): `name_keys`, the joins and what is left out on made-up words;
the 06M, Level 02 and Level 03 composites with the catalogue's rows for what they print (each
skipped when its fixture is missing; the 02 and 03 composites are ~15 MB each and read for about
three minutes together); the job passing the project's and the app library's names; `retag`.
`tests/test_plan_raster.py` (T141): the raster keeps the CropBox, MediaBox and /Rotate and draws a
square where the vector page does (rotated or not), images only; no seams between tiles at
fractional zooms; the pixel cap; page objects inside forms; the job storing a heavy sheet as a
raster with the vector beside it (and a light one as before); `rasterise` on stored sheets, a
second run, and `retag` reading the vector; 06M stays vector and 03 is rasterised on its CropBox
(each skipped when its fixture is missing).
