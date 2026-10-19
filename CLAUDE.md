# CLAUDE.md — Field Survey (ETC lighting-control installation survey, iPad)

> Client stack is **React Native + Expo (TypeScript)**, built from Windows through EAS (D70). There is no Mac on the team and no Xcode anywhere in this workflow. Never propose Swift, Xcode, SwiftUI, PencilKit or SPM; use the React Native/Expo equivalents in §5.

Read this file fully before every task. `PLAN.md` is the normative spec, `DECISIONS.md` the decision log, `TASKS.md` the ordered work. The phase documents in `docs/history/` are background only; when they disagree with `PLAN.md`, `PLAN.md` wins.

## 1. What this is

An offline-first iPad app plus a small Python server that replaces Landry's spreadsheet workflow for surveying ETC lighting-control installations (Houston Methodist Centennial Tower first; more projects later). Surveyors walk a floor with an iPad, tap device pins on the floor plan, set status, add notes and photos, and the app generates punch items, missing parts, an Excel master workbook and a per-floor PDF for the electrical contractor (EC), ETC field service (ETC) and the general contractor (GC). Several people work at once, offline for days, and reconcile without losing anything.

Owner: Landry (Luminary Technology & Productions). Internal team ≤ 5. No external users.

## 2. Repo layout (D60, D68, D70, D71)

```
field-survey/
  CLAUDE.md  PLAN.md  DECISIONS.md  TASKS.md
  package.json  pnpm-workspace.yaml          pnpm workspaces: app, packages/*
  app/            Expo (latest stable SDK), React Native, TypeScript, expo-router; iPad only, iPadOS 17+
    app.json      name "Field Survey", slug field-survey, bundle id productions.luminarytechnology.fieldsurvey
    eas.json      profiles: development (dev client, internal), preview (internal), production (TestFlight)
    src/          screens (expo-router), components, plan viewer, camera, sync UI
  packages/core/  TypeScript: models, SQL schema + migrations, Store.apply(op), op log, sync client,
                  blob queue - no React, no Expo imports; runs in Node for tests (better-sqlite3)
                  and on the iPad (expo-sqlite) through one SqlDriver interface
  packages/rules/ TypeScript: pure rule engine over a snapshot - no DB, no React
  server/         Python 3.12, FastAPI, Postgres 16, S3-compatible storage
    app/          api, sync, numbering, blobs, claude (the API client), jobs (seed import, plan sheets + grid calibration, BOM and riser extraction, DaVinci library import, exports)
    tests/
    docker-compose.yml  Caddyfile
  fixtures/       golden inputs (private): Lighting_Control_Survey_Master_B2-06_4.xlsx,
                  riser.pdf, BOM.pdf, Level_06M_-_Lighting_Composite_vector.pdf,
                  15090056-BOM.pdf (format example only, never a project input — D4)
  docs/history/   Phase 0–4 documents and the original prompt
  docs/ON_DEVICE_CHECKLIST.md  pending iPad checks, grown per task and reset on "tested"; archive in docs/on-device-log.md (D122)
```

## 3. Vocabulary — exact strings, never paraphrased

These are the master workbook's values. Use them byte-for-byte in enums, pickers, generated text and exports. Do not invent new values; a new value is a `vocab` draft that Landry accepts.

