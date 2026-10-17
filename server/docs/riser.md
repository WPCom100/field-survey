# Riser extraction: riser PDF → device and cable drafts (T43)

How the riser becomes `draft_device` / `draft_cable` proposals for the per-level review (PLAN
§7.1, §7.3), how it meets the BOM's drafts (D28, D10) and the seeded master (D30), and what the
Claude API is asked. Normative references: PLAN §7.3, §2.2 (`draft_device` / `draft_cable`),
§3.1–3.2 (ops and the apply loop). Decisions: D6, D10, D11, D21, D28, D30, D189, D190.

## Files

| File | What |
|---|---|
| `app/claude.py` | The Claude API client: key from the server `.env` only (`ANTHROPIC_API_KEY`), model `CLAUDE_MODEL` (Opus 5.5), one structured-output call per crop (`messages.create` with `output_config.format`, effort high, the system prompt cached), tokens and USD per call (`claude_call` events) and per job (`totals()`), and the `Recorder` the tests replay. |
| `app/jobs/riser_extract.py` | Pure functions: pages → bands → devices, bubbles, rack output labels (`analyse`); band crops, the column overview and the prompt for the model (`band_crop`, `column_overview`, `band_prompt`); the model's answer folded back (`apply_answer`); drafts, BOM edits, deletions, placeholders, cables, source conflicts and findings (`build`). No database, no network. |
| `app/jobs/riser_endpoints.schema.json` | The committed structured-output schema (`additionalProperties: false` throughout): `level_code`, `devices[]`, `cables[]`, `unlabelled_lines[]` (T108), `notes`. |
| `app/jobs/riser.py` | The job: `create_riser_batch` (PDF → object store, batch queued), `target_of` (levels, placeholders, the BOM's drafts, the project's devices, the BOM normalisation target), `resolve_with_claude`, `import_riser` (one transaction: ops through `Push`), `run_queued`, CLI. |
| `app/api/imports.py` | `POST /imports` with `kind=riser` (multipart `project_id`, `file`); `GET /imports/{id}` for `job_state` and `stats`. |
| `app/worker.py` | Polls queued riser batches with the other jobs. |
| `tests/test_riser.py` | `fixtures/riser.pdf` end to end; `tests/golden/riser_claude.json` holds the recorded answers. |

## Running one

```
POST /imports            Authorization: Bearer <token> · X-Survey-User: <name>
multipart: project_id=<uuid> · kind=riser · file=<.pdf>
202 { "id", "kind": "riser", "files": [{name, sha256, size, pages}], "job_state": "queued", … }
GET  /imports/{id}       → job_state ∈ queued · running · done · skipped · failed, stats
```

From the server shell:

```
docker compose exec worker python -m app.jobs.riser <project_id> /path/to/riser.pdf --user Landry
```

Upload the BOM first (T42) and, for a project seeded from a master, run the seed import first:
the riser job merges into whatever drafts and devices the project has at the time (below). The
same file (SHA-256) for the same project is `skipped` the second time. One sheet pair takes
about 12 minutes with the model (26 bands, ≈ 25 s each) and seconds without.

**The key.** `ANTHROPIC_API_KEY` lives in the server `.env` (D189); the worker reads it. Without
one the job still completes (D11): devices, bubbles and the rack's labelled outputs are
deterministic, every other cable is written with `endpoint:unresolved`, and `stats.claude`
reads `unavailable (no ANTHROPIC_API_KEY)`. Re-running the same file later does not re-extract
(it is `skipped`); delete the drafts or upload a revised riser (T55) instead.

## What the job reads

The ETC riser (Phase 1f §1): sheet 001 (levels B2–12) has a text layer; sheet 002 (14–28) is
outlined into ~6,000 curve fragments — only its title block and legend are text.

**Bands.** Long horizontal rules close each level's band; they are found on a raster row profile
(144 dpi, a dark run ≥ 250 pt wide left of the title block), which works on both sheets, and
grouped by x-extent into columns (one on 001, two on 002). A band is the space down to its rule
(the first band of a column starts under a blank run above its content). The level is the big
`LEVEL nn` label inside the band; the outlined `LEVEL 03` still reads; a band with no label
between numbered neighbours two apart is interpolated; on a no-text sheet the model reads it.

