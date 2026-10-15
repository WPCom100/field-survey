# Server sync: `POST /ops` (T09) and `GET /ops` + materialised state (T10)

How a push is applied, how a pull pages, and how the entity tables follow the log. Normative
references: PLAN §3.1 (the op), §3.2 (apply steps, pull), §3.3 (conflict rule per field type),
§2.1 (versioning), §2.3 (numbering). Decisions: D37, D76, D81, D84, D85.

## Files

| File | What |
|---|---|
| `app/sync.py` | `PushIn`/`PushOut`/`PullOut` wire types, `validate_op`, the `Push` apply loop, review-item creation, `pull_ops`. |
| `app/materialise.py` | `materialise(session, op)`: one applied op → its entity table; `replay(session, project_id)`: rebuild a project's tables from the log. |
| `app/numbering.py` | Numbering-group counters and `C-nn` / integer display values. |
| `app/api/ops.py` | The routes: one transaction per push (commit on success, rollback and 409/422/500 otherwise); paged pull. |
| `tests/test_ops.py` | Every row of PLAN §3.3, D37 ordering, numbering, idempotency, validation, one-transaction. |
| `tests/test_pull_materialise.py` | Pull paging and states; materialised rows per op kind; replay == state; no `server_seq` gaps under 8 concurrent pushers (TP-7 partial). |
| `app/projects.py`, `app/api/projects.py` | `POST /projects` / `GET /projects` (T41, D127): the `project` row a push locks on, then the project, its `numbering_group`s, levels and copies written as trusted ops (`Push(trusted=True)`) so an iPad's first pull delivers them. Replaces the `app.seed` CLI (D89); the twin-client harness (`packages/core/docs/e2e.md`) uses it. |

## Request and response

```
POST /ops            Authorization: Bearer <shared token>
{ "project_id": "<uuid>", "since": <int|null>, "ops": [ <op>, … ≤ 500 ] }
```

`since` is the install's pull cursor for the project (`last_server_seq:<project_id>`) when the
push was built: ops above it are ones the install has not seen. T11 pushes **before** pulling
and sends it; null means "treat every other user's op as unseen" (conservative). Ops are the
client's `Op` shape (D76 names, ISO timestamps); `server_seq`/`server_ts`/`state` are ignored.

```
200 { "results": [ { "op_id", "outcome", "server_seq", "review_item_id"? } … ],
      "server_ops": [ <op> … ],      // assign ops + review-item create ops, full op JSON
      "server_seq": <int> }          // highest seq in the project after the push
401 bad token · 404 unknown project · 422 malformed op { "index", "op_id", "error" }
```

A 409, 422 or 500 stores nothing. The whole push is applied inside `SELECT … FOR UPDATE` on
the project row, so pushes to one project are serial: `server_seq` has no gaps and counters never
race. **409** `{"error": "integrity", "detail"}` is a deferred foreign-key failure at commit: a
create referenced a level, device, cable, sheet… the server has never seen (D76 keeps FKs on the
materialised tables). The client keeps the ops and retries with backoff; the fix is on the
client side (T13 lint). It is logged as `push_integrity` with the op ids.

```
GET /ops?project_id=<uuid>&since=<int, default 0>&limit=<1..500, default 500>
200 { "ops": [ <op> … ],         // server_seq > since, oldest first, every state
      "server_seq": <int>,       // highest seq in the project (not of this page)
      "has_more": <bool> }       // page on with since = ops[-1].server_seq
401 bad token · 404 unknown project · 422 bad query
```

Every state is returned: the client acknowledges its own echoes, materialises other installs'
`applied` ops and records `review`/`superseded` ones (D81). The client is caught up when its
cursor equals `server_seq`.

`pull_ops` reads `server_seq` (the top) **before** the page (T74, D144). The two statements see
different snapshots under READ COMMITTED, so a push committing between them can only add ops to
the page, never raise the top above a page that misses them; `server_seq` is then at least the
last op returned. The client treats an empty page under a higher top as a gap and keeps its
cursor instead of jumping to the top (which skipped those ops before T74).

## Outcomes

| Outcome | Meaning | Stored as |
|---|---|---|
| `applied` | Accepted; heads moved; `create` may have triggered an `assign` | state `applied` |
| `duplicate` | `op_id` already known; earlier `server_seq` returned; server ops caused by it returned again | nothing new |
| `review` | Conflict: the head value stays official; a `review_item(sync_conflict)` was created | state `review` |
| `superseded` | Same user, older `client_ts` than the head set from another iPad (D37) | state `superseded` |

Every stored op gets the next `server_seq`, including server-generated ones. The client's
`applyRemote` materialises `applied` ops only and records the others (D81); the server does the
same (below).

## Materialised tables (T10, D85)

