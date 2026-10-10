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

## Server-generated ops

`assign` and the review-item `create` are ops like any other: `install_id =
SERVER_INSTALL_ID` (`uuid5(NAMESPACE_URL, "field-survey:server")`), `user_id` and
`change_type` copied from the op that caused them, `base_op_id` = that op's `op_id`,
`client_ts = server_ts`, state `applied`. A retried push returns them again by that
`base_op_id`.