**Devices (text sheets).** `CTxxLCPA/B` tags with the model under them (`ECHO ERP-FT-481P` or
`FOUNDRY UFMP8`) and their option-card lines (`2 - ERP-FT-LVD`, `1 - ERP-RTO`) as accessories;
`EQUIPMENT RACK - 18U` with the component lines inside it (`1 - P-ACP`, patch panel, switch,
UPS…) as `role: component`; `n - P-NSPS-DIN` enclosures; `EBDK`; loose `UFMP4/8`; `PARADIGM
<model>` (stations, sensors, `P-NSPS-DIN W/ENCLOSURE`), `UNISON UHCI-WM`, `P-TS7-E`. Each
symbol's `QTY: nn` callout is matched by centre-x (left-x mis-assigned 40 % in Phase 1f). The
riser's spellings map to the BOM's models (`ERP-FT-241P` → `ERP24-FT-241P`, `ERn4-RM` →
`ERN4-RM-120`, `P-NSPS-DIN` → `P-NSPS-D`) before the project `model_map`.

**Bubbles.** A lone `X` / `N` / `NG` / `U` / `F` / `P` / `UV` token ringed by ≥ 30 small curve
fragments (real bubbles carry 52–161; the `WHT / F` finish labels under stations 0–15). The
letter is the wire identification code, never a quantity. `U` bubbles are the Unison chain links
between device types — counted in `stats.sheets[].unison_links`, never proposed: the library's
R2e makes the bus rows.

**Rack output labels.** Text printed right beside a bubble (`DMX TO B3A CANYON`, `SPARE DMX OUT`,
`TO ERn4 LEVEL 16`, `TO EQUIP RACK LEVEL 06`) names that run's far end outright.

**Lines with no bubble (T108, D192, D194).** Every connecting line drawn without a wire bubble
is asked about, so nothing on the drawing goes unaccounted for. On a text sheet they are found
by geometry (`lines_of`): every straight piece of ink (`segments_of`: lines, rectangle edges,
each step of a curve) joined end to end within 2 pt; a line counts when it touches the outline
drawn round a device (`symbol_boxes` / `symbol_box`), reaches out of it and carries no bubble
(`U` links included). Trunks between bands are not followed: a line that reaches one is marked
`leaves_band` and the model reads its far end. The text block at the free end is the line's
label; a device's arrows ending at one label are one line (the triple feed arrow). Sheet 001:
**99 lines** — per band the `TO LOAD CKTS` / `TO LOAD` arrows, the `(2)#16 AWG … TO 0-10V
CONTROL` leaders, the panels' and UFMPs' feed arrows, the EBDK sense feeds, the NSPS / rack 120V
feeds and the NSPS runs up the trunk. Each gets a guess from its own text (`0-10V` → `0-10V`,
`120V` / `100-277V` → `120V`, 0.5) that the model's `code_guess` replaces; on sheet 002 the
model lists the lines itself.

## The Claude API pass (PLAN §7.3, D21, D189, D190 (4))

One call per band, in band order: the band crop (≤ 2000 px on its long edge, PNG), the whole
column at low resolution with the band outlined in red (so trunk lines between bands can be
followed), and a prompt listing the band's known devices and bubbles with their pixel boxes,
the column's levels and the project's levels. The answer must match
`riser_endpoints.schema.json`. On a text sheet the model returns cables only (from / to device
ids from the list, or a far-end label with a level code); on sheet 002 it returns the devices,
the bubbles and the cables. Coordinates come back in band pixels and are mapped to page points.

