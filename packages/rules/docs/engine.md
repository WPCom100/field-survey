# `packages/rules` engine (T33) and rules (T34)

How rules run on the iPad. Normative references: PLAN §6 (rule engine), CLAUDE.md §4 (rules
produce proposals and findings, never records except on Accept — with D170's one exception),
D24 (client only), D169 (deterministic proposal ids), D170–D173 and D175 (T34's readings).

## Files

| File | What |
|---|---|
| `src/snapshot.ts` | `Snapshot` (one array per table, client columns, deleted rows included) and `indexSnapshot()` (maps by id, by level, by device, ends per cable, `otherEnd()`, records by proposal). |
| `src/rule.ts` | `Rule { id, title, text, lints?, run(ctx) }`, `RuleContext { snap, index, propose(), find() }`, keys and ids. |
| `src/evaluate.ts` | `evaluate(snap, rules)`: runs every rule, dedupes by key, hashes inputs; a throwing rule is reported, not fatal. |
| `src/reconcile.ts` | The state machine as pure diffs: existing rows + this run's output → `create` / `set` changes. |
| `src/decide.ts` | What an Accept creates per proposal `kind` (`acceptPlan`), the keys an Edit form offers, `recordDiffers`. |
| `src/engine.ts` | `RuleEngine` over a core `Store`: `loadSnapshot`, `run`, `decide`, `explain`, `openProposals`, `openFindings`. |
| `src/hash.ts` | SHA-256 (pure TS), `stableStringify`, `hashUuid` (UUID v8 from a hash). |
| `src/rules/index.ts` | `RULES`, the registry the app runs, and the rule exports. |
| `src/rules/shared.ts` | Helpers: signal words, `targetOf` (how item text names the far end), `terminationItem`, `waitsForSurvey` (R5), level / ID ordering. |
| `src/rules/r1.ts` … `e5.ts` | The rules, one file per family (below). |
| `src/rules/quick.ts` | Quick actions E6 / E7 / E9: `runQuickAction(editor, deviceId, action)` writes the records at once (a person tapped). |
| `src/testing/sample.ts`, `src/testing/build.ts` | A two-device snapshot with two sample rules, and the snapshot builder the rule tests use. |

## The rules (T34)

| Rule | Kind | What it does |
|---|---|---|
| R1 | findings `R1.untested` / `R1.no_item` / `R1.complete` | `Installed, untested` with an end `Not installed`/`Issue` or an open wiring item; `Issue` with no open item; `Complete` while `project.settings.completion_phase` is not true. |
| R2a | finding | A note contradicting the status ("Not run" on a non-`Not installed` end, "Run, not terminated" on a `Not installed` one, "no term kit" on a non-DMX cable). Never writes a note (D172). |
| R2b | finding | `riserCheck` (core) says the A end's To text differs from `cable.riser_to_label`. |
| R2c | `cable` drafts, per Relay panel | 0-10V → `Fixtures` and P → `EBDK panic wire` (single rows; P `Installed, untested`, derived), paired to the EBDK with the same `panel_name`. Skipped when the device already has an end of that code. |
| R2d | `cable` draft, per NSPS / rack | 120V: `120v Power` → `P-NSPS-D Power Supply` / `Equipment rack` (D52). |
| R2e | `cable` draft, per in-scope level | One Unison pair `Stations & Sensors` ↔ the level's NSPS (else its rack): host end `Unison from stations & sensors`, bus end `Devices to P-NSPS-D` / `Devices to equipment rack`. Skipped when the level has any U end. |
| R2f | `status` draft `Not started` (derived) | An unsurveyed end on an out-of-scope level, or whose far end is on one (or a `level_not_in_scope` placeholder). Nothing is ever copied (D171). |
| R3a | `punch` draft on the end | `Not installed` → `Run <signal> to <far end>` (`Cable not run`, `EC`); 0-10V reads "Run and land 0-10V control wiring". `Issue` + "not terminated"/"not landed"/"needs landing" → `Terminate <signal> to <far end>` (`Termination`; "Land 0-10V control wiring", "Land 120V power"), discriminator `terminate`, owner per D175 (3). Gated by R5; skipped when an open item with the same text exists. |
| R3b | `punch` draft on the device, discriminator = end id | DMX end `Issue` "no term kit" → `Terminate DMX to <far end>`, `Missing part`, `EC/ETC`, Notes "Waiting on DMX Termination Kits". Gated by R5. |
| R3c | `punch` draft on the numbering group + **upkeep** | "Missing all Device Neuron IDs", `Information`, `EC`, `sort_last`, `device_text` "All devices", Notes = missing IDs, on the group's first level. Once an item exists (accepted, or the master's), `ctx.maintain` rewrites Notes, closes it (date = today) when empty, reopens it on a new device without an ID (D170). |
| R3d / R3f | findings on the item | "test"/"commission" in the text; text outside `vocab(punch_item)` when that list exists (rule-made items exempt). |
| R4a / R4d | findings on the part | Owner ≠ `EC`; re-pulled wire (Belden, re-pull) or a network termination kit as a part. |
| R4b | `part` draft on the device, discriminator = item id | An open DMX-kit item (`rule_id` R3b or Missing part + the Notes phrase) with no part sourced to it → "DMX termination kit - <destination> run", Qty 1, `EC`, `Needed`, "Need to be ordered", `sources: [{punch, item}]`. |
| R4c | helper | `defaultPartNotes('part' | 'device')` → "Need to be ordered" / "Confirm whether on site" for the part editor. |
| R5 | gate | `waitsForSurvey(end)`: level `surveyed` null and the end never surveyed on an iPad → R3a / R3b / R4b stay quiet for that end. |
| E5 | `status` draft on the 0-10V end + `punch` draft on the device | ERP-FT-LVD found < expected → end `Issue` with `extra {note: "Not landed", status_source: derived}`; "Land 0-10V control wiring" (`Wiring`, `EC`) unless R3a's Termination branch already raises it. |
| Acc | finding, discriminator = accessory id | Any accessory found < expected (D52). |
| E6 / E7 / E9 | quick actions | See `quick.ts`: Spot-check fixed, Non-ETC device (make), Relocated (new room). |

Upkeep (D170) is the one output a rule applies without an Accept: `ctx.maintain({entity, id,
fields, proposal_id, why})`. The engine writes the changed fields as one group per record,
`Field survey`, reason `Rule engine <rule_id>`, carrying `proposal_id`; unchanged values write
nothing, and `recordDiffers` ignores maintained fields so the row stays `accepted`, not `edited`.

## Writing a rule

```ts
export const R3a: Rule = {
  id: 'R3a',
  title: 'Cable not run',
  text: 'One "Run …" item per unpulled wire, Cable not run, EC, on the surveyed end only.',
  run(ctx) {
    for (const end of ctx.index.cableEnd.values()) {
      if (end.status !== 'Not installed') continue;
      ctx.propose({
        subject: { entity_kind: 'cable_end', entity_id: end.id, level_id: end.level_id },
        kind: 'punch',
        payload: { item: `Run ${code} to ${target}`, type: 'Cable not run', owner: 'EC', device_id: end.device_id, cable_end_id: end.id },
        inputs: { status: end.status, target },          // what the proposal depends on
        why: `${end.to_text} is Not installed.`,           // "why?" on the card
      });
    }
  },
};
```

`ctx.now` / `ctx.today()` give the run's clock (never put it in `inputs`); `ctx.maintain(...)` is
upkeep (D170, R3c only so far).

- A rule reads the snapshot and index only; it never touches a store. It must be
  deterministic: the same snapshot gives the same output on every iPad.
- **Key** = `(rule_id, subject, discriminator)`. One proposal per key per run; use
  `discriminator` when a rule makes several proposals on one subject (`'U run'`, a cable code).
- **`inputs`** (default: the payload) is hashed into `inputs_hash`. Put in it exactly the facts
  the proposal follows from: a rejected proposal stays rejected while the hash holds and
  comes back when it changes. Do not put volatile values (timestamps, counters) in it.
- **Records the rule itself created**: a live punch item or part whose `proposal_id` names the
  proposal marks it `accepted` whatever the rule outputs, so a rule may keep proposing while the
  record exists; but a rule that *also* checks for its record (e.g. R3c's one item per group)
  should look it up through `index.recordsByProposal` or `rule_id`.
- **Findings** (`ctx.find`): `lint_id` defaults to the rule id; a rule that raises several lints
  names each (`R1.untested`) and lists them in `lints`, so its findings resolve when it goes
  quiet. Findings of other producers (the import's `import.*`) are never touched.
- `ctx.index` maps are over live rows; deleted rows are in `ctx.snap.*` with `deleted_at`.

## Payloads per `kind` (what Accept does — `decide.ts`)

| kind | payload | Accept writes |
|---|---|---|
| `punch` | `punch_item` columns: `item` (required), `type`, `owner`, `notes`, `tracking_status` (default `Open`), `date_closed`, `device_id`, `cable_end_id`, `device_text`, `sort_last`, `level_id` | one `punch_item` with `rule_id`, `proposal_id` |
| `part` | `missing_part` columns: `part` (required), `part_no`, `qty`, `owner`, `part_status` (default `Needed`), `notes`, `device_id`, `device_location`, `level_id`; `sources: [{target_kind, target_id}]` | one `missing_part` + `part_source` links |
| `status` | `now` (required), `field` (default `status`), `extra` (more columns to set, e.g. `status_source`, `note`) | `set`s on the subject device or end |
| `note` | `now` (required), `field` (default `note` on an end, `notes` on a device), `extra` | `set`s on the subject |
| `cable` | `cable: {…cable columns}`, `ends: [{…end columns}, {…}]` | the cable and its ends, ids linked |

`level_id` falls back to the subject's `level_id`, then to the subject record's own level.
`why` is never written to a record. `device_id` / `cable_end_id` fall back to the subject.

## States (PLAN §6)

| stored row | rule output present | absent |
|---|---|---|
| none | create `proposed` | — |
| `proposed` | same hash → nothing; else new payload + hash | → `superseded` |
| `superseded` | → `proposed` | nothing |
| `rejected` | same hash → stays; else → `proposed` | nothing |
| `accepted` / `edited` | cited by a live record → nothing; else → `proposed` | nothing |

A live record citing the proposal (`proposal_id`) makes the row `accepted` (`edited` when the
record's fields differ from the payload) on every iPad, from the record alone.

Findings: `open` ↔ `resolved` follow the output; `dismissed` stays dismissed (T36 adds the
reason and reappearance on input change).

## Ids and sync (D169)

`proposal.id = hashUuid('field-survey:proposal', [project_id, key])`, a UUID v8; findings the
same with their own namespace. Every iPad names a proposal the same way, so two iPads
evaluating the same data push two `create` ops with one `entity_id`: the server (and the local
store on pull) applies both, the row and its field heads stay with the first-arrived create,
and a `set` based on either create applies without review (`server/docs/sync.md`). Proposal and
finding rows are ordinary synced records; the engine's ops are `Field survey` / "Rule engine",
one group per run; decisions are one group each with `proposal_id` on every op and the reason
`Accept R3a: <item>` / `Edit …` / `Reject …`.

## Running

`RuleEngine.run()` = load snapshot → `evaluate` → `reconcile` → one `Editor.group` with the
changes (nothing written when there are none: a second run over the same data is a no-op).
Runs are serialised; a run requested during a run follows it. On the iPad, `app/src/rules/`
starts a core `DebouncedTrigger` (500 ms after the last commit or pull) over every project in
the store, logs under `rules`, and bumps a version the plan screen's card reloads on. Rows of
rules this build does not register are left alone (and can still be accepted or rejected: the
demo level's seeded drafts).
