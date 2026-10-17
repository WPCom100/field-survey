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
- [ ] **Floor PDF still fine.** Generate floor PDF for 06M on the same project: Ready, opens. (Its speed is the T98 section below.) → saw:

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

## T40 — Vocabulary and placeholder editors  ·  Needs: no new build

**Why it matters:** the note chips, captions, categories and placeholder endpoints are the project's own vocabulary; they must be editable in the field without losing a phrase.

- [ ] **Open it.** Home sidebar → **Vocabulary**. Two tabs: Lists and Placeholders. → saw:
- [ ] **Load standard lists.** Tap **Load standard lists**: a line says how many values and placeholders were added; the Lists tab shows the master's phrases (e.g. `Empty box on wall.`) and the eight categories, Placeholders shows Fixtures, 120v Power, Stations & Sensors, Level 09–12 and the rest. Tap it again: "Everything standard is already here." → saw:
- [ ] **Add, accept, edit, remove.** Add `Stuck button` to Device notes: it shows with a yellow `draft` tag; **Accept** removes the tag; **Edit** renames; **Remove** deletes. A repeat of the same spelling is refused. → saw:
- [ ] **Chips follow.** Open a device card on the plan: the Notes chips show the project's Device notes (including a fresh draft). → saw:
- [ ] **Endpoint picker.** On a connection whose end is a placeholder (e.g. fixtures), open the end editor: **Change placeholder…** lists the project's placeholders; pick another and the header and the Cable view show it. **Add & use** creates one. A device end has no picker. → saw:
- [ ] **Remove guard.** Remove a placeholder a connection still uses: refused with the count. → saw:

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

- [ ] **Open it from Projects.** Levels home → Projects → **Device-type library**: `App device-type library`, ◀ Projects back. On a fresh iPad with no project it still opens (and syncs). → saw:
- [ ] **Add and accept without a project.** **+ New type** → `P-TS7-E`, Touchscreen → Add draft → add a default cable (N → `Network switch`) → Save → **Accept draft**. → saw:
- [ ] **Second iPad.** Within a few seconds the other iPad's app library shows `P-TS7-E` accepted (no project open needed). → saw:
- [ ] **Promote.** In a project's Library, pick an accepted type → **Promote to app library**: "Promoted: … new projects copy it."; the button becomes `In the app library ✓`. Promoting a draft is not offered; promoting a model the app library already has is refused. The app library lists the type. → saw:
- [ ] **New project copies it.** Projects → **+ New project** (any name, one level) → open its Library: the promoted type and `P-TS7-E` are there, accepted. → saw:
- [ ] **Conflict.** Both iPads offline (airplane mode), open the same app-library type, change its Aliases differently, Save on both; back online: the library header reads `1 in review ▸` → **App library — needs review** lists `Device type …` · Aliases with A / B; Choose B → both iPads show B's aliases and the item is gone. → saw:
- [ ] **Offline.** In airplane mode, add an app-library type: it saves at once; the Sync screen counts it as pending and it uploads when back online. → saw:

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

- [ ] **Upload.** Setup → **3 Sources** → **BOM and riser** → BOM **Choose PDF…** → `BOM.pdf`. The line reads Queued, then "Done: 108 device drafts, 17 excluded lines…". Then Riser → `riser.pdf`. About 12 minutes later it reads "Done: … cable drafts … Claude $…". → saw:
- [ ] **Step 4 opens.** After a sync, **4 Review drafts** is live. Level chips show B2…06M plus **Pool** and the floors the project lacks (09, 10…). Each chip shows its open count, and the header reads "Devices n · Cables n · Needs review n". → saw:
- [ ] **Source crops.** Tap a device row with Src **R+B**. The panel shows two crops: the BOM line and the riser symbol, each outlined in red. Tap a crop: it gets larger with more of the sheet around it. → saw:
- [ ] **SR / LR.** On 01, a `P-DOC-C-?` row. Accept stays greyed with "Pick the model…". Pick LR → Accept. The row reads ✓ edited. → saw:
- [ ] **BOM ≠ riser.** On 01, PI1004. The panel offers BOM 1 / Riser 2 radio buttons. Pick one → Accept. Needs review no longer lists that level's source conflict. → saw:
- [ ] **Accept all ≥ 0.9.** On a level, tap **Accept all ✓ ≥ 0.9 (n)**. The dialog names you; confirm. Only clean rows turn ✓ accepted; flagged and conflict rows stay open. Open a device draft's History if shown, or check the Sync screen's pending count: one change per draft. → saw:
- [ ] **Edit / Reject / Reopen.** Edit… a draft: change qty and level → **Save & accept** → ✓ edited. Reject another with a reason chip → ✗ rejected, and the **Rejected** filter lists it. **Reopen** → back to Open. → saw:
- [ ] **Mismatch list.** Under the table, sentences like "BOM qty 1 ≠ riser 2 (PI1004)" and "Riser device not in the BOM: …". Tap one: its draft is selected. → saw:
- [ ] **Excluded lines.** Devices tab → **Excluded BOM lines ▸** lists service lines, brackets and similar items with their reason. **Promote…** one → it appears as a draft with Src **BOM↑** and asks for a category before Accept. → saw:
- [ ] **Cables tab.** Switch to Cables on 06M. Rows show Code · From · To · To-lvl; unresolved far ends read "— pick" in orange. The panel shows the riser crop with the **bubble** outlined. → saw:
- [ ] **Endpoint picker.** On a cable whose To is unresolved, tap **Change…**. Candidates come first, a draft device that is already a device reads "(in the baseline)", and placeholders follow. Search finds devices on other levels. Pick one → the To line updates. → saw:
- [ ] **Confirm endpoint.** Tap **Confirm endpoint ✓**. The note says the cable is made, or that it waits for its device to be placed. Open **Cable / riser**: the new cable is listed **without ⚑**, and its ends read like `DMX to Level 02 UFMP4`. A cable accepted with **Accept unconfirmed** shows ⚑. → saw:
- [ ] **Hand drafts (K12).** **+ Draft device** → PI1002 · Station · qty 4 on 02 → Add. It lists with Src **hand** and can be accepted. **+ Draft cable** → NG, From `Equipment rack`, To `P-TS7-E` → Add, then pick both ends and Confirm. → saw:
- [ ] **Needs review link.** Needs review → **Extraction** tab: a line counts the flagged drafts → **Open Setup → Review drafts ▸** opens step 4. A **Source conflict** item has **Open in Review drafts ▸**, which opens that draft selected. → saw:
- [ ] **Offline.** Airplane mode: Accept, Reject and endpoint picks still save; crops and excluded lines say they need a connection. Back online, the edits sync. → saw:
- [ ] **Second iPad.** After a sync, the other iPad shows the same states, and an accepted cable appears once in Cable / riser. → saw:

