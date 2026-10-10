# Plan an iPad app for ETC lighting-control installation surveys (offline-first, multi-user)

## Your role
You're the lead architect and orchestrator for a new iPad app that replaces my spreadsheet-based installation-survey workflow. Your job in this conversation is to **produce a build plan, not code**. Work in phases, stop at each approval gate and wait for me. Where you can run parallel workers or sub-agents, split the research workstreams across them; otherwise run them in sequence. Verify anything time-sensitive (framework status, pricing, platform limits) against current sources and cite them.

## About me and the job
- I'm Landry, principal of Luminary Technology & Productions (LTP), an ETC lighting-controls consultant (ETC-certified Echo termination tech; Paradigm and Mosaic experience).
- Current project: installation survey of the ETC lighting-control system at Houston Methodist Centennial Tower. I check what the electrical contractor has installed, record the status, and produce punch lists and missing-parts lists for the EC and ETC.
- Surveyed so far: Levels B2, B1, 01, 02, 03, 04, 06 and 06M. Level 6 is split: 06M is the mezzanine (equipment rack, CT06LCPB, EBDK, CT06LCPA) and 06 holds the field devices. More floors are coming; the riser already shows runs to Levels 09–28.
- Parties: EC (electrical contractor: pulls and lands wire, supplies parts), ETC (manufacturer field service: terminations, commissioning) and the GC. Responsibility labels are EC, ETC and EC/ETC.

## How it works today
1. I walk each floor with an iPad and mark up the lighting floor-plan PDFs by hand: green = complete, purple = installed/untested, red = issue (note written next to it; NI = not installed), yellow = no access. Photos go next to the devices. A device I didn't reach stays unmarked and counts as No access.
2. The riser diagram (PDF) shows the cross-floor cabling. Blue numbers on the verticals are destination levels, and "run" means pulled but not terminated.
3. I transcribe the findings into a workbook per floor (Summary, Devices, Connections, Punch List, Missing Parts, Photo Log), then roll them into one master workbook for all floors (Excel Tables with filters, Summary counts with charts, Change Log).
4. Field updates come back as edited workbooks, with changes highlighted by hand in dark red (some get missed). I edit in Excel for Mac and Excel Online. Everything is reconciled by hand, standing decisions ("rulings") are applied to every floor by hand, and the change log is rebuilt by diffing file versions.
5. ETC separately keeps a Master Site Survey (MSS) commissioning tracker. Survey results get merged into it, with conflicts shown to me first.

### What breaks (the app must remove these)
- Several copies of the truth (floor workbooks, the master, an Excel Online copy) drift apart; reconciliation is manual and highlights get missed.
- One physical cable is two rows (one per floor), and the two ends drift out of sync.
- Renumbering cascades: Missing Parts "Source" refers to punch numbers, and the Neuron ID item must stay last on each floor.
- Vocabulary drifts (ETC/EC vs EC/ETC, Issue vs Not installed for an unpulled cable, "Control wiring" vs "Fixtures").
- Rulings have to be re-applied by hand to earlier floors.
- Spreadsheet limits: dropdown lists get lost as files move between Excel Online and other tools; macros don't run in Excel Online (a macro-driven clickable Summary was tried and rejected); row heights, wrapping and frozen-pane titles render differently in Excel for Mac and Excel Online; iPad photos arrive rotated or as HEIC/MPO.
- There's no audit trail; the change log is reconstructed after the fact.
- There's no signal in basements and electrical rooms, and several people need to work at once.

## Attachments: read these first
- `Lighting_Control_Survey_Master_B2-06.xlsx`: the current master and the schema to start from (about 210 devices, 107 connection rows, 215 punch items, 85 missing parts, 76 photos and 375 change-log entries).
- `riser.pdf`: the riser diagram with my notes.
- If attached: a floor workbook, that floor's marked-up drawing PDF, and ETC's MSS workbook.
- If attached: the project's bill of materials (BOM), plus an unmarked submittal floor plan and riser PDF. These are the setup sources; use them to test the extraction described under Project setup.

Treat the workbook's tabs, columns and vocabulary as the source of truth. Don't invent fields or values unless you flag them as proposals.

