/**
 * Draft review edits (T44, Phase 3 §3.3, D193): Accept / Edit / Reject / Reopen a device or cable
 * draft, Accept all ≥ 0.9 (each draft still gets its own reviewed op), Promote an excluded BOM
 * line (D12), hand-entered drafts (the K12 fallback), a cable draft's endpoints and code, and
 * Confirm endpoint (D6). Every edit is an op through the `Editor` (`Master edit`, setup work
 * before the baseline lock). No React or Expo imports: tested in Node.
 *
 * What Accept writes (D193): a device draft only changes state — its devices are made when they
 * are placed (T46, `baseline_ref`); a cable draft becomes its `cable` with both ends once both
 * endpoints are real records (a device or a placeholder), or links to the matching cable already
 * in the baseline; until an endpoint draft device is placed it waits, accepted, and
 * `commitWaitingCables` makes it then.
 */

import type { EditBatch, EditContext, Editor, Op, Store } from '@field-survey/core';
import { CABLE_CODES, DEVICE_CATEGORIES, hashUuid } from '@field-survey/rules';
import { canonicalCategory, roleOfCategory, type Role } from '@field-survey/core';

import {
  BULK_MIN,
  RISER_KINDS,
  bulkCables,
  bulkDevices,
  candidateList,
  deviceForDraft,
  loadDraftReview,
  withChosen,
  type CableDraftRow,
  type DeviceDraftRow,
  type DraftReviewData,
  type Endpoint,
  type LevelKey,
  type Side,
} from './model';

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

const ctx = (reason: string): EditContext => ({ change_type: 'Master edit', reason });

// the D196 eleven; an extraction job's category (the master's spelling, D1) is read as its canonical value
const CATEGORIES: readonly string[] = DEVICE_CATEGORIES;
const known = (c: string | null | undefined): string | null => canonicalCategory(c);
// a category picked by hand names the draft's role when it names one (T115); else the type decides at placement
const roleFor = (category: string | null): Role | null => {
  const r = roleOfCategory(category);
  return r === 'other' ? null : r;
};

function wholePositive(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new DraftError(`${what} must be a whole number, 1 or more.`);
  return n;
}

function label(d: Pick<DeviceDraftRow, 'model' | 'name' | 'qty'>): string {
  return `${d.name ?? d.model ?? 'draft'}${d.qty && d.qty > 1 ? ` ×${d.qty}` : ''}`;
}

/** Settle the draft's open source-conflict item (D30) in the same group as the decision. */
async function settleReview(g: EditBatch, editor: Editor, itemId: string | null, resolution: Record<string, unknown>, now: string): Promise<void> {
  if (!itemId) return;
  await g.setField('review_item', itemId, 'resolution', resolution);
  await g.setField('review_item', itemId, 'resolved_by_id', editor.userId);
  await g.setField('review_item', itemId, 'resolved_at', now);
  await g.setField('review_item', itemId, 'state', 'resolved');
}

const iso = () => new Date().toISOString();

// ------------------------------------------------------------------ device drafts

export type DeviceChoice = { model?: string | null; qty?: number | null; levelId?: string | null; category?: string | null };

/** What Accept still waits for, in words (empty = Accept can go). */
export function deviceBlockers(d: DeviceDraftRow, choice: DeviceChoice = {}): string[] {
  const out: string[] = [];
  if (d.state !== 'proposed') out.push(`This draft is ${d.state}.`);
  if (d.needs.model && !(choice.model && d.needs.model.options.includes(choice.model))) out.push(`Pick the model: ${d.needs.model.options.join(' or ')}.`);
  if (d.needs.qty && !(typeof choice.qty === 'number' && choice.qty >= 1)) out.push('Pick the quantity: BOM or riser.');
  if (d.needs.level && !(choice.levelId && d.needs.level.options.some((o) => o.id === choice.levelId))) out.push(`Pick the level: ${d.needs.level.options.map((o) => o.code).join(' or ')}.`);
  if (d.needs.category && !(known(choice.category) && CATEGORIES.includes(known(choice.category)!))) out.push('Pick a category.');
  if (!(choice.model ?? d.model)) out.push('The draft has no model: Edit… first.');
  return out;
}

