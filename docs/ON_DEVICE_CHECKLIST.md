# On-device checklist

Things only an iPad can prove. Each finished task adds its checks here; you test several features in one session; then say **"tested"** with the results and Claude archives this list to [on-device-log.md](on-device-log.md) and resets it. How the file is kept: see "Rules for this file" at the bottom.

## Before you start (once per round)

1. **Which build?** Check each task's "Needs" line. If any pending task says *new dev build*, run `eas build --profile development --platform ios` and install it first. Otherwise the dev build already on the iPad works.
2. **Load the latest JS.** On the PC: `git pull`, then `cd app && npx expo start --dev-client`. Open the app on the iPad and let it load from Metro (same Wi-Fi).
3. **Logs.** In the Metro terminal press `j` to open React Native DevTools; app logs appear there, not in the terminal.
4. **Mark results as you go.** Tick `[x]` for pass. For a fail, leave it `[ ]` and write what you saw after "→ saw:". Then paste this file back to Claude.

Pending round started: **2026-10-11**. Items: T41 (new), T25, T26, T20–T24 (carried over, never recorded as tested). A first pass on 2026-10-11 stopped early at T25/T20-1 (results in [on-device-log.md](on-device-log.md)); the steps below were corrected from it. **Most of T25, all of T26 and the "real level" steps need a project on the iPad, which arrives with T41** — until then they are skipped, not failed.

---

## T41 — Projects and levels  ·  Needs: no new build (JS only; the server on the Droplet must be updated first — see the T41 deploy note in TASKS.md)

**Why it matters:** this is how a project reaches an iPad at all. Until now nothing on the iPad could sync; after this round the Tower project exists on the server and every other pending check ("real level only") becomes possible.

Do this **first** in the round, online.

