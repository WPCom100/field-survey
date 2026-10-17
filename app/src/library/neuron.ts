/**
 * A device's type, role and Neuron ID need, for the screens that read the store directly (card,
 * dashboard, plan). The rules themselves are `needsNeuronId` and `roleOf` (packages/rules and
 * core); this loads the types they read: the project's own and the app library's (D183 (4)).
 */

import { roleOf, type Role, type Store } from '@field-survey/core';
import { findDeviceType, needsNeuronId, type TypeLike } from '@field-survey/rules';

/** The row as stored; the card also reads its optional cables and accessories (T105). */
export type DeviceType = TypeLike & {
  category: string | null;
  needs_neuron_id: boolean | null;
  /** T112 (D201): what its devices are; null = the category's role. */
  role?: string | null;
  default_cables?: unknown;
  optional_cables?: unknown;
  optional_accessories?: unknown;
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

export function deviceNeedsNeuron(types: DeviceTypes, d: DeviceLike): boolean {
  return needsNeuronId(typeOf(types, d), { category: text(d.category) });
}
