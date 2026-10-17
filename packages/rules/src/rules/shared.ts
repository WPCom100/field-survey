/**
 * Helpers the rule files share (T34). Everything here reads the snapshot index only. The strings
 * are the master workbook's (CLAUDE.md §3 and `fixtures/…Master…xlsx`) as the built-in defaults
 * of the rule parameters (T102, `../params.ts`): signal words as the master's punch items spell
 * them ("Run DMX to …", "Run network to …", "Run Unison to …", "Run fiber to …", "Run 120V to …").
 */

import { DEFAULT_PARAMS, fillTemplate, flagParam, ownerParam, templatePattern, textParam, type ParamRef } from '../params';
import type { RuleContext } from '../rule';
import type { CableEndRow, CableRow, DeviceRow, LevelRow, MissingPartRow, PlaceholderRow, PunchItemRow, Subject } from '../snapshot';

/** The default signal word per cable code, as the master's items use it (the `R3.signal` parameter). */
export const SIGNAL: Readonly<Record<string, string>> = DEFAULT_PARAMS.get('R3', 'signal') as Record<string, string>;

/** The parameters' defaults under the names T34 gave them (tests and docs). */
export const NEURON_ITEM = textParam(DEFAULT_PARAMS, 'R3c', 'item');
export const DMX_KITS_NOTE = textParam(DEFAULT_PARAMS, 'R3b', 'notes', 'X');
export const BUS_LABEL = 'Stations & Sensors';

/** The default signal word of a code (no project parameters); `signal(ctx, code)` reads the project's. */
export function signalOf(code: string | null | undefined): string {
  return (code && SIGNAL[code]) || code || 'cable';
}

