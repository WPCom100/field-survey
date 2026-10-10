# Survey iPad App — Phase 1: Research

Date 2026-10-09. Gate 1 approved with answers Q1–Q16 (section 1). Workstreams a–e ran as low-effort sub-agents with web search; 1f ran on the actual files. Two new inputs arrived during the phase: `15090056-BOM.pdf` (alternate BOM format) and `Level_06M_-_Lighting_Composite_vector.pdf` (example floor plan); findings in section 4.

## 1. Gate 1 answers → decisions

| Q | Answer | Decision / consequence |
|---|---|---|
| Q1 | BOM arrives as PDF only; never CSV. Two formats seen: VENUE-grouped submittal BOM (job 15076538 set) and scanned ETC "Material List" order form (15090056). | D5 BOM import = PDF only, text-layer parse first, OCR fallback. Material List has no venue/level grouping → project-wide pool by type. |
| Q2 | Riser is always the clean submittal. | D6 Clean riser = baseline source for cables. The app needs a riser verification step at setup (reviewer confirms each extracted cable against the riser crop) and the as-found marks are survey data. A1 confirmed. |
| Q3 | Example floor plan attached (see §4). | D7 Plans are vector; grid labels are extractable text → auto-calibration is feasible. |
| Q4 | Setup by Landry and team; no permissions in the app. | D8 No roles, no permissions. Sign-in is identity only (who made each change). Q14/Q16 closed. |
| Q5 | Use generic model names (P-DOC-C-LR); explore "accessories" for option cards (ERP-FT-LVD, ERP-RTO on ERP24/48). | D9 Model vocabulary = master's generic names; BOM suffixes (-4Z, -5, -4) stripped by a mapping table. Proposal P1 (needs approval): add an Accessory record (parent device, model, expected qty, found qty) — see §6. |
| Q6 | Riser is more accurate for level; anything undefinable goes to a human; do not gate the app at import — flagged list; a floor whose devices and connections are set is usable while others are open. | D10 Level comes from the riser when the BOM pools. D11 Import never blocks: unresolved drafts go to a "Needs review" list; floor readiness is per level. |
| Q7 | ETC devices only; anything mis-read at import can be converted to a device by hand. | D12 Extraction filter = ETC devices; every excluded BOM line stays visible and can be promoted to a device. |
| Q8 | Not understood — restated in chat. | Open O1: placeholder endpoints (proposed: Fixtures, 120v Power, Level XX (not in scope), Unknown destination). |
| Q9 | Change log for everything after an import. | D13 R6 revised: after the baseline is set, new records are logged too (as "row added"); setup/import itself is not logged. Matches the 22 `(row added)` entries. |
| Q10 | Yes | D14 Keep `Complete` and `Ordered` in the vocabulary. |
| Q11, Q12 | No — keep things static once set, for EC exports. | D15 Photo numbers, punch numbers and Missing Parts `Source` text are assigned once and never renumbered. Open O2: how a floor's new punch items get numbers while "Neuron ID item stays last" (R3c). |
| Q13 | Yes | D16 `Floor Order` and `Lists` are export-only helpers. |
| Q15 | Yes | D17 Dashboard counts drill down to filtered lists. |
| A3 | Not addressed | Assumed E1–E12 still stand (A3 still open). |

## 2. Workstream summaries

### 1a Offline-first sync (sources accessed 2026-10-09)

