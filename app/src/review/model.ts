/**
 * Read model of the Needs review screen (T26, Phase 3 §6): open review items listed by kind and
 * level, and one item's A/B panel. Reads only; resolving goes through `Editor.resolve` (T15,
 * D91). No React or Expo imports, so it is tested in Node over `BetterSqliteDriver`.
 *
 * D90: one item per conflicting op, listed separately (never grouped by subject). D98: a sync
 * conflict has no Dismiss; the other kinds (extraction, source conflict, import pair, lint, MSS)
 * are listed here and resolved by their own screens when those tasks land.
 */

import {
  choicesFor,
  combineText,
  defaultDeviceText,
  displayNumber,
  isPunchDeviceItem,
  sideOf,
  type Candidate,
  type ChoiceName,
  type ReviewItem,
  type StoredOp,
  type Store,
} from '@field-survey/core';

import { installName, loadInstallLabels } from '../sync/install';

type Row = Record<string, unknown>;

/** Review kinds (PLAN §2.2) in tab order, with the tab label. */
export const REVIEW_KINDS = [
  ['sync_conflict', 'Sync conflict'],
  ['extraction', 'Extraction'],
  ['source_conflict', 'Source conflict'],
  ['import_pair', 'Import pair'],
  ['lint', 'Lint'],
  ['mss', 'MSS'],
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number][0];
/** Tabs shown even when empty (Phase 3 §6); Lint and MSS only when they have items. */
const ALWAYS_SHOWN: readonly string[] = ['sync_conflict', 'extraction', 'source_conflict', 'import_pair'];

export function kindLabel(kind: string): string {
  return REVIEW_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}

const FIELD_LABELS: Record<string, string> = {
  pin: 'Pin position',
  deleted_at: 'Deleted',
  neuron_id: 'Neuron ID',
  display_id: 'ID',
  room_location: 'Room / location',
  from_text: 'From',
  to_text: 'To',
  part_no: 'Part #',
  qty: 'Qty',
  what_it_shows: 'What it shows',
};

