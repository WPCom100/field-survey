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
  → blob: the display PDF rewritten with the boundary OCG off (D100), or the source PDF as is
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

**Rooms**: words matching `ROOM_CODE_RE` (`XX06M-1E05`) with the name printed above them in the
same font (one or two lines), title-cased (`Elevator Machine Room`; `IDF`, `C16`, `(FSAE)` stay).
**Tags**: words matching a `TAG_RES` pattern (`CT06LCPA`, `EBDK`, `UFMP8`, `ERP`, `NSPS`,
`P-ACP`…) at font size ≥ 4 pt (rack elevations print hairline text) — T46's pre-placement
proposals read these. **Bubbles**: ringed labels no set claimed (detail callouts) — what the
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
  "tags": [{"text": "CT06LCPA", "x": 2360.1, "y": 1354.9, "size": 12.0}],
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
