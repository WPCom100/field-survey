# Setup end to end on the fixtures (T49)

One walk through every setup step, from nothing to a locked level, on the golden fixtures:
new project → levels B2–06M + 07 → BOM + riser + the 06M composite → extraction → review → place →
lock 06M. Two halves (CLAUDE.md §7 5a):

- **The script:** `bash scripts/mac/rig.sh e2e` on the Mac test rig (`app/maestro/e2e-setup.yaml`). It
  proves the taps, the screens and the counts, and times each stage. The rig's server has no Claude
  key, so the riser's far ends come back to pick.
- **The checklist:** the same walk on an iPad against the Droplet (Claude key set), in
  `docs/ON_DEVICE_CHECKLIST.md` § T49. Landry judges what only a person can: whether the drafts, the
  proposals and the numbers are *right*, and how long it takes on the hardware.

## 1. The script

```
bash scripts/mac/rig.sh server     # if not running
bash scripts/mac/rig.sh metro      # in its own terminal
bash scripts/mac/rig.sh e2e        # about 5 min; RIG_PROJECT="…" names the project
bash scripts/mac/rig.sh e2e --unjoined   # T172: the same with 06M not joined to 06 (both pickers cleared)
```

`rig.sh e2e` puts `BOM.pdf`, `Level_06M_-_Lighting_Composite_vector.pdf` and `riser.pdf` in the
simulator's Files app (name order: the flow taps them by position), runs `e2e-setup.yaml` on a new
project `Maestro e2e <hhmmss>`, prints each stage's time (`scripts/mac/stages.py` reads Maestro's
`commands.json`: one labelled `runFlow` per stage), and checks on the server that 06M is
`baseline_locked`. The table is saved as `$TMPDIR/field-survey-rig/e2e-<time>.md`.

| Stage | Sub-flow | What it does and asserts |
|---|---|---|
| create project | `_e2e-create.yaml` | New project with B2, B1, 01, 02, 03, 04, 06, 06M, 07; 06M arrives **sharing 06's numbering group and as a split of 06** (New project's default since T172, D263; as the Tower, D33) and the flow asserts both pickers read 06; with `--unjoined` (`UNJOINED=yes`) it clears both, and Review drafts must still offer 06 or 06M (defect 1); Create → the Levels home lists 07, 06M, B2 |
| BOM extraction | `_e2e-bom.yaml` | Sources → BOM → `BOM.pdf` → `Done: n device drafts, n excluded lines, n flagged` |
| riser extraction | `_e2e-riser.yaml` | Sources → Riser → `riser.pdf` → `Done: … (n merged into the BOM's), n cable drafts, n far ends to pick` |
| plan sheets 06M + 07 | `_e2e-sheets.yaml` | The 06M composite as 06M's display sheet, then again as 07's (the fixtures hold no 07 sheet); each waits for its sheet job and the synced sheet |
| review drafts | `_e2e-review.yaml` | Review drafts: 06M's rack (ERN4-RM-120, the BOM's "Level 5") accepted; on 06 the riser's UFMP8 CT06LCPA, ERP24-FT-241P CT06LCPB and EBDK each show "06 or 06M?" → ○ 06M → Accept; 06M then lists nothing open and all four under All; the Pool's 17-unit PI1002 line accepted |
| place 06M | `_e2e-place.yaml` | Place devices → 06M: "3 dashed pins where the sheet prints the type or tag"; CT06LCPA and CT06LCPB confirmed from their proposals, the EBDK from the faint guess beside CT06LCPB (D234), the rack from the list left of CT06LCPB (it has no proposal); `Placed 4 of 4`, the list empty |
| pooled station on 07 | `_e2e-pool.yaml` | Place devices → 07 → Pool → PI1002 → a spot → `Placed 07-? …` |
| lock 06M | `_e2e-lock.yaml` | Place devices: 06M and 07 read **Open plan ▸** (0 not on plan, 0 from drafts — `loadPlacementProgress`), `4/4 ✓`, the pool line `16 units to place`; Lock baseline: `Lock 06M` with no ⚠, the dialog's button `Lock 06M` (not "Lock anyway"), `🔒 Locked <date>`, the Levels home shows 06M 🔒 |
| sync | `_sync.yaml` | Sync now → Synced, nothing needs attention |

The proposal spots (`28%,51%`, `23%,43%`, `25%,43%`) are read off a screenshot of the rig's
"Field Survey iPad" simulator at fit, portrait. Each tap is followed by an assertion on the selected
item, so a tap that misses fails the run instead of placing the wrong thing; a new simulator model
or a changed sheet needs them read again (`rig.sh shot`).

