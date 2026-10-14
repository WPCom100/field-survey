# Twin-client harness (T14)

Two iPads as two core stores (`BetterSqliteDriver`), each driving the real `SyncEngine` +
`HttpTransport`, against the real FastAPI server in Docker. It automates TP-1, TP-7, TP-10 and
TP-11 (docs/history/Phase4_Delivery_Plan.md §4) and runs in GitHub Actions (`ci.yml`, job `e2e`).
Unit tests use `FakeServer`; everything here goes over HTTP to Postgres.

## Files

| File | What |
|---|---|
| `src/e2e/harness.ts` | Server setup (`seedProject` over `POST /projects`, `restartApi` through compose), clients (`openClient`, `makeWorld`), the `Flapper` fetch wrapper, `drain`, `expectConverged`, `expectGapFree`. |
| `src/e2e/twin.e2e.test.ts` | The TP scripts (table below). |
| `src/blobs.e2e.test.ts` | T12's upload-resume test; same env, runs in the same CI job. |
| `server/docker-compose.e2e.yml` | Compose override: API on `127.0.0.1:8010`, token `e2e`, local S3. |

## Running it

```
cd server && cp .env.example .env            # once
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build postgres s3 api
docker compose -f docker-compose.yml -f docker-compose.e2e.yml exec -T api alembic upgrade head
docker compose -f docker-compose.yml -f docker-compose.e2e.yml exec -T api python -m app.storage ensure-bucket
cd .. && FIELD_SURVEY_E2E_URL=http://127.0.0.1:8010 FIELD_SURVEY_E2E_TOKEN=e2e pnpm --filter @field-survey/core test:e2e
```

Without `FIELD_SURVEY_E2E_URL` and `FIELD_SURVEY_E2E_TOKEN` every e2e test is **skipped with that
reason** (never passed silently), so `pnpm -r test` stays a unit run. `test:e2e` runs the e2e files
one at a time (`--no-file-parallelism`) because the restart test takes the API down for a moment.

| Variable | Default | Use |
|---|---|---|
| `FIELD_SURVEY_E2E_URL`, `_TOKEN` | — (required) | Where the server is and its shared token |
| `FIELD_SURVEY_E2E_COMPOSE` | `docker compose -f server/docker-compose.yml -f server/docker-compose.e2e.yml` | Compose command, run from the repo root |
| `FIELD_SURVEY_E2E_RESTART` | `<compose> restart api` | How to restart the API; `skip` skips the restart test (host uvicorn) |

Each test creates its **own project** with `POST /projects` (T41, D127: the project, its numbering
groups and levels arrive as ops), so `server_seq` and numbering start after the project's own ops
and tests never see each other. A client opens with the project id only (`rememberProjects`) and
its first pull brings the project row, as on the iPad. Users are `POST /team` (`Ann`, `Bob`); install ids are
fresh UUID v7s. Clients open with `backoffMs: 50`, `maxBackoffMs: 200` and no log.

## What is covered

| TP | Test | Checks |
|---|---|---|
| TP-1 | two iPads edit the same floor offline, then sync (B first, then A) | 06M-03 and the photos merge silently; 06M-02 Notes → review with B's value official (D37, A7) and A's op `review` on both iPads; A's Status edit applies (different field); both field additions arrive with distinct punch numbers; both field-added devices show `06M-?` + `NEW` offline and get distinct server-assigned IDs after sync, `06M-04` (B, first to arrive) and `06M-05` (A) (D93, T63); the review item has A/B candidates; both stores converge. **T15:** Bob resolves with Combine ("A; B"); Ann's op is `rejected` on both iPads and the server, no item open, converged |
| TP-7 | network flaps and lost responses during a 1,200-op push | Both iPads push 100-op batches through a `Flapper` that drops requests 30–40 % of the time and throws away every 4th/5th push response (the server applied it: the resend answers `duplicate`); `drain` keeps calling `requestSync()`; afterwards every client op is on the server exactly once, `server_seq` is 1..n, all `applied`, numbers 1..5, both stores equal |
| TP-7 | a server restart mid-push | `docker compose restart api` fires as the second 500-op batch goes out; the client converges once the API is back; 1,003 client ops once each, 6 `assign`s, no gaps |
| TP-7 | a duplicate push | The same body pushed twice through `HttpTransport`: second answer is all `duplicate` with the same `server_seq` and the same `assign` ops; the engine's third push settles everything; numbers unchanged |
| TP-10 | create, delete, create again (× 4 numbered kinds) | numbering.test's script against the real counters: 06/06M share, 07 counts alone, deleted numbers stay retired, restore keeps the number, five `assign`s total |
| TP-11 | A deletes while B edits, B's edit arrives first | The delete goes to review (PLAN §3.2 step 4): official = not deleted with B's note; A keeps her deleted row (own value in review) and B's note still lands on it; punch items untouched. **T15:** Bob chooses A (keep): a Reconcile `restore` brings Ann's row back, her delete is `rejected`, converged with no exceptions |
| TP-11 | A's delete arrives first, then B's edit; A restores | The edit goes to review (set vs existing delete); B's row is deleted by pull but shows his in-review note. **T15:** Bob chooses A (keep deleted): a Reconcile `set` of the official note lands on the deleted record (D91) and B's row converges. The restore brings the device back on both with `create → delete → set(rejected) → set(Reconcile) → restore` in the log, punch items attached, ID kept: the next server-assigned ID on 06M is `06M-03` (D93) |
| T15 | delete first, B chooses B; a field group | Restore + set as one Reconcile group, B's op `superseded`; then Tracking status + Date closed reviewed as one item, resolved with A on both fields, both members `rejected`; converged |
| TP-11 | delete vs delete, then restore | Merges without a review item; converges everywhere |
| T87 | one person's ink layer from two iPads (D160, D162) | Ann on two installs writes one layer offline from the same copy, B syncs first: A's older write is `superseded` on both stores, no review item; `reconcileInkLayer` on A merges it, and after a sync both stores hold every stroke and find nothing left to merge. Both installs creating the layer offline give two rows, each with its strokes, on both |

`expectConverged(a, b, project, {except})` compares every row of `level`, `device`, `punch_item`,
`missing_part`, `photo`, `cable`, `cable_end`, `review_item` (deleted included), the field heads of
each row, and the op log `(op_id, server_seq, state)` of both stores against the server's, which
must be gap-free. `except` names records whose rows are expected to differ because one iPad holds
a value still in review (the A7 "official + in review" state); since T15 every test resolves its
items and converges without it.

## Known differences (not failures)

- `version` is not compared: a local apply plus a later remote apply of the official value count
  differently from a single remote apply.
- `deleted_at` is compared exactly since T15: the deleting iPad re-stamps it with `server_ts` when
  its own applied delete comes back (`Store.restampDelete`).
