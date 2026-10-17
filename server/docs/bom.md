# BOM extraction: BOM PDF → device drafts (T42)

How a BOM becomes `draft_device` proposals for the per-level review (PLAN §7.1–7.2). Normative
references: PLAN §7.2 (BOM), §2.2 (`draft_device`), §3.1–3.2 (ops and the apply loop).
Decisions: D5, D9, D10, D11, D12, D21, D27, D28, D187, D188.

## Files

| File | What |
|---|---|
| `app/ocr.py` | Tesseract for pages with no text layer: render at 300 dpi (`pypdfium2`), cut the page into panels at full-height separator rules, `tesseract --psm 6 … tsv` per panel through `subprocess`, words back in PDF points. `available()` / `tesseract_path()` (`TESSERACT_CMD`, PATH, the Windows default). |
| `app/jobs/bom_extract.py` | Pure functions: words (text layer or OCR) → tables by header words → column bands → `Line`s → `build()` → drafts, accessories, racks, excluded lines. No database. |
| `app/jobs/bom.py` | The job: `create_bom_batch` (PDF → object store, batch queued), `target_of` (the project's levels, `vocab(model_map)` / `vocab(level_alias)`, device-type library), `import_bom` (one transaction: drafts as `create` ops through `Push`), `run_queued`, CLI. |
| `app/api/imports.py` | `POST /imports` with `kind=bom` (multipart `project_id`, `file`); `GET /imports/{id}` for `job_state` and `stats`. |
| `app/worker.py` | Polls queued BOM batches with the other jobs. |
| `tests/test_bom.py` | `fixtures/BOM.pdf` end to end (text pages, p.3 by OCR, drafts, the job, the route); `fixtures/15090056-BOM.pdf` (Material List, format only — D4). |

## Running one

```
POST /imports            Authorization: Bearer <token> · X-Survey-User: <name>
multipart: project_id=<uuid> · kind=bom · file=<.pdf>
202 { "id", "kind": "bom", "files": [{name, sha256, size, pages}], "job_state": "queued", … }
GET  /imports/{id}       → job_state ∈ queued · running · done · skipped · failed, stats
```

From the server shell:

```
docker compose exec api python -m app.jobs.bom <project_id> /path/to/BOM.pdf --user Landry
```

The project must exist with its levels (`POST /projects`, T41); a BOM floor the project lacks
still yields drafts, unlevelled (below). The same file (SHA-256) for the same project is
`skipped` the second time.

**Tesseract.** The image (`Dockerfile`) and CI install `tesseract-ocr`; on the Windows PC the
UB-Mannheim build at `C:\Program Files\Tesseract-OCR` (or `TESSERACT_CMD`). A page whose table
has no text layer on a server without it fails the batch with `page N has no text layer … install
tesseract-ocr`; nothing is written. The tests that need it skip with that reason.

## What the job reads

Two formats (Phase 1f, Phase 1 §4):

| Format | Rows | Venue | Where seen |
|---|---|---|---|
| Submittal BOM (ETC `BOM-n` drawings) | `Line Item · Part Number · Part Description · Model · Quantity (value)`; one or two tables per page; `VENUE` rows group the lines that follow (across a page break) | `Level 1`, `FLOOR 3`, `Floor B2` → one floor; `Level B2 - 12`, `Level 16, 22`, `Link to P-CCS in other building` → pooled | `fixtures/BOM.pdf`: pp.1, 2, 4–6 text layer (pp.4–6 print two title blocks — `dedupe_chars`), p.3 image-only (two columns, OCR) |
| Material List (ETC order form, scanned) | `Item · Material · Quantity`; an item is two or three rows (`part · qty EA`, `Model: …`, description); `Line 270 delivers for line 260` marks a sub-item | none → project pool | `fixtures/15090056-BOM.pdf` (all four pages OCR) |

Column bands come from each table's header words, so text and OCR words go through one row
parser. Every line keeps `source_ref = {kind: bom_line, file, job, page, line, bbox, venue,
level_code}` (bbox in PDF points, top-left origin) and `extraction` (`text` | `ocr`).

OCR fixes (`fix_ocr_model`): `P11002` → `PI1002` (Phase 1f's one systematic misread) and a
letter `O` for a digit inside a `P-…` model.

## What the job writes

Only `draft_device` rows, as trusted `create` ops by the user who uploaded the file
(`change_type` `Master edit`, reason `BOM extraction: <file>`), `state = proposed`:

| Column | From |
|---|---|
| `model`, `model_raw`, `candidates` | the Model column, normalised (below); `candidates` only when there is more than one |
| `role`, `category` | T115 (D201): the project's device-type library (`library_type.model` / `aliases`, project rows then the app library's, D183 (4)) — the type's `role`, else the role its category names, else the model's; `category` = the type's, canonicalised to the D196 spelling — else the built-in `MODEL_ROLE` table (`ERP…` relay_panel, `UFMP…` foundry_panel, `EBDK` ebdk, `P-NSPS…` nsps, `P-TS…` / `P-LCD…` / `ETS-…` touchscreen, `PI1234` / `EPS05` station, `P-DOC…` / `P-LS` / `UHCI…` sensor) with the role's category (`roles.ROLE_CATEGORY`: Power Distribution, Emergency Equipment, Equipment, Equipment Panels for a rack, Touchscreen, Station, Sensor). A rack venue's draft is `equipment_rack` / `Equipment Panels`. |
| `qty` | the Quantity column |
| `accessories[]` | `{model, model_raw, qty, role: accessory \| component, description, source_ref, extraction, confidence}` |
| `level_id`, `level_basis` | `venue` (one floor the project has), `pooled_venue` (null, D10), `level_not_in_project` (null, the floor code kept in `source_ref.level_code`), `project_pool` (Material List) |
| `confidence` | 0.95 from the text layer; tesseract's mean word confidence (≤ 0.9) from OCR; halved for a pooled venue |
| `conflicts[]` | `model:SR/LR` (D28); `level:06/06M` when a panel-class device sits on a floor the project splits (the master keeps panels and racks on the mezzanine) |

Anything with a conflict or confidence < 0.7 is **flagged** for the reviewer (D11); the job never
accepts anything.

### Model normalisation (D9, D187)

1. The colour / finish suffix `-4Z`, `-4`, `-5` is stripped (`PI1002-4Z` → `PI1002`,
   `P-TS7-E-5` → `P-TS7-E`; `ERP24-FT-241P` and `CBS350-24P-4G-NA` are untouched).
2. `model_map`: the built-in pairs `P-DOC-W-WD` → `P-DOC-W` and `P-NSPS-D-KIT` → `P-NSPS-D`, plus
   the project's `vocab(model_map)` rows — **row shape (D187):** a canonical row (`value` = the
   canonical model, `canonical_of_id` null) and one variant row per raw spelling (`value` = the
   BOM's model, `canonical_of_id` → the canonical row). `level_alias` uses the same shape with
   level codes as canonical values (`06M` ← `Level 5`, built in).
3. `P-DOC-C-SR` / `P-DOC-C-LR`: both are candidates and `model:SR/LR` is raised; the BOM's own
   value stays `model` until the reviewer (or the riser, T43) decides (D28).

### Accessories and racks (D27, PLAN §7.2)

An accessory line attaches to the nearest line of its parent model in the same job and venue,
preceding first: Inspire faceplates (`1IFP`) → `PI…` stations or the switch-mount sensor
(`P-DOC-SM…`); `ERP-FT-LVD` / `ERP-RTO` → an `ERP…`; `AD-C18…` → `UHCI…`; `P-LCD-FBB` →
`P-TS…`; `DIN14` → `P-NSPS…`; `ERM VDK` → `UFMP…` / `ERP…`; `URTO` → the rack; Echo faceplates
(`EPS05-FP`) → `EPS05`; a Material List sub-item (`Line 270 delivers for line 260`) → line 260.
An accessory with no parent in its venue is excluded (`accessory without a parent line`).

A venue's first `18U RACK` or `ERn4` line opens an **Equipment rack** draft; every later line of
the venue that is not itself a lighting-control device folds into it as `role: component`
(processors, station power modules, Mosaic controller, switch, UPS, patch panel, fibre, rack
ears…). The draft's `model` is the ERn4 enclosure's when the rack has one (`ERN4-RM-120`, the
master's naming), else the rack line's.

### Excluded lines (D12)

Service lines (`ENERGIZATION`, `ENGINEERING`, `DATA TERM OTHERS`, `PROJECT MANUALS`), hardware
kits, brackets, and anything the category table does not know (breakers, boxes, cable, Sensor IQ
parts, consoles…) are listed in the batch `stats.excluded_lines` with a reason and their
`source_ref` — not as rows (D188). The review screens (T44) show them and promote one by creating
a draft by hand.

## Stats (`fixtures/BOM.pdf`, Tower levels)

258 lines over 6 pages (p.3 by OCR, 67 lines), 4 jobs, 27 venues (4 pooled); **108 drafts**
(4 Equipment racks with 50 component lines folded in, 15 pooled and unlevelled), **56 accessory
lines**, **17 excluded** (`tests/test_bom.py::test_drafts_of_the_whole_bom`). Phase 1f's report
counted 258 lines, 113 drafts, 56 accessory lines and 17 excluded; this pass matches the line,
accessory and excluded counts and folds rack component lines into their rack, which is where its
draft count differs (see TASKS T42).

The OCR page in detail: tesseract's own page layout drops the white-on-blue header bar, so
`app.ocr.ocr_page` OCRs each dark filled band of a panel again as a single line (plain and in
the negative) and merges the words (`dedupe`, by box overlap); a header word clipped at either
end (`Quantit`, `tem`) still matches; data words sit up to ~2 pt left of their header word, so
every column band starts `COLUMN_MARGIN_PT` early. The scanned Material List's first page loses
its header to the scan; it inherits the nearest page's bands.

## Known limits (follow-ups in TASKS.md)

- Option cards pooled over several ERP lines in one venue (`ERP-FT-LVD` 21 against ERP24 ×9 and
  ERP48 ×6) attach to the nearest ERP line; the riser cross-check (T43) splits them.
- A pooled venue's drafts carry no level until the riser places them (D10, T43); the review
  screen can also assign one by hand (T44).
- Source crops for the review panel are rendered on request by `GET /imports/{id}/crop` (T44,
  `app/jobs/crops.py`) from the stored PDF (`imports/<batch>/<file>`) at `source_ref.page`;
  the iPad converts a line's `[x0, top, x1, bottom]` box to `x,y,w,h`.
