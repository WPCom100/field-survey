/**
 * T86 (D155): `install` — one row per iPad (`id` = install id) holding its label. Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE install (
  id TEXT NOT NULL,
  label TEXT,
  user_id TEXT,
  updated_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER,
  deleted_at TEXT,
  deleted_by_id TEXT,
  delete_reason TEXT,
  PRIMARY KEY (id)
)`,
];