/**
 * Accept a device draft with the choices it needed (D28): the chosen fields are set and the state
 * becomes `edited` when anything changed, else `accepted`; an open source conflict on it is
 * resolved with the accepted quantity. One group.
 */
export async function acceptDevice(editor: Editor, d: DeviceDraftRow, choice: DeviceChoice = {}, opts: { now?: () => string } = {}): Promise<Op[]> {
  const blockers = deviceBlockers(d, choice);
  if (blockers.length) throw new DraftError(blockers.join(' '));
  const changes: Record<string, unknown> = {};
  if (d.needs.model && choice.model !== d.model) changes.model = choice.model;
  if (d.needs.qty && choice.qty !== d.qty) changes.qty = wholePositive(choice.qty, 'Quantity');
  if (d.needs.level && choice.levelId !== d.levelId) changes.level_id = choice.levelId;
  if (d.needs.category) {
    changes.category = known(choice.category);
    changes.role = roleFor(changes.category as string);
  }
  const qty = (changes.qty as number | undefined) ?? d.qty;
  const model = (changes.model as string | undefined) ?? d.model;
  return editor.group(ctx(`Draft review: accepted ${label({ ...d, model, qty })}`), async (g) => {
    await g.setFields('draft_device', d.id, changes);
    await g.setField('draft_device', d.id, 'state', Object.keys(changes).length ? 'edited' : 'accepted');
    await settleReview(g, editor, d.reviewItemId, { choice: 'drafts', value: qty, reason: 'Accepted in draft review' }, (opts.now ?? iso)());
  });
}

export type DeviceFields = { model?: string; category?: string | null; qty?: number | null; name?: string | null; levelId?: string | null };

/** Edit… → Save & accept: the fields as typed, state `edited` (Phase 3 §3.3). */
export async function editDevice(editor: Editor, d: DeviceDraftRow, f: DeviceFields, opts: { now?: () => string } = {}): Promise<Op[]> {
  if (d.state === 'rejected') throw new DraftError('Reopen the draft first.');
  if (d.placed > 0) throw new DraftError('Devices were already placed from this draft; edit them on the plan.');
  const model = f.model !== undefined ? f.model.trim() : d.model;
  if (!model) throw new DraftError('Model is required.');
  const category = known(f.category !== undefined ? f.category : d.category);
  if (!category || !CATEGORIES.includes(category)) throw new DraftError(`Category must be one of: ${CATEGORIES.join(' · ')}.`);
  const qty = f.qty !== undefined && f.qty !== null ? wholePositive(f.qty, 'Quantity') : d.qty;
  const changes: Record<string, unknown> = { model, category, qty, name: f.name !== undefined ? f.name?.trim() || null : d.name };
  if (category !== known(d.category)) changes.role = roleFor(category);
  if (f.levelId !== undefined) changes.level_id = f.levelId;
  return editor.group(ctx(`Draft review: edited ${label({ model, name: changes.name as string | null, qty })}`), async (g) => {
    await g.setFields('draft_device', d.id, changes);
    await g.setField('draft_device', d.id, 'state', 'edited');
    await settleReview(g, editor, d.reviewItemId, { choice: 'drafts', value: qty, reason: 'Edited in draft review' }, (opts.now ?? iso)());
  });
}

/** Reject with a reason (required); a source conflict on the draft resolves to the baseline's count. */
export async function rejectDraft(editor: Editor, kind: 'device' | 'cable', d: DeviceDraftRow | CableDraftRow, reason: string, opts: { now?: () => string } = {}): Promise<Op[]> {
  if (!reason.trim()) throw new DraftError('Say why it is rejected.');
  if (d.state === 'rejected') throw new DraftError('Already rejected.');
  if (kind === 'device' && (d as DeviceDraftRow).placed > 0) throw new DraftError('Devices were already placed from this draft; delete them on the plan instead.');
  if (kind === 'cable' && (d as CableDraftRow).committed) throw new DraftError('Its cable exists; delete the cable in the cable view instead.');
  const entity = kind === 'device' ? 'draft_device' : 'draft_cable';
  return editor.group(ctx(`Draft review: rejected — ${reason.trim()}`), async (g) => {
    await g.setField(entity, d.id, 'state', 'rejected');
    if (kind === 'device') await settleReview(g, editor, (d as DeviceDraftRow).reviewItemId, { choice: 'baseline', reason: reason.trim() }, (opts.now ?? iso)());
  });
}

