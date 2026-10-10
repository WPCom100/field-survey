# Test 1f — Riser + BOM → master device/connection records (2026-10-09)

Scope: Houston Methodist Centennial, jobs 15076538/39 and 15084073/74. Levels compared: B2, B1, 01, 02, 03, 04, 06, 06M. Files: `bom_lines.json` (258 lines), `device_drafts.json` (113 drafts, 56 accessory lines, 17 excluded), `riser_extract.json`, `comparison.md`.

## 1. What the inputs actually are

| Input | Text layer | Consequence |
|---|---|---|
| BOM pp.1, 2, 4–6 | Real text; pp.4–6 have doubled title-block glyphs (two title blocks overprinted) | pdfplumber words + per-page header-derived column bands; `dedupe_chars()` |
| BOM p.3 (job 15084073, Floors 1/2/9/10/15/16/19/20, two columns) | **None** — table is 5,455 vector curves | Rendered 300 dpi, two column crops, tesseract `--psm 6`; one systematic fix (`P11002`→`PI1002`); 67/67 lines recovered, verified against the image |
| Riser sheet 001 (B2–12) | Text, but overlaid duplicate glyphs fragment some labels (`C T 0 4 LC P B`); "LEVEL 03" label itself is outlined | Fragment-merge pass; level bands from the 10 long horizontal separator lines; missing label inferred by interpolation |
| Riser sheet 002 (14–28) | **None** — only title block + legend are text (81 words) | Not parseable from text; needs OCR or a vision model |

Riser legend note: the bubble letter is a **wire identification number, not a quantity** (sheet 002 legend). Bubbles are stadium outlines drawn as ~50 tiny curve fragments; counting fragments within 10 pt of a lone X/U/P/N/NG/F/UV token separates cable bubbles from the "WHT / F" finish labels under every station.

## 2. BOM → device drafts

Rules applied: ETC devices only; faceplates (1IFP), ERP-FT-LVD, ERP-RTO, URTO, ERM VDK, DIN14, P-LCD-FBB, through-beam AD-C18 parts → `accessories` attached to parent lines in the same job+venue; 19 rack component lines per rack → one "Equipment rack" draft; energization/engineering/manuals/DATA TERM/hardware kits/brackets excluded. Models normalised by stripping `-4Z/-4/-5`.

Level assignment: VENUE naming one floor → level; pooled venues (`Level B2 - 12`, `Level 14 - 28`, `Level 16, 22`, `Link to P-CCS in other building`) → `level=null`, confidence halved.

## 3. Riser → devices and cables (sheet 001 only)

Per band: `CTxxLCPA/B` + `ECHO ERP-FT-xx1P` + card lines (`2 - ERP-FT-LVD`, `1 - ERP-RTO`) folded into one panel; `EBDK`, `UFMP4/8`, `EQUIPMENT RACK - 18U`, `PARADIGM …` symbols with `QTY: nn` matched by centre-x (left-x matching mis-assigned ~40% of callouts). Result: every device count on levels B2–06 matches the drawing after the centre-x fix. Pooled BOM totals reconcile exactly with riser placements (ERP24 9, ERP48 6, EBDK 15, UFMP8 5 across B2–12) — a useful cross-check rule.

Cables: code, level and bubble count are reliable. **Endpoints are not**: the nearest-label-on-the-same-row heuristic gets rack output labels right (`DMX TO B3A CANYON`, `TO EQUIP RACK LEVEL 06`, confidence 0.8) but mis-assigns most ERP/UFMP/NSPS runs because they route through vertical trunk lines between bands. This needs line tracing (pdfplumber exposes 4,756 line segments) or a vision pass.

## 4. Comparison vs master

Devices (level + model), 54 keys:

| Result | Keys | Classification |
|---|---:|---|
| Hit, BOM direct | 25 | — |
| Hit via vocabulary map | 8 | BOM `P-DOC-C-SR`→master `P-DOC-C-LR`; `P-DOC-W-WD`→`P-DOC-W`. Riser uses LR throughout; master follows the riser |
| Miss: pooled venue | 16 | All ERP/EBDK on B2–06M, UFMP8 06M, P-TS7-E ("Link to P-CCS"). **Riser places all 16 correctly** → hits in a merged pipeline |
| Miss: rack under "Level 5" | 1 (+1 extra) | BOM `Level 5` rack = master 06M rack; riser band 06 |
| Miss: 06 vs 06M | 0 after merge | Riser has one band 06; master splits stations (06) from mezzanine panels/rack (06M). Needs a level-alias table |
| Miss: accessory granularity | 1 | Master lists "Partition sensors" as a device; BOM has AD-C18 emitter/receiver as UHCI-WM accessories |
| Qty mismatch | 2 | 01 PI1004: BOM 1 / riser 2 / master 2 (BOM–riser conflict). 03 ceiling sensors: BOM 13 (11 LR + 2 SR) / riser 13 / master 9 (survey found fewer — real finding, not an extraction error) |

Merged BOM+riser device recall on these levels: 50/54 keys exact; remaining 4 are the two qty conflicts, the partition-sensor granularity and the 06M rack label.

Connections (level + code), master qty summed:

| Result | Keys | Notes |
|---|---:|---|
| Hit | 14 | All P (panic is drawn — one bubble per EBDK — so it **is** extractable, contrary to the brief's assumption), F, UV on 04, X on B2/B1/04, N on B2 |
| Qty mismatch | 7 | 01 X 12 vs 8; 02 X 6 vs 2; 03 X 8 vs 6; 06M X 11 vs 8; 06M N 11 vs 2; 01 N 3 vs 2; 01 NG 2 vs 1. Cause: master books each run **from both endpoints** (01 C-02 and C-18 are the same cable) and books cross-level runs on both levels; the riser draws one bubble per run, at one end |
| Miss | 4 | 02/03/04 N, 06M UV: bubbles drawn in another band or inside the rack output stack (geometry) |
| Library-generated, not extractable | 13 + 13 | 0-10V ×13, 120V ×13 rows; plus same-floor Unison bus rows (qty blank) ×13 — riser U bubbles (27) are per-device-type chain links, not runs |

Failure-type summary: pooled venue (16), perspective double-booking (7), model vocabulary (8), geometry-only endpoints (most runs), OCR-required pages (BOM p.3, riser 002), rack level alias (1), 06/06M split (5), accessory granularity (1), source conflicts (2).

## 5. Recommended pipeline

1. **Deterministic first** (what this test did): pdfplumber words → header-derived column bands (BOM) / separator-line bands + regex + QTY centre-x matching (riser). Zero cost, fully reproducible, carries `source_ref` (job/page/line or sheet/bbox).
2. **OCR fallback** for pages with no text layer (tesseract at 300 dpi worked for BOM p.3; apply to riser 002 per band crop).
3. **Claude API** for (a) riser endpoints and rack output stacks — send each level-band crop (≤2000 px wide) with the deterministic device list and ask for `cable_drafts`; (b) scanned/outlined pages when OCR confidence is low; (c) floor-plan sheets (station/sensor room locations, which neither BOM nor riser carry — all 150 master `Room / Location` values come from plans or site).
   - PDF input: all active models; 600 pages/request (100 under a 1M context), 32 MB request; each page = extracted text (1,500–3,000 tokens) + page image; base64/URL/Files API. [1]
   - Structured outputs: GA, `output_config.format = {type: "json_schema", schema}` (no beta header); `additionalProperties:false` required; no `minimum/maximum`, recursion or external `$ref`; works with Batch API. [2]
   - Images: `⌈w/28⌉×⌈h/28⌉` tokens; long edge 2576 px on 4.7+ (cap 4,784 tokens); >20 images/request → each ≤2000 px. [3]
   - Models/prices (per MTok, 2026-10-09): Haiku 5.5 $0.10/$0.50 (≤100K prompt); Sonnet 5.5 $2/$10; Opus 5.5 $4/$20; Fable 5.1 $10/$50; Batch −50%. IDs `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`; all 1M context, 128K output. [4][5]
4. **Validation rules** (automatic): pooled-venue totals = Σ riser placements per model; ERP card counts (riser) = ERP-FT-LVD/RTO accessory qty (BOM); faceplate qty = station qty per venue; every EBDK pairs with one ERP on the same level; every NSPS/ERn4 has an N run; each riser X bubble yields two connection rows (one per endpoint) to match master convention; model vocabulary table (`SR→LR`, `W-WD→W`); level alias table (`Level 5`→06M, `FLOOR 6`→06/06M by category); flag any BOM≠riser qty as a conflict, never auto-resolve.
5. **Human review**: a per-level diff sheet — proposed row, source ref/crop thumbnail, confidence, conflict flags. Reviewer accepts/edits; anything <0.7 or flagged is blocked until reviewed. Library-generated rows (0-10V, 120V, bus U) are emitted from the device-type library, marked `library`, and never claimed as extracted.

### Proposed schema (abridged; `additionalProperties:false` everywhere)

```json
{"device_drafts":[{"level":"01|null","model":"PI1104","model_raw":"PI1104-4Z","category":"Station",
  "qty":15,"name":"CT01LCPB|null","accessories":[{"model":"ERP-FT-LVD","qty":2}],
  "source":{"kind":"bom_line|riser_crop","job":"15084073","page":3,"line":80,
            "sheet":1,"bbox":[1384,1942,1464,2012]},
  "level_basis":"single-floor venue|riser band|inferred","extraction":"text|ocr|model",
  "confidence":0.93,"conflicts":["bom_qty!=riser_qty"]}],
 "cable_drafts":[{"level":"01","code":"X","qty":1,"from":"CT01LCPB","to":"Equipment rack",
  "to_level":"01","origin":"riser|library","source":{"sheet":1,"bbox":[1240,1950,1262,1964]},
  "confidence":0.6}]}
```

### Cost per project (6 BOM pages, 2 riser sheets, 4 floor-plan sheets)

| Stage | Input tokens | Output tokens | Basis |
|---|---:|---:|---|
| BOM p.3 only (others deterministic) | 3,500 | 3,000 | 1 page ≈ 2,000 text + 1,568 image; 67 lines × ~45 |
| Riser: 25 band crops | 25 × (1,700 img + 800 prompt) = 62,500 | 25 × 400 = 10,000 | crop 1825×675 px → 66×25 = 1,650 tokens |
| Floor plans: 4 sheets × 6 tiles (2000×1500 px) | 24 × (3,888 + 800) = 112,500 | 24 × 500 = 12,000 | 72×54 patches |
| **Total** | **≈178,500** | **≈25,000** | |

Sonnet 5.5: 0.1785 × $2 + 0.025 × $10 = $0.36 + $0.25 = **$0.61**. Opus 5.5: $0.71 + $0.50 = **$1.21**. Haiku 5.5: $0.018 + $0.013 = **$0.03**. Batch halves these; a second verification pass doubles them. Even a two-pass Opus run is under $3 per project; the cost driver is reviewer time, not tokens.

## Sources

1. PDF support — https://platform.claude.com/docs/en/build-with-claude/pdf-support (fetched 2026-10-09)
2. Structured outputs — https://platform.claude.com/docs/en/build-with-claude/structured-outputs (2026-10-09)
3. Vision / image tokens — https://platform.claude.com/docs/en/build-with-claude/vision (2026-10-09)
4. Pricing — https://platform.claude.com/docs/en/about-claude/pricing (2026-10-09)
5. Models — https://platform.claude.com/docs/en/about-claude/models (2026-10-09). Note: `/about-claude/models/overview` served a stale table (Sonnet 4.5/Haiku 4.5/Opus 4.1) on the same day; the models and pricing pages agree with each other and were used.
