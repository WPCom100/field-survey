/**
 * Read model of the device card (T20, Phase 3 §4.3): one device with its accessories, photos,
 * connections, punch items, missing parts, rule drafts, open findings and history. Reads only
 * (writes go through `actions.ts` → `Editor`); no React or Expo imports, so it runs in Node.
 */

import { defaultDeviceText, displayNumber, isNew, reviewFields, type StoredOp, type Store } from '@field-survey/core';

import { photoStrip } from '../photo/links';
import { baselineEvents, type BaselineEvent } from '../setup/lock';

/** Seed of the device-note chips until T40 puts the project's `vocab` lists on the iPad (CLAUDE.md §3). */
export const STANDARD_PHRASES: readonly string[] = [
  'Not run',
  'Run, not terminated',
  'Run, not terminated; no term kit',
  'Not surveyed',
  'Waiting on DMX Termination Kits',
  'Need to be ordered',
  'Confirm whether on site',
  'Confirm whether on site (provided in box)',
  'Replace wire nuts with Wagos (provided in box)',
  'Re-pull correct wire type (Belden 8471) and re-terminate with Wagos (provided in box); provide ground',
  'Not installed: install P-NSPS-D and land 120V and Unison wire',
  'Missing all Device Neuron IDs',
  'Lands in ERP; needs to be run down to the NSPS below it',
  'Reterminated - all good',
  'Empty box on wall.',
  'Land 0-10V control wiring',
];

/** Master column names for the device's op fields (D76 maps them to snake_case). */
export const FIELD_LABEL: Readonly<Record<string, string>> = {
  display_id: 'ID',
  category: 'Category',
  device: 'Device',
  type: 'Type',
  room_location: 'Room / Location',
  drawing_position: 'Drawing Position',
  status: 'Status',
  notes: 'Notes',
  pin: 'Pin',
  neuron_id: 'Neuron ID',
  neuron_method: 'Neuron ID method',
  neuron_evidence_photo_id: 'Neuron ID evidence',
  origin: 'Origin',
  found_on_site: 'Found on site',
  panel_name: 'Panel name',
  library_type_id: 'Library type',
  level_id: 'Level',
};

export type CardDevice = {
  id: string;
  projectId: string;
  levelId: string;
  levelCode: string;
  /** `06M-04`, `01-S15`, or `06M-?` while the server has not numbered it (D93). */
  label: string;
  isNew: boolean;
  category: string | null;
  device: string | null;
  type: string | null;
  room: string | null;
  drawingPosition: string | null;
  status: string | null;
  notes: string | null;
  pin: { sheet: string; x: number; y: number } | null;
  neuronId: string | null;
  neuronMethod: string | null;
  fieldAddition: boolean;
  deleted: boolean;
  deleteReason: string | null;
};

export type CardAccessory = {
  id: string;
  model: string;
  expected: number | null;
  found: number | null;
  notes: string | null;
  /** Found fewer than expected (the D52 lint, shown before the rule engine exists). */
  short: boolean;
};

export type CardPhoto = {
  id: string;
  /** Photo number or `NEW`. */
  label: string;
  thumb: string | null;
  image: string | null;
  markup: string | null;
  subject: string | null;
  /** Some of its bytes (image, thumbnail, markup) are still on this iPad only (`📷 waiting`, as the queue counts). */
  waiting: boolean;
};

export type JumpTarget = { deviceId: string; levelId: string; label: string; sameLevel: boolean };

export type CardConnection = {
  /** The cable end on this device. */
  id: string;
  /** `C-07` or `NEW`. */
  label: string;
  cable: string | null;
  /** Stored To text (D32), else the far end's label. */
  to: string;
  status: string | null;
  note: string | null;
  statusSource: string | null;
  singleRow: boolean;
  /** The far end's device, when it is one (placeholders have nowhere to jump). */
  jump: JumpTarget | null;
};

export type CardPunch = {
  id: string;
  label: string;
  /** The Punch List's Device text, derived from this device (D148): what the export writes. */
  deviceText: string | null;
  item: string;
  type: string | null;
  owner: string | null;
  tracking: string;
  notes: string | null;
  open: boolean;
};

export type CardPart = {
  id: string;
  label: string;
  part: string;
  qty: number | null;
  owner: string | null;
  partStatus: string;
  notes: string | null;
  /** `#4` (punch), `C-07` (end), `device`: the generated Source column. */
  sources: string[];
};

/** A rule proposal on this device or one of its ends (`DRAFT ⚑ R3a`). */
export type CardDraft = {
  id: string;
  ruleId: string;
  kind: string;
  title: string;
  sub: string;
  why: string | null;
};

