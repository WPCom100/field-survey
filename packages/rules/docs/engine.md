# `packages/rules` engine (T33), rules (T34) and lint checks (T36)

How rules run on the iPad. Normative references: PLAN §6 (rule engine), CLAUDE.md §4 (rules
produce proposals and findings, never records except on Accept — with D170's one exception),
D24 (client only), D169 (deterministic proposal ids), D170–D173 and D175 (T34's readings), D178
(dismissed findings, T36).

## Files

| File | What |
|---|---|
| `src/snapshot.ts` | `Snapshot` (one array per table, client columns, deleted rows included) and `indexSnapshot()` (maps by id, by level, by device, ends per cable, `otherEnd()`, records by proposal). T36 adds `sheets`, `drafts` (unreviewed `draft_device` / `draft_cable` only) and `photos` (only live photos whose device is deleted). |
| `src/rule.ts` | `Rule { id, title, text, lints?, run(ctx) }`, `RuleContext { snap, index, propose(), find() }`, keys and ids. |
| `src/evaluate.ts` | `evaluate(snap, rules)`: runs every rule, dedupes by key, hashes inputs; a throwing rule is reported, not fatal. |
| `src/reconcile.ts` | The state machine as pure diffs: existing rows + this run's output → `create` / `set` changes. |
| `src/decide.ts` | What an Accept creates per proposal `kind` (`acceptPlan`), the keys an Edit form offers, `recordDiffers`. |
| `src/engine.ts` | `RuleEngine` over a core `Store`: `loadSnapshot`, `run`, `decide`, `explain`, `openProposals`, `openFindings`. |
| `src/hash.ts` | SHA-256 (pure TS), `stableStringify`, `hashUuid` (UUID v8 from a hash). |
| `src/rules/index.ts` | `RULES`, the registry the app runs, and the rule exports. |
| `src/rules/shared.ts` | Helpers: signal words, `targetOf` (how item text names the far end), `terminationItem`, `waitsForSurvey` (R5), level / ID ordering. |
| `src/rules/r1.ts` … `e5.ts` | The rules, one file per family (below). |
| `src/rules/lint.ts` | The PLAN §6.3 checks the rules above do not raise (T36), `LINT_RULES`, `VOCAB_FIELDS`. |
| `src/lints.ts` | `LINT_CHECKS` (every lint id under its §6.3 check, with a hint, in the lint view's order), `checkOf`, `rulingSeeds` (the "fix all via ruling" hand-off to T37). |
| `src/rulings.ts` | Rulings (T37, PLAN §6.4): `RulingDraft` (filter, action, scope, standing), `RULING_FIELDS`, `parseRuling` (incl. the D50 import form), `checkRuling`, `previewRuling`, `vocabPlan`, `describeRuling`, the hand-off drafts (`draftFromSeed`, `draftFromSelection`) and `RulingRule` (standing rulings). |
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
| R2g | `cable` drafts, per device of an accepted type with `default_cables` (T48, D183) | Each template `{code, from, to, far, single_row, qty, status}` (`rules/library.ts`): near end the device (From = template or panel name), far end the placeholder labelled `far`, else text only. One per template; a second template of one code is `<code>#2`. Skipped when the device has that many ends of the code; `U` left to R2e. The device's type is its `library_type_id`, else the project's (then the app's) non-rejected type whose model / alias equals its Device text. R2c, R2d, `lint.relay_cables` and `lint.power_120v` skip a device R2g governs. |
| R2f | `status` draft `Not started` (derived) | An unsurveyed end on an out-of-scope level, or whose far end is on one (or a `level_not_in_scope` placeholder). Nothing is ever copied (D171). |
| R3a | `punch` draft on the end | `Not installed` → `Run <signal> to <far end>` (`Cable not run`, `EC`); 0-10V reads "Run and land 0-10V control wiring". **One per wire** (D177): when both ends are surveyed `Not installed` the draft sits on the **start of the run** — side A: the lower floor in the master, the riser's origin once the riser is imported — even when that end is a placeholder; a Run item the rule made on the other end stands for the wire. `Issue` + "not terminated"/"not landed"/"needs landing" → `Terminate <signal> to <far end>` (`Termination`; "Land 0-10V control wiring", "Land 120V power"), discriminator `terminate`, owner per D175 (3) — one per end, since each end is terminated. Gated by R5; skipped when an open item with the same text exists. A single row's far end is its To text (`P-NSPS-D Power Supply`, `Equipment rack`, `Fixtures`), never the placeholder that pairs it (`120v Power`). |
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

## Lint checks (T36, PLAN §6.3)

| §6.3 check | Lint id | Raised on |
|---|---|---|
| NSPS/rack without 120V | `lint.power_120v` | the device (R2d offers the row) |
| Relay panel without P or 0-10V | `lint.relay_cables` (discriminator = code) | the device (R2c offers the row) |
| Issue device without open item | `R1.no_item` | the device |
| Item without Owner | `lint.item_owner` | the punch item |
| Neuron ID item missing / not last | `lint.neuron_item` | the numbering group (no item while a device lacks an ID) or the item (`sort_last` false) |
| Value outside vocabulary | `lint.vocab`, `R3f` | the record: an old spelling (`vocab.canonical_of`; `fix` = field, from, canonical), a category outside CLAUDE.md §3 + `vocab(category)`, a cable code outside the master's; R3f for item text |
| Cable with missing far end | `lint.far_end` | the end that has an endpoint (one end only, or the far end names no device/placeholder) |
| Ends with different code / incompatible statuses | `lint.end_status` | the `Not installed` end when the other is `Complete` / `Installed, untested`; a code mismatch cannot happen (one cable, one code) |
| To ≠ riser | `R2b` | the A end |
| Duplicate Neuron ID | `lint.neuron_dup` | each device (case-insensitive) |
| — (T13: duplicate device ID, D88) | `lint.id_dup` | each live device |
| Link to deleted device | `lint.deleted_link` | the punch item, part, end or photo |
| Pin outside sheet | `lint.pin_sheet` | the device (outside `width_pt` × `height_pt`, or on a deleted sheet) |
| Level locked with unreviewed drafts | `lint.locked_drafts` | the level |
| Accessory found < expected | `Acc` | the device (discriminator = accessory) |

A finding may carry `fix: {field, from, to}` (stored in its `subject`): the vocabulary lint's
rename for "Fix all via ruling"; put `from` in the discriminator so another value is another
finding. **Messages are the inputs** (D178): name the facts (IDs, values, counts) and nothing
volatile — a dismissed finding reopens when its message changes.

Over the master (TP-8) the lints raise exactly the 12 `lint.far_end` findings of the cables the
import left unresolved (D126); `master.test.ts` pins them.

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

Findings: `open` ↔ `resolved` follow the output. `dismissed` (D178, T36: `RuleEngine.dismiss(id,
reason)`, a reason required; `reopen(id)` undoes it): the same message → stays; a different
message → `open`, reason cleared; no output → `resolved` (reason kept), so it is raised again if
it returns.

## Ids and sync (D169)

`proposal.id = hashUuid('field-survey:proposal', [project_id, key])`, a UUID v8; findings the
same with their own namespace. Every iPad names a proposal the same way, so two iPads
evaluating the same data push two `create` ops with one `entity_id`: the server (and the local
store on pull) applies both, the row and its field heads stay with the first-arrived create,
and a `set` based on either create applies without review (`server/docs/sync.md`). Proposal and
finding rows are ordinary synced records; the engine's ops are `Field survey` / "Rule engine",
one group per run; decisions are one group each with `proposal_id` on every op and the reason
`Accept R3a: <item>` / `Edit …` / `Reject …`.

## Golden tests over the master (TP-8, T35)

`src/golden/master.test.ts` replays `fixtures/master-ops.json` — the op log a client pulls after
the server has imported the master (`server/tests/dump_master_ops.py`, `server/docs/imports.md`)
— into a Node store through `Store.applyRemoteMany` and runs the engine as the iPad would. It
pins down: the replay and the master's counts; that over the master **as imported** the engine
proposes exactly the **known differences** committed in the file (31 rows, each against the
master row it stands for: the engine's D175 (2) wording vs the surveyor's free text, runs the
master folded into a device's "Not installed" item, ends the import left unresolved, D126) and
no finding, with R3c rewriting the seven Neuron ID items' Notes as its only write (D175 (4));
that the rows marked `copied` vanish once the master's eight copied ends ("(per …)") are
unsurveyed (D171); R3c, R3b → R4b and E5 re-made from the master with those rows removed. The
test is skipped, with the reason in its name, when the fixture is missing. Regenerate the fixture
after a seed-import change; extend the lists in the test when a rule's wording changes on
purpose, never to hide a new proposal.

## Running

`RuleEngine.run()` = load snapshot → `evaluate` → `reconcile` → one `Editor.group` with the
changes (nothing written when there are none: a second run over the same data is a no-op).
Runs are serialised; a run requested during a run follows it. On the iPad, `app/src/rules/`
starts a core `DebouncedTrigger` (500 ms after the last commit or pull) over every project in
the store, logs under `rules`, and bumps a version the plan screen's card reloads on. Rows of
rules this build does not register are left alone (and can still be accepted or rejected: the
demo level's seeded drafts).

## Rulings (T37, PLAN §6.4, D179)

A ruling is one decision applied to every record it fits. `RuleEngine.previewRuling(draft)` lists
what it would change (one row per record: Level · Ref · Field · Was → Now; records already right
are left out); `applyRuling(draft, { skip })` writes the ticked rows as one group of ops with
`change_type = Ruling`, `reason` = the ruling text and `ruling_id`, the `ruling` row created in the
same group. `setRulingStanding`, `deleteRuling` and `rulingProposals` serve the Rulings screen.

| Part | Stored as |
|---|---|
| Scope | `scope_levels`: level **codes** (null = all levels), as the seed import's D50 ruling writes them |
| Filter | `{ entity, where: [{field, op, value}], ids?, except? }`; entities `device`, `cable_end` (with the cable's code as `cable`), `cable`, `punch_item`, `missing_part`; ops `eq`, `ne`, `contains`, `not_contains` (case-insensitive), `has_phrase` (whole value or one `; ` phrase), `empty`, `not_empty`, `in`. `ids` = chosen records (multi-select, lint seed); `except` = records unticked in a preview, never changed or proposed again. The import's `{entity, field, values}` reads as one `in` condition. |
| Action | `set` (field = value; enum fields checked against their list) · `rename` (old phrase → new, whole value or one `; ` phrase) · `append` (a phrase after `; `, once) · `item` (one punch item per device or end, `rule_id = ruling`; none when an item with that text is already on the record, open or closed). The import's `{set: {field: value}}` reads as `set`. |
| Rename → vocabulary | when the field has a vocabulary list (`VOCAB_FIELDS`) **and the project already has rows in it**: the new phrase canonical, the old one `canonical_of` it, older spellings of the old one re-pointed; `lint.vocab` then flags any new use. An empty list is left alone (the first `punch_item` row would switch R3f on for every item). |
| Standing | `RulingRule` (`rule_id = ruling`, discriminator = the ruling id) proposes the change on each record the ruling fits that is not right yet: `note` / `status` kind (`payload {field, now, ruling_id}`) or `punch` for an item ruling. `decide()` accepts it as a `Ruling` op with the ruling's text and id; Reject holds until the record's value or the ruling changes; a ruling no longer standing, or deleted, supersedes its open proposals. |
