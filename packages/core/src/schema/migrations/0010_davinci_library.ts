/**
 * T111 (D197): `library_type.description`, `datasheet_url`, `source_ref` (`{kind: 'davinci',
 * type_id, …}`, what a re-run matches by) and `accessory_only` (imported as another type's
 * accessory, never offered as a device; null = placeable) — what the DaVinci library import keeps
 * on a type. `vocab.list` gains `cable_code`: a port protocol with no cable code becomes a draft
 * there, never a new code. SQLite cannot alter a CHECK, so `vocab` is rebuilt with the new list
 * (same columns, same index; rows copied). Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE library_type ADD COLUMN description TEXT`,
  `ALTER TABLE library_type ADD COLUMN datasheet_url TEXT`,
  `ALTER TABLE library_type ADD COLUMN source_ref TEXT`,
  `ALTER TABLE library_type ADD COLUMN accessory_only INTEGER`,
  `CREATE TABLE vocab_t111 (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
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
  `INSERT INTO vocab_t111 (id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state)
  SELECT id, project_id, list, value, canonical_of_id, version, head_seq, deleted_at, deleted_by_id, delete_reason, state FROM vocab`,
  `DROP TABLE vocab`,
  `ALTER TABLE vocab_t111 RENAME TO vocab`,
  `CREATE INDEX ix_vocab_project_id_list ON vocab (project_id, list)`,
];