export type CardFinding = { id: string; lintId: string; message: string };

export type HistoryEntry = {
  opId: string;
  at: string;
  userId: string;
  /** Field label, or `(row added)` / `Deleted` / `Restored` / `ID assigned`. */
  what: string;
  was: string | null;
  now: string | null;
  changeType: string;
  reason: string | null;
  pending: boolean;
  inReview: boolean;
};

export type DeviceCard = {
  device: CardDevice;
  accessories: CardAccessory[];
  photos: CardPhoto[];
  photosWaiting: number;
  connections: CardConnection[];
  punch: CardPunch[];
  parts: CardPart[];
  drafts: CardDraft[];
  findings: CardFinding[];
  history: HistoryEntry[];
  /** Fields with an open review item (IN REVIEW outline). */
  inReview: ReadonlySet<string>;
  /** Fields with an unsynced op of this iPad (per-field dot, Phase 3 §13). */
  pending: ReadonlySet<string>;
  /** Chips under Notes: the project's `device_note` vocabulary, else `STANDARD_PHRASES`. */
  phrases: readonly string[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Numbered rows first by number, `NEW` (no number yet) last. */
function byNumber(a: Row, b: Row): number {
  const na = num(a.number);
  const nb = num(b.number);
  if (na === null || nb === null) return Number(na === null) - Number(nb === null) || String(a.id).localeCompare(String(b.id));
  return na - nb;
}

function inList(ids: readonly string[]): string {
  return ids.map(() => '?').join(',');
}

async function levelCodes(store: Store, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids)];
  if (!want.length) return out;
  for (const r of await store.db.query<{ id: string; level: string }>(`SELECT id, level FROM level WHERE id IN (${inList(want)})`, want)) {
    out.set(r.id, r.level);
  }
  return out;
}

