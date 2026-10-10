/**
 * T12 (D87): the client `blob` row records what the bytes are (`thumb`, `image`, `sheet`…) so the
 * LRU cache can evict full-size images before thumbnails and display sheets. Client-only, like
 * `local_path` and `last_used_at`; the server's `blob` table has no such column. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE blob ADD COLUMN kind TEXT CHECK (kind IN ('thumb', 'image', 'markup', 'ink', 'sheet', 'export'))`,
  `CREATE INDEX ix_blob_local_path ON blob (local_path)`,
];
