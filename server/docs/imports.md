# Seed import: master / floor workbook → ops (T27)

How a survey workbook becomes this project's baseline (PLAN §7.5, D30). Normative references:
PLAN §7.5 (tab mapping), §2.2 (entities), §2.3 (numbering), §3.1–3.2 (ops and the apply loop).
Decisions: D13, D25, D30, D32, D33, D40, D50, D51, D110, D124–D126.

## Files

| File | What |
|---|---|
| `app/jobs/workbook.py` | Reads the `.xlsx`: every known tab by header name (row 3), the Summary floor table (Surveyed/Updated as ISO text), the Photo Log pictures straight from the drawing XML (openpyxl needs Pillow for pictures; we read `xl/drawings/*.xml` → `xl/media/*` ourselves). `ColumnMap` = `{tab: {field: header}}` overrides for the column-mapping UI (T28). |
| `app/jobs/seed_import.py` | Rows → `Plan`: the ops, the Change Log as historical ops, the images, stats and checks. Device matching, cable-end pairing, `Source` parsing, the D50 rename ruling. No database. |
| `app/jobs/runner.py` | `import_batch` lifecycle: `create_batch` (file → object store, row queued), `import_workbook` (one transaction), `run_batch` / `run_queued` (worker), CLI. |
| `app/api/imports.py` | `POST /imports` (multipart), `GET /imports/{id}`, `GET /imports?project_id`. |
| `app/worker.py` | Polls queued batches every 5 s; backups and heartbeat once a minute. |
| `app/sync.py` | `Push(trusted=True)` keeps carried display numbers and moves the counters (below). |
| `tests/test_seed_import.py` | The master fixture end to end, a synthetic workbook for the edge cases, the routes, the trusted-push rules. |

## Running one

```
POST /imports            Authorization: Bearer <token> · X-Survey-User: <name>
multipart: project_id=<uuid> · kind=master_xlsx|floor_xlsx · file=<.xlsx> · mapping=<json, optional>
202 { "id", "project_id", "kind", "files": [{name, sha256, size}], "job_state": "queued", "stats": null, … }
GET  /imports/{id}       → job_state ∈ queued · running · done · skipped · failed, stats
```

The worker picks the batch up within 5 s. From the server shell (the Droplet, before T28 exists):

```
docker compose exec api python -m app.jobs.runner <project_id> /path/to/master.xlsx --user Landry
```

The project must exist (`POST /projects`, T41); it needs
no numbering groups or levels — the import creates them from the Summary (one group per floor,
06 and 06M in one, D33). Existing levels with the same code are reused.

## What the job writes

Everything is **ops through the ordinary apply loop** (`Push`), by the user who started the import
(`change_type` `Master edit`, reason `Seed import from <file>`), in one transaction. The server
materialises, numbers and heads them exactly as it would an iPad push; `replay()` reproduces the
tables; every iPad gets the baseline by pull. Stats (`import_batch.stats`) count what was written.