| Option | Status 2026 | Conflict model | Fit for field-level review queue | P2P | Cost (team of ≤5) |
|---|---|---|---|---|---|
| GRDB (SQLite) + custom sync service | GRDB active (v7.11) | Whatever we build: field-edit log → review queue is direct | Best | Possible later via MultipeerConnectivity | Hosting ≈ $5–25/mo |
| PowerSync + Postgres | Active; Swift SDK | None built in; client upload queue, backend connector decides → review table | Good | None | Free tier (deactivates after 1 week idle — risky); Pro $49/mo; photos must live elsewhere (2 GB sync/mo) |
| CloudKit (CKSyncEngine + CKShare) | Apple, active | Record-level; merge written by us on `serverRecordChanged` | Workable; needs per-field modelling | None | Free, but every user needs an iCloud account; quota is the owner's |
| Ditto | Active | CRDT per-field auto-merge; review queue needs an audit trail on top | Fair | Best (BLE/Wi-Fi mesh) | Free ≤10 devices; Pro unpriced |
| Couchbase Lite + Capella | Active | Doc revisions + custom resolver | Fair | Listed, unverified | Free tier; mobile "request pricing" |
| Firestore | Active | Last-write-wins per document | Poor (custom transactions; 100 MB cache default) | None | Pay-as-you-go |
| Automerge-swift | Active, small ecosystem | CRDT keeps both values | Fair, but we build transport, storage, photos | DIY | Free |
| ElectricSQL | Active (joining Databricks) | Read-path only, no Swift SDK | Not a fit | — | — |
| Realm / Atlas Device Sync | **EOL Sept 2025** | — | Excluded | — | — |

Shortlist for Phase 2: **(1) GRDB + custom sync with an append-only field-edit log** (matches the review-queue rule exactly, no vendor risk, highest build effort); **(2) PowerSync Pro** (removes client plumbing, conflict logic still ours); **(3) Ditto only if P2P becomes a must** (get a Pro quote first). Unverified items: CKShare quotas, Ditto Pro price, Couchbase blob/P2P detail.

### 1b Floor-plan PDFs, pins, Pencil

| Topic | Finding |
|---|---|
| Viewer | PDFKit `PDFView` as base; pins and PencilKit ink in our own overlay in **page coordinates**, stored outside the PDF (not `PDFAnnotation`). `PDFPageOverlayViewProvider` (WWDC22 10089) hosts a `PKCanvasView` per page. |
| Known problems | Apple forum thread: PencilKit ink blurs after zoom over a PDFView page (no fix posted); iOS 26.3–26.5 `PDFTilePool` over-release crash on 3 GB iPads (iPad 8/9) with canvas overlays; PDFKit's automatic page analysis can `bad_alloc` on big documents. |
| Mitigations | One PDF per sheet (never multi-sheet files); test on the oldest target iPad; keep a **pre-rasterised tile pyramid viewer (CATiledLayer)** as fallback; re-render canvas at the new scale after zoom ends. |
| Commercial | Nutrient/PSPDFKit ≈ €5,000 per user per year (Capterra, third-party figure) — not justified. |
| Grid calibration | 2–3 reference points per sheet → affine transform → "C-4"; with vector plans the grid bubbles are text (see §4) so this can be automatic. |
| Photos | HEIC → JPEG via ImageIO on export; bake EXIF orientation into pixels; take image index 0 from multi-image files; strip GPS; markup = PKCanvasView over the image, drawing stored separately (same code as the plan layer). |

Items marked by the agent as unverified against current docs: coordinate/`PKDrawing` storage details, HEIC/orientation specifics (standard practice, but confirm in Phase 2).

### 1c Excel and PDF export

| Library | Tables+filter | List validation | Native stacked bar | Images | Freeze/row height/wrap | Maintained | License |
|---|---|---|---|---|---|---|---|
| **XlsxWriter** (Python, server) | Yes | Yes | Yes (richest) | Yes | Yes | 3.2.9, 2025-09 | BSD |
| openpyxl | Yes (fragile headers) | Yes | Clunky | Yes | Yes | 3.1.5, 2024-06 | MIT |
| libxlsxwriter (C, SPM on device) | Yes | Yes | Yes | Yes | Yes | copyright to 2026 | BSD |
| ExcelJS / ClosedXML | Yes | Yes | **No charts** | Yes | Yes | slow | MIT |
| SheetJS CE | Pro-only styling/images | — | No | Pro | — | active | Apache/commercial |
| CoreXLSX (Swift) | read-only | — | — | — | — | — | — |

