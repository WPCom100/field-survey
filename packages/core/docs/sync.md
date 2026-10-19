# `packages/core` sync engine (T11)

How the iPad pushes and pulls. Normative references: PLAN §3.2 (pull/push paragraph), §3.1;
server side in `server/docs/sync.md` (T09/T10). Decisions: D37, D81, D84, D85, D86.

## Files

| File | What |
|---|---|
| `src/sync.ts` | `SyncEngine`, `SyncTransport` interface, `TransportError`, the status model (`SyncStatus`), `ReviewMark`. |
| `src/http-transport.ts` | `HttpTransport`: `POST /ops` / `GET /ops` over `fetch` with the shared token and `X-Survey-User` (D77). |
| `src/testing/fake-server.ts` | In-process server for tests: seq, duplicates, heads, review on conflict, review-item create op, assign numbers, fault injection. Test-only. |
| `src/sync.test.ts`, `src/http-transport.test.ts` | 19 + 3 tests. |
| `src/e2e/` | Twin-client harness (T14): two stores through this engine against the Docker server — TP-1, TP-7, TP-10, TP-11. See `docs/e2e.md`. |
| `app/src/sync/` | `engine.ts` (the app's one engine), `SyncRunner.tsx` (start / foreground / every 5 s, D130), `useSyncStatus.ts` (status bar hook + `describeSync`). |

## One cycle (`engine.sync()`)

For each project (local `project` rows ∪ projects with outbox entries, or the injected list):

1. **Push** until the outbox is empty. Each batch is the next ≤ 500 ops in `client_ts` order
   (`Store.outbox`); a `group_id` is never split across batches (the trailing group moves whole
   into the next batch; a group longer than a batch is sent split and logged
   `group_exceeds_batch`). The body carries `since` = the project's pull cursor as of the push
   (D84). Results go to `Store.acknowledgeMany`: `server_seq` and state stored, outbox rows
   removed, `head_seq` moved for applied ops; `duplicate` keeps the op `pending` until its echo.
   The response's `server_ops` (assign ops, review-item creates) are applied at once with
   `applyRemoteMany`. A failed push counts an attempt and keeps the error on the outbox rows.
   A **refusal** (409/422 — the server rolled the whole batch back) never blocks the outbox
   (T75, D145): the op a 422 names is **quarantined** with its group (`outbox.state =
   'quarantined'`, the server's error in `last_error`); a 409 that names no op is narrowed by
   pushing each half of the batch alone, at group boundaries, until one group fails by itself
   and is quarantined. The rest of the outbox is pushed in the same cycle, which counts as
   `ran`, not `failed`. Quarantined ops are not pushed again until the Sync screen's **Retry**
   (`SyncEngine.retryQuarantined`); they still count in `pendingOps` (the iPad is not synced
   while it holds them, so D94's export gate stays shut) and in `quarantinedOps`.
2. **Pull** pages of ≤ 500 from the cursor until `has_more` is false, applying each page with
   `applyRemoteMany` and advancing `last_server_seq:<project>` to the last op's seq. Orphans
   (an applied op on a record this iPad never received) are logged, never fatal. The cursor only
   ever moves to the seq of an op this iPad applied: an empty page whose `server_seq` is above
   the cursor is a **gap** (logged `pull_gap`), the cursor stays and the next cycle asks again
   (T74, D144). The server reads the top before the page so this never happens in practice;
   the client still refuses to skip ahead if it does.
3. A **network** failure ends the cycle for every project (nothing else will work either). A
   401 or 5xx on the push still lets the pull run, so the iPad keeps receiving edits; the
   status carries the message and the cycle retries with backoff.

Concurrent `sync()` calls share the running cycle. `requestSync()` (foreground, a tap on the
status) clears the backoff and runs now. `start()` runs a cycle at once and then every
`intervalMs` (60 s by default; the app passes 5 s, D130), waiting for the backoff when that is longer; `stop()` ends it.

## "Will be reviewed" marks

A pulled op that collides with a local pending op (`collided_pending` from `applyRemote`, D81)
marks that pending op in `sync_state('will_review:<project>')` as `{op_id, entity_kind,
entity_id, field, source}`. The mark goes when the op is acknowledged by a push result — a
`review` outcome means the server has made the review item (it arrives as a `review_item`
create op and T26 shows it); the pending badge is only for what is still unsent.
`engine.willBeReviewed(project)` lists the marks; `status.willReview` counts them.

## Backoff and status

| State | Meaning |
|---|---|
| `idle` | Last cycle succeeded (`lastSyncAt`) or nothing ran yet |
| `syncing` | A cycle is running |
| `offline` | Network failure; retry after `nextAttemptAt` |
| `error` | The server refused something (`lastError`); retry after `nextAttemptAt` |
| `no_token` | No transport: no server/token yet. Edits are kept locally |

Backoff: `backoffMs × 2^(failures−1)` capped at `maxBackoffMs` (5 s → 10 → 20 → … → 5 min),
reset by a successful cycle, `requestSync()` or `setTransport()`. `sync()` inside the backoff
returns `skipped`. Status fields: `pendingOps` (outbox, all projects), `willReview`,
`lastServerSeq` per project, `failures`, `nextAttemptAt`, `lastCycle`. `subscribe(listener)` is
called at once with the current status and on every change.

## Timing (T131, D223)

`status.lastCycle` (`CycleTiming`) is what the last completed cycle cost: `ms` (the whole cycle,
every project, the status refresh included), `pushMs` (`POST /ops` calls), `pullMs` (`GET /ops`
calls, network only), `applyMs` (materialising pulled ops), `pushed`, `pulled`, `projects`, `at`
and `failed`. The `synced` log event carries the same numbers (`ms`, `push_ms`, `pull_ms`,
`apply_ms`); the Sync screen shows them as one line (`describeCycle` in `app/src/sync/screen.ts`,
with the last rules pass from `app/src/rules/engine.ts`). A pulled page is materialised
`applyChunk` ops per `Store.applyRemoteMany` transaction (default 100): the iPad has one SQLite
connection, and a screen's query waits for the transaction in progress, so a whole 500-op page in
one transaction held it for a second. The cursor still moves once per page, after the last chunk;
a chunk applied again after a crash is a duplicate op.

## Editing never waits

The engine only reads the outbox the store fills; `Store.apply` never consults it. With no
transport the cycle reports `no_token` and leaves the outbox alone; `setTransport()` later
drains it. Nothing in the engine deletes an op: a refused batch stays until the data changes
(T13 lint for unknown references).

## Wiring on the iPad

`getSyncEngine()` builds one engine over `openAppStore()`. `<SyncRunner/>` (inside
`IdentityGate`, so the server URL, token and user are known) attaches an `HttpTransport`,
starts the engine, and calls `requestSync()` on every `AppState` change to `active`.
`useSyncStatus()` subscribes a component; `describeSync(status)` is the status-bar text.

## Reachability without a project

A cycle whose project list is empty (an iPad before setup has given it a project) has nothing
to push or pull, so until 2026-10-11 it never contacted the server and reported `idle` even in
airplane mode. Now `SyncTransport.ping()` (`GET /health`, optional on test doubles) runs in that
case: a network failure makes the cycle `offline` with the usual backoff, a 2xx keeps `idle` and
`lastSyncAt` means "the server answered". With projects present the push/pull calls already tell.

## Where an iPad learns its projects (T41, D127)

The default project list is local `project` rows ∪ projects with outbox entries ∪
`sync_state('known_projects')`. The app fills the last one from `GET /projects` (the Projects
screen's refresh) and from its own `POST /projects` (`rememberProjects(store, ids)`), so a
project the iPad has never seen is pulled on the next cycle: the server wrote the project, its
numbering groups, levels and copied vocabulary/library/rulings/placeholders as ops at creation,
and the first pull materialises them, the `project` row included. Nothing is written locally
outside the pull; `knownProjects(store)` reads the list.

## The app library stream (T61, D184)

`SyncEngine({ library: true })` (the app's engine) also pushes and pulls `LIBRARY_STREAM`, the
app-level device-type library, **first** in every cycle (a project's device may name an app type
made in the same cycle). It is an ordinary stream to the store: an `Editor` with
`projectId: LIBRARY_STREAM` writes app-library ops, the outbox, cursor (`last_server_seq:<stream>`),
review marks and quarantine work as for a project. `HttpTransport` sends it to `/library/ops`
(`server/docs/sync.md`). App-library rows keep `project_id` null; their review items carry the
stream id.