- [ ] **Projects screen.** Sidebar → **Projects** (new entry at the top). With nothing on the iPad it says so and offers "Refresh from server" and "+ New project". → saw:
- [ ] **Create a scratch project.** **+ New project**: name "Scratch", site anything, ETC prefilled "ETC Field Service", copy-from left at "Nothing (app library only)". Levels: Add level `b2` → shows `B2`; Add level `06`; Add level `6m` → `06M`, set "Shares numbering with" = 06 and "Split of" = 06; **Add range** `09-12` → four rows out of scope (switch off). Move 06M below 06 with ↑↓ if needed. **Create project** → within a few seconds you land on the Levels screen showing Scratch with 7 levels, B2 … 12, the four range levels greyed "out of scope". → saw:
- [ ] **It came by sync, not by magic.** Sync screen: "Last successful sync" shows a seq ≥ 12 (project + groups + levels). Airplane mode on, kill and relaunch the app: Scratch and its levels are still there (they are in the local store). → saw:
- [ ] **Setup screen, offline.** Still in airplane mode: sidebar **Setup** → "2 Levels" table shows #, Code, In scope, Numbering group (06 and 06M read `06/06M ◀ shared`), Split of (06M → 06), Display sheet "(none yet)". Toggle 09 In scope on → row un-greys. **Share with…** on 10 → pick 09 → 10 reads `09/10 ◀ shared`; **Separate** on 10 → `10` again. Add level `13` with "Split of" 12 → it lands right after 12. Each action adds a pending edit in the top bar ("Offline · n pending"). → saw:
- [ ] **Project fields, offline.** "1 Project": change the disclaimer, tap elsewhere → "Saved" and one more pending edit. Leave and reopen Setup: the change is there. → saw:
- [ ] **It syncs.** Airplane mode off → the pending count drops to 0. On a **second iPad** (or after Re-sign-in with the data kept), Projects → Refresh from server → Scratch appears "downloading…" and then opens with the edited levels and disclaimer. → saw:
- [ ] **Numbering group is fixed once used.** On any level of Scratch, long-press the plan… there is no plan yet, so instead: on the Tower project (below), a level with devices shows "n records" under its code and its **Share with…** / **Separate** buttons are greyed. → saw:
- [ ] **The Tower project.** Create "Houston Methodist Centennial Tower" the same way with levels B2, B1, 01, 02, 03, 04, 06, 06M (shares with 06, split of 06), then Add range 09-12 out of scope. Then Landry runs the seed import on the Droplet (TASKS.md T27 deploy note, now with this project's id from the Projects screen or `GET /projects`), and the next sync brings 210 devices etc. → saw:
- [ ] **Decision D127 is Proposed** (projects as ops, levels edited by ops, numbering group frozen once a level has records, app library always copied, seed CLI gone): approve or change.

---

## T25 — Sync & uploads screen  ·  Needs: no new build (JS only)

**Why it matters:** this is the screen you will open in the field when something seems stuck. It must tell you the truth about what has and has not reached the server, and never block editing.

Open it from the sidebar on the Levels screen: **Sync**.

- [ ] **Screen opens and reads sensibly.** You should see eight sections: Connection, Pending edits, Photos waiting, Review items, Cached levels, Storage, Install, plus the hint line about cellular. → saw:
- [ ] **Sync now.** Online, tap **Sync now**. The Connection line should read "Online · Synced hh:mm" and "Last successful sync" shows today's time and a seq number. → saw:
- [ ] **Airplane mode shows offline.** Turn on airplane mode, wait up to a minute or tap **Sync now**. Connection must read "Not connected · Offline" (the server is asked even when there is no project on the iPad; fixed 2026-10-11). → saw:
- [ ] **Airplane mode, pending edits — real level only.** Still offline, on a *real* level make two edits (set a status, add a note), return to **Sync**. **Pending edits** must show 2 (or more) with an "oldest" time and the top bar "Offline · n pending". The demo plan never counts here: it lives in its own never-synced database (D101). → saw:
- [ ] **Come back online.** Turn airplane mode off, tap **Sync now**. Pending edits drops to 0 and the time updates. → saw:
- [ ] **Cached levels — real level only.** Level chips show ✓ (plan on the iPad), … (downloading) or ⬇ (not downloaded). Tap **Download assigned levels**; the message says how many files were queued (or that nothing was), and a ⬇ chip for one of *your* assigned levels turns … then ✓. With no project on the iPad the button is greyed out and the section says so. → saw:
- [ ] **Storage numbers.** Photos / plans / other show non-zero sizes after you have taken photos and cached a plan. → saw:
- [ ] **Free uploaded photos.** Only after a photo has uploaded (↑ cleared). The button shows how many MB it would free. Tap it, confirm, and the number drops to 0. Open that photo on a card: the full-size image should download again (needs network); the thumbnail is still there offline. → saw:
- [ ] **Retry failed uploads.** Normally the button is greyed out. If any upload ever shows a red "Upload failed" line, tap Retry and note whether it clears. Skip if nothing has failed. → saw:
- [ ] **Install section.** Shows your name, `app 1.0.0 (build number)`, the server URL and an 8-character install id. Confirm the build number matches the latest TestFlight/dev build. → saw:
- [ ] **Export local log.** Tap it. The iOS share sheet should open with a log file; AirDrop or save it to Files, open it, and confirm it has lines like `[sync] …` with times. → saw:
- [ ] **Re-sign in.** Tap, confirm. You should land on the Connect screen. Re-enter the server and token, pick your name. Your earlier edits must still be there and any unsynced ones must still sync. **Do this last in the round**, since it takes a minute. → saw:

---

## T26 — Needs review screen  ·  Needs: no new build (JS only)

**Why it matters:** two people editing the same thing offline is normal here. This screen is where you settle it; nothing is overwritten until someone picks, and the pick must reach every iPad.

You need a conflict first. It takes **two iPads with different team names** (the same name on two iPads never conflicts, D37), both on a real level and synced:
1. Turn on airplane mode on both. On iPad 1 type a note on a device (e.g. "Cover plate loose"); on iPad 2 type a different note on the same device ("LVD card missing").
2. Airplane mode off on iPad 1 → Sync now. Then iPad 2 → Sync now. Then iPad 1 → Sync now again.
3. For the pin check: repeat with **[⋯] → Move pin** on the same device, to two different spots.

- [ ] **Badges.** On both iPads the device's Notes field has the amber outline, its list row shows IN REVIEW, and its pin has an **amber ring**. The Levels row's Review column shows `IN REVIEW 1`. → saw:
- [ ] **Open the screen.** Sidebar → **Needs review** (also Sync → "Open Needs review →"). Title "Needs review (1)", tabs All / Sync conflict 1 / Extraction 0 / Source conflict 0 / Import pair 0, a Level chip for your level, Sort toggle. The row reads "<device> · Notes", "sync conflict · <level> · <date>". → saw:
- [ ] **A/B panel.** A (official now, first to arrive) and B side by side, each with the person's name, date/time and the iPad ("this iPad" on the iPad that made it). Under them "was: …" shows the note before both edits. → saw:
- [ ] **Combine.** Tap **Combine ▸**: the box is pre-filled "A; B" (A first). Edit it, tap **Save combined**: a confirmation shows the reason "Review: combined A (…) and B (…)". Tap Resolve. The row disappears and the device's note is the combined text. → saw:
- [ ] **Badges clear on the other iPad after its sync.** On the other iPad, Sync now: the amber outline, IN REVIEW chip and amber ring are gone and the note is the combined text. → saw:
- [ ] **No Dismiss.** A sync conflict has only Choose A / Choose B / Combine (and Set value for a number field). There is no Dismiss button. → saw:
- [ ] **Pin conflict on the plan.** With the Move-pin conflict, the panel shows "Resolve on the plan ▸". Tap it: the plan opens framed on **two pins, A solid and B dashed with a "B"**, not merged into a cluster, and a bar "Pin conflict on <ID>" with **Choose A / Choose B**. Pinch out: neither pin joins a cluster. Tap **Choose B**: a confirmation shows "Review: chose B (…) over A (…)"; tap Resolve and you are back on Needs review with the item gone. The pin now sits at B on both iPads after they sync. → saw:
- [ ] **Context link.** On any item, "Context: open the device card on the plan ▸" opens the level with that device's card. → saw:
- [ ] **Decision D123 is Proposed** (confirmation before each choice, iPad shown by id tail, other kinds read-only, pin conflicts on the plan, amber ring): approve or change.

---

## Carried over: T20 — Device card edits  ·  Needs: no new build

Not yet recorded as tested. Open **Demo plan (06M composite)** from the Levels sidebar (it seeds sample devices on first open), then tap pin **06M-01**.

- [ ] **Status taps.** Tap a status; the pin recolours at once and the card's History gains a line. This proves the edit is applied immediately, not after a sync. On the demo the line stays marked unsynced (↑): the demo never syncs, by design. → saw:
- [ ] **Notes save on leaving the field.** Type a note, tap elsewhere → exactly one ↑ (unsynced) mark appears, not one per keystroke. → saw:
- [ ] **Chips and phrases.** Tap a standard-phrase chip; it appends to the note. → saw:
- [ ] **Neuron ID normalising.** Enter `00:a1:b2:c3:d4:e5` → it saves as `00A1B2C3D4E5`. Entering the same ID on 06M-02 warns "Already on 06M-01". → saw:
- [ ] **ERP-FT-LVD rule.** Entering `found 2` clears the "short" state, as designed. → saw:
- [ ] **Cross-record link.** On C-03, tap `06M-03 ▸`; it selects 06M-03. → saw:
- [ ] **Move pin.** `[⋯]` → Move pin → give a reason → tap the new spot → the pin moves. → saw:
- [ ] **Delete / Restore.** `[⋯]` → Delete → reason → card shows "Deleted" with a Restore button; Restore brings it back. → saw:
- [ ] **Keyboard.** While typing in Notes and Neuron ID, does the keyboard cover the field you are typing in (28 % side panel)? Say yes or no. → saw:
- [ ] **Decision D111 is Proposed:** reply "approve D111" or what to change.

## Carried over: T21 — Photos  ·  Needs: the T21–T24 dev build (`e11d5685…`, built 2026-10-10)

Do these on the demo (nothing uploads) and on a real level (photos upload).

- [ ] **Camera opens at once.** First time, allow camera access. → saw:
- [ ] **Shutter → caption → Save.** The card shows a thumbnail with ↑, and the top bar says "1 photo waiting". After it uploads (real level only), ↑ and the waiting count clear. → saw:
- [ ] **Library picker with a HEIC photo.** It saves as a normal JPEG. → saw:
- [ ] **Markup with the Pencil.** Pressing harder draws thicker lines. Try circle, arrow, text, erase, undo. Reopen the photo: the markup is there and a ✎ mark shows. → saw:
- [ ] **Links.** Link the photo to a punch item, then to C-03. → saw:
- [ ] **Resume after force-quit (T12, TP-2 manual part).** On a real level, take several photos, force-quit the app while they upload, relaunch: uploads finish and nothing is sent twice. Check the **Sync** screen (T25) for "Photos waiting" going to 0. → saw:
- [ ] **Decision D112 is Proposed:** approve or change.

## Carried over: T22 — Cable ends  ·  Needs: no new build beyond T17

On the demo, tap **06M-01**, then **C-03**.

- [ ] **C-03:** both ends shown, riser line shows ✓ (matches). → saw:
- [ ] **C-08:** other end reads "Fixtures" (a placeholder, 1 row). **Unison row:** riser line shows ≠. → saw:
- [ ] **Edit the far end.** Tap a status on the other end → shows "surveyed by <you>". Edit the To text → the riser line updates. → saw:
- [ ] **Jump to 06M-03** selects it on this plan. → saw:
- [ ] **Cross-level jump.** On C-11 "Jump to 07-01 (Level 07)" opens level 07 with "Plan not downloaded", the list, and 07-01's card; ◀ returns to 06M with the card. → saw:
- [ ] **Back navigation.** Conns tab row → end editor → ◀ Connections. → saw:
- [ ] **Keyboard over From/To boxes?** yes/no. → saw:
- [ ] **Decision D113 is Proposed** (especially point 2, editing the far end): approve or change.

## Carried over: T23 — Adding devices  ·  Needs: the T21–T24 dev build

- [ ] **Long-press on empty plan** → a menu appears next to your finger; lifting does not select anything. → saw:
- [ ] **+ Device** opens a form in the side panel with a grey + pin at the spot. → saw:
- [ ] **NSPS / P-NSPS-D · app → Add** → card `06M-?` marked NEW with +; pin shows + too. (`?` is correct: the server assigns the number, D118.) → saw:
- [ ] **Station / PI1002**, tag `s 41` → preview `06M-S41` → Add. Again with `41` → "already used" warning, still adds. → saw:
- [ ] **Typed model** `ERP-XYZ` on Relay panel → "New model … draft" → Add; a DRAFT type now appears in the picker. → saw:
- [ ] **Real level only:** after a sync, `06M-?` gets its real number. → saw:
- [ ] **Long-press a pin** → "+ Photo of <ID>". → saw:
- [ ] **Decision D114 is Proposed:** approve or change.

## Carried over: T24 — Plan ink  ·  Needs: the T21–T24 dev build

Demo plan → **✎ Ink**.

- [ ] **Pencil pressure:** pressing harder is thicker; a finger gives medium width; try highlighter. → saw:
- [ ] **T Note:** tap → type → Place. → saw:
- [ ] **Erase / Undo:** ⌫ erases only your own stroke; ↶ undoes. → saw:
- [ ] **Colours and widths** change as picked. → saw:
- [ ] **✋ Pan, then pinch/pan:** ink stays glued to the drawing while pinching (like the pins). → saw:
- [ ] **Done** shows "Saved". **Layers ▸ Ink** off/on toggles it. Leave the plan and return: ink is still there. → saw:
- [ ] **Long-press → ✎ Markup / + Note here** enter draw mode; **+ Photo here** away from a pin leaves a camera mark at that spot after Save. → saw:
- [ ] **Two iPads (or two team names), real level:** each sees the other's ink read-only after sync and cannot erase it. → saw:
- [ ] **Decision D115 is Proposed:** approve or change.

---

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
