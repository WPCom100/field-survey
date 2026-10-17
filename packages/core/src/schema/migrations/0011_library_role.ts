/**
 * T112 (D196 (2), D201): `library_type.role` — what kind of thing the type's devices are
 * (`relay_panel`, `foundry_panel`, `ebdk`, `equipment_rack`, `nsps`, `touchscreen`, `station`,
 * `sensor`, `other`). The rules, the ID scheme, the Punch List Device text and the pin shapes
 * read it instead of the master's category strings; null = the category's role
 * (`roleOfCategory` in core). No row is rewritten: a fresh iPad rebuilds the table from ops and
 * must read the same. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE library_type ADD COLUMN role TEXT CHECK (role IN ('relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', 'station', 'sensor', 'other'))`,
];
