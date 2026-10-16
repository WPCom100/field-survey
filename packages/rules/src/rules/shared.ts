/**
 * Helpers the rule files share (T34). Everything here reads the snapshot index only. The strings
 * are the master workbook's (CLAUDE.md §3 and `fixtures/…Master…xlsx`): signal words as the
 * master's punch items spell them ("Run DMX to …", "Run network to …", "Run Unison to …",
 * "Run fiber to …", "Run 120V to …").
 */

import type { RuleContext } from '../rule';
import type { CableEndRow, CableRow, DeviceRow, LevelRow, PlaceholderRow, PunchItemRow, Subject } from '../snapshot';

/** The signal word per cable code, as the master's items use it. */
export const SIGNAL: Readonly<Record<string, string>> = {
  X: 'DMX',
  N: 'network',
  NG: 'network & ground',
  U: 'Unison',
  F: 'fiber',
  P: 'panic',
  UV: 'UHCI-WM partition sensor',
  '0-10V': '0-10V',
  '120V': '120V',
  // D199 (T111): DALI loops, from the DaVinci library's DALI ports
  D: 'DALI',
};

export const NEURON_ITEM = 'Missing all Device Neuron IDs';
export const DMX_KITS_NOTE = 'Waiting on DMX Termination Kits';
export const BUS_LABEL = 'Stations & Sensors';

export function signalOf(code: string | null | undefined): string {
  return (code && SIGNAL[code]) || code || 'cable';
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function cableOf(ctx: RuleContext, end: CableEndRow): CableRow | null {
  return ctx.index.cable.get(end.cable_id) ?? null;
}

export function endDevice(ctx: RuleContext, end: CableEndRow): DeviceRow | null {
  return end.device_id ? (ctx.index.device.get(end.device_id) ?? null) : null;
}

/** The end's level: its own `level_id`, else its device's. */
export function endLevel(ctx: RuleContext, end: CableEndRow): LevelRow | null {
  if (end.level_id) {
    const l = ctx.index.level.get(end.level_id);
    if (l) return l;
  }
  const d = endDevice(ctx, end);
  return d ? (ctx.index.level.get(d.level_id) ?? null) : null;
}

export function endPlaceholder(ctx: RuleContext, end: CableEndRow): PlaceholderRow | null {
  return end.placeholder_id ? (ctx.index.placeholder.get(end.placeholder_id) ?? null) : null;
}

export function deviceLabel(ctx: RuleContext, d: DeviceRow): string {
  if (d.display_id) return d.display_id;
  const level = ctx.index.level.get(d.level_id);
  return `${level?.level ?? '?'}-?`;
}

/** `C-07`, or the device's ID while the server has not numbered the end. */
export function endLabel(ctx: RuleContext, end: CableEndRow): string {
  if (end.display_id) return end.display_id;
  const d = endDevice(ctx, end);
  return d ? `${deviceLabel(ctx, d)} ${signalOf(cableOf(ctx, end)?.cable)} end` : 'NEW';
}

/**
 * The far end as item text names it: the destination part of the To text ("DMX to Level B1
 * CTB1LCPB" → "Level B1 CTB1LCPB"), a single row's To text as it stands ("Fixtures", "EBDK
 * panic wire", "P-NSPS-D Power Supply" — its other end is only the placeholder that pairs the
 * row, "120v Power", which no item names; T35), else the other end's device (`Level 03 03-05`
 * on another level, the ID on the same level), the placeholder's label, else the To text
 * itself. Null when nothing names it.
 */
export function targetOf(ctx: RuleContext, end: CableEndRow): string | null {
  const to = str(end.to_text);
  if (to) {
    const m = /\s[Tt][Oo]\s+(.+)$/.exec(to);
    if (m?.[1]) return m[1].trim();
    if (cableOf(ctx, end)?.single_row) return to;
  }
  const other = ctx.index.otherEnd(end);
  if (other) {
    const d = endDevice(ctx, other);
    if (d) {
      const here = endLevel(ctx, end);
      const there = ctx.index.level.get(d.level_id);
      const id = deviceLabel(ctx, d);
      return there && there.id !== here?.id ? `Level ${there.level} ${id}` : id;
    }
    const p = endPlaceholder(ctx, other);
    if (p) return p.label;
  }
  return to;
}

export function isOpen(p: PunchItemRow): boolean {
  return p.tracking_status !== 'Closed';
}

/** Live punch items on a device and on its ends (each once). */
export function itemsOfDevice(ctx: RuleContext, device: DeviceRow): PunchItemRow[] {
  const out = new Map<string, PunchItemRow>();
  for (const p of ctx.index.punchByDevice.get(device.id) ?? []) out.set(p.id, p);
  for (const e of ctx.index.endsByDevice.get(device.id) ?? []) for (const p of ctx.index.punchByEnd.get(e.id) ?? []) out.set(p.id, p);
  return [...out.values()];
}

/** Is there a live, open punch item with exactly this text on the device or the end? */
export function hasOpenItemText(ctx: RuleContext, deviceId: string | null, endId: string | null, text: string): boolean {
  const rows = [...(deviceId ? (ctx.index.punchByDevice.get(deviceId) ?? []) : []), ...(endId ? (ctx.index.punchByEnd.get(endId) ?? []) : [])];
  return rows.some((p) => isOpen(p) && p.item === text);
}

/**
 * R5: far-end items wait for that floor's survey. An end on a level whose `Surveyed` date is not
 * set, and that nobody has surveyed on an iPad, raises no R3a / R3b / R4b item yet.
 */
export function waitsForSurvey(ctx: RuleContext, end: CableEndRow): boolean {
  const level = endLevel(ctx, end);
  if (!level) return false;
  return level.surveyed == null && end.surveyed_at == null && end.status_source !== 'surveyed';
}

export function subjectOfEnd(ctx: RuleContext, end: CableEndRow): Subject {
  return { entity_kind: 'cable_end', entity_id: end.id, level_id: endLevel(ctx, end)?.id ?? null };
}

export function subjectOfDevice(d: DeviceRow): Subject {
  return { entity_kind: 'device', entity_id: d.id, level_id: d.level_id };
}

export function noteHas(note: string | null, re: RegExp): boolean {
  return !!note && re.test(note);
}

/** Floor order, nulls last, then the level code. */
export function compareLevels(a: LevelRow, b: LevelRow): number {
  const fa = a.floor_order ?? Number.POSITIVE_INFINITY;
  const fb = b.floor_order ?? Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a.level.localeCompare(b.level);
}

/** `06M-S2` before `06M-S10`: digit runs compare as numbers. */
export function compareIds(a: string, b: string): number {
  const ta = a.split(/(\d+)/);
  const tb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i] ?? '';
    const y = tb[i] ?? '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x.localeCompare(y);
  }
  return 0;
}

