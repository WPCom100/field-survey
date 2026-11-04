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

| Sub-flow | Walks |
|---|---|
| `_launch.yaml` | fresh launch (`clearState`), then `_devclient` |
| `_resume.yaml` | relaunch keeping the local store, then `_devclient` |
| `_devclient.yaml` | a dev client loads from Metro by deep link (`METRO_URL`; skipped for a `--release` build), its menu and Tools button closed, a stale "Open in Field Survey?" cancelled |
| `_connect.yaml` | Connect to server (URL, token) → pick the name `USER`; re-signs in when the keychain holds another name |
| `_new-project.yaml` | Projects → + New project (`PROJECT`, level 06M) → home → open the level → back |
| `_sources.yaml` | Setup → 3 Sources: DaVinci (two files), then the 06M display sheet; waits for both jobs |
| `_pick-wait.yaml` | waits for the Files picker before a position tap |
| `_drafts.yaml` | Setup → 4 Review drafts: three hand drafts, accepted / edited / rejected |
| `_place.yaml` | Setup → 5 Place devices → Place ▸ → first unit → tap the sheet → Place ✓ |
| `_card.yaml` | Devices list → card: status Issue, a note, Quick actions → Spot-check fixed (punch item) |
| `_open-device.yaml` | Projects → `PROJECT` (scrolls to it; waits for it to arrive) → 06M → Devices → the card |
| `_sync.yaml` | Sync → Sync now → `Synced <time>` → back |
| `_seed-import.yaml` | Setup → 3 Sources → Seed import: the master from Files, the Checks, the mapping (a wrong column flagged and put back), Import |
| `_seed-vocab.yaml` | Vocabulary → Load standard lists twice |
| `_seed-review.yaml` | Needs review on a fresh seed: Link, Create device ▸, Put on, Keep |

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
