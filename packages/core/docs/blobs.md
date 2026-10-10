# Client blobs: upload queue, prefetch, cache (T12)

`BlobQueue` (`src/blobs.ts`) moves photo, thumbnail, markup, ink and sheet bytes between the
iPad sandbox and the server's `/blobs` routes (`server/docs/blobs.md`). Decisions: D87.

## Using it

| Call | What |
|---|---|
| `addLocal({sha256, kind, path, size, mime, width?, height?})` | Register bytes already written to the sandbox (T21 capture, setup sheets) and queue the upload. Idempotent; never touches the network; kicks a run if the queue is started. Write the file to `files.pathFor(sha, kind)` first. |
| `ensureLocal(sha, kind)` | Full-size on demand: the cached path, or a download now. `null` when offline, not uploaded yet, or no server. Concurrent calls share one download. |
| `localPath(sha, {touch?})` | The cached path or `null`; marks it used for the LRU unless `touch: false`. |
| `photosWaiting()` | Photos (not deleted) whose image, thumbnail or markup has not reached the server: the "N photos waiting" count. |
| `status()` / `subscribe(fn)` / `refresh()` | `BlobQueueStatus` for the status bar and Sync screen: state, `photosWaiting`, `uploadsPending`/`uploadBytesPending`, `uploadsFailed`, `downloadsPending`, `cacheBytes`, `lastError`, `failures`, `nextAttemptAt`. |
| `start()` / `stop()` / `requestRun()` / `kick()` / `run()` | Scheduling, as `SyncEngine`: a run at start and every 60 s, backoff 5 s doubling to 5 min after a network failure, `requestRun` on foreground. Runs never overlap. |
| `setTransport(t)` | Attach or drop the server (`null` = `no_token`: captures are kept and counted). |
| `prefetch()` / `evict()` | Exposed for tests and the Sync screen; `run()` calls both. |

## One run

1. **Recover**: rows left `active` by a killed app go back to `queued`.
2. **Uploads**, one blob at a time in `UPLOAD_PRIORITY` order: thumb 0, markup/ink 1, image 2,
   sheet 3, export 4 (then oldest first). Per blob: `declare` (answers with the chunks the
   server already holds, or `complete` → skip), `putChunk` for each missing chunk with
   `blob.chunks_received` saved after each, `complete`. A `missing_chunks` answer re-declares
   and resends once. Outcomes: done; **failed** (`BlobUploadError`: file missing, bytes ≠
   SHA-256, size disagrees with the server; never retried, counted in `uploadsFailed`, the
   photo still counts as waiting); retry later with per-row backoff (4xx/5xx); or stop the pass
   (network, 401).
3. **Prefetch**: queue downloads for the display sheets and photo thumbnails of levels the
   current user is assigned to (`assignment` link, not deleted) that are not cached. A
   finished download whose file was evicted is queued again.
4. **Downloads**, four at a time in `DOWNLOAD_PRIORITY` order (sheet 0, thumb 1, …). A 404
   means the author has not uploaded yet: retried after `notFoundRetryMs` (2 min) without
   counting as a failed run.
5. **Evict** down to `cacheBudgetBytes` (3 GiB): least recently used first, full-size images
   and exports before thumbnails, sheets and strokes; never bytes not yet on the server, never
   anything used within `evictGraceMs` (10 min).

## Tables

| Table | Use |
|---|---|
| `blob` | One row per known blob. `upload_state` `local` → `partial` → `complete` (downloads are `complete`), `chunks_received` (JSON), `local_path` (null = not cached), `last_used_at` (LRU), `kind` (migration 0002). Written by the queue only, not by ops: like the server's `blob` table, it is byte bookkeeping, not survey data. |
| `blob_queue` | One row per (sha, direction): `state` `queued`/`active`/`done`/`failed`, `priority`, `attempts`, `next_attempt_at`, `last_error`. Done rows stay as history. |

## Runtime pieces

| Piece | Node tests | iPad |
|---|---|---|
| `BlobTransport` | `FakeBlobServer` (`src/testing/`, kill + fault injection), or `HttpBlobTransport` with `readRange`/`writeFile` | `ExpoBlobTransport` (`app/src/blobs/`): chunk cut to a temp file and sent with an `expo-file-system` `UploadTask` (background session); downloads with `File.downloadFileAsync` |
| `BlobFiles` | `NodeBlobFiles(dir)` | `ExpoBlobFiles`: `Documents/blobs/<sha>.<ext>`, paths stored **relative** to Documents because iOS moves the app container on every update |

`src/blobs.e2e.test.ts` runs the queue against a real server when `FIELD_SURVEY_E2E_URL` and
`FIELD_SURVEY_E2E_TOKEN` are set; it skips otherwise. It is part of `pnpm --filter
@field-survey/core test:e2e` and the CI `e2e` job (T14, `docs/e2e.md`).
