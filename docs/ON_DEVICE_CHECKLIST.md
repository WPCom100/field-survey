# On-device checklist

Things only an iPad can prove. Each finished task adds its checks here; you test several features in one session; then say **"tested"** with the results and Claude archives this list to [on-device-log.md](on-device-log.md) and resets it. How the file is kept: see "Rules for this file" at the bottom.

## Before you start (once per round)

1. **Which build?** Check each task's "Needs" line. If any pending task says *new dev build*, run `eas build --profile development --platform ios` and install it first. Otherwise the dev build already on the iPad works.
2. **Load the latest JS.** On the PC: `git pull`, then `cd app && npx expo start --dev-client`. Open the app on the iPad and let it load from Metro (same Wi-Fi).
   **TestFlight iPads** (from build 13 on, T84) get the latest published JS by **launching the app twice**: open it, swipe it away from the app switcher, open it again. The Sync screen's Install section then shows `update <id> · <date> · T<nn>: …` instead of `embedded`.
3. **Logs.** In the Metro terminal press `j` to open React Native DevTools; app logs appear there, not in the terminal.
4. **Mark results as you go.** Tick `[x]` for pass. For a fail, leave it `[ ]` and write what you saw after "→ saw:". Then paste this file back to Claude.

Pending round started: **2026-11-02**. The fresh-start round of 2026-11-01 ran Parts 0–C and D-3 … D-5 of the sheet on one iPad and is archived in [on-device-log.md](on-device-log.md): 40 pass, 3 fail, 13 skip, 109 not done; Parts D (from D-6), E, G, H and the two-iPad Part I not started. The fails became **T134** (riser outline and focus: the page index), **T135** (enlarged crop: pinch and pan), **T136** (a waiting cable is invisible outside Review drafts) and **T137** (the riser’s label shown instead of the draft’s model); Landry’s notes became **T133** (settled conflicts stay on the mismatch list), **T138** (delete a connection), **T139** (undo a placement), **T140** (proposals by the printed text, stations and sensors too), **T141** (heavy sheets lag), **T142** (the 422 reason; a two-way share) and **T143** (move a flagged draft); Landry’s answers of 2026-11-02 added **T144** (ERn enclosures → Equipment Panels, D232) and settled D233 (T141), D234 (T140) and D235 (T136: a connection with one placed end is made at once, the far end follows placement). No Decision line was answered: the ones below stay. What passed has left this file; what is below was skipped, not done, or failed and waits for its fix.

**The sheet:** https://claude.ai/artifact/TbM5bqU6V1F1VUZxXK5JMy, rebuilt 2026-11-02 as round **ROUND-1102** (fresh results, collection `round1102`): only what is open; the fails are "Retest after T13n"; the projects of 2026-11-01 (`Scratch1`; `pipeline test` with its BOM and riser in and 03 reviewed and placed) are kept and a new **Master** is made in Part E. Where a check below names the Tower, Tower M3 round, Houston or TP-3 project, the sheet says which project to use. Server `f6c6aa0` (migration 0017), JS update `bf9eef31` for TestFlight build 15 and dev build `a5cbf96f` (runtime `24fe50c2`); T133–T143 each publish a newer update as they land (Sync → Install shows the newest).

**Decision lines whose sections passed and left this file, still unanswered:** D194 (riser lines with no bubble, T108 — amended by D221), D203 (library screen at catalogue size, T114), D204 (BOM and riser drafts by role, T115); and since 2026-11-02: D202 (accessory groups in the lint and on the card, T113), D216 (cable codes beyond the master's in the library and the Cable / riser view, T117), D224 (riser load-circuit lines are guessed 120V to Fixtures, T132), D228 (change a cable draft's code on any open draft, T128), D230 (dashed proposals for every panel the sheet names; full names in the list, T127). Their text is in DECISIONS.md. → Approve / change each:

**This round's build:** dev build `a5cbf96f` (T92) or TestFlight build 15; no new native build is pending. The long press was proven on 2026-11-01 (D-4, D-5: the menu opens with the finger still). **Server and JS:** every green push to `main` deploys the server and publishes the update (T85); `curl -s https://survey.wpcom.cloud/health` shows what runs.

---

## T92 — Long press without moving the finger  ·  Needs: new dev build `a5cbf96f`

**Why it matters:** the long press was held back until the finger moved (close-out D-15). T92 times it itself; these lines in Metro tell us what was holding it, so a fail can be fixed without guessing.

- [ ] **The new patch runs.** Open any plan: Metro logs `[plan] pdf native patch: t92 ink,longpress-move,press-timer`. → saw:
- [ ] **Timings in Metro.** Long-press the plan with the finger still, wait a second, lift. Metro logs, in this order: `[plan] long press native: timer fired ~300 ms after finger down, UIKit long press …, undecided: …; reached JS n ms later`, then `[plan] long press: began (menu open, finger down)`. Copy both lines into "saw" (the "UIKit long press" and "undecided" parts name what held it back; n should be under ~50). If a `UIKit recognised it … ms after finger down` line appears, copy it too. → saw:

