# Functional test plan for the Mac rig (after T151)

What the Maestro flows should cover next, in the order that buys the most safety before the pilot,
and which lines of `docs/ON_DEVICE_CHECKLIST.md` (277 open on 2026-11-03, mirrored by the ROUND-1102
sheet) each flow takes off Landry's list. Each item is one flow (or one `rig.sh` orchestration) that
a later task writes, with the `testID`s it needs. §5 is what stays on the iPad whatever we do
(CLAUDE.md §7 5a).

## 1. Covered today

| Where | What is proven |
|---|---|
| `smoke.yaml` | connect (all three gate states, re-sign-in), new project with 06M, open the level, sync |
| `setup.yaml` | DaVinci library and the 06M sheet uploaded from the Files app and processed by the worker; three hand device drafts accepted / edited / rejected; one pin placed; the card's status, note and a quick-action punch item; sync |
| `rig.sh two` | one project on two simulators as two users: B sees A's status and note, sets another status, A sees it |
| vitest (core, rules, app) | the store, op log, sync client, rules R1–R5 and E-rules, screen models |
| pytest (server) | sync, numbering, extraction jobs on the fixtures, export round-trip (TP-4) |
| iPad rounds (`docs/on-device-log.md`) | hand-tested once each, not repeated since: ink, photos, long-press, cable view, lint, rulings, dashboard, export, lock, assignments |

The last row is the gap: everything there was tested by hand on one date and has no regression
check, and the checklist's 277 open lines are the hand checks nobody has had time to run.

## 2. Infrastructure first (one task, before any wave)

- **`seed.yaml` + `rig.sh seed`:** import `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx`
  through Setup → Seed import (Files picker, mapping preview, Import, "Imported"), then Vocabulary →
  Load standard lists / values (T40, T112). Fixed project name (`Maestro master`), made once per server
  lifetime (`server reset` clears it; `seed` skips when it exists). This is the checklist's "Tower
  round project": 210 devices, 80 cables, 215 punch items, 85 parts, the 12 unpaired far ends, the 13
  "Device → link" review items. Most flows below open it instead of making data by hand.
- **`pipeline.yaml` + `rig.sh pipeline`:** the checklist's `pipeline test` project: a scratch project
  B2–06M with `BOM.pdf` and `riser.pdf` uploaded (no Claude key on the rig: the riser's far ends come
  back empty, which is what the endpoint-picker checks need anyway) and the 06M sheet. Made once per
  server lifetime like the seed.
- **`rig.sh scale`:** the TP-3 synthetic generator (T32) against the local server, for the export
  card / cancel / second-iPad checks (T93) and the scale wave.
- **`rig.sh media`:** `xcrun simctl addmedia` puts two PNGs in the simulator's photo library, so
  `🖼 Library` on the card and `+ Photo here` have something to pick (the camera does not exist on the
  simulator).
- **Status bar as a selector:** the bar carries `accessibilityLabel="Sync status"`; flows assert its
  text (`Offline · n pending`, `Syncing…`, `Synced …`, `· n need attention`) through it.
- **Counts as text:** the plan's tabs read `Devices n`, `Conns n`, `Punch n`, `Parts n`; Lint's title
  `Lint (n open · m dismissed)`; the cable view's footer; the dashboard's as-found line. Flows assert
  those after each action instead of reading lists.
- **Log lines as assertions:** `[rules] run`, `[plan] ink: merged …`, `[sync] synced` are in the
  app's log file; `rig.sh log [A|B]` copies it out of the simulator's sandbox so a flow's last step
  (or the orchestration) can grep it. Replaces every "Metro shows …" line in the checklist.
- **`rig.sh conflict`:** a three-run orchestration (A edits offline, B edits the same field offline,
  server back, both sync) for wave 3; parametrised by the flow that makes the edit, so the library
  stream (T61), a ruling (T37) and a plain field reuse it.
- **Alerts and pickers:** the patterns from T151 (`rightOf: Cancel`, `_pick-wait`, `rig.sh files`).

## 3. Waves

Each row names the checklist sections it retires (their open lines move to "Claude ran" once the
flow is green; Landry keeps only the lines in the last column).

### Wave 1 — the field loop (what a surveyor does all day)