| Tab | Records | Notes |
|---|---|---|
| Summary | `level` per floor row (floor order = row order, Surveyed/Updated parsed), `numbering_group` rows | levels stay `setup`; the import does not lock baselines (D125) |
| Devices | `device`: ID kept, `origin=import`, `panel_name` from a `CTxxLCPx` in Device or Type (EBDKs included) | `Unsurveyed` → empty status (D110); any other off-list status → empty + `review_item(lint)` |
| Connections | one `cable_end` per row (`C-nn` kept) + its `cable`; pairing below; the four Unison bus spellings → `Stations & Sensors` via one `ruling` row + a `Ruling` op per end (D50) | From/To verbatim (D32); `cable.endpoint_confirmed=false` on every cable (D6) |
| Punch List | `punch_item` (# kept), `device_id` matched from the Device text (tag `S4`/`D6`, `PI1002 #2`, panel `CT01LCPB`, `EBDK (CT01LCPB)`, model + room, `UFMP4 #2`); `Missing all Device Neuron IDs` → `sort_last` | text naming several devices, a room or "All devices" → no device |
| Missing Parts | `missing_part` (# kept, `device_location` verbatim, single-device text matched) + `part_source` links from Source: `Punch #8-14`, `#15, #19`, `Punch #14; Devices 06-S3`, `Connections C-06 (…)` | an unparsed segment → `finding(import.part_source)`; the parsed ones still link |
| Photo Log | `photo` (number kept) with the picture as a complete `blob` (`thumb_blob`, 320×240, `seed_thumbnail_only`, D40); `device_id` = first Device ID (else the Devices tab's Photo column), `punch_item_id` = first punch row listing the number | a row without a picture keeps its record (check) |
| Change Log | one historical op per row: user `import`, `install_id` `IMPORT_INSTALL_ID`, **state `superseded`** (D124), `client_ts` = the row's date, `change_type`/`reason` as written, `was`/`now` verbatim, `payload` = `{source, sheet, ref, entry, field, level}`; `(row added)` → kind `create`; `field` = our column when the master's maps (`Notes` → `notes`, `Qty` → `cable.qty`…), else the master's name (`Photo`, `Source`) | Refs resolve against the imported numbering; a range (`#2-#27`) hangs off the level |
| Lists / Floor Order | not imported (D16) | |

Historical ops are recorded, never materialised, never move a head: the current values come from
the creates. On the iPad they arrive by pull as `recorded` ops and show in a record's History
(`opsFor`), which is why they exist (D51: history stays in the app).

### Cable-end pairing

Each Connections row is a numbered end. `P`, `0-10V` and `120V` are single-row cables: side A is the
row, side B the panel's EBDK (device, same level, never numbered), the `Fixtures` placeholder, or
the `120v Power` placeholder (for `120V` the row's endpoint is the device its To names). For the
other codes:

1. A To text naming an out-of-scope level (`Level 09`, `Level 16`…) or a seed placeholder
   (`B3A Canyon`, `Walter Tower ETC P-CCS`, `Spare DMX out`, …) gets that placeholder as its far
   end; `Level NN` placeholders beyond the PLAN §7.5 list are created as met (D126).
2. The rest are scored pairwise (same code only): does each To name the other's level (explicit
   `Level 01` → 1.0; same floor and no level named → 0.8; naming a different level → never) and
   the other's device (`CT01LCPB`, `rack`, `UFMP4`, `NSPS`, `UHCI`, `TS7`, the bus → 1.0; naming a
   different one → never). Score = 0.3 + 0.3 (levels) + 0.2 + 0.2 (devices).
3. Greedy best-first matching: a pair at ≥ 0.8 becomes one cable (side A = the lower floor).
4. Every end left over keeps its own cable with an **unresolved** side B (`endpoint_kind` null) and
   an open `review_item(import_pair)` whose candidates list the free partners scoring ≥ 0.4 with
   their confidence; the client lists these read-only until T44/T45 build the Pair / Not-a-pair
   panel (Phase 3 §6).

On the master this gives 27 pairs, 17 placeholder far ends, 8 review items (the `02 ↔ 03` DMX
runs that only name each other's level, `01 C-05 ↔ 02 C-02` at 0.6, and two network runs with
no destination) and 4 `import.endpoint` findings (`UFMP4 #1, #2` / `UFMP4 (7)` name several
devices). `endpoint_confirmed` stays false everywhere: the reviewer confirms each cable (D6).

### Numbers and counters

A trusted create (the import) carries the master's `#`, photo number, `C-nn` and device ID; the
apply loop keeps them, sets the field head to the create and moves the group counter up to the
number, so the next field addition continues after the master (PLAN §7.5 "counters set to
max"). The rule is general, not import-specific: `Push.assign` also never numbers the side-B end
of a `single_row` cable. An untrusted (iPad) push carrying a number is still refused (422).

### Idempotence and failure

A workbook already imported into the project (same SHA-256, an earlier batch `done`) ends
`skipped` with `stats.earlier_batch`. A failure (`failed`, `stats.error`) rolls the data
transaction back: the project is untouched and the batch can be re-queued. Re-importing a
*changed* master into a seeded project is not a seed: it would duplicate every record. That merge
is the MSS/T58 shape of problem and needs its own task.

### Users

The requesting user (`X-Survey-User`) owns the creates. Historical ops belong to the `import`
user: an `app_user` with `entra_oid = system:import`, which `GET /team` hides from the picker
(`app.auth.system_user`). The iPad's History shows it by id tail until names for system users
reach the client (follow-up).

## Known limits (follow-ups in TASKS.md)

- `punch_item` has no column for the master's **Device** text; it is regenerated at export from
  `device_id`. 20 of 215 master rows name no single device (`All devices`, rooms, two stations) and
  several name the device differently from its Device column (`P-NSPS-D` vs `P-NSPS-D-KIT`) → T29's
  round-trip diff will show them unless a text column is added (decision).
- A photo links to **one** device and **one** punch item; the master lists several on 10 photos and
  reuses a photo number on several punch rows. The first wins; T29 lists the rest as documented
  differences, or a `photo_link` table is added (decision).
- Change Log refs resolve against the master's current numbering; rows written before a
  renumbering (`#28 → #29`) attach to whatever carries that number now.
