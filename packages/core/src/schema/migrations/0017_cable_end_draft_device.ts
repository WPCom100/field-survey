/**
 * T136 (D235): `cable_end.draft_device_id` — the draft device an end waits for. A cable accepted
 * with one placed end is made at once; its other end names the unplaced draft here (no device
 * yet) until that draft is placed, when the end's `device_id` is set and the column stays as
 * provenance. Null on every other end, so no row is rewritten. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE cable_end ADD COLUMN draft_device_id TEXT`,
  `CREATE INDEX ix_cable_end_draft_device_id ON cable_end (draft_device_id)`,
];