| # | Flow | Steps and assertions | Checklist it retires | Stays with Landry |
|---|---|---|---|---|
| F1 | `ends.yaml` — end editor and the rules | On the seeded project open a connection from a card → **This end** `Not installed` → `DRAFT ⚑ R3a Run <signal> to …` on the card → Accept → `Punch n` +1, and `DRAFT ⚑ R4b <kit> - … run` → Accept → `Parts n` +1 with `src #n` after a sync. Then `Issue` + chip "Run, not terminated" → the R3a Terminate draft; "…; no term kit" on DMX → R3b `Missing part · EC/ETC`. Both ends `Not installed` → one Run draft only, on the start of the run; accepted item stands when the end flips back (T35). 120V on an NSPS → `Run 120V to P-NSPS-D Power Supply`. Findings line on the card (`Installed, untested with outstanding wiring…`). **Other end** jump → the other level's plan. Change placeholder… / Add & use on a placeholder end; remove guard in Vocabulary (T40). | T34 (Not installed end, R3b→R4b, findings, two iPads one row with `rig.sh two`), T35, T40 endpoint picker and guard, T118 kit chips per code, T103 unpulled run → two kits / no second kit / placeholder gets one | T34 "First run on the Tower" counts; whether the wording is right |
| F2 | `lists.yaml` — punch, parts, Conns | Punch tab: open an item, tracking `Open → Closed`, owner chip; Parts tab: `Needed → Ordered`; the "Missing all Device Neuron IDs" item is last and its Notes shrink when a Neuron ID is typed (T34 upkeep, T68, T146); Conns rows read `<this end> ↔ <other end> · <status>`; search `C-14` → one Conns row and both end devices under Devices; a device-ID search lists only that device (T95). Punch side list shows the device's derived room text; a Room change follows at once with no punch-item history (T81 "Lists" / "rename"). | T95 (all), T81 lists / rename, T34 Neuron upkeep, T68 card hides / item leaves them out | — |
| F3 | `additions.yaml` — long-press and the card's menu | `longPressOn: point` on the sheet → `+ Device (field addition)` → the eleven category chips in D196 order (T112) → type search → `Add device` → the card opens with `06M-?` + `NEW`; after a sync the ID; a `Test station` type gives `<level>-S<n>` (T112 "ID letters"). `+ Note here`. `⋯` → `Move pin…` → tap → moved; `Place pin…` on a pinless device (T81 "Place"); `Put back in the unplaced list…` ("Placed by mistake" prefilled) → Deleted, pin gone, the unit back in Place devices (T139 "From the card"); `Delete…` with a reason → `Restore…`; History shows each with who / when / reason (R6). Quick actions: all four (`Non-ETC device` → `Not installed` + the EC item; `Relocated` → "; moved from …"; `Not found on site` → `Not installed`, no item, no second "Not Installed." on a second tap, Dashboard `never found` +1). | T112 category picker and ID letters, T139 "From the card", T101 (all three), T34 quick actions, T81 "Place the new device" | the long-press feel and timings (T92) |
| F4 | `place.yaml` (extend) — placement, undo, proposals, flags | Undo in the panel (draft and master device, only the latest, gone after ◀ Done placing); place a draft with a waiting cable → the far card shows "(draft on 06M, not placed yet)" → Undo → still waiting → place again → one cable (T139, T136 "Placing links it"); Flag: not on this sheet → Flagged row → Move to… another level / "Pool, every level" after one unit placed; Review drafts shows `project_pool` / `manual` (T143); entry points: Needs review's "Place on the 06M plan ▸", the Devices tab's `Place ▸`, ⊕ Place (T46); two iPads place two units of one pooled draft offline → two devices, pool −2, nothing in review (`rig.sh two` variant, T46). Dashed pins: the panel's "n to place from drafts" count and "Nothing written by a proposal" (leave without confirming) (T140 last line). | T139 (all), T143 (all), T46 entry points + two iPads, T136 "Placing links it", T140 "Nothing written" | T140's other five lines (are the proposals *right*: positions, variants, guesses) |
| F5 | `photos.yaml` — library photos | Card → `🖼 Library` → pick → thumbnail; `Photos waiting 1` on Sync → 0 after sync; link the photo to a second device (T65 behaviour on new data); `+ Photo here` from the long-press menu; `_resume` while an upload is queued → it finishes, nothing twice (T21). | T21 upload resume, T25 "Retry failed uploads" greyed | camera, markup with Pencil, T65 observation on the Tower |
| F6 | `ink.yaml` — markup | `✎ Ink` → a `swipe` draws a stroke → Layers → `Ink (all users)` off / on; B sees A's ink after sync; same name on both, both offline, both draw → after both sync A's and B's strokes survive and the log reads `[plan] ink: merged 1 concurrent write(s)` (T87, with `rig.sh log`). Proof of the drawing itself is a screenshot diff (Skia), so the pixel check stays low priority. | T87 (with the log line) | pressure, palm rejection, two-finger pan while drawing (T69) |

### Wave 2 — setup, the rest