/** The project's signal word for a cable code (`R3.signal`), else the code itself. */
export function signal(ctx: RuleContext, code: string | null | undefined): string {
  if (!code) return 'cable';
  const map = ctx.param('R3', 'signal') as Record<string, string>;
  return map[code] || code;
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function cableOf(ctx: RuleContext, end: CableEndRow): CableRow | null {
  return ctx.index.cable.get(end.cable_id) ?? null;
}

/**
 * Does the cable take termination kits (T103, D213)? Its own `term_kit` when set, else its code's
 * `R4b.kit` rule parameter (X, F, N and NG by default).
 */
export function takesKits(ctx: RuleContext, cable: CableRow | null | undefined): boolean {
  if (!cable) return false;
  if (cable.term_kit != null) return !!cable.term_kit;
  return ctx.params.flagCode('R4b', 'kit', cable.cable);
}

/** The kit item's Notes for a cable code (`R3b.notes`, `<signal>` filled). */
export function kitNote(ctx: RuleContext, code: string | null | undefined): string {
  return fillTemplate(textParam(ctx.params, 'R3b', 'notes', code), { signal: signal(ctx, code) });
}

/**
 * The cable code a kit item's Notes name ("Waiting on Fiber Termination Kits" → `F`): the first
 * code whose kit Notes the item's Notes carry, the project's wording first, then the defaults.
 * Null when none does.
 */
export function kitNoteCode(ctx: RuleContext, notes: string | null): string | null {
  if (!notes) return null;
  const have = notes.toLowerCase();
  const codes = [...new Set(['X', ...Object.keys(ctx.param('R3b', 'notes') as object), ...Object.keys(ctx.param('R3', 'signal') as object)])].filter((c) => c !== '*');
  for (const c of codes) if (have.includes(kitNote(ctx, c).toLowerCase())) return c;
  for (const c of codes) {
    const def = fillTemplate(textParam(DEFAULT_PARAMS, 'R3b', 'notes', c), { signal: signalOf(c) });
    if (have.includes(def.toLowerCase())) return c;
  }
  return null;
}

/**
 * A kit item (R3b): made by R3b, or a `Missing part` item whose Notes carry a kit note ("Waiting
 * on DMX Termination Kits", the project's `R3b.notes` per code, or the defaults).
 */
export function isKitItem(ctx: RuleContext, p: PunchItemRow): boolean {
  if (p.rule_id === 'R3b') return true;
  return p.type === 'Missing part' && kitNoteCode(ctx, p.notes) != null;
}

/** A termination kit part: made by R4b, or a part whose text names a kit ("DMX termination kit - …", "Fiber kit part"). */
export function isKitPart(m: { rule_id: string | null; part: string | null }): boolean {
  return m.rule_id === 'R4b' || /\bkit\b/i.test(m.part ?? '');
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The end of `deviceId` on a cable that takes kits whose far end `destination` names — the same
 * text, else one containing the other ("Level 04" ~ "Level 04 CT04LCPA") — skipping `taken`. How
 * a kit or kit item the seed import left without an end (the master links items to devices
 * only) finds its run (D213). Null when none or no destination.
 */
export function endByDestination(ctx: RuleContext, deviceId: string | null, destination: string | null, taken: ReadonlySet<string>): CableEndRow | null {
  if (!deviceId || !destination) return null;
  const d = normText(destination);
  const ends = (ctx.index.endsByDevice.get(deviceId) ?? [])
    .filter((e) => !taken.has(e.id) && takesKits(ctx, cableOf(ctx, e)))
    .map((e) => ({ e, t: normText(targetOf(ctx, e) ?? '') }))
    .filter((x) => x.t);
  return (ends.find((x) => x.t === d) ?? ends.find((x) => x.t.includes(d) || d.includes(x.t)))?.e ?? null;
}

/** What a kit part's text names as the run ("DMX termination kit - Level 03 run" → "Level 03"), or null. */
export function kitDestination(ctx: RuleContext, part: string | null): string | null {
  if (!part) return null;
  const codes = Object.keys(ctx.param('R4b', 'part') as object);
  for (const c of codes) {
    const m = templatePattern(fillTemplate(textParam(ctx.params, 'R4b', 'part', c), { signal: signal(ctx, c === '*' ? null : c) }), 'far end').exec(part)?.[1];
    if (m?.trim()) return m.trim();
  }
  return /\bkit\s*-\s*(.+?)\s+run$/i.exec(part)?.[1]?.trim() ?? null;
}

/**
 * The ends that already have their termination kit (one kit per end, D213): a live kit part
 * sourced to the end itself, or to a punch item on the end (its kit item, or the Run item of an
 * unpulled run — Closed once the wire is pulled, still the end's). A kit with no such source (as
 * imported) counts for the end of its device its text names (`endByDestination`).
 */
export function endsWithKit(ctx: RuleContext): Set<string> {
  const out = new Set<string>();
  const loose: MissingPartRow[] = [];
  for (const m of ctx.index.missingPart.values()) {
    if (!isKitPart(m)) continue;
    let placed = false;
    for (const s of ctx.index.sourcesByPart.get(m.id) ?? []) {
      const endId = s.target_kind === 'cable_end' ? s.target_id : s.target_kind === 'punch' ? ctx.index.punchItem.get(s.target_id)?.cable_end_id : null;
      if (endId) {
        out.add(endId);
        placed = true;
      }
    }
    if (!placed) loose.push(m);
  }
  for (const m of loose) {
    const e = endByDestination(ctx, m.device_id, kitDestination(ctx, m.part), out);
    if (e) out.add(e.id);
  }
  return out;
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
  return d ? `${deviceLabel(ctx, d)} ${signal(ctx, cableOf(ctx, end)?.cable)} end` : 'NEW';
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
 * set, and that nobody has surveyed on an iPad, raises no R3a / R3b / R4b item yet. The gate is a
 * parameter (`R5.enabled`, T102); off, nothing waits.
 */
export function waitsForSurvey(ctx: RuleContext, end: CableEndRow): boolean {
  if (!flagParam(ctx.params, 'R5', 'enabled')) return false;
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
export function terminationItem(
  ctx: RuleContext,
  end: CableEndRow,
): { item: string; owner: 'EC' | 'ETC' | 'EC/ETC'; params: ParamRef[] } | null {
  if (end.status !== 'Issue') return null;
  const code = cableOf(ctx, end)?.cable ?? null;
  if (!code) return null;
  if (!noteHas(end.note, /not terminated|not landed|needs landing/i)) return null;
  if (noteHas(end.note, /no term kit/i) && takesKits(ctx, cableOf(ctx, end))) return null; // R3b's case
  const item = fillTemplate(textParam(ctx.params, 'R3a', 'terminate.item', code), { signal: signal(ctx, code), 'far end': targetOf(ctx, end) });
  const owner = ownerParam(ctx.params, 'R3a', 'terminate.owner', code);
  return { item, owner, params: [['R3a', 'terminate.item', code], ['R3a', 'terminate.owner', code], ['R3', 'signal', code]] };
}