/** Back to `proposed`, while nothing was made from it (no device placed, no cable made). */
export async function reopenDraft(editor: Editor, kind: 'device' | 'cable', d: DeviceDraftRow | CableDraftRow): Promise<Op | null> {
  if (d.state === 'proposed') return null;
  if (kind === 'device' && (d as DeviceDraftRow).placed > 0) throw new DraftError('Devices were already placed from this draft.');
  if (kind === 'cable' && (d as CableDraftRow).committed) throw new DraftError('Its cable exists; change it in the cable view.');
  return editor.setField(kind === 'device' ? 'draft_device' : 'draft_cable', d.id, 'state', 'proposed', ctx('Draft review: reopened'));
}

// ------------------------------------------------------------------ hand-entered and promoted drafts

export type NewDeviceDraft = { levelId: string | null; model: string; category: string; qty: number; name?: string | null };

/** A draft typed in by hand — the K12 fallback when a floor comes before the BOM and riser are extracted. */
export async function addDeviceDraft(editor: Editor, projectId: string, f: NewDeviceDraft): Promise<string> {
  const model = f.model.trim();
  if (!model) throw new DraftError('Model is required.');
  const category = known(f.category);
  if (!category || !CATEGORIES.includes(category)) throw new DraftError(`Category must be one of: ${CATEGORIES.join(' · ')}.`);
  const { id } = await editor.create(
    'draft_device',
    {
      project_id: projectId,
      level_id: f.levelId,
      model,
      model_raw: model,
      name: f.name?.trim() || null,
      category,
      role: roleFor(category),
      qty: wholePositive(f.qty, 'Quantity'),
      level_basis: f.levelId ? 'manual' : 'project_pool',
      extraction: 'manual',
      state: 'proposed',
    },
    ctx(`Draft review: device draft added by hand (${model})`),
  );
  return id;
}

export type NewCableDraft = { levelId: string | null; code: string; fromLabel: string; toLabel: string; toLevelId?: string | null; qty?: number };

/** A code of `codes` (the project's, `cableCodes` — T121), else why not. */
function checkCode(code: string, codes: readonly string[]): void {
  if (!codes.includes(code)) throw new DraftError(`Cable code must be one of: ${codes.join(' · ')}.`);
}

/** `codes`: the project's cable codes (`DraftReviewData.codes`); the master's ten by default. */
export async function addCableDraft(editor: Editor, projectId: string, f: NewCableDraft, codes: readonly string[] = CABLE_CODES): Promise<string> {
  checkCode(f.code, codes);
  if (!f.fromLabel.trim() || !f.toLabel.trim()) throw new DraftError('Say where it runs from and to.');
  const { id } = await editor.create(
    'draft_cable',
    {
      project_id: projectId,
      level_id: f.levelId,
      to_level_id: f.toLevelId ?? null,
      code: f.code,
      qty: wholePositive(f.qty ?? 1, 'Quantity'),
      from_label: f.fromLabel.trim(),
      to_label: f.toLabel.trim(),
      origin: 'manual',
      level_basis: 'manual',
      extraction: 'manual',
      state: 'proposed',
    },
    ctx(`Draft review: cable draft added by hand (${f.code} ${f.fromLabel.trim()} → ${f.toLabel.trim()})`),
  );
  return id;
}

/** An excluded BOM line as the batch stats keep it (D188). */
export type ExcludedLine = {
  reason: string;
  model: string | null;
  part_number: string | null;
  description: string | null;
  qty: number | null;
  source_ref: Record<string, unknown>;
  extraction: string | null;
};

/** The key that ties a promoted draft to its excluded line: batch, page, line. */
export const excludedKey = (batchId: string, ref: Record<string, unknown>): string => `${batchId}|${String(ref.page ?? '')}|${String(ref.line ?? '')}`;

