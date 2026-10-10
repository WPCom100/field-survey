# DECISIONS.md — LTP Survey

Append-only. New decisions take the next D-number; assumptions the next A-number. Never edit an earlier line; supersede it with a new one that cites it. Status: **Approved** (Landry at a gate), **Default** (used unless Landry answers otherwise), **Proposed** (needs a yes), **Superseded**.

## Decisions

| # | Decision | Source | Status |
|---|---|---|---|
| D1 | The master workbook's tabs, columns and vocabulary are the schema of record | Prompt | Approved |
| D2 | A cable is one record with two ends; per-floor rows are generated | Prompt | Approved |
| D3 | Custom app; Fieldwire is a UX reference only | Prompt | Approved |
| D4 | Azle job 15090056 files are not project inputs (format example only) | Gate 1 | Approved |
| D5 | BOM import = PDF only; text-layer parse first, OCR fallback | Q1 | Approved |
| D6 | The clean riser is the baseline source for cables; reviewer confirms each extracted endpoint; as-found marks are survey data | Q2 | Approved |
| D7 | Plans are vector; grid labels are text → auto-calibration | Q3 | Approved |
| D8 | No roles or permissions; sign-in is identity only | Q4 | Approved |
| D9 | Model vocabulary = master's generic names; BOM suffixes stripped by a mapping table | Q5 | Approved |
| D10 | Level comes from the riser when the BOM pools | Q6 | Approved |
| D11 | Import never blocks; unresolved drafts go to Needs review; readiness is per level | Q6 | Approved |
| D12 | Extraction filter = ETC devices; excluded BOM lines stay visible and promotable | Q7 | Approved |
| D13 | After the baseline lock, new records are logged too ("row added"); setup/import is not logged | Q9 | Approved (export clause superseded by D51) |
| D14 | Keep `Complete` and `Ordered` in the vocabulary | Q10 | Approved |
| D15 | Photo numbers, punch numbers and Source text are assigned once, never renumbered | Q11/Q12 | Approved |
| D16 | `Floor Order` and `Lists` are export-only helpers | Q13 | Approved |
| D17 | Dashboard counts drill down to filtered lists | Q15 | Approved |
| D18 | Export runs server-side (XlsxWriter + WeasyPrint); offline export not required | Phase 1/2 | Approved |
| D19 | Plan viewer = PDFKit + overlay in page coordinates; tile-pyramid fallback | Phase 1/2 | Approved |
| D20 | Sync choice between GRDB+custom and PowerSync | Phase 1 | Superseded by D22 |
| D21 | Setup pipeline = deterministic parse → OCR → Claude API, per-level human review | Phase 1/2 | Approved |
| D22 | Sync = GRDB + custom op-log; PowerSync, CloudKit, Ditto not used | Phase 2 | Approved |
| D23 | Server = Python/FastAPI + Postgres + object storage, one Docker Compose deployment, same codebase for jobs | Phase 2 | Approved |
| D24 | Rules run on the client only; server stores, orders, assigns numbers | Phase 2 | Approved |
| D25 | Display numbers assigned once by the server at first sync, never reused; Neuron ID item pinned last by `sort_last` | O2 | Approved |
| D26 | Placeholder endpoints = editable per-project vocabulary seeded from the master | O1 | Approved |
| D27 | Accessory entity (parent device, model, expected qty, found qty) | O3 | Approved |
| D28 | BOM≠riser → a human decides; drafts carry both candidates | O4 | Approved |
| D29 | A level has one display sheet (composite) and zero or more source sheets | O5 | Approved |
| D30 | Master seed import is this project's baseline; differences vs BOM/riser → review | O6 | Approved |
| D31 | Sign-in via Microsoft Entra ID / MSAL, identity only | O9 | Approved |
| D32 | From/To text generated once at creation from templates, stored, editable | Phase 2 | Approved |
| D33 | 06 and 06M share one numbering group for punch, parts, photos and connections | Master | Approved |
| D34 | Rulings E1–E12 stand | G2-1 | Approved |
| D35 | Target iPadOS 17+, iPad Air/Pro M-series or A14+; tile fallback is a risk item, not a milestone | G2-2 | Approved |
| D36 | Each device's missing Neuron ID is a need; one item per numbering group lists them | G2-3 | Approved (completed by D49) |
| D37 | First-arrived value is official with an "in review" badge; one person's own iPads never review against each other | G2-4 | Approved |
| D38 | Full-resolution JPEG q≈0.9; HEIC not kept; 320-px thumbnails | G2-5 | Approved |
| D39 | Everyone signs in with a Microsoft account in the LTP tenant; no guest flow in MVP | G2-7 | Approved |
| D40 | No full-size originals for the 76 seed photos; imported as `seed_thumbnail_only` | G2-10 | Approved |
| D41 | Floor PDF layout designed, not copied | G2-11 | Approved |
| D42 | Level 04 partition sensing = one `UHCI-WM` device with accessories | G2-12 | Approved |
| D43 | Device-type library is an in-app editor: default cables, optional cables, optional accessories; new entries are drafts until Landry accepts | G2 overall | Approved |
| D44 | Layout: plan/list left ~62 %, side panel right ~38 %; cards never leave the plan | Phase 3 | Approved |
| D45 | Edits commit per tap (one op each), no Save buttons; grouped fields share `group_id` | Phase 3 | Approved |
| D46 | Pin shape = category, colour = status | Phase 3 | Superseded by D54 |
| D47 | Grid calibration supports several grid sets per sheet with a per-set Drawing Position prefix | Phase 3 | Approved |
| D48 | Library drafts are usable immediately and flagged until accepted | Phase 3 | Approved |
| D49 | Neuron ID item: Notes list device IDs with no `neuron_id`; regenerated on each capture; auto-Closed when empty; reopens on a new device without an ID | G3-1 | Approved |
| D50 | Canonical Unison bus label `Stations & Sensors`; the master's four spellings map to it via a rename ruling recorded at seed import | G3-2 | Approved |
| D51 | The Change Log is not exported; history stays in the app. Supersedes the prompt's Change Log export Must and the export clause of D13 | G3-3 | Approved (confirmed G4-9; no history export either) |
| D52 | 120V rows: rack → `Equipment rack`, NSPS → `P-NSPS-D Power Supply`; NSPS power supply is an accessory (expected 1 for -KIT); accessory found < expected is a lint finding on every type | G3-4 | Approved (lint part Proposed) |
| D53 | Plan ink is shared survey data: one PencilKit blob per (sheet, user), writer = owner, shown to all, flattened on the floor PDF | G3-5 | Approved |
| D54 | One pin shape; fill colour = status; category read from the ID label; riser mini-map dropped from MVP | G3-6 | Superseded by D64 (mini-map still dropped) |
| D55 | A surveyor may type a model not in the library; the app creates a library draft for acceptance | G3-7 | Approved (G4-2), extended by D65 |
| D56 | Floor PDF opens with a cover (header, status counts, plan snapshot with pins); photos 2×3 per page | G3-8 | Approved (G4-3), layout density per D66 |
| D57 | Unlocking a locked level is allowed with a typed reason and is logged | G3-9 | Approved (G4-4) |
| D58 | Hosting: DigitalOcean Basic Droplet 4 vCPU/8 GB + Managed Postgres single node + Spaces; ≈ $78/mo | Phase 4 | Rejected at G4-5 (too expensive); superseded by D67 |
| D59 | Distribution: TestFlight internal; upload a build at least every 60 days | Phase 4 | Approved (G4-6) |
| D60 | Monorepo `ltp-survey/` (`ios/`, `server/`, `docs/`, `fixtures/`), private GitHub; GitHub Actions for server tests; iOS built locally in Xcode | Phase 4 | Superseded by D68 (name) |
| D61 | Model/effort per task: Fable 5.1 High for sync, conflicts, export fidelity, extraction, rule engine, plan viewer; Opus 5.5 Medium for ordinary features; Sonnet 5.5 Low/Medium for scaffolding, lists, settings, fixtures, docs | Phase 4 | Proposed |
| D62 | MVP scope = Phase 4 §2.1; §2.2 deferred to M7 or later | Phase 4 | Proposed |
| D63 | The four attachments plus the Azle BOM are committed to `fixtures/` as golden test inputs (private repo) | Phase 4 | Proposed |
| D64 | Pins: **shape = category, fill colour = status** (reinstates D46 over D54). Default shapes, editable per category in the vocabulary editor: Relay panel ■ square · Foundry panel ▢ rounded square · EBDK ▬ wide rectangle · Equipment rack ⬢ hexagon · NSPS ⬟ pentagon · Touchscreen ▲ triangle · Station ● circle · Sensor ◆ diamond. Colours unchanged (green / purple / red / red hollow "NI" / yellow / grey). Riser mini-map stays out of the MVP | G4-1 | Approved (shape table is a proposal — adjust in-app) |
| D65 | The device-type library exists at **app level** as well as per project: `library_type.project` is nullable (null = app library). A Library screen is reachable from the Projects list without opening a project; a project copies types from the app library at creation and can promote its accepted types back to it; field-addition drafts (D55) are accepted into the project library and optionally promoted | G4-2 | Approved |
| D66 | Floor PDF is a **dense** layout: several findings per page in a table with inline thumbnails, no single-item pages, sections flow without page breaks between them; cover page and 2×3 photo grid (D56) stand. The example report Landry described was not received — the template is finalised against it when attached (G5-1) | G4-3 | Approved, example pending |
| D67 | **Hosting**: one DigitalOcean Basic Droplet 2 vCPU / 4 GB ($24/mo) running Caddy + api + worker + **Postgres in Compose**; object storage on **Cloudflare R2** ($0.015/GB-month, first 10 GB free, no egress fees — ≈ $0.25/mo for one tower); no paid Droplet backups. Backups: nightly `pg_dump` to R2 (90 days) + weekly master export to R2 + weekly copy to a second R2 bucket. **≈ $25/mo.** Alternative offered (G5-2): self-host the same Compose stack on an always-on machine in the LTP office behind a Cloudflare Tunnel, R2 for photos and backups, ≈ $1/mo | G4-5 | **Approved, option A** (G5-2, 2026-10-09 22:00): DigitalOcean Droplet ≈ $25/mo |
| D68 | Repo: private GitHub repo **`field-survey`**; app name **Field Survey**; Xcode project/scheme `FieldSurvey`; bundle id `productions.luminarytechnology.fieldsurvey`; Entra app registration "Field Survey". Layout per D60 otherwise unchanged | G4-10 | Approved |
| D69 | **Sign-in last.** Entra/MSAL (T03, T04) move to the start of M6, before the pilot. Until then an **interim identity**: each iPad picks a name from a team list (stored in `user` with `entra_oid` null, merged when that person first signs in with Microsoft) and the server accepts requests carrying a shared token from `.env` (`AUTH_MODE=token`). No roles either way (D8). The op log is identical in both modes, so nothing is migrated later | G4-7 | Approved |
| D70 | Client built as **React Native + Expo (TypeScript)**; EAS Build/Submit from Windows; development builds on the team iPads; `expo-sqlite` for the local store; `react-native-pdf` (PDFKit) for plans; Skia canvas for ink; server, data model, sync, rules, import/export and hosting unchanged. Supersedes the Swift/SwiftUI/GRDB parts of D22 and D35. Chosen because there is no Mac on the team (Windows PC + iPad) | 2026-10-09 message | **Approved** (G5-4, 22:03) |
| D71 | Client toolchain: pnpm workspaces (`app`, `packages/core`, `packages/rules`); Expo latest stable SDK, managed workflow with config plugins, `expo-router`; `packages/core` accesses SQLite only through a `SqlDriver` interface (`expo-sqlite` on device, `better-sqlite3` in Node) so sync and store logic is unit-tested on Windows CI; `vitest`; native modules limited to the list in CLAUDE.md §5; pins, ink and photo markup drawn with `@shopify/react-native-skia`; ink/markup stored as our own stroke-list JSON | Phase 4 rework | Proposed |
| D72 | TP-5 (Excel open test) runs in Excel Online and Excel for Windows; Excel for Mac is checked whenever a Mac is available (teammate or later purchase) and is a known gap until then | No Mac on the team | Proposed |
| D73 | GitHub Actions runs server tests (Python) and client package tests (Node) on every push; EAS Build is triggered manually, not from CI | Phase 4 rework | Proposed |
| D74 | **iPad-only MVP.** The Expo app ships `supportsTablet` only; an iPhone layout (full-screen plan, card as a bottom sheet, lists as screens) is an M7 task (T62); the office/Mac need is met by installing the iPad app on Apple-silicon Macs via TestFlight, and a browser (Expo web) build stays a Could | 22:06 answer | Approved |
| D75 | **Node 24 everywhere.** `.nvmrc`, GitHub Actions and CLAUDE.md §6 move from Node 22 to Node 24 so local (v24) and CI match; Expo SDK 57 supports it | 2026-10-09 follow-up | Approved |

