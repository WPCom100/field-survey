# DaVinci library import: ETC's catalogue → app-library device types (T111)

How DaVinci's `library.json` becomes draft `library_type` rows in the **app library** (D65),
delivered to every iPad through the library's own op log (D184). Normative references: PLAN §2.2
(`library_type`, `vocab`, `import_batch`), §10 Library, §3.1–3.2 (ops and the apply loop).
Decisions: D43, D48, D65, D183, D184, D196, D197.

## Files

| File | What |
|---|---|
| `app/jobs/davinci_library.py` | `read_library` (the JSON → `DType`s resolved through `constants`, `propertyTypes`, `scripts`, `documents`), `read_categories` (the mapping workbook → `Mapping`), `build_plan` (pure: what the app library should hold), `create_davinci_batch`, `import_davinci` (one transaction: ops through `Push`), `run_queued`, CLI. |
| `app/api/imports.py` | `POST /imports` with `kind=davinci` (multipart `project_id`, `file` = library.json, optional `categories` = the mapping workbook); `GET /imports/{id}` for `job_state` and `stats`. |
| `app/worker.py` | Polls queued davinci batches with the other jobs. |
| `alembic/versions/0011_davinci_library.py` | `library_type.description / datasheet_url / source_ref / accessory_only`; `vocab.list` gains `cable_code`; `import_batch.kind` gains `davinci`. Client side: core migration 0010. |
| `tests/test_davinci_library.py` | The golden sample end to end: the mapping, the plan, the job, re-runs, clashes, the route. |
| `tests/make_davinci_sample.py` | Regenerates `fixtures/davinci-library-sample.json` from a real `library.json`. |
| `fixtures/DaVinci_categories.xlsx` | Landry's mapping (D196): Categories tab "Our category" per DaVinci family / category (155 rows, 52 kept), Types tab "Override" per type (none yet). |

## Running one

From the iPad: Setup → 3 Sources → **DaVinci library → Choose files…**, pick `library.json` (and
`DaVinci_categories.xlsx` the first time, or after regrouping) from Files. DaVinci writes the
library to `%LOCALAPPDATA%\ETC\DaVinci\library.json` on the PC at every launch (≈ 49 MB); copy it
to iCloud Drive or send it to the iPad first. The job is never fetched from ETC.

```
POST /imports            Authorization: Bearer <token> · X-Survey-User: <name>
multipart: project_id=<uuid> · kind=davinci · file=<library.json> · categories=<.xlsx, optional>
202 { "id", "kind": "davinci", "files": [{name, role: "library", sha256, size}, {name, role: "categories", …}], "job_state": "queued", … }
GET  /imports/{id}       → job_state ∈ queued · running · done · skipped · failed, stats
```

From the server shell:

```
docker compose exec worker python -m app.jobs.davinci_library /tmp/library.json --project <project_id> --categories /tmp/DaVinci_categories.xlsx --user Landry
```

**The project.** The batch is filed under the project whose Sources screen started it (an
`import_batch` always has one), and that project's vocabulary takes the `cable_code` drafts
(below). The types themselves go to the **app** library, project-less, whichever project started
the job. Without `categories` the job reuses the workbook of the latest davinci batch that had one
(`stats.categories_reused_from`); with none ever uploaded the request is refused (422).

**Skipped.** The same library and the same mapping (both SHA-256) already imported → `skipped`.
A newer library, or a regrouped mapping, runs again (re-runs below). The full ETC library (2,470
types) plans in well under a second and writes ≈ 1,130 ops.

## What the job reads

`types[]`, resolved through `constants` (families, categories, port protocols and directions,
product classifications, document types), `propertyTypes` (names), `scripts` (names) and
`documents` (URLs):

