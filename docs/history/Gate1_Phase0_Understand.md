# Survey iPad App — Phase 0 (Gate 1): Understand

Inputs read: `Lighting_Control_Survey_Master_B2-06_4.xlsx`, `riser.pdf` (ETC dwg 001–002, rev F 7/23/26), `BOM.pdf` (ETC BOM-1…6, 4 job numbers). Azle files excluded. No floor workbook, marked-up plan or MSS was attached.

## 1. Glossary

| Term | Meaning (as used in the workbook/riser/BOM) |
|---|---|
| EC / ETC / GC | Electrical contractor / ETC field service / general contractor. Owner labels: `EC`, `ETC`, `EC/ETC` |
| ERP, ERP-FT-241P / 481P | Echo relay panel, 24 or 48 relays. Named `CTxxLCPA/B` on the riser (xx = level) |
| ERP-FT-LVD | 0-10V dimming control card (option) in an ERP |
| ERP-RTO | Ride-through option card + jumper in an ERP |
| EBDK | Emergency Bypass Detection Kit, paired with each ERP; gets a 4-wire sense feed and the panic wire (P) |
| UFMP4 / UFMP8 | Foundry 4/8-zone DMX mini panels |
| Equipment rack (18U) | Wall rack with Unison ERn4-RM (P-ACP3 ×2, P-SPM-E ×2), Mosaic MSCX-10, patch panel, brush panel, 28-port PoE switch, RSN-DMX4 gateway, UPS |
| P-NSPS-D(-KIT) | Paradigm network station power supply (DIN); each floor's stations/sensors home-run Unison to it |
| PI1002 / PI1004 / PI1104 | Paradigm Inspire stations: 2-button, 4-button, 4-button with fader (BOM suffix `-4Z` black, `-5` white; faceplate `1IFP` is a separate BOM line) |
| P-DOC-C-LR / -SR / -W / -SM2 | Paradigm occupancy sensors: large ceiling, small ceiling, wall, switch-mount |
| P-LS | Paradigm light sensor |
| P-TS7-E | Paradigm 7" touchscreen |
| UHCI-WM | Unison contact interface for the Level 04 partition (through-beam) sensors; cable code `UV` |
| Cable codes | `X` DMX (Belden 9729) · `N` network (Cat) · `NG` network + ground · `U` Unison (Belden 8471 + ground) · `F` fiber · `P` panic (2×#16) · `0-10V` · `120V` |
| Run | Cable pulled but not terminated |
| Term kit | DMX termination kit (ETC-supplied). Network kits are never needed |
| Wagos / wire nuts | Lever connectors (provided in box) vs. the wrong connector |
| Neuron ID | Per-device LonWorks ID ETC needs; every floor ends with the "Missing all Device Neuron IDs" item |
| Riser | ETC dwg 001 (Levels B2–12) and 002 (14–28): devices per level, cable bubbles, named rack outputs, `QTY:` callouts on station groups |
| VENUE line | BOM grouping row that names the level/area the following lines belong to |
| MSS | ETC's Master Site Survey commissioning tracker (not attached) |
| Ruling | A standing decision applied to every floor; logged with change type `Ruling` |
| Baseline / as-found | Reviewed setup (what should be there) vs. survey record (what is there) — from the prompt, not yet in the workbook |

## 2. Entities as found in the master

Common to every data tab: row 1 title, row 2 `Levels B2-06`, headers row 3, data from row 4, an Excel Table, frozen panes at C4, helper column `Floor Order` (B2=1 … 06M=8). Status columns use data validation against the `Lists` tab.

| Entity (tab, table) | Columns as found | Notes |
|---|---|---|
| Level | Only implicit: Summary rows carry `Floor`, `Surveyed`, `Updated` dates; `Floor Order` on every tab | No Levels tab. Codes: B2, B1, 01, 02, 03, 04, 06, 06M |
| Device (`Devices`) | Level, ID, Category, Device, Type, Room / Location, Drawing Position, Status, Notes, Photo, Floor Order | ID = `<level>-<nn>` for panels/equipment, `<level>-S<n>` / `-D<n>` for stations/sensors. Photo = Photo Log number(s), text |
| Connection (`Connections`) | Level, ID, From, Cable, To, Qty, Status, Note, Floor Order | ID `C-nn` per floor; 06/06M share numbering. **From/To are free text, not device IDs.** Qty blank on 13 rows (Unison bundles) |
| Punch item (`Punch List`, table `PunchList`) | Level, #, Device, Item, Type, Photo, Owner, Tracking status, Date closed, Notes, Floor Order | Photo holds numbers, incl. `"7, 8"` |
| Missing part (`Missing Parts`) | Level, #, Device / Location, Part, Part no., Qty, Owner, Source, Part status, Notes, Floor Order | Source is free text: `Punch #2`, `Punch #15, #16`, `Punch #14; Devices 06-S3`, `Connections C-06 (fiber to Level 01)` |
| Photo (`Photo Log`) | Level, Photo, Location, Subject, What it shows, Device ID, Floor Order, Image | 76 embedded 320×240 images anchored in column H |
| Change-log entry (`Change Log`) | Date, Level, Sheet, Ref, Entry, Field, Was, Now, Change, Reason, Floor Order | Ref is `#n`, `#1-#9`, device ID or `C-nn` per sheet. Field includes `(row added)` on 22 rows |
| Summary | 4 tables (device status by floor; outstanding by floor; outstanding by owner; missing parts by floor), SUMPRODUCT formulas over rows 4–2000, 4 stacked bar charts | Header lines: title, levels, "Surveyed 2026-10-07 to 2026-10-09", submittal disclaimer |
| Lists | Device status, Tracking status, Part status, Connection status | Source of the dropdowns |

### Enums as found (count in master)

| Field | Values |
|---|---|
| Device Category | Station 96 · Sensor 73 · Foundry panel 12 · Relay panel 11 · EBDK 11 · NSPS 4 · Equipment rack 2 · Touchscreen 1 |
| Device model (`Device`) | PI1002 61, P-DOC-C-LR 59, PI1104 30, EBDK 11, UFMP4 10, P-DOC-W 8, PI1004 5, P-NSPS-D-KIT 4, CTxxLCPA/B 11 (one row each), Equipment Rack 18U 2, P-LS 2, P-DOC-SM2 2, UFMP8 1, UHCI-WM 1, P-TS7-E 1, Partition sensors 1 |
| Device Status | Not installed 77 · Installed, untested 70 · Issue 50 · No access 13 · Complete 0 (in list, unused) |
| Cable | X 42 · N 16 · U 14 · 0-10V 11 · P 11 · 120V 6 · F 3 · NG 2 · UV 2 |
| Connection Status | Issue 52 · Not installed 32 · Installed, untested 17 · Not started 5 · No access 1 · Complete 0 |
| Punch Type | Not installed 77 · Missing part 40 · Cable not run 28 · Wiring 18 · Information 16 · Termination 16 · Missed Survey 15 · Access 3 · Replace Part 2 |
| Owner | EC 169 · ETC 24 · EC/ETC 22 (punch); Missing Parts: EC 85 |
| Tracking status | Open 198 · Closed 16 · In progress 1 |
| Part status | Needed 81 · Installed 2 · On site 2 · Ordered 0 |
| Missing Parts Notes | Need to be ordered 41 · Confirm whether on site 34 · Confirm whether on site (provided in box) 4 · 6 one-offs |
| Change type | Field survey 166 · Reconcile 68 · Ruling 54 · Riser cross-check 33 · Master edit 24 · MSS ruling 20 · Correction 10 |
| Change-log Field | Notes 77, Status 51, Note 31, Photo 26, To 23, (row added) 22, Owner 19, Source 16, Tracking status 16, Type 15, Date closed 15, Category 12, Qty 11, Item 10, Device / Location 8, # 7, Part 6, Level 3, Part status 3, Device 2, From 2 |

Everything in the prompt's "data as it exists" section matches the workbook, with these deviations to note: no Level tab; `Floor Order` helper column and `Lists` tab exist but weren't listed; `Complete` and `Ordered` exist in lists but not in data; From/To/Source are prose, not keys.

## 3. Counts

| Tab | Rows | By level |
|---|---|---|
| Devices | 210 | B2 5 · B1 39 · 01 36 · 02 45 · 03 36 · 04 31 · 06 14 · 06M 4 |
| Connections | 107 | B2 8 · B1 5 · 01 25 · 02 14 · 03 16 · 04 14 · 06 1 · 06M 24 |
| Punch List | 215 | B2 9 · B1 28 · 01 53 · 02 32 · 03 31 · 04 44 · 06 3 · 06M 15 |
| Missing Parts | 85 | B2 3 · B1 8 · 01 20 · 02 10 · 03 16 · 04 13 · 06 2 · 06M 13 |
| Photo Log | 76 | B2 4 · B1 12 · 01 15 · 02 6 · 03 17 · 04 16 · 06 3 · 06M 3 |
| Change Log | 375 | 2026-10-08: 186 · 2026-10-09: 189 |

## 4. Riser and BOM as found

| Source | Findings |
|---|---|
| `riser.pdf` | Clean vector ETC submittal (text extractable), 2 sheets, job 15076538, rev F 7/23/26. Sheet 001 = Levels B2–12, sheet 002 = 14–28. Per level: ERP panels named `CTxxLCPA/B` with card counts, EBDK, UFMP, NSPS/DIN enclosures, station/sensor groups with `QTY:` callouts, cable bubbles `X N NG U F P`, equipment racks (01, 06, 16 ERn4, 28) with named outputs (e.g. "DMX TO B3A CANYON", "TO WALTER TOWER ETC P-CCS", "TO EQUIP RACK LEVEL 06"). Legend maps wire types to signals. **No hand annotations** (blue destination numbers, "run" marks) are in this copy. |
| `BOM.pdf` | Vector text, 6 pages, four ETC jobs (15076538, 15076539, 15084073, 15084074). Rows: line, part no., description, model, qty. `VENUE` rows group lines by area: some by floor (`Floor B2`, `FLOOR 3`…), some pooled (`Level B2 - 12` for all ERP/LVD/RTO/EBDK/UFMP8; `Level 14 - 28`; `Level 16, 22`; `Link to P-CCS in other building`), and racks under `Level 1`, `Level 5`, `Level 28`. Page 3 is a two-column layout. Models carry colour suffixes (`-4Z`, `-5`), faceplates are separate lines, and service lines (energization, engineering, manuals, "DATA TERM OTHERS") are mixed in. |

Observed mismatches worth a question (not yet a cross-check — that is Phase 1f): BOM sensors are mostly `P-DOC-C-SR` (small ceiling) where the master says `P-DOC-C-LR`; the BOM puts the second rack at `Level 5` while the master has it at `06M`; `Level 1` under job 15076538 pools P-TS7-E, 17 P-DOC-C-LR, 8 P-LS and 11 PI1002 without a floor.

## 5. Rules with provenance

Source key: **P** = prompt "Rules" section; **W** = evidence in the workbook (change-log reason or data); **E** = ruling from an earlier conversation, not in the prompt (confirm it still stands).

| # | Rule | Source |
|---|---|---|
| R1 | "Installed, untested" = nothing outstanding; any outstanding wiring/termination → Issue; nothing is Complete this phase; unreached → No access | P1; W (Complete 0) |
| R2a | Unpulled cable → Not installed, note "Not run"; pulled not terminated → Issue, "Run, not terminated" (+ "; no term kit" for DMX) | P2; W reason ×10 |
| R2b | Riser governs To; notes keep alternate-destination guesses | P2; W reason "To field follows the riser" ×9 |
| R2c | Panic wire: always run, one row. 0-10V row reads "Fixtures", one row | P2; W reason "0-10V rows read Fixtures" ×9 |
| R2d | 120V rows read "120v Power → <device> Power Supply" | P2; W reason ×2 |
| R2e | Each floor's Unison gets its own row | P2; W (06M C-15 vs 06 C-10) |
| R2f | Unchecked end copies the known end's status, else No access "Not surveyed"; floors not in scope → Not started | P2; W (06M C-16, C-20…C-24) |
| R3a | One "Run …" item per unpulled wire; becomes a terminate item once run | P3 |
| R3b | DMX termination = own device-level item (Missing part, EC/ETC, "Waiting on DMX Termination Kits") | P3; W |
| R3c | Every floor's list ends with "Missing all Device Neuron IDs" (Information, EC) | P3; W ×7 |
| R3d | No test/commission items | P3 |
| R3e | Short item text, qualifiers in Notes, open questions with "?" | P3 |
| R3f | Standard wording set (wire nuts → Wagos; re-pull Belden 8471; "Not installed: install …") | P3; W (11, 4, 2 uses) |
| R4a | Missing part owner = EC | P4; W (85/85) |
| R4b | DMX kits one per run, "DMX termination kit - <destination> run" | P4; W |
| R4c | Notes "Need to be ordered" (parts/kits) or "Confirm whether on site" (devices/backboxes) | P4; W |
| R4d | Re-pulled wire never a missing part; network kits never needed | P4 |
| R5 | Far-end items for unsurveyed floors wait for that floor's survey | P5; W (Not started ×5) |
| R6 | Every edit to an existing record is logged (who, when, was→now, reason); new records are not listed | P6 — **conflicts with W**: 22 `(row added)` entries exist |
| R7 | Floor report + punch list; header shows survey date only, no company name | P7 |
| E1 | Punch types "Replace Part" (swap card/device) vs "Missing part" (not present) | E; W (2) |
| E2 | "Missed Survey" for devices to re-check (e.g. stuck buttons); "Information" for data-gathering; "Access" for barricade/locked | E; W |
| E3 | DMX terminations and kits are counted only at the surveyed floor's end of a wire | E |
| E4 | Same-floor runs also get a row at each end (panic and 0-10V excepted) | E |
| E5 | Missing ERP-FT-LVD implies a "0-10V wire not landed" connection row and punch item | E |
| E6 | Spot-check findings fixed on site → Information item, Closed, "Reterminated - all good"; spot-check notes stay out of Devices Notes | E |
| E7 | Non-ETC sensor at a P-DOC location → NI + Information item to confirm | E; W ("Wattstopper") |
| E8 | P-NSPS-D 48V jumper is EC wiring; cables found landed in the ERP are "Lands in ERP; needs to be run down to the NSPS below it" | E; W |
| E9 | A relocated device's "moved from <room>" goes in Room / Location | E |
| E10 | Photo captions short; empty-box caption "Empty box on wall." | E |
| E11 | Change Log excludes rows added for things missed; word wrap everywhere; tab titles on two lines; chart beside each Summary table; no clickable Summary links | E; W |
| E12 | MSS: prior entries kept; disagreements become "check" items, not overrides | P (Should) + E |

## 6. Questions

**Project setup (asked for in the prompt)**

| # | Question | Why it matters |
|---|---|---|
| Q1 | The BOM is vector PDF, grouped by `VENUE` rows: per floor for stations/sensors/NSPS/UFMP, pooled for ERP/EBDK/LVD/RTO ("Level B2 - 12", "Level 14 - 28") and racks ("Level 1", "Level 5", "Level 28"). Is this the format every ETC BOM takes, and do you also get the Excel/CSV original? | Decides whether extraction is text parsing with AI fallback, or AI-first |
| Q2 | The attached riser is the clean rev F submittal with no hand notes. Does an annotated copy (blue destination numbers, "run" marks) exist, and should the app treat the clean riser as the baseline source and your marks as survey data? | Separates baseline from as-found |
| Q3 | Floor-plan sheets: vector or scanned, how many per level, and do they carry a grid that could be calibrated for Drawing Position? | Phase 1b/1f scope |
| Q4 | Who does setup — you only, or also team members? | Permissions and review flow |
| Q5 | BOM model names differ from the master's (`P-DOC-C-SR-4` vs `P-DOC-C-LR`, `PI1002-4Z` vs `PI1002`, faceplates as separate lines, racks as ~20 component lines). Should the device-type library map BOM models → your `Device`/`Type` vocabulary, and should rack components stay inside one "Equipment rack" device? | Extraction mapping rules |
| Q6 | BOM pooled sections (ERP/EBDK for "Level B2 - 12") give no floor; the riser does (`CT03LCPB`). Confirm: level comes from the riser when the BOM pools, and the riser panel name becomes the master `Device` name. | Level assignment rule |
| Q7 | Which BOM lines become devices? Proposal: ETC devices only; exclude faceplates, cards/kits (LVD, RTO, URTO, VDK), rack components, service lines, through-beam brackets. Cards/kits would instead become expected sub-parts of their parent device. | Extraction filter |

**Data model**

| # | Question |
|---|---|
| Q8 | From/To are prose today ("Stations & sensors", "DMX to Level 03 UFMP4s"). The app would link each cable end to a device (or to a placeholder like "Fixtures", "120v Power", "Level 09 — not in scope") and generate the prose for export. OK, and which placeholder endpoints do you want? |
| Q9 | Rule R6 says new records aren't change-logged, but the master has 22 `(row added)` entries (reason "Added in the 10/8 survey"). Which is the standing rule? |
| Q10 | `Complete` and `Ordered` are in the lists but unused. Keep both for later phases? |
| Q11 | Punch/Device `Photo` columns hold Photo Log numbers as text ("7, 8"). In the app a photo attaches to a device/item directly; the export would regenerate these numbers. OK? |
| Q12 | Missing Parts `Source` is prose referencing punch numbers (the renumbering problem). Proposal: store links to punch items/devices/connections and generate "Punch #2" text at export. OK? |
| Q13 | `Floor Order` and the `Lists` tab are export-only helpers, not fields people edit. Confirm. |

**Roles and UI (asked for in the prompt)**

| # | Question |
|---|---|
| Q14 | Roles: proposal is two — *Surveyor* (edit assigned floors, propose edits) and *Lead* (everything, resolve conflicts, record rulings, lock baseline, export). Is a read-only *Office* role needed now? |
| Q15 | Dashboard drill-down (tap a Summary count to open the filtered list): yes or no? You rejected clickable links in Excel; the app is a different context. |
| Q16 | Should field edits need reviewer approval before reaching the official record (optional in the prompt), or is the review queue for true conflicts only? |

## 7. Decision log and assumptions

| Decision | Status |
|---|---|
| D1 Workbook tabs, columns and vocabulary are the schema of record | From prompt; confirmed against file |
| D2 A cable is one record with two ends; per-floor rows are generated | From prompt |
| D3 Custom app; Fieldwire is UX reference only | From prompt |
| D4 Azle 15090056 files are not inputs | Your instruction today |

| Assumption | Label |
|---|---|
| A1 The clean riser (rev F) is the baseline source for cables; hand notes are survey data | Needs Q2 |
| A2 BOM-pooled devices take their level from the riser | Needs Q6 |
| A3 Rulings E1–E12 from earlier conversations still stand | Needs confirmation |
| A4 No MSS merge detail can be specified until the MSS workbook is attached | Fact |

## 8. Next phase block (paste into a fresh conversation)

```
Phase 1: Research for the ETC survey iPad app.
Effort: Medium (sub-agents Low). Web search: ON.
Attach: Lighting_Control_Survey_Master_B2-06_4.xlsx, riser.pdf, BOM.pdf, Gate1_Phase0_Understand.md (project doc), and the original prompt file.
Handoff: Gate 1 approved on <date>. Answers to Q1–Q16: <paste>.
Run workstreams a–f in parallel as the prompt describes; for 1f, extract cables from riser.pdf (vector) and devices from BOM.pdf (vector, VENUE-grouped, 4 jobs, page 3 two-column) into JSON matching the Gate 1 entity tables, compare against the master's Connections and Devices tabs, and report hits, misses and failure types. Note known mismatches: BOM P-DOC-C-SR vs master P-DOC-C-LR; rack at BOM "Level 5" vs master 06M; pooled "Level B2 - 12" panels.
Outputs needed: per-workstream summary with sources and dates; 1f test results and pipeline recommendation with cost per project; decisions, open questions, next-phase block for Phase 2.
```