/** Promote an excluded BOM line (D12): a draft by hand that carries the line's `source_ref`. Category is the reviewer's to pick. */
export async function promoteExcluded(editor: Editor, projectId: string, batch: { id: string; file: string | null }, line: ExcludedLine, levelId: string | null): Promise<string> {
  const model = (line.model ?? line.part_number ?? '').trim();
  if (!model) throw new DraftError('This line has no model or part number to promote.');
  const { id } = await editor.create(
    'draft_device',
    {
      project_id: projectId,
      import_batch_id: batch.id,
      level_id: levelId,
      model,
      model_raw: line.part_number ?? model,
      category: null,
      qty: line.qty && line.qty > 0 ? Math.round(line.qty) : 1,
      source_ref: { ...line.source_ref, file: batch.file, promoted: true, excluded_reason: line.reason, description: line.description },
      level_basis: levelId ? 'manual' : 'project_pool',
      extraction: 'manual',
      state: 'proposed',
    },
    ctx(`Draft review: promoted excluded BOM line (${model}${line.reason ? ` — was "${line.reason}"` : ''})`),
  );
  return id;
}

// ------------------------------------------------------------------ cable drafts

/** Set (or clear) a side's endpoint; stored as the chosen entry in the draft's candidates. */
export async function setEndpoint(editor: Editor, store: Store, draftId: string, side: Side, pick: Endpoint | null): Promise<Op | null> {
  const raw = await store.get<Record<string, unknown>>('draft_cable', draftId);
  if (!raw) throw new DraftError('That draft is not on this iPad.');
  if (raw.state !== 'proposed') throw new DraftError('Reopen the draft to change its endpoints.');
  return editor.setField('draft_cable', draftId, 'candidates', withChosen(raw.candidates, side, pick), ctx(`Draft review: ${side} end ${pick ? `→ ${pick.label}` : 'cleared'}`));
}

/** A code's placeholder far end (CLAUDE.md §3, R2c / R2d): the To that follows a changed code (T128). */
export const CODE_TO: Readonly<Record<string, string>> = { '0-10V': 'Fixtures', '120V': '120v Power', P: 'EBDK panic wire' };
const CODE_TO_LABELS = new Set(Object.values(CODE_TO).map((l) => l.toLowerCase()));

/**
 * Set an open cable draft's code (T108 / T128): on any open draft, the project's codes. A change
 * from the code the draft had (or, with none, from the riser's guess) moves a To that is one of
 * the codes' placeholders (`CODE_TO`) to the new code's — unless the To was picked by hand or the
 * project has no such placeholder. The first change keeps the draft's own code (`code_set`), so
 * Accept writes `edited`. One group.
 */
export async function setCableCode(editor: Editor, store: Store, data: DraftReviewData, draftId: string, code: string): Promise<Op[]> {
  checkCode(code, data.codes);
  const raw = await store.get<Record<string, unknown>>('draft_cable', draftId);
  const c = data.cables.find((x) => x.id === draftId);
  if (!raw || !c) throw new DraftError('That draft is not on this iPad.');
  if (raw.state !== 'proposed') throw new DraftError('Reopen the draft to change its code.');
  const was = (raw.code as string | null) ?? null;
  if (was === code) return [];
  let candidates = candidateList(raw.candidates);
  let changed = false;
  if (!candidates.some((v) => v.side === 'code_set')) {
    candidates = [...candidates, { side: 'code_set', was }];
    changed = true;
  }
  const to = c.ends.to;
  const prev = was ?? c.codeGuess?.value ?? null;
  const target = CODE_TO[code];
  if (prev !== code && target && to?.kind === 'placeholder' && !c.handPicked.to && CODE_TO_LABELS.has(to.label.toLowerCase())) {
    const p = data.placeholders.find((x) => x.label.toLowerCase() === target.toLowerCase());
    if (p && p.id !== to.id) {
      const pick: Endpoint = { kind: 'placeholder', id: p.id, label: p.label, levelId: p.levelId };
      candidates = withChosen(candidates, 'to', pick).map((v) => (v.side === 'to' && v.id === p.id && v.chosen === true ? { ...v, follows_code: true } : v));
      changed = true;
    }
  }
  return editor.group(ctx(`Draft review: cable code ${was ?? '?'} → ${code}`), async (g) => {
    await g.setField('draft_cable', draftId, 'code', code);
    if (changed) await g.setField('draft_cable', draftId, 'candidates', candidates);
  });
}

/** The master's words for a run's far end, by code (CLAUDE.md §3 and the master's Connections). */
const SIGNAL_TO: Readonly<Record<string, string>> = {
  X: 'DMX',
  N: 'Network',
  NG: 'Network & ground',
  U: 'Unison',
  F: 'Fiber',
  UV: 'UHCI-WM partition sensor',
  '0-10V': '0-10V',
  '120V': '120V',
};
const SINGLE_ROW = new Set(['P', '0-10V', '120V']);

/** An endpoint as a record: a device or a placeholder, with the From text it reads as. */
export type RealEnd = { kind: 'device' | 'placeholder'; id: string; levelId: string | null; levelCode: string | null; text: string; category?: string | null; role?: Role; placeholderKind?: string };

/** A device reads as its panel tag, a rack (by role, T112) as "Equipment rack", else its Device text (the master's From column). */
function deviceText(d: DraftReviewData['devicesLive'][number]): string {
  if (d.panelName) return d.panelName;
  if (d.role === 'equipment_rack') return 'Equipment rack';
  return d.device ?? d.category ?? d.displayId ?? 'device';
}

/** The record an endpoint is now: itself, or the device a draft device has become; null while that draft is unplaced. */
export function realEnd(data: DraftReviewData, e: Endpoint | null): RealEnd | null {
  if (!e) return null;
  const code = (id: string | null) => (id ? (data.levels.find((l) => l.levelId === id)?.code ?? null) : null);
  if (e.kind === 'placeholder') {
    const p = data.placeholders.find((x) => x.id === e.id);
    return p ? { kind: 'placeholder', id: p.id, levelId: p.levelId, levelCode: code(p.levelId), text: p.label, placeholderKind: p.kind } : null;
  }
  let dev = e.kind === 'device' ? (data.devicesLive.find((x) => x.id === e.id) ?? null) : null;
  if (e.kind === 'draft_device') {
    const dd = data.devices.find((x) => x.id === e.id);
    dev = dd ? deviceForDraft(data, dd) : null;
  }
  return dev ? { kind: 'device', id: dev.id, levelId: dev.levelId, levelCode: code(dev.levelId), text: deviceText(dev), category: dev.category, role: dev.role } : null;
}

/**
 * The library's one row per device for a riser line accepted as `0-10V` or `120V` (D194, R2c /
 * R2d, D52): a Relay panel's 0-10V run to its far end (`Fixtures`), an NSPS's or rack's 120V row
 * `120v Power` → `P-NSPS-D Power Supply` / `Equipment rack`; and a relay or Foundry panel's load
 * circuits, `120V` → `Fixtures` (D221) — `exact`: matched by its two ends only, since the panel's
 * 120V feed is another cable. Null when the code, the device's role (T112: its type's, else its
 * category's) or the ends (one device, one placeholder) do not fit the table.
 */
export function libraryRow(code: string, a: RealEnd, b: RealEnd): { device: RealEnd; far: RealEnd; from: string; to: string; exact: boolean } | null {
  const [device, far] = a.kind === 'device' && b.kind === 'placeholder' ? [a, b] : b.kind === 'device' && a.kind === 'placeholder' ? [b, a] : [null, null];
  if (!device || !far) return null;
  const role = device.role ?? roleOfCategory(device.category);
  if (code === '0-10V' && role === 'relay_panel') return { device, far, from: device.text, to: far.text, exact: false };
  if (code === '120V' && role === 'nsps') return { device, far, from: '120v Power', to: 'P-NSPS-D Power Supply', exact: false };
  if (code === '120V' && role === 'equipment_rack') return { device, far, from: '120v Power', to: 'Equipment rack', exact: false };
  if (code === '120V' && (role === 'relay_panel' || role === 'foundry_panel') && far.placeholderKind === 'fixtures') return { device, far, from: device.text, to: far.text, exact: true };
  return null;
}

/** A live cable of this code with an end on this device (the library's row R2c / R2d look for). */
async function deviceCableOfCode(store: Store, projectId: string, code: string, deviceId: string): Promise<Record<string, unknown> | null> {
  const rows = await store.db.query<Record<string, unknown>>(
    `SELECT c.* FROM cable c JOIN cable_end e ON e.cable_id = c.id
     WHERE c.project_id = ? AND c.cable = ? AND e.device_id = ? AND c.deleted_at IS NULL AND e.deleted_at IS NULL ORDER BY c.id LIMIT 1`,
    [projectId, code, deviceId],
  );
  return rows[0] ?? null;
}

/**
 * The cable and its ends for an accepted draft (D32: From / To written once from the master's
 * templates, then stored): side A on the draft's From end — From its text, To "<signal> to [Level
 * nn ]<far end>"; side B likewise back, or the placeholder's own label as From with no To (as the
 * library's runs, T48). A panic run reads "EBDK panic wire"; P, 0-10V and 120V are single-row.
 * A riser draft's `source_ref` becomes `riser_ref` in its blob form (D191) and its A end names
 * the vertical.
 */
export function cablePayload(
  c: Pick<CableDraftRow, 'id' | 'code' | 'qty' | 'origin' | 'levelId' | 'toLevelId' | 'sourceRef'>,
  a: RealEnd,
  b: RealEnd,
  opts: { confirm: boolean; riserBlob?: string | null },
): { cable: Record<string, unknown>; ends: Record<string, unknown>[] } {
  const code = c.code!;
  const far = (from: RealEnd, to: RealEnd) => {
    if (code === 'P') return 'EBDK panic wire';
    const where = to.kind === 'device' && to.levelId && to.levelId !== from.levelId && to.levelCode ? `Level ${to.levelCode} ` : '';
    return `${SIGNAL_TO[code] ?? code} to ${where}${to.text}`;
  };
  const end = (side: 'A' | 'B', me: RealEnd, other: RealEnd, fallbackLevel: string | null): Record<string, unknown> =>
    me.kind === 'device'
      ? { side, endpoint_kind: 'device', device_id: me.id, level_id: me.levelId ?? fallbackLevel, from_text: me.text, to_text: far(me, other) }
      : { side, endpoint_kind: 'placeholder', placeholder_id: me.id, level_id: me.levelId ?? fallbackLevel, from_text: me.text, to_text: null };
  const ref = c.sourceRef;
  const riser = ref && RISER_KINDS.has(String(ref.kind)) && Array.isArray(ref.bbox);
  return {
    cable: {
      cable: code,
      qty: c.qty ?? 1,
      origin: c.origin === 'riser' ? 'riser' : 'manual',
      single_row: SINGLE_ROW.has(code),
      riser_ref: riser ? { blob: opts.riserBlob ?? null, file: ref!.file ?? null, page: ref!.page, bbox: ref!.bbox, draft: c.id } : null,
      vertical: riser ? `${a.text} ${code}` : null,
      endpoint_confirmed: opts.confirm,
    },
    ends: [end('A', a, b, c.levelId), end('B', b, a, c.toLevelId ?? c.levelId)],
  };
}

/** `cablePayload` with the library's texts (R2c / R2d's): the device end A, the placeholder B reading its own label. */
export function libraryPayload(
  c: Parameters<typeof cablePayload>[0],
  lib: NonNullable<ReturnType<typeof libraryRow>>,
  opts: { confirm: boolean; riserBlob?: string | null },
): ReturnType<typeof cablePayload> {
  const p = cablePayload(c, lib.device, lib.far, opts);
  p.ends[0] = { ...p.ends[0], from_text: lib.from, to_text: lib.to };
  p.ends[1] = { ...p.ends[1], from_text: lib.far.text, to_text: null };
  return p;
}

/** A live cable of this code whose two ends are exactly these records (either way round): the baseline already has it (D30). */
export async function matchingCable(store: Store, projectId: string, code: string, a: RealEnd, b: RealEnd): Promise<Record<string, unknown> | null> {
  const rows = await store.db.query<Record<string, unknown>>(
    `SELECT c.*, e.side AS e_side, e.device_id AS e_device, e.placeholder_id AS e_placeholder FROM cable c JOIN cable_end e ON e.cable_id = c.id
     WHERE c.project_id = ? AND c.cable = ? AND c.deleted_at IS NULL AND e.deleted_at IS NULL ORDER BY c.id`,
    [projectId, code],
  );
  const want = [a.id, b.id].sort().join('|');
  const byCable = new Map<string, { row: Record<string, unknown>; ids: string[] }>();
  for (const r of rows) {
    const id = String(r.id);
    const entry = byCable.get(id) ?? { row: r, ids: [] };
    const end = (r.e_device ?? r.e_placeholder) as string | null;
    if (end) entry.ids.push(end);
    byCable.set(id, entry);
  }
  for (const { row, ids } of byCable.values()) if (ids.length === 2 && [...ids].sort().join('|') === want) return row;
  return null;
}

export type CableAcceptResult = { ops: Op[]; cableId: string | null; linked: boolean; waiting: boolean };

async function writeCable(
  g: EditBatch,
  store: Store,
  projectId: string,
  c: CableDraftRow,
  a: RealEnd,
  b: RealEnd,
  opts: { confirm: boolean; riserBlob?: string | null },
): Promise<{ cableId: string; linked: boolean }> {
  // a 0-10V / 120V line meets the library's row for its device: one cable, not two (D194); a
  // panel's load circuits only the cable with the same two ends (D221)
  const lib = libraryRow(c.code!, a, b);
  const existing = lib && !lib.exact ? await deviceCableOfCode(store, projectId, c.code!, lib.device.id) : await matchingCable(store, projectId, c.code!, a, b);
  const p = lib ? libraryPayload(c, lib, opts) : cablePayload(c, a, b, opts);
  if (existing) {
    const id = String(existing.id);
    if (existing.riser_ref == null && p.cable.riser_ref) await g.setField('cable', id, 'riser_ref', p.cable.riser_ref);
    if (existing.vertical == null && p.cable.vertical) await g.setField('cable', id, 'vertical', p.cable.vertical);
    if (opts.confirm) await g.setField('cable', id, 'endpoint_confirmed', true);
    await g.setField('draft_cable', c.id, 'placed', true);
    return { cableId: id, linked: true };
  }
  // ids derived from the draft (as the rules' proposals, D169): two iPads accepting one draft offline make one cable
  const cableId = hashUuid('draft_cable', [c.id, 'cable']);
  const endIds = p.ends.map((e) => hashUuid('draft_cable', [c.id, String(e.side)]));
  await g.create('cable', { ...p.cable, id: cableId, project_id: projectId, end_a_id: endIds[0], end_b_id: endIds[1] });
  for (const [i, e] of p.ends.entries()) await g.create('cable_end', { ...e, id: endIds[i], cable_id: cableId });
  await g.setField('draft_cable', c.id, 'placed', true);
  return { cableId, linked: false };
}

/** What Accept on a cable draft still waits for (empty = it can go). */
export function cableBlockers(c: CableDraftRow): string[] {
  const out: string[] = [];
  if (c.state !== 'proposed') out.push(`This draft is ${c.state}.`);
  if (!c.code) out.push('Pick the cable code.');
  if (!c.ends.from) out.push('Pick the From end.');
  if (!c.ends.to) out.push('Pick the To end.');
  return out;
}

/**
 * Accept a cable draft — **Confirm endpoint** (D6) is Accept with `confirm`: the cable is made
 * with `endpoint_confirmed`, else it shows ⚑ in the cable view until someone confirms it there.
 * Both ends real → the cable (or the link to the one the baseline has); an end still an unplaced
 * draft device → accepted and waiting (`commitWaitingCables`). One group.
 */
export async function acceptCable(
  editor: Editor,
  store: Store,
  data: DraftReviewData,
  c: CableDraftRow,
  opts: { confirm: boolean; riserBlob?: string | null; reason?: string },
): Promise<CableAcceptResult> {
  const blockers = cableBlockers(c);
  if (blockers.length) throw new DraftError(blockers.join(' '));
  const raw = await store.get<Record<string, unknown>>('draft_cable', c.id);
  if (!raw) throw new DraftError('That draft is not on this iPad.');
  const projectId = String(raw.project_id);
  const a = realEnd(data, c.ends.from);
  const b = realEnd(data, c.ends.to);
  let result: { cableId: string; linked: boolean } | null = null;
  const edited = c.handPicked.from || c.handPicked.to || c.codeEdited || c.conflicts.includes('code:unknown');
  const what = `${c.code} ${c.ends.from!.label} → ${c.ends.to!.label}`;
  const reason = opts.reason ?? `Draft review: ${opts.confirm ? 'endpoint confirmed' : 'accepted'} ${what}`;
  const ops = await editor.group(ctx(reason), async (g) => {
    const fixed = withChosen(withChosen(raw.candidates, 'from', c.ends.from, opts.confirm), 'to', c.ends.to, opts.confirm);
    await g.setField('draft_cable', c.id, 'candidates', fixed);
    // the reviewer said what the line is: its question is answered (T108)
    if (c.conflicts.includes('code:unknown')) await g.setField('draft_cable', c.id, 'conflicts', c.conflicts.filter((k) => k !== 'code:unknown'));
    await g.setField('draft_cable', c.id, 'state', edited ? 'edited' : 'accepted');
    if (a && b) result = await writeCable(g, store, projectId, c, a, b, opts);
  });
  const r = result as { cableId: string; linked: boolean } | null;
  return { ops, cableId: r?.cableId ?? null, linked: r?.linked ?? false, waiting: !r };
}

/**
 * Accept all ≥ 0.9 on one level (Phase 3 §3.3; prompt Must): every open draft over the bar with
 * no conflict and nothing to choose, each with its own `state` op in one group, so each is still
 * recorded as reviewed by this person. Cables accepted in bulk stay unconfirmed (D6).
 */
export async function acceptAll(
  editor: Editor,
  store: Store,
  data: DraftReviewData,
  key: LevelKey,
  what: 'devices' | 'cables',
  opts: { min?: number; riserBlob?: string | null } = {},
): Promise<number> {
  const min = opts.min ?? BULK_MIN;
  const reason = `Draft review: Accept all ≥ ${min}`;
  if (what === 'devices') {
    const rows = bulkDevices(data, key, min);
    if (!rows.length) return 0;
    await editor.group(ctx(reason), async (g) => {
      for (const d of rows) await g.setField('draft_device', d.id, 'state', 'accepted');
    });
    return rows.length;
  }
  const rows = bulkCables(data, key, min);
  if (!rows.length) return 0;
  const raws = new Map<string, Record<string, unknown>>();
  for (const c of rows) {
    const raw = await store.get<Record<string, unknown>>('draft_cable', c.id);
    if (raw) raws.set(c.id, raw);
  }
  await editor.group(ctx(reason), async (g) => {
    for (const c of rows) {
      const raw = raws.get(c.id);
      if (!raw) continue;
      await g.setField('draft_cable', c.id, 'candidates', withChosen(withChosen(raw.candidates, 'from', c.ends.from), 'to', c.ends.to));
      await g.setField('draft_cable', c.id, 'state', 'accepted');
      const a = realEnd(data, c.ends.from);
      const b = realEnd(data, c.ends.to);
      if (a && b) await writeCable(g, store, String(raw.project_id), c, a, b, { confirm: false, riserBlob: opts.riserBlob });
    }
  });
  return rows.length;
}

/**
 * Make the cables of accepted drafts that were waiting for an endpoint device to be placed (T46
 * calls this after it places devices; the review screen offers it as "Make n waiting cables").
 * Returns how many.
 */
export async function commitWaitingCables(editor: Editor, store: Store, projectId: string, opts: { riserBlob?: string | null } = {}): Promise<number> {
  const data = await loadDraftReview(store, projectId);
  const ready = data.cables
    .filter((c) => c.waiting && c.code)
    .map((c) => ({ c, a: realEnd(data, c.ends.from), b: realEnd(data, c.ends.to) }))
    .filter((x): x is { c: CableDraftRow; a: RealEnd; b: RealEnd } => !!x.a && !!x.b);
  if (!ready.length) return 0;
  await editor.group(ctx('Draft review: cables of accepted drafts, endpoints now placed'), async (g) => {
    for (const { c, a, b } of ready) await writeCable(g, store, projectId, c, a, b, { confirm: c.confirmed, riserBlob: opts.riserBlob });
  });
  return ready.length;
}