## Assumptions

| # | Assumption | Status |
|---|---|---|
| A1 | Clean riser rev F is the baseline source for cables | Confirmed (Q2) |
| A2 | BOM-pooled devices take their level from the riser | Confirmed (Q6) |
| A3 | Rulings E1–E12 still stand | Confirmed (G2-1) |
| A4 | No MSS merge detail can be specified until the MSS workbook is attached | Open (fact) |
| A5 | Team iPads are A12+/≥4 GB | Confirmed (G2-2: Airs and Pros) |
| A6 | Same person's two iPads don't review against each other | Confirmed (G2-4) |
| A7 | First-arrived value shows as official with an "in review" badge | Confirmed (G2-4) |
| A8 | Photos stored as JPEG derived on the iPad; HEIC not kept | Confirmed (G2-5) |
| A9 | All team members can sign in with a Microsoft account | Confirmed (G2-7) |
| A10 | Setup uploads happen from the iPad Files picker; no web UI in MVP | Carried |
| A11 | Raster images embedded in composite sheets are ignored at import | From O5 |
| A12 | G2-8 meant "who" is app-only, not that the Change Log tab is dropped | Superseded by D51 (the tab is dropped) |
| A13 | Per-user plan ink is personal, not synced | Superseded by D53 (ink syncs) |
| A14 | Content-addressed blobs are never overwritten, so bucket versioning is optional | Carried |
| A15 | Milestone sizes are estimates in sessions; calendar time depends on availability | Carried |
| A16 | LTP has or will get an Apple Developer Program membership and an Entra tenant where an app can be registered | Needs G4-6, G4-7 |
| A17 | The next floor's survey date is unknown (G4-8 / G5-3: "no idea"). The pilot is whichever in-scope level is surveyed first after M5; the build runs at its own pace. If a floor must be surveyed before M5, K12's fallback applies (survey in the app with hand-entered drafts, T44) | Closed 2026-10-09 |
| A18 | Until T03/T04 land, the server is only reachable with the shared token; the team is ≤ 5 people, internal, no encryption requirement (prompt), so this is acceptable for the build period but not for the pilot | From D69 |
| A19 | The floor-report example is a one-item-per-page Fieldwire export; "similar but denser" is the target | Confirmed by the attached file |
| A20 | EAS free-tier build volume covers the few native builds this project needs; Starter ($19/mo) only if not | From D70 |
| A21 | `expo-sqlite` ships SQLite with FTS5 enabled (verify in T07; LIKE-based search is the fallback) | From D71 |

## Open questions carried into the build

G4-1…G4-10 answered 2026-10-09 (D64–D69 above; statuses updated in place because this file was not yet in a repo — from the first commit on, append only). D70 approved 22:03; client-side parts of CLAUDE.md, PLAN.md, TASKS.md and FIRST_SESSION_PROMPT.md reworked the same evening (D71–D74). **Gate 4 approved 2026-10-09 22:17.** Planning is closed; from the first commit this file is append-only. Nothing open. See `docs/history/Phase4_Delivery_Plan.md` §15.