Decision D165: our own 0.3 s timer starts the long press (not UIKit's recogniser), and a finger that drifts more than 10 pt before then is a pan, not a long press. → Approve / change:

## T89 — Floor PDF shows a survey date  ·  Needs: no new build; re-run after T91

**Why it matters:** a report that goes to the EC and GC must carry a date (R7).

Failed 2026-10-14 (close-out B-3): "I did not see a surveyed date field anywhere" — Setup → Levels has no Surveyed field yet → **T91**, which adds it and its own checks.

- [ ] **Export screen header line.** Export, Floor PDF, a level with no Surveyed date: the line reads `… — Level 06M · Surveyed <date>` (the day of the newest survey edit on it, else today), never a dash. → saw:
- [ ] **PDF header.** Generate that level's floor PDF and open it: every page after the cover carries the same date, no company name; the Connections, Punch list and Missing parts tables match the workbook for that level. → saw:
- [ ] **A set date wins.** Set the level's Surveyed date in Setup → Levels (T91): the header shows that date. → saw:

## T93 — A long export keeps its card; one at a time; Cancel  ·  Needs: no new build (server deploy + JS update)

**Why it matters:** on TP-3 a long export showed no status, its card vanished when you left the screen, and a second Generate waited behind it (close-out G-4). Use "TP-3 synthetic" so the export runs long enough to watch; T94 (speed) comes after.

- [ ] **Stage and counts.** Export → Generate workbook (all levels, all tabs). Within a few seconds the card shows a stage line that changes, e.g. `Photo Log 1,240 / 10,000 pictures · 1 min 05 s`, the count climbing and the time ticking. → saw:
- [ ] **Leave and come back.** While it runs, go back to Levels, then open Export again: the same card is there with the stage and the time still counting, without pressing anything. → saw:
- [ ] **Another iPad.** On a second iPad (any name), open Export on the same project: the same card, "Started by <first name>", same stage. Its Generate workbook button is disabled and the line above it reads `An export is already running (started by <name> hh:mm)`. Generate floor PDF stays available. → saw:
- [ ] **Cancel.** On the second iPad tap *Cancel export* → confirm. Within a couple of seconds both iPads show `Cancelling…`, then `Cancelled by <name>`; Generate workbook is enabled again. → saw:
- [ ] **Run one to the end.** Generate again and wait: the card ends at `Ready · <size>` and Share works; note the minutes from Generate to Ready (also T32's number below). → saw:

Decision D166 (already answered by you: one at a time per project and kind, anyone may Cancel) — nothing to approve.

## T32 / T94 — TP-3 export under 5 minutes  ·  Needs: no new build (server deploy; push T93 + T94 first)

Failed 2026-10-14 (close-out G-4): over 5 minutes (the server logs say 18–23 min), no status, the card lost on leaving the screen. Every other TP-3 step passed (`docs/perf/tp3.md` §3). **Why it matters:** T94 makes the server read the 10,000 Photo Log pictures 16 at a time instead of one by one; on the PC with the Droplet's storage delay imitated the whole workbook took 80 s. This proves it on the real server.

- [ ] **Export.** "TP-3 synthetic" → Export → Generate workbook (all levels, all tabs): time from Generate until Ready under 5 minutes? (Expect about 2.) The `Photo Log … pictures` count on the card should climb by hundreds a second, not a few. Open it in Excel from the share sheet: pictures in the Photo Log, no repair prompt. → saw:
- [ ] **Floor PDF still fine.** Generate floor PDF for 06M on the same project: Ready, opens. (Its speed is the T98 section below.) → saw:

## T81 — Punch List Device text follows the device  ·  Needs: no new build

**Why it matters:** the EC reads the Punch List's Device column to find the device; it must match the device as it is now (renamed, retagged), and a row the import could not link must not vanish into a wrong device.

Skipped 2026-10-14 (close-out E-8 … E-12). Use "Tower M3 round" (imported after T81; the Tower itself was imported earlier and has no review items for this). Needs review now opens on the project shown on the home (T83 passed).

- [ ] **Review items arrive.** Needs review → Lint tab: 13 items reading `Punch #… · Device "…" → link` (e.g. B1 #27 `Walter Tower east wing`, 04 #22 `Elec XX04-1E01`, three `Stations & sensors`). No item for the "Missing all Device Neuron IDs" rows. → saw (Claude, rig, 2026-11-03, seed.yaml): Needs review (31) on a fresh import = Import pair 8 + 23 Lint rows, among them B1 #27 `Walter Tower east wing`, 04 #34 `Elec XX04-1E01` (the master numbers it #34 now; #22 "Gain access" names the same room) and the three `Stations & sensors`; the split 13 link + 10 connection rows is not asserted one by one, nor the absence of a Neuron row. Left open for that.
- [x] **Link to device.** Select B1 #27: the panel shows the punch item and "Device, as the master wrote it: Walter Tower east wing". Type `S1` in the filter: the list narrows to B1 devices with S1 in the ID or text. Tap one → Link: the item leaves the list, the note reads "Linked: Review: linked punch item to B1-S1… (master: "Walter Tower east wing")". → saw (Claude, rig, 2026-11-03, seed.yaml): the panel shows "Walter Tower east wing"; filter `S1` lists B1-S1 and hides B1-01; Link → confirm → the row leaves and the note reads "Linked: … B1-S1 … Walter Tower east wing …".
- [ ] **Create device.** Select 04 #22 → Create device ▸: the + Device form opens in the panel with Room / Location empty-or-prefilled and "Not on the plan yet". Pick Relay panel, type `CT04LCPB`, Add device: the item closes as linked to `04-? (new)`. After the next sync the device gets its 04-nn ID. → saw (Claude, rig, 2026-11-03, seed.yaml, on 04 #34 "Elec XX04-1E01"): Create device ▸ opens "Create device for this punch item" with "Not on the plan yet"; Power Distribution, model `CT04LCPB`, room → Add device → the note reads "Linked: … 04-? (new) …" and the row leaves. Not asserted: the 04-nn ID after the next sync (F3, T155).
- [ ] **Place the new device.** Open level 04 → Devices list → the new device (it is in the "not on the plan" count) → card ⋯ → **Place pin…**, give a reason, tap the plan: the pin appears there. → saw:
- [ ] **Lists show the derived text.** On B1, the Punch side list: #8 reads `B1-S3 · PI1002 S3 - Corridor XXB1-C005, north · Install cover…` (the device's room, not the master's spelling); an unlinked row (e.g. a `Stations & sensors` one still open) shows the master's text. → saw:
- [ ] **A rename follows.** Open B1-S3's card, change Room / Location: the card's Punch items line and the side list's #8 show the new room at once, with no edit on the punch item (its history has no new entry). → saw:
- [ ] **Two iPads.** Link an item on iPad A; after a sync iPad B no longer lists it and shows the same Device text for that punch item. → saw:
- [ ] **Export.** Export the workbook (Export screen, synced): Punch List row B1 #8 shows the renamed room; 04 #22 shows the new panel's name; an item left unlinked shows the master's text (e.g. `Stations & sensors`). → saw:

Decision D151: answered 2026-10-14, **Approved**.

## T84 — Over-the-air JS updates (leftovers)  ·  Needs: a TestFlight iPad; the rollback needs a "publish a test update" session with Claude

Skipped 2026-10-14 (close-out C-18, C-19). Everything else in T84 passed.

- [ ] **An iPad offline for a day catches up.** Leave one TestFlight iPad in airplane mode (or off) while an update is published; the next day turn the network on and launch twice: it shows the new update. Nothing typed offline is lost (Sync → Pending edits drains). → saw:
- [ ] **Rollback.** After a second test update, Claude runs `eas update:republish` of the first one: two launches later Install shows a **new** update id with the **first** update's message. → saw:

Decision D157: answered 2026-10-14, **Approved**.

## T87 — One name on two iPads  ·  Needs: no new build; two iPads

The two-name check passed in the close-out (Part A) and the name on the home passed 2026-10-18 (B-1). Sheet D-32.

- [ ] **Same name on two iPads: both inks survive.** Both iPads signed in under the **same** name, both cached 06M, airplane mode on both. A draws over the rack area first; a minute later B circles a station. Airplane mode off on B, wait for Synced; then A. Open 06M on A: within a few seconds A's strokes come back next to B's; the Metro log reads `[plan] ink: merged 1 concurrent write(s) into layer …`. Sync B and open 06M: the same strokes. No review item. → saw:

Decision D162: answered 2026-10-14, **Approved**.

## T47 — Lock / unlock baseline (leftover)  ·  Needs: no new build; two iPads

- [ ] **Offline and the other iPad.** Airplane mode on, lock a level (works, ↑ on the History line); airplane off, Synced. On the second iPad (different name) after its sync the level reads `🔒 Locked` on the Levels screen and the History line names who locked it. → saw:

Decision D164: answered 2026-10-14, **Approved**.

## Carried over: T25 — Sync & uploads screen  ·  Needs: no new build

- [ ] **Download assigned levels with a plan.** Sync → Download assigned levels: the message says how many files were queued; ⬇ → … → ✓ for levels with a plan. **No assignment is needed:** with none, every in-scope level counts as yours (D97); T97 adds assigning. (Skipped 2026-10-14, close-out C-2.) → saw:
- [ ] **Retry failed uploads.** Greyed normally; if a red "Upload failed" line appears, Retry clears it. Skip if nothing failed. → saw:

## Carried over: T21 — Upload resume  ·  Needs: no new build

- [ ] **Upload resume.** On a real level take several photos, force-quit while they upload, relaunch: uploads finish, nothing sent twice; Sync shows Photos waiting → 0. (Not done 2026-10-14, close-out C-6.) → saw:

## T75 — A refused edit (only if one happens)  ·  Needs: no new build

- [ ] **A refused edit shows and the rest goes.** A refused edit cannot be provoked from the iPad on purpose. If the status bar ever reads "· N need attention": the Sync screen lists each refused edit (what · when · tries · the server's error) with Retry refused edits, other edits made afterwards still reach the other iPad, and Retry sends the listed ones again. → saw:

Decision D145: answered 2026-10-14, **Approved**. Whether you want a **Discard** action for an edit the server will never accept is still open (DECISIONS.md, Open now).

## T65 — Imported multi-device photos (observation)  ·  Needs: no new build

- [ ] **Imported multi-device photos.** On the Tower project, if a photo shows several devices in the master (`B1-01, B1-02`): note whether only the first device shows it (expected for data imported before T65; see the Tower backfill question in DECISIONS.md). → saw:

## T91 — Surveyed / Updated dates in Setup → Levels  ·  Needs: no new build (JS update)

Set the date and Bad date refused passed 2026-10-18 (C-2, C-3). Sheet G-1.

- [ ] **Header follows.** Export screen's Floor PDF header line for 06M reads `Surveyed 2026-10-13`; a level with an empty box still shows its newest survey date (D159). → saw:

## T33 — Rule drafts: Accept / Edit / Reject on the card  ·  Needs: no new build (JS update; server deploy first)

**Why it matters:** the rule engine core is in; since T34 the real rules raise the demo's drafts (the seeded ones are gone), so the buttons are tried on real output.

- [ ] **Accept.** Open **Demo plan (06M composite)** → tap **06M-01** → the Punch items section shows `DRAFT ⚑ R3a Run Unison to Stations & Sensors`, `DRAFT ⚑ R3a Land 0-10V control wiring`, `DRAFT ⚑ R3b Terminate DMX to 06M-03` and `DRAFT ⚑ R2c cable`. Tap **why?** on the Unison draft: the rule's text and `… is Not installed: the wire has not been pulled.` appear. Tap **Accept**: the draft disappears and a new punch item `NEW · Run Unison to Stations & Sensors · Cable not run · EC · Open` is listed. → saw (Claude, rig, 2026-11-04, ends.yaml), on real data instead of the demo (same buttons): **Accept** on four drafts (R3a Run, R4b kit, R3b, the Run on 06M-02): each leaves the card and its item or part is listed, Punch items / Missing parts +1. Not run: why?, Edit, Reject.
- [ ] **Edit.** On the R3b draft tap **Edit**: small fields (item, type, owner, notes) appear; change the item text, tap **Save & accept**: the Punch items section lists the edited text as `Missing part · EC/ETC`. → saw:
- [ ] **Reject.** The demo database keeps decisions, so Reject needs a draft still open: on another team iPad (or after deleting and reinstalling the app) tap **Reject** on the `Land 0-10V control wiring` draft: it disappears and does not come back after leaving and reopening the card. → saw:
- [ ] **Sync still clean.** After the demo decisions, the Sync screen on a real project shows nothing pending from the demo (the demo database never syncs) and no "need attention" ops. → saw:

Decision D169: **approved** (Landry, 2026-10-15); nothing to answer here. (The "Nothing on a real project" check is replaced by T34's below: the rules now write.)

## T34 — Rules R1–R5, E5–E9 on real data  ·  Needs: no new build (JS update; server deploy first — D169's create rule)

**Why it matters:** the rules now raise drafts, findings and the Neuron ID item's upkeep on every project; two iPads must converge on one row each, and nothing may be written except drafts, findings and that one maintained item.

- [ ] **First run on the Tower.** Open the Tower M3 round project (after a sync). DevTools shows one `[rules] run` with `rules: 17`, `problems: 0`, and `created` > 0 the first time; the next run (half a second after any edit) shows `ops: 0`. Note the first run's `proposals` / `findings` counts here. → saw:
- [ ] **The master's items raise no duplicates.** On 06M open **06M-01** (CT06LCPB's panel card, or any panel with the master's `Terminate DMX …` items): the Punch items section lists the imported items, and no `DRAFT` repeats an item already there. Why: D175 (8) — an open item with the same text silences the draft. → saw:
- [x] **A Not installed end raises its Run item.** On a device with a connection, open the end editor, set a status-less end to **Not installed** → back on the card within a second: `DRAFT ⚑ R3a Run <signal> to <far end>`; set it to **Issue** with the chip "Run, not terminated" → the Run draft is gone and `DRAFT ⚑ R3a Terminate …` is there (`Termination`); on a DMX run pick "Run, not terminated; no term kit" → `DRAFT ⚑ R3b Terminate DMX to … · Missing part · EC/ETC` instead. → saw (Claude, rig, 2026-11-04, ends.yaml, on a fresh copy of the master): 06M-01's C-23 (X → the placeholder Level 11, Not started, no item) set **Not installed** → `DRAFT ⚑ R3a Run DMX to Level 11` on the card; after accepting it, **Issue** + the chip "Run, not terminated" → `Terminate DMX to Level 11 · Termination · EC/ETC`; the note "Run, not terminated; no term kit" → `Terminate DMX to Level 11 · Missing part · EC/ETC` and the Termination draft gone.
- [ ] **Accept R3b, then R4b follows.** Accept the R3b draft: the item appears; within a second `DRAFT ⚑ R4b DMX termination kit - <far end> run · part · EC · Needed` appears on the card. Accept it: the Missing parts section lists it with `src #<the item's number>` once the server has numbered the item (Qty 1, Need to be ordered). → saw (Claude, rig, 2026-11-04, ends.yaml), the unpulled-run path (T103): accepting `Run DMX to Level 11` raised `DRAFT ⚑ R4b DMX termination kit - Level 11 run`; accepted, Missing parts +1 and after the sync `Needed · EC · src #19 · Need to be ordered`. Then accepting the R3b item on the same end raised no second kit. Not run: R3b accepted on an end with no Run item first (R4b following it).
- [ ] **Neuron ID item upkeep (D170).** On a level whose Neuron ID item is the master's ("Missing all Device Neuron IDs"): type a Neuron ID on a device of that level; within a second the item's Notes (card of any device on the level → Punch items, or the export) no longer list that device; History on the item shows `Rule engine R3c`. On a fresh project with no such item, the draft is in the store but **no screen shows it yet** (T100) — nothing to see. → saw:
- [ ] **Two iPads, one row.** Both iPads online on the same project: make the same end `Not installed` on iPad A, sync both; iPad B shows the same single `DRAFT ⚑ R3a` (not two), Needs review stays empty. Reject it on B, sync: A's card loses the draft. → saw:
- [ ] **Library drafts.** On a Relay panel with no P cable (06M-01 on the demo, or a field-added panel): `DRAFT ⚑ R2c cable` → **why?** names the EBDK; **Accept**: the Connections section gains `NEW · P → EBDK panic wire · Installed, untested`. An NSPS or rack without 120V shows `DRAFT ⚑ R2d cable` the same way. → saw:
- [ ] **Quick actions.** On a station's card open **Quick actions**: **Spot-check fixed** → type what was found → Apply: a Closed `Information · ETC` item `Spot check: …` with notes "Reterminated - all good", device Notes unchanged. **Non-ETC device** → type `Wattstopper` → Apply: status `Not installed`, Notes end with `…appears to be a Wattstopper, confirm.`, an Open `Information · EC` item `Confirm existing station at location is a Wattstopper, not a PI1002`. **Relocated** → type a room → Apply: Room / Location reads `<room>; moved from <old room>`. "Not found on site" stays disabled. → saw:
- [ ] **Findings on the card.** A device set to **Installed, untested** with an end `Not installed` shows the finding line `Installed, untested with outstanding wiring/termination → Issue (suggested)`; set it to **Issue** with no open item → `Issue device with no open punch item`; accept or add an item → the line goes. → saw (Claude, rig, 2026-11-04, ends.yaml): 06M-04 (both ends Issue) set **Installed, untested** → `⚑ R1.untested: Installed, untested with outstanding wiring/termination → Issue (suggested)`; back to **Issue** → the line goes. Not run: the "Issue device with no open punch item" half.
- [ ] **Sync load.** After the first run, the Sync screen pushes the engine's proposal and finding creates (count them in the outbox before the sync; on the Tower round expect a few hundred) and ends "Synced" with no "need attention" ops. → saw:

Decision D175: **approved** (Landry, 2026-10-15) as the defaults; D176 makes every value settable per project and in the library (T102). Nothing to answer here.

## T36 — Lint view: findings by check, dismiss with a reason  ·  Needs: no new build (JS update)

**Why it matters:** the rules' findings and the PLAN §6.3 checks now have their own screen; a finding can be dismissed with a reason and comes back when its facts change, so nothing is silenced for good by mistake.

- [ ] **Open it.** On the Levels home tap **Lint** in the sidebar (the Tower round project): the title reads `Lint (<n> open · 0 dismissed)`; groups are listed by check, starting with the PLAN §6.3 ones (e.g. `Issue device without open punch item (…)`, `Cable with missing far end (…)`). Note the open count here. → saw:
- [ ] **The master's unresolved far ends.** `Cable with missing far end` lists the runs whose far end the import could not pair (the UFMP4 #1/#2 and (7) runs on 01, 03 and 04, and a few DMX/network runs on 01–04: 12 on a fresh import of the master). Each also sits in Needs review → Import pair. → saw:
- [ ] **Filter and group.** Tap a level chip: only that level's findings stay. Tap **Group by → Level**: one group per level, each row naming its check. Tap a group header: it folds and unfolds. → saw:
- [ ] **Open card.** Select a finding on a device, tap **Open card ▸**: the plan opens on that level with the device's card. Back returns to Lint. → saw:
- [ ] **Dismiss with a reason.** Select an `Issue device without open punch item` finding → **Dismiss…** → the **Dismiss** button stays disabled until a reason is picked or typed; pick `Checked on site: correct as is` → **Dismiss**: the row leaves the list, the title counts one more dismissed, **Show → Dismissed** lists it with the reason. → saw:
- [ ] **It comes back when the facts change.** On that device's card set the status to anything but Issue, wait a second, then set it back to **Issue**: the finding is open again in Lint (the dismissal covered the earlier occurrence). For a message that names facts (e.g. `Duplicate Neuron ID … also on 02-S2`), changing those facts reopens it too. → saw:
- [ ] **Reopen.** In **Show → Dismissed** select a dismissed finding → **Reopen**: it is back under Open. → saw:
- [ ] **Two iPads.** Dismiss a finding on iPad A, sync both: iPad B's Lint shows it dismissed with A's reason; Needs review stays empty. → saw:
- [ ] **Fix all via ruling.** If a `Value outside vocabulary` group exists (a category outside the list, or an old spelling once T40 seeds the vocabulary), its header lists `"<value>" ×n` with **Fix all via ruling ▸**: since T37 tapping it opens the ruling editor pre-filled (see the T37 checks). Nothing is changed until a preview is applied. → saw:
- [ ] **Links into Lint.** Needs review → **Lint** tab → `Open the Lint view to dismiss or fix them ▸` opens Lint; Export's pre-flight `See the <n> lint findings ▸` opens Lint too. → saw:

Decision D178 (Proposed): a dismissed finding stays dismissed while it says the same thing, comes back when its message (the facts it names) changes, and is raised again if its condition clears and returns. → Approve / change:

## T37 — Rulings: record, preview, apply, standing  ·  Needs: no new build (JS update)

**Why it matters:** one decision ("0-10V rows read Fixtures", "items without an owner are the EC's") is applied to every record it fits in one go, row by row in the Change Log as `Ruling` with its reason — and, when standing, offered on every record that fits later. Use the **Tower round project** or a throw-away one; a ruling writes real changes.

- [ ] **Open it.** Levels home → sidebar **Rulings**: the title reads `Rulings (<n> standing · <m> applied)`. On a project imported from the master the list already holds `Unison bus placeholder is spelled 'Stations & Sensors' (D50)` (standing, the import's renames counted). → saw:
- [ ] **Build one.** **+ New ruling** → Reason `0-10V rows read Fixtures` · Scope **All levels** · Where **Connection end**, condition `Cable` `=` `0-10V`, **+ condition** `To` `≠` `Fixtures` · Action **Set field** → `To`, value `Fixtures` · Standing ticked. Until the reason and values are filled, red lines say what is missing and **Preview ▸** stays disabled. → saw:
- [ ] **Preview with untick.** **Preview ▸**: `<n> changes on <k> levels` and a table Lvl · Ref · Field · Was → Now, one row per end that does not read `Fixtures` yet. Tap a row with a qualifier you want to keep: it greys out with ☐ and the title says `· 1 unticked`; **Apply** counts one less. **Back** returns to the editor with everything still filled. → saw:
- [ ] **Apply.** **Apply n**: the ruling opens in the panel (`n changes`, applied now, by you). On a ticked end the card/end editor reads `Fixtures`, and its History shows the change as **Ruling** with the reason. The unticked end kept its text. **Preview again ▸** shows nothing to change, and says the unticked record stays as it is. → saw:
- [ ] **Standing.** On a level, add a 0-10V row whose To reads something else (or edit one back to `Control wiring`); wait a second. The ruling's panel lists it under `Proposed by this ruling (1)` (and the device card shows the draft): **Accept** sets `Fixtures` as a Ruling change; **Reject** leaves it until the To text changes again. Untick **Standing**: the open proposal goes away; tick it again: it comes back. → saw:
- [ ] **Rename phrase.** A ruling on **Device** · `Notes` `has phrase` `Empty box on wall` → **Rename phrase** `Empty box on wall` → `Empty box on wall.`: the preview changes only that phrase inside longer notes. If the project has a device-note vocabulary, the footer says the old spelling is recorded; afterwards typing the old phrase on a device raises a `Value outside vocabulary` finding in Lint. (No vocabulary yet: the footer says only the records change.) → saw:
- [ ] **Generate item / Append note.** A ruling on **Connection end** · `Cable` `=` `0-10V` → **Generate item** `Land 0-10V control wiring`, Wiring, EC: one Open item per end, none twice (Preview again shows nothing). **Append note** adds a phrase after `; ` and never twice. → saw:
- [ ] **From Lint.** In Lint, **Fix all via ruling ▸** on a `Value outside vocabulary` value: Rulings opens with `New ruling · from Lint`, the reason pre-filled (`Rename "…" to "…"` or `Replace "…"`), `Only the n chosen records` and the levels as scope. Preview → Apply: the findings resolve in Lint. → saw:
- [ ] **From the plan lists (multi-select).** On a level's side panel tap **Select** (Devices, Conns, Punch or Parts tab): rows get ☐ boxes; tick a few (or **All n**) → **Apply as ruling…**: Rulings opens with `from <tab> on <level>`, `Only the n chosen records`. Pick an action (e.g. Punch → Set field `Owner` = `EC/ETC`), preview, apply. **Cancel** leaves selection mode; switching tab clears it. → saw:
- [ ] **Copy and Delete.** On a stored ruling **Copy as new** opens the editor with `(copy)` and nothing unticked; **Delete…** needs a reason; the ruling leaves the list, what it changed stays, its proposals go away. → saw:
- [ ] **Two iPads.** Apply a ruling on iPad A, sync both: iPad B lists the ruling and shows the changes; an edit on B to one of those fields made before syncing becomes a review item in Needs review, not a silent overwrite. → saw:

Decision D179 (Proposed): how a ruling is stored and applied — level codes as scope; `filter.ids` for chosen records and `filter.except` for unticked ones (never touched or proposed again); rename = whole value or one `; ` phrase and records the old spelling only in a vocabulary list the project already has (the first `punch_item` row would switch R3f on for every item); a standing ruling proposes on records that match later, Accept writes a `Ruling` op; items it generates carry `rule_id = ruling`. → Approve / change:

## T39 — Cable / riser view  ·  Needs: no new build (JS update)

**Why it matters:** every cable of the project on one screen with both ends, so a missing far end, a wrong status at one end or an unconfirmed endpoint is seen across floors, not one card at a time. Use the **Tower round project** (imported from the master) — Confirm endpoint writes a real change.

- [ ] **Open it.** Levels home → sidebar **Cable / riser**: the title reads `Cable / riser (80)` on a fresh master import. The footer reads `missing far end 12 · code mismatch 0 · status mismatch 0 · To ≠ riser 0 · unconfirmed endpoint 80 · Not started on in-scope level 0` (the 12 are the far ends the import left unpaired, the same 12 as Lint; every imported cable starts unconfirmed, D6). → saw:
- [ ] **Group by.** **Vertical** (default): groups like `06M-01 → X (DMX) <n>`, `Same-floor: U (Unison)`, and `Single-row: P · 0-10V · 120V` last. **Level**: one group per level; a run between two floors shows under both. **Code**: `X (DMX)`, `N (network)` … in that order. Tap a group header: it folds. → saw:
- [ ] **Rows.** Each row: Code · A (`06M-01 C-20`) · A status · B · B status · `⚠n` or `✓`. An end with no status reads `Unsurveyed`; a cable with one end reads `⚠ missing end`; an `ⓡ` marks an open Needs review item. Levels show in brackets when the ends are on different floors. → saw:
- [ ] **Filters.** Tap a level chip, a code chip, a status chip (`Unsurveyed` too) and **☑ only**: the list narrows and the title reads `(<shown> of 80)`. Tap `missing far end 12` in the footer: only those 12 stay; tap it again to clear. → saw:
- [ ] **End editor in the side panel.** Tap a row: the right panel shows the T22 end editor (both ends stacked, status buttons, note, From/To, riser check) with **◀ Cables**; below it **Checks on this cable** and **Riser crop**. Change the far end's status: the row and the footer counts update. **Jump to …** opens that level's plan with the pin lit; Back returns here. → saw:
- [ ] **Confirm endpoint.** On a cable with `unconfirmed endpoint`, tap **Confirm endpoint**: the check leaves the list, the footer counts one less, and the end's History (on the card) does not change — the cable's change is `Riser cross-check` with reason `Endpoint confirmed against the riser`. → saw:
- [ ] **Needs review link.** On a row with `ⓡ` (an Import pair item) tap **Open Needs review item ▸**: Needs review opens on that item. → saw:
- [ ] **Riser crop.** Every master cable says `No riser crop for this cable: the riser has not been extracted for it (riser extraction, T43).` — expected until T43 writes `riser_ref`. (Nothing more to check on the iPad yet.) → saw:
- [ ] **Apply as ruling.** Tap **Select**, tick two rows (or **All n**) → **Apply as ruling… (n)**: Rulings opens `from Cable / riser` with `Only the n chosen records` (both ends of each cable) and their levels as scope. **Cancel** leaves selection mode. → saw:
- [ ] **Offline.** In airplane mode the view, filters and end edits still work; Confirm endpoint queues like any edit. → saw:

Decision D180 (Proposed): the cable view's six checks (code mismatch = no code, a code outside the list, or a riser label naming another signal; unconfirmed = any cable with `endpoint_confirmed` false, so all 80 imported cables until confirmed; `Not started` is fine on a run to an out-of-scope level), Confirm endpoint as one `Riser cross-check` op, derived verticals when none is stored, and `riser_ref = {sheet, bbox: [x, y, w, h]}` in sheet coordinates for T43. → Approve / change:

## T38 — Dashboard and search  ·  Needs: no new build (JS update — `victory-native` is JavaScript over the Skia already in the binary; the fingerprint did not change)

**Why it matters:** the workbook's Summary tab on the iPad, offline, with every number one tap from the records behind it — the counts the EC and GC will read in the export. Use the **Tower round project** (imported from the master) and keep the master's **Summary** tab (or the latest export's) open beside it.

- [ ] **Open it.** Levels home → sidebar **Dashboard**: header `Dashboard ← Levels as of sync hh:mm (local data)`, Levels and Owner chips, a search box. Four sections: *Device status by floor* (with Surveyed / Updated), *Outstanding items by floor*, *Outstanding items by owner*, *Missing parts by floor*, each a table with a stacked bar chart beside it and a colour legend. → saw:
- [ ] **Same numbers as the Summary tab.** Compare every cell with the workbook's Summary: on a fresh master import the totals are 70 · 50 · 77 · 13 · 0 = **210** devices, 198 · 1 · 16 = **215** punch items (EC 169, ETC 24, EC/ETC 22), 81 · 0 · 2 · 2 = **85** parts. After survey edits, compare with a fresh export's Summary instead — they must match exactly. Devices with no status are in no column; the line under the table says how many (`n Unsurveyed`). → saw:
- [ ] **Charts.** One bar per floor (per owner on the by-owner table), stacked in the table's column order, tallest bar reaching the top; colours: Installed, untested purple, Issue red, Not installed light red, No access yellow, Complete green; Open red, In progress yellow, Closed green; Needed red, Ordered yellow, On site blue, Installed green. Rotate the iPad: the charts redraw to the new width. → saw:
- [ ] **Drill-down (D17).** Tap a count (e.g. `01` · `Issue`): the cell turns blue and a panel opens on the right: `Device status by floor · 01 · Issue (7)` listing exactly that many devices (level, ID, device · room, status). Tap a **Total** cell, a **Total** row cell and the bottom-right total: the lists hold every row counted there. Tap a row: that level's plan opens with the device's card; Back returns to the dashboard with the panel still open. A punch item or part with no device opens the level's plan. → saw:
- [ ] **Filters.** Tap a level chip: every table shows that one floor (the owner table counts that floor's items only). Tap **EC**: the punch and parts tables count only `EC` items (not `EC/ETC`, which is its own row); the device table does not change. **All** clears each. → saw:
- [ ] **As-found and readiness.** `As-found: field additions n · never found n · Neuron IDs captured n/210` — tap each: the panel lists those devices (Neuron IDs lists the devices still without one). `Readiness: B2 setup · B1 setup (2 review) …` — a level in setup with review items opens Needs review; lock a level (Setup → Levels) and it reads `ready`; edit a device on it and it reads `surveying` after the dashboard reloads. → saw:
- [ ] **Apply as ruling from a drill-down.** In a drill-down tap **Select**, tick two rows (or **All n**) → **Apply as ruling… (n)**: Rulings opens `from Dashboard: <table> · <key> · <status>` with `Only the n chosen records` and their levels as scope. **Cancel** leaves selection mode. → saw:
- [ ] **Search.** Type `06M-04`: the panel shows `Search "06M-04"` grouped **Devices · Connections · Punch · Parts · Photos** (only groups with hits), each row with level, ID / number and text; tap one → its plan and card. Try a room name, a phrase from Notes (`Empty box`), a Neuron ID, `#12`, `c-14` (that connection only) and `dmx`. **Close** clears the search. → saw:
- [ ] **Offline.** In airplane mode the dashboard, drill-downs and search all work (local data); the header still says when the last sync was. After syncing an edit from another iPad the numbers update without leaving the screen. → saw:
- [ ] **TestFlight build.** After the update reaches a TestFlight iPad (two launches), open the Dashboard there too: the charts draw and the app does not close (the charts run Reanimated code on the UI thread, which only a release build proves). → saw:

Decision D181 (Proposed): the dashboard counts exactly what the export's Summary counts (in-scope levels in floor order, live records, a status outside the columns in no column and not in Total); the **Owner** filter is exact (`EC` does not include `EC/ETC`, unlike the plan's D99 filter) and applies to punch items and parts only; readiness = `setup` until locked (with unreviewed drafts + open review items counted), `ready` once locked, `surveying` once any edit to the level's records lands after the lock; search covers every level of the project, in scope or not. → Approve / change:

## T40 — Vocabulary and placeholder editors  ·  Needs: no new build

**Why it matters:** the note chips, captions, categories and placeholder endpoints are the project's own vocabulary; they must be editable in the field without losing a phrase.

- [ ] **Open it.** Home sidebar → **Vocabulary**. Two tabs: Lists and Placeholders. → saw:
- [ ] **Load standard lists.** Tap **Load standard lists**: a line says how many values and placeholders were added; the Lists tab shows the master's phrases (e.g. `Empty box on wall.`) and the eight categories, Placeholders shows Fixtures, 120v Power, Stations & Sensors, Level 09–12 and the rest. Tap it again: "Everything standard is already here." → saw (Claude, rig, 2026-11-03, seed.yaml): "Added n values and m placeholders."; `Empty box on wall.` under Device notes; the tab reads `Placeholders · n`; second tap "Everything standard is already here." (found and fixed: the line was cleared as soon as it was set, T154). Not asserted: the eleven categories and the placeholder names (S4, T158).
- [ ] **Add, accept, edit, remove.** Add `Stuck button` to Device notes: it shows with a yellow `draft` tag; **Accept** removes the tag; **Edit** renames; **Remove** deletes. A repeat of the same spelling is refused. → saw:
- [ ] **Chips follow.** Open a device card on the plan: the Notes chips show the project's Device notes (including a fresh draft). → saw:
- [ ] **Endpoint picker.** On a connection whose end is a placeholder (e.g. fixtures), open the end editor: **Change placeholder…** lists the project's placeholders; pick another and the header and the Cable view show it. **Add & use** creates one. A device end has no picker. → saw (Claude, rig, 2026-11-04, ends.yaml): C-23's far end (Level 11) → **Change placeholder…** → "Choose a placeholder" with the project's list, Level 11 marked → `Maestro spare` + Return (Add & use) → the end reads "Other end: Maestro spare". Not asserted: the Cable view's row (R4, T157) and that the device end has no picker.
- [x] **Remove guard.** Remove a placeholder a connection still uses: refused with the count. → saw (Claude, rig, 2026-11-04, ends.yaml): Manage… → Vocabulary › Placeholders → Remove `Maestro spare` → "1 connection end still uses this placeholder." and the row stays (found and fixed: it read "1 connection end still use").

Decision D182 (Proposed): `vocab.state` draft/accepted, seed as a Load button, placeholder removal guard. → Approve / change:

## T48 — Device-type library editor (project)  ·  Needs: no new build (JS update)

**Why it matters:** device types carry the runs every device of the type must have; accepting one is how a new floor's NSPS, panels and racks get their library cables proposed instead of typed by hand. Use the **Tower round project** (or a scratch one).

- [ ] **Open it.** Levels home → sidebar **Library**: `Device-type library (n types · n drafts)`, **+ New type** and **Copy from…** on the right; the list on the left is grouped by category, each row with its device count. A model typed freely on the plan earlier (T23, e.g. `ERP-XYZ`) shows as `DRAFT ERP-XYZ` with `added by <you> <date> ⚑`. → saw:
- [ ] **New type.** **+ New type** → model `P-NSPS-D-KIT`, category **NSPS** → **Add draft**: the editor opens on it with `DRAFT`; the device count says how many devices already carry that Device text (on the master: 4). Adding the same model again is refused with "already in the library". → saw:
- [ ] **Edit and save.** Aliases `P-NSPS-D`; ID scheme **Level-number**; Default cables **+ add cable** → code **120V**, From `120v Power`, To `P-NSPS-D Power Supply`, Far end `120v Power`, Single row on; Optional accessories → **+ P-NSPS-D Power Supply (expected 1, D52)**. **Save** → "Saved."; leave and come back: everything is kept. `Rules that reference this type: R2e, R2g`. → saw:
- [ ] **Accept raises drafts for existing devices.** With the form saved, **Accept draft** → "Accepted. The rules will offer its default cables to 4 devices as drafts." Open an NSPS card on the plan (one without a 120V row): its draft reads `R2g cable` with **why?** "… is a P-NSPS-D-KIT (library: 120V → P-NSPS-D Power Supply)", and the old `R2d` draft is gone. Accept it: the connection appears with the type's From / To; the draft does not come back. → saw:
- [ ] **Template edit follows open drafts.** Change the To text in the type, Save: on another NSPS card still showing the draft, its text follows after the rules run (a second or two). → saw:
- [ ] **Reject and back.** Reject a draft type: it moves under **Rejected** (greyed) and leaves the + Device type picker on the plan; **Back to draft** restores it. → saw:
- [ ] **Copy from.** In a second project (e.g. Scratch), Library → **Copy from…** → pick the Tower project → tick the accepted types → **Copy n**: they arrive accepted; a model the project already has is listed as "already here". → saw:
- [ ] **Two iPads.** After a sync, the other iPad's Library shows the new type and its state. → saw:

Decision D183 (Proposed): cable templates `{code, from, to, far, single_row, qty, status}`; only an accepted type with default cables governs its devices (R2g drafts; R2c / R2d stand aside; U stays R2e's per level); imported devices match a type by model or alias; Copy from copies accepted types only. → Approve / change:

## T61 — App-level device-type library  ·  Needs: no new build (JS update; server deploy with migration 0009 first)

**Why it matters:** device types added on one job carry into the next: the app library lives apart from any project, syncs between iPads like project data, and every new project starts from it.

Failed 2026-10-18 (sheet A-2, A-3): "The sidebar is too small and all the text is bunched up; the buttons at the bottom should be visible the whole time" and "Upon clicking save you seem to lose the state of the information panel" → **T125** (done; re-run A-2 and A-3 with its section below). Promote (B-27) and New project copies it (C-1) passed. Sheet A-4 … A-6 need the second iPad.

- [ ] **Second iPad.** Within a few seconds the other iPad's app library shows `TEST-TS-1` accepted (no project open needed). → saw:
- [ ] **Conflict.** Both iPads offline (airplane mode), open the same app-library type, change its Aliases differently, Save on both; back online: the library header reads `1 in review ▸` → **App library — needs review** lists `Device type …` · Aliases with A / B; Choose B → both iPads show B's aliases and the item is gone. → saw:

Decision D184 (Proposed (2)–(5)): the library's ops are stored with no project and named by a fixed stream id on the iPad; the library syncs first; `promoted_from` is a plain id; Promote and "Copy from…" into the app library record `promoted_from`. → Approve / change:

## T68 — Neuron ID needed per device type  ·  Needs: no new build (JS update; server deploy with migration 0010 first)

**Why it matters:** racks and NSPS have no Neuron ID (your note from the 2026-10-11 round, T20-4). Until now the card asked for one and "Missing all Device Neuron IDs" listed them, so the EC's list was never going to close.

- [ ] **Card hides it on a rack or NSPS.** Open any Equipment rack or NSPS card on the Tower round project: no **Neuron ID** section. A Relay panel, Station or Sensor card still has it. → saw:
- [ ] **The Neuron item leaves them out.** Rules (or the punch list) → "Missing all Device Neuron IDs" on a floor with a rack or NSPS: within a few seconds its Notes no longer name the rack / NSPS IDs (one "Rule engine R3c" edit in its History). → saw:
- [ ] **Dashboard.** Dashboard → as-found line reads `Neuron IDs captured n/N` where N no longer counts racks and NSPS (on the seeded master: 204 of 210 devices). Tapping it lists no rack or NSPS. → saw:
- [ ] **Per-type override.** Library → pick a Station type → **Neuron ID** shows `Category default (needed)` selected; choose **Not needed** → Save. Open a station of that type: no Neuron ID section, and the Neuron item's Notes drop it. Choose **Category default** again → Save: it comes back. → saw:
- [ ] **Second iPad.** The other iPad shows the same choice in the Library and the same card within a few seconds. → saw:

Decision D185: a type's `needs_neuron_id` is empty by default, meaning "the category decides": **off for Equipment rack and NSPS, on for every other category**. A device with no type follows its own category. The editor's **Needed** / **Not needed** overrides that. A card whose device has a Neuron ID anyway still shows it. → Approve / change:


## T105 — Optional cables and accessories on the card  ·  Needs: no new build (JS update)

**Why it matters:** a device type's optional runs (an NSPS's extra 120V, a panel's network drop) and optional accessories (a back box) were stored in the Library but nowhere to be added on site; now one tap on the card adds them with the type's texts, and cable drafts say what they are.

- [ ] **Set up a type.** Library → pick (or add and accept) an NSPS type with a default `120V` and an optional `N` (To `switch`, Far end a placeholder label such as `Network switch`) and an optional accessory `Back box` expected 1 → Save. → saw:
- [ ] **Greyed rows.** Open a device of that type: under Connections a greyed, italic `+ add N → switch` row marked `optional`; under Accessories `+ add Back box` with `expected 1` (the Accessories section shows even if the device had none). → saw:
- [ ] **Add the cable.** Tap `+ add N → switch`: a `NEW` connection `N → switch` appears at once and the greyed row is gone; open it in the end editor: the far end is the `Network switch` placeholder. History on the cable shows one `Field survey` change. → saw:
- [ ] **Add the accessory.** Tap `+ add Back box`: it becomes a normal accessory row `Back box expected 1` with found 0 / 1 buttons, nothing selected. → saw:
- [ ] **Defaults first.** On a device of the type that still lacks its default 120V, an optional `120V` row is not offered until the 120V run exists (accept the R2g draft first). → saw:
- [ ] **Draft titles.** On any device with a cable draft (R2c / R2d / R2g), the proposal reads like `120V → P-NSPS-D Power Supply` or `P → EBDK panic wire`, not `cable`. → saw:
- [ ] **Second iPad.** After a sync, the other iPad's card shows the new connection and accessory, and no longer offers them. → saw:

Decision D186 (Proposed): an optional run is offered once the runs before it of its code exist (an accepted type's defaults first, then the optional ones one at a time); a draft type offers its optional runs at once, a rejected type and a deleted device offer nothing; an accessory is offered while the device has no row of that model; both adds are `Field survey` edits (the cable and its two ends as one group, built by R2g's builder). → Approve / change:


## T44 — Review drafts (devices, cables)  ·  Needs: no new build (JS update; server deploy first — the crop route is new)

**Why it matters:** the BOM and the riser become reviewed drafts per level, with the paper next to each one, before anything is placed or locked. Nothing is accepted for you, and every Accept is recorded under your name. Use a **scratch project** with levels B2–06M (not the Tower round project), so nothing duplicates the seeded master.

Passed 2026-10-18 on the Pipeline project (sheet C-14 … C-21, C-24, C-27: upload — riser 15 min, Claude $2.84 — step 4, crops, SR / LR, BOM ≠ riser, Accept all, Edit / Reject / Reopen, Cables tab, hand drafts). What stays:

C-23 was skipped 2026-11-01 ("No idea where you are asking me to do this at in the app"): the mismatch list is **below the Devices table on the left** of Setup → 4 Review drafts (pick the level chip first); Excluded BOM lines is under it on the Devices tab only. Three settled conflicts stayed on 03’s list → **T133**. Endpoint picker, Confirm, links and offline passed.

- [ ] **Mismatch list.** Under the table, sentences like "BOM qty 1 ≠ riser 2 (PI1004)" and "Riser device not in the BOM: …". Tap one: its draft is selected. → saw:
- [ ] **Excluded lines.** Devices tab → **Excluded BOM lines ▸** lists service lines, brackets and similar items with their reason. **Promote…** one → it appears as a draft with Src **BOM↑** and asks for a category before Accept. → saw:
- [ ] **Second iPad.** After a sync, the other iPad shows the same states, and an accepted cable appears once in Cable / riser. → saw:

Decision D193 (Proposed): Accept on a device draft only marks it reviewed; its devices are made when placed (step 5, T46), so a level seeded from the master is never duplicated. Accept on a cable draft makes the cable once both ends are real records; if the baseline already has that cable, it is linked instead. A cable whose end is a not-yet-placed draft device waits until that device is placed. **Confirm endpoint** = Accept plus "endpoints confirmed"; Accept all leaves cables unconfirmed. A source conflict is settled by Accept (the drafts' count) or Reject (the baseline's). Flagged drafts get no Needs review items: Needs review counts them and links to step 4. → Approve / change:

## T106 — Riser crop on cables made from the riser  ·  Needs: no new build (JS update)

**Why it matters:** a cable accepted from a riser draft now shows the riser itself in the Cable / riser view, zoomed to its bubble, so you can check the far end against the drawing without leaving the cable. Use the scratch project from T44 / T108 (it has accepted riser cables).

Failed 2026-10-18 (C-35): "I want to be able to pan and zoom on the cropped image once I click on it to make it bigger. Riser crop was working for a while and is now broken. No riser loads anywhere." → **T129** (why it stopped; a visible error; pinch-zoom on the enlarged crops). Not from the riser (C-37) passed. Re-run after T129:

C-35 failed 2026-11-01 in three ways: no outline and no focus on the bubble → **T134**; the N line set on the riser draft (To: the 06M rack draft) is waiting for placement and nothing but Review drafts says so → **T136**; the riser’s printed label (`PARADIGM P-NSPS-DIN`) shown for the draft instead of its model → **T137**. Download and upright passed; re-run the rest after T134 (landed 2026-11-02: see its section below).

- [ ] **Focused and outlined.** The crop opens **upright** (the drawing reads left to right, not on its side), zoomed to the cable's wire bubble with some of its line around it, and the bubble has a red outline. It is the same bubble the Review drafts crop outlined for that draft. → saw:
- [ ] **Pinch.** Pinch out and pan: the red outline stays on the bubble (it may trail a moment behind during the gesture). In Review drafts, tap a source crop to enlarge it: it pinches and pans the same way. → saw:
- [ ] **Page 2.** A cable from a level on sheet 002 (14–28 are out of scope, so pick one whose far end is there if you have one; else skip) opens on **p.2**, focused the same way. → saw:
- [ ] **Cached.** Pick another riser cable: it opens straight away, no download. Airplane mode: it still opens. → saw:
- [ ] **Accepted offline.** Airplane mode on: in Review drafts accept another riser cable with Confirm endpoint. Turn airplane mode off, sync, open it in Cable / riser: the crop still finds the riser (by its file name) and opens it. With airplane mode on at that point instead, it says the riser PDF could not be found, with **Try again**. → saw:

Decision D195 (Proposed): the riser's boxes are measured on the page as it is displayed (the Tower riser's pages are turned a quarter, `/Rotate 270`); the iPad turns them into PDF coordinates using the rotation the viewer reports, so the crop opens upright on the bubble with no new build. A cable accepted offline finds its riser by file name when it is shown, and nothing is written back to the cable. → Approve / change:

## T111 — DaVinci library import  ·  Needs: no new build (JS update; server deploy first, and **every iPad on the new JS before the first upload** — an older iPad refuses the new columns on pull until it updates, nothing lost)

**Why it matters:** ETC's whole catalogue becomes app-library drafts in one upload, so types are picked, not typed, and every project created afterwards starts with the accepted ones.

Passed 2026-10-18 (sheet B-2 … B-4, B-6, B-13 … B-15: the upload in 0.5 min, the drafts, the codes, Accept all, accessories not devices, a re-run). What stays:

- [ ] **A hand-made model.** Make a draft type "P-TS7-PE" by hand in the app library, upload again (any newer file) with the Retire box **off**: the line ends "1 model clash"; your type is untouched. → saw:

Decision D197 (Proposed): the import files its batch under the project you start it from (that project's Vocabulary takes the unmapped protocols as Cable codes drafts), writes the types to the app library as drafts with four new columns (description, datasheet, DaVinci provenance, accessory-only), keeps "one of these" accessory rules as a group on each row rather than an expected count, treats a model you already made by hand as a clash it reports and never merges, and never touches an accepted or rejected type on a re-run. → Approve / change:

## T112 — Roles on library types; the D196 categories  ·  Needs: no new build

**Why it matters:** the rules, the ID letters, the Punch List Device text and the pin shapes no longer read the words `NSPS`, `Relay panel`, `EBDK`…: they read the device's **role**, which its library type carries (D201). The categories become the eleven you grouped in D196, with the master's old names as old spellings.

**Order on a project** (D201 (3)): run the DaVinci import first (T111 checks), accept or at least leave the catalogue types as drafts, **then** Vocabulary → Load standard values, **then** fix the old spellings with one ruling.

- [ ] **Category picker.** On a plan, long-press → + Device: the category chips read Power Distribution · Emergency Equipment · Equipment · Equipment Panels · Equipment Rack · Power Supplies · Wall Plates · Lighting Console · Touchscreen · Station · Sensor (the eleven), in that order. The same list in Setup → Review → Edit a device draft, and in the ruling editor's Category options. → saw:
- [ ] **Pin shapes follow the role.** On a Centennial plan: the NSPS pin is a pentagon, the rack a hexagon, EBDKs wide rectangles, UFMP4s rounded squares (they match the catalogue's UFMP4 type), relay panels squares, stations circles, sensors diamonds, the touchscreen a triangle. Add a device with a `Power Supplies` type (E-SPS): its pin is an **octagon**. → saw:
- [ ] **Load standard values on Centennial.** Setup → Vocabulary → Load standard values: the line counts the new values; **Device categories** now lists the eleven (Equipment Rack included) and no longer lists Relay panel / Foundry panel / EBDK / NSPS / Equipment rack (they are old spellings now). Touchscreen, Station and Sensor are the same rows as before. → saw:
- [ ] **The rename ruling.** Lint → **Value outside vocabulary**: one finding per device still spelled the old way (`06M-04: Category "NSPS" is an old spelling of "Equipment"` …), with **Fix all via ruling**. Tap it: the ruling editor opens one rename per spelling (Relay panel → Power Distribution first); the preview lists every device it changes; Apply. Repeat for the other four. Afterwards the lint is quiet, each device's History shows a Ruling change with your name and the reason, and Device categories shows the old spelling pointing at the new one. → saw:
- [ ] **Roles survive the rename.** After the ruling: the NSPS pins are still pentagons and the Neuron ID item still leaves the NSPS out (they match the catalogue's P-NSPS-D-KIT by Device text); EBDKs still wide rectangles; UFMP4s still rounded squares; the rack still a hexagon. **The 11 relay panels (CTxxLCPA/B) turn into octagons** and lose R2c: their Device text is the panel tag, which matches no catalogue model (D201 (2)). On each relay panel's card pick its type (ERP24-FT / ERP48-FT, or the ERP-FT-241P / -481P alias if the catalogue has it): the pin is a square again and the card's Neuron ID / rules read as before. → saw:
- [ ] **Floor PDF and export.** Export a floor PDF of 06M after the ruling: the pin shapes on the page match the plan (octagon for an untyped relay panel until its type is picked); the Punch List tab's Device column still reads `P-NSPS-D-KIT`, `Equipment Rack 18U`, `EBDK (CT06LCPB)`, `UFMP4 - <room>` for the typed devices; the Devices tab's Category column shows the eleven. → saw:
- [ ] **ID letters by role.** In the project's Device-type library add a draft type `Test station`, category Equipment, role **Station**, Save. On a plan, + Device with it: the form asks for a tag (or leaves it to the server) and the device comes back as `<level>-S<n>`; a device added with E-SPS (Power Supplies, role Other) gets `<level>-<nn>`. Delete the test device and reject the test type afterwards. → saw:

Decision D201 (Proposed): (1) `library_type.role`, read instead of category strings everywhere; (2) a device of `Power Distribution` or `Equipment` with no type is `other` — its type carries the role (Centennial's relay panels need their type picked); (3) the rename is applied through Load standard values + the vocabulary lint's "Fix all via ruling", not by the seed import, so TP-4 and TP-8 stand and the riser schema waits for T115; (4) the DaVinci import's role table; (5) what stays on the master's eight. → Approve / change:

## T46 — Place devices from the unplaced list  ·  Needs: no new build (JS update; no server change)

**Why it matters:** setup ends with every device on its plan. Devices from the master and units of accepted drafts had no way onto the plan except one by one from the card; Landry could not tell what was unplaced without scrolling the whole list (M3 round A-4).

Set-up: the T115 **scratch** project, with its BOM / riser drafts reviewed (some accepted in Review drafts) and 06M's composite uploaded as the display sheet (Setup → Sources → Floor plans), downloaded on this iPad.

Tap to place (C-40) and Drag to place (C-41) passed 2026-10-18. C-40's note — "Need to include the full names of the devices to be placed. Having only their part numbers doesn't help." — is in **T127**.

Passed 2026-11-01 with notes: proposals "very off", none for stations or sensors → **T140**; "no way to remove a placed device … put it back into the list" → **T139**; "does a flagged draft go back to review or into the pool?" → **T143** (Move to… from the Flagged row). Everything but Entry points and Two iPads passed.

- [ ] **Entry points (A-4).** Needs review → All (or Extraction): a line per level with something left, "Not on the plan, 06M: n devices and m to place from drafts — Place on the 06M plan ▸" opens the plan with the panel. On the plan's Devices tab, "· n not on the plan" has **Place ▸** beside it; ⊕ Place in the plan tools opens the panel too; ◀ Done placing closes it. → saw:
- [ ] **Two iPads.** Place two units of the same pooled draft, one on each iPad, offline; sync both: two devices, the pool down by two, nothing in review. → saw:

Decision D205 (Proposed): (1) the unplaced list = pinless devices of the level + units of accepted drafts not yet placed, minus the level's existing devices that stand for a draft (panel tag, then model, then the one device of the role for a one-unit draft), and the pool on every in-scope level; (2) placing a baseline device sets only its pin and the fields you changed; placing a draft unit creates the device (`baseline_ref` = the draft, no ID — the server numbers it, no tag field per D118, the type from the library or a new draft type with the draft's role, the draft's accessories divided per unit when they divide), then makes the cables waiting on it; (3) "not on this sheet" is the draft's `not_on_sheet` flag, for drafts only; (4) dashed proposals come from the sheet's panel tags (exact tag or model first, then a 4+ character part of the model), never written until Place ✓; (5) the Lock table's Drafts / Flagged / Cables ⚑ columns and the "unreviewed drafts" / "draft devices to place" warnings. → Approve / change:


## T95 — Connection search shows the devices at both ends  ·  Needs: no new build (JS update)

**Why it matters:** in the close-out round (B-1) a connection search showed the run but not which devices it joins; you had to open the card to find either end.

Set-up: 06M on a project with cables (the Houston project or the scratch one), plan open, side panel on **Conns**.

- [ ] **Both ends on every row.** Each Conns row's second line reads `<this end> ↔ <other end> · <status>`, e.g. `06M-04 ↔ 06-02 · Issue`; an end on a placeholder shows its text (`Stations & Sensors`, `Fixtures`); a cable whose other end is not set yet shows `?`. A riser cable names the device on the other floor. → saw:
- [ ] **C-nn search lists both end devices.** Type `C-14` (or `c14`, `14`) in the search: Conns shows that one row; switch to **Devices**: the two devices at its ends are listed (one, if the other end is a placeholder or on another floor), and the plan shows just their pins. → saw:
- [ ] **A name search stays a name search.** Type an end device's ID (e.g. `06-02`): Conns lists the runs to or from it; the Devices tab shows that device only, not every device at the other end of those runs. → saw:

Decision D167: answered 2026-10-15, **Approved** (both). Nothing to answer here.

## T97 — Assign levels to people (two-iPad leftovers)  ·  Needs: no new build; two iPads

The tab, assigning several per level and All in scope / None passed 2026-10-18 (C-4 … C-6). Sheet C-7 … C-9 on the Pipeline project:

- [ ] **The other iPad follows a sync.** Sync both iPads. On Ann's Levels screen 06 and 06M carry ●, B2 does not; **Assigned to me** shows only 06 and 06M; Ann's Setup → Assignments shows the same ticks Landry set. → saw:
- [ ] **Only your levels once you have some (D208).** On Ann's iPad Sync → **Download assigned levels**: only 06 and 06M plans download (B2 stays "not cached" unless cached before). On Landry's iPad (no assignment now) the same button fetches every in-scope level. → saw:
- [ ] **Anyone can change it.** On Ann's iPad untick 06 × Ann, sync both: Landry's Assignments shows 06 × Ann ☐ and Ann's ● on 06 is gone. → saw:

Decision D208: answered 2026-10-16, **Approved** (anyone assigns; several people per level; unassigned does not count for everyone once you have an assignment). Nothing to answer here.

## T98 — Floor PDF at tower scale  ·  Needs: no new build (server deploy; push T98 first)

**Why it matters:** 06M of "TP-3 synthetic" has 5,000 photos and 3,140 finding thumbnails; read one at a time from R2 (≈ 0.11 s each) its floor PDF would take ≈ 15 min. T98 reads them 16 at a time; on the PC with the Droplet's storage delay imitated it took ≈ 1.5 min (load 59 s, render 35 s).

- [ ] **Under 5 minutes.** "TP-3 synthetic" → Export → Generate floor PDF, level 06M, all sections: time from Generate until Ready under 5 minutes? (Expect 2–3.) The card's `Photos … pictures` count climbs by about a hundred a second, not a few. → saw:
- [ ] **Same report.** Open it: the cover's counts and plan, findings with up to four thumbnails each, then the tables, then the photos in number order with their captions (spot-check Photo 1 and the last one); no blank picture boxes. → saw:
- [ ] **Cancel.** Generate it again and tap Cancel while the card says `Photos`: the card goes to Cancelled within a few seconds, and a new Generate starts at once. → saw:

## T100 — Drafts with no device in Lint  ·  Needs: no new build

**Why it matters:** the Neuron ID item (R3c) and a level's Unison pair (R2e) were drafted by the rules but no screen showed them, so they could never be accepted.

- [ ] **They are listed.** On a level group where a station has no Neuron ID and no "Missing all Device Neuron IDs" item exists (or on a level with an NSPS and no Unison row), open **Lint**: the title ends `· n drafts`, and **Drafts with no device (n)** heads the list with rows like `Levels 06/06M` → `DRAFT ⚑ R3c Missing all Device Neuron IDs`, `Information · EC · Open`, and `Level 03 · 03-01 …` → `DRAFT ⚑ R2e U → Unison from stations & sensors`. → saw:
- [ ] **why? and Open card.** Tap **why?** on the R3c row: the rule's text and the count of devices with no Neuron ID. On the R2e row tap **Open card ▸**: the plan opens on that level with the NSPS's card. → saw:
- [ ] **Accept / Edit / Reject.** Edit the R3c draft's notes, **Save & accept**: the draft leaves the list, the "Neuron ID item missing" finding goes, and the level's punch list has the item. Reject the R2e draft: it leaves the list and does not come back on the next sync unless that level's devices change. → saw:
- [ ] **Level filter.** Tap a level chip: only that level's drafts show (the R3c draft is under the first level of its group, e.g. 06, not 06M). **Dismissed** shows no drafts. → saw:

Decision D209: drafts that no device card lists (Neuron ID item, Unison pair, a part on an item with no device) live in the Lint view, decided in place with the card's buttons. → Approve / change:

## T101 — "Not found on site" quick action  ·  Needs: no new build

**Why it matters:** a drawn device that is simply not there had no one-tap way to record it; it now stays in the baseline marked not found, and the rules make the items from its `Not installed` status.

- [ ] **One tap.** Open a surveyed or unsurveyed device's card, tap **Not found on site** under the quick actions: no question appears; the status shows `Not installed` (red hollow "NI" pin), Notes end with "Not Installed." after "; " if there was a note. → saw:
- [ ] **No item, still in the baseline.** The card's punch items gain nothing from the tap itself (rule drafts for its wires may appear as usual); the device is not deleted and its pin stays. History shows one group, "Quick action not_found: Not found on site". Tap it again: Notes do not get a second "Not Installed.". → saw:
- [ ] **Dashboard.** Dashboard → As-found: `never found` went up by one; tap it and the list holds the device. → saw:

## T102 — Rule settings per project and app-level defaults  ·  Needs: no new build (JS update; server deploy first — Alembic 0014 adds `rule_param`; **every iPad on the new JS before anyone changes a setting**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** owners, item wording and starting statuses (D175's readings) were fixed in the code; some projects give terminations to the EC, some to ETC (D176). They are now settings per project, with defaults for new projects.

- [ ] **Nothing moves on the update.** After the JS update, open a level you know: its drafts and punch items read as before (`Run DMX to …`, owners `EC`, DMX kits `EC/ETC`), and no rejected draft has come back. → saw:
- [ ] **The Rules tab.** Setup → **Rules** (below Assignments): groups with the rule's text (Signal words, R3a Cable not run, R3b …, Quick action: Spot-check fixed …), each value with what it changes; "All on the built-in defaults." at the top. Turn on **Only what is changed**: the list is empty. → saw:
- [ ] **A changed owner follows on drafts, not on accepted items.** Pick a level with an open "Terminate network to …" draft and an accepted Termination item. In Rules → R3a → **Termination item owner**, set `N` to `EC`. Back on the plan (after the rules run, a second or two): the open draft's Owner is `EC`; the accepted item still reads `ETC`. The row in Rules is highlighted "changed" with "Default: …" and **Reset to default**. → saw:
- [ ] **A rejected draft comes back once its wording changes.** Reject a "Run DMX to …" draft, then in R3a → **Run item text** change *Any other code* to `Pull <signal> to <far end>` (tap out of the box to save): the draft is offered again as "Pull DMX to …". **Reset to default**: it reads "Run DMX to …" again. → saw:
- [ ] **Per code and quick actions.** In Signal words add a code `ZZ` = `test signal`: the row appears in every per-code table. Set Quick action: Spot-check fixed → Owner `EC`, run Spot-check fixed on a device: the new item's Owner is `EC`. Reset both. → saw:
- [ ] **Second iPad.** With a second iPad on the project, sync both: the other iPad's Rules tab shows the same change, and its drafts follow it after its own rules run. → saw:

Decision D211: rule settings are a `rule_param` table (your choice), owners per project and cable code (not per level); a project reads only its own values — app-level defaults are copied when a project is created and never change an existing project; only values set away from the default can bring back a rejected draft; Punch Type, part status and the `Stations & Sensors` label stay fixed. → Approve / change:

## T99 — Suggestion chips in the library  ·  Needs: no new build (JS update; server deploy first — Alembic 0015 adds `suggestion`; **every iPad on the new JS before anyone adds a chip**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** the chips under Notes were one list for every device; stations need "Stuck buttons", racks do not, and a DMX end needs "Missing DMX termination kit" where a network end needs "Missing network termination" (D172, D174). Chips now come from the library: per type, per category, per cable code.

- [ ] **Nothing moves on the update.** Open a device card and a connection end you know: the chips under Notes / Note are the same as before (no library chips yet). → saw:
- [ ] **Seed the app library.** Projects → app library → **Suggestions…** → **Load standard suggestions**: "Added 21 standard suggestions as drafts". Pick **Station**: "Stuck buttons" and "Empty box on wall." marked DRAFT. Pick cable **N**: "Missing network termination" under End Note and Punch item; the place chips at the bottom have no **Part** (R4). Tap Load again: "all here already". Accept the ones you want, edit by Remove + add, Reject the rest. → saw:
- [ ] **Into the Tower.** Tower → Library → **Suggestions…** → **Copy from app library**: "Copied N chips" (only what you accepted); a second tap copies nothing. → saw:
- [ ] **Card chips, most specific first.** Open a station's card: under Notes the first chips are the Station ones ("Stuck buttons", "Empty box on wall."), then the usual list; a relay panel's card does not show them. Tap "Stuck buttons": it is appended to Notes as any chip; typing freely still works. → saw:
- [ ] **A type's own chips.** Library → pick the station's type (e.g. PI1002) → **Suggestions** (under Default cables): add "Faceplate cracked" for Device Notes. It shows as DRAFT and appears at once, **first**, on every device of that type, before the Station chips. Reject it: it disappears from the card. → saw:
- [ ] **End chips by code.** Open a DMX (X) end: the X chips come first, then the usual list; an N end shows "Missing network termination" instead. → saw:
- [ ] **Draft Edit form.** On a card with a "Terminate DMX to …" (or any punch) draft, tap **Edit**: under *item* the X punch chip "Missing DMX termination kit" shows (when the draft sits on a DMX end), then the project's punch-item phrases; tapping a chip replaces the item text; Cancel leaves the draft as it was. → saw:
- [ ] **Copy and promote with the type.** In a project, accept a chip on an accepted type, then **Promote to app library**: in the app library the type shows the chip too. Add another chip to the project type afterwards, accept it: it has its own **Promote**. → saw:
- [ ] **Second iPad.** Sync both iPads: a chip added on one appears on the other's card after its sync. → saw:

Decision D212: suggestion chips are one `suggestion` table (your choice); new chips are drafts that show at once; a project reads its own category / code chips and its types' chips (the app library's reach it by copying); the card's draft Edit form is where punch-item and part chips appear for now; N / NG never offer a Part chip; the seed above is a first draft of the phrases per category and code for you to accept or change. → Approve / change:

---

## T103 — Termination kits per cable code, at both ends  ·  Needs: no new build (JS update; server deploy first — Alembic 0016 adds `cable.term_kit`; **every iPad on the new JS before anyone sets a cable's Termination kits**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** the master raised a DMX kit for every run that still has to be pulled, and DMX is not the only cable that needs kits (D213). The rules now raise a kit at each device end of every cable that takes them, from the setting you choose per code, and never twice for one end.

- [ ] **Nothing doubles on the update.** After the JS update, open Levels 01, 04 and 06M: no new kit draft repeats a kit already on the Missing Parts list (01 #8–#11, 04 #2, 06M #4–#6, #10–#13). New drafts may appear for network and fiber runs and for far ends; each "why" names the run. → saw:
- [ ] **The setting.** Setup → **Rules** → R4b · Termination kit part → **Takes termination kits**: one toggle per code, `X`, `F`, `N`, `NG` on, the rest off. → saw:
- [ ] **An unpulled run gets both kits.** On a floor that has been surveyed, set a DMX end to a device on another surveyed floor `Not installed` and accept its "Run DMX to …" draft. After a second or two, two kit drafts appear: "DMX termination kit - … run" on this device, and one on the far device (its "why" says "at its far end too"). Accept both: they appear on each floor's Missing Parts, Source "Punch #n" here and "Connections C-nn" on the far floor. → saw:
- [x] **No second kit after the pull.** On that run, close the Run item and set the end `Issue`, note "Run, not terminated; no term kit": the "Terminate DMX to …" kit-item draft appears; accept it. No new kit draft appears for that end. → saw (Claude, rig, 2026-11-04, ends.yaml): C-23 after its Run item and kit were accepted: **Issue** + "Run, not terminated; no term kit" → the kit item draft; accepted → no `DMX termination kit - Level 11 run` draft again. The Run item stayed open (no screen closes an item yet, T162).
- [x] **A placeholder far end gets one kit.** Accept a "Run DMX to <fixtures>" draft (far end Fixtures or a spare): only one kit draft, on the device. → saw (Claude, rig, 2026-11-04, ends.yaml): `Run DMX to Level 11` (far end the placeholder Level 11) accepted → one kit draft, on 06M-01; accepted, Missing parts +1.
- [ ] **Per cable.** Open a DMX connection → **Termination kits**: "As X (yes)" is selected. Tap **No**: its open kit drafts go away after the rules run, and a "no term kit" note on it is now flagged in Lint. Tap **As X (yes)**: they come back. Set a Unison cable to **Yes** and give an end "Run, not terminated; no term kit": a "Terminate Unison to …" kit item is offered. Put both back. → saw:
- [ ] **Per code.** In Rules turn `N` off: the network kit drafts go away, and a network kit part already on the list is flagged "Network termination kits are not parts" in Lint. Turn it back on. → saw:
- [ ] **Second iPad.** With a second iPad on the project, set a cable's Termination kits on one and sync both: the other shows the same choice, and its drafts follow after its rules run. → saw:

Decision D213: kits per cable code (`X`, `F`, `N`, `NG` on by default) with a per-cable Yes / No; one kit at each **device** end on an in-scope floor (none for Fixtures, spares or out-of-scope floors; the far end waits for its floor's survey); the far end's kit is sourced to its connection, not the Run item (whose number belongs to the other floor); a network kit is a part wherever kits are on; imported kits with no connection are matched to a run by their text. → Approve / change:

## T104 — Vocabulary follow-ups: model map, level aliases, device types, pin shapes, app-level vocabulary  ·  Needs: no new build (JS update; server deploy first — Alembic 0017 lets `vocab` rows have no project; **every iPad on the new JS before anyone edits the app library's vocabulary or a pin shape**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** the BOM import reads the model map and level aliases, the card's Type now has chips, pin shapes can follow how Landry wants the floor to read, and values Landry trusts can be offered to every new project.

Model map, level aliases, remove a model, the app library vocabulary, Promote and Copy from app library passed 2026-10-18 (B-25, B-26). Sheet D-15 and G-6:

- [ ] **Device types and the card.** Lists → **Device types**: add `Echo relay panel`, Accept. Open a device's card → **Type** → Edit…: the chip `Echo relay panel` is under the box; tap it, Save. The card's header shows the new type; the pin's label (Labels layer) shows it too; History has the change as Field survey. → saw:
- [ ] **Pin shapes.** Vocabulary → **Pin shapes**: nine roles, each with nine shape chips, the current one highlighted. Give **Station** the **Square**: the line says "shares its shape with another role" on Relay panel and Station. Open a plan with stations: their pins are squares, fill colours unchanged. Put Station back to **Circle**. → saw:
- [ ] **Pin shapes on the floor PDF.** With Station set to Square, export a floor PDF of a level with stations: the cover sheet and the crops draw stations as squares. Put it back. → saw:
- [ ] **Pin shapes on a second iPad.** Change a shape on one iPad and sync both: the other iPad's plan shows the new shape after its sync, with no project-level setting anywhere. → saw:

Decision D214: app-level vocabulary is `vocab` with no project on the library stream (drafts for Landry; new projects and "Copy from app library" take the accepted ones; a project reads only its own rows), and pin shapes are one app-library setting per role that applies to every project at once, on the iPad and in the floor PDF (no per-project shapes, no draft). → Approve / change:

## T116 — Rules tab: review accepted items after a change  ·  Needs: no new build (JS update only)

**Why it matters:** a changed owner or wording follows on open drafts but leaves accepted items as they were (D176). The Rules tab now offers a ruling, already filled in, for the accepted items the change words differently, so the punch list can be brought in line without hunting for them.

- [ ] **The offer.** On a level with at least one accepted "Run DMX to …" item, in Setup → Rules → R3a → **Run item owner**, set *Any other code* to `ETC`. Under the "saved" notice a yellow box lists **Review accepted items ▸  n punch items: Owner → "ETC"**, n = the accepted Run items still reading `EC`. → saw:
- [ ] **The pre-filled ruling.** Tap it: Rulings opens on the editor with Punch item · n chosen records, the level(s) as scope, **Reword from the rule · Owner** (since T120; was Set field Owner = ETC) and the reason "Rule parameter R3a · … changed: accepted items reworded to match". Preview: one row per item, `EC` → `ETC`. Untick one, Apply. The items read `ETC` on the plan; History shows the change as Ruling with that reason. → saw:
- [ ] **What is left.** Back in Setup → Rules: the box now lists only the item you unticked (1 punch item). → saw:
- [ ] **Hand edits stay out.** Change one accepted Run item's Owner by hand to `EC/ETC`, then in Rules set *Any other code* back with **Reset to default**: that item is not in the box's count. → saw:
- [ ] **A wording change.** Set R3a → **Run item text** *Any other code* to `Pull <signal> to <far end>`: since T120 the box lists **one** entry for the field ("n punch items: Item reworded (n wordings)"); the T120 section below goes on from here. → saw:

Decision D215: accepted items are only changed by a ruling you apply; the Rules tab offers one pre-filled ruling per (field, new value) over the accepted items the change words differently, leaving out fields someone changed by hand; a wording with the far end in it means one ruling per item until a "reword" ruling action exists (T120). → Approve / change:

## T118 — Suggestion chips follow the termination-kit setting  ·  Needs: no new build (JS update only)

**Why it matters:** since T103 the project decides which cable codes take termination kits; the chips still offered "; no term kit" on DMX only and never let a network cable have a Part chip, so they contradicted the Rules tab.

- [ ] **Kit Note on fiber and network.** Open an `F` (or `N`) connection's end editor: the Note chips include "Run, not terminated; no term kit". On a `U` or `120V` end they do not. → saw (Claude, rig, 2026-11-04, ends.yaml), on other codes: the `X` end C-23 offers "Run, not terminated; no term kit"; the `P` end C-08 offers "Run, not terminated" but not the kit note, also under "more". Not run: `F`, `N`, `U`, `120V`.
- [ ] **Kit Part chip.** On a device card with a draft kit part on a DMX / network end, tap the Part field: a "DMX termination kit" / "Network termination kit" chip is offered. → saw:
- [ ] **Turning network kits off.** Setup → Rules → R4b **Takes termination kits**: turn `N` off. The `N` end editor stops offering "; no term kit"; Library → Suggestions → Cable code `N` shows no Part group and "+ add" as Part is refused with the R4 message. Turn it back on and both return. → saw:
- [ ] **One cable's own setting.** On an `N` cable with the code's kits off, set its Termination kits to **Yes**: its end editor offers "; no term kit" again; set **No** on a DMX cable: its end editor no longer does. → saw:

Decision D217: kit chips are computed from `R4b.kit` (and a cable's own Termination kits), not seeded; a code that takes kits offers "Run, not terminated; no term kit" and its kit Part chip (from the R4b Part text); a cable that takes none offers no "no term kit" Note; a network code offers Part chips only where its kits are on. → Approve / change:

## T120 — One ruling rewords accepted items from the rule  ·  Needs: no new build (JS update only)

**Why it matters:** a changed template with the far end in it (`Pull <signal> to <far end>`) used to need one ruling per item; now one ruling writes each item's own new wording, and leaves alone what someone changed by hand.

- [ ] **One entry per field.** On a level with two or more accepted "Run … to …" items, in Setup → Rules → R3a → **Run item text**, set *Any other code* to `Pull <signal> to <far end>`. The yellow box shows one **Review accepted items ▸  n punch items: Item reworded (n wordings)** (or `Item → "…"` when there is only one). → saw:
- [ ] **The reword ruling.** Tap it: the editor shows Punch item · n chosen records, **Reword from the rule · Item** with a line saying each record gets what its rule now words, and no Standing switch. Preview: one row per item, each with its own far end ("Run DMX to 06-02" → "Pull DMX to 06-02"). → saw:
- [ ] **Hand edits and gone wordings.** Before applying, back out; change one of those items' Item by hand on its card, and mark one of the runs pulled (its end to `Installed, untested`). Preview again: the hand-edited item and the pulled run's item are not rows; the footer says "1 record changed by hand … left as it is" and "1 record its rule no longer words … : <level> #<n>". → saw:
- [ ] **Apply.** Apply: each remaining item reads its new text on the plan's punch list; History shows Change = Ruling with the reason. Back in Setup → Rules the box is gone (or lists only what you unticked). Reset Run item text to default afterwards, and use the box once more to put them back. → saw:
- [ ] **Stored.** In Rulings, open the applied reword ruling: its action reads "reword Item from its rule", no Standing switch; **Preview again** shows nothing to change. → saw:

Decision D219: the Rules tab offers one reword ruling per field (not per new value); it writes, per record, what its rule now words, carries the rule parameters as they were so hand edits are told apart, names records the rule no longer words, and is never standing. → Approve / change:

## T122 — Needs review: put an imported cable item on its end  ·  Needs: no new build (JS update; server deploy first). Only on a project imported **after** this deploy (a scratch import of the master)

**Why it matters:** ten master items name no single connection ("Run 2x DMX cables to Lvl 9 & 6M Equipment Rack", "Terminate DMX" on a panel with two DMX runs…). Until they sit on a connection the rules can draft a second Run / Terminate item for the same run.

- [ ] **Listed.** Import the master into a scratch project. Needs review → Lint shows 10 rows reading "X item → which connection?" (one "U item"). → saw (Claude, rig, 2026-11-03, seed.yaml): the X rows on 06M (#2, #7, #11, #12), 03 (#10, #11, #27, #28), 02 #3 and the U row B2 #6 are listed (31 items in all); the count of 10 is not asserted one by one.
- [x] **The ends offered.** Open 06M "Punch #2 Run 2x DMX cables to Lvl 9 & 6M Equipment Rack": the panel shows the device (06M-02 · CT06LCPB) and two choices, **C-07** · X · DMX to Level 09 and **C-12** · X · DMX to equipment rack — not the panic or 0-10V ends. → saw (Claude, rig, 2026-11-03, seed.yaml): `06M-02 · CT06LCPB`; C-07 `X · DMX to Level 09` and C-12 `X · DMX to equipment rack`; no P, 0-10V or 120V end offered.
- [ ] **Put on.** Tap C-07, confirm: the row leaves the list; the item, on the plan's punch list, still reads the master's text and number. On CT06LCPB's card, C-07 shows no Run draft of its own; C-12, if it is still not run, keeps its own Run draft (accept or reject it as usual). History shows one Reconcile change. → saw (Claude, rig, 2026-11-03, seed.yaml): Put on C-07 → confirm → the row leaves. Not asserted: the card's C-07 / C-12 drafts and the History entry (F1, T155).
- [x] **Keep.** Open 03 "Terminate DMX" on a UFMP4: it says the device has no X connection; tap **Keep on the device**: the row leaves the list and the item is unchanged. → saw (Claude, rig, 2026-11-03, seed.yaml): 03 #10 on 03-06 (UFMP4) reads "This device has no X connection."; Keep on the device → confirm → the row leaves; Needs review 31 → 27 after the four actions, and the server holds 27 open + 4 resolved.

Decision D220 (Landry, "One end, no split"): an item about two runs goes on one end you pick and keeps its number and text; the other run gets its own Run draft. → Recorded.

## T125 — Library editor: wider, actions always visible, Save keeps the form  ·  Needs: no new build (JS update only)

**Why it matters:** in the 2026-10-18 round the type editor was too narrow to read (A-2, B-5) and Save seemed to throw away what you had typed (A-3). Re-run A-2, A-3 and B-5 of the round sheet with these.

- [ ] **A pull still refreshes it.** With the type open on iPad A and not edited, change its aliases on iPad B and sync both: A’s form shows B’s aliases. → saw:

## T131 — Slow to load during sync  ·  Needs: no new build (JS update only)

**Why it matters:** with the DaVinci catalogue in the library every rules run scanned 1,132 types per device, freezing the app for seconds after each pull and each edit (`docs/perf/t131.md`). The PC numbers are in; these are the iPad's. Do this on the Pipeline project (the one with the BOM / riser drafts), dev build with Metro so the log lines are visible, store already synced once (warm).

- [ ] **Launch to Levels.** Force-quit the app, open it, start a stopwatch at the icon tap: the Levels table is on screen and tappable within **3 s**. Metro shows `[store] open`, then one `[rules] run … "ms":n` per project — copy each line's `ms`. → saw:
- [ ] **Quiet cycle.** Leave the app on Levels for a minute without touching anything. Sync → Connection: the timing line reads like `Last cycle 0.3 s · push 0.0 s · pull 0.2 s · apply 0.0 s · 0 pushed, 0 pulled · rules …`; the whole cycle is under **1 s** and the numbers barely change from cycle to cycle. Copy one line. → saw:
- [ ] **No stall during a pull.** On iPad B (or the Library screen on the same iPad) change three aliases and Save; on iPad A stay on Levels and keep scrolling the table while the edits arrive (within ~5 s): the scroll never freezes; afterwards the timing line shows `3 pulled` and `apply` under 0.2 s, and Metro shows one `[rules] run` per project (not one for the library stream). → saw:
- [ ] **Edit without a freeze.** Open a plan on the Pipeline project, change a device's status: the card answers at once; about half a second later Metro shows `[rules] run … "ms":n` with n well under 1,000 (copy it); pan the plan while it runs — no hitch longer than a blink. → saw:
- [ ] **Log keeps growing.** Sync → Install → export the log: it contains today's `[sync] synced {… "ms":…, "push_ms":…, "pull_ms":…, "apply_ms":…}` lines and the earlier days' lines are still there (append, not rewrite). → saw:

Decision D223: type lookups are indexed, a library change re-runs every project's rules (never the stream), pulled pages are applied 100 ops per transaction, and the Sync screen shows a per-cycle timing line. → Approve / change:

## T124 — A large plan sheet no longer runs the server out of memory  ·  Needs: no new build (server deploy only)

**Why it matters:** on 2026-10-19 uploading `Level 02 Concourse - Composite (vector).pdf` grew the worker to 3.2 GB, the server stopped answering every iPad until it was restarted by hand, and the batch never finished. The same morning the riser crops went blank (C-35, T129).

- [ ] **Everything else keeps working meanwhile.** While that upload runs, on the same or another iPad pull to sync and open another level's plan: sync finishes and the plan opens without waiting for the upload (before, the server stopped answering). → saw:

Decision D226: the vector pass is streamed (output unchanged), a page with more than 500,000 characters is refused with a reason, the worker is capped at 2 GB, and a batch the worker died under runs once more, then fails with "the server stopped twice … upload a smaller or flattened PDF". → Approve / change:

## T130 — The DaVinci import corrects the NSPS / rack Neuron flag  ·  Needs: no new build (JS update; server deploy first)

**Why it matters:** in the 2026-10-18 round (B-11) the library editor read Neuron ID **Needed** on P-NSPS-D and P-NSPS-D-KIT: the import had written DaVinci's IP properties over the NSPS default. You ruled "import should correct the flag" (D222).

- [ ] **Your own choice stands.** Set Neuron ID to Needed by hand on one NSPS type, re-upload the library again (a newer copy from DaVinci, since the same files are now skipped): that type still reads Needed and the Done line does not count it. → saw:

Decision D227: the correction is a `Correction` op keyed on who last set the flag (the import's reason); a person's flag is left alone on drafts too; the same library re-uploaded once after the deploy is not skipped, so the correction runs. → Approve / change:

## T126 — Accessories are no longer devices to place  ·  Needs: no new build (JS update; server deploy first)

**Why it matters:** in the 2026-10-18 round (C-38) accessories on a level showed up in Setup → 5 Place devices as devices. With the DaVinci catalogue in the library, a rack's outlet strip, power modules, switches and UPS each became a draft of their own instead of parts of the rack.

The three "existing drafts" checks cannot run on a project set up after T126 (no old accessory drafts exist; the old Pipeline was cleared 2026-11-01); they are covered by the app tests and stay here only for a project imported before T126. Place devices and the new BOM upload passed 2026-11-01.

- [ ] **Existing drafts are flagged.** On the project of the 2026-10-18 round, Setup → Review drafts → level 01 (or 06M), Devices, filter All: the drafts of the rack parts (`SGE1552` 8 Outlet Strip, `P-SPM-E`) carry the ⚑ and, selected, read "An accessory, not a device: the library files … as another type's accessory", with **Fold into <parent>** when a draft of that level lists it, else "No draft of this level lists it". The level's mismatch list has a line for each. Accept is greyed with "fold it into its parent or reject it". → saw:
- [ ] **Fold.** Tap Fold into … on one: the draft leaves the list, and the parent draft's Accessories line now ends with that model ×qty. Its history (the change log) shows "… folded into … as an accessory". → saw:
- [ ] **Reject the rest.** On one with no parent, Reject… with a reason (e.g. "An accessory of the rack"): it moves to Rejected. → saw:

Decision D229: a BOM line whose model is an accessory-only library type attaches to the nearest line whose type lists it (else is a rack component, else excluded); inside an open rack a line of role `other` or `equipment_rack` is a component, as before the catalogue; Fold puts an existing accessory draft on its parent and soft-deletes it. → Approve / change:

## T129 — Riser crops load or say why; enlarged crops pinch and pan  ·  Needs: no new build (JS update only)

**Why it matters:** in the 2026-10-18 round (C-35) the riser crops stopped loading everywhere with no word on screen — the server had run out of memory that day (T124) — and an enlarged crop could not be zoomed.

Failed 2026-11-01: "Enlarge, pinch, pan" — "Pinch zoom does not work; only double tap." → **T135**; "Cable / riser" — "No red outline." → **T134** (the viewer reports pages 1-based; the guard compared with `page - 1`, so nothing focused or outlined). Re-run the two below after them (T134 landed 2026-11-02, so "Cable / riser" can be re-run now; "Enlarge, pinch, pan" is re-run in the T135 section below, landed 2026-11-02); the other four passed.

- [ ] **Enlarge, pinch, pan.** Tap the crop: it opens full screen with more around it. Pinch: it zooms about your fingers up to about 8×; drag: it pans but never off the picture; double-tap: 3× on that spot, double-tap again: back to fit. The red outline stays on its bubble throughout. **Close** returns to the draft. → saw:
- [ ] **Cable / riser.** Cables → a cable made from a riser draft → Riser crop: it loads (⤓ Download riser first if asked). Pinch and pan in the small frame: the red outline stays on the bubble **while** your fingers move, not after. Scroll to another page: no outline there. → saw:

Decision D231: source crops are downloaded and cached by the app with a 45 s timeout so a failure has a reason on screen; tapping a crop opens it full screen with pinch / pan / double-tap; the riser keeps PDFKit's own pinch with the outline following on the UI thread and gains ⤢ Enlarge. → Approve / change:

## T134 — Riser crop: focus and red outline on the bubble  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 the riser crop opened at fit with no red outline (T129 "Cable / riser", C-35): the viewer counts pages from 1 and the crop compared with a count from 0, so it never recognised its own page. Use `pipeline test` (riser cables accepted on 03). After this, re-run **T106** "Focused and outlined", "Pinch", "Page 2" and **T129** "Cable / riser" above.

- [ ] **Opens on the bubble.** Cables → a cable made from a riser draft (sheet 001) → Riser crop: it opens zoomed to that cable's wire bubble with a little of its line around it, not the whole page, and the bubble has a red outline. → saw:
- [ ] **Enlarged too.** ⤢ Enlarge on the same cable: full screen, the same bubble outlined in red. Close. → saw:

## T135 — Enlarged source crop: pinch and pan  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 an enlarged source crop only answered a double tap (T129 "Enlarge, pinch, pan"): "Pinch zoom does not work; only double tap. Very hard to use." It now zooms the way Photos does, with iPadOS's own scroll-view pinch instead of gesture-handler's. This replaces T129's "Enlarge, pinch, pan" above. Use Setup → Review drafts → any draft with a BOM or riser source.

- [ ] **Pinch.** Tap the source crop: it opens full screen. Pinch out: it zooms about your fingers, smoothly, up to about 8×; pinch in: back to fit, with a little bounce past either end. → saw:
- [ ] **Pan.** Zoomed in, drag with one finger: it pans and coasts, and stops at the picture's edges (a short bounce, never off into grey). At fit, a drag does nothing. → saw:
- [ ] **Double tap.** At fit, double-tap a spot: it zooms to 3× on that spot. Double-tap again: back to fit. Two slow taps or taps far apart do nothing. The red outline stays on its bubble throughout. **Close** returns to the draft. → saw:

Decision D236: an enlarged source crop zooms with the native iOS scroll view (pinch, pan, bounce by UIKit) and a JS-timed double tap; gesture-handler is no longer used in that modal. → Approve / change:

## T136 — A connection with one placed end is made at once  ·  Needs: no new build (JS update; server deploy first — Alembic 0018 adds `cable_end.draft_device_id`; **every iPad on the new JS before anyone accepts a cable draft to an unplaced draft**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** on 2026-11-01 (C-35) the N line set to the 06M `Equipment Rack 18U` draft was confirmed and then was nowhere but Review drafts: "if one side of a device is placed, I should be able to begin surveying the connection at that side." Now Accept makes the cable at once on the placed side, and its far end follows when the draft is placed (D235). Use `pipeline test` (or any project with a riser in and a device draft not placed yet). After this, re-run **T106 / C-35** above.

- [ ] **Accept makes it.** Setup → 4 Review drafts → a cable draft whose From is a placed device and whose To is a draft device not placed yet (set it with Change… if needed) → **Confirm endpoint ✓**: the message says the cable is made on the placed end and its far end follows when that draft is placed; no "waits for placing" in the State column. (A line accepted before this update: **Make n waiting cables**, or placing any device, makes it the same way.) → saw:
- [ ] **On the placed device's card.** Open that device's plan → tap it → Connections: the new row reads `<code> → <signal> to Level <nn> <device>` with `→ <draft> (draft on <nn>, not placed yet)` under it (e.g. `→ Equipment Rack 18U (draft on 06M, not placed yet)`). The plan's **Conns** tab shows the same far end after `↔`. → saw:
- [ ] **Survey the placed end.** Tap that connection: the end editor shows this end editable and the far end titled with the draft and "Its device is not on the plan yet…", its status, note, From / To greyed and no Choose placeholder. Set this end `Not installed`, note "Not run": after the rules run, the card proposes `Run <signal> to Level <nn> <device>`; Lint shows no "Cable with missing far end" for it. → saw:
- [ ] **Cable / riser.** Cables → the cable: side B reads `<draft> (draft on <nn>, not placed yet)`, no ⚑ missing far end. → saw:
- [ ] **Placing links it.** Place the draft (Setup → 5 Place devices, or ⊕ Place on its level's plan) and sync: the first device's card now shows the far end's ID with a jump ▸ instead of the draft line; the new device's card lists the same connection (one cable, not two — Cables shows one row). → saw:
- [ ] **Export.** Before placing (or on another such cable), sync and run an export: the Connections tab has a row on the draft's level for the far end, `Unsurveyed`, with its To text. → saw:

Decision D237 (Proposed): the waiting end is a device end with no device and `draft_device_id` (kept after placement as provenance); a draft to a placeholder is made too; the waiting end is read-only in the end editor until its device is placed; placement links by the device placed from the draft (or the one device on its level that plainly is it); lines accepted before this are made by the next placement or "Make n waiting cables". → Approve / change:

## T133 — The mismatch list forgets what you settled  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01, after every review item on 03 was settled, the level's mismatch list still showed "No network (N) run drawn to P-NSPS-D on the riser" and "SR or LR? P-DOC-C-SR / P-DOC-C-LR — pick one" twice: an accepted draft kept asking. Now a device's warning shows only while its draft is open (not yet accepted, edited or rejected), and the N warning also goes once an N cable draft runs to that device. Use `pipeline test`, level 03.

- [ ] **Settled warnings are gone.** Setup → 4 Review drafts → 03: the mismatch list no longer shows the two SR / LR lines or the P-NSPS-D N line (those drafts are accepted). → saw:
- [ ] **Reopen asks again.** Reopen one of the SR / LR sensor drafts: its "SR or LR? … — pick one" line comes back; Accept it with a pick: the line goes. → saw:
- [ ] **The N line answers itself.** On a level with an open NSPS draft showing "No network (N) run drawn to P-NSPS-D on the riser", + Add a cable draft of code `N` and set one end (Change…) to that NSPS draft: the line goes at once, without accepting the NSPS draft. Reject that N draft: the line comes back. (Skip if no level has an open one.) → saw:

## T137 — Endpoints read as the device, the riser's text a note  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 (C-35) "it calls the device a P-NSPS-DIN, while everything else calls it a P-NSPS-D. When I searched for the 3rd floor P-NSPS-D and selected it, it auto input the P-NSPS-DIN." An end the riser read is now labelled by what it is — a draft by its model, name and level, a placed device by its ID and text, a placeholder by its label — with the riser's printed text after it as `· riser: …`. Use `pipeline test`, level 03, a cable draft whose To is the P-NSPS-D.

- [ ] **The end line.** Setup → 4 Review drafts → 03 → that cable draft: To reads `P-NSPS-D (draft, 03)  (not placed yet)  · riser: PARADIGM P-NSPS-DIN` (or the device's ID and text if it is placed); the table's To column reads `P-NSPS-D (draft, 03)`. The line above, "The riser reads: …", still shows the riser's own text. → saw:
- [ ] **Search and pick.** Change… on To, type `P-NSPS-D`: the 03 draft is listed once, as `◌ P-NSPS-D (draft, 03) … · riser: PARADIGM P-NSPS-DIN`; typing `DIN` finds it too. Pick it: the end line still reads `P-NSPS-D (draft, 03)`. → saw:
- [ ] **Confirm.** Confirm endpoint ✓, then open the draft's history (or the Change Log): the reason reads `… → P-NSPS-D (draft, 03)`, not `PARADIGM P-NSPS-DIN`. → saw:

## T138 — Delete a connection added in error  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 Landry added a connection from the punch list by mistake and had no way to remove it. Now ⋯ deletes a cable with both its ends (a `Correction` with your reason), and the device's History restores it. Use any project with a cable you can spare, or add one first with **+ add …** on a device card.

- [ ] **From the card.** Tap a device → Connections: each row has a **⋯** before the ›. Tap it: the box at the top asks "Delete the connection `<code> C-nn → …` with both ends: why?", Delete stays grey until you type a reason. Type one → **Delete**: the row leaves the Connections list, and the plan's **Conns** tab no longer lists either end. → saw:
- [ ] **History restores it.** Same card → History: the newest lines include `Connection deleted` with `<code> C-nn → …`, Correction and your reason, and a **Restore…** button. Restore… asks why; give a reason: the row is back in Connections with its status and note as they were; History now shows `Connection restored` and the delete line has no button. → saw:
- [ ] **The far device too.** Delete it again and open the device at the other end: the connection is gone from its card as well, and its History has the same `Connection deleted` line with Restore…. → saw:
- [ ] **From the Cable / riser view.** Cables → select a row → the end editor's header has **⋯** → **Delete connection…** → reason → Delete: the row leaves the list (and the counts along the bottom), the side panel says "This cable is deleted. Restore it from the History of a device at either end." Opened from a card instead, the end editor shows DELETED, "Deleted: <reason>" and Restore…. → saw:
- [ ] **Nothing comes back by itself.** Delete a connection the rules proposed and you accepted (e.g. a relay panel's 0-10V → Fixtures, or + add …): after the rules run (a few seconds, or Sync), no new draft for it appears on the card and its Run / Terminate drafts are gone. If an accepted punch item or kit part was on that connection, **Lint** lists it under "Linked to a deleted device or connection": close or delete it yourself. → saw:
- [ ] **Export.** Sync, then export the workbook: the deleted connection's rows are not on the Connections tab (and not in the floor PDF's Connections table). → saw:

Decision D238 (Proposed): a connection is deleted as one `delete` op on its cable (the ends stay as they are and go with it); Restore lives in the History of the device at either end and in the end editor; punch items and parts on it are left for the lint, not deleted with it; an accepted cable draft is never re-offered by itself once its cable is gone. → Approve / change:

## T139 — Undo a placement; put a device back in the list  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 Landry placed a device by mistake and had no way to put it back in the unplaced list. Use a project with drafts left to place (e.g. `pipeline test`) and a level with an accepted cable waiting on a draft if you have one.

- [ ] **Undo in the panel.** Plan → Place devices → pick a draft row → tap the plan → Place ✓. A green row at the top reads "Placed `<level>-? <model>`." with **↶ Undo**. Tap ↶ Undo: the pin leaves the plan, the note says "… back in the unplaced list.", and the row is back in the list with its count as before. → saw:
- [ ] **A master device.** Place a device marked "in the baseline", then ↶ Undo: its pin is gone and it is back in the list; its card keeps its ID, Drawing Position and Room. → saw:
- [ ] **Only the latest, until the panel closes.** Place two items: only the second shows ↶ Undo. Tap ◀ Done placing and open Place devices again: no Undo row. → saw:
- [ ] **From the card.** Tap a device you placed from a draft → ⋯ → **Put back in the unplaced list…**: the box asks "Put `<level>-?` back in the unplaced list (the device is deleted, its draft's unit is left to place): why?" with "Placed by mistake" filled in → **Put back**: the card shows Deleted: Placed by mistake, the pin is gone, and Place devices lists the unit again. On a master device the box says "(its pin is cleared)" instead. → saw:
- [ ] **Its connection waits, then follows.** Place a draft that has a waiting connection (Metro: `… 1 waiting cable(s) made`), set that end's status on the card, then ↶ Undo: the far device's card still lists the connection with "→ … (draft on <level>, not placed yet)". Place the draft again: the connection is on the new device's card with the status you set, and Cables shows it once, not twice. → saw:

Decision D239 (Proposed): Undo / Put back deletes a device placed from a draft (its cable ends go back to waiting for the draft, so placing it again re-links them) and only clears the pin of any other device; the card offers it for every device with a pin, not only those placed from drafts; the reason starts as "Placed by mistake". → Approve / change:

## T140 — Dashed proposals at the type the sheet prints, stations and sensors included  ·  Needs: no new build (JS update; server deploy first, then `plans retag` on the project — TASKS follow-up)

**Why it matters:** on 2026-11-01 Landry found many proposals "very off" and none for stations or sensors on 03, though the drawing prints `PI1104`, `P-LS`, `P-DOC-C-LR`, `EBDK` beside each one. Use a project whose 03 sheet was re-read after the deploy (the `retag` run) and whose 03 has station / sensor drafts or master devices left to place.

- [ ] **Stations and sensors get dashed pins.** Plan 03 → ⊕ Place: dashed "?" pins sit on the `PI1104` / `PI1002` / `PI1004` labels and the `P-DOC-C-LR` / `P-LS` labels, one per label, none on the legend tables at the sheet's edges. → saw:
- [ ] **One draft, one pin per label.** Pick a station draft with ×n left: it has at most as many dashed pins as the plan prints its model, and no label carries two dashed pins. → saw:
- [ ] **The right sensor variant.** A `P-DOC-C-LR` draft is never proposed at a `P-DOC-C-SR` label (on 02, where both are printed). → saw:
- [ ] **Panels at their own tag.** The relay and Foundry panels' pins sit at `CT03LCPA` / `CT03LCPB` or the model printed under them (`ERP24-FT241P`), never at a `UFMP` of another size. → saw:
- [ ] **Guesses look weaker.** If a pin is fainter (thin, sparse dash) and reads "… ? guess", the panel note counts it ("n faint ones are guesses…"), and tapping it shows "Guess: the sheet prints CT… here, not this model" above Place ✓. Say whether the guesses help or should go. → saw:
- [ ] **Nothing written by a proposal.** Leave placing without confirming: no device moved, no new device. → saw:

Decision D241 (Proposed): the text pass keeps every library model / alias / short variant printed on the sheet (legends and notes left out), proposals go printed model → type → panel tag → model part for every role, and only a left-over `CT…LCP` tag is guessed, drawn fainter; `plans retag` re-reads stored sheets. → Approve / change:

## T141 — Heavy plan sheets open fast and pan smoothly (03 rasterised)  ·  Needs: no new build (JS update; server deploy first, then `plans rasterise` on the project — TASKS follow-up)

**Why it matters:** on 2026-11-01 the 03 composite was "very slow to load and lags when moving around", in placing and in the survey tab. The server now stores a sheet that heavy as a 200-dpi picture of itself at the same size (D233), so the iPad no longer redraws two million lines on every zoom step. Numbers go in `docs/perf/t141.md` §On the iPad. Use a project with 03 (and 06M if it has one) uploaded; the timings come from the Metro / DevTools log or Sync → Export log, line `[plan] sheet_loaded {"ms":…}`.

- [ ] **Before (optional, if you can do it before the `rasterise` run).** Open plan 03 from cold (close the app first): note the `sheet_loaded` ms, how long until the whole plan is drawn, and how panning / pinching feels. Do the same on 06M. → saw:
- [ ] **The new sheet arrives.** After the `rasterise` run, sync (Wi-Fi): 03's plan downloads again on its own (or shows "Plan not downloaded … ⤓ Download plan now" briefly — tap it). The pins, ink and boundaries sit exactly where they were, on the same rooms and devices. → saw:
- [ ] **Opens fast.** Close the app, open plan 03: the whole sheet is drawn in about the time 06M takes; write down the `sheet_loaded` ms and the seconds until drawn. → saw:
- [ ] **Pans and zooms smoothly.** Pan across the sheet and pinch in and out at fit, mid and full zoom: no stalls, the picture sharpens within a moment after a zoom, pins stay glued. The survey tab (device card open) feels the same. → saw:
- [ ] **Readable at full zoom.** Zoom all the way in on a station or sensor label (`PI1104`, `P-DOC-C-LR`) and on a room name: the text is legible (slightly soft is fine, blurry is not); no thin lines or seams across the plan where the picture's tiles meet. → saw:
- [ ] **Memory.** Open 03 and stay at fit for a minute, then zoom in and out ten times: the app does not quit or reload. (Dev client: Perf Monitor RAM at fit and after the zooms.) → saw:
- [ ] **06M unchanged.** Plan 06M still looks and behaves as before (it stays vector: under the threshold). → saw:
- [ ] **Floor PDF still sharp.** Export a floor PDF for 03: the plan snapshot and the device crops are as crisp as before (they read the vector original). → saw:

Decision D242 (Proposed): a display sheet over 400,000 page objects is stored as a 200-dpi raster (at most 250 megapixels; 512-px JPEG tiles, quality 75; same CropBox and rotation), the vector original kept beside it for the text pass, `retag` and the floor PDF; `plans rasterise` converts sheets stored earlier; T17b only if this is not enough. → Approve / change:

## T142 — New project: the server's reason, and a two-way numbering share refused  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 creating a project said only "POST /projects → 422": 06 shared numbering with 06M and 06M with 06, and the form gave no hint. The form now names that before Create, and any refusal says the server's reason.

- [ ] **Two-way share named.** Projects → New project, add levels 06 and 06M; set 06 → "Shares numbering with" 06M and 06M → 06. Under the levels table, in red: "Levels 06 and 06M share numbering with each other. Set it on one level only: 06 shares with 06M, and 06M keeps "own group"." Tap Create project: nothing is created, the same line shows by the button. Set 06M back to "own group": the line goes and Create works (the project opens with 06 and 06M in one numbering group). → saw:
- [ ] **A chain named.** In a new form, add 01, 02, 03; set 01 → 02 and 02 → 03: the line reads "Level 01 shares with 02, which itself shares with 03. Set it on one level only: 01 shares with 03 directly." Set 01 → 03: the line goes. Cancel. → saw:
- [ ] **The server's reason.** With Wi-Fi off, Create project: "Could not create the project: the server is not reachable (no connection?)." (Any 4xx from the server now reads "the server answered 422 (<its reason>)".) → saw:

## T143 — Move a flagged draft to another level or the pool  ·  Needs: no new build (JS update only)

**Why it matters:** on 2026-11-01 (C-43) a draft flagged "not on this sheet" could only sit under Flagged; moving it meant Review drafts → Edit… → Level, refused once any unit was placed. Now the flagged row moves it in one tap. Use a level with an accepted draft of ×2 or more (a station or sensor draft is easiest).

- [ ] **Move to another level.** Plan → ⊕ Place, select the draft, Flag: not on this sheet ⊗. Open Flagged, tap its row: beside Cancel there is **Move to…**; tap it — chips for the other in-scope levels and "Pool, every level" (not the level it is on). Tap another level: the note reads "<draft>: moved to <level>.", it is gone from Flagged and from this level's list. Open that level's plan → ⊕ Place: it is in the list (not flagged) with its units. → saw:
- [ ] **Move to the pool after placing one.** Place one unit of a ×2+ draft, then flag it and open its Flagged row → Move to…: the line says "1 unit left move; the 1 placed keep their level." Tap "Pool, every level": the placed pin stays where it is (same ID); the draft shows under Pool on every in-scope level with the units left. → saw:
- [ ] **Review drafts agrees.** Setup → Review drafts → the pool: the moved draft is listed there with Level "pool (no level)", basis `project_pool`; the one moved to a level is under that level, basis `manual`. → saw:

Decision D243 (Proposed): Move to… on a flagged draft sets its level (or the pool) and unflags it in one edit, also after some units were placed (those keep their level); a draft put in the pool by hand is in the pool whatever level its extraction read. → Approve / change:

## T144 — ERn enclosures are Equipment Panels  ·  Needs: no new build (JS update; server deploy first, then **one DaVinci upload with the new `DaVinci_categories.xlsx`**)

**Why it matters:** on 2026-11-01 (A-2) the ERn read as `Equipment`; you ruled them `Equipment Panels` (D232). The mapping workbook in the repo (`fixtures/DaVinci_categories.xlsx`) now files the 22 ERn enclosures under Equipment Panels on its Types tab. The server keeps using the workbook you last uploaded, so upload the new one once: copy it and DaVinci's `library.json` (`%LOCALAPPDATA%\ETC\DaVinci\`) to the iPad first.

- [ ] **The upload corrects them.** Setup → 3 Sources → DaVinci library → Choose files…, pick `library.json` **and** the new `DaVinci_categories.xlsx`. When the card reads Done, the line includes "n categories corrected" (about 22, plus one per project copy of an accepted ERn type). → saw:
- [ ] **The library shows them as Equipment Panels, still racks.** Library (app, then this project's): ERn2 Mk2, ERn4 Mk2 and the other ERn enclosures are listed under Equipment Panels with role Equipment rack, Neuron ID not needed. ERn-Net, ERn-BM, ERn-RPS Mk2 and the ERn upgrade kits are still under Accessories (not placeable). → saw:
- [ ] **A category you set yourself stays.** If you had changed an ERn type's category by hand before the upload, it still reads what you set. (Skip if you never did.) → saw:
- [ ] **Placed ERn devices are flagged.** Lint → check "Category differs from its type": each ERn device placed before the upload reads "<ID>: type ERn2-W-120 Mk2 says Equipment Panels, device says Equipment". Tap **Fix all via ruling**: the ruling editor opens with `Rename "Equipment" to "Equipment Panels"` over those devices; apply it and the findings close. Their pins are still hexagons. → saw:

Decision D244 (Proposed): the ERn upgrade kits (`ERn2-W-UPG` and the rest) stay accessories, not Equipment Panels (an override would make them placeable devices); project copies count as set by the import while nobody has edited their category; the new lint flags any device whose category differs from its type's, not only the ERn. → Approve / change:

## T146 — Addresses follow the wires: Neuron ID per Unison run, IP address per network run, DMX address per DMX run  ·  Needs: no new build (**server deploy first** — Alembic 0020 — then the JS update)

**Why it matters:** until now every device but racks and NSPS was listed under "Missing all Device Neuron IDs", and the app had no IP or DMX address field. Now a device needs an address by the wires it gets (D245): a Unison run → Neuron ID, a network run → IP address, a DMX run → DMX address; each kind has its own "Missing all Device …" item at the end of every numbering group. On the Tower the first rules run after the update rewrites the seven Neuron items' Notes (35 devices leave them — see the Decision line) and proposes 13 new IP / DMX items. Use the Tower project unless a check says otherwise.

- [ ] **The Neuron items shrink.** Open any level's punch list: "Missing all Device Neuron IDs" (last) lists stations and sensors only — no relay panel (`CT…LCP…`), no `UFMP4`, no EBDK, no touchscreen. The Change Log of the item shows one "Rule engine R3c" edit of Notes. → saw:
- [ ] **New drafts in the Lint view.** Lint → the checks "IP address item missing or not last" and "DMX address item missing or not last" list the groups; under each, the R3c draft "Missing all Device IP addresses" (Owner ETC) / "Missing all Device DMX addresses" (Owner EC), Notes = the device IDs. Accept one of each on Level 01: both appear at the very end of 01's punch list, after the Neuron item, numbered in order; the lint findings close. → saw:
- [ ] **Card sections follow the wires.** Open a relay panel's card (01-01): a **DMX address** section ("— not captured"), no Neuron ID section. Open a station: Neuron ID, no IP / DMX. Open touchscreen 01-06: **IP address**, no Neuron ID. Open NSPS 02-03 (a network run lands on it): IP address only. → saw:
- [ ] **Typing an IP address.** On 01-06, IP address → Type…: `10.101.4.23/24` shows "No subnet: type the address only"; `10.101.4.256` shows "Each number … is 0–255"; `10.101.004.23` shows `10.101.4.23 ✓`; Save. The line reads `10.101.4.23`; History shows one Field survey edit "IP address". Type the same address on the NSPS 02-03: "⚠ Already on 01-06 in this project." and the button reads **Save anyway**; save, then Lint → "Duplicate IP address" flags both; Clear on 02-03 and the finding closes. → saw:
- [ ] **Typing a DMX address.** On 01-01, DMX address → Type…: `1/1` shows `1/001 ✓` and saves as `1/001`; `1/513` is refused ("The address is 1–512"); `1-001` is refused. The accepted DMX item's Notes on 01 no longer list 01-01 after the next rules run (a few seconds). → saw:
- [ ] **Library editor.** Library (this project) → any type: three rows, **Neuron ID**, **IP address**, **DMX address**, each with chips `By the wires · Needed · Not needed`, "By the wires" selected. Set the `EBDK` type (or the panel type) to Neuron ID **Needed** and save: its devices return to the Neuron item's Notes on the next run; set it back to By the wires. → saw:
- [ ] **Rules tab.** Setup → Rules → R3c: the Neuron / IP / DMX item texts and owners, and three per-code tables "Cable codes that need a Neuron ID / an IP address / a DMX address" (U on; N and NG on; X on). Set the DMX item owner to ETC: the open DMX drafts reword to Owner ETC; accepted items keep theirs. Set it back. → saw:
- [ ] **Dashboard.** "Neuron IDs captured n/N": N is now the stations and sensors only (Tower: 169, was 204); the drill-down lists no panels. → saw:
- [ ] **Offline.** Airplane mode: type an IP address and a DMX address on two devices, open their cards again (values shown, "↑ not synced" mark), then Wi-Fi back: they sync, and the Lint view's drafts update. → saw:

Decision D247 (Proposed): "gets a wire" = the device's live cable ends (any status), else its accepted type's default cables, stations and sensors always on the Unison bus; the NSPS / rack Neuron exception stays unless the type says Needed; "Missing all Device IP addresses" / "… DMX addresses" as the item texts; neither address is exported; a duplicate IP is a lint and a Save-anyway warning, a duplicate DMX is not. **And the Tower consequence:** besides the 11 relay panels you ruled on (D246), the wire rule takes the **12 Foundry panels (UFMP4)**, the **11 EBDKs** and the **touchscreen 01-06** off the Neuron items (they have DMX, panic or network wires, no Unison), and gives the racks, the NSPS with network runs, 01-06 and the panels IP / DMX address needs. Right? If a Foundry panel, an EBDK or a touchscreen does carry a Neuron ID, say which: it becomes "Needed" on its type (or a code in the R3c Neuron map), not a code change. → Approve / change:

## T147 — Dashboard: IP and DMX addresses captured  ·  Needs: no new build (JS update only; T146's server deploy first if it has not happened yet)

**Why it matters:** T146 gave devices an IP address and a DMX address by the wires they get; the dashboard only counted Neuron IDs. The as-found line now shows all three, each counted over the devices that need one, with a list of the devices still missing it. Use the Tower project.

- [ ] **The line.** Dashboard → the as-found line reads `field additions n · never found n · Neuron IDs captured n/169 · IP addresses captured n/9 · DMX addresses captured n/16` (Tower, before anyone types an address). On a narrow window the line wraps; nothing is cut off. → saw:
- [ ] **IP drill-down.** Tap "IP addresses captured": the side panel is titled "Devices without an IP address" and lists B2-03, 01-05, 01-06, 02-03, 03-01, 03-05, 04-03, 04-05, 06M-01 (racks, NSPS with a network run, the touchscreen, two relay panels). Tap a row: its card opens on the plan. → saw:
- [ ] **DMX drill-down.** Tap "DMX addresses captured": "Devices without a DMX address" lists the 12 relay panels (`CT…LCP…`), the Foundry panels 02-06 and 04-06, and the racks 01-05 and 06M-01. → saw:
- [ ] **Counts follow a capture.** Type an IP address on 01-06 and a DMX address on 01-01 (card → Type…), then back to the Dashboard: IP reads 1/9 and DMX 1/16; neither device is in its list any more. Clear both afterwards if this is the real project. → saw:
- [ ] **Levels filter.** Pick Level 01 in the Levels chips: the three counts cover level 01 only (IP n/2, DMX n/3), and each list holds only 01 devices. → saw:

## T148 — Project search finds IP and DMX addresses  ·  Needs: no new build (JS update only; client migration 0020 runs on the first launch)

**Why it matters:** T146 gave devices an IP address and a DMX address, but the dashboard search did not index them, so "which device is 10.101.4.23?" had no answer. Migration 0020 adds both to the search index and re-indexes every device once, so addresses typed before this update are found too. Use the Tower project.

- [ ] **Placeholder.** Dashboard: the search field reads `Search the project: ID, tag, room, item, notes, Neuron ID, IP, DMX`. → saw:
- [ ] **Find by IP.** Type an IP address on 01-06 (card → IP address → Type…, e.g. `10.101.4.23`), go back to the Dashboard and search `10.101.4.23`: 01-06 is the one device result; tap it and its card opens on the plan. A partial `10.101` finds it too. → saw:
- [ ] **Find by DMX address.** Type a DMX address on 01-01 (e.g. `1/001`) and search `1/001`: 01-01 is a device result. Change it to `2/017`, search again: `2/017` finds it and `1/001` no longer does. Clear both addresses afterwards if this is the real project. → saw:

## T149 — Mac test rig  ·  Needs: a Mac (Apple silicon, on the office Wi-Fi), not an iPad

**Why it matters:** from here on the functional half of each task's checks is a Maestro flow Claude runs on the Simulator (D248); this section proves the rig once. Do it at the Mac, or let Claude do it over SSH (`docs/ops.md` §6 says how). Nothing here touches the Droplet.

- [x] **Setup.** In the repo on the Mac: `bash scripts/mac/rig.sh setup`. It ends with `rig: ready` after checking Xcode's command-line tools, installing Maestro and CocoaPods if missing, and creating and booting the simulator **Field Survey iPad** (Simulator.app opens with an iPad). → saw (Claude, 2026-11-03, T151): `rig: ready` (Maestro, CocoaPods and the lockfile already in place; the simulator exists and is booted).
- [x] **Local server.** `bash scripts/mac/rig.sh server`: Docker starts postgres, s3 and the API; the script migrates, makes the bucket and ends with `health: ok` from `http://127.0.0.1:8010/health`. → saw (Claude, 2026-11-03, T151): `{"status":"ok","commit":"dev","migration":"0020"}`; `up` now waits for Postgres before migrating (a fresh volume failed the migration).
- [x] **Local build.** `bash scripts/mac/rig.sh build` (10–20 min the first time: prebuild, `pod install`, the Xcode build): it ends with the app installed and open on the simulator, showing the dev client's launcher or the Connect screen. No `eas.json` change, no EAS build. → saw (Claude, 2026-11-03, T151): built on branch `t151-first-run` with T152's UIScene support (off `main` until T150); the app lands in Xcode's DerivedData, so `rig.sh status` / `second` now look there too.
- [x] **Metro.** In a second terminal `bash scripts/mac/rig.sh metro`; then `bash scripts/mac/rig.sh open` loads the app from Metro: the Connect screen appears. → saw (Claude, 2026-11-03, T151): Metro `packager-status:running` on 8081; the flows' deep link loads the app (iOS asks "Open", then the dev menu, which `_launch` closes).
- [x] **The smoke flow passes.** `bash scripts/mac/rig.sh flows`: Maestro connects to `127.0.0.1:8010` as Ann, creates a project with level 06M, opens the level (the "No plan sheet yet" line), syncs (`Synced …`), and reports `smoke.yaml` passed. The project appears in the local server, not on the Droplet. → saw (Claude over SSH, 2026-11-03, T151): green after four flow fixes (the keychain outlives `clearState`, the dev menu's Tools button over "+ New project", iOS's *Save Password?* sheet after the token, the `Synced` line is "● Online · Synced <time>"; `docs/ops.md` §6.3). Green three runs in a row, one from a reset keychain (connect form → picker), one picker-only, one already signed in. Local Postgres holds the `Maestro 11-04 02:44` … `02:52` projects (UTC names); nothing on the Droplet.
- [x] **A failing selector reads clearly.** Break a selector (`id: nav.sync` → `nav.syncx` in `app/maestro/_sync.yaml`) and run again: the run fails at that step with a screenshot in the debug output; put it back. (Changing `USER` no longer fails: `_connect` adds a name the server lacks, T151.) → saw (Claude, 2026-11-03): `Tap on id: nav.syncx... FAILED`, "Element not found: Id matching regex: nav.syncx", debug output under `$TMPDIR/field-survey-rig/maestro/.maestro/tests/<run>/`; reverted.
- [x] **Second simulator.** `bash scripts/mac/rig.sh second`: a second iPad simulator boots with the same build; `rig.sh flows --device B` runs the smoke flow there and both projects are on the local server. → saw (Claude, 2026-11-03, T151): "Field Survey iPad B" created and booted with the DerivedData build; `RIG_USER=Bob rig.sh flows --device B` green after three fixes (a stale "Open in Field Survey?" alert, `smoke.yaml`'s `env:` overriding `-e USER`, and the home losing a just-created project; T151 in TASKS.md). Then `rig.sh two`: A sets a status and a note, B (Bob) sees both and sets `No access`, A sees it — green.
- [x] **Setup pipeline flow (T151).** `bash scripts/mac/rig.sh flows setup.yaml`: DaVinci upload and the 06M sheet from the Files app, three drafts accepted / edited / rejected, one pin placed, the card's status, note and punch item, sync. → saw (Claude, 2026-11-03): green twice; the local server holds `06M-D1` `Issue` "Maestro note" with punch #1 (`Information`, `ETC`, "Reterminated - all good").

Decision D249 (Proposed): `eas.json` is not edited for the rig; the `simulator` profile waits for the next build cycle (T150) because any `eas.json` edit changes the runtime fingerprint and would cut the iPads off from updates. → Approve / change:

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
