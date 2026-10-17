/**
 * Device roles (T112, D196 (2), D201). The rules, the lints, the ID scheme, the Punch List
 * Device text and the pin shapes used to key on five literal category strings (`NSPS`,
 * `Relay panel`, `Foundry panel`, `Equipment rack`, `EBDK`). Those strings were the master's
 * categories (D1); the D196 eleven replaced them, and a category is a label a project may edit.
 * What a rule needs is the device's **role**: what kind of thing it is in the installation.
 *
 * - `library_type.role` carries it. The DaVinci import sets it on a type it creates (D199 (3));
 *   the library editor edits it.
 * - `roleOf(type, device)`: the type's role, else the role of the type's category, else of the
 *   device's own category (every imported device has no type), through `roleOfCategory`.
 * - `roleOfCategory` understands the master's eight (one role each) and, of the eleven, only the
 *   ones that name one role: `Emergency Equipment` → ebdk, `Equipment Panels` / `Equipment Rack`
 *   → equipment_rack, `Touchscreen`, `Station`, `Sensor`. `Power Distribution` (relay and Foundry
 *   panels, racks, zone controllers…) and `Equipment` (NSPS, gateways, switches…) name several
 *   roles, so a device of those categories with no type is `other`: the type carries the role.
 *
 * No React, Expo or DB: the same table serves packages/rules, the app and (mirrored in
 * `server/app/roles.py`) the server.
 */

export const ROLE = ['relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', 'station', 'sensor', 'other'] as const;
export type Role = (typeof ROLE)[number];

/** The role as the rules and lints name it in messages (the master's own words, D1). */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  relay_panel: 'Relay panel',
  foundry_panel: 'Foundry panel',
  ebdk: 'EBDK',
  equipment_rack: 'Equipment rack',
  nsps: 'NSPS',
  touchscreen: 'Touchscreen',
  station: 'Station',
  sensor: 'Sensor',
  other: 'Other',
};

/** `vocab(category)` as seeded (D196; CLAUDE.md §3), in the pickers' order. */
export const DEVICE_CATEGORIES = [
  'Power Distribution',
  'Emergency Equipment',
  'Equipment',
  'Equipment Panels',
  'Equipment Rack',
  'Power Supplies',
  'Wall Plates',
  'Lighting Console',
  'Touchscreen',
  'Station',
  'Sensor',
] as const;

/**
 * The master's categories (D1) that the D196 eleven renamed, old → new. Seeded as old spellings
 * of their canonical value (`vocab.canonical_of`); the rename ruling (T37, PLAN §6.4) retrofits
 * the records. The other three (`Touchscreen`, `Station`, `Sensor`) kept their names.
 */
export const MASTER_CATEGORY_RENAME: Readonly<Record<string, string>> = {
  'Relay panel': 'Power Distribution',
  'Foundry panel': 'Power Distribution',
  EBDK: 'Emergency Equipment',
  NSPS: 'Equipment',
  'Equipment rack': 'Equipment Panels',
};

/** A category as the eleven spell it: an old master spelling becomes its canonical value. */
export function canonicalCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  return MASTER_CATEGORY_RENAME[category] ?? category;
}

const ROLE_OF_CATEGORY: Readonly<Record<string, Role>> = {
  // the master's eight (D1): one role each
  'Relay panel': 'relay_panel',
  'Foundry panel': 'foundry_panel',
  EBDK: 'ebdk',
  'Equipment rack': 'equipment_rack',
  NSPS: 'nsps',
  Touchscreen: 'touchscreen',
  Station: 'station',
  Sensor: 'sensor',
  // of the eleven (D196), those that name one role
  'Emergency Equipment': 'ebdk',
  'Equipment Panels': 'equipment_rack',
  'Equipment Rack': 'equipment_rack',
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLE as readonly string[]).includes(v);
}

/** The role a category implies for a device with no type; `other` when it implies none or several. */
export function roleOfCategory(category: string | null | undefined): Role {
  return (category && ROLE_OF_CATEGORY[category]) || 'other';
}

/** What `roleOf` reads of a library type; a stored row satisfies it. */
export type RoleSource = { role?: unknown; category?: string | null } | null | undefined;

/**
 * The device's role: its type's `role`, else the role of the type's category, else of the
 * device's own category.
 */
export function roleOf(type: RoleSource, device: { category?: string | null } | null | undefined): Role {
  if (type && isRole(type.role)) return type.role;
  return roleOfCategory(type?.category ?? device?.category);
}
