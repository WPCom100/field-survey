/**
 * Device-type library cables (T48, Phase 3 §10, D183). A `library_type` row's `default_cables`
 * are templates of the runs every device of that type has; once the type is **accepted** it
 * governs its devices: R2g offers each missing run as a `cable` draft (D173), and the category
 * table of R2c / R2d (and their lints) stands aside for those devices. A draft or rejected type,
 * or one with no default cables, leaves the category table in charge. `U` rows are R2e's (one
 * Unison bus per level, not per device), so R2g never offers them.
 *
 * A device's type is its `library_type_id`; an imported device has none, so the project's (then
 * the app library's) type whose model or alias equals the device's Device text is used.
 */

import { roleOf, type ConnectionStatus, type Role } from '@field-survey/core';

import type { Rule, RuleContext } from '../rule';
import type { DeviceRow, LibraryTypeRow, PlaceholderRow } from '../snapshot';
import { SIGNAL, cableOf, deviceLabel, str } from './shared';

/** The cable codes a library row may name (CLAUDE.md §3). */
export const CABLE_CODES: readonly string[] = Object.keys(SIGNAL);

/** One run of a device type: its code and the texts the generated ends get. */
export interface LibraryCable {
  code: string;
  /** The device end's From text; empty = the device's panel name / model, as R2c writes it. */
  from: string | null;
  /** The device end's To text (`Fixtures`, `P-NSPS-D Power Supply`). */
  to: string | null;
  /** The far end: a placeholder of this label when the project has one, else its From text. */
  far: string | null;
  single_row: boolean;
  qty: number | null;
  /** A status the device end starts with (R2c's panic run: `Installed, untested`). */
  status: ConnectionStatus | null;
}

/**
 * An accessory a type may carry (D52: an NSPS kit's power supply, expected 1). A catalogue import
 * (T111, D197) also keeps the slot's `max_quantity` and, where the catalogue asks for "n of these",
 * the `group` the slot belongs to (`{label, min, max}`); `lint.accessory_group` reads both (T113).
 */
export interface LibraryAccessory {
  model: string;
  expected_qty: number | null;
  max_quantity?: number | null;
  group?: { label: string; min: number; max: number | null } | null;
}

const STATUSES: readonly string[] = ['Complete', 'Installed, untested', 'Issue', 'Not installed', 'No access', 'Not started'];

/** Read a stored cable list defensively: rows without a known code are dropped. */
export function parseLibraryCables(v: unknown): LibraryCable[] {
  if (!Array.isArray(v)) return [];
  const out: LibraryCable[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const code = str(r.code);
    if (!code || !CABLE_CODES.includes(code)) continue;
    const qty = typeof r.qty === 'number' && Number.isFinite(r.qty) ? r.qty : null;
    const status = typeof r.status === 'string' && STATUSES.includes(r.status) ? (r.status as ConnectionStatus) : null;
    out.push({ code, from: str(r.from), to: str(r.to), far: str(r.far), single_row: r.single_row === true, qty, status });
  }
  return out;
}

export function parseLibraryAccessories(v: unknown): LibraryAccessory[] {
  if (!Array.isArray(v)) return [];
  const out: LibraryAccessory[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const model = str(r.model);
    if (!model) continue;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const a: LibraryAccessory = { model, expected_qty: num(r.expected_qty) };
    if (num(r.max_quantity) !== null) a.max_quantity = num(r.max_quantity);
    const g = r.group && typeof r.group === 'object' ? (r.group as Record<string, unknown>) : null;
    if (g && str(g.label) && num(g.min) !== null) a.group = { label: str(g.label)!, min: num(g.min)!, max: num(g.max) };
    out.push(a);
  }
  return out;
}

const modelKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** What `findDeviceType` reads of a type; the app's own rows satisfy it too. */
export type TypeLike = Pick<LibraryTypeRow, 'id' | 'project_id' | 'model' | 'aliases' | 'state'>;

/**
 * The type a device belongs to among `types` (live rows of its project and the app library): its
 * `library_type_id`, else a not rejected type whose model or alias matches its Device text, the
 * project's before the app library's.
 */
export function findDeviceType<T extends TypeLike>(types: ReadonlyMap<string, T>, d: Pick<DeviceRow, 'library_type_id' | 'device'>): T | null {
  if (d.library_type_id) return types.get(d.library_type_id) ?? null;
  const text = str(d.device);
  if (!text) return null;
  const k = modelKey(text);
  const matches = [...types.values()]
    .filter((t) => t.state !== 'rejected' && (modelKey(t.model) === k || (t.aliases ?? []).some((a) => typeof a === 'string' && modelKey(a) === k)))
    .sort((a, b) => Number(a.project_id == null) - Number(b.project_id == null) || a.id.localeCompare(b.id));
  return matches[0] ?? null;
}

/** The type a device belongs to: its `library_type_id`, else a live, not rejected type matching its Device text. */
export function typeOfDevice(ctx: RuleContext, d: DeviceRow): LibraryTypeRow | null {
  return findDeviceType(ctx.index.libraryType, d);
}

/**
 * The device's role (T112, D201): its type's `role`, else the role its type's category implies,
 * else its own category's (`roleOf` in core). What R2c / R2d / R2e, the lints and the Neuron ID
 * default key on instead of the master's category strings.
 */
export function deviceRole(ctx: RuleContext, d: DeviceRow): Role {
  return roleOf(typeOfDevice(ctx, d), d);
}

