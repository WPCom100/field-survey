# Survey iPad App — Phase 4 (Gate 4): Delivery plan

Date 2026-10-09. Inputs: `Fable_Prompt_Survey_iPad_App.md`, project docs Gate 1, Phase 1, Phase 2, Phase 3. Web search used for four facts only (§7, §8; sources at the end). Everything else is from the attachments and your answers. Items beyond them are marked **(proposal)**. No code in this phase.

Companion files (the handoff package, §11): `CLAUDE.md`, `PLAN.md`, `DECISIONS.md`, `TASKS.md`, `FIRST_SESSION_PROMPT.md`.

## 1. Gate 3 answers → decisions

| # | Your answer | Decision / consequence |
|---|---|---|
| G3-1 | close when the Neuron ID is put in per device | **D49** Each device's `neuron_id` is its own need. The floor's "Missing all Device Neuron IDs" item lists the device IDs still missing in Notes; the engine regenerates that list on every capture and sets the item to Closed (Date closed = date of the last capture) when the list is empty. Adding a device without an ID reopens it. |
| G3-2 | Stations & Sensors | **D50** Canonical label `Stations & Sensors` (capital S on both). The seed import maps the master's four spellings ("Stations & sensors", "Station & sensor", "Stations & sensor", "PI1002 & P-DOC-C-LR stations") to it through a rename ruling recorded at import, so exports use the canonical form from the first run. |
| G3-3 | No log at all in the export | **D51** The Change Log tab is **not** exported. Exported tabs: Summary · Devices · Connections · Punch List · Missing Parts · Photo Log · Lists. The op log, history view and Change-type vocabulary stay in the app (R6 still applies internally). This supersedes the prompt's "Export … and the Change Log" Must and the export clause of D13 — **confirm in G4-9**, because it reverses a requirement you wrote. |
| G3-4 | Just as Equipment Rack; NSPS kits include a power supply but NSPS is sometimes sold as pieces | **D52** 120V rows: rack → To `Equipment rack` (as found); NSPS → To `P-NSPS-D Power Supply` (as found). In the library, the NSPS power supply is an **accessory** of the NSPS type: expected 1 when the BOM line is `P-NSPS-D-KIT`, otherwise expected from its own BOM line (or 0 if none); found qty from the survey. Accessory found < expected is a lint finding on every type **(proposal; today only E5 generates items, and only for ERP-FT-LVD)**. |
| G3-5 | syncs | **D53** Plan ink (Pencil on the sheet) is shared survey data. Stored as one PencilKit drawing blob per (sheet, user); every user's layer is shown to everyone; a user only ever writes their own layer, so ink never conflicts. Flattened onto the plan snapshot in the floor PDF. Closes A13. |
| G3-6 | use different colors, not shapes | **D54** One pin shape for every category. Fill colour = status (your code: green / purple / red / red hollow "NI" / yellow). Category is read from the pin label (the device ID, e.g. `06M-S3` vs `06M-02`), not from a shape. The riser mini-map (unanswered half) is dropped from the MVP. **Confirm the colour reading in G4-1.** |
| G3-7 | Unknown | Restated with an example in §12 (G4-2). Default until answered: **D55** a surveyor may type a model that is not in the library; the app creates a library draft flagged for your acceptance (D48 pattern). |
| G3-8 | not sure what page 1 is | Restated in §12 (G4-3). Default: **D56** floor PDF opens with a cover page (header, status counts, plan snapshot with pins); photos print six per page in a 2×3 grid with captions. |
| G3-9 | not sure what you're asking | Restated in §12 (G4-4). Default: **D57** unlocking a locked level is allowed, requires a typed reason, and is logged. |

From here on, every open question in §12 carries a one-line "what this means" and an example, as you asked.

## 2. MVP scope

The MVP is the smallest build that lets your team survey **the next floor** in the app instead of the spreadsheet, with setup done from the BOM and riser, and the EC/ETC/GC workbook produced by export.

### 2.1 In the MVP

| Area | What ships | Replaces (today) |
|---|---|---|
| Project and levels | Create project, levels with floor order, numbering groups (06/06M), in-scope flag, copy vocabulary/library/rulings from a previous project | Workbook headers, `Floor Order` column |
| Seed import | Master and floor workbooks → records, with column mapping and checks (D30) | Copying rows between files |
| Setup from sources | BOM PDF (text + OCR), riser (text + Claude API endpoints), floor-plan sheets with grid auto-calibration, drafts reviewed per level with source crops, cross-check list, place-from-list with ID/tag confirm, lock baseline | Typing every device and cable |
| Field loop | Offline project home, plan viewer with status-coloured pins, device card (status, vocabulary notes, accessories, manual Neuron ID, photos with markup, connections with jump, punch/part drafts, history), long-press additions, lists beside the plan, plan ink (D53) | Hand markup + transcription |
| Sync | Op-log sync, server-assigned numbers, field-level conflict review (A/B/Combine), soft delete, resumable photo upload | Several copies of the truth, dark-red highlights |
| Rules | R1–R7, E1–E12 as proposals citing their rule; vocabulary pickers; lint view; rulings with preview and standing re-evaluation; device-type library editor with drafts (D43) | Re-applying rulings by hand |
| Views | Dashboard with the four Summary tables, charts and drill-down (D17); search; cable/riser view with consistency checks; Needs review | Summary tab, eyeballing cables |
| Export | Workbook matching the master minus the Change Log (D51); floor PDF (D56); export history | The master workbook, floor reports |
| Sign-in and distribution | Microsoft Entra ID (identity only), TestFlight internal builds | — |

