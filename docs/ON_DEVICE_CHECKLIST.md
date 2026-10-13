# On-device checklist

Things only an iPad can prove. Each finished task adds its checks here; you test several features in one session; then say **"tested"** with the results and Claude archives this list to [on-device-log.md](on-device-log.md) and resets it. How the file is kept: see "Rules for this file" at the bottom.

## Before you start (once per round)

1. **Which build?** Check each task's "Needs" line. If any pending task says *new dev build*, run `eas build --profile development --platform ios` and install it first. Otherwise the dev build already on the iPad works.
2. **Load the latest JS.** On the PC: `git pull`, then `cd app && npx expo start --dev-client`. Open the app on the iPad and let it load from Metro (same Wi-Fi).
3. **Logs.** In the Metro terminal press `j` to open React Native DevTools; app logs appear there, not in the terminal.
4. **Mark results as you go.** Tick `[x]` for pass. For a fail, leave it `[ ]` and write what you saw after "→ saw:". Then paste this file back to Claude.

Pending round started: **2026-10-12 (second)**. The M3 round of 2026-10-12 stopped at the seed import (archived in [on-device-log.md](on-device-log.md)); every step below is still untested. **T80 fixed the upload error** (JS only, no new build): start with the T80 section below, then resume the M3 round sheet at A-2. Decisions D101–D107, D124, D126, D131–D133, D135 and D137 were approved on 2026-10-12; D136 and D139 were changed (D148, D149); D138 was approved after an explanation; D150 answers how a punch item naming a room exports. New tasks add their checks below.

**This round's build:** dev build `ddf99272` (T69 + T70), install from https://expo.dev/accounts/wpcom/projects/field-survey/builds/ddf99272-0e81-474c-8af7-2392c0232e81 before step 2. Every dev build reads `1.0.0 (6)` on the Sync screen, so check Metro instead: opening a plan must log `[plan] pdf native patch: t70 ink,longpress-move`. **Server:** the Droplet runs `2444a69` with migration 0005 (deployed 2026-10-12 evening, pre-migration dump `backups/pg/survey-2026-10-12T231434Z.dump`), so T29/T31/T59 exports, T75 and T45 plan sheets all have their server side. **TestFlight:** production build 8 (`41d313ab`, from `2444a69`) was submitted the same evening.

---

## T80 — Uploads work again ("Unsupported FormDataPart implementation")  ·  Needs: no new build (JS only)

**Why it matters:** the seed import and the plan sheet upload are how a project gets its devices and its floor plan; both stopped at A-2/A-3 of the M3 round with this error.

- [ ] **Seed import reads the workbook.** Setup → 3 Sources → Seed import → Choose workbook…, pick `Lighting_Control_Survey_Master_B2-06_4.xlsx`: "Reading the workbook…", then Checks and Column mapping appear. No "Unsupported FormDataPart implementation". Then continue with the T28 steps above. → saw:
- [ ] **Re-check sends the file again.** Change one mapping and tap Re-check with this mapping: the Checks refresh without an error (the file is read from the iPad a second time). → saw:
- [ ] **Plan sheet uploads.** Floor plans → 06M → Choose…, pick `Level_06M_-_Lighting_Composite_vector.pdf`: the job line reads Queued → Reading the sheet…, no error. Then continue with the T45 steps. → saw:

## T28 — Seed import from the iPad  ·  Needs: **new dev build** (adds `expo-document-picker`); the server must run this task's code (`POST /imports/preview`)

**Why it matters:** this is how the Tower's master workbook becomes the project's records without retyping, and the mapping step is what lets a differently-headed floor workbook in.