| # | Flow | Steps and assertions | Checklist it retires | Stays with Landry |
|---|---|---|---|---|
| S1 | `seed.yaml` | see §2; the mapping screen (`Re-check with this mapping`, a wrong column flagged), `Open Needs review` after the import, the 13 `Device "…" → link` items: Link (filter `S1`, note "Linked: …"), `Create device ▸` → a relay panel `04-? (new)` (T81); the 10 `X item → which connection?` rows: the ends offered are the X ends only, "Put on" C-07 leaves the row and the item keeps its number, "Keep on the device" (T122). | T81 "Review items", "Link", "Create device", T122 (all) | T81 export column content |
| S2 | `pipeline.yaml` + `drafts.yaml` (extend) | `BOM.pdf` → "Done: n device drafts …"; `riser.pdf` → "far ends to pick" > 0; Cables tab → Change… → search `P-NSPS-D` → the draft listed once as `P-NSPS-D (draft, 03) … · riser: …` → pick → `Confirm endpoint ✓` → history reason names the draft's model (T137); a cable to an unplaced draft is made at once: the placed card shows `→ … (draft on 06M, not placed yet)`, the end editor has this end editable and the far end greyed, `Not installed` → Run draft, no "missing far end" lint, Cables side B reads the draft (T136); `Accept all ✓ ≥ 0.9` alert; the mismatch list under the table, settled lines gone, Reopen brings one back, an N cable draft to an NSPS draft clears its N line (T133, T44 "Mismatch list"); Excluded BOM lines → Promote (T44); a source crop opens full screen and Close returns (T129 "Enlarge" minus the pinch); accepted offline → found by file name after sync (T106 "Accepted offline"). | T136 (all but Export), T137 (all), T133 (all), T44 (mismatch, excluded, second iPad), T106 "Cached" / "Accepted offline", T124 "Everything else keeps working" (upload the 02 Concourse PDF while B syncs and opens a plan) | pinch / pan / double-tap on crops (T129, T134, T135, T106 "Pinch"), T106 "Page 2", "Focused and outlined" (is the *right* bubble outlined), the riser's Claude endpoints |
| S3 | `lock.yaml` — baseline, assignments, rules tab | 6 Lock baseline → lock 06M (dialog) → `🔒 Locked` on Levels, B sees who locked after a sync, offline lock queues (T47); an edit after the lock lands in History as Field survey with a reason; unlock. Assignments: tick 06 × Ann → on Ann's Levels 06 carries ●, `Assigned to me` filters, `Download assigned levels` fetches only hers, B unticks and A follows (T97, T25). Rules tab: "All on the built-in defaults", `Only what is changed` empty; R3a Termination owner `N` → `EC` → open draft follows, accepted item does not, row "changed" + Reset to default; a rejected Run draft returns once Run item text changes to `Pull <signal> to <far end>`; Signal word `ZZ` appears in every per-code table; quick-action owner `EC` → Spot-check item reads `EC`; B's Rules tab shows the same after a sync (T102). Review accepted items ▸ box: n items, the pre-filled ruling (`Reword from the rule · Owner`), untick one → Apply → the box lists the one left; a hand-edited item stays out; a wording change gives one entry "(n wordings)" → the reword ruling: Preview rows with each far end, hand-edited and pulled runs named in the footer, Apply, stored with no Standing switch, `Preview again` empty (T116, T120). R4b kit toggles per code; `N` off → network kit drafts go, a network kit part flagged in Lint; per cable `Termination kits` Yes / No / As X (T103, T118 "Turning network kits off", "One cable's own setting"). R3c: item texts, owners, the three per-code tables; DMX owner → ETC on open drafts only (T146 "Rules tab"). | T47, T97 (all), T25 "Download assigned levels", T102 (all), T116 (all), T120 (all), T103 "The setting", "Per cable", "Per code", "Second iPad", T118 (all), T146 "Rules tab" | — |
| S4 | `library.yaml` — library, vocabulary, chips | Library: `+ New type` `P-NSPS-D-KIT` (duplicate refused), aliases, ID scheme, default cable 120V, optional N and accessory `Back box`, Save → "Saved." and kept; Accept draft → "will offer … to 4 devices"; an NSPS card shows `R2g cable` with **why?** naming the type → Accept → the connection; a template edit follows open drafts; Reject → Rejected, Back to draft; `+ add N → switch` and `+ add Back box` on the card, defaults first; Copy from… another project; B sees it (T48, T105). Neuron / IP / DMX rows `By the wires · Needed · Not needed`: EBDK → Needed → back on the Neuron item's Notes (T68 override, T146 "Library editor"). App library: the DaVinci drafts → `Accept all n`; a hand-made `P-TS7-PE` + a re-upload with Retire off → "1 model clash" (T111); Promote to app library; a pull refreshes an open, unedited form (T125). Suggestions: Load standard suggestions ("Added 21 …", then "all here already"), Station chips first on a station card and absent on a panel, a type's own chip first, X / N end chips, the draft Edit form's item chips, Copy from app library, Promote with the type, B after a sync (T99). Vocabulary: Load standard lists (+ "already here"), add / accept / edit / remove a note phrase, duplicate refused, chips follow on the card; Device types: add `Echo relay panel` → the card's Type chip → header and pin label; Pin shapes: Station → Square ("shares its shape"), B follows, back to Circle (T40, T104). The rename ruling after Load standard values: `Value outside vocabulary` findings → Fix all via ruling → five renames → quiet lint, roles survive (pins by shape: screenshot) (T112). | T48 (all), T105 (all), T61 "Second iPad", T68 "Per-type override" / "Second iPad", T111, T125, T99 (all), T40 (all), T104 "Device types", "Pin shapes", "second iPad", T112 "Load standard values", "The rename ruling", "Roles survive" (minus the shapes' look) | the shapes as drawn (pins and the floor PDF, T104 "on the floor PDF"), T112 "Floor PDF and export" |
| S5 | `sheets.yaml` — floor plans, sources | `Replace…` the 06M sheet with the same PDF → pins and ink where they were (T77); `Add…` a source sheet → `Boundaries (source sheets)` layer (T78); a level with no grid → "needs …" → `⌗ Grid` by two taps; DaVinci upload with the new `DaVinci_categories.xlsx` → "n categories corrected", ERn types under Equipment Panels, a hand-set category stays, Lint "Category differs from its type" → Fix all via ruling (T144); a second DaVinci upload with a hand-set Neuron flag → the flag stays (T130). | T144 (all), T130, T77 / T78 when they land | — |

### Wave 3 — offline, conflicts, resilience (the data-loss risks)

| # | Orchestration | Steps and assertions | Checklist it retires | Stays with Landry |
|---|---|---|---|---|
| O1 | `offline.yaml` | `rig.sh server stop` → status bar `Offline`; set a status, a note, an IP and a DMX address, accept a draft, lock a level, Confirm endpoint, dismiss a finding → `Pending edits n` on Sync, every screen still opens (Dashboard, Cables, Lint, Rulings on local data); `server start` → `Synced`, pending 0; the server holds them all. The app never blocked an edit. | T146 "Offline", T39 "Offline", T38 "Offline", T47 "Offline", T106 "Cached" | true airplane mode, cellular |
| O2 | `rig.sh conflict` | A (Ann) and B (Bob) both offline; both set the same device's status differently; server back; A syncs first, then B: A's value is official, the card on both shows the "in review" badge, Needs review lists the field with `A (official now)` / `Choose B` → choose B → both agree, badge gone (D37, per-field). Same with the app library (aliases on one type → `1 in review ▸` in the library header, T61) and with a ruling applied on A against a hand edit on B (T37 "Two iPads"). | T61 "Conflict", T37 "Two iPads", T36 "Two iPads" (a dismissal syncs, Needs review stays empty) | — |
| O3 | `same-user.yaml` | A and B both as Ann, same field offline: no review item, last write stands (D37); both inks survive (F6). | T87 | — |
| O4 | `resume.yaml` | an edit, then `_resume` (kill and relaunch) before the sync: the outbox survives, pending count unchanged, then syncs; re-sign in keeps the edits (T25); photos resume (F5). | T21, T25 | — |
| O5 | `pickup.yaml` | B's edit reaches A without tapping Sync now (T67's faster pickup) within the poll interval; A's open, unedited library form refreshes (T125); A on Levels keeps scrolling while B's three alias edits arrive, then the timing line reads `3 pulled` and `[rules] run` once per project in the log (T131 "No stall" — functional half). | T125, T131 "No stall" (minus the feel) | T131's launch and cycle timings on the iPad |
| O6 | `restart.yaml` | `docker compose restart api` during a large push (the scale project): no `need attention` ops, numbering continues; if a refused edit ever appears the Sync screen lists it with Retry (T75 — cannot be provoked, so only the "nothing refused" side). | T75 (negative side) | — |

### Wave 4 — review screens and outputs

