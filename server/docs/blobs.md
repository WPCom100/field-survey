# Server blobs: resumable uploads and content (T12)

Photo, thumbnail, markup, ink and sheet bytes are content-addressed by SHA-256 and move apart
from the ops that reference them (PLAN §3.4, §8; D76: blob references are plain text, no FK;
D87). A record syncs at once; its bytes follow whenever the network allows.

## Files

| File | What |
|---|---|
| `app/blobs.py` | Declare, chunk, complete (assemble + hash check), status, content lookup. |
| `app/api/blobs.py` | The five routes under `/blobs`, all behind the bearer token. |
| `app/storage.py` | `ObjectStore` (`S3ObjectStore` for R2/SeaweedFS, `MemoryObjectStore` for tests), `get_object_store` dependency, `python -m app.storage check|ensure-bucket`. |
| `tests/test_blobs.py` | Every route and failure; two real-bucket tests that run when `S3_ENDPOINT` answers and skip with a reason otherwise. |

## Protocol

Chunk size is fixed at **2 MiB** (`2097152`); the last chunk is shorter. `chunks_total =
ceil(size / chunk_size)`; an empty blob has none.

| Route | Body | Answer |
|---|---|---|
| `POST /blobs/{sha}` | `{size, mime, width?, height?}` | `BlobOut`. Creates the row (`partial`) or returns the existing one. **This is the resume call**: `chunks_received` lists what the server holds. A complete blob answers `complete` (dedup: skip the bytes). 409 `size_mismatch`, 413 `too_large` (`BLOB_MAX_BYTES`, default 512 MiB), 422 `bad_sha`. |
| `PUT /blobs/{sha}/chunks/{n}` | raw bytes | `BlobOut`. Any order; repeats are harmless; after completion a no-op. 404 `unknown_blob`, 422 `bad_chunk` / `bad_chunk_length`. |
| `GET /blobs/{sha}` | — | `BlobOut`, or 404. |
| `POST /blobs/{sha}/complete` | — | `BlobOut` with `upload_state: complete`. 409 `missing_chunks` + `missing: [n…]` (also when the bucket lost a chunk the row listed); 422 `hash_mismatch` (chunks discarded, `chunks_received` reset, so a retry starts clean). Idempotent. |
| `GET /blobs/{sha}/content` | — | The bytes, `Content-Type` = declared mime, `ETag: "<sha>"`, `Cache-Control: private, max-age=31536000, immutable`. 404 `not_available` until complete. |

`BlobOut = {sha256, size, mime, width, height, upload_state, chunk_size, chunks_total,
chunks_received}`. Errors are FastAPI's `{"detail": {"error": "<code>", …}}`.

## Storage layout

| Key | What |
|---|---|
| `blobs/<sha>` | The finished object, written once (A14: never overwritten). |
| `blobs/.chunks/<sha>/<nnnnn>` | One object per received chunk, deleted after completion or a hash mismatch. |

Chunks are separate objects because S3/R2 multipart parts must be at least 5 MB. The `blob`
row (`upload_state`, `chunks_received`) plus the bucket are the whole state, so an upload
resumes across server restarts as well as app kills. `complete` holds the row lock (`FOR
UPDATE`) while it streams the chunks through SHA-256 into a spooled temp file (16 MB in RAM,
then disk) and uploads the result; a chunk `PUT` writes its object first and takes the lock
only to record the number.

Events are logged as JSON on the `blobs` logger: `blob_declared`, `blob_complete`,
`blob_hash_mismatch`, `blob_chunks_lost`, `blob_chunk_cleanup_failed`.

## Local S3

MinIO's images left Docker Hub, so the dev stack runs **SeaweedFS** as the `s3` service
(`chrislusf/seaweedfs:3.97`, port 9000, no identities: any key works). Once per fresh volume:

```
docker compose up -d postgres s3
docker compose run --rm api python -m app.storage ensure-bucket
# host-side: S3_ENDPOINT=http://localhost:9000 uv run python -m app.storage check
```

Production is unchanged: R2 from `.env`, and `docker-compose.prod.yml` keeps `s3` behind the
`dev-only` profile.
