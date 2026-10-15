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

import type { ConnectionStatus } from '@field-survey/core';

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

/** An accessory a type may carry (D52: an NSPS kit's power supply, expected 1). */
export interface LibraryAccessory {
  model: string;
  expected_qty: number | null;
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
    out.push({ model, expected_qty: typeof r.expected_qty === 'number' && Number.isFinite(r.expected_qty) ? r.expected_qty : null });
  }
  return out;
}

const modelKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** The type a device belongs to: its `library_type_id`, else a live, not rejected type matching its Device text. */
export function typeOfDevice(ctx: RuleContext, d: DeviceRow): LibraryTypeRow | null {
  if (d.library_type_id) return ctx.index.libraryType.get(d.library_type_id) ?? null;
  const text = str(d.device);
  if (!text) return null;
  const k = modelKey(text);
  const matches = [...ctx.index.libraryType.values()]
    .filter((t) => t.state !== 'rejected' && (modelKey(t.model) === k || (t.aliases ?? []).some((a) => typeof a === 'string' && modelKey(a) === k)))
    .sort((a, b) => Number(a.project_id == null) - Number(b.project_id == null) || a.id.localeCompare(b.id));
  return matches[0] ?? null;
}

/** The default cables an accepted type imposes on the device, or null when the category table applies. */
export function governingCables(ctx: RuleContext, d: DeviceRow): { type: LibraryTypeRow; cables: LibraryCable[] } | null {
  const type = typeOfDevice(ctx, d);
  if (!type || type.state !== 'accepted') return null;
  const cables = parseLibraryCables(type.default_cables);
  return cables.length ? { type, cables } : null;
}

function placeholderLabelled(ctx: RuleContext, label: string): PlaceholderRow | null {
  const k = label.toLowerCase();
  return [...ctx.index.placeholder.values()].sort((a, b) => a.id.localeCompare(b.id)).find((p) => p.label.toLowerCase() === k) ?? null;
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
        const ph = c.far ? placeholderLabelled(ctx, c.far) : null;
        const near: Record<string, unknown> = {
          side: 'A', endpoint_kind: 'device', device_id: d.id, level_id: d.level_id,
          from_text: c.from ?? str(d.panel_name) ?? str(d.device) ?? str(d.display_id), to_text: c.to,
          ...(c.status ? { status: c.status, status_source: 'derived' } : {}),
        };
        const far: Record<string, unknown> = ph
          ? { side: 'B', endpoint_kind: 'placeholder', placeholder_id: ph.id, level_id: ph.level_id, from_text: c.far, to_text: null }
          : { side: 'B', endpoint_kind: null, level_id: d.level_id, from_text: c.far, to_text: null };
        ctx.propose({
          subject: { entity_kind: 'device', entity_id: d.id, level_id: d.level_id },
          discriminator: n === 0 ? c.code : `${c.code}#${n + 1}`,
          kind: 'cable',
          payload: { cable: { cable: c.code, qty: c.qty, single_row: c.single_row, origin: 'library', endpoint_confirmed: true }, ends: [near, far] },
          inputs: { device: d.id, type: gov.type.id, cable: c },
          why: `${deviceLabel(ctx, d)} is a ${gov.type.model} (library: ${c.code} → ${c.to ?? c.far ?? 'its far end'}).`,
        });
      }
    }
  },
};
