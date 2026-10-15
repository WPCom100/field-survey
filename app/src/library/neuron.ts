/**
 * Which devices need a Neuron ID (T68, D185), for the screens that read the store directly (card,
 * dashboard). The rule itself is `needsNeuronId` in packages/rules; this loads the types it reads.
 */

import type { Store } from '@field-survey/core';
import { findDeviceType, needsNeuronId, type TypeLike } from '@field-survey/rules';

type NeuronType = TypeLike & { category: string | null; needs_neuron_id: boolean | null };

export type NeuronTypes = ReadonlyMap<string, NeuronType>;

/** The live types a project's devices may be of: its own and the app library's. */
export async function loadNeuronTypes(store: Store, projectId: string): Promise<NeuronTypes> {
  const rows = await store.list<NeuronType>('library_type', { where: 'project_id = ? OR project_id IS NULL', params: [projectId] });
  return new Map(rows.map((t) => [t.id, t] as const));
}

type DeviceLike = { category?: unknown; device?: unknown; library_type_id?: unknown };

const text = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

export function deviceNeedsNeuron(types: NeuronTypes, d: DeviceLike): boolean {
  const device = { category: text(d.category), device: text(d.device), library_type_id: text(d.library_type_id) };
  return needsNeuronId(findDeviceType(types, device), device);
}
