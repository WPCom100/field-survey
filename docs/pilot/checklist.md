# Pilot checklist — floor 03

The pilot from Phase 4 §5 (`docs/history/Phase4_Delivery_Plan.md`), as Landry runs it: what has to be true before the first device is surveyed (Part A, task T50), how to survey (Part B), what to do after (Part C), what to measure (Part D), and how the go/no-go and the way back work (Part E). T51 records TP-1 / TP-2 in this folder, T52 fixes what the pilot finds, and T53 writes `docs/pilot/report.md` from Part D.

Mark each line `[x]` when it holds and write what you saw after `→ saw:`. Paste the file back to Claude at any point; a failed line becomes a task before the pilot goes on.

## The plan in one look (D271)

| | |
|---|---|
| **Projects** | Two. **Houston Methodist Centennial Tower** is the current project, seeded from the master (B2–06M) and kept as the record. **Centennial Tower 03 pilot** holds floor 03 only: it is set up from scratch from the BOM, the riser and the 03 composite, then surveyed. 03 is already in the master and the seed import cannot leave a floor out, so the pilot gets its own project. |
| **Level** | 03, in scope in the pilot project; every other floor is out of scope there and holds only the far ends of 03's cables. |
| **People** | Landry alone, on one iPad. Phase 4 §5's second surveyor overlapping on a few devices is deferred: it needs a second person (Zach and Wiley are retired, D269). It waits in `docs/ON_DEVICE_CHECKLIST.md` under T50. |
| **Build** | TestFlight build **18** (uploaded 2026-11-08, runtime `aa772f1e`) plus the newest JS update. It is under 30 days old until **2026-12-08**. If the pilot starts after that, make a new production build first (`docs/ops.md` §5.3). |
| **Server** | `https://survey.wpcom.cloud`, `AUTH_MODE=entra` (sign in with Microsoft). |
| **Fallback** | The marked-up PDF method, only if the app blocks you. Never run both at once. |

## Part A — Before the pilot (T50)

### A1. The iPad

