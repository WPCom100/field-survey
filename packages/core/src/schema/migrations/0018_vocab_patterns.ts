/**
 * T79 (D240): `vocab.list` gains `room_code_pattern` and `tag_pattern` — the plans job's text
 * pass, one regular expression per row, edited on the Vocabulary screen and copied with the
 * project. SQLite cannot alter a CHECK, so `vocab` is rebuilt (same columns and index; rows
 * copied). Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE vocab_t79 (
  id TEXT NOT NULL,
  project_id TEXT,
  list TEXT NOT NULL CHECK (list IN ('device_note', 'punch_item', 'punch_note', 'part_note', 'connection_note', 'photo_caption', 'model_map', 'level_alias', 'category', 'type', 'cable_code', 'room_code_pattern', 'tag_pattern')),
  value TEXT NOT NULL,
  canonical_of_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER,
  deleted_at TEXT,
  deleted_by_id TEXT,
  delete_reason TEXT,
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('draft', 'accepted', 'rejected')),
  PRIMARY KEY (id)
)`,
  `INSERT INTO vocab_t79 (id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state)
  SELECT id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state FROM vocab`,
  `DROP TABLE vocab`,
  `ALTER TABLE vocab_t79 RENAME TO vocab`,
  `CREATE INDEX ix_vocab_project_id_list ON vocab (project_id, list)`,
];
