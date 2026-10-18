# fixtures/ — golden test inputs (private repo)

| File | Role |
|---|---|
| Lighting_Control_Survey_Master_B2-06_4.xlsx | Master workbook: schema of record (D1); TP-4 round-trip target. **Add from your files.** |
| riser.pdf | ETC riser dwg 001–002 rev F: cable extraction input (TP-9). **Add from your files.** |
| BOM.pdf | ETC BOM, 4 jobs, 6 pp (p.3 image-only): device extraction input (TP-9). **Add from your files.** |
| Level_06M_-_Lighting_Composite_vector.pdf | 06M composite plan; **save it under exactly this name (underscores, no spaces)**: plan-viewer performance test (TP-6) and grid calibration test. **Add from your files.** |
| 15090056-BOM.pdf | Azle Material List — **format example only, never a project input (D4)**. **Add from your files.** |
| Lake_Dallas_CTE_Punch_List_ETC_Updated_20251030.pdf | Fieldwire punch-list export — layout reference for the floor PDF (D66, T59). Included. |
| master-ops.json | The master's op log as a client pulls it after the seed import (1,461 ops): TP-8 rule golden tests (T35, `packages/rules/src/golden/master.test.ts`). **Generated** by `server/tests/dump_master_ops.py` — regenerate after a seed-import change, never edit by hand. Included. |
| DaVinci_categories.xlsx | ETC DaVinci product library (2,470 types, library timestamp 2026-10-13) grouped by Landry into our device categories on 2026-10-16 (D196): the category mapping the DaVinci library import reads (T111). Source `library.json` is the one DaVinci writes to `%LOCALAPPDATA%\ETC\DaVinci\` at launch; regenerate the Types/Categories tabs with a fresh copy when ETC's library changes. Included. |
| davinci-library-sample.json | Trimmed DaVinci `library.json` (37 types, 221 KB): the seven golden types of T111 (P-NSPS-D, EBDK, UHCI-WM, ERn2-W-120 Mk2, P-TS7-E, UH10002, ERP-FT-LVD), the NSPS kit, one ERP-FT panel and every accessory they reference, with only the constants, property types, scripts and documents they use. **Generated** by `server/tests/make_davinci_sample.py <library.json>` — regenerate when ETC changes those types, never edit by hand. Included. |

Phase1f_Extraction_Test.md (the extraction test report) belongs in docs/history/ if you still have it; TASKS T42 cites its counts.
