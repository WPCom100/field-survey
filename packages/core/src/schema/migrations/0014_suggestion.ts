/**
 * T99 (D174, D212): `suggestion` — the library's chips per device type, category and cable code,
 * at the app level (`project_id` null) and per project. Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE suggestion (
  id TEXT NOT NULL,
  project_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('type', 'category', 'code')),
  ref TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('device_note', 'connection_note', 'punch_item', 'part')),
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'accepted', 'rejected')),
  created_by_id TEXT,
  promoted_from_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER,
  deleted_at TEXT,
  deleted_by_id TEXT,
  delete_reason TEXT,
  PRIMARY KEY (id)
)`,
  `CREATE INDEX ix_suggestion_project_id ON suggestion (project_id)`,
  `CREATE INDEX ix_suggestion_ref ON suggestion (ref)`,
];
