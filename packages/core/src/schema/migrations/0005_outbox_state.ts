/**
 * T75 (D145): `outbox.state` — `pending` rows are pushed; a group the server refused with 409/422
 * is `quarantined` with the server's error in `last_error` and leaves the pipe free for the rest,
 * until the Sync screen's Retry puts it back to `pending`. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'quarantined'))`,
];