| DaVinci | → `library_type` |
|---|---|
| `modelInformation.generatorData.items` — strings and `{propertyTypeId}` placeholders (colour, legend…) | `model` = the strings with the placeholders removed and trailing `-`, `/`, spaces stripped (`UH10002-{Heritage Color}` → `UH10002`, `P-TS7-E{…}` → `P-TS7-E`); empty → the display name. The raw pattern is kept in `source_ref.model_pattern`. |
| `typeInformation.displayName`, `partInformation.generatorData.lookupData[]` (`modelNumber`, `partNumber`) | `aliases` = display name, distinct part numbers, the suffixed variants (`UH10002-1` … `UH10002-X`, `P-TS7-E-4`) — everything a BOM or master might call it (D183 (4) matches a device's Device text by model or alias). |
| family / category → the mapping workbook | `category` (D196's eleven); an `Ignore` row, an override `Ignore`, or a family / category the sheet does not list → the type is left out (`stats.rows_not_in_mapping` names what a newer library added). |
| `ports[]` protocol | `default_cables` rows: DMX → `X`, 0-10V → `0-10V`, Panic → `P`, LinkConnect and EchoConnect → `U`, aux power (Aux Power Input, 24 / 48 V Auxiliary Power) → `UV`, Sense → `120V`, DALI → `D`, Fiber (short / long haul) → `F`; Ethernet → `NG` on `Touchscreen` and `Station` types, `N` elsewhere (D199 for the Echo, aux, Sense and DALI rows). One row per port for X / N / NG / U / F (`qty` 1); P, 0-10V, 120V and D collapse into one row with `qty` = port count (an EBDK: `P` × 3; a DALI option kit: `D` × 24). `from` / `to` / `far` / `status` are left empty — the reviewer adds the From / To templates (D183); R2g reads `from` empty as the device's panel name. |
| `Power` ports by direction; **power supplies** (D198) | one `120V` feed row (single row) when the type has a Power **Input** or **Bus** port (`qty` = that count: an ECPB AC plate, a ColorSource relay, an ELTS), or **is a power supply**, or **carries one as an accessory** — every power supply needs a 120 V line in. DaVinci marks a supply by its `Power Supplies` category, a `PowerSupplyCurrentDraw` / `ParadigmPowerSupplyCurrentDraw` script, a `… Power Supply - Aux` capacity property (the NSPS, P-SPS-D, the DIN14 SPS kits) or "power supply" / "power module" in its name or description (not "no power supply"); the `Power Supply - Units` / `Enabled` properties sit on relay-panel hosts and are ignored. `source_ref.power_supply = {self, accessories[]}` says why (the ERn2 enclosure: its P-SPM-E module and upgrade kit; the NSPS: itself). A Power **Output** port is a load circuit, not a surveyed cable (`stats.load_outputs`; a relay panel's own feed is by others, as the master has it). |
| any other protocol (Contact, EBDK Switch, USB, Serial, MIDI, SMPTE, Paradigm Portable, LSH Control, SPS Connection, Control, Emergency, CANbus, Multiverse, MeshConnect, Echoflex, Audio, the F-Drive links…) | **never a code**: one `vocab(cable_code)` **draft** per protocol in the uploading project, for Landry to accept or reject as a decision (D197). The protocol and its port count stay on the type in `source_ref.ports`. |
| `accessories[]` (`typeId`, `maxQuantity`, `userDefinable`) | `optional_accessories` rows `{model, expected_qty, max_quantity, group?}`: `expected_qty` = the slot max for a forced slot (`userDefinable = false`, e.g. the UH10002's faceplate, the ERn2's P-ACP-E Mk2) and the `SetMinAccessories` minimum where a type has one; else null. |
| `scripts[]` `MaxAccessoryMonitor` (`rules[]: accessoryIds, minCount, maxCount, minValueMessage`) | each slot in a rule carries `group: {label, min, max}` — "one of these back boxes" (P-TS7-E: four boxes, min 1 max 1), "two ERn modules incl. the forced processor" (ERn2-W-120 Mk2: min 2 max 2). A group is an expectation across alternatives, which `expected_qty` cannot say; the D52 lint reads `expected_qty` only (the group lint is T113). |
| `propertyTypes[]` names | `needs_neuron_id` = true when the type carries `IP Address` / `Subnet Mask` / `Gateway Address` (any port), else null (the category default, D185). |
| `typeInformation.description`, `documents[]` of type Datasheet (English preferred) | `description`, `datasheet_url`. |
| everything above plus `typeId`, family, category, classification, legacy flag, part numbers, the port summary, the library's `timestamp` and the file name | `source_ref` — `{kind: "davinci", type_id, display_name, family, category, mapped_to, classification, legacy, model_pattern, part_numbers, ports[{protocol, direction, count}], library_timestamp, file}`. Re-runs match by `type_id`; T112 reads the family / category for the type's role. |

**Accessories a kept type references** are imported as types too, even when their own row says
`Ignore` (the Paradigm / Accessories row, the option kits of a relay panel), with `accessory_only
= true` and no category (unless an override names one): the Library screen lists them under
"Accessories (not placeable)", the field-addition picker never offers them, and the host type's
`optional_accessories` names them by the model this import gave them. One level only: an
accessory's own slots are not followed.

**Hand-made types.** `retire_hand_made` (the Sources screen's "Retire the hand-made app-library
types first" box, the CLI's `--retire-hand-made`) soft-deletes every app-library type with no
`source_ref` before planning — Landry's ruling once the catalogue covers them (D199). History keeps
them (`delete` ops, reason "Replaced by the DaVinci library import"; a restore op brings one back),
their models stop counting as clashes, and the **project** copies made at project creation stay,
since devices may point at them. `stats.retired` lists the models.

**Unique names.** Models and aliases are unique across the app library (spaces and case ignored,
as the library's own clash rule). Within one file, two types that strip to the same model (the
Heritage 2-button station and its faceplate are both `UH10002-{…}`; DRd12 with and without a
power supply are both `DRD12-24-120`) are told apart by display name, placeable types first in
file order (`stats.renamed`, 143 in the current library); an alias another type already holds is
dropped (`stats.aliases_dropped`). A model the app library holds under **another** type — a
hand-made one, or a DaVinci type of a different `typeId` — is a **clash**: the type is left out
and listed in `stats.clashes` (`held_by` = the other DaVinci type id, or null for a hand-made
type); nothing is merged or overwritten. Delete or rename the hand-made type and run again.

**Not written** (D197): From / To templates, far-end placeholders, the NSPS -KIT power-supply
accessory (D52, the Library screen still offers it on NSPS types), `id_scheme` (the category
default). DaVinci has no Power port on the NSPS or the ERn enclosures (their mains is an
enclosure property), so the `120V` row on those comes from the power-supply rule above (D198),
not from a port. An equipment rack is not a DaVinci type at all (the racks are `Equipment
Racks / Equipment Racks` shells with no ports): R2d's category table keeps giving racks their
`120V` row until a type with default cables governs them (D183 (2)).

## Re-runs, accepted types, history

Every created type is a **draft** (D48) in the app library, with `created_by_id` = the person who
started the job (else the `davinci` system user), `reason` "DaVinci library import", one `create`
op each in the library log. A later run (a newer `library.json`, or a regrouped mapping):

- a type with a row of the same `source_ref.type_id`: **draft** → each changed field becomes one
  `set` op (`was` / `now` / `base_op_id` = the field head), so History shows what ETC changed; the
  `source_ref` always changes (timestamp, file), so every draft counts as `updated`;
  **accepted** or **rejected** → untouched (`stats.kept_accepted`, `kept_rejected`) — Landry's
  edits and decisions stand, however ETC's data moved;
- a new `typeId` → created; a type ETC removed → its row stays (nothing is deleted);
- the `cable_code` drafts already in the uploading project are not written again.

`stats`: `types_in_file`, `placeable`, `accessory_only`, `by_category`, `power_supplies`,
`load_outputs`, `created`, `updated`, `unchanged`, `fields_set`, `kept_accepted`,
`kept_rejected`, `retired[]`, `clashes[]`, `renamed[]`,
`aliases_dropped`, `rows_not_in_mapping[]`, `rows_unassigned[]`, `unmapped_protocols{}`,
`vocab_drafts`, `library_timestamp`, `categories_file`, `categories_reused_from`, `ops`,
`last_library_seq`.

## On the iPads

The ops carry the T111 columns (`description`, `datasheet_url`, `source_ref`, `accessory_only`)
and `vocab.list = cable_code`. An iPad still on JS older than T111 refuses them on pull (its
store knows neither the columns nor the list value): the library stream's pull logs
`pull_failed`, its cursor stays, the project streams keep syncing, and the next cycle after the
update applies everything. So deploy the server and let the iPads take the update (next cold
launch) **before** the first import; nothing is lost either way.

With the whole ETC library in, the app library holds ≈ 500 placeable drafts and ≈ 630
accessories. The Library screen lists them all in one scroll by category (T114 adds search and a
filter); the field-addition picker offers the placeable ones (drafts flagged, D48).

## Tests

`tests/test_davinci_library.py` reads `fixtures/davinci-library-sample.json` — the seven golden
types (P-NSPS-D, EBDK, UHCI-WM, ERn2-W-120 Mk2, P-TS7-E, UH10002, ERP-FT-LVD), the NSPS kit, one
ERP-FT panel (so the LVD kit is reached as an accessory) and every accessory they reference, 37
types in 221 KB — and `fixtures/DaVinci_categories.xlsx`. Skipped with a clear message when a
fixture is missing (CLAUDE.md §6). Regenerate the sample with
`python tests/make_davinci_sample.py <path to library.json>` when ETC's library changes the
golden types, then re-check the assertions.