/** "tracking_status" → "Tracking status"; links read "Link". */
export function fieldLabel(field: string): string {
  if (field.startsWith('link:')) return 'Link';
  const known = FIELD_LABELS[field];
  if (known) return known;
  const s = field.replace(/_id$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A value as the panel shows it: blanks, pins, delete/restore and links readable. */
export function formatValue(field: string, value: unknown): string {
  if (field === 'deleted_at') return value === true ? 'Deleted' : value === false ? 'Restored' : value ? 'Deleted' : 'Not deleted';
  if (value === null || value === undefined || value === '') return '(blank)';
  if (field === 'pin' && typeof value === 'object') {
    const p = value as Row;
    if (typeof p.x === 'number' && typeof p.y === 'number') return `x ${Math.round(p.x)}, y ${Math.round(p.y)}`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** When a UUID v7 was minted (the server creates the item when the conflict arrives). */
export function uuidTime(id: string): string | null {
  const hex = id.replace(/-/g, '').slice(0, 12);
  const ms = parseInt(hex, 16);
  return /^[0-9a-f]{12}$/i.test(hex) && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** "10/09 14:02" in local time. */
export function shortStamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --------------------------------------------------------------------- list

export type ReviewRow = {
  id: string;
  kind: string;
  levelId: string | null;
  levelCode: string | null;
  /** "06M-02 Echo relay panel", "03 C-13", "Punch #12". */
  subject: string;
  /** "Notes", "Tracking status + Date closed". */
  field: string;
  /** When the item was created (server). */
  at: string | null;
  ruling: boolean;
  /** A pin-position conflict: resolved on the plan (both pins drawn). */
  pin: boolean;
  /** The subject device (or the device of the subject record), for "Open on plan". */
  deviceId: string | null;
};

/** An open lint `finding` (T90), listed on the Lint tab; dismissed and fixed in the Lint view (T36). */
export type FindingRow = {
  id: string;
  /** The rule or lint that raised it: `R1`, `E3`. */
  lintId: string;
  levelId: string | null;
  levelCode: string | null;
  /** "06M-02 Echo relay panel"; "—" when the finding names no record. */
  subject: string;
  message: string;
  /** The subject device (or the device of the subject record), for "Open on plan". */
  deviceId: string | null;
};

export type ReviewList = {
  rows: ReviewRow[];
  /** Open findings, filtered by level; listed on the Lint tab beside the `lint` review items. */
  findings: FindingRow[];
  /** Tabs to show: kind, label, open count. */
  tabs: { kind: string; label: string; count: number }[];
  levels: { id: string; code: string }[];
};

export type ReviewQuery = { kind?: string | null; levelId?: string | null; sort?: 'oldest' | 'newest' };

export async function levelCodes(store: Store, projectId: string): Promise<Map<string, string>> {
  const rows = await store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  return new Map(rows.map((r) => [String(r.id), String(r.level)]));
}

/** The record a review item is about, with what a row needs to name it. */
export async function describeSubject(
  store: Store,
  kind: string,
  id: string,
  codes: ReadonlyMap<string, string>,
): Promise<{ label: string; levelId: string | null; deviceId: string | null; pin: unknown }> {
  const kinds = ['device', 'cable_end', 'punch_item', 'missing_part', 'photo'] as const;
  if (kind === 'library_type') {
    // the app library's conflicts (D184) and a project's own types
    const t = await store.get<Row>('library_type', id);
    return { label: t ? `Device type ${String(t.model)}${t.deleted_at ? ' (deleted)' : ''}` : 'Device type (not on this iPad)', levelId: null, deviceId: null, pin: null };
  }
  if (!(kinds as readonly string[]).includes(kind)) return { label: `${kind.replace(/_/g, ' ')} …${id.slice(-6)}`, levelId: null, deviceId: null, pin: null };
  const row = await store.get<Row>(kind as (typeof kinds)[number], id);
  if (!row) return { label: `${kind.replace(/_/g, ' ')} (not on this iPad)`, levelId: null, deviceId: null, pin: null };
  const levelId = typeof row.level_id === 'string' ? row.level_id : null;
  const code = levelId ? (codes.get(levelId) ?? null) : null;
  const num = displayNumber(kind as (typeof kinds)[number], row, code);
  const deleted = row.deleted_at ? ' (deleted)' : '';
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? ` ${v.trim()}` : '');
  switch (kind) {
    case 'device':
      return { label: `${num}${text(row.type ?? row.device ?? row.category)}${deleted}`, levelId, deviceId: id, pin: row.pin };
    case 'cable_end':
      return { label: `${code ?? ''} ${num}`.trim() + deleted, levelId, deviceId: (row.device_id as string) ?? null, pin: null };
    case 'punch_item':
      return { label: `Punch #${num}${text(row.item)}${deleted}`, levelId, deviceId: (row.device_id as string) ?? null, pin: null };
    case 'missing_part':
      return { label: `Part #${num}${text(row.part)}${deleted}`, levelId, deviceId: (row.device_id as string) ?? null, pin: null };
    default:
      return { label: `Photo #${num}${deleted}`, levelId, deviceId: (row.device_id as string) ?? null, pin: null };
  }
}

function itemFields(item: ReviewItem): string[] {
  const out = new Set<string>(item.subject.fields ?? [item.subject.field]);
  for (const c of item.candidates ?? []) if (c.entity_id === item.subject.entity_id) out.add(c.field);
  // A delete-vs-edit item lists the edit first: "Notes vs Deleted".
  return [...out].sort((a, b) => Number(a === 'deleted_at') - Number(b === 'deleted_at'));
}

/** Open items of the project for the list: filtered by kind and level, oldest first by default. */
export async function loadReviewList(store: Store, projectId: string, q: ReviewQuery = {}): Promise<ReviewList> {
  const codes = await levelCodes(store, projectId);
  const items = await store.list<ReviewItem>('review_item', {
    where: `state = 'open' AND project_id = ?`,
    params: [projectId],
    orderBy: 'id',
  });
  const all: ReviewRow[] = [];
  for (const item of items) {
    const subj = item.subject ?? ({ entity_kind: 'project', entity_id: '', field: '' } as ReviewItem['subject']);
    const d = await describeSubject(store, subj.entity_kind, subj.entity_id, codes);
    const levelId = item.level_id ?? subj.level_id ?? d.levelId;
    const fields = itemFields(item);
    const master = isPunchDeviceItem(item) ? masterText(item) : null;
    all.push({
      id: item.id,
      kind: item.kind,
      levelId,
      levelCode: levelId ? (codes.get(levelId) ?? null) : null,
      subject: d.label,
      field: master !== null
        ? `Device "${master}" → link`
        : fields.map(fieldLabel).join(fields.includes('deleted_at') && fields.length === 2 ? ' vs ' : ' + '),
      at: uuidTime(item.id),
      ruling: !!item.ruling,
      pin: subj.entity_kind === 'device' && fields.length === 1 && fields[0] === 'pin',
      deviceId: d.deviceId,
    });
  }
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const allFindings = await loadFindings(store, projectId, codes);
  // Findings are lint output: they share the Lint tab (and its count) with `review_item(lint)`.
  if (allFindings.length) counts.set('lint', (counts.get('lint') ?? 0) + allFindings.length);
  const tabs = [
    { kind: 'all', label: 'All', count: all.length },
    ...REVIEW_KINDS.filter(([k]) => ALWAYS_SHOWN.includes(k) || counts.has(k)).map(([k, label]) => ({ kind: k, label, count: counts.get(k) ?? 0 })),
    ...[...counts.keys()].filter((k) => !REVIEW_KINDS.some(([r]) => r === k)).map((k) => ({ kind: k, label: k, count: counts.get(k)! })),
  ];
  let rows = all.filter((r) => (!q.kind || q.kind === 'all' || r.kind === q.kind) && (!q.levelId || r.levelId === q.levelId));
  if (q.sort === 'newest') rows = rows.reverse();
  const findings = allFindings.filter((f) => !q.levelId || f.levelId === q.levelId);
  const used = new Set([...all, ...allFindings].map((r) => r.levelId).filter(Boolean));
  const levels = [...codes].filter(([id]) => used.has(id)).map(([id, code]) => ({ id, code }));
  return { rows, findings, tabs, levels };
}

/** Open findings of the project, by lint id then record. `subject` is `{entity | entity_kind, entity_id}`. */
async function loadFindings(store: Store, projectId: string, codes: ReadonlyMap<string, string>): Promise<FindingRow[]> {
  const found = await store.list<Row>('finding', {
    where: `state = 'open' AND project_id = ?`,
    params: [projectId],
    orderBy: 'lint_id, id',
  });
  const out: FindingRow[] = [];
  for (const f of found) {
    const s = (f.subject && typeof f.subject === 'object' ? f.subject : {}) as Row;
    const kind = typeof s.entity_kind === 'string' ? s.entity_kind : typeof s.entity === 'string' ? s.entity : '';
    const entityId = typeof s.entity_id === 'string' ? s.entity_id : '';
    const d = kind && entityId ? await describeSubject(store, kind, entityId, codes) : null;
    const levelId = typeof f.level_id === 'string' ? f.level_id : (d?.levelId ?? null);
    out.push({
      id: String(f.id),
      lintId: String(f.lint_id),
      levelId,
      levelCode: levelId ? (codes.get(levelId) ?? null) : null,
      subject: d?.label ?? '—',
      message: typeof f.message === 'string' && f.message.trim() ? f.message.trim() : String(f.lint_id),
      deviceId: d?.deviceId ?? null,
    });
  }
  return out;
}

/** The master's Device text an unlinked imported punch row carried (the import's candidate). */
function masterText(item: ReviewItem): string {
  const c = (item.candidates ?? [])[0] as { value?: unknown } | undefined;
  return typeof c?.value === 'string' ? c.value : '';
}

// ------------------------------------------------------------------- detail

/** A device the punch item can be linked to: `01-S10 · PI1002 S10 - Walter Tower`. */
export type LinkChoice = { id: string; label: string; text: string | null; category: string | null };

/**
 * An imported punch row linked to no device (D148): the master's text, the item, and the devices
 * of its level to link it to (or a new one from the + Device form).
 */
export type PunchDeviceReview = {
  punchId: string;
  /** `Punch #27 Gain access; survey…`. */
  punch: string;
  /** The master's Device column, e.g. `Walter Tower east wing`. */
  master: string;
  levelId: string;
  levelCode: string;
  /** The level's devices, by ID; field additions without an ID (`01-?`) last. */
  devices: LinkChoice[];
  /** The device the item is linked to now (after Link, while the item is still shown). */
  linkedTo: string | null;
};

async function punchDeviceReview(store: Store, item: ReviewItem, codes: ReadonlyMap<string, string>): Promise<PunchDeviceReview | null> {
  if (!isPunchDeviceItem(item)) return null;
  const punch = await store.get<Row>('punch_item', item.subject.entity_id);
  if (!punch) return null;
  const levelId = String(punch.level_id);
  const levelCode = codes.get(levelId) ?? '?';
  const devs = await store.list<Row>('device', { where: 'level_id = ?', params: [levelId] });
  const devices = devs
    .map((d): LinkChoice => ({
      id: String(d.id),
      label: displayNumber('device', d, levelCode),
      text: defaultDeviceText(d),
      category: typeof d.category === 'string' ? d.category : null,
    }))
    .sort((a, b) => Number(a.label.endsWith('-?')) - Number(b.label.endsWith('-?')) || a.label.localeCompare(b.label, 'en', { numeric: true }));
  const item_ = typeof punch.item === 'string' && punch.item.trim() ? ` ${punch.item.trim()}` : '';
  return {
    punchId: String(punch.id),
    punch: `Punch #${displayNumber('punch_item', punch)}${item_}`,
    master: masterText(item) || (typeof punch.device_text === 'string' ? punch.device_text : ''),
    levelId,
    levelCode,
    devices,
    linkedTo: typeof punch.device_id === 'string' ? punch.device_id : null,
  };
}

export type ReviewSide = {
  /** "Landry", or "user …abc123" when the team list does not know the id. */
  who: string;
  /** client_ts of the op. */
  when: string;
  /** "this iPad", the other iPad's label ("Field 1"), else "iPad …1a2b3c" (D155). */
  install: string;
};

export type ReviewFieldRow = {
  field: string;
  label: string;
  /** Side A (official now): the candidate's value, else the record's current value. */
  a: string;
  /** Side B: the reviewed value; "(unchanged)" when B did not touch this field. */
  b: string;
  /** The value before both edits (B's base), when known on this iPad. */
  was: string | null;
};

export type ReviewDetail = {
  item: ReviewItem;
  row: ReviewRow;
  a: ReviewSide | null;
  b: ReviewSide | null;
  fields: ReviewFieldRow[];
  choices: ChoiceName[];
  /** Pre-filled Combine text "A; B" (PLAN §3.3), when Combine is a choice. */
  combine: string | null;
  /** The A/B pins of a pin conflict, in sheet coordinates. */
  pins: { a: { sheet: string | null; x: number; y: number } | null; b: { sheet: string | null; x: number; y: number } | null } | null;
  /** Only sync conflicts are resolved with A/B here (D98: and never dismissed). */
  resolvable: boolean;
  /** An imported punch row waiting for its device (D148): Link to device / Create device. */
  punchDevice: PunchDeviceReview | null;
};

function side(
  c: Candidate | undefined,
  names: ReadonlyMap<string, string>,
  installId: string,
  labels: ReadonlyMap<string, string>,
): ReviewSide | null {
  if (!c) return null;
  return {
    who: names.get(c.user_id) ?? `user …${c.user_id.slice(-6)}`,
    when: c.client_ts,
    install: c.install_id === installId ? (labels.get(installId) ? `${labels.get(installId)} (this iPad)` : 'this iPad') : installName(c.install_id, labels),
  };
}

function opValue(op: StoredOp | null, field: string): unknown {
  if (!op) return undefined;
  if (field === 'deleted_at') return op.kind === 'delete' ? true : op.kind === 'restore' || op.kind === 'create' ? false : undefined;
  if (op.kind === 'create') return (op.payload ?? {})[field] ?? null;
  if ((op.kind === 'set' || op.kind === 'assign') && op.field === field) return op.now ?? null;
  return undefined;
}

function asPin(v: unknown): { sheet: string | null; x: number; y: number } | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Row;
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { sheet: typeof p.sheet === 'string' ? p.sheet : null, x: p.x, y: p.y };
}

/** One item's A/B panel. `names` is the team list (user id → name); `app_user` is not on the iPad. */
export async function loadReviewDetail(
  store: Store,
  itemId: string,
  names: ReadonlyMap<string, string>,
): Promise<ReviewDetail | null> {
  const item = await store.get<ReviewItem>('review_item', itemId);
  if (!item || item.deleted_at) return null;
  const list = await loadReviewList(store, item.project_id);
  const codes = await levelCodes(store, item.project_id);
  const row =
    list.rows.find((r) => r.id === itemId) ??
    // A resolved item is no longer listed; describe it anyway so the panel can say so.
    {
      id: item.id,
      kind: item.kind,
      levelId: item.level_id,
      levelCode: item.level_id ? (codes.get(item.level_id) ?? null) : null,
      subject: (await describeSubject(store, item.subject.entity_kind, item.subject.entity_id, codes)).label,
      field: itemFields(item).map(fieldLabel).join(' + '),
      at: uuidTime(item.id),
      ruling: !!item.ruling,
      pin: item.subject.field === 'pin',
      deviceId: item.subject.entity_kind === 'device' ? item.subject.entity_id : null,
    };
  const as = sideOf(item, 'A');
  const bs = sideOf(item, 'B');
  const current =
    item.subject.entity_kind && item.subject.entity_id
      ? await store.get<Row>(item.subject.entity_kind as 'device', item.subject.entity_id).catch(() => null)
      : null;

  const fields: ReviewFieldRow[] = [];
  for (const f of itemFields(item)) {
    const a = as.find((c) => c.field === f);
    const b = bs.find((c) => c.field === f);
    const aValue = a ? a.value : f === 'deleted_at' ? !!current?.deleted_at : current?.[f];
    let was: string | null = null;
    const bOp = b ? await store.getOp(b.op_id) : null;
    if (bOp) {
      const base = bOp.base_op_id ? await store.getOp(bOp.base_op_id) : null;
      const v = opValue(base, f);
      was = !bOp.base_op_id ? formatValue(f, f === 'deleted_at' ? false : null) : v === undefined ? null : formatValue(f, v);
    }
    fields.push({ field: f, label: fieldLabel(f), a: formatValue(f, aValue), b: b ? formatValue(f, b.value) : '(unchanged)', was });
  }

  const labels = await loadInstallLabels(store);
  const isPin = row.pin;
  const resolvable = item.kind === 'sync_conflict' && item.state === 'open';
  const choices = resolvable ? choicesFor(item) : [];
  return {
    item,
    row,
    a: side(as[0], names, store.installId, labels),
    b: side(bs[0], names, store.installId, labels),
    fields,
    choices,
    combine: choices.includes('combine') ? combineText(item) : null,
    pins: isPin ? { a: asPin(as[0]?.value ?? current?.pin), b: asPin(bs[0]?.value) } : null,
    resolvable,
    punchDevice: await punchDeviceReview(store, item, codes),
  };
}

/** The plan's pin-conflict overlay (Phase 3 §6): the device's B position, drawn dashed. */
export type PinConflict = {
  itemId: string;
  deviceId: string;
  a: { x: number; y: number } | null;
  b: { x: number; y: number } | null;
  /** "A — Landry 10/09 14:02 (solid)" etc. */
  aLabel: string;
  bLabel: string;
};

/** The pin conflict for the plan of `sheetId`, or null when the item is not an open pin conflict there. */
export async function loadPinConflict(
  store: Store,
  itemId: string,
  sheetId: string | null,
  names: ReadonlyMap<string, string>,
): Promise<PinConflict | null> {
  const d = await loadReviewDetail(store, itemId, names);
  if (!d || !d.pins || !d.resolvable || d.item.subject.entity_kind !== 'device') return null;
  const on = (p: { sheet: string | null; x: number; y: number } | null) => (p && (!p.sheet || !sheetId || p.sheet === sheetId) ? { x: p.x, y: p.y } : null);
  const label = (s: ReviewSide | null, letter: string, style: string) =>
    s ? `${letter} — ${s.who} ${shortStamp(s.when)} (${style})` : `${letter} (${style})`;
  return {
    itemId,
    deviceId: d.item.subject.entity_id,
    a: on(d.pins.a),
    b: on(d.pins.b),
    aLabel: label(d.a, 'A', 'solid'),
    bLabel: label(d.b, 'B', 'dashed'),
  };
}
