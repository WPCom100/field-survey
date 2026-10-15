# On-device checklist

Things only an iPad can prove. Each finished task adds its checks here; you test several features in one session; then say **"tested"** with the results and Claude archives this list to [on-device-log.md](on-device-log.md) and resets it. How the file is kept: see "Rules for this file" at the bottom.

## Before you start (once per round)

1. **Which build?** Check each task's "Needs" line. If any pending task says *new dev build*, run `eas build --profile development --platform ios` and install it first. Otherwise the dev build already on the iPad works.
2. **Load the latest JS.** On the PC: `git pull`, then `cd app && npx expo start --dev-client`. Open the app on the iPad and let it load from Metro (same Wi-Fi).
   **TestFlight iPads** (from build 13 on, T84) get the latest published JS by **launching the app twice**: open it, swipe it away from the app switcher, open it again. The Sync screen's Install section then shows `update <id> · <date> · T<nn>: …` instead of `embedded`.
3. **Logs.** In the Metro terminal press `j` to open React Native DevTools; app logs appear there, not in the terminal.
4. **Mark results as you go.** Tick `[x]` for pass. For a fail, leave it `[ ]` and write what you saw after "→ saw:". Then paste this file back to Claude.

Pending round started: **2026-10-14**. The M3 close-out round of 2026-10-14 is complete and archived in [on-device-log.md](on-device-log.md): 64 pass, 3 fail, 9 skip, 1 not done. **Part A passed in full** (three review items, nothing lost). Its fails became **T91** (no Surveyed field in Setup → Levels — the last M4 gate item), **T92** (the long-press menu waits for a move) and **T93** / **T94** (export status and speed at TP-3 size); your notes became **T95** (both end devices in a connection search), **T96** (preview the in-between grid bubbles) and **T97** (assign levels). Every decision on the sheet was accepted. What passed has left this file; what is below was skipped, not done, or failed and waits for its fix. New tasks add their checks below.

**This round's build:** still dev build `ddf99272` (T69 + T70); opening a plan must log `[plan] pdf native patch: t70 ink,longpress-move`. T92 may change the native patch; if it does, its section names the new build. **Server and JS:** every green push to `main` deploys the server and publishes the update (T85); `curl -s https://survey.wpcom.cloud/health` shows what runs.

---

## T70 — Long-press feel  ·  Needs: the dev build named by T92 (re-run after T92)

**Why it matters:** placing a device or a note exactly on the drawing is the point of the long press; the spot must be adjustable before choosing.

Failed 2026-10-14 (close-out D-15): "The menu does not pop up till the holding finger is moved." → **T92**. Run these again once T92 is done.

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

## T32 — TP-3 export  ·  Needs: no new build; re-run after T93 and T94

Failed 2026-10-14 (close-out G-4): over 5 minutes, no status, the card lost on leaving the screen. Every other TP-3 step passed (`docs/perf/tp3.md` §3).

- [ ] **Export.** "TP-3 synthetic" → Export → Generate workbook (all levels, all tabs): time from Generate until Ready under 5 minutes? Open it in Excel from the share sheet. → saw:

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

---

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