/** Roles whose devices carry no Neuron ID unless their type says so (T68, D185). */
export const NO_NEURON_ROLES: readonly Role[] = ['equipment_rack', 'nsps'];

/** A role's Neuron ID default: off for racks and NSPS, on otherwise. */
export function neuronIdDefaultForRole(role: Role): boolean {
  return !NO_NEURON_ROLES.includes(role);
}

/** A category's Neuron ID default for a device with no type: off for a rack or NSPS category, on otherwise. */
export function neuronIdDefault(category: string | null | undefined): boolean {
  return neuronIdDefaultForRole(roleOf(null, { category: category ?? null }));
}

/**
 * Whether a device needs a Neuron ID (T68, D185): its type's `needs_neuron_id`, else the default of
 * its role (the type's, else the type's category's, else the device's own category's — D201).
 */
export function needsNeuronId(
  type: { needs_neuron_id?: boolean | null; category?: string | null; role?: unknown } | null,
  d: { category: string | null },
): boolean {
  if (type?.needs_neuron_id != null) return type.needs_neuron_id;
  return neuronIdDefaultForRole(roleOf(type, d));
}

/** `needsNeuronId` with the device's type looked up in the snapshot. */
export function deviceNeedsNeuronId(ctx: RuleContext, d: DeviceRow): boolean {
  return needsNeuronId(typeOfDevice(ctx, d), d);
}

/** The default cables an accepted type imposes on the device, or null when the category table applies. */
export function governingCables(ctx: RuleContext, d: DeviceRow): { type: LibraryTypeRow; cables: LibraryCable[] } | null {
  const type = typeOfDevice(ctx, d);
  if (!type || type.state !== 'accepted') return null;
  const cables = parseLibraryCables(type.default_cables);
  return cables.length ? { type, cables } : null;
}

/** The first (by id) of `placeholders` labelled `label`, case-insensitively. */
export function placeholderLabelled<P extends Pick<PlaceholderRow, 'id' | 'label' | 'level_id'>>(placeholders: Iterable<P>, label: string): P | null {
  const k = label.toLowerCase();
  return [...placeholders].sort((a, b) => a.id.localeCompare(b.id)).find((p) => p.label.toLowerCase() === k) ?? null;
}

/**
 * The `cable` proposal payload of one library run on a device (`decide.ts`): the cable with the
 * template's code / qty / single row, the device end with its From / To texts, and the far end on
 * the placeholder labelled `far` (else text only). R2g's drafts and the card's "+ add" (T105) both
 * build it here.
 */
export function libraryCablePayload(
  d: Pick<DeviceRow, 'id' | 'level_id' | 'panel_name' | 'device' | 'display_id'>,
  c: LibraryCable,
  placeholders: Iterable<Pick<PlaceholderRow, 'id' | 'label' | 'level_id'>>,
): { cable: Record<string, unknown>; ends: Record<string, unknown>[] } {
  const ph = c.far ? placeholderLabelled(placeholders, c.far) : null;
  const near: Record<string, unknown> = {
    side: 'A', endpoint_kind: 'device', device_id: d.id, level_id: d.level_id,
    from_text: c.from ?? str(d.panel_name) ?? str(d.device) ?? str(d.display_id), to_text: c.to,
    ...(c.status ? { status: c.status, status_source: 'derived' } : {}),
  };
  const far: Record<string, unknown> = ph
    ? { side: 'B', endpoint_kind: 'placeholder', placeholder_id: ph.id, level_id: ph.level_id, from_text: c.far, to_text: null }
    : { side: 'B', endpoint_kind: null, level_id: d.level_id, from_text: c.far, to_text: null };
  return { cable: { cable: c.code, qty: c.qty, single_row: c.single_row, origin: 'library', endpoint_confirmed: true }, ends: [near, far] };
}

/** `120V → P-NSPS-D Power Supply`: a library run (or a `cable` payload) as the card names it. */
export function cableTitle(code: string | null, to: string | null, far: string | null): string {
  return `${code ?? 'cable'} → ${to ?? far ?? 'its far end'}`;
}

function countCode(ctx: RuleContext, d: DeviceRow, code: string): number {
  return (ctx.index.endsByDevice.get(d.id) ?? []).filter((e) => cableOf(ctx, e)?.cable === code).length;
}

export const R2g: Rule = {
  id: 'R2g',
  title: 'Device-type library cables',
  text: "An accepted device type's default cables (Library) are offered as drafts for each of its devices that lacks them; for those devices the type replaces R2c / R2d's category table. Unison (U) stays per level (R2e).",
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      const gov = governingCables(ctx, d);
      if (!gov) continue;
      const seen = new Map<string, number>();
      for (const c of gov.cables) {
        if (c.code === 'U') continue;
        const n = seen.get(c.code) ?? 0;
        seen.set(c.code, n + 1);
        if (countCode(ctx, d, c.code) > n) continue; // the device already has this run
        ctx.propose({
          subject: { entity_kind: 'device', entity_id: d.id, level_id: d.level_id },
          discriminator: n === 0 ? c.code : `${c.code}#${n + 1}`,
          kind: 'cable',
          payload: libraryCablePayload(d, c, ctx.index.placeholder.values()),
          inputs: { device: d.id, type: gov.type.id, cable: c },
          why: `${deviceLabel(ctx, d)} is a ${gov.type.model} (library: ${cableTitle(c.code, c.to, c.far)}).`,
        });
      }
    }
  },
};
