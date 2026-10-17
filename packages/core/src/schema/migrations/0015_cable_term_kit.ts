/**
 * T103 (D213): `cable.term_kit` — whether this cable takes termination kits, over its code's
 * `R4b.kit` rule parameter. Null = the code's setting, so no row is rewritten here: a fresh iPad
 * rebuilds the table from ops and must read the same. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE cable ADD COLUMN term_kit INTEGER`,
];
