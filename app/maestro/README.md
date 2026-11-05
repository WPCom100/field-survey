# Maestro flows (T149, D248)

What Claude runs on the Mac test rig against the iOS Simulator: `bash scripts/mac/rig.sh flows [file]`
(`docs/ops.md` §6). Files starting with `_` are sub-flows the top-level flows include. Every flow
talks to the local e2e server (`rig.sh server`: api **and worker**, 127.0.0.1:8010, token `e2e`,
team Ann / Bob), never to the Droplet.

| Top-level flow | Runs | Proves |
|---|---|---|
| `smoke.yaml` | `rig.sh flows` | connect, create a project, open its level, sync |
| `setup.yaml` | `rig.sh flows setup.yaml` | Setup → 3 Sources (DaVinci library + the 06M sheet from Files) → 4 Review drafts (accept / edit / reject) → 5 Place devices (one pin) → the card (status, note, a punch item) → sync |
| `peer.yaml`, `peer-back.yaml` | `rig.sh two` | after `setup.yaml` on A (Ann): B (Bob) opens the same project, sees A's status and note, sets another status, syncs; A syncs and sees B's |
| `seed.yaml` | `rig.sh seed` | the master workbook into `Maestro master` through Setup → Seed import (Checks: 8 floors, 210 devices, 215 punch, 85 parts; a column set to "not in this workbook" flagged before and after Re-check, put back; Import → "Imported", 31 review items · 4 findings · 8 unpaired ends) → Vocabulary → Load standard lists (added, then "Everything standard is already here.") → Needs review (31: 8 import pairs, the link and connection rows): Link B1 #27 to B1-S1, Create device ▸ for 04 #34, Put 06M #2 on C-07 (only the X ends offered), Keep 03 #10 on its device → 27 → sync. Once per server lifetime (T154) |
| `pipeline.yaml` | `rig.sh pipeline` | `Maestro pipeline`: a project B2–06M, BOM.pdf → "Done: n device drafts …", riser.pdf → "Done: … n far ends to pick" (no Claude key on the rig), the 06M display sheet, sync. Once per server lifetime (T154) |
| `sync-now.yaml` | `rig.sh conflict` | relaunch keeping the store, Sync now |
| `conflict-status.yaml`, `conflict-check.yaml` | `rig.sh conflict conflict-status.yaml conflict-check.yaml` | with the server stopped, A sets the first 06M device `Issue` and B `Not installed` (status bar "Offline · n pending"); after A then B sync, both cards show `✓ Issue` and "in review", Needs review counts a sync conflict (the orchestration's proof; wave 3 O2 resolves it) |
| `ends.yaml` | `rig.sh flows ends.yaml` | F1 (T155): a fresh copy of the master (`_seed-copy`), then on 06M: C-23 Not installed → R3a Run draft → Accept → R4b kit → Accept (`src #n` after the sync); Issue "Run, not terminated" → R3a Terminate EC/ETC, "…; no term kit" → R3b Missing part EC/ETC → Accept, no second kit; C-12 one Run draft on end A, the item standing through a flip; no kit chip on the P run C-08; 06M-04's findings line; C-13 → Jump to 04-01 on Level 04; 04-05's `Run 120V to P-NSPS-D Power Supply`; Change placeholder… → Add & use, Vocabulary refuses its removal (about 11 min) |
| `lists.yaml` | `rig.sh flows lists.yaml` | F2 (T155): a fresh copy of the master; on 06M the Conns rows `<this end> ↔ <other end> · <status>`, `C-14` → one row and its two end devices, `06M-02` → that device alone; B1's Punch #8 Device text from B1-S3 and Relocated followed at once; B2's Neuron ID item drops B2-S1 once its Neuron ID is typed; the NSPS card has no Neuron ID (about 8 min). Tracking / Part status: no screen yet (T162) |
| `additions.yaml` | `rig.sh flows additions.yaml` | F3 (T155): a new project with the 06M sheet; long-press → + Device: the eleven categories, a Station → `06M-S1`, a Sensor → `06M-D1` after the sync; + Note here; the card's ⋯: Move pin…, Put back in the unplaced list… ("Placed by mistake"), Place pin…, Delete… → Restore…, each in History with who and why; Not found on site (once in the Notes, no item), Spot-check fixed, Non-ETC device, Relocated (about 6 min) |
| `place.yaml` | `rig.sh flows place.yaml` | F4 (T155): a fresh copy of the master plus the 06M sheet; hand drafts on 06M (MAESTRO-EQ ×1 with an N cable from 06M-04 confirmed while it waits, MAESTRO-ST ×2, MAESTRO-SN ×2); Needs review's "Not on the plan, 06M: 4 devices and 5 to place from drafts", the Devices tab's Place ▸, ⊕ Place; ↶ Undo for a draft unit and for 06M-03 (keeps C/13 and its Room), only the latest, none after ◀ Done placing; MAESTRO-EQ placed → "1 waiting cable made", its end Not installed, Put back… → 06M-04 shows "(draft on 06M, not placed yet)" → placed again: the end still Not installed, `Cable / riser (81)`; Flag → Move to… 04, and to the pool with one unit placed; Review drafts: basis `manual` / `project_pool`; a spot left unconfirmed writes nothing |
| `place-two-setup.yaml`, `place-two-peer.yaml`, `place-two-edit.yaml`, `place-two-check.yaml` | `rig.sh place-two` | F4 two-iPad half (T46): A pools a Station draft ×2 and syncs, B opens the 06M plan; with the server stopped each places one unit; after A then B sync, both see `06M-S1` and `06M-S2`, `Pool 0`, no sync conflict |
| `offline-setup.yaml`, `offline-edit.yaml`, `offline-check.yaml` | `rig.sh offline` | O1 (T156): a fresh copy of the master; with the server stopped (status bar `Offline`) 06M-03 No access and a note, 06M-01's IP and DMX address, C-23 Not installed with its R3a Run and R4b kit drafts accepted, Confirm endpoint in Cables, a Lint finding dismissed, B2 locked, Dashboard and Rulings open, the Sync screen's Pending edits n; server back: `Synced` with nothing pending, the card still shows them, and `rig.sh` finds an applied op of each kind on the server (`client_ts` in the offline window) |
| `conflicts-peer.yaml`, `conflicts-edit.yaml`, `conflicts-check.yaml` | `rig.sh conflicts` | O2 (T156): A (Ann) a seed copy (`offline-setup.yaml`), B (Bob) opens it; offline both set 06M-03's status, A applies a ruling (Append note on 06M-02) while B types 06M-02's note, both change the app library's EBDK aliases, A dismisses a finding; after A then B sync, A's values are official and in review; A chooses B for each (Needs review → Sync conflict 2; App library — needs review via `1 in review ▸`) and syncs: both iPads show B's values, nothing in review, B sees A's dismissal |
| `same-user-setup.yaml`, `same-user-peer.yaml`, `same-user-edit.yaml`, `same-user-check.yaml` | `rig.sh same-user` | O3 (T156): A and B both as Ann on a project with the 06M sheet, a station and Ann's ink layer; offline both set 06M-S1's status and draw a stroke; after A then B sync: no sync conflict, B's status (the last write) on both, and A's log reads `ink_merged` (both strokes kept, D133) |
| `resume-setup.yaml`, `resume-edit.yaml`, `resume-check.yaml` | `rig.sh resume` | O4 (T156): offline a status, a note and a library photo on 06M-S1; a kill and relaunch loses nothing from the outbox (the count never drops), the photo still waits, the card unchanged; Re-sign in while offline; server back: sign in again, `Synced`, 0 photos waiting, the server holds the ops |
| `lint.yaml` | `rig.sh flows lint.yaml` | R1 (T157): a fresh copy of the master; Drafts with no device: 01's two R3c drafts under the level filter, why?, Open level ▸, IP Accept and DMX Edit → Save & accept (owner EC/ETC), both last on 01's punch list after the Neuron item; B2's IP draft Rejected and still gone after a sync; none under Dismissed. Findings: `Cable with missing far end (12)`, a level chip, Group by Level and folding, 06M-03 Issue → its finding → Open card ▸ and back, Dismiss… disabled until a reason, Dismissed with the reason, resolved when the status leaves Issue and open again when it returns, Reopen, Fix all via ruling ▸ (EBDK) into the editor, Needs review → Lint tab → Open the Lint view ▸ |
| `rulings.yaml` | `rig.sh flows rulings.yaml` | R2 (T157): a fresh copy of the master; the D50 ruling; "0-10V rows read Fixtures" built by hand (red missing lines, Preview disabled), Preview `11 changes`, one unticked, Back keeps the editor, Apply 10, Preview again empty naming the unticked record; a standing Device ruling (No access → Append note) proposes on 06M-03 and 06M-04 set later: Accept, Standing off withdraws, on brings back, Reject; Fix all via ruling on EBDK applied from Lint; Select → All → Apply as ruling… from 06M's Punch tab; Generate item once; Rename phrase "Install cover" with the vocabulary footer; Copy as new; Delete… with a reason |
| `dashboard.yaml` | `rig.sh flows dashboard.yaml` | R3 (T157): a fresh copy of the master; the Summary's numbers (210 · 215 · 85 and their splits), drill-downs on a cell, a row and column Total and the grand total, a row to its card and back, the Levels and Owner filters (EC is not EC/ETC), Apply as ruling from a drill-down; the as-found line and its drill-downs, 01-06's IP and 01-01's DMX address moving the counts, Level 01 alone; readiness B2 setup → ready (locked) → surveying (an edit); search by ID, note phrase, #12, c-14, dmx, an IP whole and partial, a DMX address that changes |
| `cables.yaml` | `rig.sh flows cables.yaml` | R4 (T157): a fresh copy of the master; `Cable / riser (80)` and the six footer counts, Group by Vertical / Level / Code and folding, the filters and the footer filter, Open Needs review item ▸, an N run's end editor in the side panel, a far-end status moving the row and `status mismatch`, Confirm endpoint, Jump to, Select → Apply as ruling…; C-23 deleted from 06M-01's card (Run item and kit accepted first): gone from Connections and Conns, nothing re-proposed, Lint `Linked to a deleted device or connection`, History → Restore… back Not installed; a P run deleted from the cable view |
| `station-setup.yaml`, `export-edit.yaml`, `export-check.yaml` | `rig.sh export` | R6 (T157): a project with the 06M sheet and a station (`station-setup`, also R5's); with the server stopped an edit waits and Export reads `Offline. …` with both Generate buttons disabled; server back: Sync first → `Synced — …`, the workbook's card (Started by Ann) to `Ready · <size>`, See the n lint findings ▸ → Lint, the floor PDF header `… — Level 06M · Surveyed <date>`, a Surveyed date set in Setup → Levels wins, a PDF to Ready, History lists both |
| `projects.yaml`, `projects-offline.yaml` | `rig.sh projects` | R7 (T157): a new project beside `Maestro master`; Refresh from server; the home's chips switch and Lint, Cable / riser, Dashboard and Export follow; the new-project form names a two-way numbering share and a chain and Create refuses both; ◀ Projects; Setup → Open the levels screen ▸; with the server stopped Create reads "the server is not reachable" |
| `review-edit.yaml`, `review-check.yaml` (with `station-setup.yaml`, `same-user-peer.yaml`) | `rig.sh review` | R5 (T157): A (Ann) a project with the 06M sheet and a station, B (Bob) opens it; offline each types a note on 06M-S1; after A then B sync, A: Needs review → Sync conflict 1 → Combine ▸ (the official note first) → Save combined; the Extraction drafts line on `Maestro pipeline` opens Setup → Review drafts; both iPads read the combined note, nothing in review |
| `photos.yaml` | `rig.sh photos` | F5 (T158): two PNGs in the photo library; a project with the 06M sheet and two stations; 06M-S1 → 🖼 Library → Save → `Photos (1)`, the app killed and relaunched at once (the upload resumes: `0 photos` on Sync, Retry failed uploads greyed); the photo linked to 06M-S2 in its caption sheet (06M-S2 shows it); + Photo here → the camera stage → 🖼 Library → a level photo; sync. `rig.sh` then reads the server: 2 photos, each once, image and thumbnail uploaded whole, 1 device link |
| `drafts.yaml` | `rig.sh drafts` (`--device B` too) | S2 (T158): its own pipeline project (`pipeline.yaml`), then Setup → 4 Review drafts: 01's riser N run to `P-NSPS-D (draft, 02)` with `· riser: PARADIGM P-NSPS-DIN`, the source crop enlarged and closed, Change… by model and by `DIN`, Confirm endpoint → waits for placing; 01's mismatch list (a line selects its draft, SR / LR gone once accepted and back on Reopen), Accept all asks first; an excluded BOM line promoted; 03's NSPS N line answered by a hand N draft and back when it is rejected; the 06M rack placed and 01's F run to it made at once (`draft on 01, not placed yet` on its card and in Cable / riser, its end surveyed). `rig.sh` then finds the confirm's reason naming the drafts on the server (about 10 min) |
| `ink-setup.yaml`, `ink-peer.yaml`, `ink-check.yaml` | `rig.sh ink` | F6 (T158): A (Ann) a project with the 06M sheet, a stroke (`Saved`), Layers → Ink (all users) off and on; B (Bob) syncs and opens 06M (its log: `ink_loaded … "others":1`), draws its own stroke, syncs; A syncs and opens 06M (`ink_loaded {"layers":2,"mine":1,"others":1}`). The same-name merge is O3 (`rig.sh same-user`) |

| Sub-flow | Walks |
|---|---|
| `_launch.yaml` | fresh launch (`clearState`), then `_devclient` |
| `_resume.yaml` | relaunch keeping the local store, then `_devclient` |
| `_devclient.yaml` | a dev client loads from Metro by deep link (`METRO_URL`; skipped for a `--release` build), its menu and Tools button closed, a stale "Open in Field Survey?" cancelled |
| `_connect.yaml` | Connect to server (URL, token) → pick the name `USER`; re-signs in when the keychain holds another name |
| `_new-project.yaml` | Projects → + New project (`PROJECT`, level 06M) → home → open the level → back |
| `_sources.yaml` | Setup → 3 Sources: DaVinci (two files), then the 06M display sheet; waits for both jobs |
| `_sheet.yaml` | Setup → 3 Sources → the 06M display sheet from Files at `AT` (env), waits for the job and the sheet |
| `_pick-wait.yaml` | waits for the Files picker before a position tap |
| `_drafts.yaml` | Setup → 4 Review drafts: three hand drafts, accepted / edited / rejected |
| `_place.yaml` | Setup → 5 Place devices → Place ▸ → first unit → tap the sheet → Place ✓ |
| `_card.yaml` | Devices list → card: status Issue, a note, Quick actions → Spot-check fixed (punch item) |
| `_open-device.yaml` | Projects → `PROJECT` (scrolls to it; waits for it to arrive) → 06M → Devices → the card |
| `_sync.yaml` | Sync → Sync now → `Synced <time>` → back |
| `_seed-import.yaml` | Setup → 3 Sources → Seed import: the master from Files, the Checks, the mapping (a wrong column flagged and put back), Import |
| `_seed-vocab.yaml` | Vocabulary → Load standard lists twice |
| `_seed-review.yaml` | Needs review on a fresh seed: Link, Create device ▸, Put on, Keep |
| `_seed-copy.yaml` | + New project → Seed import of the master (no mapping detours) → "Imported" → sync → Load standard lists: each wave-1 run's own copy (T155; `rig.sh flows` stages the workbook); `SEED_AT` (env) is the workbook's spot when `rig.sh` stages the sheet beside it (place.yaml) |
| `_open-level.yaml`, `_open-card.yaml` | Projects → `PROJECT` → level `LEVEL` (env) → its plan; `_open-card` then taps Devices → `DEVICE` |
| `_side-down.yaml`, `_side-up.yaml` | swipe the plan's side panel (card, end editor) until `ID` (env) is on screen, then a little more, clear of the edge and of the card's fixed header |
| `_open-end.yaml` | the card's connection `CONN` (env, tapped by its C-label) → its end editor |
| `_end-note-clear.yaml` | empties this end's note (two tap-and-erase passes: eraseText deletes before the cursor) |
| `_ends-run.yaml`, `_ends-terminate.yaml`, `_ends-wire.yaml`, `_ends-elsewhere.yaml`, `_ends-placeholder.yaml` | the steps of `ends.yaml` |
| `_search.yaml`, `_search-clear.yaml` | the plan's search box: `TERM` (env) typed, or emptied; Return closes the keyboard |
| `_lists-conns.yaml`, `_lists-punch.yaml` | the steps of `lists.yaml` |
| `_add-here.yaml` | long-press `AT` → + Device → `CAT`, new model `MODEL` → Add device → NEW, then the server's ID `IDRE` (env) |
| `_quick-apply.yaml` | Return applies the open quick action; waits for its question to close |
| `_additions-add.yaml`, `_additions-menu.yaml`, `_additions-quick.yaml` | the steps of `additions.yaml` |
| `_place-draft.yaml` | Review drafts: + Draft device `MODEL`, `CAT`, `QTY` on 06M → Add draft → Accept |
| `_place-one.yaml` | in the open place panel: row `ROW` → tap `AT` → Place ✓ → the "Placed …" row reads `PLACED` |
| `_place-drafts.yaml`, `_place-entry.yaml`, `_place-undo.yaml`, `_place-waiting.yaml`, `_place-flag.yaml` | the steps of `place.yaml` |
| `_card-address.yaml` | on an open card: the address `KIND` (`ip` or `dmx`) typed as `VALUE`, saved with Return; repeats the Type… tap clear of the card's fixed header when the input did not open |
| `_lint-dismiss.yaml` | Lint → level `LEVEL` (env, one the caller does not edit) → fold "Drafts with no device" → its first finding → Dismiss… → a chip reason → the Dismissed count one higher |
| `_open-project.yaml` | Projects → `PROJECT` → its Levels home: after a cold start the home (and so Needs review, Lint …) shows the first project |
| `_logbox-open.yaml` | dismisses the dev client's full error log when the T161 toast took a tap and opened it (`_logbox` runs it first) |
| `_sheet-station.yaml` | a new project with the 06M sheet (`_sources`) and a Station by long-press (06M-S1); ends on the plan |
| `_ink-stroke.yaml` | ✎ Ink → a stroke at `STROKE` (`setup`, `A`, `B`: literal spots, a swipe takes no variables) → `Saved` → Done |
| `_photo-library.yaml` | the card's 🖼 Library → the picker (a position, `PHOTO_AT`) → Save → `Photos (1)` |
| `_drafts-endpoint.yaml`, `_drafts-mismatch.yaml`, `_drafts-excluded.yaml`, `_drafts-nline.yaml`, `_drafts-waiting.yaml` | the steps of `drafts.yaml` (each starts on Review drafts) |
| `_lint-open.yaml` | Sidebar → Lint, the title loaded, "Drafts with no device" folded (it comes back unfolded on every visit) |
| `_lint-fold.yaml` | folds the Lint group `GROUP` (env) until its header reads ▸ (a tap while a long group renders is lost) |
| `_lint-drafts.yaml`, `_lint-findings.yaml` | the steps of `lint.yaml` |
| `_rulings-build.yaml`, `_rulings-standing.yaml`, `_rulings-more.yaml` | the steps of `rulings.yaml` |
| `_cables-view.yaml`, `_cables-delete.yaml` | the steps of `cables.yaml` |
| `_dash-counts.yaml`, `_dash-found.yaml` | the steps of `dashboard.yaml` |
| `_dash-asfound.yaml` | the Dashboard's as-found link `KEY` (env) with no panel open (an open panel wraps the line out of reach) |
| `_dash-search.yaml` | the Dashboard's search box: `TERM` (env) typed, Return |
| `_projects-follow.yaml` | the home's project chip `CHIP` (env) → its levels; Lint, Cable / riser, Dashboard and Export follow (`HAS`, `HASNOT` level codes) |
| `_projects-level.yaml` | the new-project form: level `CODE` (env) added with Return, the keyboard closed |
| `station-setup.yaml` | (top level, step 1 of `rig.sh export` and `rig.sh review`) a new project with the 06M sheet and a station, synced |

Selectors: `id:` is the control's `testID` (`<screen>.<element>`, CLAUDE.md §5); plain text is a
regex on what is visible. A flow for a new screen gets its `testID`s in the same task.
The status bar is `id: status.bar`; its text ("Offline · 3 pending", "Synced …", "· n need attention") is what a flow asserts (T154: it used to carry the label "Sync status", which hid the text).
Variables come from `rig.sh` (`-e SERVER_URL=… TOKEN=… METRO_URL=… USER=… PROJECT=…`; its `RIG_*`
defaults). Top-level flows carry no `env:` block: a flow's own `env:` beats `-e` (T151), so run them
through `rig.sh`, or pass all five `-e` values to `maestro test` yourself. Failed steps leave
screenshots under `~/.maestro/tests/` and the `--debug-output` folder the script prints.

**What Maestro cannot see** (tapped by position, iPad Pro 13" simulator in portrait): the Files
picker (another process; `rig.sh files`, which `flows`, `seed` and `pipeline` call, puts exactly the files
a flow expects in "On My iPad", so they sit in a known order), iOS's *Save Password?* sheet, and the plan (PDFKit and a Skia overlay: pins are
not in the accessibility tree, so a spot on the sheet is a point).