`Push.store(row, "applied")` calls `materialise(session, row)` inside the push transaction, so
the entity tables never lag the log. The projection is the client store's (D81), column for
column, so a replayed server and a synced iPad hold the same rows:

| Kind | Effect | `version` / `head_seq` (records only) |
|---|---|---|
| `create` | INSERT the payload (`id` = `entity_id`); `ON CONFLICT DO NOTHING`, so a replayed create never overwrites later sets | `1` / `server_seq` |
| `set`, `assign` | `field = now` | `+1` / `max(head_seq, server_seq)` |
| `delete` | `deleted_at = server_ts`, `deleted_by_id = user_id`, `delete_reason = reason` | `+1` / max |
| `restore` | clears the three | `+1` / max |
| `link_add` | INSERT … ON CONFLICT (pk) DO UPDATE, clearing `deleted_*` (revives a removed link) | — |
| `link_remove` | `deleted_at = server_ts`, `deleted_by_id` on the link row | — |

`review`, `superseded` and `rejected` ops are never materialised. A `set`/`delete`/`link_remove`
whose row does not exist is logged as `materialise_orphan` and skipped (the op stays in the log).
JSON payload values are coerced to the column types (UUID, timestamp, date, bool, int, float).

The review item is no longer inserted directly: `Push.review` builds the payload, appends the
server `create` op, and the row appears by materialising that op — one write path on the server
too, and the replay reproduces the item (`version = 1`, `head_seq` = the create's seq).

`replay(session, project_id, reset=True)` deletes every row an op of the project created (and
every link row its link ops touched), leaves server-seeded rows (`project`, `numbering_group`,
`app_user`, levels from `POST /projects`) alone, then re-applies all `applied` ops in
`server_seq` order. It is the recovery tool if a table is ever found out of step with the log;
run it inside one transaction.

## Decisions per op kind (PLAN §3.2)

- **create**: always applies. `field_head` is set for every payload column except `id`, the
  protected columns and server-assigned ones (D81). Numbered kinds (`punch_item`, `missing_part`,
  `photo` → `number`; `cable_end` → `display_id` as `C-nn`) get an `assign` op from the level's
  numbering group (the level row — materialised in the same transaction when it arrived as an
  op). A null `level_id` (cable ends off any level) → no number yet, logged as `assign_skipped`;
  an unknown `level_id` fails the push (409). A replayed create never renumbers.
  **Devices (D93, T63):** a `device` create without `display_id` whose scheme is `level_number`
  (library type's `id_scheme`, else Station/Sensor → `level_tag`, any other category →
  `level_number`) gets an `assign` op on `device.display_id` = `<level code>-<nn>`, highest number
  ever used on that level code in the project + 1, two digits (every device `display_id` in the
  op log in any state, plus the device table: deleted, renamed and imported IDs stay used). Per
  level code, not per numbering group: 06 and 06M count separately. **D118:** a `level_tag` create
  (stations, sensors) without `display_id` is numbered the same way per letter: `<code>-S<n>` /
  `<code>-D<n>`, no padding (a tag-scheme type on another category gets a plain number); it no
  longer fails with 422. A create that carries an ID keeps it.
- **set**: `head = field_head(entity, field)`. Record deleted by another user → review (step 4).
  `head == base_op_id` or no head → apply. Same user as the head → apply if `client_ts` is not
  older than the head's, else `superseded`. `ink_layer.*` and `photo.image_blob/thumb_blob/
  markup_blob` → apply (attachments never conflict). Same value → apply (merge). Else → review.
- **delete / restore**: like a `set` on `deleted_at` whose value is deleted/not-deleted:
  delete vs delete and restore vs restore merge; delete vs restore from different users →
  review. A delete that would apply is still reviewed when another user has an applied `set`
  on the record with `server_seq > since` (step 4, "newer edit").
- **link_add**: always applies. **link_remove**: the latest applied link op for the same key
  (`payload @> key`) is a `link_add` by another user above `since` → review; else apply.
- **Groups** (`group_id`, PLAN §3.3 field groups): members are decided together against an
  overlay of their own heads (a `set` after a `create` in the same group bases on the create).
  If any member conflicts, every member that would have applied goes to `review` under one
  review item; `create` and `link_add` members still apply; `superseded` stays `superseded`.
- **Ruling** (step 6): the review item's `ruling` flag is set when any op on either side has a
  `ruling_id`.

## Review items (D84)

One `review_item` per conflict (or per group): `kind = sync_conflict`, `subject = {entity_kind,
entity_id, field, level_id?, group_id?, fields?}`, `op_a_id` = the head op (official, side A),
`op_b_id` = the incoming op (side B), `candidates` = one entry per op on each side
(`side, op_id, user_id, install_id, client_ts, entity_kind, entity_id, field, kind, value`),
`state = open`. The row is inserted **and** a server `create` op on `review_item` is appended
to the log, so the item reaches every iPad through the normal pull and T15's resolution can be
ops on it. `level_id` on the row is only set when the `level` row exists (FK); the subject
carries it regardless.

## Resolution (T15, D91)

A resolution arrives as one ordinary push group from the resolver's iPad
(`packages/core/docs/review.md`): the `Reconcile` op(s) on the subject, then `set`s on the item's
`resolution`, `resolved_by_id`, `resolved_at` and `state`. It is decided like any group: a stale
Reconcile op (the field moved since the resolver pulled) sends the whole group to review and the
item stays open. Two server rules serve it:

- When `review_item.state` is materialised as `resolved`/`dismissed`, `materialise._settle_review`
  moves the ops listed in `resolution.rejected_op_ids` to `rejected` and those in
  `superseded_op_ids` to `superseded`, only from `review` (idempotent; replay repeats it). Pulls
  from then on return the new state; iPads that already hold the op settle it themselves from the
  same op.
- Step 4 exception: a `set` with `change_type = Reconcile` on a record deleted by another user is
  **not** reviewed when that delete is at or below the push's `since` (the resolver saw it). An
  unseen delete, or any other change type, is still reviewed.

## Server-generated ops

`assign` and the review-item `create` are ops like any other: `install_id =
SERVER_INSTALL_ID` (`uuid5(NAMESPACE_URL, "field-survey:server")`), `user_id` and
`change_type` copied from the op that caused them, `base_op_id` = that op's `op_id`,
`client_ts = server_ts`, state `applied`. A retried push returns them again by that
`base_op_id`.

## Trusted producers (T27)

`Push(session, body, trusted=True)` is how a server-side job (the seed import, `app/jobs/runner.py`)
delivers its results as ops. The only difference from an iPad push: a `create` may carry a display
number or device ID (`punch_item.number`, `missing_part.number`, `photo.number`, `cable_end.display_id`,
`device.display_id`). `Push.assign` then keeps it, sets the field head to the create and moves the
numbering-group counter up to that number (`numbering.parse_number`), so later field additions
continue after the imported ones (PLAN §7.5, D25). A `set` on a server-assigned field is refused
either way, and an untrusted create carrying a number is still 422.

Two general rules came with it: the side-B end of a `single_row` cable (`P`, `0-10V`, `120V`) is
never numbered (it is not a Connections row), and a `cable_end` created without a level logs
`assign_skipped` at info, not warning (a placeholder far end has no level by design).

Historical ops (the master's Change Log) bypass `run()` and are written with `Push.store(row,
"superseded")`: a `server_seq`, no materialisation, no head (D124). See `docs/imports.md`.

## Deterministic ids (D169, T33)

The rule engine names a proposal or finding by a hash of its key, so two iPads evaluating the
same data push two `create` ops with one `entity_id`. Both are `applied`; the second changes
nothing (`_create` returns False) and, when the record already has field heads from an earlier
create, moves no heads and assigns no number (`Push.commit`). A `set` whose `base_op_id` is *a*
create of its record while the head is *another* create of it is treated as current
(`based_on_a_create_of`), so a decision taken on the second iPad before it pulled the first's
create applies without a review item. A row inserted directly (as `POST /projects` does before
logging its create) has no heads yet and takes them from its create as before.

## The app library's log (T61, D65, D184)

`POST /library/ops` (`{since, ops}`) and `GET /library/ops?since&limit` carry the app-level
device-type library: the same op format, `Push` loop, field heads, conflict review and history
as a project's `/ops`, in a log of its own (`app/api/library.py`, `Push(..., library=True)`).

- Ops name `LIBRARY_STREAM` (`00000000-0000-7000-8000-00000000a11b`) as their `project_id` on
  the wire and on the iPad; Postgres stores them with `project_id` **null** and numbers them on
  their own (`uq_op_library_server_seq`, a partial unique index); pushes are serialised by an
  advisory lock instead of the project row lock. `op_to_json` writes the stream id back.
- Only `library_type` (with `project_id` null) and `review_item` sets (resolutions) are taken;
  anything else is 422. A project push may not create a `library_type` without its project.
- A conflict's `review_item` row has `project_id` null; its `create` op's payload carries the
  stream id on the wire, because the iPad's `review_item.project_id` is NOT NULL. Needs review
  lists it under the stream (`/review?project=<LIBRARY_STREAM>`).
- `library_type.promoted_from_id` is a plain id (no foreign key, migration 0009): a promotion
  names a project's type across logs, and the two commit separately.
- New projects copy the app library's accepted types at creation (`projects._copy`, D65).
