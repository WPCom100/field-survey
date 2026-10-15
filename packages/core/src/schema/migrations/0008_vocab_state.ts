/**
 * T40 (D182): `vocab.state` — a value added to a project list is a `draft` until Landry accepts it
 * (D43/D48); rows that existed before are `accepted`. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE vocab ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('draft', 'accepted', 'rejected'))`,
];
