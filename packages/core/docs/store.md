# `packages/core` store (T07)

How the local SQLite store works. Normative references: PLAN §2.1 (versioning, soft delete),
§2.2 (entities), §3.1 (the op), §3.2 (pull/push). Column names follow D76; store rules are D81.

## Files

| File | What |
|---|---|
| `src/schema/entities.ts` | Registry of every table: columns, types, CHECK lists, primary keys, indexes, role (`record`, `link`, `plain`, `local`). `Store.apply` validates against it and codes values with it (JSON → TEXT, bool → 0/1). |
| `src/schema/migrations/0001_initial.ts` | Frozen DDL generated from the registry on 2026-10-10. Never edited; later changes are new entries in `migrations.ts`. `schema.test.ts` fails if the migrated DB and the registry drift. |
| `src/schema/migrations.ts` | `migrate(db)`: applies pending migrations in one transaction each, recorded in `schema_migration`; refuses a DB written by a newer app. |
| `src/schema/search.ts` | `search_doc` (one text row per live device / punch item / missing part / photo, kept by triggers) and the FTS5 index over it when the SQLite build has FTS5, else `LIKE`. |
| `src/store.ts` | `Store.open`, `apply`, `applyMany`, `applyRemote`, `applyRemoteMany`, reads (`get`, `list`, `search`, `opsFor`, `fieldHead(s)`, `outbox`). |
| `src/op.ts` | The `Op` type. |
| `src/editor.ts` | `Editor` / `EditBatch` (T08): the mutation API screens call; builds ops with `was`, `base_op_id` and `group_id` and applies them through the store. |
| `src/sync.ts`, `src/http-transport.ts` | `SyncEngine` and the HTTPS transport (T11): see `docs/sync.md`. |
| `src/numbering.ts`, `src/device-id.ts` | `NEW` state, `unnumbered()`, device ID rules (T13, T63: server-assigned `level_number` IDs): see `docs/numbering.md`. |
| `src/ids.ts` | UUID v7; `setRandomSource` for runtimes without `crypto.getRandomValues`. |
| `src/node.ts` | `BetterSqliteDriver` (Node tests only). The iPad driver is `app/src/db/expo-sqlite-driver.ts`. |

## Applying a local op (`Store.apply`)

One transaction: validate → insert into `op` (`state = pending`, no `server_seq`) → insert into
`outbox` → materialise. Duplicate `op_id` → `'duplicate'`, nothing written.

| Kind | Effect on the entity table | `field_head` |
|---|---|---|
| `create` | `INSERT` the payload (`id` = `entity_id`), `version = 1`, `head_seq = server_seq` (null locally). Replays never overwrite (`ON CONFLICT DO NOTHING`). | one row per payload column → this op |
| `set` | `field = now`, `version + 1`, `head_seq = max(head_seq, server_seq)` | `(entity, field)` → this op |
| `delete` | `deleted_at = ts`, `deleted_by_id = user`, `delete_reason = reason`, `version + 1` | `(entity, deleted_at)` → this op |
| `restore` | clears the three, `version + 1` | same |
| `link_add` | `INSERT … ON CONFLICT(pk) DO UPDATE` (revives a removed link) | — |
| `link_remove` | `deleted_at`, `deleted_by_id` on the link row | — |
| `assign` | refused locally (server-only) | — |

Refused with `StoreError` (nothing written): unknown entity kind or column; `set`/`create` on
`id`, `version`, `head_seq`, `deleted_*`; a local `set` or non-null `create` value on a
server-assigned column (`punch_item.number`, `missing_part.number`, `photo.number`,
`cable_end.display_id`); `delete`/`restore` on link or plain tables; link ops on records; a
`set` on a record that does not exist locally; bad `kind`, `change_type` or `state`.

## Building ops from the UI (`Editor`, T08)

Screens hold one `Editor` per (store, project, user) and never construct an `Op` themselves:

```ts
const editor = new Editor(store, { projectId, userId });          // userId from useCurrentUser()
const ctx = { change_type: 'Field survey', reason: 'LVD card missing' };
await editor.setField('device', id, 'status', 'Issue', ctx);       // one op, group_id null
await editor.group(ctx, async (g) => {                             // one group_id, one transaction
  await g.setField('punch_item', p, 'tracking_status', 'Closed');
  await g.setField('punch_item', p, 'date_closed', '2026-10-10');
});
```