| # | Flow | Steps and assertions | Checklist it retires | Stays with Landry |
|---|---|---|---|---|
| R1 | `lint.yaml` | Seeded project: title `Lint (n open · 0 dismissed)`, `Cable with missing far end (12)`, level chip, Group by → Level, fold a group, `Open card ▸` → the plan; `Dismiss…` stays disabled until a reason, `Checked on site: correct as is` → Show → Dismissed with the reason; the facts change (status away from Issue and back) → open again; `Reopen`; `Fix all via ruling ▸` on `Value outside vocabulary`; the links from Needs review and Export (T36). Drafts with no device: `· n drafts`, the R3c / R2e rows, why?, Open card ▸, Save & accept / Reject, level filter (T100); "IP address item missing" / "DMX …" checks and their R3c drafts, Accept one of each → last on the punch list (T146 "New drafts"); "Linked to a deleted device or connection" after R4's delete. | T36 (all), T100 (all), T146 "New drafts in the Lint view", T103 "Per code" lint flag | — |
| R2 | `rulings.yaml` | Title `Rulings (n standing · m applied)` with the D50 one; `+ New ruling` with the red "missing" lines until filled; Preview with an untick (`· 1 unticked`), Back keeps the editor, Apply → History `Ruling` with the reason, Preview again empty and names the unticked record; Standing: a new 0-10V row → `Proposed by this ruling (1)` → Accept / Reject, untick Standing → gone; Rename phrase (and the vocabulary footer); Generate item once, Append note never twice; from Lint (pre-filled), from a plan list's Select → `Apply as ruling…`, from Cables and from a Dashboard drill-down; Copy as new; Delete… with a reason (T37). | T37 (all but "Two iPads" → O2), T39 "Apply as ruling", T38 "Apply as ruling from a drill-down" | — |
| R3 | `dashboard.yaml` | Header, chips, four tables; drill-down on a cell / Total / grand total opens the panel with the right count and a row opens the card; Level and Owner filters (`EC` ≠ `EC/ETC`); as-found line (`field additions n · never found n · Neuron IDs captured n/169 · IP n/9 · DMX n/16` on the seed) and each drill-down; counts follow a typed address; Levels filter narrows them; readiness `setup` → `ready` after a lock → `surveying` after an edit; search by ID, room, note phrase, Neuron ID, `#12`, `c-14`, `dmx`, an IP (partial too), a DMX address (and no longer after it changes); Close (T38, T147, T148). The counts equal the master's Summary on a fresh seed: assert the fixed numbers (210 / 215 / 85 and the splits). | T38 (all but Charts' look and TestFlight), T147 (all), T148 (all), T68 "Dashboard", T101 "Dashboard" | the charts' colours and redraw on rotation; the TestFlight check (release build) |
| R4 | `cables.yaml` | Title `Cable / riser (80)`, the footer counts, Group by Vertical / Level / Code and folding, row format (`Unsurveyed`, `⚠ missing end`, `ⓡ`), chips + `☑ only` → `(shown of 80)`, footer tap filters; row → end editor in the side panel with ◀ Cables, a far-end status change updates the row and footer; `Jump to …`; `Confirm endpoint` → one less, cable change `Riser cross-check`; `Open Needs review item ▸` (T39). Delete from the card (`⋯` → reason → Delete → gone from Connections and Conns), History `Connection deleted` + `Restore…` → back with status and note, the far device's History too, delete from the cable view (side panel text, DELETED in the editor), nothing re-proposed, an accepted item on it flagged in Lint (T138). | T39 (all but Riser crop and Offline → O1), T138 (all but Export) | T138 "Export" content |
| R5 | `review.yaml` | Needs review on the seed: the 12 Import pair items; `Set value` on a vocabulary row; `Save combined` on a merge; `Create device for this punch item`; the links to Lint, to Review drafts ("Extraction drafts: n …"), to Place devices (T26, T46 entry points). | the Needs review lines spread over T36 / T39 / T46 / T81 | — |
| R6 | `export.yaml` | `Start` / Generate disabled until `Synced` and while the outbox has ops (D94), `Sync first`; `Generate workbook` → the card's stage line and ticking time → leave and come back → same card; on B the same card "Started by Ann", Generate disabled with "An export is already running", floor PDF still allowed; Cancel from B → `Cancelling…` → `Cancelled by Bob` on both; run one to `Ready · <size>` → History row (T93, on the scale project); the Floor PDF header line `… — Level 06M · Surveyed <date>` (newest edit, else today; a set date wins, T89 / T91); `See the n lint findings ▸`; the files exist on the server (size > 0). | T93 (all but the minutes), T89 "Export screen header line", "A set date wins", T91 | the PDF's pages and tables (T89 "PDF header"), the workbook's content (T81, T136, T138 "Export"), minutes on the Droplet (T32 / T94 / T98) |
| R7 | `projects.yaml` | two projects on one iPad: the home's chips switch and every sidebar screen follows (T83); `Refresh from server` → download; a two-way numbering share and a chain are named in the form and refused by Create; a refusal reads the server's reason (server stopped: "not reachable") (T142); `Open the levels screen ▸`, `◀ Projects`. | T142 (all), T83 | — |

### Wave 5 — scale on the simulator (regression only)

`scale.yaml` on the `rig.sh scale` project plus `500 pins →` on the demo plan: the Sync screen's
timing line, `[rules] run` and `[sync] synced` `ms`, `[plan] sheet_loaded` on 06M stay under a
ceiling set from the first green run. Not transferable to the iPad (ops §6.4), but a doubling shows
up. The export's minutes on the local server are a regression number, not T94's Droplet number.

## 4. Checklist sections → where they go

Every open section of `docs/ON_DEVICE_CHECKLIST.md` on 2026-11-03, and who proves it once the
flows above exist. "rig" = all its lines; "part" = the flow takes the lines named in §3 and the rest
stays; "iPad" = nothing the rig can do.

