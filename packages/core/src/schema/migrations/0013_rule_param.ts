/**
 * T102 (D176, D211): `rule_param` — the rules' owners, wordings and statuses as settings, at the
 * app level (`project_id` null) and per project. No row = the built-in default. Frozen.
 */
export const statements: readonly string[] = [
  `CREATE TABLE rule_param (
  id TEXT NOT NULL,
  project_id TEXT,
  rule_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('draft', 'accepted', 'rejected')),
  version INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER,
  deleted_at TEXT,
  deleted_by_id TEXT,
  delete_reason TEXT,
  PRIMARY KEY (id)
)`,
  `CREATE INDEX ix_rule_param_project_id ON rule_param (project_id)`,
];
