/**
 * Read model of the punch item / missing part editor (T162, D254): one item with its device (a
 * jump to its card), Tracking status + Date closed or Part status, Owner, Notes with the project's
 * `punch_note` / `part_note` chips, and its History. An R3c address item ("Missing all Device
 * Neuron IDs", …) is kept by the rules (D49, D170): its status is read-only here and the devices
 * its Notes name are listed per floor as links (none when it reads "Missing all …": its Notes are
 * a phrase, T169). No React or Expo imports: runs in Node.
 */

import { displayNumber, punchDeviceText, reviewFields, type Store } from '@field-survey/core';
import { ADDRESS_LABEL, addressItemKind, isAllNotes, loadRuleParams, type AddressKind } from '@field-survey/rules';

import { historyEntry, type HistoryEntry, type JumpTarget } from '../card/model';
import { SEED_VOCAB } from '../vocab/seed';
import { ITEM_TABLE, type ItemKind } from './actions';

export type MissingDevice = { label: string; jump: JumpTarget | null };
/** The devices an R3c item's Notes name on one floor (`levelCode` null: a label no device here carries). */
export type MissingGroup = { levelCode: string | null; devices: MissingDevice[] };

export type ItemView = {
  kind: ItemKind;
  id: string;
  /** `12`, or `NEW` until the server numbers it (D25). */
  label: string;
  /** Item text, or the part (with `×qty`). */
  title: string;
  /** Punch Type, or the part number. */
  sub: string | null;
  levelId: string | null;
  levelCode: string | null;
  device: { id: string; label: string; deleted: boolean; jump: JumpTarget | null } | null;
  /** A punch item's Device text (D148, D150); null for a part. */
  deviceText: string | null;
  /** Tracking status (none reads `Open`) or Part status (none reads `Needed`). */
  status: string;
  dateClosed: string | null;
  owner: string | null;
  notes: string | null;
  deleted: boolean;
  inReview: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  phrases: readonly string[];
  history: HistoryEntry[];
  /**
   * An R3c address item: its kind, what it waits for, and the devices its Notes name per floor;
   * `all` when its Notes are the "all" phrase (no device on the floor has the address, T169): no list.
   */
  rule: { kind: AddressKind; label: string; all: boolean; missing: MissingGroup[] } | null;
};