Devices are classified by **role** (T115, D201): the schema's `devices[].role` is one of
`relay_panel` … `other` (the prompt lists a text sheet's devices by role too), and the draft's
D196 `category` is the role's (`roles.ROLE_CATEGORY`; none for `other`) — or, when the project's
library has a type for the model, that type's role and canonical category. The schema carries no
`category` of its own: the API allows at most 16 union-typed (nullable) parameters in a
structured-output schema and the riser schema already has 16. `draft_device.role` (Alembic
0013, client migration 0012) keeps the role for draft review and placement (`typeForDraft` in
`app/src/library/neuron.ts`). A trunk label (`TO RELAY PANEL LEVEL 20`, `TO EQUIP RACK LEVEL
06`, `TO NSPS …`) resolves to the device of that role on the level (`device_on`).

A model answer's confidence is capped at 0.85 (`MODEL_CONFIDENCE_CAP`), so nothing the model
alone proposed is bulk-acceptable; under 0.7 the cable is flagged `endpoint:low_confidence`;
with no end named, `endpoint:unresolved`. A failed band (API error, refusal, bad JSON) is
recorded in `stats.claude_bands` and skipped; its cables stay unresolved.

Cost: `stats.claude` = `{model, calls, replayed, input_tokens, output_tokens, cost_usd}` from
`response.usage` at D189's prices; each call logs a `claude_call` event with its label, tokens,
USD and request id. The Tower's two sheets: 26 calls, ≈ 210 K input tokens (the system prompt
cached), ≈ 113 K output tokens (thinking included), **≈ $3.10 per run** at effort high (T108's
re-recording, 2026-10-16; ≈ $2.00 before the lines with no bubble were asked about — 244 line
answers added ≈ 48 K output tokens) — above the Phase 1f estimate ($0.45) because the estimate
had no thinking tokens and one image per band. With the recording: 221 lines with no bubble on
the Tower (sheet 001: 99 by geometry + 6 the model added; sheet 002: 116 by the model), guessed
120V 140, 0-10V 37, U 16, N 3, X 2, none 23 — about 135 of them load, feed-circuit and sense-feed
arrows "by others" that the reviewer rejects (kept, D192). Reading the model's lines
(`apply_lines`): a line written arrow-first (from the note to the device) is turned round so the
device is its near end, and a trunk that touches no device on the band is dropped there (it is
asked about on the band whose device it leaves). Effort `medium` would roughly halve it; the overview image is a fifth of the input.

## What the job writes

Everything as trusted ops by the uploading user (`Master edit`, reason `Riser extraction:
<file>`), one transaction:

| Op | When |
|---|---|
| `placeholder` create | a far-end label names a seed placeholder the project lacks (`fixture_run` from `DMX TO …`, `spare`, `external`, `Level nn` as `level_not_in_scope`) |
| `draft_device` create | a riser symbol with no BOM draft of its model family on its level — `level_basis = riser_band`, `extraction` `text` (0.9) or `model` (≤ 0.85), `source_ref = {kind: riser_symbol, file, page, sheet, band, bbox, label, qty, model, level_code}`, `name` for panels (the tag) and racks (`Equipment Rack 18U`), accessories with their own `source_ref`; `source_ref.bom` when it draws down a pooled BOM line |
| `draft_device` set | the merge (D28): a BOM draft of the same model family on the level gets `source_ref.riser` (`shared_with` when several BOM lines share one symbol), `name` from the panel tag (D10), `conflicts` (`qty:bom≠riser`, `cards:bom≠riser`, `pairing:ebdk≠erp`, `network:no_N_run`), `confidence` raised only when the counts agree |
| `draft_device` delete | a pooled BOM line whose riser placements add up (option cards summed per venue): reason `Placed by the riser: n drafts on levels …` |
| `draft_cable` create | one per run bubble: `code`, `qty 1`, `origin riser`, `from_label` / `to_label` / `to_level_id`, `candidates[]` (`{side: from\|to, kind: draft_device\|placeholder, id, label, confidence}`), `source_ref = {kind: riser_bubble, file, page, sheet, band, bbox, label, bubble, note, level_code}`, `extraction`, `confidence`, `conflicts` |
| `draft_cable` create (line) | one per line with no bubble (D192): `code` **null**, conflict `code:unknown`, `candidates` with the guess as `{side: code, value, confidence, source: label\|model}` (never the code) and, for a guessed `0-10V` / `120V`, the library's placeholder (`Fixtures` / `120v Power`, D194) as the To; `source_ref = {kind: riser_line, …, bbox, line, label, note}` |
| `review_item` create | `source_conflict` (D30): the riser's count per (level, model family) against the project's live devices on a surveyed floor, `subject = {entity_kind: draft_device, entity_id, field: qty, level_code, model}`, `candidates = [{side: riser}, {side: bom}, {side: master}]` |