| Field | Values |
|---|---|
| Device Status | `Complete` · `Installed, untested` · `Issue` · `Not installed` · `No access` |
| Connection Status | the five above + `Not started` |
| Device with no status yet | stored empty; shown and exported as `Unsurveyed` (D110) |
| Device Category | `Power Distribution` · `Emergency Equipment` · `Equipment` · `Equipment Panels` · `Equipment Rack` · `Power Supplies` · `Wall Plates` · `Lighting Console` · `Touchscreen` · `Station` · `Sensor` (D196; the master's `Relay panel` / `Foundry panel` → `Power Distribution`, `EBDK` → `Emergency Equipment`, `NSPS` → `Equipment`, `Equipment rack` → `Equipment Panels` are old spellings, retrofitted by a rename ruling — T112, D201) |
| Library role (`library_type.role`, T112) | `relay_panel` · `foundry_panel` · `ebdk` · `equipment_rack` · `nsps` · `touchscreen` · `station` · `sensor` · `other` — what the rules, the ID scheme, the Punch List Device text and the pin shape key on; a device with no type gets its category's role (the master's eight, `Emergency Equipment`, `Equipment Panels`, `Equipment Rack`, `Touchscreen`, `Station`, `Sensor`; anything else is `other`) |
| Cable code | `X` (DMX) · `N` (network) · `NG` (network + ground) · `U` (Unison; EchoConnect too, D199) · `F` (fiber) · `P` (panic) · `UV` (UHCI-WM partition sensor; aux power, D199) · `0-10V` · `120V` (feeds and Sense wires) · `D` (DALI, D199) |
| Punch Type | `Missing part` · `Cable not run` · `Termination` · `Wiring` · `Not installed` · `Replace Part` · `Missed Survey` · `Information` · `Access` |
| Owner | `EC` · `ETC` · `EC/ETC` (never `ETC/EC`) |
| Tracking status | `Open` · `In progress` · `Closed` |
| Part status | `Needed` · `Ordered` · `On site` · `Installed` |
| Change type (internal only, D51) | `Field survey` · `Ruling` · `Reconcile` · `Correction` · `Riser cross-check` · `MSS ruling` · `Master edit`; creates show as `(row added)` |
| Unison bus placeholder | `Stations & Sensors` (D50 — the only spelling) |
| 120V To text | NSPS → `P-NSPS-D Power Supply`; Equipment rack → `Equipment rack` (D52) |
| 0-10V To text | `Fixtures` |
| Panic To text | `EBDK panic wire` |

ID formats: panels/equipment `<level>-<nn>` (`06M-04`), stations `<level>-S<n>` (`01-S15`), sensors `<level>-D<n>` (`B2-D1`); connection ends `C-<nn>` per numbering group; punch, part and photo numbers are integers per numbering group. Level codes as the project defines them (`B2`, `B1`, `01`…`04`, `06`, `06M`, `07`…). `06` and `06M` share one numbering group (D33).

Standard phrases (seed `vocab`): "Not run" · "Run, not terminated" · "Run, not terminated; no term kit" · "Not surveyed" · "Waiting on DMX Termination Kits" · "DMX termination kit - <destination> run" · "Need to be ordered" · "Confirm whether on site" · "Confirm whether on site (provided in box)" · "Replace wire nuts with Wagos (provided in box)" · "Re-pull correct wire type (Belden 8471) and re-terminate with Wagos (provided in box); provide ground" · "Not installed: install P-NSPS-D and land 120V and Unison wire" · "Missing all Device Neuron IDs" · "Lands in ERP; needs to be run down to the NSPS below it" · "Reterminated - all good" · "Empty box on wall." · "Land 0-10V control wiring".

Export header strings: `ETC Lighting Controls Survey`; row 2 `Levels <first>-<last>`; the floor PDF header shows the survey date only and no company name (R7).

## 4. Rules the code enforces (summary; full text PLAN §6)