Decision D193 (Proposed): Accept on a device draft only marks it reviewed; its devices are made when placed (step 5, T46), so a level seeded from the master is never duplicated. Accept on a cable draft makes the cable once both ends are real records; if the baseline already has that cable, it is linked instead. A cable whose end is a not-yet-placed draft device waits until that device is placed. **Confirm endpoint** = Accept plus "endpoints confirmed"; Accept all leaves cables unconfirmed. A source conflict is settled by Accept (the drafts' count) or Reject (the baseline's). Flagged drafts get no Needs review items: Needs review counts them and links to step 4. → Approve / change:

## T108 — Riser lines with no bubble: "What is this cable?"  ·  Needs: no new build (JS update; server deploy first, then upload the riser again to a **new scratch project**)

**Why it matters:** the riser draws some cables with no code bubble (feed and note arrows, the last Unison link into an NSPS, trunks marked only by a label). You asked to be asked about each one, so nothing on the drawing goes unaccounted for. Use a fresh scratch project: a riser already extracted for a project is skipped the second time.

- [ ] **They are proposed.** After the riser job finishes, its line in Setup → 3 Sources still reads "Done: … cable drafts …". On **4 Review drafts → Cables** for 03, the first rows have Code **?**: two `TO LOAD CKTS`, two 0-10V control leaders, two feed arrows, the UFMP4's `TO LOAD` and feed, two EBDK sense feeds, the NSPS feed and the NSPS line up the trunk. That is 12 lines on 03; the model may add one it saw. → saw:
- [ ] **The question and the crop.** Tap the CT03LCPB 0-10V leader. The panel reads **What is this cable? Pick its code**, then "Guess: 0-10V (…)", with the **0-10V ?** chip marked and the To already set to **Fixtures (placeholder)**. The riser crop outlines the leader line, not a bubble, and is labelled "Riser 001 · level 03 · line l…". → saw:
- [ ] **Nothing is taken for you.** Before you pick a code, Accept stays greyed with "Pick the cable code." **Accept all ≥ 0.9** never takes these lines. → saw:
- [ ] **Accept → the library row, once.** Pick **0-10V**, then Confirm endpoint. The note says the cable is made. Open the panel's device card once it is placed: Connections shows one 0-10V row, `CT03LCPB → Fixtures`, and **no** R2c draft offering another. Do the same on a panel that **already** had its 0-10V row (accepted from the R2c draft first). The note says the baseline already had it, and the card still shows a single 0-10V row. → saw:
- [ ] **A 120V feed.** On an NSPS feed line (guess 120V, To **120v Power**): pick 120V → Confirm. The NSPS card's row reads `120v Power → P-NSPS-D Power Supply`, and R2d no longer offers one. → saw:
- [ ] **Not a cable.** On a `TO LOAD CKTS` line (no guess, To "— pick"), Reject with a reason such as "Load circuits, by others". It reads ✗ rejected and no cable is made. → saw:
- [ ] **Needs review.** Needs review → Extraction counts these lines among the flagged drafts, and the mismatch list under the table reads "A riser line with no wire code from CT03LCPB → "TO LOAD CKTS" — what is it?". → saw:

Decision D194 (Proposed): a line with no bubble is found by the geometry on text sheets (touching a device's outline, reaching out of it, no bubble) and by the model on sheet 002; its guess comes from the model, else from its own text, and is never the code. Nothing is excluded: you reject what is not a surveyed cable. An accepted 0-10V line (Relay panel) or 120V line (NSPS / rack) **becomes the device's library row**: it is linked to the row the device already has, or made with the library's wording, so R2c / R2d stop offering one. → Approve / change:

## T106 — Riser crop on cables made from the riser  ·  Needs: no new build (JS update)

**Why it matters:** a cable accepted from a riser draft now shows the riser itself in the Cable / riser view, zoomed to its bubble, so you can check the far end against the drawing without leaving the cable. Use the scratch project from T44 / T108 (it has accepted riser cables).

- [ ] **Download.** Cable / riser → tap a cable you accepted with **Confirm endpoint** in Review drafts → under the end editor, **Riser crop · riser.pdf p.1** reads "Riser not downloaded" with **⤓ Download riser**. Tap it: after a few seconds the riser opens. → saw:
- [ ] **Focused and outlined.** The crop opens **upright** (the drawing reads left to right, not on its side), zoomed to the cable's wire bubble with some of its line around it, and the bubble has a red outline. It is the same bubble the Review drafts crop outlined for that draft. → saw:
- [ ] **Pinch.** Pinch out and pan: the red outline stays on the bubble (it may trail a moment behind during the gesture). → saw:
- [ ] **Page 2.** A cable from a level on sheet 002 (14–28 are out of scope, so pick one whose far end is there if you have one; else skip) opens on **p.2**, focused the same way. → saw:
- [ ] **Cached.** Pick another riser cable: it opens straight away, no download. Airplane mode: it still opens. → saw:
- [ ] **Accepted offline.** Airplane mode on: in Review drafts accept another riser cable with Confirm endpoint. Turn airplane mode off, sync, open it in Cable / riser: the crop still finds the riser (by its file name) and opens it. With airplane mode on at that point instead, it says the riser PDF could not be found, with **Try again**. → saw:
- [ ] **Not from the riser.** A cable from the seeded master or one added on a card reads "No riser crop for this cable: it was not made from a riser draft". → saw:

Decision D195 (Proposed): the riser's boxes are measured on the page as it is displayed (the Tower riser's pages are turned a quarter, `/Rotate 270`); the iPad turns them into PDF coordinates using the rotation the viewer reports, so the crop opens upright on the bubble with no new build. A cable accepted offline finds its riser by file name when it is shown, and nothing is written back to the cable. → Approve / change:

## T111 — DaVinci library import  ·  Needs: no new build (JS update; server deploy first, and **every iPad on the new JS before the first upload** — an older iPad refuses the new columns on pull until it updates, nothing lost)

**Why it matters:** ETC's whole catalogue becomes app-library drafts in one upload, so types are picked, not typed, and every project created afterwards starts with the accepted ones. Get `library.json` from the PC first: it is at `%LOCALAPPDATA%\ETC\DaVinci\library.json` after a DaVinci launch (≈ 49 MB); copy it and `fixtures/DaVinci_categories.xlsx` to iCloud Drive.

- [ ] **Two files, one tap.** Any project → Setup → 3 Sources → **DaVinci library**: tick **Retire the hand-made app-library types first** (D199), then **Choose files…** → in Files select both `library.json` and `DaVinci_categories.xlsx` (tap Select, pick both, Open). The row reads "Uploading library.json and DaVinci_categories.xlsx…", then "Queued", then within a minute "Done: … new drafts, 0 updated, 0 unchanged (501 device types, 631 accessories), 0 protocol drafts, n hand-made types retired". After a sync, Projects → Device-type library no longer lists your hand-made types (History on a project still shows them; the Centennial project's own copies are still there). → saw:
- [ ] **Only the library picked.** Choose files… again with only `library.json`: it uploads (the mapping is reused) and ends "Already imported — this library and mapping were imported before". → saw:
- [ ] **The drafts arrive.** Sync, then Projects → **Device-type library**: Power Distribution, Equipment, Station, Touchscreen… groups full of DRAFT types ("added by <you> 10/16 ⚑"), and an **Accessories (not placeable)** group (P-LCD-FBB, ERP-FT-LVD, P-ACP-E Mk2…). Tap **P-NSPS-D**: "From DaVinci · Paradigm / Controllers · NSPS (library 2026-10-13)", the description, **Datasheet ↗** opens ETC's PDF in Safari, aliases `NSPS · 7182A1711`, Default cables U, N, **UV** (its 48 V aux bus, D199) **and 120V** (it is a power supply, D198), Neuron ID "Needed". Tap **ERn2-W-120 Mk2**: Default cables 120V alone (its P-SPM-E module is a power supply). Tap **EBDK**: P and 120V (the Sense wire). → saw:
- [ ] **A touchscreen's back boxes.** Tap **P-TS7-E**: Default cables NG; Optional accessories list P-LCD-FBB, P-LCD-SBB, P-LCD-SLBB, P-LCD-SBB-5 (expected empty — the "one of these" rule is kept on the row for T113) and P-LCD-LC. On **ERn2-W-120 Mk2**: P-ACP-E Mk2 expected 1. → saw:
- [ ] **Accessories are not devices.** On a plan, long-press → add device → the type picker: search "LVD" or "P-LCD" — nothing; "P-TS7" — the touchscreen (draft, flagged). → saw:
- [ ] **Cable codes.** That project's Setup → Vocabulary → **Cable codes**: X N NG U F P UV 0-10V 120V **D** accepted and no drafts (every DaVinci protocol has a ruling now, D199 / D200; a protocol ETC adds later would appear here as a draft). → saw:
- [ ] **Accepted types stand.** Accept P-NSPS-D as it is. Back on the PC, regroup one row in the mapping sheet (e.g. move `Paradigm / Contact Interfaces` to Equipment) and upload `library.json` + the changed `.xlsx` again: the line reads "Done: 0 new drafts, … updated, …, 1 accepted or rejected left alone"; after a sync UHCI-WM sits under Equipment as a draft, P-NSPS-D is unchanged, and History on UHCI-WM shows the category change by "DaVinci library import". → saw:
- [ ] **A hand-made model.** Make a draft type "P-TS7-PE" by hand in the app library, upload again (any newer file) with the Retire box **off**: the line ends "1 model clash"; your type is untouched. → saw:

Decision D197 (Proposed): the import files its batch under the project you start it from (that project's Vocabulary takes the unmapped protocols as Cable codes drafts), writes the types to the app library as drafts with four new columns (description, datasheet, DaVinci provenance, accessory-only), keeps "one of these" accessory rules as a group on each row rather than an expected count, treats a model you already made by hand as a clash it reports and never merges, and never touches an accepted or rejected type on a re-run. → Approve / change:

## T112 — Roles on library types; the D196 categories  ·  Needs: no new build

**Why it matters:** the rules, the ID letters, the Punch List Device text and the pin shapes no longer read the words `NSPS`, `Relay panel`, `EBDK`…: they read the device's **role**, which its library type carries (D201). The categories become the eleven you grouped in D196, with the master's old names as old spellings.

**Order on a project** (D201 (3)): run the DaVinci import first (T111 checks), accept or at least leave the catalogue types as drafts, **then** Vocabulary → Load standard values, **then** fix the old spellings with one ruling.

- [ ] **Category picker.** On a plan, long-press → + Device: the category chips read Power Distribution · Emergency Equipment · Equipment · Equipment Panels · Equipment Rack · Power Supplies · Wall Plates · Lighting Console · Touchscreen · Station · Sensor (the eleven), in that order. The same list in Setup → Review → Edit a device draft, and in the ruling editor's Category options. → saw:
- [ ] **Role chips in the library editor.** Projects → Device-type library → P-NSPS-D (from DaVinci): a new **Role** field reads **NSPS** (chip selected), with Category default (Other) · Relay panel · Foundry panel · EBDK · Equipment rack · NSPS · Touchscreen · Station · Sensor · Other beside it. The Neuron ID line reads "Role default (not needed)"; "+ P-NSPS-D Power Supply (expected 1, D52)" is offered. Open UFMP4: role Foundry panel; ERn2-W-120 Mk2: Equipment rack; P-TS7-E: Touchscreen; UH10002: Station; UHCI-WM: Sensor; EBDK: EBDK; ERP-FT-LVD (accessory): Category default (Other). Rules that reference this type: R2d, R2e on the NSPS; R2c on a relay panel type. → saw:
- [ ] **A role corrected by hand stands.** Change P-TS7-E's role to Other and Save; upload the DaVinci library again (any newer file): after the sync P-TS7-E still says Other (D199 (3)); set it back to Touchscreen. → saw:
- [ ] **Pin shapes follow the role.** On a Centennial plan: the NSPS pin is a pentagon, the rack a hexagon, EBDKs wide rectangles, UFMP4s rounded squares (they match the catalogue's UFMP4 type), relay panels squares, stations circles, sensors diamonds, the touchscreen a triangle. Add a device with a `Power Supplies` type (E-SPS): its pin is an **octagon**. → saw:
- [ ] **Load standard values on Centennial.** Setup → Vocabulary → Load standard values: the line counts the new values; **Device categories** now lists the eleven (Equipment Rack included) and no longer lists Relay panel / Foundry panel / EBDK / NSPS / Equipment rack (they are old spellings now). Touchscreen, Station and Sensor are the same rows as before. → saw:
- [ ] **The rename ruling.** Lint → **Value outside vocabulary**: one finding per device still spelled the old way (`06M-04: Category "NSPS" is an old spelling of "Equipment"` …), with **Fix all via ruling**. Tap it: the ruling editor opens one rename per spelling (Relay panel → Power Distribution first); the preview lists every device it changes; Apply. Repeat for the other four. Afterwards the lint is quiet, each device's History shows a Ruling change with your name and the reason, and Device categories shows the old spelling pointing at the new one. → saw:
- [ ] **Roles survive the rename.** After the ruling: the NSPS pins are still pentagons and the Neuron ID item still leaves the NSPS out (they match the catalogue's P-NSPS-D-KIT by Device text); EBDKs still wide rectangles; UFMP4s still rounded squares; the rack still a hexagon. **The 11 relay panels (CTxxLCPA/B) turn into octagons** and lose R2c: their Device text is the panel tag, which matches no catalogue model (D201 (2)). On each relay panel's card pick its type (ERP24-FT / ERP48-FT, or the ERP-FT-241P / -481P alias if the catalogue has it): the pin is a square again and the card's Neuron ID / rules read as before. → saw:
- [ ] **Floor PDF and export.** Export a floor PDF of 06M after the ruling: the pin shapes on the page match the plan (octagon for an untyped relay panel until its type is picked); the Punch List tab's Device column still reads `P-NSPS-D-KIT`, `Equipment Rack 18U`, `EBDK (CT06LCPB)`, `UFMP4 - <room>` for the typed devices; the Devices tab's Category column shows the eleven. → saw:
- [ ] **ID letters by role.** In the project's Device-type library add a draft type `Test station`, category Equipment, role **Station**, Save. On a plan, + Device with it: the form asks for a tag (or leaves it to the server) and the device comes back as `<level>-S<n>`; a device added with E-SPS (Power Supplies, role Other) gets `<level>-<nn>`. Delete the test device and reject the test type afterwards. → saw:

Decision D201 (Proposed): (1) `library_type.role`, read instead of category strings everywhere; (2) a device of `Power Distribution` or `Equipment` with no type is `other` — its type carries the role (Centennial's relay panels need their type picked); (3) the rename is applied through Load standard values + the vocabulary lint's "Fix all via ruling", not by the seed import, so TP-4 and TP-8 stand and the riser schema waits for T115; (4) the DaVinci import's role table; (5) what stays on the master's eight. → Approve / change:

## T113 — Accessory groups in the lint and on the card  ·  Needs: no new build

**Why it matters:** the catalogue says "one of these back boxes" and "two ERn modules"; until now only a single accessory found short was flagged. T113 checks the groups and each model's maximum, and the card offers a group's members together.

Set-up: in Projects → Device-type library, **accept** the DaVinci types ERn2-W-120 Mk2 (or another ERn2) and P-TS7-E, and give one device of each on a scratch plan that type (card → type).

- [ ] **Grouped "+ add" rows.** Open the ERn2 device's card → Accessories: the "+ add" rows come in blocks with a left rule; one reads `ERn Modules · needs 2` over its members, another `ERn Accessories · needs 0 to 1`; ungrouped accessories (URTO Mk2…) are single rows. On the P-TS7-E: one block `backbox accessory · needs 1` with the back boxes in it. On an NSPS kit device: `+ add P-NSPS-D Power Supply` · expected 1 is still its own row. → saw:
- [ ] **Counting fills the head.** On the ERn2, + add P-ACP-E Mk2, set found 1: the block's head now reads `ERn Modules · needs 2 · found 1` and still offers ERn-BM; the block stays where it was. → saw:
- [ ] **Group findings.** With only that module counted, the card's findings (and Lint → **Accessory group out of range**) show `<ID>: ERn Modules found 1, needs 2 (P-ACP-E Mk2, ERn-BM)`. Add ERn-BM with found 1: the finding goes. On the P-TS7-E add two different back boxes, found 1 each: `backbox accessory found 2, needs 1 (…)`; set one to 0: quiet. → saw:
- [ ] **Max quantity.** Set an accessory whose catalogue max is 1 (URTO Mk2) to found 2: `<ID>: URTO Mk2 found 2, at most 1`. Back to 1: quiet. → saw:
- [ ] **Drafts stay quiet; Save keeps groups.** Put the P-TS7-E type back to draft (Back to draft): its group finding disappears, the card still shows the grouped "+ add" rows. Accept it again, change its description or an alias, Save: the groups are still on the card (the editor no longer drops them). → saw:

Decision D202 (Proposed): (1) only accepted types' groups are checked; (2) a group is checked once one member is counted, found = the members' counted sum; (3) one model above its max quantity is its own finding; (4) `Acc` unchanged beside it; (5) the card's "+ add" rows in blocks by group in slot order, the NSPS power supply its own row, a full group still offers its members; (6) the editor's Save keeps max quantity and group. → Approve / change:

---

## T114 — Library screen at catalogue size  ·  Needs: no new build

**Why it matters:** after the DaVinci import the app library holds about 500 placeable drafts and 630 accessories; without search, filters and a bulk accept nobody can review it, and the plan's "+ Device" picker becomes a wall of chips.

Set-up: Projects → App device-type library (the imported DaVinci types). Use a **scratch** project for the picker checks.

- [ ] **Opens and scrolls.** The screen opens in a few seconds; the list scrolls smoothly top to bottom; the header still reads `(n types · m drafts)` and the "in review" link (if any) shows the same count as before. Note how long it took to open. → saw:
- [ ] **Search.** Type `ts7`: only P-TS7-E (and anything else named so) remains, under its group head reading `1 of …`. Type `control station`: the types whose display name has both words. Clear with the ✕: the full list is back. → saw:
- [ ] **Chips and Drafts only.** Tap the `Station (…)` chip: only stations. Tap it again: all. Turn on Drafts only: accepted types disappear, group heads show `n of m`. → saw:
- [ ] **Accessories folded.** With no search and no chip, `▸ Accessories (not placeable) (…)` shows as one folded header; tap it: it opens (▾); tap again: folded. Searching a back-box model shows it even while folded. → saw:
- [ ] **Accept all in a group.** On a small group (e.g. Touchscreen), tap `Accept all n`: a dialog asks "Accept all n drafts in Touchscreen?"; Cancel does nothing; Accept → the note says `Accepted n drafts in Touchscreen.`, the DRAFT flags go, the header's draft count drops by n. With a search typed first, the dialog's n is still the whole group's. Rejected has no Accept all. → saw:
- [ ] **Picker search.** On the scratch plan, long-press → + Device: the Type list shows at most 60 chips and `n more: type in the box below to narrow`. Type `acp`: the chips narrow to the matching types; tap one: it stays selected. Type a model that matches nothing: "No library type matches …" and the purple "New model … as a draft" line (D55). → saw:

Decision D203 (Proposed): (1) search = every word in model / alias / display name; (2) groups = category, then accessories, then rejected, one chip per group, Drafts only; (3) accessories folded unless chip, search or tap; (4) Accept all = the whole group's drafts after a confirm, one group of per-type accepts, not offered on Rejected; (5) the picker's model box doubles as its search, 60 chips shown; (6) virtualised list. → Approve / change:

---

## T115 — BOM and riser drafts by role  ·  Needs: no new build (JS update; server deploy first — Alembic 0013 adds `draft_device.role`; every iPad on the new JS before the next upload, an older iPad refuses the new column on pull until it updates, nothing lost)

**Why it matters:** the extractions wrote the master's old category names (`Relay panel`, `NSPS`…) into drafts and matched trunk labels by them; with the D196 categories and the catalogue types those names no longer say what a device is. Drafts now carry a role and the new category.

Set-up: a **scratch** project with levels B2–06 / 06M and the DaVinci types copied; upload `BOM.pdf`, then `riser.pdf` (Setup → Imports).

- [ ] **New categories in Review drafts.** Devices tab, level 01: the relay panels read `Power Distribution`, the rack `Equipment Panels`, the EBDKs `Emergency Equipment`, the stations / sensors / touchscreen as before; no draft shows `Relay panel`, `NSPS` or `Equipment rack`. A pooled NSPS reads `Equipment`. → saw:
- [ ] **Trunk ends still resolve.** Cables tab, level 01: an `F` run labelled `TO EQUIP RACK LEVEL 06` has its far end on the 06M rack draft (or the rack device) as before T115; a DMX run `TO RELAY PANEL LEVEL nn` names that level's relay panel. → saw:
- [ ] **Edit sets the role.** Edit… a station draft, change its category to `Sensor`, Save & accept: it reads `Sensor`; nothing else on the row changes. → saw:

Decision D204 (Proposed): (1) `draft_device.role` written by both extractions, every riser check by role; (2) the library type's role and canonical category first, else the model rule and the rename table's category; (3) the riser schema asks for the role only (the API's 16-union limit); (4) draft review matches the master's device by role; a hand-picked category sets the role it names; (5) placement (T46) takes the type and role from `typeForDraft`. → Approve / change:

## T46 — Place devices from the unplaced list  ·  Needs: no new build (JS update; no server change)

**Why it matters:** setup ends with every device on its plan. Devices from the master and units of accepted drafts had no way onto the plan except one by one from the card; Landry could not tell what was unplaced without scrolling the whole list (M3 round A-4).

Set-up: the T115 **scratch** project, with its BOM / riser drafts reviewed (some accepted in Review drafts) and 06M's composite uploaded as the display sheet (Setup → Sources → Floor plans), downloaded on this iPad.

- [ ] **Setup → 5 Place devices.** The step is live: one row per in-scope level with Placed n/m, Not on plan, From drafts, Flagged, and Place ▸ (Open plan ▸ when nothing is left). A line under the table counts the pool when it has units. → saw:
- [ ] **Place ▸ opens the panel.** Tap Place ▸ on 06M: the plan opens with "Place devices — 06M" in the side panel, the banner "Pick a device in the list…", chips `06M n · Pool n · Flagged n` and type chips. A master device without a pin is listed by its ID (`06M-04 · CT06LCPA`, "in the baseline"); an accepted draft that the master already has (same panel tag or model) is **not** listed a second time. → saw:
- [ ] **Dashed proposals.** On 06M, CT06LCPA / CT06LCPB / EBDK / UFMP8 that are unplaced show as grey dashed pins with "?" at their printed tags; the note above the list counts them. Tap one: its row is selected and the confirm form opens with that spot (grey "+"). → saw:
- [ ] **Tap to place.** Select a row, tap the plan: the grey "+" appears there and the form shows ID (`06M-04`, or `06M-?` NEW "numbered by the server"), Panel tag (panels only), Drawing Position and Room filled from the grid and the nearest room. Tap the plan again: the "+" moves and the untouched fields follow; a field you typed in keeps your text. Place ✓: the pin appears in its status colour, the row leaves the list, "Placed n of m" goes up. → saw:
- [ ] **Drag to place.** Select a row, drag "⠿ Drag onto the plan" over the plan: a blue ring follows the finger over the plan; let go: the "+" is where you let go and the form opens. Let go over the side panel: nothing changes. → saw:
- [ ] **A draft unit becomes a device.** Place a unit of an accepted draft (e.g. a sensor ×n on a level): the new device's card shows its model, the category, `06M-?` NEW until the next sync, then a server number; the draft's row reads one fewer (×n-1). → saw:
- [ ] **The pool.** On another level, Pool chip: a pooled station `PI1002 · pool ×n`. Place one: it lands on this level and the pool reads ×n-1 on every level's panel. → saw:
- [ ] **Waiting cables.** Place a draft device that an accepted cable draft was waiting on (Review drafts → Cables showed "Make n waiting cables"): the note says "1 waiting cable made"; the cable shows in the Cables view with both ends. → saw:
- [ ] **Flag not on this sheet.** Select a draft row (no spot yet), tap "Flag: not on this sheet ⊗": it leaves the list; Flagged chip shows it; Setup → 5 and the Lock table count it. Select it in Flagged, "Unflag: back on the list": it returns. → saw:
- [ ] **Lock table columns.** Setup → 6 Lock baseline shows Placed (with "+n" for draft units still to place), Drafts (unreviewed), Flagged, Cables ⚑ (cables not endpoint-confirmed) and In review. Lock a level that still has unreviewed drafts: the dialog names "n unreviewed drafts" (and "n draft devices to place"). → saw:
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

## T96 — Manual grid calibration previews the bubbles in between  ·  Needs: no new build (JS update)

**Why it matters:** in the close-out round (D-6) a hand calibration showed only the three tapped bubbles, so a wrong tap or label only showed after Finish, when pins read the wrong Drawing Position.

Set-up: any sheet with lettered and numbered grid bubbles (06M on the Tower round project, or the demo plan), plan open, **⌗ Grid** → **Recalibrate: tap three bubbles**.

- [ ] **Two taps, the bubbles in between.** Tap bubble A, label it `A`; tap bubble H, label it `H`: dashed rings in the new set's colour appear on the printed B … G bubbles (at both ends of each grid line where the sheet prints two), while A and H keep their solid rings. The panel shows the "Dashed rings" line. → saw:
- [ ] **Third tap, the other axis.** Tap a row bubble (9), label it `9`: dashed rings appear on its neighbours (12 … 6), on the printed bubbles where they line up. → saw:
- [ ] **A wrong label shows.** **Undo tap** twice (back to A only), tap H again but label it `G`: the dashed B … F rings drift off the printed bubbles (C … F sit between printed bubbles rather than on them). **Undo tap**, re-tap H as `H`: the rings snap back onto the bubbles. → saw:
- [ ] **Finish unchanged.** Finish: the set is saved as before (columns A–H, rows 12–6 on the set row), the dashed rings are gone and only the tapped bubbles show in the saved set's colour; **Test** on a point reads the same Drawing Position as before T96. Cancel instead: the dashed rings go with the taps. → saw:
- [ ] **Smooth while panning.** With the dashed rings showing, pinch and pan: the rings stay on their bubbles every frame (no lag, no flicker). → saw:

## T97 — Assign levels to people  ·  Needs: no new build (JS update; no server change)

**Why it matters:** in the close-out round (C-2) there was no way to assign a level, so "Assigned to me", the ● on the Levels screen and Download assigned levels could not be tried.

Set-up: two iPads under two team names (say Landry and Ann), both synced, the Tower round project with B2, 06, 06M in scope.

- [ ] **The tab.** Projects → Setup: below *6 Lock baseline*, after a rule, **Assignments**. It shows the levels down the side (out-of-scope ones dimmed, "out of scope"), one column per team name (yours marked "(you)"), ☐ in every cell and "nobody" under each in-scope level. → saw:
- [ ] **Assign, several per level.** On Landry's iPad tap 06 × Ann and 06 × Landry, then 06M × Ann: those cells turn ☑ on blue; "nobody" goes from 06 and 06M. Tap 06 × Landry again: back to ☐. Works in airplane mode too. → saw:
- [ ] **All in scope / None.** Under Landry's column tap **All in scope**: "Landry: 3 levels added" (B2, 06, 06M; never the out-of-scope ones). Tap **None**: "Landry: 3 levels removed". → saw:
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
- [ ] **App-level defaults.** Projects → **Rule defaults**: the same list with "A change is a draft until accepted". Set R3b → Owner `ETC`: the row shows `draft` with **Accept** / **Reject**; tap **Accept**. Create a throw-away project (New project, copy from nothing): its Rules tab shows R3b Owner `ETC` changed; the Tower project's Rules still say `EC/ETC`. Reset the default afterwards (and Accept), delete nothing. → saw:
- [ ] **Copy from.** New project with **Copy from** the throw-away project and **Rule settings** ticked: its Rules match the source's. → saw:

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
- [ ] **No second kit after the pull.** On that run, close the Run item and set the end `Issue`, note "Run, not terminated; no term kit": the "Terminate DMX to …" kit-item draft appears; accept it. No new kit draft appears for that end. → saw:
- [ ] **A placeholder far end gets one kit.** Accept a "Run DMX to <fixtures>" draft (far end Fixtures or a spare): only one kit draft, on the device. → saw:
- [ ] **Per cable.** Open a DMX connection → **Termination kits**: "As X (yes)" is selected. Tap **No**: its open kit drafts go away after the rules run, and a "no term kit" note on it is now flagged in Lint. Tap **As X (yes)**: they come back. Set a Unison cable to **Yes** and give an end "Run, not terminated; no term kit": a "Terminate Unison to …" kit item is offered. Put both back. → saw:
- [ ] **Per code.** In Rules turn `N` off: the network kit drafts go away, and a network kit part already on the list is flagged "Network termination kits are not parts" in Lint. Turn it back on. → saw:
- [ ] **Second iPad.** With a second iPad on the project, set a cable's Termination kits on one and sync both: the other shows the same choice, and its drafts follow after its rules run. → saw:

Decision D213: kits per cable code (`X`, `F`, `N`, `NG` on by default) with a per-cable Yes / No; one kit at each **device** end on an in-scope floor (none for Fixtures, spares or out-of-scope floors; the far end waits for its floor's survey); the far end's kit is sourced to its connection, not the Run item (whose number belongs to the other floor); a network kit is a part wherever kits are on; imported kits with no connection are matched to a run by their text. → Approve / change:

## T104 — Vocabulary follow-ups: model map, level aliases, device types, pin shapes, app-level vocabulary  ·  Needs: no new build (JS update; server deploy first — Alembic 0017 lets `vocab` rows have no project; **every iPad on the new JS before anyone edits the app library's vocabulary or a pin shape**, an older iPad refuses those ops on pull until it updates, nothing lost)

**Why it matters:** the BOM import reads the model map and level aliases, the card's Type now has chips, pin shapes can follow how Landry wants the floor to read, and values Landry trusts can be offered to every new project.

- [ ] **Model map.** Vocabulary → **Model map & levels** → Model map: type `P-DOC-W-WD` → `P-DOC-W`, Add. It shows as `Model: P-DOC-W  draft` with `← P-DOC-W-WD  draft` under it. Add `P-DOC-W-4Z` → `p-doc-w`: it joins the same model (no second `P-DOC-W`). Adding `p-doc-w-wd` again is refused ("already in this list"). → saw:
- [ ] **Level aliases.** Same tab → Level aliases: `Level 5` → `06M`, Add; Accept both rows. → saw:
- [ ] **Remove a model.** Remove `P-DOC-W`: its spellings go with it. → saw:
- [ ] **Device types and the card.** Lists → **Device types**: add `Echo relay panel`, Accept. Open a device's card → **Type** → Edit…: the chip `Echo relay panel` is under the box; tap it, Save. The card's header shows the new type; the pin's label (Labels layer) shows it too; History has the change as Field survey. → saw:
- [ ] **Pin shapes.** Vocabulary → **Pin shapes**: nine roles, each with nine shape chips, the current one highlighted. Give **Station** the **Square**: the line says "shares its shape with another role" on Relay panel and Station. Open a plan with stations: their pins are squares, fill colours unchanged. Put Station back to **Circle**. → saw:
- [ ] **Pin shapes on the floor PDF.** With Station set to Square, export a floor PDF of a level with stations: the cover sheet and the crops draw stations as squares. Put it back. → saw:
- [ ] **Pin shapes on a second iPad.** Change a shape on one iPad and sync both: the other iPad's plan shows the new shape after its sync, with no project-level setting anywhere. → saw:
- [ ] **App library vocabulary.** Vocabulary → **App library** → Lists: add a device note `Stuck buttons`: it shows `draft`. **Load standard lists** here: "Added n drafts to the app library"; no Placeholders tab in this scope. Back in **This project**, the note is not in the project's list. → saw:
- [ ] **Promote.** In **This project**, an accepted value shows **Promote**; tap it on a model-map spelling: the App library's Model map now has the model and that spelling as drafts. Promote it again: "The app library already has …". → saw:
- [ ] **Copy from app library.** In the App library accept the promoted model and spelling. On another project → Vocabulary → **Copy from app library**: "Copied n values"; they are accepted there; tapping it again copies nothing. A new project made from Projects → New gets the accepted app values too. → saw:

Decision D214: app-level vocabulary is `vocab` with no project on the library stream (drafts for Landry; new projects and "Copy from app library" take the accepted ones; a project reads only its own rows), and pin shapes are one app-library setting per role that applies to every project at once, on the iPad and in the floor PDF (no per-project shapes, no draft). → Approve / change:

## T116 — Rules tab: review accepted items after a change  ·  Needs: no new build (JS update only)

**Why it matters:** a changed owner or wording follows on open drafts but leaves accepted items as they were (D176). The Rules tab now offers a ruling, already filled in, for the accepted items the change words differently, so the punch list can be brought in line without hunting for them.

- [ ] **The offer.** On a level with at least one accepted "Run DMX to …" item, in Setup → Rules → R3a → **Run item owner**, set *Any other code* to `ETC`. Under the "saved" notice a yellow box lists **Review accepted items ▸  n punch items: Owner → "ETC"**, n = the accepted Run items still reading `EC`. → saw:
- [ ] **The pre-filled ruling.** Tap it: Rulings opens on the editor with Punch item · n chosen records, the level(s) as scope, **Set field Owner = ETC** and the reason "Rule parameter R3a · … changed: accepted items reworded to match". Preview: one row per item, `EC` → `ETC`. Untick one, Apply. The items read `ETC` on the plan; History shows the change as Ruling with that reason. → saw:
- [ ] **What is left.** Back in Setup → Rules: the box now lists only the item you unticked (1 punch item). → saw:
- [ ] **Hand edits stay out.** Change one accepted Run item's Owner by hand to `EC/ETC`, then in Rules set *Any other code* back with **Reset to default**: that item is not in the box's count. → saw:
- [ ] **A wording change.** Set R3a → **Run item text** *Any other code* to `Pull <signal> to <far end>`: the box lists one entry per item ("1 punch item: Item → "Pull DMX to …""), at most 8 and "+n more". Reset to default afterwards. → saw:

Decision D215: accepted items are only changed by a ruling you apply; the Rules tab offers one pre-filled ruling per (field, new value) over the accepted items the change words differently, leaving out fields someone changed by hand; a wording with the far end in it means one ruling per item until a "reword" ruling action exists (T120). → Approve / change:

## T117 — Cable codes beyond the master's in the library and the Cable / riser view  ·  Needs: no new build (JS update only)

**Why it matters:** a project can add a cable code by giving it a signal word in Rules (T102); until now the library's cable picker, the device card's "+ add" offers and the Cable / riser view still knew only the master's ten, so the new code could not be put on a type and showed as an error.

- [ ] **D is a code.** Open Cable / riser on a project with a `D` (DALI) cable (add one on a device card if there is none): it shows as `D (DALI)` with no "not a cable code" check. → saw:
- [ ] **A new code.** In Setup → Rules → **Signal words**, add code `DX` with the word `DALI-2`. Open Library, pick a type, + add cable: the code chips end with `… 120V · D · DX`. Pick `DX`, To `DALI-2 bus`, Save — it saves (no "not a cable code"). → saw:
- [ ] **The card and the cable view.** Put that run in the type's optional cables; on a device of the type the card offers "+ add DX → …". Add it: in Cable / riser it is grouped as `DX (DALI-2)` after D, the filter chips include `DX`, and it has no code check. → saw:
- [ ] **Suggestions.** Library → Suggestions → Cable code lists `DX` as well. → saw:
- [ ] **Scoped to the project.** On another project (no `DX` word), the Library's code chips stop at `D`. → saw:

Decision D216: a scope's cable codes are the master's ten plus every code its own accepted Rules give a signal word; the app library reads its own accepted rule parameters; a project skips a library run whose code it does not name; the Cable / riser view names a project code by its signal word. → Approve / change:

## T118 — Suggestion chips follow the termination-kit setting  ·  Needs: no new build (JS update only)

**Why it matters:** since T103 the project decides which cable codes take termination kits; the chips still offered "; no term kit" on DMX only and never let a network cable have a Part chip, so they contradicted the Rules tab.

- [ ] **Kit Note on fiber and network.** Open an `F` (or `N`) connection's end editor: the Note chips include "Run, not terminated; no term kit". On a `U` or `120V` end they do not. → saw:
- [ ] **Kit Part chip.** On a device card with a draft kit part on a DMX / network end, tap the Part field: a "DMX termination kit" / "Network termination kit" chip is offered. → saw:
- [ ] **Turning network kits off.** Setup → Rules → R4b **Takes termination kits**: turn `N` off. The `N` end editor stops offering "; no term kit"; Library → Suggestions → Cable code `N` shows no Part group and "+ add" as Part is refused with the R4 message. Turn it back on and both return. → saw:
- [ ] **One cable's own setting.** On an `N` cable with the code's kits off, set its Termination kits to **Yes**: its end editor offers "; no term kit" again; set **No** on a DMX cable: its end editor no longer does. → saw:

Decision D217: kit chips are computed from `R4b.kit` (and a cable's own Termination kits), not seeded; a code that takes kits offers "Run, not terminated; no term kit" and its kit Part chip (from the R4b Part text); a cable that takes none offers no "no term kit" Note; a network code offers Part chips only where its kits are on. → Approve / change:

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
