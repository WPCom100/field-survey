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