### 2.2 Deferred (after the pilot)

| Item | Prompt priority | Why deferred | Milestone |
|---|---|---|---|
| Neuron ID scanning (VisionKit) | Should | Manual entry works with D49 from day one; scanner is additive | M7 |
| Re-run extraction on a revised drawing set, diff against baseline | Should | Needs a stable baseline first | M7 |
| Copy a typical floor | Should | Cheap once the model exists; not needed for one pilot floor | M7 |
| MSS export/merge | Should | MSS workbook never attached (A4) | M7, blocked |
| Peer-to-peer sync | Should (evaluate) | Op-log design allows it; evaluation spike only | M7 |
| Web/Mac dashboard, multi-project UI, templates | Could | Schema is multi-project already; UI lists one project | later |
| Riser mini-map; pin shapes | — | Dropped (D54) | — |
| Offline export on the iPad | — | Export runs server-side (D18) | — |
| Reviewer approval of every field edit | optional | D8 closed it; `awaiting_approval` state reserved | — |
| Sheet revisions with pins carried over | Should (1d pattern) | Needs re-extraction diff | M7 |

## 3. Milestones

Sizes are in Claude Code sessions (one task per session, per the prompt). Calendar time depends on how many sessions a week you run; at one session per working day the MVP (M0–M5) is roughly **10–14 weeks**, the pilot adds 2–3 weeks. Estimates are mine, not measured (**A15**).

