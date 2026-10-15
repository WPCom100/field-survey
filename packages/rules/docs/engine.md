# `packages/rules` engine (T33)

How rules run on the iPad. Normative references: PLAN §6 (rule engine), CLAUDE.md §4 (rules
produce proposals and findings, never records except on Accept), D24 (client only), D169
(deterministic proposal ids). T34 adds the rules themselves to `src/rules/`.

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
| `src/rules/index.ts` | `RULES`, the registry the app runs (empty until T34). |
| `src/testing/sample.ts` | A two-device snapshot and two sample rules for tests. |

## Writing a rule (T34)

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
