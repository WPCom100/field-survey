/**
 * T45 (D147): `sheet.features` — the plan text pass beside `grid_sets`: rooms, device tags, loose
 * bubbles and the source-sheet boundaries (JSON, written by the server's plans job). Frozen.
 */
export const statements: readonly string[] = [`ALTER TABLE sheet ADD COLUMN features TEXT`];