- [ ] **Open the step.** Projects → the Tower project → Setup → 3 Sources. "Seed import" shows Master workbook / Floor workbook buttons and Choose workbook…. → saw:
- [ ] **Pick from Files.** Put `Lighting_Control_Survey_Master_B2-06_4.xlsx` in iCloud Drive or On My iPad; Choose workbook… opens Files, only .xlsx can be picked. After picking, "Reading the workbook…" then Checks and Column mapping appear. → saw:
- [ ] **Pre-matched.** Checks list the floors, the rows per tab (Devices 210, Connections 107, …) and "Every column is matched."; the mapping pickers show the master's own headers. → saw:
- [ ] **Change a mapping.** Set one Devices field to "not in this workbook" or another header: the field name turns amber, the Checks line counts it unmatched; Re-check with this mapping keeps your choice. → saw:
- [ ] **Import and follow it.** Import master workbook: the Import card goes Queued → Importing… → Imported with review items, findings and unpaired ends; Open Needs review opens the list. Do this on a throw-away project: the Tower's devices appear after the next sync. → saw:
- [ ] **Same file twice.** Pick the same file again and import: "Already imported — … nothing changed". → saw:
- [ ] **Floor workbook.** Choose Floor workbook and pick one floor's workbook: "Floors in this file" names its floor(s) and the import completes the same way. Skip if none is at hand. → saw:
- [ ] **Offline.** Airplane mode on, Choose workbook…: a plain error line (no crash), the rest of the app unaffected. → saw:

Decision D135: answered 2026-10-12, **Approved**.

## T67 — Sync every 5 seconds  ·  Needs: no new build (JS only)

**Why it matters:** two people on one floor should see each other's changes within seconds, and the faster cycle must not make the plan or lists stutter.