- [ ] **Build.** TestFlight shows Field Survey build 18 or newer installed. Launch the app twice (open, swipe away, open): Sync → Install reads build 18 and `update <id> · <date> · T<nn>: …`, not `embedded`. → saw:
- [ ] **Signed in.** Sync → Install reads `Landry` and `Signed in with Microsoft (<email>)`; **Sync now** → `Synced`. → saw:
- [ ] **Room.** iPad Settings → General → iPad Storage: at least 10 GB free (03's plan, a day of photos at full size until they upload). → saw:
- [ ] **Battery and case.** Charged, charger and Pencil packed. → saw:

### A2. The current project, seeded from the master

Done on the iPad. About 5 minutes plus the import (the rig's import takes about a minute).

- [ ] **New project.** Projects → + New project. Name `Houston Methodist Centennial Tower`, Site, EC / ETC / GC as on the master. Levels B2, B1, 01, 02, 03, 04, 06, 06M, in that order. 06M's row reads **Share numbering 06** and **Split of 06** without you touching it (T172, D263). **Create project**. → saw:
- [ ] **Seed import.** Setup → Sources → Seed import → **Master workbook** → Choose workbook… → `Lighting_Control_Survey_Master_B2-06_4.xlsx`. The Checks section lists Floors B2 … 06M, each tab with its row count, and reads "Every column is matched." Import, then copy the result line. → saw:
- [ ] **Needs review.** Open Needs review: anything the import could not fit into the vocabulary is listed there. Resolve each item, or note it here for a ruling. → saw:
- [ ] **Totals.** Dashboard: the device, punch and part counts per level match the master's Summary tab. → saw:
- [ ] **Lock.** Setup → Lock baseline → lock each of B2 … 06M. Locking with warnings is allowed: the "not on a plan" warning is expected because this project has no plan sheets yet. From here every edit is logged against the baseline (R6). → saw:

### A3. The pilot project: 03 from scratch

This is the same walk as the T49 dress rehearsal (`docs/test/setup-e2e.md`), on 03 and the real project, so it replaces the "E2E <date>" run on the on-device checklist. Time each stage with a stopwatch. Anything slow, unclear or wrong goes in its `→ saw:` and becomes a task before Part B.

- [ ] **New project.** Projects → + New project `Centennial Tower 03 pilot`, same Site / EC / ETC / GC. Add the levels B2, B1, 01, 02, 03, 04, 06, 06M, 07 one by one with **+ Add level** (each comes in scope), then switch **In scope** off on every level except 03. Leave 06M's two pickers as they come. Create. Time: → saw:
- [ ] **BOM.** Setup → Sources → BOM → `BOM.pdf`. Time until `Done: …`; copy the line. → saw:
- [ ] **Riser.** Sources → Riser → `riser.pdf`. Time until `Done: …`; copy the line. How many far ends are left to pick? → saw:
- [ ] **03's sheet.** Floor plans → 03 display → `Level_03_-_Lighting_Composite_vector.pdf`. The server rasterises this sheet because it is heavy (D242). Time until the plan opens, then pan and zoom: smooth? → saw:
- [ ] **Review drafts → 03.** Every panel, power supply, station and sensor you expect on 03 is there, with nothing extra; the quantities match the drawing. Accept, or edit then accept, each one. Leave the other floors' drafts alone: those floors are out of scope here. Time: → saw:
- [ ] **Place devices → 03.** The dashed proposals sit on the printed types (D241: `CT03LCPA`, `CT03LCPB`, `PI1104`, `PI1002`, `P-LS`, `EBDK`, …). Confirm each from its pin; place the rest from the list where they really are. Drawing Position and Room / Location come out right? Time: → saw:
- [ ] **Cables.** Cable / riser view, Level 03: every cable has two ends (03's device, plus a far end on another floor's placeholder or device), and no `missing far end` is left that you did not expect. → saw:
- [ ] **Lock 03.** Setup → Place devices reads `n/n ✓` for 03 (0 not on plan, 0 from drafts) → Lock baseline → `Lock 03`, with no ⚠ → `🔒 Locked <today>`. Sync. → saw:
- [ ] **IDs against the master.** After the sync, compare 03's device IDs with the master's 03 Devices tab. The pilot numbers devices in the order you place them, so they can differ from the master's (the T49 numbering question). Note any that differ; Part C needs this. → saw:
- [ ] **Total setup time**, from New project to the lock. → saw:

### A4. Assignments

- [ ] Setup → Assignments → **Centennial Tower 03 pilot** → 03 → Landry. On the Levels home, 03 shows ● and appears under "Assigned to me". → saw:

### A5. Plans cached, proven offline

- [ ] **Download.** In the pilot project, Sync → Cached levels → **Download assigned levels**. Wait until 03 reads `03 ✓`. The Levels home's Cache column reads `Cached` for 03. → saw:
- [ ] **Offline proof.** Airplane mode on, swipe the app away, open it. Open 03's plan, pan and zoom, open a device card, set a status, then put it back. Sync reads Offline and the edits wait. Airplane mode off → `Synced`. → saw:

### A6. Ready to go

- [ ] **Fallback ready.** The marked-up 03 PDF is on the iPad (Files) or printed, untouched unless the app blocks you. → saw:
- [ ] **Rig.** Claude ran `rig.sh e2e` green on the commit this build carries (T50: green on `b3fd598`; re-run after any change to New project, the extraction, Review drafts, Place devices or the lock). → saw:
- [ ] **Pilot date** set, and it is no later than 2026-12-08 (build 18's 30 days). → saw:

## Part B — During the survey

- The app is the only record. Survey normally: status, notes (chips first, free typing when no chip fits), photos, field additions, markup.
- **Every time you reach for the spreadsheet, or for a phrase the chips don't offer, write one line** in the log below. Each line is a defect or a missing vocabulary phrase.
- Sync whenever you have a connection. Edits and photos queue offline either way.
- If the app crashes, write the time and what you were doing, then carry on. Sync → Export local log gives Claude the log file.

| Time | What I reached for, or what went wrong | Device |
|---|---|---|
| | | |

## Part C — After the survey

- [ ] **Sync.** Sync now → `Synced`; Pending edits 0, Photos waiting 0. → saw:
- [ ] **Needs review.** Resolve every item. With one surveyor, few or none are expected. Count: → saw:
- [ ] **Rule drafts.** Accept, edit or reject each rule draft on 03. Count the accepted-unedited, edited and rejected (Part D). → saw:
- [ ] **Lint.** Lint for 03: fix each finding or dismiss it with a reason. Count: → saw:
- [ ] **Rulings.** If a pattern needs the same edit on many devices, record a ruling, preview it and apply it. List them: → saw:
- [ ] **Export.** Export → Master workbook, then Floor PDF → 03. Both run to `Ready`. → saw:
- [ ] **Check without fixing.** Open the workbook and the PDF and read them. **Do not change anything in Excel.** List every cell you would have had to fix before sending (target 0). → saw:
- [ ] **Send or hold** (Decision D271 (5) below). → saw:

## Part D — Measures (for T53)

| Measure | Target | Result |
|---|---|---|
| Cells you would have fixed in Excel after export | 0 | |
| Review items raised vs expected | — (one surveyor: overlap deferred) | |
| Rule proposals accepted without edit | ≥ 80 % | accepted unedited / total = |
| Time per device (survey only, not setup) | below your estimate for the PDF method | minutes on site ÷ devices = ; estimate for the old method: |
| Setup time (A3 total) | — (first measure) | |
| Crashes | 0 | |
| Lost edits or photos | 0 | |
| Spreadsheet reaches and missing phrases (Part B log) | — | |

## Part E — Go/no-go and the way back

- **Go:** the 03 workbook and floor PDF need no Excel fixes, and no edit or photo was lost.
- **No-go:** any lost edit or photo, or more than a handful of Excel fixes. Fix them (T52) and run the pilot again on the next floor.
- **Way back:** after one sync, no data lives only on the iPad. The exported workbook has today's format, so the old spreadsheet loop can pick up from it.
- T53 records the decision in `DECISIONS.md` and the measures in `docs/pilot/report.md`.

Decision D271 (5), Claude's proposal: the pilot project's 03 workbook goes to EC/ETC **only if** its device IDs match the master's 03 (A3 "IDs against the master") or you decide they may change. Otherwise "accepted unchanged" is judged by you, reading the 03 export against the master's 03 tabs, and the pilot's results enter the Centennial Tower project as edits after T53. → Approve / change:
