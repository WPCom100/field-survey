/**
 * First use of a type (T200, D292 (1), (2)): the first time a device of a **draft** type enters a
 * project — Add device, placing a draft, accepting a device draft — the app asks, per cable row
 * of the type, Required or Optional, and the answer is written to the type in the one library.
 * An accessory's type is asked the same way the first time that accessory is added to a device
 * (a forced slot counts as added with the device, T199 / D297 (1)). Several at once (Accept all,
 * a seed import) are listed once, as one "Types to set up" step — never one question per device.
 *
 * - **Asked:** a live, project-less type in `draft` state with at least one cable row. A draft with
 *   no row (a model typed in the field) has nothing to answer and stays a draft for the Library.
 *   Once a type is accepted — by this answer on any iPad, or by a review in the Library — it is
 *   never asked again: the question reads the type's state as this iPad last pulled it.
 * - **Preset:** a row the type already requires (`default_cables`) and a row named in the import's
 *   `source_ref.exceptions` (D291: a supply's 120V, a rack shell's) start as Required, every other
 *   row as Optional.
 * - **Confirm** writes `default_cables` (the Required rows), `optional_cables` (the Optional ones)
 *   and `state: accepted` as one group on the library stream — the one type edit D292 (1) allows
 *   outside the Library screen. Two iPads answering the same type offline meet in the library's
 *   conflict review like any two edits of the same fields.
 * - **Later** writes nothing: the type stays a draft, requires nothing, and is asked at its next use.
 *
 * No React or Expo imports: tested in Node. The screens hand questions to the one sheet through
 * `askTypeSetup` (the sheet is mounted once, in the root layout).
 */

import { LIBRARY_STREAM, OpError, type EditContext, type Editor, type Op, type Store } from '@field-survey/core';
import { parseLibraryCables, type CarriedRow, type LibraryCable } from '@field-survey/rules';

import { cablesFor, loadDeviceTypes, type DeviceType, type DeviceTypes } from './neuron';
import { describeCable } from './model';

/** One cable row of the type, with the answer it starts from. */
export interface TypeSetupRow {
  /** `d<i>` for the i-th of `default_cables`, `o<i>` for `optional_cables`: what an answer names. */
  key: string;
  cable: LibraryCable;
  /** "X · 2 ends · qty 1", for the row's line. */
  line: string;
  /** The preset: true = Required. */
  required: boolean;
  /** Why the preset is Required: the import's exception (its reason), or the type's own default row. */
  why: string | null;
}

export interface TypeSetupQuestion {
  typeId: string;
  model: string;
  category: string | null;
  /** The device model that carries it, when it is asked as an accessory (null = the device's own type). */
  via: string | null;
  rows: TypeSetupRow[];
}

/** row key → Required (true) or Optional (false); a key left out keeps its preset. */
export type TypeSetupAnswer = Readonly<Record<string, boolean>>;

export const TYPE_SETUP_CTX = (model: string): EditContext => ({ change_type: 'Master edit', reason: `Device-type library: first use of ${model}` });

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The codes the import named as exceptions (`source_ref.exceptions[].code`, D291 / D297 (9)), with their reasons. */
function exceptionsOf(t: Pick<DeviceType, 'source_ref'>): Map<string, string> {
  const out = new Map<string, string>();
  const ref = t.source_ref && typeof t.source_ref === 'object' ? (t.source_ref as Row) : null;
  const list = ref && Array.isArray(ref.exceptions) ? ref.exceptions : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const code = str((e as Row).code);
    if (code && !out.has(code)) out.set(code, str((e as Row).reason) ?? 'suggested by the import');
  }
  return out;
}

/** Whether a type is one the first-use question is about: live, in the app library, a draft. */
function isDraft(t: DeviceType & { deleted_at?: unknown; project_id?: unknown }): boolean {
  return t.state === 'draft' && t.deleted_at == null && t.project_id == null;
}

/** The question for one type, or null when there is nothing to ask (not a draft, or no cable row). */
export function questionOf(t: DeviceType, via: string | null = null): TypeSetupQuestion | null {
  if (!isDraft(t)) return null;
  const exceptions = exceptionsOf(t);
  const rows: TypeSetupRow[] = [];
  parseLibraryCables(t.default_cables).forEach((cable, i) =>
    rows.push({ key: `d${i}`, cable, line: describeCable(cable), required: true, why: 'required on the type' }),
  );
  parseLibraryCables(t.optional_cables).forEach((cable, i) => {
    const why = exceptions.get(cable.code) ?? null;
    rows.push({ key: `o${i}`, cable, line: describeCable(cable), required: why !== null, why });
  });
  if (!rows.length) return null;
  return { typeId: t.id, model: t.model, category: t.category ?? null, via, rows };
}

/** What entered: a device (as stored, or as a draft will make it) and the accessory rows it carries. */
export interface Arrival {
  device: { device?: unknown; library_type_id?: unknown; category?: unknown };
  accessories?: readonly CarriedRow[];
}

/**
 * The questions for what just entered a project, each type once, in arrival order: each device's
 * own type, then the accessories it carries (rows matched to a type, and forced slots with no row —
 * `cablesFor(...).carried`). A type already asked earlier in the list is not repeated.
 */
export function questionsFor(types: DeviceTypes, arrivals: readonly Arrival[]): TypeSetupQuestion[] {
  const out: TypeSetupQuestion[] = [];
  const seen = new Set<string>();
  const push = (t: DeviceType | null, via: string | null) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    const q = questionOf(t, via);
    if (q) out.push(q);
  };
  for (const a of arrivals) {
    const plan = cablesFor(types, a.device, a.accessories ?? []);
    push(plan.type, null);
    for (const c of plan.carried) push(c.type, plan.type?.model ?? str(a.device.device));
  }
  return out;
}

/** A JSON list column, whether the driver gave it parsed or as text. */
function jsonList(v: unknown): Row[] {
  let x = v;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      return [];
    }
  }
  return Array.isArray(x) ? x.filter((r): r is Row => !!r && typeof r === 'object') : [];
}

/** Accessory rows by device id. */
async function accessoryRows(store: Store, deviceIds: readonly string[]): Promise<Map<string, CarriedRow[]>> {
  const out = new Map<string, CarriedRow[]>();
  if (!deviceIds.length) return out;
  const rows = await store.list<{ device_id: string; model: string | null; expected_qty: number | null; found_qty: number | null }>('accessory', {
    where: `device_id IN (${deviceIds.map(() => '?').join(',')})`,
    params: [...deviceIds],
  });
  for (const r of rows) out.set(r.device_id, [...(out.get(r.device_id) ?? []), r]);
  return out;
}

/** The questions for devices just created (Add device, a placed draft): their types and carried accessories'. */
export async function questionsForDevices(store: Store, deviceIds: readonly string[]): Promise<TypeSetupQuestion[]> {
  const types = await loadDeviceTypes(store);
  const accessories = await accessoryRows(store, deviceIds);
  const arrivals: Arrival[] = [];
  for (const id of deviceIds) {
    const d = await store.get<Row>('device', id);
    if (d && !d.deleted_at) arrivals.push({ device: d, accessories: accessories.get(id) ?? [] });
  }
  return questionsFor(types, arrivals);
}

/** A device draft as accepting it brings it in: its model (the one picked, when it needed one) and its accessory lines. */
export interface DraftArrival {
  model: string | null;
  category: string | null;
  accessories: readonly { model: string; qty: number | null }[];
}

/** The questions for device drafts just accepted (one, or Accept all's lot): listed once. */
export async function questionsForDrafts(store: Store, drafts: readonly DraftArrival[]): Promise<TypeSetupQuestion[]> {
  const types = await loadDeviceTypes(store);
  return questionsFor(
    types,
    drafts.map((d) => ({ device: { device: d.model, category: d.category, library_type_id: null }, accessories: d.accessories.map((a) => ({ model: a.model, expected_qty: a.qty })) })),
  );
}

/** The question for an accessory just added to a device on its card (the accessory's type, asked as carried by `hostModel`). */
export async function questionsForAccessory(store: Store, model: string, hostModel: string | null): Promise<TypeSetupQuestion[]> {
  const types = await loadDeviceTypes(store);
  const plan = cablesFor(types, { device: model, library_type_id: null });
  const q = plan.type ? questionOf(plan.type, hostModel) : null;
  return q ? [q] : [];
}

/**
 * Every type a project uses that still waits for its first-use answer — its live devices and
 * their accessories, and its accepted device drafts not placed yet — for Setup's "Types to set up"
 * step, which is where a seed import's devices (they arrive by pull, all at once) are answered.
 */
export async function questionsForProject(store: Store, projectId: string): Promise<TypeSetupQuestion[]> {
  const types = await loadDeviceTypes(store);
  const devices = await store.db.query<Row>(
    `SELECT d.id, d.device, d.category, d.library_type_id FROM device d JOIN level l ON l.id = d.level_id
     WHERE l.project_id = ? AND d.deleted_at IS NULL AND l.deleted_at IS NULL ORDER BY d.id`,
    [projectId],
  );
  const accessories = await accessoryRows(store, devices.map((d) => String(d.id)));
  const drafts = await store.list<Row>('draft_device', { where: `project_id = ? AND state IN ('accepted', 'edited')`, params: [projectId], orderBy: 'id' });
  const arrivals: Arrival[] = [
    ...devices.map((d) => ({ device: d, accessories: accessories.get(String(d.id)) ?? [] })),
    ...drafts.map((d) => ({
      device: { device: d.model, category: d.category, library_type_id: null },
      accessories: jsonList(d.accessories).map((a) => ({ model: str(a.model), expected_qty: typeof a.qty === 'number' ? a.qty : null })),
    })),
  ];
  return questionsFor(types, arrivals).sort((a, b) => a.model.localeCompare(b.model, 'en', { numeric: true }));
}

/** The lists Confirm writes: the stored rows as they are (unread keys kept), split by the answer. */
export function splitRows(type: Pick<DeviceType, 'default_cables' | 'optional_cables'>, q: TypeSetupQuestion, answer: TypeSetupAnswer): { required: unknown[]; optional: unknown[] } {
  const raw = (v: unknown, prefix: string) => {
    // the same rows `parseLibraryCables` keeps, in its order, each with the key the question gave it
    const kept: [string, unknown][] = [];
    if (!Array.isArray(v)) return kept;
    let i = 0;
    for (const r of v) {
      if (!r || typeof r !== 'object' || !str((r as Row).code)) continue;
      kept.push([`${prefix}${i++}`, r]);
    }
    return kept;
  };
  const required: unknown[] = [];
  const optional: unknown[] = [];
  for (const [key, row] of [...raw(type.default_cables, 'd'), ...raw(type.optional_cables, 'o')]) {
    const preset = q.rows.find((r) => r.key === key)?.required ?? false;
    ((answer[key] ?? preset) ? required : optional).push(row);
  }
  return { required, optional };
}

/**
 * Confirm: the type's lists by the answer and `state: accepted`, one group on the library stream
 * (whatever stream `editor` is on: this is the one sanctioned type edit outside the Library,
 * D292 (1)). Returns null, writing nothing, when the type is no longer a draft on this iPad (it
 * was answered meanwhile — on another iPad, or in the Library).
 */
export async function answerTypeSetup(editor: Editor, store: Store, q: TypeSetupQuestion, answer: TypeSetupAnswer): Promise<Op[] | null> {
  const t = await store.get<DeviceType & { deleted_at?: unknown; project_id?: unknown }>('library_type', q.typeId);
  if (!t) throw new OpError(`${q.model} is not in the library on this iPad.`);
  if (!isDraft(t)) return null;
  const { required, optional } = splitRows(t, q, answer);
  return editor.forStream(LIBRARY_STREAM).group(TYPE_SETUP_CTX(q.model), async (g) => {
    await g.setFields('library_type', q.typeId, { default_cables: required.length ? required : null, optional_cables: optional.length ? optional : null, state: 'accepted' });
  });
}

/** "2 required · 3 optional" for a question with an answer. */
export function answerLine(q: TypeSetupQuestion, answer: TypeSetupAnswer): string {
  const req = q.rows.filter((r) => answer[r.key] ?? r.required).length;
  return `${req} required · ${q.rows.length - req} optional`;
}

// ------------------------------------------------------------------ the one sheet

type Listener = (questions: TypeSetupQuestion[]) => void;
let listener: Listener | null = null;

/** The sheet (mounted once) listens here; returns the unsubscribe. */
export function onTypeSetup(l: Listener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** Hand questions to the sheet; nothing happens for an empty list. Returns how many were handed over. */
export function askTypeSetup(questions: readonly TypeSetupQuestion[]): number {
  if (!questions.length || !listener) return 0;
  listener([...questions]);
  return questions.length;
}

/** Merge newly asked questions into the open ones, each type once (the open answer kept). */
export function mergeQuestions(open: readonly TypeSetupQuestion[], more: readonly TypeSetupQuestion[]): TypeSetupQuestion[] {
  const ids = new Set(open.map((q) => q.typeId));
  return [...open, ...more.filter((q) => !ids.has(q.typeId))];
}