/** The first live placeholder of a kind (or with a label), for a library draft's far end. */
export function placeholderFor(ctx: RuleContext, kind: string, label?: string): PlaceholderRow | null {
  const rows = [...ctx.index.placeholder.values()].sort((a, b) => a.id.localeCompare(b.id));
  return rows.find((p) => p.kind === kind) ?? (label ? (rows.find((p) => p.label === label) ?? null) : null);
}

/** The Termination item an `Issue` end gets once its run is pulled (R3a), or null when none applies. */
export function terminationItem(ctx: RuleContext, end: CableEndRow): { item: string; owner: 'EC' | 'ETC' | 'EC/ETC' } | null {
  if (end.status !== 'Issue') return null;
  const code = cableOf(ctx, end)?.cable ?? null;
  if (!code) return null;
  if (!noteHas(end.note, /not terminated|not landed|needs landing/i)) return null;
  if (code === 'X' && noteHas(end.note, /no term kit/i)) return null; // R3b's case
  if (code === '0-10V') return { item: 'Land 0-10V control wiring', owner: 'EC' };
  if (code === '120V') return { item: 'Land 120V power', owner: 'EC' };
  const target = targetOf(ctx, end);
  const item = target ? `Terminate ${signalOf(code)} to ${target}` : `Terminate ${signalOf(code)}`;
  const owner = code === 'N' || code === 'NG' || code === 'U' ? 'ETC' : code === 'F' || code === 'X' ? 'EC/ETC' : 'EC';
  return { item, owner };
}