- [ ] **Changes arrive in about 5 seconds.** Two iPads (or the iPad plus a change made on the server) on the Houston Methodist Hospital project: change a device note on one; on the other, open the same device's card. The note updates within about 5–10 seconds without tapping Sync now. → saw:
- [ ] **No flicker while idle.** Leave the Levels screen (and, once T71 lands, a level's lists) open for a minute with nobody editing. Nothing reloads, jumps or loses its scroll position every 5 seconds. → saw:
- [ ] **Offline still backs off.** Airplane mode on: the status bar turns Offline and stays calm (no rapid flashing); airplane mode off: it reads Synced again within a few seconds. → saw:

## T65 — A photo linked to several devices and connection ends  ·  Needs: no new build (JS only); the server must be on migration 0002

**Why it matters:** a photo often shows two panels or several cables side by side; it must show up on every one of them, and a photo taken from a connection must really be linked to that connection (the T21-5 fail).

- [ ] **Photo from a connection is linked to it.** Open a device with connections → tap a connection → 📷 Photo, take a picture: in the caption sheet the connection's chip is already ticked (✓). Save; back in the end editor, the end shows "Photos (1)" with the thumbnail; the other end of the cable does not. → saw:
- [ ] **Link several, nearest first.** Take a photo of a device that has other pins close to it on the plan: under Linked, its own connections come first, then the nearby devices (closest first) each followed by their connections, then its punch items. Tick two devices and one connection, Save. → saw:
- [ ] **Shown everywhere it is linked.** Open each linked device's card and the linked connection: the photo is in each Photos strip, showing only its number (and ✎ / ↑ marks) — no blue "🔗 …" line under it (D134, T73); its links show in the caption sheet's Linked picker. → saw:
- [ ] **Unlink.** Open the photo again, untick one device, Save: it disappears from that device's card only; the others keep it. On a second iPad (or after a sync) the same. → saw:
- [ ] **Imported multi-device photos.** On the Tower project, if a photo shows several devices in the master (`B1-01, B1-02`): note whether only the first device shows it (expected for data imported before T65; see TASKS follow-ups). → saw:

Decision D131: answered 2026-10-12, **Approved**.

## T66 — Setup and card form polish  ·  Needs: no new build (JS only)

**Why it matters:** setting up a project with 20 floors should be quick typing, not fighting the keyboard; the In scope switch must register every tap.

- [ ] **Add levels in a row.** Setup → 2 Levels (and + New project): tap Add level, type `07`, press Return: the level is added, the cursor stays in the field, the page scrolls so the field stays above the keyboard. Type `08`, Return, and so on. → saw:
- [ ] **No extra text.** No description under the Levels header; on 1 Project no "each field saves when you leave it" note. → saw:
- [ ] **Column help.** Under In scope, Numbering group (Shares numbering with on New project) and Split of there is one short grey line explaining each. → saw:
- [ ] **In scope taps.** Tap anywhere in the In scope cell (switch or the space around it) ten times: it flips every time; off shows "out of scope (far ends only)". → saw:
- [ ] **Neuron ID Save.** On a device card, Neuron ID → Type…: Save and Cancel are on the same line as the field, visible above the keyboard; Return saves a valid ID. → saw:

## T69 — Two-finger pan while drawing ink  ·  Needs: **new dev build** (native patch)

**Why it matters:** marking up a big floor means moving around while drawing; leaving draw mode just to pan was slow.

- [ ] **Draw with one finger and the Pencil.** On a level with a plan, ✎ Ink: a Pencil stroke draws with pressure (lighter = thinner); a finger stroke draws at medium width. There is no ✋ Pan button. → saw:
- [ ] **Two fingers pan and zoom.** Still in Ink, put two fingers down and drag: the plan pans; pinch: it zooms. Your ink, everyone's ink and the pins stay glued to the drawing during the move. Nothing is drawn by the two fingers. → saw:
- [ ] **Second finger cancels a stroke.** Start a stroke with one finger, then put a second finger down and pan: the half-drawn stroke disappears (not saved) and the plan pans. → saw:
- [ ] **No taps while drawing.** In Ink, tap a pin: no card opens (a dot or nothing is drawn); double-tap: no zoom; long-press: no add-here menu. Tap Done: tapping a pin opens its card again, double-tap and long-press work again. → saw:
- [ ] **Eraser and Note still work.** ⌫ Erase removes your stroke under the finger; T Note: tap the plan, type, Place. → saw:

Decision D132: answered 2026-10-12, **Approved**.

## T70 — Long-press feel  ·  Needs: **new dev build** (same build as T69)

**Why it matters:** placing a device or a note exactly on the drawing is the point of the long press; the spot must be adjustable before choosing.

Before these steps, in the Metro DevTools console after opening a plan: the line **`[plan] pdf native patch: t70 ink,longpress-move`** must appear. If it does not, the iPad is running an older build — install the new one from its build link and stop here.

- [ ] **Menu while the finger is down.** Long-press the plan and keep the finger down: the blue dot and the menu appear while the finger is still on the glass (Metro: `[plan] long press: began`). → saw:
- [ ] **Dot follows the finger.** Still holding, slide the finger: the dot follows; lift: it stays where you lifted (Metro: `lifted after n move event(s)`, n > 0). → saw:
- [ ] **Drag the dot after lifting.** With the menu open, drag the blue dot to a nearby spot (or onto a pin): it moves; the menu follows; "+ Photo of <device>" names the device now under the dot. Pick + Device: the grey "+" pin sits where the dot was dropped. → saw:
- [ ] **Pan still closes the menu.** With the menu open, pan the plan (away from the dot): the menu closes. → saw:

## T72 — Edit other people's ink  ·  Needs: the T69/T70 dev build; a level with a plan (T45) and two iPads or two team names

**Why it matters:** the floor's markup is shared work; anyone should be able to clean up or correct it without anyone's strokes getting lost when two people change it at once.

- [ ] **Erase someone else's stroke.** Ann draws, syncs; on Bob's iPad, Ink → ⌫ Erase → touch Ann's stroke: it disappears. After both sync it is gone on Ann's iPad too. → saw:
- [ ] **Recolour.** Bob: Ink → 🎨 Recolour, pick blue, touch one of Ann's strokes: it turns blue (and stays faded as Ann's). After sync Ann sees it blue. → saw:
- [ ] **Undo across layers.** Bob: erase one of Ann's strokes and one of his own, then ↶ Undo twice: both come back, in reverse order. → saw:
- [ ] **Both at once, online.** Ann draws new strokes while Bob erases one of Ann's older strokes, within a few seconds of each other: after both sync, Ann's new strokes are there and the erased one is gone, on both iPads. → saw:
- [ ] **Both offline.** Both iPads in airplane mode: Ann erases stroke X of her own layer, Bob recolours stroke Y of Ann's layer. Airplane mode off on both, wait ~10 s (two sync cycles): on both iPads X is gone and Y has the new colour (Metro may log `ink: merged 1 concurrent write(s)`). → saw:

Decision D133: answered 2026-10-12, **Approved**.

## T31 — Export screen and history  ·  Needs: no new build (JS only); **the server must run T29 + T31** (deploy and `alembic upgrade head` to 0003 first — until then the Export screen's requests fail)