| Call | Op | `was` / `base_op_id` | Notes |
|---|---|---|---|
| `create(kind, payload, ctx)` | `create` | — | `payload.id` kept or a UUID v7 generated; payload is the full record incl. `id`; `undefined` values dropped. Refuses an existing id, protected / server-assigned / unknown columns and off-list values. |
| `setField(kind, id, field, now, ctx)` | `set` | current value / `field_head` (null if never set) | Returns `null` and writes nothing when `now` equals the current value (JSON-equal). Refuses deleted records ("restore it first"). |
| `setFields(kind, id, values, ctx)` | `set` × n | as above | One group. |
| `delete(kind, id, ctx)` | `delete` | — / head of `deleted_at` | `reason` becomes `delete_reason`. Refuses an already-deleted record. |
| `restore(kind, id, ctx)` | `restore` | — / head of `deleted_at` (the delete) | Refuses a live record. |
| `link(kind, ownerId, key, ctx)` / `unlink(...)` | `link_add` / `link_remove` | — | `entity_id` = owner (`level` for `assignment`, `missing_part` for `part_source`); `key` = the other pk columns plus extras. |
| `group(ctx, fn)` | any of the above | chained inside the group | Every op shares one `group_id`; applied with `applyMany` (all or nothing). Inside a group, a `set` after a `create` bases on the create, a second `set` on one field bases on the first. |

Every call takes an `EditContext`: `change_type` (one of the seven, CLAUDE.md §3) and a
non-empty `reason` are required (`OpError` otherwise); `ruling_id` / `proposal_id` are passed
through. `op_id` is a UUID v7, `install_id` is `store.installId`, `client_ts` comes from the
editor's clock (`now` option, default `new Date().toISOString()`), `state` is `pending`.

Heads are read before the op is applied, in a separate transaction. If a pull lands in between
the op carries the older head, which is exactly what the server should see: the user edited the
value they were looking at (PLAN §3.2 step 3 decides).

## Applying a pulled op (`Store.applyRemote`)

Ops arrive in `server_seq` order with their server `state`.

| Situation | Outcome | Effect |
|---|---|---|
| `op_id` already known, same `server_seq` | `duplicate` | nothing |
| `op_id` known (our own op echoed) | `acknowledged` | `server_seq`, `server_ts`, `state` stored; outbox row removed; `head_seq` bumped if applied. The materialised value is **not** touched: if the server put our op in `review`, the official value already arrived as the other user's applied op (lower `server_seq`). An op already acknowledged from a push result (`acknowledgeMany`, no `server_ts` yet) is completed by its echo; after that the same seq is a `duplicate`. An applied `delete` echo re-stamps `deleted_at` with `server_ts` while it is still the record's head (T15). |
| new op, `state = applied` | `applied` / `orphan` | materialised as above; `orphan` when the record is unknown locally (logged by the caller, never fatal) |
| new op, any other state | `recorded` | written to `op` only |

`collided_pending` lists local pending ops on the same field (or any pending op on the record
for an incoming delete/restore, and pending deletes for an incoming set): the sync engine marks
those ops "will be reviewed" (`docs/sync.md`). Ink layers and the photo blob fields
(`image_blob`, `thumb_blob`, `markup_blob`) never collide: the server applies the last write
there (PLAN §3.3), so nothing would be reviewed (T24).

Materialising `review_item.state = resolved`/`dismissed` (local or pulled) settles the ops the
item held: `resolution.rejected_op_ids` → `rejected`, `superseded_op_ids` → `superseded`, only
from `review`, exactly as the server does (T15, `docs/review.md`).

`acknowledgeMany(results)` records a push's `results[]` (T11): `server_seq` and state, outbox
rows removed, `head_seq` moved for applied ops; a `duplicate` result keeps the op `pending`
until its echo. `noteOutboxFailure(opIds, error)` counts a failed attempt. `outboxProjects()`
lists projects with something to push.

## Search

`Store.search(text, { projectId?, levelId?, kinds?, limit? })` returns `{ entity_kind,
entity_id, level_id }` hits. FTS5 mode quotes every term as a prefix phrase (`"06M-04"*`), so
punctuation never produces a parser error; LIKE mode ANDs the terms. `store.searchMode` and
`sync_state('search_mode')` say which is active. expo-sqlite compiles FTS5 in on iOS (A21), so
the LIKE path is a safety net exercised by tests with `Store.open(db, { search: 'like' })`.

## Client-only tables

`outbox(op_id, project_id, client_ts, attempts, last_error, created_at)`,
`blob_queue(sha256, direction, kind, priority, state, attempts, next_attempt_at, last_error,
created_at)` (T12), `sync_state(key, value)` with `install_id`, `search_mode`, `last_server_seq:<project_id>` (pull
cursor) and `will_review:<project_id>` (pending ops the server will review).
