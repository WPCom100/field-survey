# TP-5 — the exported workbook opens cleanly in Excel (T30, D72)

The master workbook the server exports (T29, PLAN §7.6) must open in **Excel Online** and
**Excel for Windows** without a repair prompt, with working dropdowns, readable wrapping and row
heights, and rendered charts. **Excel for Mac** is checked whenever a Mac is available (D72).
TP-4 (`server/tests/test_export.py`) already proves the cells, styles, tables, validations and
charts equal the master's; TP-5 proves Excel agrees.

## 1. The file under test

| | |
|---|---|
| File | [`tp5/tp5_export.xlsx`](tp5/tp5_export.xlsx) (1,111,099 bytes) |
| SHA-256 | `edd9866c06f35e26908d7fad237866ed6f571c6954646e3a7b3e672a2ac3508d` |
| Made | 2026-10-12, commit of T30, from the T29 export code: the TP-4 test imports `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx` into a fresh project and exports it |
| Contents | 7 tabs (Summary, Devices 210, Connections 107, Punch List 215, Missing Parts 85, Photo Log 76 with pictures, Lists); 4 charts; 5 Tables |

Remake it after any change to the export code, then update the SHA-256 above:

```
cd server
TP5_OUT=../docs/test/tp5/tp5_export.xlsx uv run pytest -q -k tp4
uv run python tests/tp5_precheck.py ../docs/test/tp5/tp5_export.xlsx
sha256sum ../docs/test/tp5/tp5_export.xlsx
```

From real data instead (the Droplet, after the T29 deploy and `alembic upgrade head` 0003):
`docker compose exec worker python -m app.jobs.exports <project_id> --out /tmp/master.xlsx --user Landry`,
then `docker compose cp worker:/tmp/master.xlsx .`. The Tower project was imported before T29,
so its Punch List Device column is generated, not the master's text (TASKS follow-up); that does
not matter for TP-5.

## 2. Automated pre-check (done on the PC)

`server/tests/tp5_precheck.py` looks for what makes Excel say *"We found a problem with some
content… Do you want us to try to recover as much as we can?"*: unparsable or untyped package
parts, broken relationships, table headers that differ from their cells, overlapping tables and
merges, invalid sheet/table/defined names, style or dxf indexes out of range, strings over 32,767
characters, formulas over 8,192, validation lists over 255, row heights over 409 pt, widths over
255, chart series pointing at missing sheets. The TP-4 test runs it on every export, and
`test_tp5_precheck_catches_repair_causes` proves it catches a bad header and an impossible row
height.

| File | Result (2026-10-12) |
|---|---|
| `tp5/tp5_export.xlsx` | ok, no problem found |
| `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx` (reference) | ok, no problem found |

The pre-check cannot see rendering (charts, wrapping, pictures) or Excel Online's own limits, so
the manual run below is still needed.

## 3. Manual run (Landry, on a PC with Excel)

How to open it:

- **Excel Online:** upload `tp5_export.xlsx` to OneDrive (or SharePoint), open it in the browser.
- **Excel for Windows:** download the file and double-click it. If it opens in Protected View,
  click *Enable Editing* (that bar is normal for downloaded files and is not a repair prompt).

Screenshots go in `docs/test/tp5/` named `online-<n>.png` / `windows-<n>.png` with the step
number (Win + Shift + S, then paste into Paint and save). Mark each cell `pass`, `fail: <what you
saw>` or `skip`.

| # | Step | What you should see | Excel Online | Excel for Windows | Excel for Mac |
|---|---|---|---|---|---|
| 1 | Open the file | No "We found a problem with some content" / repair dialog; no "Repaired Records" message. **Screenshot of the first screen** | | | pending — no Mac |
| 2 | Tabs | Summary, Devices, Connections, Punch List, Missing Parts, Photo Log, Lists, in that order; no Change Log (D51) | | | pending — no Mac |
| 3 | Summary numbers | A1 `ETC Lighting Controls Survey`, A2 `Levels B2-06`; the four tables show counts at once (not zeros, not `#VALUE!`); press F9 (Online: edit any empty cell and undo): the numbers stay the same. **Screenshot** | | | pending — no Mac |
| 4 | Charts | Four stacked column charts at J6, F18, F30, G42, each with its legend and colours (green / purple / red / …), none blank. **Screenshot of each** | | | pending — no Mac |
| 5 | Dropdowns | Devices: click any Status cell (column H) → arrow → 5 values `Complete` … `No access`. Connections Status (G) → 6 values incl. `Not started`. Punch List Tracking status (H) → `Open` · `In progress` · `Closed`. Missing Parts Part status (I) → `Needed` · `Ordered` · `On site` · `Installed`. Pick a different value, then Ctrl+Z. **Screenshot of one open list** | | | pending — no Mac |
| 6 | Wrapping and row heights | Devices Notes (I), Connections Note (H), Punch List Item/Notes (D, J): long texts wrap inside the cell and no row cuts a line in half or leaves a big empty gap. **Screenshot of a screenful of Punch List** | | | pending — no Mac |
| 7 | Frozen panes | On each data tab scroll down and right: rows 1–3 and columns A–B stay in place | | | pending — no Mac |
| 8 | Table filters | Devices header arrows: filter Status = `Issue`, then clear; the table's banding/borders look like the master's | | | pending — no Mac |
| 9 | Photo Log pictures | Column H shows a 320×240 photo on each row, inside its row (not overlapping the next row). **Screenshot** | | | pending — no Mac |
| 10 | Dates | Punch List Date closed shows `yyyy-mm-dd` dates where set; Summary Surveyed/Updated show the floor dates as text | | | pending — no Mac |
| 11 | Print preview | File → Print on Punch List: landscape, one page wide, row 3 (headers) repeated on every page | | | pending — no Mac |
| 12 | Save and reopen | Excel for Windows: Save, close, open again: still no repair prompt. Online: it autosaves; close the tab and reopen | | | pending — no Mac |

Result: write the overall verdict and the date here, then say **"TP-5 done"** with this table
pasted back; any fail becomes a fix in `app/jobs/export_xlsx.py`, the file is remade, the
pre-check and TP-4 are re-run, and the failed rows are tested again.

| Environment | Verdict | Date | Excel version |
|---|---|---|---|
| Excel Online | | | |
| Excel for Windows | | | |
| Excel for Mac | pending — no Mac (D72) | | |