- R1 `Installed, untested` means nothing outstanding; outstanding wiring/termination → `Issue`; nothing is `Complete` this phase; unreached → `No access`.
- R2 Cables: not pulled → `Not installed` "Not run"; pulled not terminated → `Issue` "Run, not terminated" (+ "; no term kit" on a cable that takes kits — D213). Riser governs To. `P` and `0-10V` are single-row; `120V` reads "120v Power → …"; each floor's Unison has its own row; an unsurveyed end stays empty (`Unsurveyed`) and is never copied from the other end (D171); out-of-scope far ends are `Not started`. Notes are never auto-filled (D172).
- R3 Punch: one "Run …" item per unpulled wire (→ terminate item once run); DMX termination = own `Missing part` item `EC/ETC`, item `Terminate DMX to <far end>`, Notes "Waiting on DMX Termination Kits" (D175); every numbering group ends with "Missing all Device Neuron IDs" (`Information`, `EC`, `sort_last`, Notes list the device IDs still missing, auto-closes when empty — D49; once accepted the engine maintains it — D170); no test/commission items; short item text, qualifiers in Notes.
- R4 Missing parts: Owner `EC`; termination kits one per **device end** of every cable that takes them (`R4b.kit` per code — `X`, `F`, `N`, `NG` by default — overridden by `cable.term_kit`; from the kit item, or from an unpulled run's accepted Run item; never a second kit on an end — D213); Notes "Need to be ordered" (parts/kits) or "Confirm whether on site" (devices/backboxes); re-pulled wire is never a part, network kits only where the setting says so.
- R5 Far-end items wait for that floor's survey.
- R6 Every edit after a level's baseline lock is an op with who/when/was/now/reason. Internal only; never exported (D51).
- R7 Floor report + punch list; header date only.
- E1–E12 stand (D34): see PLAN §6.2.
- Rules run **on the client only** (D24) and produce proposals (drafts citing their rule) and findings (lint). They never write records except on Accept.

## 5. Engineering conventions

| Area | Convention |
|---|---|
| Client | TypeScript strict; React Native via Expo (managed workflow + config plugins, no ejecting); `expo-router` for navigation; `packages/core` and `packages/rules` have no React or Expo imports and are tested in Node with `vitest`. Native modules allowed (each needs a new EAS development build, so add them deliberately): `expo-sqlite`, `react-native-pdf` (PDFKit underneath), `@shopify/react-native-skia` (pins, ink, markup), `expo-camera`, `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker` (workbook import, D135), `expo-file-system`, `expo-secure-store`, `expo-crypto` (random bytes for UUID v7, D82), `expo-auth-session` (Entra, from T04), `victory-native` (charts; JavaScript over Skia, so no new build — D181), `react-native-vision-camera` + OCR plugin (M7 only), `react-native-reanimated` (+ `react-native-worklets`) and `react-native-gesture-handler` for the UI-thread plan overlay (D95), `react-native-blob-util` (peer of `react-native-pdf`; the viewer carries a pnpm patch, D92 — see `patches/react-native-pdf.md`), `expo-updates` (over-the-air JS updates on the `production` channel, fingerprint runtime version, applied on the next cold launch and never by `reloadAsync`; D153, D157, `docs/ops.md` §5.5). Anything else is a decision for `DECISIONS.md` first. |
| Database access | `packages/core` talks to SQLite only through its `SqlDriver` interface; `ExpoSqliteDriver` on the iPad, `BetterSqliteDriver` in Node tests. Same SQL in both; migrations live in core. |
| Builds | No local native builds. `eas build --profile development --platform ios` produces the dev client; day-to-day work loads JS over Wi-Fi with `npx expo start --dev-client`. TestFlight uploads via `eas submit`. Build numbers auto-increment in EAS. |
| IDs | UUID v7 for every record (`id`); display numbers are separate fields assigned by the server once, never reused (D25). Never renumber. |
| Ops | Every field edit is one `op` (PLAN §4.1). Grouped edits share `group_id`. No direct table writes from UI code: UI → `Store.apply(op)` → tables + outbox. |
| Soft delete | `deleted_at`; nothing is hard-deleted on either side. |
| Python | 3.12, FastAPI, SQLAlchemy 2 + Alembic, psycopg 3, `uv` for deps, `ruff` + `pytest`. One package `app`, one worker entrypoint. Jobs are idempotent and resumable. |
| Export | XlsxWriter only; model every format detail on `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx` (PLAN §7.6). Never "close enough": the round-trip diff (TP-4) must be empty except the documented differences. |
| Secrets | Server `.env` (never committed). The Claude API key lives on the server only; the iPad never calls Anthropic. Until Entra sign-in lands (D69) the server runs `AUTH_MODE=token` with a shared token from `.env`; every op still carries the user picked on the iPad. |
| Logging | Structured JSON on the server; on the iPad a tiny logger with categories `sync`, `store`, `rules`, `plan`, `update`, written to a rotating file in the app sandbox that the Sync screen can export. |
| Errors | Reliability over cleverness. Fail loudly in tests, degrade quietly in the field: an iPad with no network must never block an edit. |
| Docs | Each task updates the docs it touches. New decisions are appended to `DECISIONS.md` with the next D-number; nothing is edited in place there. |

## 6. Build and test

```
# server
cd server && uv sync && cp .env.example .env
docker compose up -d postgres s3
docker compose run --rm api python -m app.storage ensure-bucket   # once per fresh s3 volume
uv run alembic upgrade head
uv run pytest                      # unit + API + export round-trip (needs fixtures/)
uv run uvicorn app.main:app --reload

# client (Windows PC; Node 24 LTS, pnpm, Docker Desktop, EAS CLI logged in)
pnpm install
pnpm -r test                        # vitest in packages/core and packages/rules (Node + better-sqlite3)
# twin-client harness against the Docker server (TP-1/7/10/11 + blobs; packages/core/docs/e2e.md)
cd server && docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build postgres s3 api && cd ..
FIELD_SURVEY_E2E_URL=http://127.0.0.1:8010 FIELD_SURVEY_E2E_TOKEN=e2e pnpm --filter @field-survey/core test:e2e
pnpm --filter app typecheck         # tsc --noEmit
pnpm --filter app lint
cd app && npx expo start --dev-client     # iPad with the dev build installed loads over Wi-Fi
eas build --profile development --platform ios   # only when a native module changes
eas submit --platform ios                        # TestFlight (D59)
EXPO_PUBLIC_UPDATE_MESSAGE="T<nn>: <title>" eas update --channel production --environment production --platform ios --clear-cache --message "T<nn>: <title>"   # manual fallback only: CI publishes after the deploy (docs/ops.md §2.1, §5.5)
bash /opt/field-survey/server/deploy/deploy.sh <sha>   # on the Droplet: what CI's deploy job runs on a push to main (D154, docs/ops.md §2)
```

Workstation: Windows 11, Claude Code (native Windows), Git, Node 24, pnpm, Docker Desktop, `uv`, EAS CLI (`npm i -g eas-cli`), Tesseract (UB-Mannheim build at `C:\Program Files\Tesseract-OCR`, for the BOM/riser OCR tests — installed by hand, the installer needs a UAC prompt; `docs/ops.md` §4.1), the Expo development build installed on each team iPad. No WSL required; if a tool misbehaves on Windows, WSL 2 is the fallback, not a Mac.

Golden tests read `fixtures/`; if a fixture is missing the test is skipped with a clear message, never silently passed.

## 7. Session protocol (one task per session)

1. Read `CLAUDE.md`, then the task's entry in `TASKS.md` and the PLAN sections it cites. Do not start a task whose dependencies are not marked done.
2. Restate the definition of done in your first message. If the task needs a decision PLAN does not cover, stop and ask; do not guess. Prefer the smallest change that meets the DoD.
3. Implement, with tests named in the DoD. Run the full test suite for the package you touched.
4. Update `TASKS.md`: mark the task `done`, note any deviation, and list follow-ups as new tasks at the end of the milestone (never silently expand scope).
5. Append new decisions to `DECISIONS.md`.
5a. If the task has anything only an iPad can prove (UI, Pencil, camera, airplane mode, two devices, a build), append a section to `docs/ON_DEVICE_CHECKLIST.md` in its format (what to do, what you should see, why it matters, `→ saw:`, new-dev-build flag, Decision lines for Proposed decisions) and have the task's `TASKS.md` entry say "checks added to the on-device checklist" instead of listing them inline. Mention the new checks in the summary.
5b. When Landry says **"tested"** (pasting the checklist back with results), do that as its own small session, not part of a feature task: copy the round with results into `docs/on-device-log.md` under a dated heading, add a `TASKS.md` task for every failure, record each answered Decision line in `DECISIONS.md`, then reset the checklist to its "Before you start" block with an empty list and a new round date. Untested items stay; nothing is dropped.
6. Commit with the message `T<nn>: <title>` and a body listing what the DoD check showed.
7. End with a 5-line summary: what was built, test results, deviations, open questions, next task.
8. Close with a **hand-off** for the next task: its number and title, the model and effort from `TASKS.md` decoded (e.g. "S/M = Sonnet 5.5, Medium") and whether that differs from the current session, a reminder that it runs in a **new session** (`/clear` or a new chat, then `/model` to switch if needed), the prompt to paste (`Read CLAUDE.md, then do task T<nn> in TASKS.md per the session protocol in CLAUDE.md §7.`), and any decision the user should settle before starting. Do the same at the end of any reply in a session whose task is already done.

Model and effort per task are in `TASKS.md` (D61). Do not switch tasks mid-session. Do not refactor beyond the task's files unless the DoD requires it.

## 8. Things that are easy to get wrong

- A cable is **one** record with two ends; per-floor rows are generated. Never store a cable twice.
- From/To are generated **once** from templates and then stored and editable (D32); the export writes the stored text verbatim.
- Conflicts are per **field**, detected by comparing `base_op_id` with the field head; same user on two iPads never conflicts (D37). First-arrived value is official with an "in review" badge; nothing is overwritten.
- `NEW` records have no display number until the server assigns one. Never show or store a provisional number. Device IDs are server-assigned too (D93, D118 — stations `<level>-S<n>` and sensors `<level>-D<n>` included): the iPad shows `<level>-?` + `NEW` until the `assign` op arrives and never asks for a tag. Pin labels on the plan show the device type, not the ID (D119).
- Export needs a connection and an empty outbox (D94): *Start* stays disabled until "Synced"; nothing is ever exported from the local store.
- Pins and ink are stored in **sheet coordinates** (CropBox top-left origin, y down, PDF points — `app/src/plan/viewport.ts`), never in view or raw PDF user space; the overlay follows the viewer's native transform and is never hidden during a pinch (D95).
- Placeholder endpoints are a project vocabulary (D26), not an enum.
- The Change Log is **not** in the export (D51). History stays in the app.
- Plan ink is one stroke-list blob per (sheet, user) (Skia strokes with pressure, our own JSON format) and never merged (D53).
- Pins: **shape = role, fill colour = status** (D64, T112). Shapes by `library_type.role` (else the category's role), by default (the app library can move a role to another shape for every project — Vocabulary → Pin shapes, D214): relay_panel square · foundry_panel rounded square · ebdk wide rectangle · equipment_rack hexagon · nsps pentagon · touchscreen triangle · station circle · sensor diamond · other octagon. Colours: green `Complete`, purple `Installed, untested`, red `Issue`, red hollow "NI" `Not installed`, yellow `No access`, grey `Not started`. Colour is never the only signal (letter/glyph as backup).
- Nothing in this repo compiles on Windows except TypeScript and Python: native iOS code is only ever built by EAS in the cloud. If a task seems to need Xcode, it is mis-specified; stop and ask.
- Rules never test a category string: R2c / R2d / R2e, the lints, `needsNeuronId`, `defaultIdScheme`, `defaultDeviceText` and the pin shapes read the device's **role** (`roleOf` in core, `app/roles.py` on the server: the type's `role`, else the type's category's, else the device's category's). `Power Distribution` and `Equipment` name no role, so a device of those categories needs a type to be a relay panel or an NSPS (T112, D201).
- Rules never hard-code an owner, an item / note / part wording or a starting status: they read `ctx.param(rule, key[, code])` (T102, D176, D211; the catalogue `PARAMS` in `packages/rules/src/params.ts` holds the defaults) and list what they read in the proposal's `params`. A project reads only its own `rule_param` rows; app-level defaults are copied at project creation.
- The device-type library lives at app level and per project (D65); `library_type.project == null` means the app library. Projects copy from it; accepted project types can be promoted to it.
- The library is catalogue-sized (≈ 1,130 types since T111). A device's type by Device text or model goes through `findDeviceType` (indexed per map, D223); never scan `library_type` rows per device, and never run the rules per keystroke — a rules run is synchronous JS (`docs/perf/t131.md`). The Sync screen's timing line and `[sync] synced` / `[rules] run` `ms` fields show a regression.
- Suggestion chips live in the library (`suggestion`, T99, D174, D212): one row per chip on a device type, a category or a cable code, for device Notes, end Note, punch Item or Part. Screens show `chipsFor` — type, then category, then code, then the project's `vocab` list; free typing always stays. A chip never writes anything by itself. Kit chips follow D213 (T118, D217): a cable that takes kits (`R4b.kit` per code, the cable's own `term_kit` over it) also offers the "Run, not terminated; no term kit" end Note and its kit's Part chip (`R4b.part` up to the far end), a cable that takes none offers no "no term kit" Note, and a network code (`N`, `NG`) whose kits are off offers no Part chip (R4).
- The floor PDF is dense (D66): tables with several findings per page, never one item per page.
- Sign-in is built last (D69): the app and server must work end-to-end with the interim team-name picker and shared token before T03/T04 exist.
- `Accept all ≥ 0.9` in setup review still records each accept as a reviewed draft; nothing enters the baseline unreviewed (prompt Must).