Recommendation: **server-side XlsxWriter** (only maintained option covering Tables + validation + charts + images + freeze/row heights in one file; output modelled on real Excel files, lowest Excel-Online risk; template updates need no app release). Fallback for offline export: libxlsxwriter via SPM. PDF per floor: **WeasyPrint 70 (2026-09)** from an HTML template on the same server; `UIGraphicsPDFRenderer` only if offline PDF is required. Must-do before relying on it: open-test a generated file in Excel for Mac and Excel Online.

### 1d UX references (Fieldwire first)

| Product | Copy | Offline / conflicts | Gaps vs our needs |
|---|---|---|---|
| Fieldwire | Plan-first: sheet → pin → card → photo/markup; task list beside plan; filters; custom statuses (Pro+); sheet compare; forms (Business) | Works offline on downloaded content; must log in online first; pushes on reconnect; **task numbers assigned at sync, first device to reconnect wins** (confusing); no documented conflict resolution | No two-ended cable, no rule engine, no locked vocabulary, generic change log/export. Pro $54 / Business $74 / Business Plus $104 per user/mo (Capterra) |
| Procore | Punch item from a drawing pin, ball-in-court | Offline exists; conflict policy undocumented | Heavy, priced by volume |
| Autodesk Build / PlanGrid | Sheets auto-synced; issues with markups; fast pan/zoom; hyperlinked sheets | Works offline, auto-sync; conflict rules not found | Same single-location pin limit |
| Bluebeam | Markups list as sortable spreadsheet, custom columns, Tool Chest symbols | File-based sessions | Markup ≠ structured record |