**Why it matters:** this is how the master workbook reaches the EC, ETC and GC without anyone touching the PC, and the gate is what guarantees an export never misses an edit still sitting on an iPad (D94).

- [ ] **Open it.** Levels screen sidebar → Export. Three panes on the left: Master workbook, Floor PDF, History; the project name under "Export"; the sync line at the top. → saw:
- [ ] **Gate while edits are pending.** Airplane mode on, change a device note, open Export → Master workbook: the pre-flight counts "1 unsynced edit on this iPad", an amber line says Offline / Sync first, and Generate workbook is greyed out. → saw:
- [ ] **Sync first.** Airplane mode off, tap Sync first: the status turns "Synced hh:mm", the amber line turns green ("Synced — the export will include every edit…") and Generate workbook becomes active. → saw:
- [ ] **Levels and tabs.** Tap one level chip (e.g. 06M): "All in scope" turns off and row 2 reads "Levels 06-06"; tap All in scope again. Untick Photo Log: Summary and Lists stay ticked and cannot be unticked. → saw:
- [ ] **Generate and follow it.** Generate workbook (all levels, all tabs): the card goes Queued → Building the workbook… → Ready · ~1 MB with the filename `Lighting_Control_Survey_Master_B2-06_<n>.xlsx` and a diff line. → saw:
- [ ] **Open in Excel / Save to Files.** Tap Open in… / Share / Save to Files: the iOS share sheet shows the workbook; Save to Files saves it; Open in Excel (if installed) opens it with its tabs. "✓ on this iPad" appears on the card. → saw:
- [ ] **Diff vs previous.** Change one device's status, sync, Generate again: the new card says "Diff vs previous export: 1 changed ▸"; tapping it lists "Devices: +0 −0 ~1 (e.g. …)". → saw:
- [ ] **History.** History pane: every export newest first, each labelled "Exported <date>, <time>" with its levels/tabs and state; a daily backup (if one ran) says "daily backup". → saw:
- [ ] **Offline history.** Airplane mode on, History → Refresh: a note says it is showing the last list; an export marked "✓ on this iPad" still opens the share sheet; one not on the iPad shows an error when tapped (needs a connection), no crash. → saw:

Decision D140 (share sheet instead of `expo-sharing`, files kept on the iPad, photos still uploading warn but do not block the export): approve / change →
Decision D141 (tab choice: Summary and Lists always included, a Summary table dropped with its tab): approve / change →

## T32 — TP-3: a tower-sized project on the iPad  ·  Needs: no new build; **the synthetic project on the Droplet** (see the Decision line: it is created only after you say yes); the T29 + T31 server deploy for the export step

**Why it matters:** the Tower will reach about 2,000 devices and 10,000 photos; the app must still open a crowded floor quickly, scroll its lists and cache every thumbnail over Wi-Fi in reasonable time. Results go in `docs/perf/tp3.md` §3.

- [ ] **First sync.** Projects → Refresh → open "TP-3 synthetic". Time from opening it until the status bar reads "Synced": write the minutes. Editing stays possible meanwhile. → saw:
- [ ] **Open the crowded floor.** Levels → 06M (1,000 devices). From the tap until the pins are on the plan: under 3 seconds? → saw:
- [ ] **Scroll the lists.** On 06M, flick the Devices tab from top to bottom, then Conns and Punch: smooth, no blank rows that stay blank, no freeze. → saw:
- [ ] **Search.** Type `Run` in the search box: the lists narrow within a moment. → saw:
- [ ] **Prefetch on Wi-Fi.** Sync screen → Download assigned levels; note the time until downloads reach zero (10,000 thumbnails): under 10 minutes? → saw:
- [ ] **Export.** Export → Generate workbook (all levels, all tabs): time from Generate until Ready: under 5 minutes? Open it in Excel from the share sheet. → saw:
- [ ] **Memory (dev build only).** Perf Monitor after opening 06M and scrolling: RAM under 600 MB? → saw:

Decision D142 (synthetic project shape: half the devices on 06M, distinct thumbnails, no full-size photo bytes): approve / change →
Decision (TP-3 on the iPad): create the synthetic project "TP-3 synthetic" on the Droplet — about 110 MB of thumbnails in R2 and a permanent project, since projects cannot be deleted yet? yes / no →

## T59 — Floor PDF  ·  Needs: no new build (JS only); **the server rebuilt with T29 + T31 + T59** (`docker compose up -d --build` — the image gains Pango for WeasyPrint — and `alembic upgrade head` to 0003)

**Why it matters:** this is the per-floor report the EC, ETC and GC read; it must be dense (several findings per page), show the plan with everyone's markings, and carry the survey date but no company name.

- [ ] **Open the pane.** Export → Floor PDF: level chips (in-scope levels), six Include boxes all ticked, a header line "ETC Lighting Controls Survey — Level <NN> · Surveyed <date>". → saw:
- [ ] **Generate.** Pick a level with devices (e.g. 06M on the Tower), Generate PDF: the card goes Queued → Building the PDF… → Ready with `ETC_Lighting_Controls_Survey_Level_06M_1.pdf`. → saw:
- [ ] **Look at it.** Share sheet → open the PDF (Quick Look or Files): the cover has the status counts and the plan with pins shaped by category, coloured by status and labelled with the device type, and any ink you drew on the plan. → saw:
- [ ] **Findings are dense.** The Findings pages show about four devices per page, each with status | owner | category, notes, open punch items, thumbnails and a small plan crop with the device ringed. → saw:
- [ ] **Header and tables.** Every page after the cover has the header with the survey date only (no company name); Connections, Punch list and Missing parts tables match the workbook for that level. → saw:
- [ ] **Photos.** The appendix shows six photos per page with "Photo n — subject — device IDs", markups drawn on them. → saw:
- [ ] **Sections.** Untick Photo appendix and Connections, Generate again: the new PDF (`…_06M_2.pdf`) has neither; the History pane lists both PDFs with their sections. → saw:

Decision D143 (floor PDF: plan snapshot as an image with ink and type-labelled pins; findings = every device not Installed, untested, about four per page with a plan crop; photos six per page): approve / change →

## T75 — Refused edits are quarantined, the rest keeps syncing  ·  Needs: no new build (JS only); the Droplet on `alembic upgrade head` (0004, an index only)

**Why it matters:** one edit the server refuses must never stop every other edit on the iPad from syncing, and you must be able to see and retry it.