## The data as it exists (confirm against the workbook)
- **Level**: code (B2, B1, 01–04, 06, 06M), floor order, surveyed and updated dates.
- **Device**: ID per level (e.g. 01-S15, 06M-04), Level, Category (Relay panel, Foundry panel, EBDK, Equipment rack, NSPS, Touchscreen, Station, Sensor), Device (model, e.g. CT01LCPB Echo relay panel, UFMP4, P-NSPS-D-KIT, PI1002 station, P-DOC-C-LR sensor), Type, Room / Location, Drawing Position (grid), Status, Notes (only what's missing or wrong), Photo.
  - Statuses: Complete · Installed, untested · Issue · Not installed · No access.
- **Connection** (one row per cable end): ID (C-xx per floor; 06 and 06M share one numbering), From, Cable, To, Qty, Status (the device statuses plus Not started, for floors not yet in scope), Note.
  - Cable codes: X = DMX, N = network, U = Unison, P = panic, F = fiber, NG = network + ground, UV = wire to the UHCI-WM partition sensor, plus 0-10V and 120V.
- **Punch item**: # per floor, Level, Device, Item, Type (Missing part, Cable not run, Termination, Wiring, Not installed, Replace Part, Missed Survey, Information, Access), Photo, Owner (EC / ETC / EC/ETC), Tracking status (Open / In progress / Closed), Date closed, Notes.
- **Missing part**: # per floor, Level, Device / Location, Part, Part no., Qty, Owner, Source (punch numbers or device IDs), Part status (Needed / Ordered / On site / Installed), Notes.
- **Photo**: # per floor, Level, Location, Subject, What it shows, Device ID, image.
- **Change-log entry**: Date, Level, Sheet, Ref, Entry, Field, Was, Now, Change type (Field survey, Ruling, Reconcile, Correction, Riser cross-check, MSS ruling, Master edit), Reason.
- **Summary**: device status by floor; outstanding items by floor and by owner; missing parts by floor. Each has a stacked bar chart.

Modeling note: a cable is one physical thing with two ends, which may be on different floors. Model it once (a cable with two ends, each with its own status, note and the person who surveyed it) and generate the per-floor rows from that.

## Rules the app must enforce or automate (my standing rulings)
1. **Device status.** "Installed, untested" means nothing is outstanding on the device. Any outstanding wiring or termination makes it Issue. Nothing in this phase is Complete. A device nobody reached is No access.
2. **Cables.**
   - Status and wording: a cable that isn't pulled is Not installed (note "Not run"). One that is pulled but not terminated is Issue ("Run, not terminated"; DMX adds "no term kit").
   - Destination: the riser governs the To field, and notes keep any guesses about an alternate destination.
   - Single-row cables: the panic wire is always treated as run and stays one row. The 0-10V row reads "Fixtures" and also stays one row.
   - 120V: these rows read "120v Power → <device> Power Supply", because 120V never comes from the NSPS.
   - Unison: each floor's Unison gets its own row.
   - Unchecked ends: an end nobody has checked copies the other end's status if that's known, otherwise it's No access with "Not surveyed". Ends on floors not yet in scope are Not started.
3. **Punch list.**
   - Cables: one "Run …" item per unpulled wire; it becomes a terminate item once the wire is run.
   - DMX terminations: each is its own device-level item (Missing part, EC/ETC, "Waiting on DMX Termination Kits").
   - Every floor's list ends with "Missing all Device Neuron IDs" (Information, EC).
   - No test or commission items.
   - Wording: item text stays short, with qualifiers in Notes. Open questions go in Notes with a "?".
   - Standard wording I reuse, for example:
     - "Replace wire nuts with Wagos (provided in box)"
     - "Re-pull correct wire type (Belden 8471) and re-terminate with Wagos (provided in box); provide ground"
     - "Not installed: install P-NSPS-D and land 120V and Unison wire"
4. **Missing parts.**
   - Owner is EC.
   - DMX termination kits: one per run, named "DMX termination kit - <destination> run".
   - Notes read "Need to be ordered" for parts and kits, or "Confirm whether on site" for devices and backboxes.
   - Re-pulled wire is never a missing part, and network termination kits are never needed.
5. **Floors not yet surveyed.** Far-end terminations, kits and missed-survey items for those floors wait until the floor is surveyed.
6. **Change log.** Every edit to an existing record is logged: who, when, was → now, and the reason or ruling. New records stay in the history but aren't listed in the change log.
7. **Reports.** Each floor gets a findings report plus a punch list. The header shows the survey date only, with no company name.

Ask me before you generalize any rule beyond what's written here or in the attachments.

## Requirements
**Must**
- **iPad-first** (Apple Pencil, camera). It works fully offline for days, stores data locally first, syncs when a connection returns and never loses data. Photo uploads resume if interrupted.
- **Multi-person, internal only.** Several people on my team work on the same project at once, on the same floor or different ones. Every change records who made it and when, and floors can be assigned to people. Keep accounts and permissions simple; ask me what roles I need. EC, ETC and the GC receive exports, not app access.
- **Reconciliation.** Edits to different fields merge automatically. When two people edit the same field, it goes to a review queue that shows both values, who changed each and when, and lets me pick one or combine them. Nothing is silently overwritten, and deletes are soft (recoverable). Optionally, a reviewer approves field edits before they reach the official record.
- **Floor plans.** Plan-first daily use modelled on Fieldwire; see "Daily use" below.
- **Fast field entry.** Status buttons, notes picked from my vocabulary, and a quick photo with caption. Punch items and missing parts are generated from the rules as editable drafts, each citing its rule.
- **Cable/riser view.** Cables grouped by riser vertical, showing both ends, with consistency checks: missing far end, cable type or status mismatch, To not matching the riser.
- **Lint view for gaps.** For example: an NSPS or equipment rack without a 120V row, an Issue device without a punch item, a punch item without an owner, the Neuron ID item not last, or values outside my vocabulary.
- **Dashboard and search.** A dashboard with the Summary counts and charts, plus search, filter and sort across floors by floor, device, status, owner and type. Ask me before adding drill-down links.
- **Rulings.** Record a ruling once and apply it across all floors, with a preview first and a change-log entry.
- **Import and export.**
  - Import the current master and floor workbooks as seed data.
  - Export Excel that matches today's master: the same tabs, Excel Tables with filters, word wrap, two-line titles (subject, then levels), Summary charts and the Change Log. No macros, and it must open cleanly in Excel for Mac and Excel Online.
  - Export a PDF report per floor.

**Should**
- **Neuron ID capture.** Scan or OCR the device labels to close the "Missing all Device Neuron IDs" items.
- **Photos.** Photo markup, correct orientation and HEIC handling.
- **MSS.** Export to or merge with ETC's MSS. Keep prior MSS entries, and turn disagreements into "check" punch items.
- **Peer-to-peer sync.** Evaluate syncing between iPads on site with no internet.
- **Assignments.** Assign floors and items to team members, with an "assigned to me" view.

**Could**
- A web or Mac dashboard for office users, multi-project support, and templates for other ETC jobs.

**Non-functional**
- Plan for the full tower: about 2,000 devices and 10,000 photos per project.
- Internal use only, and no encryption requirement. Don't spend effort on security hardening beyond the simple sign-in that attributes each change. Keep backups and exports so nothing is ever lost.
- Favour reliability over cleverness.

## Daily use: Fieldwire is the model
I like how Fieldwire works day to day: I move around the floor plan, tap a device, and add information and photos about it and its connections. Use that as the pattern for the field app.
- **Plan-first.**
  - Open a level's sheet and pan and zoom smoothly, even on large PDFs.
  - Device pins are coloured by status using my colour code.
  - Filter pins by category, status, owner or open punch items, and search by ID or tag.
- **Device card.** Tap a pin to open its card:
  - status buttons and notes from my vocabulary
  - photos, from the camera or library, with markup
  - its connections, each with status and note, with a jump to the device at the other end, even on another floor
  - its punch items and missing parts
  - its history: who changed what, and when
- **Add on the plan.** Long-press on the plan to add a device that isn't in the baseline (a field addition) or to drop a note or photo.
- **Lists beside the plan.** Devices, connections, punch items and parts, with the same filters, like Fieldwire's task list.
- **Offline.** The plans, records and photos for my assigned floors are cached so the whole loop works offline.

Study Fieldwire closely (plan viewer, pins, photo markup, filters, offline behaviour, permissions) as UX inspiration and copy what works. This is a custom app: don't propose building it on Fieldwire or any other field-management platform.

## Project setup: BOM and riser in, devices and connections out
How I want to start a job: upload the bill of materials (BOM), which lists every device, and the riser, which shows the connections. The app deciphers them into devices and connections.

Use an AI model API for that. For example, the Claude API reads PDFs and images and can return JSON that matches a schema. Verify current capabilities, limits and cost.

**Must**
- **Create a project.** Name, site, parties and levels (codes, floor order, split levels like 06/06M). Copy vocabulary, device types and rulings from a previous project.
- **Inputs.** BOM (Excel, CSV or PDF), riser (PDF, vector or scanned) and the floor-plan sheets (PDF), each sheet assigned to a level.
- **Extraction.** The AI drafts the following, mapped to my vocabulary and my ID scheme (level plus drawing tag for stations and sensors, e.g. 01-S15, B2-D1; level plus a number for panels and equipment, e.g. 01-01):
  - Devices: model, category, type, quantity, and level/room where the BOM says.
  - Cables: type, qty, from device/level and to device/level, with a note when the destination is unclear.
- **Pin placement by hand, from the device list.** A person places each device on the drawing the first time.
  - The extracted devices appear as an unplaced list beside the sheet. The list is per level when the BOM or riser gives the level; otherwise it's a project-wide pool by type (e.g. 120 × PI1002).
  - Pick a device and tap its spot (or drag it on). Placing it sets its level, and I enter or confirm its drawing tag (S15) so the ID follows my scheme.
  - Placed devices drop off the list, with progress shown (e.g. 42 of 57 placed).
  - A device that isn't on the sheet can be flagged rather than placed.
  - Drawing Position fills from the pin location once the sheet's grid is calibrated, or I type it.
- **Cross-check the sources** and list every mismatch:
  - BOM quantity vs riser endpoints, and riser devices missing from the BOM, before commit
  - after placement, devices still unplaced or flagged as not on the sheet, and devices added on the plan that aren't in the BOM
- **Review before commit.** Every drafted device and cable shows its source (BOM line or riser crop) and a confidence flag. I accept, edit or reject, in bulk where possible. Nothing goes into the baseline unreviewed.
- **Device-type library.** Fills the connections the riser doesn't show, as drafts. Examples:
  - a relay panel's 0-10V to fixtures and panic wire to its EBDK
  - Unison from a floor's devices to its P-NSPS-D
  - 120V feeds

  Build the library from this project's data, and ask me before adding anything to it.
- **Where it runs.** Extraction runs at setup time, online and server-side; the API key never sits on the iPad. Field use stays fully offline.
- **Fallbacks.** Spreadsheet/CSV import with column mapping and checks, for this project's master and floor workbooks (and the MSS device tracker only if I choose it), plus adding devices by hand on the plan.
- **Baseline vs as-found.**
  - The reviewed setup is the design baseline (what should be there); the survey records what is actually there.
  - Track separately: devices found on site but not in the baseline (like the partition sensors added on 10/8), devices never found, and status changes.
  - Setup and imports aren't change-logged; edits after the baseline are.

**Should**
- Re-run extraction on a revised drawing set and show what changed against the baseline (devices added, removed or moved; cables changed) for review.
- Copy a typical floor: duplicate a level's devices and connections, renumber them, then adjust.

Ask me what my BOMs look like (format; whether they list devices per floor or room, or only totals), whether the drawings are vector or scanned, and who does setup.

## How to run this
**Phase 0: Understand (Gate 1).** Read the attachments. Deliver a glossary, the entities with their fields and enums as found, the rules list with where each came from, data counts, and your questions, including the project-setup questions above. Then stop.

**Phase 1: Research.** Run these as parallel workstreams and summarize each with sources and dates.
- a. Offline-first sync with multi-user conflict handling on iPad. Evaluate options such as:
  - CloudKit (CKSyncEngine, sharing)
  - SQLite/GRDB or SwiftData with a custom sync service
  - Postgres sync layers (PowerSync, ElectricSQL)
  - Firestore offline
  - Couchbase Lite
  - Ditto (peer-to-peer)
  - CRDTs (Automerge)

  Check which are still supported, because some sync products have been deprecated. Judge them on offline duration, conflict model, attachments, cost, lock-in, maturity and how simple they are to run for a small internal team.
- b. Floor-plan PDFs, pins and Pencil markup on iPad (PDFKit, PencilKit) with large files.
- c. Generating .xlsx with Tables, charts and data validation (on the device or on a server), plus PDF reports.
- d. Fieldwire first, then Procore, Autodesk Build/PlanGrid and others, as UX references only: what they do well, and what this job needs that they don't (two-ended cables, a rule engine, ETC vocabulary).
- e. Label scanning and OCR for ETC devices (Vision/VisionKit).
- f. AI-assisted setup. Run a small test yourself now:
  - Extract cables from the attached riser, and devices from the BOM if attached, into JSON that matches the data model.
  - Compare the result with the master's Connections and Devices tabs and report what it got right, what it missed and the failure types.
  - Then recommend the pipeline: API and model, prompts, schema, validation rules and the review step, with cost per project.

**Phase 2: Architecture and data model (Gate 2).**
- The recommended stack, with a trade-off table.
- The entity model: stable internal IDs vs display numbers, versioning, soft deletes and audit events.
- The sync and reconcile spec: a state machine, a conflict rule for each field type, and attachments.
- Accounts (simple, internal), the rule engine and import/export.
- Diagrams where they help (Mermaid is fine).

**Phase 3: UX (Gate 3).** Wireframes for the key flows:
- Project setup: upload the BOM, riser and plans; review the drafted devices and cables against their sources and the mismatch list; place each device on its sheet from the unplaced list; then lock the baseline.
- The field loop, modelled on Fieldwire:
  - open the project offline, pick a floor, move around the plan and tap a device
  - set status, notes and photos on its card and update its connections
  - preview the punch items and parts it generates.
- The cable/riser view.
- Conflict review.
- The dashboard.
- Rulings.
- Export.

**Phase 4: Delivery plan (Gate 4, before any code).**
- MVP scope: what replaces the spreadsheet loop first, including setup. My preferred setup path is BOM + riser extraction with review; importing this project's master is the seed and the fallback.
- Milestones.
- A test plan that covers:
  - two iPads editing the same floor offline, then syncing
  - surveys done in airplane mode
  - large photo sets
  - an import-then-export round trip compared against the attached master
- A pilot on the next floor survey.
- How to install it on my team's iPads (internal distribution only).
- Risks.
- A task breakdown sized for building with Claude Code, with definitions of done, and the handoff package described under "Moving to Claude Code".

**Rules of engagement**
- Custom app only. Don't propose building on Fieldwire or another field-management platform.
- No code until I approve Gate 4.
- Don't extrapolate beyond the attachments and my answers. Label assumptions and ask.
- Be concise and technical, and prefer tables to prose.
- Keep my vocabulary exactly: status names, owner labels, punch types and ID formats.
- End every phase with the decisions made, open questions, next steps and the "next phase" block described below, then stop.
- Keep a running decision log and a list of assumptions.

## Usage limit, effort and when to move
I'm on a usage limit that the Claude app, Claude Code and Claude Desktop share. Help me make it last: tell me when to change settings or move, because I set effort and start new conversations myself.

**Effort by phase**

| Phase | Effort | Why |
|---|---|---|
| 0: Understand | Medium | Reading and questions |
| 1: Research | Medium (sub-agents low, if they can be set separately) | Tool-heavy; lower effort also means fewer tool calls |
| 2: Architecture and data model | High | Decisions that are expensive to undo |
| 3: UX | Medium | Flows and wireframes |
| 4: Delivery plan | High | Scope, risks and the handoff |

- Effort reference for Claude Fable 5.1: high is the default; medium and low suit routine work; xhigh and max spend the most tokens.
- Don't ask for xhigh or max unless a specific problem fails at high. If one does, say which problem and why before I switch.

**Keep conversations short**
- Run each phase in its own conversation.
- At each gate, give me a "next phase" block that I'll paste into a fresh conversation, containing:
  - the effort level to set
  - which files to attach (only what that phase needs; often just the master, riser and BOM)
  - whether web search should be on (only in Phase 1, or briefly in Phase 2 to verify a fact)
  - a compact handoff: decisions so far, assumptions, open questions, and the outputs that phase needs
- If a phase is running long, tell me early and give me the handoff so I can continue in a new conversation.

**Moving to Claude Code**
- Switch to Claude Code only after I approve Gate 4, when it's time to write code. Phases 0–4 stay in the Claude app.
- Claude Code has to run on my Mac, because building and testing an iPad app needs Xcode on macOS.
- Gate 4 ends with a handoff package as repo-ready markdown files:
  - `CLAUDE.md`: project context, my vocabulary and rules, conventions, and how to build and test
  - `PLAN.md`: architecture, data model, sync and reconcile spec, import/export spec
  - `DECISIONS.md`: the decision log and assumptions
  - `TASKS.md`: ordered tasks, each with its definition of done and suggested effort
  - the prompt for the first Claude Code session
- In Claude Code, run one task per session. Use medium effort for routine tasks, and high for sync, conflict handling and the Excel export.
- Usage also depends on the model. Keep Fable for planning and the hard problems, and mark tasks a lighter model can handle.

## Success looks like
- A new project is set up by uploading the BOM, riser and plans. The AI drafts the devices and cables, I review and fix them and place each device on the drawings from the list, and the baseline is ready without typing every device and cable.
- A floor survey is captured once on the iPad, offline, and the all-floor dashboard, master export and change log update themselves.
- Two people can edit the same floor offline and reconcile without losing anything.
- The exported workbook is close enough to today's master that the EC, ETC and GC teams don't notice the switch.
- Rulings and consistency checks replace reconciling by hand.
