# On-device test log

Archive of finished rounds from [ON_DEVICE_CHECKLIST.md](ON_DEVICE_CHECKLIST.md), newest first. Each round is copied here with the results as Landry filled them in. Earlier checks recorded directly in `TASKS.md` (T07, T17, T64) are not repeated.

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

