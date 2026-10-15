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

- [ ] **Both ends surveyed, one draft.** On a cable whose two ends are both on cached levels (e.g. a DMX run between a relay panel on 04 and the rack on 06M), set the panel's end **Not installed**, then the rack's end **Not installed** too: only one `DRAFT ⚑ R3a Run DMX to …` exists, on the card at the **start of the run** (the lower floor's end on the Tower; the riser's origin once risers are imported); the other card shows none for that wire. Why: R3 says one Run item per unpulled wire (D177). → saw:
- [ ] **The accepted item stands.** Accept that draft, then set the other end back to empty and to **Not installed** again: no second Run draft appears on either card. → saw:
- [ ] **120V wording.** On an NSPS or rack, set the 120V end **Not installed**: the draft reads `Run 120V to P-NSPS-D Power Supply` (rack: `Run 120V to Equipment rack`), not "… to 120v Power". → saw:

Decision D177: answered 2026-10-15, **Approved** — "the start of the run holds the item" (side A in the data). Nothing to answer here.

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

---

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