| M | Name | Sessions | Exit criterion (what you can do when it's done) |
|---|---|---|---|
| M0 | Foundations | 6 | Repo, server running on the Droplet with TLS, iPad app signs in with Microsoft, empty build on TestFlight, nightly dump restored once |
| M1 | Core data and sync | 9 | Two simulated iPads edit the same device offline; after sync the same-field edit is in review, different-field edits merged, numbers assigned once; the full conflict matrix (PLAN §4.4) passes automatically |
| M2 | Field loop | 11 | On a real iPad, offline: open 06M, pan/zoom the composite at ≥50 fps, tap a pin, set status, add a photo with markup, edit a connection end and jump to Level 03; everything syncs when back online |
| M3 | Seed import and export | 6 | Import the attached master → export → every data tab diffs clean cell-by-cell (TP-4); file opens in Excel for Mac and Excel Online with Tables, validation and charts intact |
| M4 | Rules, rulings, lint, dashboard, cable view | 8 | Golden tests reproduce the master's generated items (R3c item per group, E5 on a missing LVD, R2f copied statuses); a ruling previews and applies as Change-type Ruling ops; dashboard counts equal the exported Summary |
| M5 | Setup pipeline and library | 9 | From BOM.pdf + riser.pdf + the 06M composite: drafts reviewed with crops, ≥50/54 device keys correct before review (1f baseline), grid auto-calibrates both grid sets, devices placed from the list, level locked |
| M6 | Pilot | 4 | Next floor surveyed by two people in the app; workbook exported and sent to EC/ETC without hand edits; go/no-go recorded |
| M7 | Should items | 5 | Scanner, re-extraction diff, copy floor, P2P spike; MSS when the file exists |

Critical path: M0 → M1 → M2 → M3 → M5 → M6. M4 can interleave with M3/M5 (rules are client-only, D24). The 06M-composite performance test (TP-6) runs in M2's first task, because it decides whether the tile fallback (D19) is built at all.

## 4. Test plan

| ID | Scenario (from the prompt) | Steps | Pass | How | M |
|---|---|---|---|---|---|
| TP-1 | Two iPads edit the same floor offline, then sync | Both cache 06M; both airplane mode; iPad A sets 06M-02 Status → Issue and Notes; iPad B sets 06M-02 Notes (different text) and 06M-03 Status; both add a photo and a field-addition device; reconnect B first, then A | 06M-03 and the photos merge silently; 06M-02 Notes goes to review with B's value official (first-arrived, D37), A's in review; A's Status edit applies (different field); both new devices get distinct IDs and numbers; nothing lost; resolve with Combine → one Reconcile op | Scripted on real iPads (checklist) + automated twin-client harness (T14) | M1 (auto), M6 (real) |
| TP-2 | Survey in airplane mode for a full day | 8 h offline: 60+ edits, 40+ photos, 3 field additions, markup; then sync once | Outbox drains in `client_ts` order; `NEW` rows get numbers; photos upload with thumbnails first; app survives force-quit mid-upload and resumes | Manual on one iPad; upload resume automated (T12) | M2, M6 |
| TP-3 | Large photo set | Synthetic project: 2,000 devices, 10,000 photos (2.5 MB each), 1,500 ops | Plan opens < 3 s; device list scroll smooth; 10,000 thumbnails prefetch for assigned levels < 10 min on Wi-Fi; server storage ≈ 25 GB; export completes < 5 min | Automated generator + timed run | M3 |
| TP-4 | Import-then-export round trip | Import `Lighting_Control_Survey_Master_B2-06_4.xlsx`; export | Cell-by-cell diff of Devices, Connections, Punch List, Missing Parts, Photo Log, Lists is empty except documented differences (D50 spelling, D51 no Change Log tab); Summary values identical; column widths, freeze panes, Table names, validation ranges, chart count/anchors identical | pytest with openpyxl diff | M3 |
| TP-5 | Opens cleanly in Excel for Mac and Excel Online | Open the TP-4 file in both | No repair prompt; dropdowns work in both; row heights/wrap readable; charts render | Manual, checklist with screenshots | M3 |
| TP-6 | PDFKit on the 06M composite | Load `Level_06M_-_Lighting_Composite_vector.pdf` (153K segments) with 40 pins and ink | First render < 2 s on iPad Air M-series; pan/zoom ≥ 50 fps; memory < 600 MB; no `PDFTilePool` crash after 100 zoom cycles | Instruments run, recorded in the task | M2 first task |
| TP-7 | Sync resilience | Network flaps every 10 s during a 500-op push; server restart mid-push; duplicate push | No duplicate ops (idempotent by `op_id`); no gaps in `server_seq`; client converges | Automated | M1 |
| TP-8 | Rule golden tests | Load the master; run the engine | Exactly the master's rule-generated rows appear as accepted/superseded proposals; no extra proposals except those listed as known differences | pytest-style Swift tests | M4 |
| TP-9 | Extraction regression | Run the pipeline on BOM.pdf + riser.pdf | ≥ 50/54 device keys correct, the two known qty conflicts raised as review items, endpoints flagged < 0.7 where 1f said so | pytest, server | M5 |
| TP-10 | Numbering is never reused | Create, delete, create again across two clients | Deleted numbers stay retired; counters monotonic per group; 06 and 06M share | Automated | M1 |
| TP-11 | Delete/restore | Delete a device with punch items on iPad A while B edits it | Review item (delete vs edit); restore brings it back with history intact; orphans linted | Automated + manual | M1/M4 |
| TP-12 | Sign-in and offline | Token expired, iPad offline | All editing works; sync shows "Sign-in needed"; silent refresh succeeds when online | Manual | M0 |

## 5. Pilot: the next floor survey

| Step | Detail |
|---|---|
| Entry | M0–M5 done; TP-1…TP-9 passed; your current project seeded from the master (B2–06M); the next floor set up from BOM + riser, devices placed, level locked and assigned; plans cached on every iPad |
| People | You plus one team member, each on their own iPad, same floor, deliberately overlapping on a few devices to exercise review |
| Method | App is the primary record. Keep the marked-up PDF method ready as a fallback only if the app blocks you; do not run both in parallel (that would double the work and prove nothing) |
| During | Survey normally. Note any moment you reach for the spreadsheet: that is a defect or a missing vocabulary phrase |
| After | Sync both iPads; resolve the review queue; run lint; apply any new ruling; export the workbook and the floor PDF; send to EC/ETC **without opening Excel to fix anything** |
| Measure | Edits that needed Excel afterwards (target 0); review items raised vs expected; rule proposals accepted without edit (target ≥ 80 %); time per device vs your estimate for the old method; crashes (target 0) |
| Go/no-go | Go: workbook accepted by EC/ETC unchanged and no data loss. No-go: any lost edit or photo, or more than a handful of Excel fixes → fix, re-run on the following floor |
| Rollback | Data is never only on the iPad after one sync; the exported workbook is the same format as today, so the old loop can resume from it |

## 6. Internal distribution

| Option | Facts (verified) | Fit |
|---|---|---|
| **TestFlight internal testing (recommended)** | Up to 100 internal testers (App Store Connect team members), each on up to 30 devices; builds stay installable for 90 days; no TestFlight App Review for internal testers; testers are invited under Users and Access with the Developer or App Manager role [1][2] | Team ≤ 5, instant builds, no review. Cost: Apple Developer Program membership (annual). **Rule: upload a build at least every 60 days** so nothing expires mid-survey |
| Unlisted App Distribution | Installed only through a direct App Store link that Apple issues after checking the app qualifies; App Review is part of that [3] | Later, if the 90-day refresh becomes a nuisance |
| Custom app via Apple Business Manager | Hosted on App Store Connect, reviewed by Apple, and the company must be enrolled in Apple Business Manager [4] | More admin than the team needs |
| Ad hoc | 100-device limit and provisioning profiles to manage by hand [2] | No |

**D59** TestFlight internal for the pilot and first year; revisit unlisted distribution after. Each team member needs an Apple ID invited to the LTP App Store Connect team with the Developer role (**G4-6**).

## 7. Hosting recommendation (G2-13) — superseded by §15.1 / D67 after your G4-5 answer

Hetzner's US locations were the cheap option in Phase 2; on 15 June 2026 Hetzner raised US cloud-server prices by about 158 % on average (CPX41 went from €38.99 to €120.49) [5], so it no longer wins. DigitalOcean has US regions and charges the same in every region [7].

| Component | Choice | Verified price (list, 2026-10-09) |
|---|---|---|
| Server (FastAPI + worker + Caddy in Docker Compose) | DigitalOcean Basic Droplet 4 vCPU / 8 GB | $48/mo (160 GB SSD, 5 TB transfer) [6]; 8 GB because tesseract and WeasyPrint on large sheets need headroom |
| Droplet backups | Weekly | 20 % of the Droplet price [6] ≈ $10/mo |
| Postgres | DigitalOcean Managed Postgres, single node | $15/mo (1 GiB single node); daily backups with 7-day retention included [7] |
| Object storage (photos, plans, exports, nightly dumps) | DigitalOcean Spaces | $5/mo for 250 GiB, then $0.02/GiB; outbound beyond 1 TiB $0.01/GiB [8] — one full tower ≈ 26 GB fits in the base |
| Alternative object storage | Cloudflare R2 | $0.015/GB-month, 10 GB free, no egress charge [9]; same S3 API; use if Spaces is ever a problem |
| **Total** | | **≈ $78/mo** (≈ $63 with Postgres self-hosted in Compose instead of managed) |

**D58** DigitalOcean, one Droplet + managed Postgres + Spaces, NYC or SFO region. Backups: managed Postgres daily + nightly `pg_dump` to Spaces (kept 90 days) + weekly master export to Spaces. Blobs are content-addressed and never overwritten, so bucket versioning is not required (**A14**); a weekly `rclone` copy of the bucket to a second bucket covers accidental deletion. Prices are list prices on 2026-10-09; confirm on the provider pages when you sign up.

## 8. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| K1 | PDFKit too slow or crashes on composites (153K segments) | M | H | TP-6 is M2's first task; tile-pyramid fallback (D19) scoped as a task that is only run if TP-6 fails |
| K2 | Riser endpoint extraction accuracy below review tolerance | M | M | Human review per level is in the design; 1f showed 50/54 devices; endpoints always need confirmation (D6) |
| K3 | Export not accepted by EC/ETC ("they notice the switch") | L | H | TP-4/TP-5 cell-level diff against the real master before the pilot; keep the file name pattern |
| K4 | Sync edge cases (clock skew, duplicate pushes, partial batches) | M | H | Server-seq ordering, idempotent `op_id`, twin-client harness (T14), reliability over cleverness |
| K5 | Entra app registration blocked (tenant admin rights) | M | M | Check G4-7 before M0; fallback is a second app registration in a tenant you own |
| K6 | TestFlight build expiry during a survey | L | M | 60-day upload rule; build-expiry reminder in the Sync screen (proposal) |
| K7 | Single developer, Claude Code sessions drift from spec | H | M | `CLAUDE.md` vocabulary and rules are loaded every session; each task's DoD cites PLAN sections; `DECISIONS.md` is append-only |
| K8 | Scope creep from the library editor and field additions | M | M | Library drafts gated by your acceptance (D48); MVP list in §2 is the contract |
| K9 | Photo storage growth and costs | L | L | 25 GB per tower at $0.02/GiB; JPEG only (D38) |
| K10 | iPadOS/Xcode updates break PencilKit/PDFKit overlay | L | M | Pin Xcode version per release; overlay in page coordinates is the documented API |
| K11 | Change Log removal (D51) reverses a written Must | M | L | G4-9 asks you to confirm in writing; one-line change to restore it |
| K12 | Pilot floor date unknown; milestones slip past it | M | M | G4-8 fixes the date; if the floor comes before M5, survey it in the app with hand-placed devices (T44 fallback) |
| K13 | Claude API schema or price changes between now and M5 | L | L | Structured outputs are GA; cost per project ≈ $1 (Phase 1) |

## 9. Task breakdown summary

Full list with definitions of done in `TASKS.md` (62 tasks after the Gate 4 rework; the table below is the original Swift-era split — see `TASKS.md` Counts for the current one). Model and effort policy (**D61**): Fable 5.1 at High for sync, conflicts, export fidelity, extraction, the rule engine and the plan viewer; Opus 5.5 at Medium for ordinary feature work; Sonnet 5.5 at Low/Medium for scaffolding, lists, settings screens, fixtures and docs.

| M | Tasks | Fable/High | Opus/Medium–High | Sonnet/Low–Medium |
|---|---|---|---|---|
| M0 | T01–T06 | 0 | 4 | 2 |
| M1 | T07–T15 | 6 | 3 | 0 |
| M2 | T16–T26 | 1 | 7 | 3 |
| M3 | T27–T32 | 2 | 3 | 1 |
| M4 | T33–T40 | 3 | 4 | 1 |
| M5 | T41–T49 | 3 | 5 | 1 |
| M6 | T50–T53 | 0 | 2 | 2 |
| M7 | T54–T58 | 2 | 3 | 0 |
| Total | 58 | 17 | 31 | 10 |

## 10. Decision log (this phase) and assumptions

| # | Decision | Status |
|---|---|---|
| D1–D48 | Gates 1–3 | Approved at Gate 3 |
| D49–D57 | §1 (G3 answers and defaults) | D49, D50, D52, D53 from your answers; D51 needs G4-9; D54–D57 are defaults pending G4-1…G4-4 |
| D58 | Hosting: DigitalOcean Droplet 4 vCPU/8 GB + Managed Postgres + Spaces, ≈ $78/mo | Proposed, G4-5 |
| D59 | Distribution: TestFlight internal, build at least every 60 days | Proposed, G4-6 |
| D60 | Monorepo `ltp-survey/` (`ios/`, `server/`, `docs/`, `fixtures/`), private GitHub repo, GitHub Actions for server tests only; iOS built and tested locally in Xcode | Proposed, G4-10 |
| D61 | Model/effort policy per task (§9) | Proposed |
| D62 | MVP scope = §2.1; §2.2 deferred | Proposed |
| D63 | The four attachments are committed to `fixtures/` as golden test inputs (private repo) | Proposed |

| Assumption | Label |
|---|---|
| A1–A3, A5–A9, A11–A13 closed earlier; A4 (MSS) unchanged; A10 (setup uploads from the iPad Files picker; no web UI) carried | — |
| A14 Content-addressed blobs are never overwritten, so bucket versioning is optional; a weekly bucket copy covers deletion | needs no answer |
| A15 Milestone sizes are estimates in sessions; calendar time depends on your availability | — |
| A16 LTP has (or will get) an Apple Developer Program membership and an Entra tenant where you can register an app | G4-6, G4-7 |
| A17 The next floor's survey date is after M5; if not, K12 applies | G4-8 |

## 11. Handoff package

| File | Purpose | Where it goes |
|---|---|---|
| `CLAUDE.md` | Loaded by Claude Code every session: project context, exact vocabulary, rules, conventions, how to build and test, session protocol | repo root |
| `PLAN.md` | Normative spec: architecture, data model, sync/reconcile, rule engine, import/export, sign-in, deployment. Condensed from Phase 2/3 with D49–D57 applied; the phase docs go to `docs/history/` for reference | repo root |
| `DECISIONS.md` | D1–D63 and A1–A17, append-only | repo root |
| `TASKS.md` | T01–T58 in order with definition of done, effort, model, dependencies | repo root |
| `FIRST_SESSION_PROMPT.md` | The prompt for the first Claude Code session (T01) | paste into Claude Code |
| `docs/history/` | `Fable_Prompt_Survey_iPad_App.md`, Gate1, Phase1, Phase1f, Phase2, Phase3, this file | repo |
| `fixtures/` | The master workbook, `riser.pdf`, `BOM.pdf`, the 06M composite, `15090056-BOM.pdf` (format example only, D4) | repo (private) |

## 12. Open questions for Gate 4

Each question says what it means, gives an example, and names the default I will use if you answer "either" or don't answer.

| # | Question |
|---|---|
| G4-1 | **Pin colours (from G3-6).** *Meaning:* how a pin on the plan tells you a device's status and its category. *Example:* station `06M-S3` and relay panel `06M-02` are both `Issue` → both pins are red; you tell them apart by the ID text on the pin. *Alternative:* category gets its own colour too (a coloured ring around the pin), e.g. a blue ring for stations and an orange ring for sensors. **Default: status colour only, ID label for category (D54).** If you want category colours, list category → colour. |
| G4-2 | **Field additions not in the library (from G3-7).** *Meaning:* what a surveyor can do when they find a device on site that isn't one of the accepted device types. *Example:* someone finds a `P-TS18-E` touchscreen on Level 07 but the library only has `P-TS7-E`. *Option A:* they must pick the closest accepted type and write "actually P-TS18-E" in Notes. *Option B:* they type `P-TS18-E` freely; the app creates a library draft you accept or reject later (D48). **Default: B (D55).** |
| G4-3 | **Floor PDF layout (from G3-8).** *Meaning:* the per-floor report you send the EC. "Page 1" is its cover page. *Example cover:* title "ETC Lighting Controls Survey — Level 07", "Surveyed 2026-10-20", a table of status counts (Installed, untested 12 / Issue 9 / Not installed 13 / No access 2), and below it the floor plan with the coloured pins. *Photos:* either one photo per page (big) or six per page in a 2×3 grid (compact). **Default: cover with the plan; photos 2×3 (D56).** |
| G4-4 | **Unlocking a level (from G3-9).** *Meaning:* "Lock baseline" is the moment a level's setup is finished and the app starts logging field changes (D13). *Example:* you lock Level 07 on Monday. On Wednesday ETC issues a revised riser that adds a `UFMP4` on 07. To add it as *baseline* (design intent) rather than as a *field addition* (found on site), someone must unlock 07, add it, and lock again. *Option A:* unlock allowed, typed reason, logged. *Option B:* never unlock; late design changes are entered as field additions with a note. **Default: A (D57).** |
| G4-5 | **Hosting.** Confirm DigitalOcean at ≈ $78/mo (D58), or name the provider you'd rather use. Do you already have a DigitalOcean, AWS or Azure account for LTP? |
| G4-6 | **Apple accounts.** Does LTP have an Apple Developer Program membership today? Who on the team has an Apple ID that can be invited to App Store Connect? (TestFlight internal needs each person on the team with the Developer role.) |
| G4-7 | **Entra app registration.** *Meaning:* to use Microsoft sign-in, someone must create an "app registration" in the LTP Microsoft 365 tenant (Entra admin centre → App registrations → New). *Example:* this needs a Global Administrator or Application Developer role. Do you have that role, or does someone else administer your Microsoft 365? |
| G4-8 | **Pilot floor and date.** Which level is surveyed next and roughly when? This sets the target date for M5 and decides whether K12 applies. |
| G4-9 | **Change Log export (D51).** Your original prompt listed the Change Log as a Must in the export; G3-3 says no log at all. Confirm: *the EC/ETC workbook has no Change Log tab; history stays in the app.* Optional: do you want a separate "history export" (a CSV for your own use, never sent to the EC)? **Default: no history export.** |
| G4-10 | **Repository.** Private GitHub repo named `ltp-survey` under your account/organisation (D60)? If you use a different host, say which. |
| G4-11 | **Gate 4 approval.** With G4-1…G4-10 answered, approve Gate 4 to start Claude Code with `FIRST_SESSION_PROMPT.md`. *(Answered 2026-10-09 — see §15.)* |

## 13. Usage notes

This phase ran at High in one conversation with web search used for four lookups. Nothing needed more than High. From here, planning is finished: the next step is Claude Code on your Mac (Xcode required), one task per session, effort and model per task as `TASKS.md` says. Keep this conversation only to record your G4 answers; I'll fold them into `DECISIONS.md` as D-numbers in the reply, then you move.

## 14. Next step block (Claude Code on Windows, not a new chat)

```
Gate 4 approved 2026-10-09.
Create the private GitHub repo field-survey (D68). Copy CLAUDE.md, PLAN.md, DECISIONS.md, TASKS.md to the root;
the phase docs and the original prompt to docs/history/; the master workbook, riser.pdf, BOM.pdf, the 06M composite,
15090056-BOM.pdf and the Lake Dallas punch-list PDF to fixtures/. Commit "Handoff package".
Install on the Windows PC: Git, Node 22, pnpm, Docker Desktop, uv, eas-cli, Claude Code.
Open Claude Code in the repo root. Model: Sonnet 5.5, effort Low. Paste FIRST_SESSION_PROMPT.md.
```

## Sources

1. TestFlight overview (internal tester count, device count, 90-day expiry, no review for internal): https://docs.thunkable.com/publishing-apps/publish-to-app-store-ios/testflight-overview
2. TestFlight distribution guide 2026 (Developer/App Manager role for internal testers): https://techconcepts.org/blog/testflight-guide
3. Unlisted vs custom app channels: https://info.seibert.group/x/PIMXB and https://www.goodbarber.com/help/ios-app-publication-solo-r75/ios-unlisted-distribution-of-your-app-a406
4. Custom app via Apple Business Manager: https://goodbarber.com/help/ios-app-publication-solo-r75/ios-distribute-your-app-privately-as-a-custom-app-a355
5. Hetzner June 2026 US price increase: https://heise.de/-11333037
6. DigitalOcean Droplet prices 2026: https://bestusavps.com/reviews/digitalocean/ and backups at 20 %: https://diyai.io/ai-tools/hosting/digitalocean-pricing/
7. DigitalOcean Managed PostgreSQL pricing (official docs): https://docs.digitalocean.com/products/databases/postgresql/details/pricing/ ; region-agnostic pricing and backups: https://infratally.com/articles/digitalocean-managed-postgres-deep-dive/ , https://infratally.com/articles/aws-rds-vs-digitalocean-managed-postgres-full-cost-comparison-2026/
8. DigitalOcean Spaces pricing (official docs, validated 2026-05-12): https://docs.digitalocean.com/products/spaces/details/pricing/
9. Cloudflare R2 pricing (official): https://developers.cloudflare.com/r2/pricing

---

## 15. Gate 4 addendum (answers received 2026-10-09 21:42–21:44)

### 15.1 G4 answers → decisions

| # | Your answer | Decision / consequence |
|---|---|---|
| G4-1 | Each category gets its own pin shape; colour = status | **D64** Shape = category, fill = status (D46 back in, D54 out). Default shapes: Relay panel ■ · Foundry panel ▢ · EBDK ▬ · Equipment rack ⬢ · NSPS ⬟ · Touchscreen ▲ · Station ● · Sensor ◆ — editable per category; the shape table is my proposal, the principle is yours. Riser mini-map stays out. |
| G4-2 | Library adds should carry into future projects; a library manager without a project | **D65** App-level library (`library_type.project = null`) plus the per-project library; Library screen opens from the Projects list; new projects copy from the app library; accepted project types can be promoted to it. New task T61. |
| G4-3 | Report attached (arrived in a second message); ours should be similar but with more than one item per page | **D66** Dense layout. What the example (Fieldwire punch-list export, 33 pp, 29 items) does per item: category header · `#n – title` · status \| owner \| category · plan sheet name · created date · a plan crop with the pin · the message thread with photos · your red "ETC – Complete" notes added by hand. Ours keeps those elements and packs 3–4 items per page: a compact header row, a 40 mm plan crop with the pin at the right, Notes + thumbnails in the body, Owner/Tracking status/Date closed in a status strip (so "ETC – Complete" becomes a real field, not a hand annotation). Cover page and 2×3 photo appendix (D56) stand. The file goes to `fixtures/` as the layout reference for T59. |
| G4-4 | Option A | **D57 approved.** |
| G4-5 | $78/mo is too much | **D67** ≈ **$25/mo**: one DigitalOcean Basic Droplet 2 vCPU / 4 GB ($24, verified today) running Postgres inside Compose, plus Cloudflare R2 for photos/plans/backups ($0.015/GB-month, first 10 GB free, no egress fees → one tower ≈ $0.25/mo). Dropped: managed Postgres ($15), Droplet backups ($10), Spaces ($5), the 8 GB tier ($24). What you give up: Postgres is backed up by our nightly dump instead of a managed daily snapshot, and the worker runs one job at a time. **Option B, ≈ $1/mo:** the same Compose stack on an always-on machine in your office behind a Cloudflare Tunnel (free tier), R2 for storage and off-site backups. Pick in G5-2. |
| G4-6 | Apple accounts exist; licence obtainable | **D59 approved.** A16 (Apple half) closed. |
| G4-7 | Entra registration is possible; do login last | **D69** Sign-in moves to the start of M6 (just before the pilot). Until then: team-name picker on each iPad + a shared server token (`AUTH_MODE=token`). Same op log either way; interim users merge into Entra users on first sign-in. T03/T04 re-scheduled; new task T60. |
| G4-8 | Not understood | Restated in §15.4 (G5-3) with an example. |
| G4-9 | History stays in the app; no export | **D51 approved**, no history export. |
| G4-10 | GitHub; call it Field Survey | **D68** Repo `field-survey`, app **Field Survey**, Xcode/scheme `FieldSurvey`, bundle id `productions.luminarytechnology.fieldsurvey`. |

### 15.2 Developing without a Mac (your 21:44 message)

**The constraint.** Every native iPad app must be compiled and signed by Xcode on macOS; there is no Windows Xcode. A Windows PC and an iPad can still deliver this app, but the stack chosen at Gate 2 (Swift/SwiftUI, D22) assumed a Mac on the desk. Three routes, with my recommendation second:

| Route | How it works | What changes in the plan | Monthly cost beyond hosting | Dev loop on the iPad | Verdict |
|---|---|---|---|---|---|
| **A. Keep Swift, rent a Mac** | Cloud Mac (MacStadium / MacinCloud / Scaleway) over remote desktop for Xcode; GitHub Actions macOS runners build and upload to TestFlight | Nothing in the package | ≈ $30–100/mo for the cloud Mac (unverified; varies by provider) + Apple Developer Program $99/yr | Slow: no cable to the iPad, so every on-device test is a TestFlight upload (10–20 min); the simulator runs over remote desktop | **Not recommended** — a plan-first field app needs fast on-device iteration for PDF, Pencil and camera work |
| **B. React Native with Expo (recommended)** | TypeScript app; Expo's EAS service compiles and signs the iOS build in the cloud (iOS builds "from any operating system" [10]); you install a *development build* on your iPad once, then every code change loads over Wi-Fi from Claude Code on Windows; EAS Submit pushes builds to TestFlight | `ios/` → `app/` (Expo, TypeScript); `SurveyCore`/`SurveyRules` → `packages/core` and `packages/rules` (TypeScript — the rule engine could later run on the server too); GRDB → `expo-sqlite` (same op-log design); PDFKit → `react-native-pdf` (PDFKit underneath, so TP-6 still applies); PencilKit → `@shopify/react-native-skia` canvas with pressure; camera → `expo-camera`; MSAL → `expo-auth-session` PKCE against Entra (identity only, D8) or `react-native-msal`; VisionKit scan (M7) → `react-native-vision-camera` + OCR plugin. **Server, data model, sync spec, rules, import/export, hosting: unchanged.** | EAS Free plan: a limited number of low-priority builds per month (limit not published on the plans page) [11]; Starter $19/mo gives $45 of priority build credit [11]. Apple Developer Program $99/yr | Fast: JS changes appear on the iPad in seconds; a new native build is needed only when a native module is added (a handful of times over the project) | **Recommended.** Keeps every decision except the language; Claude Code runs natively on Windows; the whole app is testable on your iPad from day one |
| **C. Progressive web app** | TypeScript web app installed to the iPad home screen from Safari; pdf.js for plans, canvas for ink, IndexedDB/OPFS SQLite for the op log; no App Store, no TestFlight, no Apple programme | Larger rewrite of the client plan; no native PDFKit, PencilKit, VisionKit; background uploads only while the app is open | $0 | Fastest (it's a URL) | **Fallback only.** Two risks hit the "never lose data" requirement: iPadOS can evict web storage under pressure, and pdf.js on the 153K-segment composite is unproven. Only if B's Apple/EAS dependencies prove unacceptable, and only after a storage-eviction spike |

**If you choose B (D70), what I will do before Claude Code starts:** rewrite `CLAUDE.md` §2/§5/§6, `PLAN.md` §1 and the client rows of §2–§5, and the client-side tasks in `TASKS.md` (T01, T04, T07, T08, T11, T12, T16–T26, T33–T39, T44–T48, T54, T57 — about 30 definitions of done; numbering and milestones unchanged) plus a new `FIRST_SESSION_PROMPT.md` for an Expo scaffold. Model/effort policy (D61) is unchanged. One session at High for that rework; then T01.

**Windows workstation setup either way:** Claude Code (native Windows build), Git, Docker Desktop (server stack), `uv`, Node 22 + `npx expo` (route B), and the Expo Go / development-build app on the iPad. No WSL required.

### 15.3 Decisions and assumptions added

| # | Decision | Status |
|---|---|---|
| D64–D69 | §15.1 | Approved except D67 (G5-2) |
| D70 | Client built as React Native + Expo (TypeScript), EAS Build/Submit from Windows, development builds on the team iPads; server and all data/sync/rule/export decisions unchanged. Supersedes the Swift/SwiftUI half of D22 and D35's "Swift 6" wording; GRDB → expo-sqlite | **Proposed, G5-5** |
| A18 | Shared token suffices until Entra lands; not acceptable for the pilot | — |
| A19 | The example report is a one-item-per-page Fieldwire export; "similar but denser" is the target | Confirmed by the file |
| A20 | EAS free-tier build volume is enough for the handful of native builds this project needs; Starter ($19/mo) only if it isn't | Needs no answer |

### 15.4 Open questions (G5)

| # | Question |
|---|---|
| G5-1 | ~~Attach the report~~ — received. Nothing further. |
| G5-2 | **Hosting.** *Meaning:* where the server runs. *A:* DigitalOcean Droplet ≈ $25/mo, nothing to maintain in your office. *B:* an always-on PC/box in your office behind a free Cloudflare Tunnel ≈ $1/mo (R2 only); you own uptime, and a power cut or ISP outage pauses sync (field work continues offline, nothing is lost). **Default: A.** *Answered A (22:00) — D67 approved.* |
| G5-3 | ~~Pilot floor and date~~ — answered "no idea" (21:56). A17 closed: the pilot is whichever level comes first after M5; no target date; K12 fallback stands if a floor arrives earlier. |
| G5-4 | ~~Development route~~ — **B approved (22:03), D70.** Package reworked the same evening: CLAUDE.md §2/§5/§6/§8, PLAN.md §1–§7 client rows, TASKS.md (62 tasks, T62 iPhone layout added to M7), FIRST_SESSION_PROMPT.md for an Expo scaffold on Windows; D71–D74 added. iPad-only MVP (D74). |
| G5-5 | **Gate 4 approved 2026-10-09 22:17.** Next step: §14. |

### 15.5 Sources added this addendum

10. Expo — create a development build ("you can also create iOS builds from any operating system"): https://docs.expo.dev/develop/development-builds/create-a-build/ ; Expo blog on iOS development from Windows: https://expo.dev/blog/build-ios-apps-on-windows-with-cloud-simulators
11. Expo plans (Free: limited low-priority builds, resets monthly; Starter $19/mo with $45 build credit): https://docs.expo.dev/billing/plans/
12. Cloudflare R2 pricing (storage $0.015/GB-month, 10 GB free, no egress): https://developers.cloudflare.com/r2/pricing
13. DigitalOcean Droplet prices (2 vCPU/4 GB $24/mo): https://bestusavps.com/reviews/digitalocean/