/** History labels of the item's fields (the card's labels are a device's). */
export const ITEM_FIELD_LABEL: Readonly<Record<string, string>> = {
  item: 'Item',
  type: 'Type',
  owner: 'Owner',
  tracking_status: 'Tracking status',
  date_closed: 'Date closed',
  notes: 'Notes',
  part: 'Part',
  part_no: 'Part no.',
  qty: 'Qty',
  part_status: 'Part status',
  device_id: 'Device',
  cable_end_id: 'Connection',
  device_text: 'Device text',
  device_location: 'Device / Location',
  level_id: 'Level',
  sort_last: 'Sorted last',
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The item `id` of `kind`, null when it is not on this iPad. `fromLevelId` is the plan's level:
 * a device there is selected, one on another level opens that level (`JumpTarget.sameLevel`).
 */
export async function loadItem(store: Store, kind: ItemKind, id: string, fromLevelId: string | null): Promise<ItemView | null> {
  const row = await store.get<Row>(ITEM_TABLE[kind], id);
  if (!row) return null;
  const levelId = str(row.level_id);
  const level = levelId ? await store.get<Row>('level', levelId) : null;
  const projectId = level ? String(level.project_id) : null;

  let device: ItemView['device'] = null;
  let linked: Row | null = null;
  if (str(row.device_id)) {
    const d = await store.get<Row>('device', String(row.device_id));
    if (d) {
      const lv = await store.get<Row>('level', String(d.level_id));
      const label = displayNumber('device', d, lv ? String(lv.level) : null);
      const deleted = !!d.deleted_at;
      if (!deleted) linked = d;
      device = {
        id: String(d.id),
        label,
        deleted,
        jump: deleted ? null : { deviceId: String(d.id), levelId: String(d.level_id), label, sameLevel: d.level_id === fromLevelId },
      };
    }
  }

  let rule: ItemView['rule'] = null;
  if (kind === 'punch' && projectId) {
    const proposal = str(row.proposal_id) ? await store.get<Row>('proposal', String(row.proposal_id)) : null;
    const params = await loadRuleParams(store, projectId);
    const k = addressItemKind(
      params,
      { item: str(row.item), rule_id: str(row.rule_id) },
      proposal ? { rule_id: String(proposal.rule_id), discriminator: str(proposal.discriminator) } : null,
    );
    if (k) {
      const all = isAllNotes(params, str(row.notes));
      rule = { kind: k, label: ADDRESS_LABEL[k], all, missing: all ? [] : await missingGroups(store, projectId, str(row.notes), fromLevelId) };
    }
  }

  const list = kind === 'punch' ? 'punch_note' : 'part_note';
  const vocabRows = projectId
    ? await store.list<Row>('vocab', { where: `project_id = ? AND list = ? AND canonical_of_id IS NULL`, params: [projectId, list], orderBy: 'id' })
    : [];
  const ops = await store.opsFor(id);
  const qty = typeof row.qty === 'number' ? row.qty : null;
  return {
    kind,
    id,
    label: displayNumber(ITEM_TABLE[kind], row),
    title: kind === 'punch' ? (str(row.item) ?? '(no text)') : `${str(row.part) ?? str(row.part_no) ?? '(no part)'}${qty != null ? ` ×${qty}` : ''}`,
    sub: kind === 'punch' ? str(row.type) : str(row.part) ? str(row.part_no) : null,
    levelId,
    levelCode: level ? String(level.level) : null,
    device,
    deviceText: kind === 'punch' ? punchDeviceText(row, linked) : str(row.device_location),
    status: kind === 'punch' ? (str(row.tracking_status) ?? 'Open') : (str(row.part_status) ?? 'Needed'),
    dateClosed: kind === 'punch' ? str(row.date_closed) : null,
    owner: str(row.owner),
    notes: str(row.notes),
    deleted: !!row.deleted_at,
    inReview: new Set(Object.keys(await reviewFields(store, id))),
    pending: new Set(ops.filter((o) => o.state === 'pending' && o.field).map((o) => o.field!)),
    phrases: vocabRows.length ? vocabRows.map((v) => String(v.value)) : SEED_VOCAB[list],
    history: ops
      .map((op) => {
        const h = historyEntry(op);
        return op.kind === 'set' && op.field ? { ...h, what: ITEM_FIELD_LABEL[op.field] ?? h.what } : h;
      })
      .reverse(),
    rule,
  };
}

/**
 * The devices an R3c item's Notes name ("B2-D1, B2-S1, 06M-S4"), grouped by floor in the order the
 * Notes list them. A label that is no live device of the project (a `NEW` device's `06M-?`, an
 * imported text) is kept, unlinked, under `levelCode` null.
 */
export async function missingGroups(store: Store, projectId: string, notes: string | null, fromLevelId: string | null): Promise<MissingGroup[]> {
  const labels = (notes ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!labels.length) return [];
  const found = new Map<string, { id: string; levelId: string; level: string }>();
  const rows = await store.db.query<{ id: string; level_id: string; display_id: string; level: string }>(
    `SELECT d.id, d.level_id, d.display_id, l.level FROM device d JOIN level l ON l.id = d.level_id
      WHERE l.project_id = ? AND d.deleted_at IS NULL AND d.display_id IN (${labels.map(() => '?').join(',')})`,
    [projectId, ...labels],
  );
  for (const r of rows) found.set(r.display_id, { id: r.id, levelId: r.level_id, level: r.level });
  const groups = new Map<string | null, MissingDevice[]>();
  for (const label of new Set(labels)) {
    const d = found.get(label);
    const key = d ? d.level : null;
    const jump = d ? { deviceId: d.id, levelId: d.levelId, label, sameLevel: d.levelId === fromLevelId } : null;
    groups.set(key, [...(groups.get(key) ?? []), { label, jump }]);
  }
  // floors in the order the Notes first name them; unlinked labels last
  return [...groups].sort(([a], [b]) => Number(a === null) - Number(b === null)).map(([levelCode, devices]) => ({ levelCode, devices }));
}
