# On-device test log

Archive of finished rounds from [ON_DEVICE_CHECKLIST.md](ON_DEVICE_CHECKLIST.md), newest first. Each round is copied here with the results as Landry filled them in. Earlier checks recorded directly in `TASKS.md` (T07, T17, T64) are not repeated.

## 2026-10-12 — round of 2026-10-11 completed (dev build `5975c04e`, `main` d9b4d91)

Landry ran the sheet (https://claude.ai/artifact/Bu78oW1sECp53FYguBJMAe) after the T41 deploy and the Tower seed import. 54 pass, 1 fail, 17 skip, 0 not done. No Decision line was answered, so D127, D123 and D111–D115 stay Proposed. Most skips have one cause: a level without a display sheet does not open from the Levels screen, so no real level could be opened (T71); plan-dependent steps wait for T45.

| Step | Result | Saw | Finding |
|---|---|---|---|
| S-1 … S-3 | pass | | |
| P-1, P-2, P-4, P-5, P-9 | pass | | |
| P-3 | pass, with a note | Keyboard covers the Add level field and the page cannot scroll to it. Enter should keep focus in the field and scroll down so floors can be added in a row | **T66** |
| P-6 | pass, with a note | Remove the description under the page header | **T66** |
| P-7 | pass, with a note | "far end" under a switched-off In scope is unclear; asked what numbering groups are | Explained in the session reply; label and an inline explanation in **T66** |
| P-8 | pass, with a note | Remove the "each field saves when you leave it" note | **T66** |
| P-10 | skip | | second iPad not used; carried over |
| P-11 | pass, with a note | The In scope switch is hard to hit and does not always register; asked what "Split of" does | Explained in the session reply; larger hit area and inline help in **T66** |
| P-12 | pass, with a note | A change made on the server took 20–30 s to show; wants it faster | The engine syncs every 60 s while open, plus on foreground and after a local edit. **T67** |
| T25-1 … T25-3, T25-5, T25-10 … T25-12 | pass | | |
| T25-4, T25-6 … T25-9 | skip | "Can't do yet. There is no plan." | Need a real level that opens (T71) and, for downloads, a display sheet (T45); carried over |
| T26-1 … T26-8 | skip | | Need two iPads on a real level (T71); carried over |
| T20-1 … T20-3, T20-5 … T20-8 | pass | | |
| T20-4 | pass, with a note | Not every device has a Neuron ID (equipment rack, NSPS); needs an on/off per library device type | **T68** (library flag; the R3c Neuron ID item must respect it) |
| T20-9 | pass, with a note | The keyboard does not cover the field but covers the Neuron ID Save button | **T66** |
| T21-1 … T21-4 | pass | | |
| T21-5 | **fail** | Photos linked to a connection don't link to the connection; they link to the device no matter what | The photo row does store `cable_end_id` (one link per photo plus its device, D112), but the end editor has no photo strip and the card's thumbnail shows no link, so the link is invisible. **T65** |
| T21-6 | skip | | needs a real level (T71); carried over |
| T22-1 … T22-7 | pass | | |
| T23-1 … T23-5, T23-7 | pass | | |
| T23-6 | skip | | needs a real level with a plan (T45); carried over |
| T24-1 … T24-4, T24-6 | pass | | |
| T24-5 | pass, with a note | Wants to pan with two fingers while ink is selected | **T69** (native patch, new dev build) |
| T24-7 | pass, with a note | Wants the long-press menu to show before lifting, dragging to fine-tune the spot, and the blue dot draggable after the menu is open | The first two were built for build `5975c04e` (`pageLongPressMove`/`End`); they did not show in this run. **T70** checks why and adds the draggable dot |
| T24-8 | skip | | needs two iPads on a real level with a plan; carried over |

## 2026-10-11 — partial pass, stopped early (dev build `5975c04e`, `main` 4349ca0)

Landry ran the sheet (https://claude.ai/artifact/XhE69ZqWx7osFK6bdPqVTp) up to T25 and T20-1, then stopped because sync looked wrong. 8 pass, 3 fail, 12 skip, 38 not done. No project existed on the iPad (that arrives with T41), so sync had nothing to do; the demo plan lives in its own never-synced database (D101).

| Step | Result | Saw | Finding |
|---|---|---|---|
| S-1 … S-3 | pass | | |
| T25-1, T25-2 | pass | | |
| T25-3 | **fail** | turning off Wi-Fi and cellular does not stop it saying synced and online | With no project the engine made no request, so it never learned it was offline. **Fixed:** a cycle with nothing to sync now pings `GET /health`; the Connection section says why "Synced" is vacuous without a project. The step also used the demo plan for pending edits, which never counts: step rewritten (real level only). |
| T25-4, 6, 7, 8 | skip | | need a real level |
| T25-5 | **fail** | stays as "Downloading plans for your assigned levels", no change after | The message was a fixed string; nothing was downloadable. **Fixed:** the button is greyed with no levels and the message states how many files were queued. |
| T25-9, T25-10 | pass | | |
| T25-11 | pass, with a note | the login background is dark and the text is black, impossible to see | iPad in dark mode: the Connect/Picker screens had no background or text colour. **Fixed:** explicit light colours. Follow-up: `userInterfaceStyle: "light"` in `app.json` (needs a build) so no screen inherits a dark window. |
| T26-1 … T26-8 | skip | | need two iPads on a real level |
| T20-1 | **fail** | log line shows up but says not synced on the status box | Expected on the demo (never syncs); step text clarified. Not a defect. |
| T20-2 … T24, decisions | not done | | |

Fixes committed the same day (see TASKS.md "2026-10-11 iPad round" follow-ups). The round continues on the same sheet once T41 puts a project on the iPad.

