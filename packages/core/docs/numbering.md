# `packages/core` numbering (T13)

Normative: PLAN §2.3, D25, D33, D84 (server side), D88 as amended by D93 (device IDs).

## Display numbers: server-assigned, `NEW` until then

Punch `#`, part `#`, photo number and `C-nn` belong to the server. It assigns them on first
receipt of the `create` op, from the counter of the level's numbering group (06 and 06M share
one group), and sends an `assign` op back (in the push response and on pull). Counters only move
forward: a deleted record keeps its number, a restore keeps it, a replayed create or a
duplicate push never renumbers (TP-10, `server/tests/test_numbering.py`).

On the iPad (`src/numbering.ts`):

| API | What |
|---|---|
| `NUMBERED` | entity kind → server-assigned column (derived from `serverAssigned` in the registry) |
| `SERVER_ASSIGNED` / `PENDING_KINDS` | `NUMBERED` plus `device → display_id` (D93): every kind that can be `NEW` |
| `isNew(kind, row)` | true while that column is null |
| `displayNumber(kind, row, level?)` | `"12"`, `"C-07"`, `"06M-04"`, or `"NEW"`; a `NEW` device shows `"<level>-?"` with the `NEW` badge beside it. Never a provisional number |
| `unnumbered(store, projectId)` | every live `NEW` record, devices included, with a reason (below), oldest create first |

`unnumbered()` reasons:

| Reason | Meaning | What to do |
|---|---|---|
| `waiting` | create still in the outbox (offline, or a network/server failure that will retry; `last_error` kept) | nothing; next sync numbers it |
| `refused` | the push carrying the create was refused with 409 (references a level/record the server does not know) or 422 | data must change; T36 lint |
| `unnumbered` | the server accepted the create but assigned nothing (no level, or a level without a group; server logs `assign_skipped`) | fix the level; T36 lint |
| `no_create` | the row has no create op locally | should not happen; report |

The store refuses a local `set` or `create` that writes a server-assigned column (D81).

## Device IDs (`src/device-id.ts`, D93, T63)

| Scheme | Categories (default) | ID | Who assigns |
|---|---|---|---|
| `level_number` | everything except Station/Sensor | `<level>-<nn>`, highest ever used on that level code + 1, two digits (`06M-04`, then `06M-100`) | **server**, as an `assign` op on `device.display_id` |
| `level_tag` | `Station` (`S`), `Sensor` (`D`) | `<level>-S<n>` / `<level>-D<n>` from the confirmed drawing tag, no padding (`01-S9`) | iPad, in the create |

The library type's `id_scheme` overrides the category default. `deviceIdFor(store, req)` returns:

- `{ scheme: 'level_number', pending: true }`: create the device **without** `display_id`. It is
  `NEW` and shows `<level>-?` until the server's `assign` arrives (one sync when online). Two
  iPads adding devices on one level offline therefore get distinct IDs, in arrival order.
- `{ scheme: 'level_tag', pending: false, display_id, taken_by }`: store `display_id` in the
  create. `taken_by` lists other devices in the project (deleted included) with the same ID; a
  duplicate tag is a warning and a lint (D76), never a refusal.

Server rules (`server/app/numbering.py`, `server/docs/sync.md`):

- Every device `display_id` the project has ever used stays used: deleted, renamed, imported or
  only proposed in review. Gaps are never filled. A restore keeps the ID; a replayed create never
  renumbers.
- Device IDs are per **level code**: 06 and 06M share a numbering group but not device IDs.
- A `level_tag` create without `display_id` is refused with 422 (the whole push). A create that
  carries an ID keeps it (imports T27, copied floors T56).
- Tags: `S15`, `s 15`, `15` → `S15` for a station; a letter that contradicts the category, or a
  full ID for another level, throws `DeviceIdError`.