## 2. Results — rig, 2026-11-07

Green twice in a row (`Maestro e2e 145642`, `Maestro e2e 150153`), after one exploratory run that
found defect 1 and one that failed on the flow's own pool-line assertion (the two PI1002 pool lines
come in no fixed order; the flow now picks the 17-unit line by its text).

| Stage | Run 1 | Run 2 |
|---|---|---|
| create project | 39 s | 39 s |
| BOM extraction | 30 s | 33 s |
| riser extraction | 27 s | 28 s |
| plan sheets 06M + 07 | 56 s | 54 s |
| review drafts | 28 s | 28 s |
| place 06M | 35 s | 35 s |
| pooled station on 07 | 21 s | 21 s |
| lock 06M | 9 s | 9 s |
| sync | 13 s | 13 s |
| **whole run** (incl. app launch and connect) | **4 min 51 s** | **4 min 52 s** |

These are Maestro's times, its own waits included; a person on an iPad is slower at the taps and
faster at nothing else. The extraction times are the rig's worker (Mac mini M4, Colima) with no
Claude calls. The riser on the Droplet makes its endpoint calls and will take longer (T49 checklist
line records it).

**What the extraction gave** (the run-2 project; the same each run):

| | |
|---|---|
| BOM | 6 pages (p.3 by OCR), 4 jobs, 27 venues (4 pooled), 258 lines → 108 device drafts, 17 excluded lines, 35 flagged |
| Riser | bands for 12, 11, 10, 09, 06, 04, 03, 02, 01, B1, B2 (no 06M band: the mezzanine's panels sit in 06's band); with the BOM's drafts 145 device drafts (807 units) and 155 cable drafts; Claude: unavailable on the rig |
| 06M sheet | 7 tags, 16 rooms, 3 grid sets auto-calibrated (residuals 0.18, 0, 0.03) |
| 06M after review | the four devices the master has on 06M: rack, CT06LCPB (ERP24-FT-241P), EBDK, CT06LCPA (UFMP8) |

**What the server holds after the lock:** 06M `baseline_locked` with 06M-01 UFMP8 CT06LCPA
(`Grid D-E / 11-10.5`, Elevator Machine Room XX06M-1EM02), 06M-02 ERP24-FT-241P CT06LCPB
(`Grid C-D / 13-12.8`, Stair A Vestibule XX06M-2SV01), 06M-03 EBDK (`Grid C-D / 13-12.8`, Shaft 1
Stair A XX06M-2S01), 06M-04 ERN4-RM-120 (`Grid B-C / 12.8-12`, no room) — each with its library
type; 07-S1 PI1002 on 07; every other level still `setup`.

## 3. Defects and observations

| # | Found | Became |
|---|---|---|
| 1 | **The riser's "06 or 06M?" offers no choice unless 06M is a split of 06.** The server flags `level:06/06M` on a 06 panel whenever the project has a level `06M` (`riser_extract.py`, `bom_extract.py`: by the code), but Review drafts lists the 06 / 06M radios only for levels joined by `split_of_id` (`drafts/model.ts`). New project creates 06 and 06M as two own groups with no split unless the user sets both pickers, so the first run showed the ⚠ "A panel-class device on a split floor: 06 or 06M?" with nothing to pick (`Level 06 · basis: riser_band`): Review drafts cannot put the panels on 06M; the way round is Setup → Levels → 06M Split of 06 afterwards, or accepting on 06 and then Flag → Move to… 06M in Place devices (T143). | **T172** — done 2026-11-07 (D263, both): Review drafts offers the two codes the server flags, joined or not; New project and + Add level join a `<code>M` to `<code>` by default. `rig.sh e2e` and `rig.sh e2e --unjoined` prove each |
| 2 | Placement order sets the device numbers. The server numbers 06M in the order the devices are placed (D25), so the run's 06M-01 is CT06LCPA, while the master's 06M-01 is the rack. Working as designed; whether setup should number a level's panels in a fixed order (rack first) is Landry's call. | a question in the T49 checklist section (no task unless Landry wants it) |
| 3 | The fixtures hold no 07 sheet; the rig uses the 06M composite for 07, so 07 shows 06M's drawing and (with the pooled ERP24 / ERP48 lines) could propose 06M's panel tags there. Only the pooled station is placed on 07. | none (a fixture gap; the checklist uses the real 07 sheet if Landry has it) |
| 4 | The rig's riser has no Claude endpoints: far ends stay to pick. | the checklist runs it against the Droplet |

Nothing else went wrong in the four runs: no server error, no app error toast, no stuck sync.
