/**
 * T68 (D185): `library_type.needs_neuron_id` — whether devices of the type carry a Neuron ID.
 * Null = the category's default (off for Equipment rack and NSPS, on otherwise), so no row is
 * rewritten here: a fresh iPad rebuilds the table from ops and must read the same. Frozen.
 */
export const statements: readonly string[] = [
  `ALTER TABLE library_type ADD COLUMN needs_neuron_id INTEGER`,
];