/** A value as the history shows it: `(blank)` for empty, pins as coordinates. */
export function formatValue(field: string | null, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (field === 'pin' && typeof v === 'object') {
    const p = v as Row;
    return num(p.x) !== null && num(p.y) !== null ? `(${Math.round(Number(p.x))}, ${Math.round(Number(p.y))})` : '(blank)';
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** One op of the device's log as a history line (D51: creates read `(row added)`). */
export function historyEntry(op: StoredOp): HistoryEntry {
  const base = {
    opId: op.op_id,
    at: op.client_ts,
    userId: op.user_id,
    changeType: op.change_type,
    reason: op.reason,
    pending: op.state === 'pending',
    inReview: op.state === 'review',
    was: null,
    now: null,
  };
  switch (op.kind) {
    case 'create':
      return { ...base, what: '(row added)' };
    case 'delete':
      return { ...base, what: 'Deleted' };
    case 'restore':
      return { ...base, what: 'Restored' };
    case 'assign':
      return { ...base, what: 'ID assigned', now: formatValue(op.field, op.now) };
    default:
      return {
        ...base,
        what: FIELD_LABEL[op.field ?? ''] ?? op.field ?? op.kind,
        was: formatValue(op.field, op.was),
        now: formatValue(op.field, op.now),
      };
  }
}

/**
 * The level's baseline lock and unlock events as History lines (T47, D164), each placed before the
 * first older entry: what follows a "Baseline locked" line is the change log R6 asks for.
 */
export function withBaselineEvents(history: HistoryEntry[], events: BaselineEvent[], levelCode: string): HistoryEntry[] {
  const out = [...history];
  for (const e of events) {
    const line: HistoryEntry = {
      opId: e.opId,
      at: e.at,
      userId: e.userId,
      what: `${e.locked ? 'Baseline locked' : 'Baseline unlocked'} (${levelCode})`,
      was: null,
      now: null,
      changeType: 'Master edit',
      reason: e.reason,
      pending: e.pending,
      inReview: false,
    };
    const i = out.findIndex((h) => h.at < e.at);
    out.splice(i < 0 ? out.length : i, 0, line);
  }
  return out;
}

/** Everything the card shows for one device; null when the device is not on this iPad. */
export async function loadDeviceCard(store: Store, deviceId: string): Promise<DeviceCard | null> {
  const d = await store.get<Row>('device', deviceId);
  if (!d) return null;
  const level = await store.get<Row>('level', String(d.level_id));
  if (!level) return null;
  const levelCode = String(level.level);
  const projectId = String(level.project_id);
  const pinRow = d.pin && typeof d.pin === 'object' ? (d.pin as Row) : null;

  const device: CardDevice = {
    id: deviceId,
    projectId,
    levelId: String(d.level_id),
    levelCode,
    label: displayNumber('device', d, levelCode),
    isNew: isNew('device', d),
    category: str(d.category),
    device: str(d.device),
    type: str(d.type),
    room: str(d.room_location),
    drawingPosition: str(d.drawing_position),
    status: str(d.status),
    notes: str(d.notes),
    pin:
      pinRow && str(pinRow.sheet) && num(pinRow.x) !== null && num(pinRow.y) !== null
        ? { sheet: String(pinRow.sheet), x: Number(pinRow.x), y: Number(pinRow.y) }
        : null,
    neuronId: str(d.neuron_id),
    neuronMethod: str(d.neuron_method),
    fieldAddition: d.origin === 'field_addition',
    deleted: !!d.deleted_at,
    deleteReason: str(d.delete_reason),
  };

  // --- accessories
  const accessories = (await store.list<Row>('accessory', { where: 'device_id = ?', params: [deviceId], orderBy: 'model, id' })).map(
    (a): CardAccessory => {
      const expected = num(a.expected_qty);
      const found = num(a.found_qty);
      return {
        id: String(a.id),
        model: str(a.model) ?? '(no model)',
        expected,
        found,
        notes: str(a.notes),
        short: expected !== null && found !== null && found < expected,
      };
    },
  );

  // --- photos taken from it or linked to it (D128), and which have not reached the server
  const photos = await photoStrip(store, { kind: 'device', id: deviceId });

  // --- connections: this device's ends, with the far end to jump to
  const ends = await store.list<Row>('cable_end', { where: 'device_id = ?', params: [deviceId] });
  const cableIds = [...new Set(ends.map((e) => String(e.cable_id)))];
  const cables = new Map<string, Row>();
  /** Every live end of those cables by `cable_id|side`: the far end is the other side. */
  const others = new Map<string, Row>();
  if (cableIds.length) {
    for (const c of await store.db.query<Row>(`SELECT * FROM cable WHERE id IN (${inList(cableIds)})`, cableIds)) cables.set(String(c.id), c);
    for (const e of await store.db.query<Row>(
      `SELECT * FROM cable_end WHERE deleted_at IS NULL AND cable_id IN (${inList(cableIds)})`,
      cableIds,
    )) {
      others.set(String(e.cable_id) + '|' + String(e.side), e);
    }
  }
  const farDeviceIds = [...others.values()].map((e) => str(e.device_id)).filter((s): s is string => !!s);
  const farDevices = new Map<string, Row>();
  if (farDeviceIds.length) {
    for (const r of await store.db.query<Row>(`SELECT * FROM device WHERE deleted_at IS NULL AND id IN (${inList(farDeviceIds)})`, farDeviceIds)) {
      farDevices.set(String(r.id), r);
    }
  }
  const farCodes = await levelCodes(store, [...farDevices.values()].map((r) => String(r.level_id)));
  const placeholderIds = [...others.values()].map((e) => str(e.placeholder_id)).filter((s): s is string => !!s);
  const placeholders = new Map<string, string>();
  if (placeholderIds.length) {
    for (const r of await store.db.query<{ id: string; label: string }>(
      `SELECT id, label FROM placeholder WHERE id IN (${inList(placeholderIds)})`,
      placeholderIds,
    )) {
      placeholders.set(r.id, r.label);
    }
  }

  const connections: CardConnection[] = [];
  for (const e of ends) {
    const cable = cables.get(String(e.cable_id));
    if (!cable || cable.deleted_at) continue;
    const other = others.get(String(e.cable_id) + '|' + (e.side === 'A' ? 'B' : 'A')) ?? null;
    const far = other && str(other.device_id) ? (farDevices.get(String(other.device_id)) ?? null) : null;
    const farLabel = far ? displayNumber('device', far, farCodes.get(String(far.level_id)) ?? null) : null;
    const farText = farLabel ?? (other && str(other.placeholder_id) ? (placeholders.get(String(other.placeholder_id)) ?? null) : null);
    connections.push({
      id: String(e.id),
      label: displayNumber('cable_end', e),
      cable: str(cable.cable),
      to: str(e.to_text) ?? farText ?? '(far end not set)',
      status: str(e.status),
      note: str(e.note),
      statusSource: str(e.status_source),
      singleRow: !!cable.single_row,
      jump:
        far && farLabel
          ? { deviceId: String(far.id), levelId: String(far.level_id), label: farLabel, sameLevel: far.level_id === d.level_id }
          : null,
    });
  }
  connections.sort(
    (a, b) => Number(a.label === 'NEW') - Number(b.label === 'NEW') || a.label.localeCompare(b.label, 'en', { numeric: true }) || a.id.localeCompare(b.id),
  );

  // --- punch items (sort_last last, then by number) and missing parts with their sources
  const punchRows = await store.list<Row>('punch_item', { where: 'device_id = ?', params: [deviceId] });
  punchRows.sort((a, b) => Number(!!a.sort_last) - Number(!!b.sort_last) || byNumber(a, b));
  const deviceText = defaultDeviceText(d);
  const punch = punchRows.map(
    (p): CardPunch => ({
      id: String(p.id),
      label: displayNumber('punch_item', p),
      deviceText,
      item: str(p.item) ?? '(no text)',
      type: str(p.type),
      owner: str(p.owner),
      tracking: str(p.tracking_status) ?? 'Open',
      notes: str(p.notes),
      open: str(p.tracking_status) !== 'Closed',
    }),
  );

  const partRows = (await store.list<Row>('missing_part', { where: 'device_id = ?', params: [deviceId] })).sort(byNumber);
  const partIds = partRows.map((m) => String(m.id));
  const sourcesOf = new Map<string, string[]>();
  if (partIds.length) {
    const links = await store.db.query<{ missing_part_id: string; target_kind: string; target_id: string }>(
      `SELECT missing_part_id, target_kind, target_id FROM part_source WHERE deleted_at IS NULL AND missing_part_id IN (${inList(partIds)})`,
      partIds,
    );
    for (const l of links) {
      let label = l.target_kind;
      if (l.target_kind === 'punch') {
        const p = await store.get<Row>('punch_item', l.target_id);
        label = p ? `#${displayNumber('punch_item', p)}` : '#?';
      } else if (l.target_kind === 'cable_end') {
        const e = await store.get<Row>('cable_end', l.target_id);
        label = e ? displayNumber('cable_end', e) : 'C-?';
      }
      sourcesOf.set(l.missing_part_id, [...(sourcesOf.get(l.missing_part_id) ?? []), label]);
    }
  }
  const parts = partRows.map(
    (m): CardPart => ({
      id: String(m.id),
      label: displayNumber('missing_part', m),
      part: str(m.part) ?? str(m.part_no) ?? '(no part)',
      qty: num(m.qty),
      owner: str(m.owner),
      partStatus: str(m.part_status) ?? 'Needed',
      notes: str(m.notes),
      sources: sourcesOf.get(String(m.id)) ?? [],
    }),
  );

  // --- rule drafts on the device or its ends, and open findings on the device
  const subjects = [deviceId, ...ends.map((e) => String(e.id))];
  const drafts = (
    await store.list<Row>('proposal', {
      where: `state = 'proposed' AND json_extract(subject, '$.entity_id') IN (${inList(subjects)})`,
      params: subjects,
      orderBy: 'rule_id, id',
    })
  ).map((p): CardDraft => {
    const pl = p.payload && typeof p.payload === 'object' ? (p.payload as Row) : {};
    return {
      id: String(p.id),
      ruleId: String(p.rule_id),
      kind: String(p.kind),
      title: str(pl.item) ?? str(pl.part) ?? str(pl.text) ?? str(pl.now) ?? String(p.kind),
      sub: [p.kind === 'part' ? 'part' : str(pl.type), str(pl.owner), str(pl.part_status) ?? str(pl.tracking_status)].filter(Boolean).join(' · '),
      why: str(pl.why),
    };
  });
  const findings = (
    await store.list<Row>('finding', {
      where: `state = 'open' AND json_extract(subject, '$.entity_id') = ?`,
      params: [deviceId],
      orderBy: 'lint_id, id',
    })
  ).map((f): CardFinding => ({ id: String(f.id), lintId: String(f.lint_id), message: str(f.message) ?? String(f.lint_id) }));

  // --- history (newest first), review and unsynced marks per field
  const ops = await store.opsFor(deviceId);
  const history = withBaselineEvents(ops.map(historyEntry).reverse(), await baselineEvents(store, device.levelId), levelCode);
  const pending = new Set(ops.filter((o) => o.state === 'pending' && o.field).map((o) => o.field!));
  const inReview = new Set(Object.keys(await reviewFields(store, deviceId)));

  // --- note chips
  const vocabRows = await store.list<Row>('vocab', {
    where: `project_id = ? AND list = 'device_note' AND canonical_of_id IS NULL`,
    params: [projectId],
    orderBy: 'id',
  });
  const phrases = vocabRows.length ? vocabRows.map((v) => String(v.value)) : STANDARD_PHRASES;

  return {
    device,
    accessories,
    photos,
    photosWaiting: photos.filter((p) => p.waiting).length,
    connections,
    punch,
    parts,
    drafts,
    findings,
    history,
    inReview,
    pending,
    phrases,
  };
}
