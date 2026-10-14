# On-device test log

Archive of finished rounds from [ON_DEVICE_CHECKLIST.md](ON_DEVICE_CHECKLIST.md), newest first. Each round is copied here with the results as Landry filled them in. Earlier checks recorded directly in `TASKS.md` (T07, T17, T64) are not repeated.

## 2026-10-13 — M3 round completed (dev build `ddf99272`, Droplet `15f7656` / migration 0005, `main` d145902)

Landry ran the M3 round sheet (https://claude.ai/artifact/TbM5bqU6V1F1VUZxXK5JMy) on two iPads after T80. Offline 18:28–18:51 (about 25 min; the sheet asked for 2–3 h), battery A 98→95 %, B 54→51 %. 26 pass, 9 fail, 14 skip, 0 not done. The decisions pasted back are the answers the sheet still held from 2026-10-12 (D136 Change, D138 Discuss, D139 Change, the other twelve Accept); all were recorded that day (D148, D149; D138 approved after the explanation), so nothing new is recorded. No checklist Decision line (D140–D143, D145–D147, D151, D157, D158, the TP-3 yes/no) was answered; they stay.

| Step | Result | Saw | Finding |
|---|---|---|---|
| 0-1 … 0-6 | done | | |
| A-1 Fresh project | pass | | |
| A-2 Seed import | pass | Needs review count 8 | the 8 `import_pair` items D126 predicts |
| A-3 Plan sheet (T45) | pass | | |
| A-4 Place the 06M devices | pass, with a note | "I see them unplaced, but this should be in the review section. Otherwise I do not see any other way of knowing what is not placed other than scrolling the whole list. I was able to place them once in the plan view." | The unplaced list per level is **T46** (M5); Landry's note is attached to it in TASKS |
| A-5 Lock 06M | **fail** | Lock baseline is greyed out | Not built: the Lock / Unlock dialog is **T47** (M5); the sheet asked for it early. Follow-up in TASKS: pull T47 forward |
| A-6 Second iPad joins | pass | | also covers P-10 (G-3) |
| B-1, B-2, B-4 … B-9 | pass | B-9: A 30 ops / 5 photos, B 23 ops / 4 photos | |
| B-3 Connections | pass, with a note | "Used C-12 because C-03 is not for device 06M-02. Tested jumping to another floor. Works." | Sheet error (C-03 is not on 06M-02), not a defect |
| B-10 Search and lists | **fail** | "Cable code search (C-14) shows no results on 6M even though both the ERP24 and Equipment rack have both ends of that connection." | `app/src/plan/lists.ts` matches cable *codes* (`X`, `N`…, D109) and the row's text; a connection's number `C-14` is only its label and is not searched. **T88** |
| C-1 Outbox drains | pass | A: under 1 min | |
| C-2 Numbers assigned | pass | | |
| C-3 Merges without review | **fail** | "Ink from only iPad B is showing. Ink from A is gone." | **T87** |
| C-4 Exactly three review items | **fail** | "No sync conflicts listed." | Three deliberate same-field conflicts raised nothing. The server skips review when `head.user_id == op.user_id` (`server/app/sync.py`, D37), and ink is one layer per (sheet, user) (D53) — both iPads under one team name would show exactly C-3 and C-4; that is the first thing T87 checks on the Droplet. **T87** |
| C-5 Resolve | skip | no conflicts to resolve | re-run with T87 |
| C-6 Quarantine (F2) | skip | "Come back to this later." | stays on the T75 checklist section |
| D-1 Import pairs | **fail** | "Unable to complete this in the setup tab. I do not believe those tabs exist." | Not built: the [Pair] / [Not a pair → placeholder] panels are **T44** (M5); `import_pair` items are listed read-only in Needs review (T26 follow-up) |
| D-2 Library draft | **fail** | Library is greyed out | Not built: **T48 / T61** (M5) |
| D-3 History, D-4 Sync screen | pass | | |
| E-1 Pre-flight | **fail** | "I was able to generate the workbook with 4 lint findings. I could not view those findings because lint is grayed out." | The 4 are the import's `import.endpoint` `finding` rows; the Needs review Lint tab lists `review_item(lint)` only and no screen shows `finding` rows before T36 (T31 → T36 note). **T90** |
| E-2 … E-4, E-7 | pass | | |
| E-5 Your edits are in it | pass, partly | "I can confirm new stations/sensor, photos are in." | the Combined Notes could not be checked (C-5 skipped) |
| E-6 Floor PDF (T59) | **fail** | No survey date | The levels were created on the iPad in A-1, so the import skipped them (`seed_import.levels()`: `ref.exists`) and never wrote the Summary's Surveyed date; the header printed "Surveyed —". **T89**, decision **D159** (Proposed) |
| F-1 … F-5 | skip | "No project with this amount of devices exists on the server." | The synthetic project waits on the TP-3 "yes" (T32 Decision line); carried over |
| G-1 T25-4, T25-6 … T25-9 | skip | "I am not sure what is being asked here." | The "Carried over: T25" section of the checklist (downloads with a plan); explained in the reset checklist; carried over |
| G-2 T26-1 … T26-8 | skip | same | The "Carried over: T26" section; covered by C-4 / C-5, which failed → T87; carried over |
| G-3 P-10 (second iPad) | skip | same | Covered by A-6, which passed: **pass** |

Record (H), filled from the results:

| Measure | Value |
|---|---|
| Offline hours (B) | 0.4 h (18:28–18:51) |
| Edits / photos / ink strokes made offline (from B-9) | A 30 ops / 5 photos, B 23 ops / 4 photos; ink strokes not counted |
| Lost after sync (target 0) | iPad A's ink layer on 06M (C-3) |
| Review items raised vs the 3 expected | 0 of 3 (C-4) |
| Excel edits needed after export (target 0) | not reported |
| Moments you reached for the spreadsheet | not reported |
| Crashes (target 0) | none reported |
| TP-3 numbers (F-1 … F-4) | not run |

## 2026-10-12 — M3 round, stopped early (Droplet `2444a69` / migration 0005, new dev build with `expo-document-picker`)

Landry ran the M3 round sheet (sections A–H) after deploying `main` to the Droplet and installing a new dev build on both iPads. Stopped at A-2 because both uploads failed. 1 pass, 2 fail, 49 not done. All 15 pending decisions were answered: 12 Accept, 2 Change (D136, D139), 1 Discuss (D138).

| Step | Result | Saw | Finding |
|---|---|---|---|
| 0-1 … 0-6 | done | | Before-the-round steps: T74/T75, T45, T30/T31/T59/T32 on `main`; Droplet deployed and migrated; new dev build on both iPads; decisions answered |
| A-1 Fresh project | pass | | |
| A-2 Seed import | **fail** | "Unsupported FormDataPart implementation" | Expo 57 installs `expo/fetch` as the global `fetch`; its FormData encoder (`expo/src/winter/fetch/convertFormData.ts`) accepts strings, `Blob`s and objects with `bytes()`, and throws on React Native's `{uri, name, type}` file part, which `app/src/setup/imports.ts` sends. The picker itself worked. **T80** |
| A-3 Plan sheet (T45) | **fail** | "Unsupported FormDataPart implementation" | Same cause: `app/src/setup/sheets.ts` sends the same file part. **T80** |
| A-4 … A-6 | not done | | blocked by A-2/A-3 |
| B-1 … B-10 | not done | | |
| C-1 … C-6 | not done | | |
| D-1 … D-4 | not done | | |
| E-1 … E-7 | not done | | |
| F-1 … F-5 | not done | | |
| G-1 T25-4, T25-6 … T25-9 | not done | | carried over |
| G-2 T26-1 … T26-8 | not done | | carried over |
| G-3 P-10 (second iPad) | not done | | carried over |
| H Record | not filled | | |

Decisions as answered:

| Decision | Answer | Recorded |
|---|---|---|
| D101, D102, D103, D106, D107 | Accept | Approved |
| D124, D126 | Accept | Approved (were Default) |
| D131, D132, D133, D135, D137 | Accept | Approved |
| D136 Punch List "Device" text is stored | Change: "Overall, the devices with no name or non matching names would reach the unresolved tab and need to be sorted or created from new by a human. Name changes of devices should propagate through the app, including the punch." | **D148** (amends D136) → **T81** |
| D138 Export conventions the plan left open | Discuss: "I do not understand what your asking" | Stays Proposed; explained in plain words in the session reply |
| D139 Weekly master export runs on its own | Change: "Let's do an export backup every day instead of every week." | **D149** (amends D139) → **T82** |

## 2026-10-12 — round of 2026-10-11 completed (dev build `5975c04e`, `main` d9b4d91)

Landry ran the sheet (https://claude.ai/artifact/Bu78oW1sECp53FYguBJMAe) after the T41 deploy and the Tower seed import. 54 pass, 1 fail, 17 skip, 0 not done. No Decision line was answered, so D127, D123 and D111–D115 stay Proposed. Most skips have one cause: a level without a display sheet does not open from the Levels screen, so no real level could be opened (T71); plan-dependent steps wait for T45.

| Step | Result | Saw | Finding |
|---|---|---|---|
| S-1 … S-3 | pass | | |
| P-1, P-2, P-4, P-5, P-9 | pass | | |
| P-3 | pass, with a note | Keyboard covers the Add level field and the page cannot scroll to it. Enter should keep focus in the field and scroll down so floors can be added in a row | **T66** |
| P-6 | pass, with a note | Remove the description under the page header | **T66** |
| P-7 | pass, with a note | "far end" under a switched-off In scope is unclear; asked what numbering groups are | Explained in the session reply; label and an inline explanation in **T66** |
| P-8 | pass, with a note | Remove the "each field saves when you leave it" note | **T66** |
| P-10 | skip | | second iPad not used; carried over |
| P-11 | pass, with a note | The In scope switch is hard to hit and does not always register; asked what "Split of" does | Explained in the session reply; larger hit area and inline help in **T66** |
| P-12 | pass, with a note | A change made on the server took 20–30 s to show; wants it faster | The engine syncs every 60 s while open, plus on foreground and after a local edit. **T67** |
| T25-1 … T25-3, T25-5, T25-10 … T25-12 | pass | | |
| T25-4, T25-6 … T25-9 | skip | "Can't do yet. There is no plan." | Need a real level that opens (T71) and, for downloads, a display sheet (T45); carried over |
| T26-1 … T26-8 | skip | | Need two iPads on a real level (T71); carried over |
| T20-1 … T20-3, T20-5 … T20-8 | pass | | |
| T20-4 | pass, with a note | Not every device has a Neuron ID (equipment rack, NSPS); needs an on/off per library device type | **T68** (library flag; the R3c Neuron ID item must respect it) |
| T20-9 | pass, with a note | The keyboard does not cover the field but covers the Neuron ID Save button | **T66** |
| T21-1 … T21-4 | pass | | |
| T21-5 | **fail** | Photos linked to a connection don't link to the connection; they link to the device no matter what | The photo row does store `cable_end_id` (one link per photo plus its device, D112), but the end editor has no photo strip and the card's thumbnail shows no link, so the link is invisible. **T65** |
| T21-6 | skip | | needs a real level (T71); carried over |
| T22-1 … T22-7 | pass | | |
| T23-1 … T23-5, T23-7 | pass | | |
| T23-6 | skip | | needs a real level with a plan (T45); carried over |
| T24-1 … T24-4, T24-6 | pass | | |
| T24-5 | pass, with a note | Wants to pan with two fingers while ink is selected | **T69** (native patch, new dev build) |
| T24-7 | pass, with a note | Wants the long-press menu to show before lifting, dragging to fine-tune the spot, and the blue dot draggable after the menu is open | The first two were built for build `5975c04e` (`pageLongPressMove`/`End`); they did not show in this run. **T70** checks why and adds the draggable dot |
| T24-8 | skip | | needs two iPads on a real level with a plan; carried over |

## 2026-10-11 — partial pass, stopped early (dev build `5975c04e`, `main` 4349ca0)

Landry ran the sheet (https://claude.ai/artifact/XhE69ZqWx7osFK6bdPqVTp) up to T25 and T20-1, then stopped because sync looked wrong. 8 pass, 3 fail, 12 skip, 38 not done. No project existed on the iPad (that arrives with T41), so sync had nothing to do; the demo plan lives in its own never-synced database (D101).

| Step | Result | Saw | Finding |
|---|---|---|---|
| S-1 … S-3 | pass | | |
| T25-1, T25-2 | pass | | |
| T25-3 | **fail** | turning off Wi-Fi and cellular does not stop it saying synced and online | With no project the engine made no request, so it never learned it was offline. **Fixed:** a cycle with nothing to sync now pings `GET /health`; the Connection section says why "Synced" is vacuous without a project. The step also used the demo plan for pending edits, which never counts: step rewritten (real level only). |
| T25-4, 6, 7, 8 | skip | | need a real level |
| T25-5 | **fail** | stays as "Downloading plans for your assigned levels", no change after | The message was a fixed string; nothing was downloadable. **Fixed:** the button is greyed with no levels and the message states how many files were queued. |
| T25-9, T25-10 | pass | | |
| T25-11 | pass, with a note | the login background is dark and the text is black, impossible to see | iPad in dark mode: the Connect/Picker screens had no background or text colour. **Fixed:** explicit light colours. Follow-up: `userInterfaceStyle: "light"` in `app.json` (needs a build) so no screen inherits a dark window. |
| T26-1 … T26-8 | skip | | need two iPads on a real level |
| T20-1 | **fail** | log line shows up but says not synced on the status box | Expected on the demo (never syncs); step text clarified. Not a defect. |
| T20-2 … T24, decisions | not done | | |

Fixes committed the same day (see TASKS.md "2026-10-11 iPad round" follow-ups). The round continues on the same sheet once T41 puts a project on the iPad.