Conflicts the reviewer sees on a draft (D11 — anything flagged or under 0.7 waits in Needs
review): `model:SR/LR` (from the BOM), `level:06/06M` (a panel-class device on a floor the
project splits, as the BOM job flags), `qty:bom≠riser`, `cards:bom≠riser`, `source:riser_only`,
`pairing:ebdk≠erp`, `network:no_N_run`, `confidence:low`, `endpoint:low_confidence`,
`endpoint:unresolved`, `code:unknown` (a line with no bubble: "What is this cable?").
`stats.findings` lists the checks behind them with their numbers; `stats.cables_unknown_code`
and `stats.code_guesses` count the lines (`cables_by_code` counts coded drafts only).

On the iPad (T44 / T108) a line lists first on its level's Cables tab with the guess, a code
picker (every CLAUDE.md §3 code) and Accept / Reject. Accept writes the picked code and clears
`code:unknown`; a `0-10V` line from a Relay panel or a `120V` line from an NSPS or rack becomes
that device's library row — linked to the cable it already has, else made with R2c / R2d's texts
— so R2c / R2d offer nothing more for it (D194).

### Levels the project lacks

A band whose level the project does not have (the Tower's 09–12, 14–28) still yields drafts
with `level_id` null and the code in `source_ref.level_code` (as the BOM's
`level_not_in_project`), and its cables likewise; "Add range" (T41) and the review (T44) give
them a level. A far end on such a level becomes the `Level nn` placeholder.

## Stats (`fixtures/riser.pdf`, Tower levels)

Sheet 001: 11 bands (12, 11, 10, 09, 06, 04, 03, 02, 01, B1, B2), **93 devices**, **71 bubbles**
(X 46, N 5, F 3, P 15, NG 1, UV 1) and 41 Unison links; 13 bubbles carry a rack output label.
Every device count on B2–06 matches the drawing and the master's Devices tab (Phase 1f §3), and
the pooled BOM totals equal the placements (ERP24 ×9, ERP48 ×6, EBDK 15, UFMP8 ×5). Sheet 002:
two columns, 6 + 9 bands, read by the model. TP-9 (`test_tp9_device_keys_and_the_master_cross_check`):
of the master's 57 (level, Device) keys, BOM + riser give **56** — the miss is `04 Partition
sensors`, which the BOM carries as `AD-C18` parts under `UHCI-WM` (Phase 1f's "accessory
granularity"); the two known quantity conflicts come out as `qty:bom≠riser` on Level 1 PI1004
(BOM 1, riser 2) and a `source_conflict` on Level 3 ceiling sensors (riser 13, BOM 13, master 9).

## Known limits (follow-ups in TASKS.md)

- A cable draft's far end on another level names the device by kind (`Equipment Rack 18U
  Level 06`) and links the rack draft when the riser has it; a relay panel named only by level
  (`Relay panel`, level 02) is text until the reviewer picks (T44's endpoint pickers, D6).
- `cable.riser_ref` names the riser blob, not a `sheet` row (D191): T44's Accept on a riser
  cable draft writes `{blob, file, page, bbox, draft}` (D193 (5)); the cable view's riser crop
  opens that blob (`GET /blobs/{sha}/content`, cached like a sheet) on its page, focused on the
  box (T106).
- Every riser `bbox` is in points, top-left origin, **of the page as displayed** — `/Rotate`
  applied, as pdfium and pdfplumber report it (the Tower riser's pages are `/Rotate 270`,
  3168 × 2448). The iPad maps it to PDF user space with the rotation its viewer reports (D195).

## Review on the iPad (T44)

Setup → 4 Review drafts reads these rows per level (D193). Its source crops come from
`GET /imports/{id}/crop?page&bbox=x,y,w,h&pad&px` (`app/jobs/crops.py`): the stored PDF around
the box with the box outlined in red, PNG, cacheable. Accept on a device draft only marks it
reviewed (devices are made at placement, T46); Accept / **Confirm endpoint** on a cable draft
makes the cable with both ends once both endpoints are records, or links the matching cable a
seeded master already has.
- The model's trunk-line reading is a judgement (0.5–0.85 on the Tower's inter-level DMX runs);
  line tracing over the vector segments would make it deterministic for text sheets.
- OCR (tesseract) is not used on sheet 002; the model reads it. A scanned riser would go the
  same way.