Patterns to adopt: pin tap opens a side card, not a page; list↔pin two-way highlight; status colour + letter/shape (your colour code); persistent filter bar incl. "assigned to me"; photo markup saved as a copy, original untouched; multi-select → bulk status/owner through the rulings preview; sync badge (pending count, last synced, unsynced mark on records); **stable UUIDs + display numbers assigned once** (fixes Fieldwire's numbering problem and matches D15); sheet versioning with pins carried to the new revision. Agent caveat: only Fieldwire offline, Fieldwire pricing and Autodesk Build overview were read from source; Procore/Bluebeam/Dalux notes are from search results.

### 1e Label scanning / Neuron ID

| Item | Finding |
|---|---|
| ETC labels | ETC: "ETC manufactured Lon control products are labeled with the Neuron id for easy reference and manual entry" (LightDesigner help). 48-bit ID = 12 hex chars. Barcode presence and label location per model: **not found in ETC docs** — needs a photo of one label per device type. Service pin / LightDesigner "wink" are the alternatives when a label is hidden. |
| Apple | `DataScannerViewController` (iOS 16+, A12+): live text + barcode in one view; no built-in content type for hex IDs → filter ourselves. `RecognizeTextRequest` (iOS 18+, Swift Vision API) with `.accurate`, `customWords`, confidence per observation. |
| Flow | Live scanner → normalise (uppercase, strip NID:/spaces/colons) → `^[0-9A-F]{12}$` → require same value on 3 frames → show crop + value in monospace, flag O/0 and B/8 substitutions, confirm before save → keep full-res label photo as evidence with capture method → reject duplicates in project. |
| Third-party | ML Kit no advantage; Scandit quote-only — not warranted unless ETC barcodes defeat VisionKit. |

## 3. 1f Extraction test — results

Full report: project doc `Phase1f_Extraction_Test.md` (schema, validation rules, cost arithmetic, sources). Headlines:

| Input | Text layer? | Handling |
|---|---|---|
| BOM pp.1,2,4–6 | Yes (pp.4–6 doubled glyphs) | pdfplumber + column bands, dedupe |
| BOM p.3 (two-column) | **No** (vector curves) | tesseract 300 dpi — 67/67 lines recovered |
| Riser 001 (B2–12) | Yes, fragmented labels | separator-line level bands, fragment merge |
| Riser 002 (14–28) | **No** | OCR or vision model required |

Riser legend correction: the bubble letter is a wire identification, not a quantity; bubbles are counted by geometry.

| Comparison (levels B2–06M) | Result |
|---|---|
| Devices, 54 level+model keys | 25 direct hits, 8 via vocabulary map (SR→LR, W-WD→W), 16 pooled-venue misses **all resolved by the riser**, 1 rack level alias (BOM "Level 5" = master 06M), 1 accessory granularity (partition sensors), 2 qty conflicts → **50/54 exact after BOM+riser merge** |
| Qty conflicts | L01 PI1004: BOM 1 / riser 2 / master 2. L03 ceiling sensors: BOM+riser 13 / master 9 |
| Connections, level+code | 14 hits (P, F, UV, X on B2/B1/04, N on B2); 7 qty mismatches because the master books each run from both ends and the riser draws one bubble; 4 misses (bubbles in another band or inside rack output stacks); 0-10V ×13, 120V ×13, same-floor Unison ×13 are **library-generated, not extractable** |
| Endpoints | Code, level and count are reliable; **from/to are not** — runs route through vertical trunks between bands; needs line tracing or a vision pass on per-level crops |

Pipeline recommendation: deterministic text parse → OCR fallback → Claude API only for riser endpoints/rack stacks, no-text pages, and floor-plan room locations; structured outputs (JSON schema, GA, `additionalProperties:false`); automatic validation (pooled totals = Σ riser placements; ERP card counts = LVD/RTO accessory qty; faceplates = stations; every EBDK pairs with an ERP; BOM≠riser qty always a conflict, never auto-resolved); human review per level with source crop and confidence; <0.7 or flagged blocks that row only (D11). Cost per project ≈ 180K input / 25K output tokens: **Sonnet 5.5 ≈ $0.61, Opus 5.5 ≈ $1.21, Haiku 5.5 ≈ $0.03**; Batch halves it. Reviewer time, not tokens, is the cost.

## 4. New inputs received this phase

| File | Findings | Consequence |
|---|---|---|
| `15090056-BOM.pdf` (Azle, used as a format example only — D4 stands) | 4 pages, **scanned** (image-only, no text). ETC "Material List" order form: Item / Material (part no., `Model:`, description, `Ship date:`) / Quantity. No VENUE rows, no level or room. Includes non-ETC-device lines (Sensor IQ breakers, outlet boxes, U-bolt kits, distribution). | OCR required (tesseract worked on BOM p.3 at 300 dpi; vision model as fallback). Devices land in the project-wide pool by type. Model filter must handle Sensor IQ/other ETC lines (D12: excluded lines stay promotable). |
| `Level_06M_-_Lighting_Composite_vector.pdf` | 1 sheet, 4235×3605 pt (≈59×50 in), composite of 4 source sheets (Ef.106.5.A/B/D/E) with a magenta boundary layer and pink fill; 2,470 text words, **153,568 line segments**, 1,523 curves, 14 embedded raster images (3 sizes — presumably pasted photos). Text includes grid bubbles (A–H, 1–24 incl. fractional 5.2/6.4/12.8), room codes (XX06M-1E05), room names, and panel tags (CT06LCPA/B, EBDK, UFMP8). No S/D station tags found in the text layer on this sheet. | Grid calibration can be automatic from bubble text positions. 153K segments is a PDFKit performance risk — the tile-pyramid fallback (1b) should be prototyped early on this very sheet. Panel tags are extractable → pre-placement of panels is possible; stations/sensors still placed by hand (as specified). Need to know whether composites are the norm (O5). |

## 5. Decision log (cumulative)

| # | Decision | Status |
|---|---|---|
| D1–D4 | Workbook = schema of record; one cable, two ends; custom app; Azle files not project inputs | From Gate 1 |
| D5–D17 | See §1 | From Q1–Q16 |
| D18 | Export runs server-side (XlsxWriter + WeasyPrint); offline export is not an MVP requirement | Proposed, Phase 2 to confirm |
| D19 | Plan viewer = PDFKit + overlay in page coordinates, tile fallback | Proposed |
| D20 | Sync: decide between GRDB+custom and PowerSync in Phase 2; Realm/ElectricSQL/Firestore excluded | Proposed |
| D21 | Setup pipeline = deterministic parse → OCR → Claude API for geometry/ambiguity, with per-level human review | Proposed |

Assumptions: A1 (clean riser = baseline) confirmed by Q2. A2 (level from riser when BOM pools) confirmed by Q6. A3 (E1–E12 still stand) still open. A4 (MSS) unchanged. A5 new: the team's iPads are recent enough (A12+ / ≥4 GB) — affects 1b risk.

## 6. Open questions for Gate 2

| # | Question |
|---|---|
| O1 | Q8 placeholders: Fixtures / 120v Power / Level XX (not in scope) / Unknown destination — OK, or different wording? |
| O2 | Static numbering (D15) vs "Neuron ID item last" (R3c): when a new punch item is added to a floor later, does it take the next number and sort after the Neuron ID item, or should the Neuron ID item keep a reserved number (e.g. always #99) so it sorts last in the export? |
| O3 | Accessory proposal (P1): add an Accessory record under a device (ERP-FT-LVD, ERP-RTO, faceplates, AD-C18 partition parts) with expected qty from the BOM and found qty from the survey; rule E5 then fires from "LVD expected 2, found 1". Approve adding this entity? |
| O4 | Vocabulary: BOM 15084074 orders P-DOC-C-SR for most floors, the riser and master say P-DOC-C-LR. Which source does the baseline model follow when BOM and riser disagree — riser, with the BOM value kept as a flagged conflict? |
| O5 | Floor plans: is a composite sheet per level (as attached) what you'll always upload, or the individual Ef.106.5.x source sheets? Are the 14 embedded images on it your pasted photos (to be ignored at import)? |
| O6 | Two source discrepancies from 1f: L01 PI1004 (BOM 1, riser 2, master 2) and L03 ceiling sensors (BOM/riser 13, master 9). Is the master count a survey finding (fewer installed) or should the baseline be 13 with 4 "never found"? |
| O7 | A3: confirm rulings E1–E12 still stand. |
| O8 | iPad models on the team (affects 1b risk and the fallback viewer). |
| O9 | For sign-in without roles: a name picked from a team list on each iPad, or individual accounts (email + password)? Attribution needs one or the other. |

## 7. Usage notes

Phase 0 and Phase 1 ran in one conversation; it is now long. Start Phase 2 in a fresh conversation at **High** with web search off (turn on briefly only to verify a fact). Sub-agent reports are summarised above; the 1f report is saved as its own project doc so Phase 2 needs no re-run.

## 8. Next phase block (paste into a fresh conversation)

```
Phase 2: Architecture and data model for the ETC survey iPad app (Gate 2).
Effort: High. Web search: OFF (on briefly only to verify a fact).
Attach: Fable_Prompt_Survey_iPad_App.md, Lighting_Control_Survey_Master_B2-06_4.xlsx. Project docs to read: Gate1_Phase0_Understand.md, Phase1_Research.md, Phase1f_Extraction_Test.md.
Handoff: Gate 1 approved 2026-10-09 with answers Q1–Q16 (Phase1_Research.md §1, decisions D5–D17). Phase 1 complete; proposed D18–D21. Answers to O1–O9: <paste>.
Deliver: recommended stack with trade-off table (sync choice between GRDB+custom field-edit log and PowerSync; server for extraction and export); entity model (stable UUIDs vs display numbers assigned once, versioning, soft deletes, audit events, cable with two ends, accessories if O3 approved, placeholder endpoints per O1, baseline vs as-found, per-level readiness and the Needs-review list per D11); sync/reconcile spec (state machine, conflict rule per field type, review queue, attachments with resumable upload); sign-in without roles (per O9); rule engine (R1–R7, E1–E12, library-generated connections, rulings with preview); import/export spec (PDF BOM text/OCR, riser, floor-plan grid auto-calibration, master xlsx seed import, XlsxWriter export matching the master, WeasyPrint floor PDF); Mermaid diagrams where useful; decisions, open questions, next-phase block for Phase 3.
```
