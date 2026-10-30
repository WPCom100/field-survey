/**
 * A device's type, role and Neuron ID need, for the screens that read the store directly (card,
 * dashboard, plan). The rules themselves are `needsNeuronId` and `roleOf` (packages/rules and
 * core); this loads the types they read: the project's own and the app library's (D183 (4)).
 */

import { isRole, roleOf, type Role, type Store } from '@field-survey/core';
import { findDeviceType, needsNeuronId, parseLibraryAccessories, type TypeLike } from '@field-survey/rules';

/** The row as stored; the card also reads its optional cables and accessories (T105). */
export type DeviceType = TypeLike & {
  category: string | null;
  needs_neuron_id: boolean | null;
  /** T112 (D201): what its devices are; null = the category's role. */
  role?: string | null;
  default_cables?: unknown;
  optional_cables?: unknown;
  optional_accessories?: unknown;
  /** T111: another type's accessory, never offered as a device (T126). */
  accessory_only?: unknown;
};

export type DeviceTypes = ReadonlyMap<string, DeviceType>;

/** The live types a project's devices may be of: its own and the app library's. */
export async function loadDeviceTypes(store: Store, projectId: string): Promise<DeviceTypes> {
  const rows = await store.list<DeviceType>('library_type', { where: 'project_id = ? OR project_id IS NULL', params: [projectId] });
  return new Map(rows.map((t) => [t.id, t] as const));
}

/** @deprecated T112: `loadDeviceTypes` (the same map; it serves roles too). */
export const loadNeuronTypes = loadDeviceTypes;
export type NeuronTypes = DeviceTypes;
export type NeuronType = DeviceType;

type DeviceLike = { category?: unknown; device?: unknown; library_type_id?: unknown };

const text = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/** The device's type among `types` (its `library_type_id`, else its Device text), or null. */
export function typeOf(types: DeviceTypes, d: DeviceLike): DeviceType | null {
  return findDeviceType(types, { device: text(d.device), library_type_id: text(d.library_type_id) });
}

/** The device's role (T112, D201): its type's, else its type's category's, else its own category's. */
export function roleOfDevice(types: DeviceTypes, d: DeviceLike): Role {
  return roleOf(typeOf(types, d), { category: text(d.category) });
}

/**
 * The type and role a device placed from a draft gets (T115 → T46): the catalogue type whose model
 * or alias is the draft's model (D183 (4)), and the role — that type's own `role`, else the role
 * the extraction read, else what the type's category (or the draft's) names.
 */
export function typeForDraft(types: DeviceTypes, d: { model: string | null; role?: Role | null; category: string | null }): { type: DeviceType | null; role: Role } {
  const type = findDeviceType(types, { device: text(d.model), library_type_id: null });
  if (type && isRole(type.role)) return { type, role: type.role };
  if (d.role && d.role !== 'other') return { type, role: d.role };
  return { type, role: roleOf(type, { category: text(d.category) }) };
}

export function deviceNeedsNeuron(types: DeviceTypes, d: DeviceLike): boolean {
  return needsNeuronId(typeOf(types, d), { category: text(d.category) });
}

/** The type a model names (its model or an alias), else null. */
export function typeOfModel(types: DeviceTypes, model: string | null): DeviceType | null {
  return findDeviceType(types, { device: text(model), library_type_id: null });
}

/** The accessory-only type (T111) a model names, else null (T126: such a draft is an accessory, never a device). */
export function accessoryTypeOf(types: DeviceTypes, model: string | null): DeviceType | null {
  const t = typeOfModel(types, model);
  return t && (t.accessory_only === true || t.accessory_only === 1) ? t : null;
}

const key = (s: string) => s.replace(/\s+/g, '').toUpperCase();
const keysOf = (t: DeviceType): string[] => [t.model, ...(t.aliases ?? [])].filter((a): a is string => typeof a === 'string').map(key);

/**
 * Whether `parent` lists `accessory` among its optional accessories (T126, as the BOM extraction
 * reads it): a slot names the accessory as the DaVinci import does — its model, or the renamed
 * `<name> (<part number>)` when the model was taken (D197) — so the name before the parenthesis
 * counts too, as do the slot model's own type's model and aliases.
 */
export function listsAccessory(types: DeviceTypes, parent: DeviceType, accessory: DeviceType): boolean {
  const want = new Set(keysOf(accessory));
  return parseLibraryAccessories(parent.optional_accessories).some(({ model }) => {
    const slot = findDeviceType(types, { device: model, library_type_id: null });
    const keys = [key(model), key(model.replace(/\s*\([^()]*\)$/, '')), ...(slot ? keysOf(slot) : [])];
    return keys.some((k) => want.has(k));
  });
}