- [ ] **Nothing changes when all is well.** Sync screen → Pending edits: no "edits the server refused" line and no Retry refused edits button; the status bar reads as before. → saw:
- [ ] **A refused edit shows and the rest goes.** (Only if one happens: a refused edit cannot be provoked from the iPad on purpose.) If the status bar ever reads "· N need attention": the Sync screen lists each refused edit (what · when · tries · the server's error) with Retry refused edits, other edits made afterwards still reach the other iPad, and Retry sends the listed ones again. → saw:

Decision D145 (quarantine semantics: 422 → the named edit's group, 409 → narrowed by halving, Retry only, refused edits still count as pending so Export stays disabled) and D146 (index + per-push caches on the server): approve / change →

## Carried over: T41 — Projects and levels  ·  Needs: no new build

- [ ] **Second iPad pulls a project.** On a second iPad, or after Sync → Re-sign in with data kept: Projects → Refresh from server → Scratch shows "downloading…", then opens with its levels and disclaimer. → saw:

## Carried over: T25 — Sync & uploads screen  ·  Needs: T71 (a real level that opens); downloads also need T45

- [ ] **Pending edits on a real level.** Airplane mode on, on a Tower level make two edits (a status, a note), open Sync: Pending edits shows 2 or more with an "oldest" time; the top bar reads "Offline · n pending". (T71) → saw:
- [ ] **Download assigned levels with a plan.** Download assigned levels: the message says how many files were queued; ⬇ → … → ✓ for levels with a plan. (T45) → saw:
- [ ] **Storage numbers.** Photos / plans / other show non-zero sizes after photos and a cached plan. (T71, T45) → saw:
- [ ] **Free uploaded photos.** After a photo uploaded (↑ cleared): the button shows MB, confirm → 0; the thumbnail still shows offline, the full image downloads again online. (T71) → saw:
- [ ] **Retry failed uploads.** Greyed normally; if a red "Upload failed" line appears, Retry clears it. Skip if nothing failed. → saw:

## T71 — Open a level with no plan sheet  ·  Needs: no new build

- [ ] **Tap a Tower level with "No sheet"** on the Levels screen: the plan opens showing "No plan sheet yet…", the device list, cards, end editor and photos work. Why: the imported Tower levels had no way in, so the T21/T25/T26 checks above (marked T71) were skipped. → saw:

## Carried over: T26 — Needs review screen  ·  Needs: T71, two iPads with different team names on a real level

Make a conflict: both iPads in airplane mode, iPad 1 note "Cover plate loose", iPad 2 note "LVD card missing" on the same device; sync iPad 1, iPad 2, iPad 1. For the pin step, repeat with [⋯] → Move pin (needs a plan, T45).

- [ ] **Badges.** Notes amber outline, IN REVIEW on the row, amber ring on the pin; Levels row Review shows IN REVIEW 1. → saw:
- [ ] **Open the screen.** Sidebar → Needs review: "Needs review (1)", kind tabs, Level chip, Sort; row "<device> · Notes". → saw:
- [ ] **A/B panel.** A (official) and B with name, time, iPad; "was: …" below. → saw:
- [ ] **Combine.** Combine ▸ pre-filled "A; B", edit, Save combined, confirmation "Review: combined A (…) and B (…)", Resolve → row gone, note combined. → saw:
- [ ] **Badges clear on the other iPad** after its sync. → saw:
- [ ] **No Dismiss** on a sync conflict. → saw:
- [ ] **Pin conflict on the plan.** Resolve on the plan ▸: A solid, B dashed with "B", never clustered; Choose B → confirm → item gone; pin at B on both after sync. (T45) → saw:
- [ ] **Context link** opens the level with that device's card. → saw:

## Carried over: T20–T24 — field loop  ·  Needs: as noted per step

- [ ] **T21 · Upload resume.** On a real level take several photos, force-quit while they upload, relaunch: uploads finish, nothing sent twice; Sync shows Photos waiting → 0. (T71) → saw:
- [ ] **T23 · Real ID after sync.** On a real level with a plan, long-press → + Device, wait for a sync: `06M-?` becomes a real ID (`06M-49`, or `06M-S16` for a station). (T45) → saw:
- [ ] **T24 · Two people's ink.** Two team names or iPads on a real level with a plan: each draws, both sync; each sees the other's ink faded. (Erasing it is allowed since D129 — see T72.) (T45) → saw:

---

## T45 — Plan sheets upload and grid calibration  ·  Needs: no new build (JS only); **the server rebuilt with T45** (`docker compose up -d --build` — the image gains pdfplumber and pypdf — and `alembic upgrade head` to 0005); the iPad's local database migrates to 0006 on first open

**Why it matters:** this is how a level gets its floor plan: the composite goes up once, every iPad downloads it, pins and ink have a sheet to live on, and Drawing Position is read off the grid instead of typed. The 06M composite is the only real sheet we have; on the PC its three grids calibrate automatically — the iPad has to show the same.

- [ ] **Upload the 06M composite.** Projects → Houston Methodist (or a throw-away project with a 06M level) → Setup → 3 Sources → Floor plans: the 06M row shows "—" and Choose…. Put `Level_06M_-_Lighting_Composite_vector.pdf` in Files, Choose…, pick it. The job line reads Queued → Reading the sheet… → "Done: 1 sheet, 3 grid sets (3 auto) — arrives with the next sync" (about 15 s). → saw:
- [ ] **It arrives.** Within a sync or two the row shows the sheet's title, "(not downloaded yet)" until the blob queue fetches it (Sync screen: plans bytes grow), then the Grid column reads **auto ✓ 3 sets**. Open plan ▸ opens the level with the drawing. → saw:
- [ ] **No magenta.** On the plan the source-sheet boundaries are drawn by the app as thin dashed magenta lines with the sheet names (Ef.106.5.A…) — not baked into the drawing: Layers ▸ Boundaries (source sheets) off makes every magenta line disappear; on brings them back. (In the demo level the toggle stays disabled: its PDF is the original.) → saw:
- [ ] **Boundaries follow a pinch.** Pinch and pan: the dashed lines stay exactly on the drawing's sheet edges, same as pins and ink (D95), and stay 1–2 px wide at every zoom. → saw:
- [ ] **Grid panel.** ⌗ Grid (bottom right) opens Grid calibration — 06M in the side panel: three sets — A–H / 13.5–5 (● auto · residual 0.2 pt), A.–F. / 15.–5. (● auto), R.–K. / 16.–13. (+22°) (● auto · rotated 22°) — each with a name and a Prefix field; the plan shows every grid bubble ringed in the set's colour (blue, green, orange) exactly over the printed bubbles, including the rotated wing's K.–R. and 13.–16. → saw:
- [ ] **Test a point.** Test: tap a point → its Drawing Position, then tap between columns B and C and rows 9 and 8 of the Centennial grid: the panel reads **Grid B-C / 9-8**. Tap on the C line at row 9: **Grid C / 9**. Tap right of column H (still in the Centennial part): **Grid East of H / …**. Tap in the Walter Tower part: **Grid C.-D. / 7.-6.**-style with the dotted labels. Tap the title block: "Off every grid on this sheet". → saw:
- [ ] **Prefix.** Set the Walter Tower set's Prefix to `WT`, Save: a test tap there now reads **WT Grid C.-D. / 7.-6.**; after a sync a second iPad shows the same prefix. → saw:
- [ ] **Three-tap calibration.** Recalibrate: tap three bubbles → tap the A bubble at the top of the Centennial grid: the panel asks "Which bubble…? Printed there: A" with A pre-filled; Use. Tap H (pre-filled H), Use. Tap the 9 bubble at the left edge (pre-filled 9), Use. Finish is enabled; name it `Test` and Finish: a fourth set "Test" (● manual) appears, its bubbles drawn in purple, and a test tap between B and C still reads Grid B-C / 9-8 (the manual set and the auto set agree). Remove the Test set. → saw:
- [ ] **A wrong label is refused.** Recalibrate again, tap any bubble and type `OF` as its label: "…is not a grid label." Tap three letter bubbles only and Finish: "Tap bubbles of both axes". Cancel. → saw:
- [ ] **Drawing Position on + Device.** Long-press between B and C / 9 and 8 → + Device: the form's Drawing Position reads **Grid B-C / 9-8** and Room / Location the nearest room (e.g. `Elevator Lobby B (FSAE) XX06M-C003`), both editable. Add: the card shows that Drawing Position. → saw:
- [ ] **Drawing Position follows a moved pin.** On that device, Move pin (reason) → tap between D and E: Drawing Position becomes Grid D-E / …. Type your own Drawing Position on another device, then move its pin: the typed text stays. → saw:
- [ ] **Source sheets.** Floor plans → 06M → Source sheets → Add…: pick any multi-page PDF: "Done: N sheets, 0 grid sets"; the row lists `<name> p.1, p.2…`. (Opening source sheets on the plan is T78.) → saw:
- [ ] **Same file twice.** Choose… the composite again for 06M: "Already uploaded — this exact file was imported for this level before". Replace… with a different PDF: the level now opens that one; the old pins show as "elsewhere" (T77 carries them over). → saw:
- [ ] **Offline.** Airplane mode on, Choose…: a plain error line, nothing else affected; the Grid panel and Test still work from the local sheet data. → saw:

Decision D147: `sheet.features` beside `grid_sets`; pypdf rewrites the display PDF with the boundary group off; three grid sets on 06M; manual calibration on the plan (⌗ Grid), Drawing Position / Room defaults follow the pin until typed over (see DECISIONS.md). Approve / change → answer:

---

## T81 — Punch List Device text follows the device  ·  Needs: no new build (JS only); the server rebuilt with T81 (no migration)

**Why it matters:** the EC reads the Punch List's Device column to find the device; it must match the device as it is now (renamed, retagged), and a row the import could not link must not vanish into a wrong device.

Use a throw-away project with the master imported **after** the server runs T81 (the Tower was imported earlier and has no review items for this).

- [ ] **Review items arrive.** Needs review → Lint tab: 13 items reading `Punch #… · Device "…" → link` (e.g. B1 #27 `Walter Tower east wing`, 04 #22 `Elec XX04-1E01`, three `Stations & sensors`). No item for the "Missing all Device Neuron IDs" rows. → saw:
- [ ] **Link to device.** Select B1 #27: the panel shows the punch item and "Device, as the master wrote it: Walter Tower east wing". Type `S1` in the filter: the list narrows to B1 devices with S1 in the ID or text. Tap one → Link: the item leaves the list, the note reads "Linked: Review: linked punch item to B1-S1… (master: "Walter Tower east wing")". → saw:
- [ ] **Create device.** Select 04 #22 → Create device ▸: the + Device form opens in the panel with Room / Location empty-or-prefilled and "Not on the plan yet". Pick Relay panel, type `CT04LCPB`, Add device: the item closes as linked to `04-? (new)`. After the next sync the device gets its 04-nn ID. → saw:
- [ ] **Place the new device.** Open level 04 → Devices list → the new device (it is in the "not on the plan" count) → card ⋯ → **Place pin…**, give a reason, tap the plan: the pin appears there. → saw:
- [ ] **Lists show the derived text.** On B1, the Punch side list: #8 reads `B1-S3 · PI1002 S3 - Corridor XXB1-C005, north · Install cover…` (the device's room, not the master's spelling); an unlinked row (e.g. a `Stations & sensors` one still open) shows the master's text. → saw:
- [ ] **A rename follows.** Open B1-S3's card, change Room / Location: the card's Punch items line and the side list's #8 show the new room at once, with no edit on the punch item (its history has no new entry). → saw:
- [ ] **Two iPads.** Link an item on iPad A; after a sync iPad B no longer lists it and shows the same Device text for that punch item. → saw:
- [ ] **Export.** Export the workbook (Export screen, synced): Punch List row B1 #8 shows the renamed room; 04 #22 shows the new panel's name; an item left unlinked shows the master's text (e.g. `Stations & sensors`). → saw:

Decision D151: the derived Device text format (named panels, racks and NSPS by name, `EBDK (<panel>)`, the rest with tag and room), the Neuron ID rows not raised, Create device unplaced with Place pin… (see DECISIONS.md). Approve / change → answer:

---

## T82 — Daily master export backup  ·  Needs: no new build (JS: the history label); the server deployed with T82 (see the TASKS.md deploy note)

**Why it matters:** if the server or the data is ever lost, the newest master workbook for each project should be at most a day old, without filling the bucket with identical copies.

- [ ] **First backup.** The morning after the deploy (after 08:00 UTC = 03:00 Houston): Export screen → history shows one export per project labelled "daily backup", made overnight. Open/Share it: a normal master workbook. → saw:
- [ ] **No edit, no backup.** On a day with no edits on a project, the next morning shows no new "daily backup" row for it. → saw:
- [ ] **An edit makes one.** Change one device's notes, sync; the next morning there is a new "daily backup" row for that project only. → saw:

Decision D152 recorded from your answer (skip unchanged, keep six months): no answer needed.

---

## Rules for this file

1. **Each finished task appends its checks** under a heading `## T<nn> — <title>  ·  Needs: <no new build | new dev build>`. Each check says *what to do*, *what you should see* and *why it matters* (one line), with `→ saw:` at the end. Put checks Claude cannot do (anything needing the iPad, Pencil, camera, airplane mode, two devices or a TestFlight build) here instead of burying them in TASKS.md; TASKS.md just says "checks added to docs/ON_DEVICE_CHECKLIST.md".
2. **Proposed decisions** that need your approval get a `Decision D<nn>` line in the same section.
3. **New dev build needed?** If a task adds a native module, its heading says *new dev build* and the "Before you start" step 1 applies to the whole round.
4. **You test, then say "tested"** and paste the file back with `[x]` / `→ saw:` filled in.
5. **Claude then:** copies the whole round (with your results) into [on-device-log.md](on-device-log.md) under a dated heading, turns every failure into a new task in `TASKS.md` (plus an answer for each Decision line in `DECISIONS.md`), and resets this file to the "Before you start" block with an empty list and a new round date.
6. Anything not yet tested stays in the list; nothing is dropped silently.
