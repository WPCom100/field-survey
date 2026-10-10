# `packages/core` numbering (T13)

Normative: PLAN §2.3, D25, D33, D84 (server side), D88 (client side).

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
| `isNew(kind, row)` | true while that column is null |
| `displayNumber(kind, row)` | `"12"`, `"C-07"`, or `"NEW"`, never a provisional number |
| `unnumbered(store, projectId)` | every live `NEW` record with a reason (below), oldest create first |

`unnumbered()` reasons:

| Reason | Meaning | What to do |
|---|---|---|
| `waiting` | create still in the outbox (offline, or a network/server failure that will retry; `last_error` kept) | nothing; next sync numbers it |
| `refused` | the push carrying the create was refused with 409 (references a level/record the server does not know) or 422 | data must change; T36 lint |
| `unnumbered` | the server accepted the create but assigned nothing (no level, or a level without a group; server logs `assign_skipped`) | fix the level; T36 lint |
| `no_create` | the row has no create op locally | should not happen; report |

The store refuses a local `set` or `create` that writes a server-assigned column (D81).

## Device IDs: chosen on the iPad (`src/device-id.ts`)

| Scheme | Categories (default) | ID |
|---|---|---|
| `level_number` | everything except Station/Sensor | `<level>-<nn>`, next free = highest used on that level code + 1, two digits (`06M-04`) |
| `level_tag` | `Station` (`S`), `Sensor` (`D`) | `<level>-S<n>` / `<level>-D<n>` from the confirmed drawing tag, no padding (`01-S9`) |

The library type's `id_scheme` overrides the category default. `deviceIdFor(store, req)`
returns `{display_id, scheme, next_free, taken_by}`:

- IDs of deleted devices stay used; gaps are never filled.
- Device IDs are per **level code**: 06 and 06M share a numbering group but not device IDs.
- `taken_by` lists other devices in the project with the same ID. A duplicate is reported for
  the UI to warn about and lint to flag (D76). It is never refused, so offline creation always works.
- Tags: `S15`, `s 15`, `15` → `S15` for a station; a letter that contradicts the category, or
  a full ID for another level, throws `DeviceIdError`.