| Section | Who | Flow(s) | What the iPad still proves |
|---|---|---|---|
| T92 long press timings | iPad | — | the native timing lines and the feel |
| T89 / T91 survey date | part | R6 | the PDF's pages |
| T93 long export, cancel, second iPad | rig | R6 (+ `rig.sh scale`) | — |
| T32 / T94 / T98 export minutes | iPad (Droplet) | wave 5 as a regression number | the real server's minutes |
| T81 Punch List Device text | part | S1, F2, F3 | the workbook's Device column |
| T84 OTA leftovers | iPad | — | TestFlight: offline catch-up, rollback |
| T87 one name, two iPads' ink | rig | F6 + O3 | — |
| T47 lock offline, other iPad | rig | S3 + O1 | — |
| T25 Sync screen leftovers | rig | S3, F5 | — |
| T21 upload resume | rig | F5 + O4 | — |
| T75 a refused edit | part | O6 (nothing refused) | a real refusal, if one ever happens |
| T65 imported multi-device photos | iPad (Tower data) | — | the observation on the Tower |
| T33 rule drafts on the demo plan | rig | F1 (on real data; the demo plan's buttons are the same code) | — |
| T34 rules on real data | part | F1, F2, F3, `rig.sh two` | the first run's counts on the Tower |
| T35 one draft per wire, 120V | rig | F1 | — |
| T36 lint | rig | R1 + O2 | — |
| T37 rulings | rig | R2 + O2 | — |
| T39 cable view | rig | R4 + O1 | the riser crop's picture |
| T38 dashboard | part | R3 + O1 | the charts' look, rotation, TestFlight |
| T40 vocabulary | rig | S4, F1 | — |
| T48 library editor | rig | S4 | — |
| T61 app library two iPads, conflict | rig | S4, O2 | — |
| T68 Neuron ID per type | rig | F2, S4, R3 | — |
| T105 optional cables, accessories | rig | S4 | — |
| T44 review drafts leftovers | rig | S2 | — |
| T106 riser crop | part | S2 | focus, outline, pinch, page 2 |
| T111 DaVinci clash | rig | S4 | — |
| T112 roles and categories | part | F3, S4 | the shapes as drawn, the floor PDF and export |
| T46 place devices leftovers | rig | F4 | — |
| T95 connection search | rig | F2 | — |
| T97 assignments two iPads | rig | S3 | — |
| T100 drafts with no device | rig | R1 | — |
| T101 Not found on site | rig | F3 | — |
| T102 rule settings | rig | S3 | — |
| T99 suggestion chips | rig | S4 | — |
| T103 termination kits | rig | F1, S3, R1 | — |
| T104 vocabulary follow-ups | part | S4 | pin shapes as drawn, on the floor PDF |
| T116 review accepted items | rig | S3 | — |
| T118 kit chips | rig | F1, S3 | — |
| T120 reword ruling | rig | S3 | — |
| T122 imported cable item on its end | rig | S1 | — |
| T125 library editor pull | rig | O5 | — |
| T131 slow during sync | part | O5 (no stall), wave 5 | launch and cycle timings on the iPad |
| T124 large sheet, server memory | part | S2 (the rest keeps working) | the Droplet's worker cap |
| T130 DaVinci Neuron flag | rig | S5 | — |
| T126 accessories as drafts | — | covered by app tests (its own note) | a pre-T126 project only |
| T129 / T134 / T135 crops: pinch, pan, outline | part | S2 (open, close, cached, offline) | pinch, pan, double-tap, the outline on the right bubble |
| T136 waiting cable made at once | part | S2, F4 | the export row |
| T133 mismatch list | rig | S2 | — |
| T137 endpoint labels | rig | S2 | — |
| T138 delete a connection | part | R4 | the export |
| T139 undo a placement | rig | F4 | — |
| T140 dashed proposals | part | F4 | whether the proposals are right (five lines) |
| T141 heavy sheets | iPad | wave 5 (`sheet_loaded` ms as a regression) | speed, smoothness, memory, legibility on the hardware |
| T142 new project refusals | rig | R7 | — |
| T143 move a flagged draft | rig | F4 | — |
| T144 ERn → Equipment Panels | rig | S5 | — |
| T146 addresses follow the wires | part | F2, R1, S3, S4, O1, plus a card flow for the address inputs (`10.101.4.23/24` refused … `1/513` refused, duplicate IP → Save anyway → Lint) | the Tower consequence in D247 (which real panels carry a Neuron ID) |
| T147 dashboard addresses | rig | R3 | — |
| T148 search addresses | rig | R3 | — |
| T149 Mac rig | done (T151) | — | — |

Tally: of the 60 sections, 37 go to the rig whole, 16 in part, 6 stay on the iPad (T92, T84, T65,
T32 / T94 / T98 minutes, T141, T126's old-project lines), 1 is done. Of the 277 lines, roughly 230
become "Claude ran". What stays for Landry is listed in the last column, plus every `Decision D…`
line, which no flow answers.

## 5. Stays on the iPad whatever we do

Camera capture; Pencil pressure, palm rejection and two-finger pan while drawing; pinch, pan and
double-tap (Maestro has no pinch; the simulator's option-key pinch is not scriptable); true airplane
mode and cellular; TestFlight and dev builds, `expo-updates` (off in Debug), the release-build
charts (T38); performance on the hardware (T131, T141, the export's minutes on the Droplet); and
every check of whether the information is right: extraction results, dashed-pin positions, generated
wording, the workbook's and the floor PDF's content, pin shapes and colours as drawn. Those keep their
lines in `docs/ON_DEVICE_CHECKLIST.md`.

## 6. Order and sizing

1. **T154** — §2 infrastructure + S1 (`seed`) + `pipeline`: O/M. Everything after it leans on the
   two projects.
2. **T155** — wave 1 F1–F4 (the survey loop): O/M. **T156** — wave 3 O1–O4 (the two ways to lose
   data): O/M.
3. **T157** — wave 4 R1–R7 (the review screens: list-and-button work, a long flow each): S/M.
4. **T158** — wave 2 S2–S5 with F5–F6: S/M. **T159** — O5–O6 and wave 5: S/M.

S2 (the riser half of `drafts.yaml`) sits in T158 because it needs `pipeline` from T154 and nothing
in T155–T157 needs it. T154 → T155 → T156 is the order that matters; T157 onward can be reordered.

Each task adds its `testID`s in the same change, lists its flow in `app/maestro/README.md`, and
moves the matching checklist lines to a "Claude ran" note (the line, the flow, the date), leaving
Landry's column. Flows run through `rig.sh`, never bare `maestro test` (the env rule, ops §6.3). When
a flow turns a checklist line green the line leaves the file the same way a "tested" round does.

## 7. How each task runs (the protocol on top of CLAUDE.md §7)

Each wave is a numbered task in `TASKS.md` (T154–T159, §8). One task per session, started with the
prompt in §8. Inside the session:

1. **Bring the rig up and check it** (`rig.sh status` over SSH: server, worker, Metro, simulator A;
   `rig.sh second` when the task needs B). If the Mac is asleep, `ping` wakes it; keep it awake with
   `caffeinate` for the session (ops §6.1).
2. **One flow at a time, in the task's order.** Write the flow and its `testID`s, copy to the Mac,
   run it, read the failure (screenshot, hierarchy, the app's log), fix, re-run. A flow is done when
   it is green **twice in a row** on A (and once on B where it has a B half).
3. **A failure is one of three things**, decided at the failing step:
   - *The flow is wrong* (selector, timing, a position tap): fix the flow.
   - *The app is wrong and the fix is small* — JS only, no new decision, no schema change, under
     about an hour, provable by the same flow: **fix it in the session**, add or extend a vitest
     where the logic allows, re-run the flow, note it in the task's entry ("found and fixed: …").
     T151's `awaitingProject` is the model.
   - *The app is wrong and the fix is bigger, or needs a decision, or is native*: **file a task**
     at the end of the milestone (`T<nn>`, with the flow and step that found it, the screenshot's
     path, and the smallest DoD), mark the flow's step with `# blocked: T<nn>` and skip it
     (`optional: true` or a `runFlow` guard) so the rest of the flow still runs, and carry on.
     Never leave a red flow in `app/maestro/`: every flow on `main` is green or has its red steps
     guarded and named.
4. **Track as you go, not at the end.** After every flow goes green or gets blocked, the session
   updates three places in the same commit as the flow:
   - the tracker in §8 (status, date, what was found);
   - `docs/ON_DEVICE_CHECKLIST.md`: each line the flow now proves gets `[x]` and
     `→ saw (Claude, rig, <date>, <flow>): …` with the assertion that proves it; a line a found bug
     blocks gets `→ blocked by T<nn>`; Landry's lines are left as they are. When a whole section is
     Claude's, it leaves the file into `docs/on-device-log.md` under "Claude ran (rig) <date>", the
     way a "tested" round does (CLAUDE.md §7 5b), so the checklist only ever holds what Landry has
     to do;
   - `TASKS.md`: the task's entry grows a progress line per flow ("F1 green 2026-11-05; F2 green;
     F3 blocked at Move pin by T160").
   Commit per green flow (`T<nn>: <flow> green — <what it proves>`), so a session that stops early
   leaves nothing half-done on disk.
5. **End of session:** the 5-line summary (CLAUDE.md §7 7) says which flows are green, blocked or
   not started; the hand-off (§7 8) gives the **next prompt verbatim** — the same task again if flows
   are left, else the next task in §8 — and lists the tasks filed. If the session fixed the app, the
   summary says so and whether `main` should be pushed (JS fixes reach the iPads only after a push).
6. **Landry's side per section:** nothing until a section's flow is green. Then the checklist shows
   only his lines for it (the last column of §4) and the Decision line, to do in a normal round.
   A filed `T<nn>` from step 3 goes into the usual order in `TASKS.md`; it is not part of this plan's
   sessions unless it blocks the next flow, in which case the next prompt says to do it first.

## 8. Tasks, prompts and tracker

Prompts, in order. Every session ends by handing over the next one; this table is the fallback.
Each is pasted into a **new** session (`/clear`, then `/model` to the task's model).

| Task | Model / effort | Prompt to paste |
|---|---|---|
| T154 | O/M = Opus 5.5, Medium | `Read CLAUDE.md, then do task T154 in TASKS.md per the session protocol in CLAUDE.md §7. It is step 1 of docs/rig-plan.md (§2 infrastructure, S1 seed, pipeline); follow the plan's §7 protocol and update its §8 tracker as you go.` |
| T155 | O/M | `Read CLAUDE.md, then do task T155 in TASKS.md per the session protocol in CLAUDE.md §7. It is wave 1 of docs/rig-plan.md (F1–F4); follow the plan's §7 protocol and update its §8 tracker as you go.` |
| T156 | O/M | `Read CLAUDE.md, then do task T156 in TASKS.md per the session protocol in CLAUDE.md §7. It is wave 3 of docs/rig-plan.md (O1–O4); follow the plan's §7 protocol and update its §8 tracker as you go.` |
| T157 | S/M = Sonnet 5.5, Medium | `Read CLAUDE.md, then do task T157 in TASKS.md per the session protocol in CLAUDE.md §7. It is wave 4 of docs/rig-plan.md (R1–R7); follow the plan's §7 protocol and update its §8 tracker as you go.` |
| T158 | S/M | `Read CLAUDE.md, then do task T158 in TASKS.md per the session protocol in CLAUDE.md §7. It is wave 2 of docs/rig-plan.md (S2–S5) with F5–F6; follow the plan's §7 protocol and update its §8 tracker as you go.` |
| T159 | S/M | `Read CLAUDE.md, then do task T159 in TASKS.md per the session protocol in CLAUDE.md §7. It is O5–O6 and wave 5 of docs/rig-plan.md; follow the plan's §7 protocol and update its §8 tracker as you go.` |

A task left unfinished is re-run with the same prompt; the tracker says where it stopped.

**Tracker** — one row per flow; the session that touches a row updates it. Status: `todo`,
`in progress`, `green <date>`, `blocked T<nn> (<step>)`, `partly green (<steps left>)`.

| Flow | Task | Status | Found (fixed in session / filed) | Checklist lines moved |
|---|---|---|---|---|
| §2 `rig.sh seed`, `pipeline`, `scale`, `media`, `log`, `conflict` | T154 | green 2026-11-04: `seed`, `pipeline` (skip when made, refuse a half-made one); `scale` (45 s; made only in the session that needs it); `media` (the two PNGs in Photos); `log` (found T161's line); `conflict conflict-status.yaml conflict-check.yaml` twice (Maestro c3, c4: A `Issue` and B `Not installed` offline, A syncs first, both cards `✓ Issue` + "in review", the server one open sync conflict); the status bar asserted through `status.bar` | `rig.sh server` after a reset: S3 not ready for the bucket, the worker died before the migration, Postgres init > 60 s — fixed in `rig.sh`; the keychain kept the old server's user id, every edit refused "unknown user" while flows read "Synced" — `server reset` resets the keychains, `_sync` fails on "need attention", app side filed **T160**; status bar label hid its text — fixed (`status.bar`) | |
| S1 `seed.yaml` | T154 | green 2026-11-03 (4 runs; the last two after the server reset, server: 27 open + 4 resolved review items) | fixed in session: Vocabulary's "Added n values …" line was cleared as soon as it was set; Needs review's "Linked: …" note sat under the next item's device list, out of sight (moved to the top of the panel) | T81 Link to device, T122 The ends offered, Keep ticked; T81 Review items arrive, Create device, T40 Load standard lists, T122 Listed, Put on partly (saw notes) |
| `pipeline.yaml` | T154 | green 2026-11-04 (twice in a row; 3.5 min: BOM 108 device drafts · 17 excluded, riser 37 device drafts · 155 cable drafts · 12 far ends to pick, the 06M sheet) | flow: levels added with Return (the "+ Add level" button slides under the keyboard), Create waits up to 2 min behind the first pull; `_logbox.yaml` closes the dev error toast; filed **T161** (a rules run overlapping a pull fails "finding … already exists") | none (S2, T158, retires the riser lines on this project) |
| F1 `ends.yaml` | T155 | green 2026-11-04 (twice in a row, ~11 min each incl. a 2.5 min seed copy) | flow: each wave-1 run works on its own seed copy (`_seed-copy.yaml`: the drafts a run accepts are gone for the next); the card is a side panel, so `_side-down` / `_side-up` swipe there and stop clear of the fixed header; a connection is tapped by its C-label (the row's middle is the far-end jump); the note box is cleared by two tap-and-erase passes. Fixed in session: Vocabulary's remove guard read "1 connection end still use" | T35 (all three, section moved to the log); T34 "A Not installed end raises its Run item"; T40 "Remove guard"; T103 "No second kit after the pull", "A placeholder far end gets one kit"; partial saw notes on T33 Accept, T34 "Accept R3b, then R4b follows", "Findings on the card", T40 "Endpoint picker", T118 "Kit Note" |
| F2 `lists.yaml` | T155 | partly green 2026-11-04 (twice in a row, ~8 min each; Tracking status, Part status and the owner chip blocked T162) | blocked: no screen edits a punch item or a part (filed **T162**, decision first); found: a device ID or room search finds no punch item by its shown Device text (filed **T163**); fixed in session: tapping a list row after closing its card with × deselected it instead of opening it; Return in a quick action's answer applies it (the keyboard covered Apply); flow: a search keeps the keyboard up until Return, and the next tap only closes it; T161's toast took the seed's Import tap once (`_logbox` before it) | T95 "C-nn search", "A name search"; T68 "Card hides it on a rack or NSPS"; partial saw notes on T95 "Both ends", T81 "Lists show the derived text", "A rename follows", T34 Neuron ID item upkeep |
| F3 `additions.yaml` | T155 | green 2026-11-04 (twice in a row, ~6 min each, on a new project with the 06M sheet) | flow: the Setup screen has no nav sidebar (Open plan ▸ from Sources); the sync can number a field addition before `06M-?` is read (NEW asserted instead); the card stays open after + Note here | T101 "One tap"; T81 "Place the new device"; partial saw notes on T112 "Category picker", "ID letters by role", T101 "No item", T34 "Quick actions", T139 "From the card" (non-draft half) |
| F4 `place.yaml` (new; `_place.yaml` stays setup.yaml's) | T155 | `place.yaml` green 2026-11-04 (twice in a row, ~11 min each: a seed copy plus the 06M sheet, three hand drafts and a waiting N cable); `rig.sh place-two` green 2026-11-04 (twice in a row, ~15 min each: A and B, one pooled unit each offline, both see 06M-S1 and 06M-S2, Pool 0, no sync conflict) | flow: the 06M sheet fills the screen between about 32 % and 78 % of its height in portrait (a tap above it chose no spot); accepted drafts leave Review drafts' default Open filter (`drafts.filter.all`); a list row on the card is one accessibility element (assert inside its text); `_search` / `_search-clear` now erase twice (a tap mid-word left `06M-04EQ`); `rig.sh flows` stages the sheet and the workbook together for a flow with both (`SEED_AT`, `_sheet.yaml`). No app bug found | T139 (all five, section moved to the log, Decision left); T143 (all three, moved, Decision left); T46 (both open lines, section moved to the log, Decision left); T136 "Placing links it"; T140 "Nothing written by a proposal"; partial saw notes on T136 "Accept makes it", "On the placed device's card" |
| O1 `offline.yaml` → `rig.sh offline` (offline-setup / -edit / -check.yaml) | T156 | green 2026-11-04 (twice in a row, ~10 min each: a seed copy, then with the api stopped 06M-03 status and note, 06M-01 IP and DMX, C-23 Not installed with its Run and kit drafts accepted, Confirm endpoint, a Lint dismissal, B2 locked, Dashboard and Rulings opened, Pending edits n; back online `Synced`, and the server holds an applied op of each kind made in the offline window) | fixed in session: the Sync screen counted Pending edits and Review items for the oldest project on the iPad, not the current one ("0" under a status bar reading "22 pending") — it uses `pickProject` like the other screens now. Flow: DMX's Type… rests under the card's fixed header after the IP field (Maestro counts it visible; `_card-address` re-taps it clear of the header); Lint's "Drafts with no device" fill the list (`_lint-dismiss` folds them); T161's toast opened the full dev log over Import once (`_logbox-open`). T106 "Cached" not covered: the seed copy has no riser (S2, T158) | partial saw notes on T47 "Offline and the other iPad" (first half), T39 "Offline", T38 "Offline", T146 "Offline" |
| O2 `rig.sh conflict` → `rig.sh conflicts` (offline-setup.yaml on A, conflicts-peer / -edit / -check.yaml) | T156 | green 2026-11-04 (twice in a row with the final flows, ~16 min each: A (Ann) a seed copy, B (Bob) opens it; offline both set 06M-03's status, A applies a ruling (Append note on 06M-02) while B types 06M-02's note, both change EBDK's aliases in the app library, A dismisses a B2 finding; after A then B sync, A chooses B for each in Needs review (Sync conflict 2, the note row `⚑ ruling`) and in App library — needs review (`1 in review ▸`); both iPads then show B's values, nothing in review, the ruling listed, A's dismissal) | no app bug. Flow: the Rulings editor's first tap after typing only closes the keyboard (the panel title is tapped first); the keyboard covers the library editor's Save footer; Choose B asks "Resolve"; after a cold start the home shows the first project, so the check opens PROJECT first (`_open-project`); a finding about a record the conflict changes resolves by itself (the dismissal is on B2); a fresh B downloads all 45 rig projects newest last and timed out, so the peer flows keep B's store (`_resume`); the newest project row sits partly under the edge (`visibilityPercentage: 50`); T161's toast covered Import at the bottom edge — `rig.sh metro` now sets `EXPO_PUBLIC_RIG=1` and the dev build ignores LogBox | T61 "Conflict", T36 "Two iPads", T37 "Two iPads" (all three [x]) |
| O3 `same-user.yaml` → `rig.sh same-user` (same-user-setup / -peer / -edit / -check.yaml, `RIG_PEER=Ann`) | T156 | green 2026-11-04 (twice in a row, ~15 min each: a project with the 06M sheet, a station and Ann's ink layer; both simulators as Ann, offline each sets 06M-S1's status and draws a stroke; after A then B sync: no sync conflict, B's later status on both, A's log reads `ink_merged`) | **found and fixed in session:** one person on two iPads did not converge — B pushed its later status, then pulled A's earlier op and showed A's value while the server and A had B's; a pulled `set` no longer overwrites a field whose local head is an applied op with a higher `server_seq` or the same person's pending edit with a later `client_ts` (`Store.applyRemote`, two vitests; core 221 and the e2e harness 17 green). The ink merge lines go to the log file now (`logTo plan ink_merged`). Flow: a swipe takes no variables (literal spots by `STROKE`); `rig.sh flows` staged no files for a flow whose sub-flow uploads — a `grep -q` at the end of a pipeline under pipefail (`uses_sources`) | T87 "Same name on two iPads" ([x], section moved to the log) |
| O4 `resume.yaml` → `rig.sh resume` (media on A, then `rig.sh offline` with resume-setup / -edit / -check.yaml) | T156 | green 2026-11-04 (twice in a row, ~10 min each: a project with the 06M sheet and a station; with the api stopped a status, a note and a library photo; the app killed and relaunched: the outbox not lower (3 → 4: the relaunch's rules run adds the finding the kill cut short), the photo still waiting, the card unchanged; Re-sign in offline → the connect form; server back: sign in again, `Synced` with nothing pending, `0 photos`, and the server holds device status / notes and photo create) | no app bug. Flow: the photo picker is another process and comes up after a few seconds (a pause, then the first photo by position); photos sharing the picked image's blob all count as waiting (the same PNG each run); the pending count may rise after a relaunch | T21 "Upload resume" (partial; F5 takes the rest) |
| R1 `lint.yaml` | T157 | green 2026-11-04 (twice in a row, ~17 min each incl. a ~6 min seed copy) | no app bug in the flow; filed **T164** (Lint's "This iPad: not numbered by the server (53)" lists imported far ends the master gives no row, e.g. single-row runs: they are numbered as designed, not stuck). Flow: Lint mounts again after Open card, Show and the sidebar, and every group comes back unfolded (`_lint-open`, `_lint-fold`: a tap on the 232-row vocabulary group while it renders is lost); the Save & accept tap after typing only closed the keyboard (Return first); Needs review's Lint link sits in the list footer under 31 rows (swipe the list, not the panel) and counted visible under the fixed header; the seed has no R2e draft (the Unison pair row not covered) | T36 Open it, far ends, Filter and group, Open card, Dismiss, comes back, Reopen, Fix all via ruling ([x]; Links into Lint half, Export's in R6); T100 Accept / Edit / Reject, Level filter ([x]), They are listed, why? (R3c half); T146 New drafts in the Lint view ([x]) |
| R2 `rulings.yaml` | T157 | green 2026-11-04 (twice in a row, ~15 min each incl. the seed copy) | no app bug. Flow: an unquoted YAML value with ": " fails the parse (the whole flow, before any step); Copy as new copies the ruling selected, which after an Apply is the one just applied; the master has no device note "Empty box on wall" without its full stop, so the rename ruling is on punch items ("Install cover" → "Install cover plate", the vocabulary footer); the standing proposals are on a Device ruling (Status = No access → Append note) set later on 06M-03 and 06M-04 | T37 Open it, Build one, Preview with untick, Standing, Rename phrase, Generate item / Append note, From Lint, From the plan lists, Copy and Delete ([x]); Apply (part: the end editor and History not opened) |
| R3 `dashboard.yaml` | T157 | green 2026-11-04 (twice in a row, ~16 min each incl. the seed copy) | no app bug. A fresh copy of the master reads `Neuron IDs captured 0/170` (the checklist's 169 is the Tower after its edits). Flow: two runs started in the same second (A and B) made two projects with one name and A's opened the wrong one — concurrent runs now set `RIG_PROJECT` each; the open drill-down panel covers the Total column and a tap there opens a panel row (close it first); with the panel open the as-found line wraps out of reach (`_dash-as-found`: close, scroll, tap); the by-owner table keeps all three rows under an owner filter (EC/ETC reads 0); readiness reads `B2 ready (1 review)` | T38 Open it, Same numbers, Drill-down, Filters, As-found and readiness, Apply as ruling from a drill-down, Search; T147 The line, IP drill-down, Counts follow, Levels filter; T148 (all three) ([x]); T147 DMX drill-down, T146 Dashboard (part) |
| R4 `cables.yaml` | T157 | green 2026-11-04 (twice in a row on B, ~15 min each incl. the seed copy) | no app bug. Flow: runs on simulator B while A runs another flow (Maestro drives both at once; the server-stopping orchestrations still run alone); `_seed-copy`'s scroll to Import needs up to 60 s when both import; the Level groups read `Level 06M 23`; the first N run's far end is a placeholder, so the status edit is on C-17 (06M-01 ↔ 04-05); a computed `${output.n + 1}` in a text selector did not match, literal counts do; the Lint group sits under the long vocabulary group (fold first); a card connection's testID is on its label, the row's text on the parent | T39 Open it, Group by, Rows, Filters, End editor, Needs review link, Apply as ruling ([x]); Confirm endpoint (part); T138 Nothing comes back ([x]); From the card, History restores it, From the Cable / riser view (part) |
| R5 `review.yaml` | T157 | todo | | |
| R6 `export.yaml` | T157 | todo | | |
| R7 `projects.yaml` | T157 | todo | | |
| S2 `drafts.yaml` (extended, riser) | T158 | todo | | |
| S3 `lock.yaml` | T158 | todo | | |
| S4 `library.yaml` | T158 | todo | | |
| S5 `sheets.yaml` | T158 | todo | | |
| F5 `photos.yaml` | T158 | todo | | |
| F6 `ink.yaml` | T158 | todo | | |
| O5 `pickup.yaml` | T159 | todo | | |
| O6 `restart.yaml` | T159 | todo | | |
| W5 `scale.yaml` | T159 | todo | | |
