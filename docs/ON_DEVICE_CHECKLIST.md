# On-device checklist

Things only an iPad can prove. Each finished task adds its checks here; you test several features in one session; then say **"tested"** with the results and Claude archives this list to [on-device-log.md](on-device-log.md) and resets it. How the file is kept: see "Rules for this file" at the bottom.

## Before you start (once per round)

1. **Which build?** Check each task's "Needs" line. If any pending task says *new dev build*, run `eas build --profile development --platform ios` and install it first. Otherwise the dev build already on the iPad works.
2. **Load the latest JS.** On the PC: `git pull`, then `cd app && npx expo start --dev-client`. Open the app on the iPad and let it load from Metro (same Wi-Fi).
   **TestFlight iPads** (from build 13 on, T84) get the latest published JS by **launching the app twice**: open it, swipe it away from the app switcher, open it again. The Sync screen's Install section then shows `update <id> · <date> · T<nn>: …` instead of `embedded`.
3. **Logs.** In the Metro terminal press `j` to open React Native DevTools; app logs appear there, not in the terminal.
4. **Mark results as you go.** Tick `[x]` for pass. For a fail, leave it `[ ]` and write what you saw after "→ saw:". Then paste this file back to Claude.

Pending round started: **2026-10-14**. The M3 close-out round of 2026-10-14 is complete and archived in [on-device-log.md](on-device-log.md): 64 pass, 3 fail, 9 skip, 1 not done. **Part A passed in full** (three review items, nothing lost). Its fails became **T91** (no Surveyed field in Setup → Levels — the last M4 gate item), **T92** (the long-press menu waits for a move) and **T93** / **T94** (export status and speed at TP-3 size); your notes became **T95** (both end devices in a connection search), **T96** (preview the in-between grid bubbles) and **T97** (assign levels). Every decision on the sheet was accepted. What passed has left this file; what is below was skipped, not done, or failed and waits for its fix. New tasks add their checks below.

**This round's build:** **new dev build `a5cbf96f`** (T92; replaces `ddf99272`). Install it from the EAS build page before the round; opening a plan must log `[plan] pdf native patch: t92 ink,longpress-move,press-timer` (if it still says `t70`, the old build is running). **Server and JS:** every green push to `main` deploys the server and publishes the update (T85); `curl -s https://survey.wpcom.cloud/health` shows what runs.

---

## T92 — Long press without moving the finger  ·  Needs: new dev build `a5cbf96f`

**Why it matters:** the long press was held back until the finger moved (close-out D-15). T92 times it itself; these lines in Metro tell us what was holding it, so a fail can be fixed without guessing.

- [ ] **The new patch runs.** Open any plan: Metro logs `[plan] pdf native patch: t92 ink,longpress-move,press-timer`. → saw:
- [ ] **Timings in Metro.** Long-press the plan with the finger still, wait a second, lift. Metro logs, in this order: `[plan] long press native: timer fired ~300 ms after finger down, UIKit long press …, undecided: …; reached JS n ms later`, then `[plan] long press: began (menu open, finger down)`. Copy both lines into "saw" (the "UIKit long press" and "undecided" parts name what held it back; n should be under ~50). If a `UIKit recognised it … ms after finger down` line appears, copy it too. → saw:
- [ ] **A quick tap is still a tap.** Tap a pin briefly: its card opens, no menu. Pan the plan with one finger right away (no pause): it scrolls, no menu. → saw:
- [ ] **Draw mode unaffected.** In draw mode hold the Pencil or a finger still on the plan for a second: no menu, the stroke draws; two fingers still pan. → saw:

Decision D165: our own 0.3 s timer starts the long press (not UIKit's recogniser), and a finger that drifts more than 10 pt before then is a pan, not a long press. → Approve / change:

## T70 — Long-press feel  ·  Needs: new dev build `a5cbf96f` (re-run after T92)

**Why it matters:** placing a device or a note exactly on the drawing is the point of the long press; the spot must be adjustable before choosing.

Failed 2026-10-14 (close-out D-15): "The menu does not pop up till the holding finger is moved." → **T92** (done; run these again on build `a5cbf96f`).

- [ ] **Menu while the finger is down.** Long-press the plan and keep the finger still: the blue dot and the menu appear while the finger is on the glass, without moving it (Metro: `[plan] long press: began`). → saw:
- [ ] **Dot follows the finger.** Still holding, slide the finger: the dot follows; lift: it stays where you lifted (Metro: `lifted after n move event(s)`, n > 0). → saw:
- [ ] **Drag the dot after lifting.** With the menu open, drag the blue dot to a nearby spot (or onto a pin): it moves; the menu follows; "+ Photo of <device>" names the device now under the dot. Pick + Device: the grey "+" pin sits where the dot was dropped. → saw:
- [ ] **Pan still closes the menu.** With the menu open, pan the plan (away from the dot): the menu closes. → saw:

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
- [ ] **Floor PDF still fine.** Generate floor PDF for 06M on the same project: Ready, opens. (Unchanged by T94; its photos are still read one at a time, so note the minutes.) → saw:

## T81 — Punch List Device text follows the device  ·  Needs: no new build

**Why it matters:** the EC reads the Punch List's Device column to find the device; it must match the device as it is now (renamed, retagged), and a row the import could not link must not vanish into a wrong device.

Skipped 2026-10-14 (close-out E-8 … E-12). Use "Tower M3 round" (imported after T81; the Tower itself was imported earlier and has no review items for this). Needs review now opens on the project shown on the home (T83 passed).

- [ ] **Review items arrive.** Needs review → Lint tab: 13 items reading `Punch #… · Device "…" → link` (e.g. B1 #27 `Walter Tower east wing`, 04 #22 `Elec XX04-1E01`, three `Stations & sensors`). No item for the "Missing all Device Neuron IDs" rows. → saw:
- [ ] **Link to device.** Select B1 #27: the panel shows the punch item and "Device, as the master wrote it: Walter Tower east wing". Type `S1` in the filter: the list narrows to B1 devices with S1 in the ID or text. Tap one → Link: the item leaves the list, the note reads "Linked: Review: linked punch item to B1-S1… (master: "Walter Tower east wing")". → saw:
- [ ] **Create device.** Select 04 #22 → Create device ▸: the + Device form opens in the panel with Room / Location empty-or-prefilled and "Not on the plan yet". Pick Relay panel, type `CT04LCPB`, Add device: the item closes as linked to `04-? (new)`. After the next sync the device gets its 04-nn ID. → saw:
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

## T87 — The name on the Levels home; one name on two iPads  ·  Needs: no new build

The two-name check passed in the close-out (Part A). These two were not on the sheet.

- [ ] **The name is on the home.** Levels home, above the project name: `Signed in as <your name> · This iPad: Field 1`. On an iPad with no label: `This iPad: iPad …` + six characters and "(name it on the Sync screen)". Rename the label on the Sync screen and come back: the line follows. → saw:
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

## T45 — Replace a plan sheet (leftover)  ·  Needs: no new build; a throw-away project

- [ ] **Replace.** Floor plans → a level with a sheet → Replace… with a different PDF: the level now opens that one; the old pins show as "elsewhere" (T77 carries them over). → saw:

## T65 — Imported multi-device photos (observation)  ·  Needs: no new build

- [ ] **Imported multi-device photos.** On the Tower project, if a photo shows several devices in the master (`B1-01, B1-02`): note whether only the first device shows it (expected for data imported before T65; see the Tower backfill question in DECISIONS.md). → saw:

## T91 — Surveyed / Updated dates in Setup → Levels  ·  Needs: no new build (JS update)

- [ ] **Set the date.** Tower M3 round → Setup → 2 Levels: each row has Surveyed and Updated boxes. Type `2026-10-13` in 06M's Surveyed, tap elsewhere. Expect the box to keep the date after a reload of the screen. Why: re-runs close-out B-3 and fills the one-off T89 → ops follow-up. → saw:
- [ ] **Bad date refused.** Type `13/10/2026` (or `2026-02-30`): red border and a message at the top; nothing saved, the old date returns after the next save elsewhere. Clear the box and tap away: the date empties. → saw:
- [ ] **Header follows.** Export screen's Floor PDF header line for 06M reads `Surveyed 2026-10-13`; a level with an empty box still shows its newest survey date (D159). → saw:

## T33 — Rule drafts: Accept / Edit / Reject on the card  ·  Needs: no new build (JS update; server deploy first)

**Why it matters:** the rule engine core is in; since T34 the real rules raise the demo's drafts (the seeded ones are gone), so the buttons are tried on real output.

- [ ] **Accept.** Open **Demo plan (06M composite)** → tap **06M-01** → the Punch items section shows `DRAFT ⚑ R3a Run Unison to Stations & Sensors`, `DRAFT ⚑ R3a Land 0-10V control wiring`, `DRAFT ⚑ R3b Terminate DMX to 06M-03` and `DRAFT ⚑ R2c cable`. Tap **why?** on the Unison draft: the rule's text and `… is Not installed: the wire has not been pulled.` appear. Tap **Accept**: the draft disappears and a new punch item `NEW · Run Unison to Stations & Sensors · Cable not run · EC · Open` is listed. → saw:
- [ ] **Edit.** On the R3b draft tap **Edit**: small fields (item, type, owner, notes) appear; change the item text, tap **Save & accept**: the Punch items section lists the edited text as `Missing part · EC/ETC`. → saw:
- [ ] **Reject.** The demo database keeps decisions, so Reject needs a draft still open: on another team iPad (or after deleting and reinstalling the app) tap **Reject** on the `Land 0-10V control wiring` draft: it disappears and does not come back after leaving and reopening the card. → saw:
- [ ] **Sync still clean.** After the demo decisions, the Sync screen on a real project shows nothing pending from the demo (the demo database never syncs) and no "need attention" ops. → saw:

Decision D169: **approved** (Landry, 2026-10-15); nothing to answer here. (The "Nothing on a real project" check is replaced by T34's below: the rules now write.)

## T34 — Rules R1–R5, E5–E9 on real data  ·  Needs: no new build (JS update; server deploy first — D169's create rule)

**Why it matters:** the rules now raise drafts, findings and the Neuron ID item's upkeep on every project; two iPads must converge on one row each, and nothing may be written except drafts, findings and that one maintained item.

- [ ] **First run on the Tower.** Open the Tower M3 round project (after a sync). DevTools shows one `[rules] run` with `rules: 17`, `problems: 0`, and `created` > 0 the first time; the next run (half a second after any edit) shows `ops: 0`. Note the first run's `proposals` / `findings` counts here. → saw:
- [ ] **The master's items raise no duplicates.** On 06M open **06M-01** (CT06LCPB's panel card, or any panel with the master's `Terminate DMX …` items): the Punch items section lists the imported items, and no `DRAFT` repeats an item already there. Why: D175 (8) — an open item with the same text silences the draft. → saw:
- [ ] **A Not installed end raises its Run item.** On a device with a connection, open the end editor, set a status-less end to **Not installed** → back on the card within a second: `DRAFT ⚑ R3a Run <signal> to <far end>`; set it to **Issue** with the chip "Run, not terminated" → the Run draft is gone and `DRAFT ⚑ R3a Terminate …` is there (`Termination`); on a DMX run pick "Run, not terminated; no term kit" → `DRAFT ⚑ R3b Terminate DMX to … · Missing part · EC/ETC` instead. → saw:
- [ ] **Accept R3b, then R4b follows.** Accept the R3b draft: the item appears; within a second `DRAFT ⚑ R4b DMX termination kit - <far end> run · part · EC · Needed` appears on the card. Accept it: the Missing parts section lists it with `src #<the item's number>` once the server has numbered the item (Qty 1, Need to be ordered). → saw:
- [ ] **Neuron ID item upkeep (D170).** On a level whose Neuron ID item is the master's ("Missing all Device Neuron IDs"): type a Neuron ID on a device of that level; within a second the item's Notes (card of any device on the level → Punch items, or the export) no longer list that device; History on the item shows `Rule engine R3c`. On a fresh project with no such item, the draft is in the store but **no screen shows it yet** (T100) — nothing to see. → saw:
- [ ] **Two iPads, one row.** Both iPads online on the same project: make the same end `Not installed` on iPad A, sync both; iPad B shows the same single `DRAFT ⚑ R3a` (not two), Needs review stays empty. Reject it on B, sync: A's card loses the draft. → saw:
- [ ] **Library drafts.** On a Relay panel with no P cable (06M-01 on the demo, or a field-added panel): `DRAFT ⚑ R2c cable` → **why?** names the EBDK; **Accept**: the Connections section gains `NEW · P → EBDK panic wire · Installed, untested`. An NSPS or rack without 120V shows `DRAFT ⚑ R2d cable` the same way. → saw:
- [ ] **Quick actions.** On a station's card open **Quick actions**: **Spot-check fixed** → type what was found → Apply: a Closed `Information · ETC` item `Spot check: …` with notes "Reterminated - all good", device Notes unchanged. **Non-ETC device** → type `Wattstopper` → Apply: status `Not installed`, Notes end with `…appears to be a Wattstopper, confirm.`, an Open `Information · EC` item `Confirm existing station at location is a Wattstopper, not a PI1002`. **Relocated** → type a room → Apply: Room / Location reads `<room>; moved from <old room>`. "Not found on site" stays disabled. → saw:
- [ ] **Findings on the card.** A device set to **Installed, untested** with an end `Not installed` shows the finding line `Installed, untested with outstanding wiring/termination → Issue (suggested)`; set it to **Issue** with no open item → `Issue device with no open punch item`; accept or add an item → the line goes. → saw:
- [ ] **Sync load.** After the first run, the Sync screen pushes the engine's proposal and finding creates (count them in the outbox before the sync; on the Tower round expect a few hundred) and ends "Synced" with no "need attention" ops. → saw:

Decision D175: **approved** (Landry, 2026-10-15) as the defaults; D176 makes every value settable per project and in the library (T102). Nothing to answer here.

## T35 — One "Run …" draft per wire; 120V wording  ·  Needs: no new build (JS update)

**Why it matters:** the golden test against the master (TP-8) showed the engine raising two "Run …" drafts for one unpulled wire when both ends were surveyed, and naming a 120V run after the power placeholder. The master has one item per wire and names the power supply.

- [ ] **Both ends surveyed, one draft.** On a cable whose two ends are both on cached levels (e.g. a DMX run between a relay panel and the rack), set the panel's end **Not installed**, then the rack's end **Not installed** too: only one `DRAFT ⚑ R3a Run DMX to …` exists, on the panel's card (side A); the rack's card shows none for that wire. Why: R3 says one Run item per unpulled wire (D177). → saw:
- [ ] **The accepted item stands.** Accept that draft, then set the rack's end back to empty and to **Not installed** again: no second Run draft appears on either card. → saw:
- [ ] **120V wording.** On an NSPS or rack, set the 120V end **Not installed**: the draft reads `Run 120V to P-NSPS-D Power Supply` (rack: `Run 120V to Equipment rack`), not "… to 120v Power". → saw:

Decision D177 (Proposed): one Run item per wire — when both ends are surveyed `Not installed` it goes on the end with a device (side A when both have one, as the master files it), and a Run item the rule made on the other end stands for the wire; terminations stay one per end. A single row's far end is its To text. → Approve / change:

---

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
