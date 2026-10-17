/**
 * T104 (D214): app-level vocabulary — `vocab.project_id` null = the app library's value, carried
 * on the library stream (D184) like `library_type`, `rule_param` and `suggestion`. SQLite cannot
 * drop a NOT NULL, so `vocab` is rebuilt (same columns, list CHECK and index; rows copied). Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE vocab_t104 (
  id TEXT NOT NULL,
  project_id TEXT,
  list TEXT NOT NULL CHECK (list IN ('device_note', 'punch_item', 'punch_note', 'part_note', 'connection_note', 'photo_caption', 'model_map', 'level_alias', 'category', 'type', 'cable_code')),
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
  `INSERT INTO vocab_t104 (id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state)
  SELECT id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state FROM vocab`,
  `DROP TABLE vocab`,
  `ALTER TABLE vocab_t104 RENAME TO vocab`,
  `CREATE INDEX ix_vocab_project_id_list ON vocab (project_id, list)`,
];
