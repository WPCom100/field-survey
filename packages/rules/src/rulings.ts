/**
 * Rulings (T37, PLAN §6.4, Phase 3 §8): one decision applied to every record that matches it.
 * Pure: the shape of a ruling, its filter and action, the preview (one row per record it would
 * change: Level · Ref · Field · Was → Now), the vocabulary a rename records, and the standing
 * rule that proposes the change on records that match later. The engine (`engine.ts`) writes
 * the ops: `change_type = Ruling`, `reason` = the ruling text, `ruling_id` (D179).
 *
 * A `ruling` row stores (D179):
 *
 * | column | content |
 * |---|---|
 * | `text` | the reason, the Change Log's Reason |
 * | `scope_levels` | level **codes** (as the seed import writes them, D50); null or empty = all levels |
 * | `filter` | `{ entity, where: [{field, op, value}], ids?, except? }` — `ids` limits it to chosen records (multi-select, lint), `except` holds the records unticked in a preview, which the ruling never touches or proposes again |
 * | `action` | `{kind: 'set', field, value}` · `{kind: 'rename', field, from, to}` (a whole value or one "; " phrase) · `{kind: 'append', field, text}` (a phrase, once) · `{kind: 'item', item, type, owner, notes?}` (a punch item per device or connection end) |
 *
 * The seed import's D50 ruling uses the older `filter {entity, field, values}` and
 * `action {set: {field: value}}`; `parseRuling` reads both.
 */

import { vocab as V, uuidv7 } from '@field-survey/core';

import type { RecordPlan } from './decide';
import type { Rule, RuleContext } from './rule';
import { VOCAB_FIELDS } from './rules/lint';
import { appendPhrase } from './rules/quick';
import { compareIds, compareLevels } from './rules/shared';
import type { CableEndRow, LevelRow, RulingRow, Snapshot, SnapshotIndex, Subject, VocabRow } from './snapshot';

export const RULING_ENTITIES = ['device', 'cable_end', 'cable', 'punch_item', 'missing_part'] as const;
export type RulingEntity = (typeof RULING_ENTITIES)[number];

export const ENTITY_LABEL: Readonly<Record<RulingEntity, string>> = {
  device: 'Device',
  cable_end: 'Connection end',
  cable: 'Cable',
  punch_item: 'Punch item',
  missing_part: 'Missing part',
};

export const FILTER_OPS = ['eq', 'ne', 'contains', 'not_contains', 'has_phrase', 'empty', 'not_empty', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const OP_LABEL: Readonly<Record<FilterOp, string>> = {
  eq: '=',
  ne: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  has_phrase: 'has phrase',
  empty: 'is empty',
  not_empty: 'is not empty',
  in: 'is one of',
};

/** Ops that take no value. */
export const UNARY_OPS: ReadonlySet<FilterOp> = new Set(['empty', 'not_empty']);

export interface Condition {
  field: string;
  op: FilterOp;
  value?: string | string[] | null;
}

export interface RulingFilter {
  entity: RulingEntity;
  where: Condition[];
  /** Only these records (multi-select, "fix all via ruling"). */
  ids?: string[] | null;
  /** Records a preview unticked: never changed or proposed by this ruling. */
  except?: string[] | null;
}

export type RulingAction =
  | { kind: 'set'; field: string; value: string }
  | { kind: 'rename'; field: string; from: string; to: string }
  | { kind: 'append'; field: string; text: string }
  | { kind: 'item'; item: string; type: string; owner: string; notes?: string | null };

export type ActionKind = RulingAction['kind'];

export const ACTION_LABEL: Readonly<Record<ActionKind, string>> = {
  set: 'Set field',
  rename: 'Rename phrase',
  append: 'Append note',
  item: 'Generate item',
};

/** A ruling as the editor holds it, before or after it is stored. */
export interface RulingDraft {
  id?: string | null;
  text: string;
  scope_levels: string[] | null;
  filter: RulingFilter;
  action: RulingAction;
  standing: boolean;
}

// ------------------------------------------------------------------ fields

export interface RulingField {
  field: string;
  label: string;
  type: 'text' | 'enum' | 'number';
  /** Fixed values (enums) or suggestions (cable codes, categories). */
  options?: readonly string[];
  /** Options are the only allowed values (an enum column). */
  strict?: boolean;
  /** A set / rename may write it (false: server-assigned or read through another record). */
  settable: boolean;
  /** "; "-separated phrases (notes): append applies. */
  phrases?: boolean;
}

const CABLE_CODES = ['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V', 'D'] as const;
const CATEGORIES = ['Relay panel', 'Foundry panel', 'EBDK', 'Equipment rack', 'NSPS', 'Touchscreen', 'Station', 'Sensor'] as const;

const text = (field: string, label: string, extra: Partial<RulingField> = {}): RulingField => ({ field, label, type: 'text', settable: true, ...extra });
const enumField = (field: string, label: string, options: readonly string[]): RulingField => ({ field, label, type: 'enum', options, strict: true, settable: true });

export const RULING_FIELDS: Readonly<Record<RulingEntity, readonly RulingField[]>> = {
  device: [
    text('display_id', 'ID', { settable: false }),
    text('category', 'Category', { options: CATEGORIES }),
    text('device', 'Device'),
    text('type', 'Type'),
    text('room_location', 'Room / Location'),
    text('drawing_position', 'Drawing Position'),
    enumField('status', 'Status', V.DEVICE_STATUS),
    text('notes', 'Notes', { phrases: true }),
  ],
  cable_end: [
    text('cable', 'Cable', { options: CABLE_CODES, settable: false }),
    text('display_id', 'ID', { settable: false }),
    text('from_text', 'From'),
    text('to_text', 'To'),
    enumField('status', 'Status', V.CONNECTION_STATUS),
    text('note', 'Note', { phrases: true }),
  ],
  cable: [text('cable', 'Cable', { options: CABLE_CODES }), text('vertical', 'Vertical'), text('riser_to_label', 'Riser To')],
  punch_item: [
    { field: 'number', label: '#', type: 'number', settable: false },
    text('item', 'Item'),
    enumField('type', 'Type', V.PUNCH_TYPE),
    enumField('owner', 'Owner', V.OWNER),
    enumField('tracking_status', 'Tracking status', V.TRACKING_STATUS),
    text('device_text', 'Device'),
    text('notes', 'Notes', { phrases: true }),
  ],
  missing_part: [
    { field: 'number', label: '#', type: 'number', settable: false },
    text('part', 'Part'),
    text('part_no', 'Part no.'),
    text('device_location', 'Device / Location'),
    enumField('owner', 'Owner', V.OWNER),
    enumField('part_status', 'Part status', V.PART_STATUS),
    text('notes', 'Notes', { phrases: true }),
  ],
};

export function fieldOf(entity: RulingEntity, field: string): RulingField | null {
  return RULING_FIELDS[entity]?.find((f) => f.field === field) ?? null;
}

/** Which actions an entity offers, and on which fields. */
export function actionFields(entity: RulingEntity, kind: ActionKind): RulingField[] {
  const fields = RULING_FIELDS[entity] ?? [];
  switch (kind) {
    case 'set':
      return fields.filter((f) => f.settable);
    case 'rename':
      return fields.filter((f) => f.settable && f.type === 'text');
    case 'append':
      return fields.filter((f) => f.settable && f.phrases);
    case 'item':
      return [];
  }
}

export function actionsFor(entity: RulingEntity): ActionKind[] {
  const out: ActionKind[] = ['set', 'rename'];
  if (actionFields(entity, 'append').length) out.push('append');
  if (entity === 'device' || entity === 'cable_end') out.push('item');
  return out;
}

/** The vocabulary list a rename of this field records (`VOCAB_FIELDS`), or null. */
export function vocabListOf(entity: RulingEntity, field: string): string | null {
  return VOCAB_FIELDS.find((v) => v.entity === entity && v.field === field)?.list ?? null;
}

// ------------------------------------------------------------------ parsing and checks

const isEntity = (v: unknown): v is RulingEntity => typeof v === 'string' && (RULING_ENTITIES as readonly string[]).includes(v);
const isOp = (v: unknown): v is FilterOp => typeof v === 'string' && (FILTER_OPS as readonly string[]).includes(v);
const strOf = (v: unknown): string => (v == null ? '' : String(v));
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

/** The filter of a stored row, the D50 `{entity, field, values}` form included; null if unreadable. */
export function parseFilter(raw: unknown): RulingFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (!isEntity(f.entity)) return null;
  const where: Condition[] = [];
  if (Array.isArray(f.where)) {
    for (const c of f.where as Record<string, unknown>[]) {
      if (!c || typeof c.field !== 'string' || !isOp(c.op)) return null;
      where.push({ field: c.field, op: c.op, value: Array.isArray(c.value) ? strList(c.value) : c.value == null ? null : String(c.value) });
    }
  } else if (typeof f.field === 'string' && Array.isArray(f.values)) {
    where.push({ field: f.field, op: 'in', value: strList(f.values) ?? [] });
  }
  return { entity: f.entity, where, ids: strList(f.ids), except: strList(f.except) };
}

/** The action of a stored row, the D50 `{set: {field: value}}` form included; null if unreadable. */
export function parseAction(raw: unknown): RulingAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case 'set':
      return typeof a.field === 'string' ? { kind: 'set', field: a.field, value: strOf(a.value) } : null;
    case 'rename':
      return typeof a.field === 'string' ? { kind: 'rename', field: a.field, from: strOf(a.from), to: strOf(a.to) } : null;
    case 'append':
      return typeof a.field === 'string' ? { kind: 'append', field: a.field, text: strOf(a.text) } : null;
    case 'item':
      return { kind: 'item', item: strOf(a.item), type: strOf(a.type), owner: strOf(a.owner), notes: a.notes == null ? null : String(a.notes) };
  }
  if (a.set && typeof a.set === 'object') {
    const [field, value] = Object.entries(a.set as Record<string, unknown>)[0] ?? [];
    if (typeof field === 'string') return { kind: 'set', field, value: strOf(value) };
  }
  return null;
}

/** A stored ruling as a draft; null when its filter or action cannot be read (another version's). */
export function parseRuling(row: Pick<RulingRow, 'id' | 'text' | 'scope_levels' | 'filter' | 'action' | 'standing'>): RulingDraft | null {
  const filter = parseFilter(row.filter);
  const action = parseAction(row.action);
  if (!filter || !action) return null;
  return { id: row.id, text: row.text ?? '', scope_levels: strList(row.scope_levels), filter, action, standing: !!row.standing };
}

/** What is wrong with a draft, in words; empty when it can be previewed and applied. */
export function checkRuling(d: RulingDraft): string[] {
  const out: string[] = [];
  if (!d.text.trim()) out.push('Give the ruling a reason: it is the Change Log\'s Reason on every change.');
  const entity = d.filter.entity;
  if (!isEntity(entity)) return [...out, 'Pick what the ruling applies to.'];
  d.filter.where.forEach((c, i) => {
    const f = fieldOf(entity, c.field);
    if (!f) out.push(`Condition ${i + 1}: pick a field.`);
    else if (!UNARY_OPS.has(c.op)) {
      const empty = Array.isArray(c.value) ? c.value.length === 0 : !strOf(c.value).trim();
      if (empty) out.push(`Condition ${i + 1}: ${f.label} ${OP_LABEL[c.op]} what?`);
    }
  });
  if (!d.filter.where.length && !(d.filter.ids?.length)) out.push('Add a condition (or pick records): a ruling never applies to everything unasked.');
  const a = d.action;
  if (a.kind === 'item') {
    if (entity !== 'device' && entity !== 'cable_end') out.push('Items are generated on devices or connection ends.');
    if (!a.item.trim()) out.push('Item text is missing.');
    if (!(V.PUNCH_TYPE as readonly string[]).includes(a.type)) out.push(`Item type must be one of: ${V.PUNCH_TYPE.join(' · ')}.`);
    if (!(V.OWNER as readonly string[]).includes(a.owner)) out.push(`Owner must be one of: ${V.OWNER.join(' · ')}.`);
    return out;
  }
  const f = actionFields(entity, a.kind).find((x) => x.field === a.field);
  if (!f) {
    out.push(`${ACTION_LABEL[a.kind]}: pick a field.`);
    return out;
  }
  if (a.kind === 'set') {
    if (!a.value.trim()) out.push(`Set ${f.label} to what?`);
    else if (f.strict && !f.options?.includes(a.value)) out.push(`${f.label} must be one of: ${f.options?.join(' · ')}.`);
  } else if (a.kind === 'rename') {
    if (!a.from.trim() || !a.to.trim()) out.push('Rename needs the old phrase and the new one.');
    else if (a.from.trim() === a.to.trim()) out.push('The new phrase is the old one.');
  } else if (!a.text.trim()) out.push('Append what?');
  return out;
}

// ------------------------------------------------------------------ records

/** One record a ruling can match, with what the preview shows about it. */
export interface RulingRecord {
  entity: RulingEntity;
  id: string;
  /** The levels it is on (a cable: its ends' levels), for scope and the preview. */
  levels: LevelRow[];
  /** `06M-04`, `C-07`, `#12`, `NEW`. */
  ref: string;
  /** The device and end an item generated on it links to. */
  deviceId: string | null;
  endId: string | null;
  value(field: string): unknown;
}

function endLevelOf(index: SnapshotIndex, end: CableEndRow): LevelRow | null {
  if (end.level_id) {
    const l = index.level.get(end.level_id);
    if (l) return l;
  }
  const d = end.device_id ? index.device.get(end.device_id) : null;
  return d ? (index.level.get(d.level_id) ?? null) : null;
}

function deviceRef(index: SnapshotIndex, levelId: string, displayId: string | null): string {
  return displayId ?? `${index.level.get(levelId)?.level ?? '?'}-?`;
}

/** The live records of an entity as the ruling sees them. */
export function rulingRecords(index: SnapshotIndex, entity: RulingEntity): RulingRecord[] {
  const one = (l: LevelRow | null | undefined) => (l ? [l] : []);
  switch (entity) {
    case 'device':
      return [...index.device.values()].map((d) => ({
        entity, id: d.id, levels: one(index.level.get(d.level_id)), ref: deviceRef(index, d.level_id, d.display_id),
        deviceId: d.id, endId: null, value: (f) => (d as unknown as Record<string, unknown>)[f],
      }));
    case 'cable_end':
      return [...index.cableEnd.values()].map((e) => {
        const d = e.device_id ? index.device.get(e.device_id) : null;
        return {
          entity, id: e.id, levels: one(endLevelOf(index, e)),
          ref: e.display_id ?? (d ? `${deviceRef(index, d.level_id, d.display_id)} end` : 'NEW'),
          deviceId: e.device_id, endId: e.id,
          value: (f) => (f === 'cable' ? (index.cable.get(e.cable_id)?.cable ?? null) : (e as unknown as Record<string, unknown>)[f]),
        };
      });
    case 'cable':
      return [...index.cable.values()].map((c) => {
        const ends = (index.endsByCable.get(c.id) ?? []).slice().sort((a, b) => a.side.localeCompare(b.side));
        const levels = new Map<string, LevelRow>();
        for (const e of ends) {
          const l = endLevelOf(index, e);
          if (l) levels.set(l.id, l);
        }
        return {
          entity, id: c.id, levels: [...levels.values()], ref: ends.map((e) => e.display_id).find(Boolean) ?? `${c.cable ?? 'cable'} NEW`,
          deviceId: null, endId: null, value: (f) => (c as unknown as Record<string, unknown>)[f],
        };
      });
    case 'punch_item':
      return [...index.punchItem.values()].map((p) => ({
        entity, id: p.id, levels: one(index.level.get(p.level_id)), ref: p.number != null ? `#${p.number}` : 'NEW',
        deviceId: p.device_id, endId: p.cable_end_id, value: (f) => (p as unknown as Record<string, unknown>)[f],
      }));
    case 'missing_part':
      return [...index.missingPart.values()].map((m) => ({
        entity, id: m.id, levels: one(index.level.get(m.level_id)), ref: m.number != null ? `#${m.number}` : 'NEW',
        deviceId: m.device_id, endId: null, value: (f) => (m as unknown as Record<string, unknown>)[f],
      }));
  }
}

const phrasesOf = (v: string): string[] => v.split(/;\s*/).map((s) => s.trim()).filter(Boolean);

/** One condition against a value. Text compares exactly (vocabulary strings); `contains` ignores case. */
export function matches(raw: unknown, c: Condition): boolean {
  const v = strOf(raw).trim();
  const want = Array.isArray(c.value) ? '' : strOf(c.value).trim();
  switch (c.op) {
    case 'eq':
      return v === want;
    case 'ne':
      return v !== want;
    case 'contains':
      return v.toLowerCase().includes(want.toLowerCase());
    case 'not_contains':
      return !v.toLowerCase().includes(want.toLowerCase());
    case 'has_phrase':
      return v === want || phrasesOf(v).includes(want);
    case 'empty':
      return v === '';
    case 'not_empty':
      return v !== '';
    case 'in': {
      const list = Array.isArray(c.value) ? c.value : strOf(c.value).split(/\s*,\s*/);
      return list.map((x) => x.trim()).includes(v);
    }
  }
}

/** Is a record inside the ruling's scope and filter (before `except`)? */
export function inRuling(d: RulingDraft, r: RulingRecord): boolean {
  const scope = d.scope_levels?.filter(Boolean) ?? [];
  if (scope.length && !r.levels.some((l) => scope.includes(l.level) || scope.includes(l.id))) return false;
  if (d.filter.ids?.length && !d.filter.ids.includes(r.id)) return false;
  return d.filter.where.every((c) => matches(r.value(c.field), c));
}

// ------------------------------------------------------------------ effects and preview

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `from` replaced by `to` where it is the whole value or one "; " phrase of it. */
export function renamePhrase(value: string, from: string, to: string): string {
  if (value.trim() === from) return to;
  const re = new RegExp(`(^|;\\s*)${escapeRe(from)}(?=\\s*;|\\s*$)`, 'g');
  return value.replace(re, (_m, lead: string) => `${lead}${to}`);
}

export interface PreviewRow {
  /** The record id (one row per record per ruling): what Untick keeps. */
  key: string;
  entity: RulingEntity;
  id: string;
  levelId: string | null;
  levelCode: string | null;
  ref: string;
  /** Column written, and its label ("To"); `item` for a generated item. */
  field: string;
  label: string;
  was: string | null;
  now: string;
  /** For `item`: the punch item to create. */
  create?: Record<string, unknown>;
}

export interface RulingPreview {
  rows: PreviewRow[];
  /** Records the filter matched, the ones already right included. */
  matched: number;
  /** Matched records skipped because a preview of this ruling unticked them. */
  excepted: number;
  levels: number;
  /** What a rename records in the vocabulary (null: nothing; `note` says why). */
  vocab: { list: string; from: string; to: string } | null;
  note: string | null;
  problems: string[];
}

function hasItemText(index: SnapshotIndex, deviceId: string | null, endId: string | null, item: string): boolean {
  const rows = [...(deviceId ? (index.punchByDevice.get(deviceId) ?? []) : []), ...(endId ? (index.punchByEnd.get(endId) ?? []) : [])];
  return rows.some((p) => p.item === item);
}

/** What the action changes on one record; null when it is already right (or out of reach). */
export function effectOf(index: SnapshotIndex, a: RulingAction, r: RulingRecord): Omit<PreviewRow, 'key' | 'entity' | 'id' | 'levelId' | 'levelCode' | 'ref'> | null {
  if (a.kind === 'item') {
    if (r.entity !== 'device' && r.entity !== 'cable_end') return null;
    const level = r.levels[0];
    if (!level) return null;
    const item = a.item.trim();
    // Once an item with this text exists on the record, open or closed, the ruling made its point.
    if (hasItemText(index, r.deviceId, r.endId, item)) return null;
    const notes = a.notes?.trim() || null;
    return {
      field: 'item',
      label: 'Item',
      was: null,
      now: item,
      create: { level_id: level.id, device_id: r.deviceId, cable_end_id: r.endId, item, type: a.type, owner: a.owner, tracking_status: 'Open', notes },
    };
  }
  const f = fieldOf(r.entity, a.field);
  if (!f || !f.settable) return null;
  const cur = r.value(a.field);
  const was = cur == null || cur === '' ? null : String(cur);
  let now: string;
  switch (a.kind) {
    case 'set':
      now = a.value.trim();
      break;
    case 'rename':
      if (!was) return null;
      now = renamePhrase(was, a.from.trim(), a.to.trim());
      break;
    case 'append':
      // Once: a note that holds the phrase anywhere is left alone.
      if (was && phrasesOf(was).includes(a.text.trim())) return null;
      now = appendPhrase(was, a.text.trim());
      break;
  }
  if (now === (was ?? '')) return null;
  return { field: a.field, label: f.label, was, now };
}

/** The live vocabulary row of a list with this value, canonical rows first. */
function vocabRow(rows: readonly VocabRow[], list: string, value: string): VocabRow | null {
  const hits = rows.filter((v) => v.deleted_at == null && v.list === list && v.value === value);
  return hits.find((v) => !v.canonical_of_id) ?? hits[0] ?? null;
}

/**
 * What a rename records in `vocab` (PLAN §6.4): the new phrase canonical, the old one pointing at
 * it (`canonical_of`), and older spellings of the old one re-pointed. Only for a field with a
 * vocabulary list that already has rows in the project: creating the first `punch_item` row would
 * switch R3f on for every item (D179).
 */
export function vocabEffect(snap: Snapshot, d: RulingDraft): { change: RulingPreview['vocab']; note: string | null } {
  if (d.action.kind !== 'rename') return { change: null, note: null };
  const list = vocabListOf(d.filter.entity, d.action.field);
  const label = fieldOf(d.filter.entity, d.action.field)?.label ?? d.action.field;
  if (!list) return { change: null, note: `${label} has no vocabulary list: the rename changes the records only.` };
  const has = snap.vocab.some((v) => v.deleted_at == null && v.list === list);
  if (!has) return { change: null, note: `The project has no ${list} vocabulary yet: the rename changes the records only.` };
  return { change: { list, from: d.action.from.trim(), to: d.action.to.trim() }, note: `Vocabulary ${list}: "${d.action.from.trim()}" becomes an old spelling of "${d.action.to.trim()}".` };
}

/** The steps that record a rename in `vocab` (empty when it is recorded already). */
export function vocabPlan(snap: Snapshot, change: NonNullable<RulingPreview['vocab']>, newId: () => string = uuidv7): RecordPlan[] {
  const rows = snap.vocab.filter((v) => v.deleted_at == null);
  const plan: RecordPlan[] = [];
  let canonical = vocabRow(rows, change.list, change.to);
  if (!canonical) {
    const id = newId();
    plan.push({ kind: 'create', entity: 'vocab', id, payload: { project_id: snap.projectId, list: change.list, value: change.to, canonical_of_id: null } });
    canonical = { id, project_id: snap.projectId, list: change.list, value: change.to, canonical_of_id: null, deleted_at: null };
  } else if (canonical.canonical_of_id) {
    // The ruling makes `to` the spelling: it is no longer a variant of anything.
    plan.push({ kind: 'set', entity: 'vocab', id: canonical.id, fields: { canonical_of_id: null } });
  }
  const variant = vocabRow(rows, change.list, change.from);
  if (!variant) {
    plan.push({ kind: 'create', entity: 'vocab', id: newId(), payload: { project_id: snap.projectId, list: change.list, value: change.from, canonical_of_id: canonical.id } });
  } else if (variant.canonical_of_id !== canonical.id) {
    plan.push({ kind: 'set', entity: 'vocab', id: variant.id, fields: { canonical_of_id: canonical.id } });
  }
  if (variant) {
    for (const v of rows) {
      if (v.list === change.list && v.canonical_of_id === variant.id && v.id !== canonical.id) {
        plan.push({ kind: 'set', entity: 'vocab', id: v.id, fields: { canonical_of_id: canonical.id } });
      }
    }
  }
  return plan;
}

/** The preview of a draft over a snapshot (Phase 3 §8): one row per record it would change. */
export function previewRuling(snap: Snapshot, index: SnapshotIndex, d: RulingDraft): RulingPreview {
  const problems = checkRuling(d);
  const { change, note } = vocabEffect(snap, d);
  if (problems.length) return { rows: [], matched: 0, excepted: 0, levels: 0, vocab: null, note: null, problems };
  const except = new Set(d.filter.except ?? []);
  const rows: { row: PreviewRow; level: LevelRow | null }[] = [];
  let matched = 0;
  let excepted = 0;
  for (const r of rulingRecords(index, d.filter.entity)) {
    if (!inRuling(d, r)) continue;
    matched++;
    if (except.has(r.id)) {
      excepted++;
      continue;
    }
    const e = effectOf(index, d.action, r);
    if (!e) continue;
    const level = r.levels.slice().sort(compareLevels)[0] ?? null;
    rows.push({ row: { key: r.id, entity: r.entity, id: r.id, levelId: level?.id ?? null, levelCode: level?.level ?? null, ref: r.ref, ...e }, level });
  }
  rows.sort((a, b) => (a.level && b.level ? compareLevels(a.level, b.level) : a.level ? -1 : b.level ? 1 : 0) || compareIds(a.row.ref, b.row.ref));
  const levels = new Set(rows.map((r) => r.row.levelId ?? 'none')).size;
  return { rows: rows.map((r) => r.row), matched, excepted, levels, vocab: change, note, problems };
}

// ------------------------------------------------------------------ words

function valueText(c: Condition): string {
  if (UNARY_OPS.has(c.op)) return '';
  return Array.isArray(c.value) ? ` ${c.value.map((v) => `"${v}"`).join(', ')}` : ` "${strOf(c.value)}"`;
}

/** "Connection end · Cable = "0-10V" AND To ≠ "Fixtures"" */
export function describeFilter(f: RulingFilter): string {
  const parts = f.where.map((c) => `${fieldOf(f.entity, c.field)?.label ?? c.field} ${OP_LABEL[c.op]}${valueText(c)}`);
  if (f.ids?.length) parts.push(`${f.ids.length} chosen record${f.ids.length === 1 ? '' : 's'}`);
  return `${ENTITY_LABEL[f.entity] ?? f.entity}${parts.length ? ` · ${parts.join(' AND ')}` : ''}`;
}

/** "set To = "Fixtures"", "rename Owner "ETC/EC" → "EC/ETC""… */
export function describeAction(entity: RulingEntity, a: RulingAction): string {
  if (a.kind === 'item') return `generate item "${a.item}" (${a.type}, ${a.owner})`;
  const label = fieldOf(entity, a.field)?.label ?? a.field;
  if (a.kind === 'set') return `set ${label} = "${a.value}"`;
  if (a.kind === 'rename') return `rename ${label} "${a.from}" → "${a.to}"`;
  return `append "${a.text}" to ${label}`;
}

export function describeRuling(d: RulingDraft): string {
  const scope = d.scope_levels?.length ? ` · levels ${d.scope_levels.join(', ')}` : '';
  return `${describeFilter(d.filter)}${scope} → ${describeAction(d.filter.entity, d.action)}`;
}

// ------------------------------------------------------------------ hand-offs

/** A new draft over chosen records (multi-select "Apply as ruling…", Phase 3 §8). */
export function draftFromSelection(entity: RulingEntity, ids: readonly string[], levelCodes: readonly string[]): RulingDraft {
  const first = actionFields(entity, 'set')[0];
  return {
    text: '',
    scope_levels: levelCodes.length ? [...new Set(levelCodes)] : null,
    filter: { entity, where: [], ids: [...new Set(ids)] },
    action: { kind: 'set', field: first?.field ?? '', value: '' },
    standing: false,
  };
}

/**
 * The lint view's "Fix all via ruling" seed (T36 `rulingSeeds`) as a draft: the records and their
 * levels as the scope, the old value as the condition, a rename when the vocabulary knows the new
 * value, else a set whose value the person picks.
 */
export function draftFromSeed(seed: { entity: string; field: string; action: 'rename' | 'set'; from: string; to: string | null; recordIds: readonly string[]; text: string }, levelCodes: readonly string[]): RulingDraft | null {
  if (!isEntity(seed.entity)) return null;
  const rename = seed.action === 'rename' && seed.to != null;
  return {
    text: seed.text,
    scope_levels: levelCodes.length ? [...new Set(levelCodes)] : null,
    filter: { entity: seed.entity, where: [{ field: seed.field, op: rename ? 'has_phrase' : 'eq', value: seed.from }], ids: [...new Set(seed.recordIds)] },
    action: rename ? { kind: 'rename', field: seed.field, from: seed.from, to: seed.to! } : { kind: 'set', field: seed.field, value: '' },
    standing: false,
  };
}

// ------------------------------------------------------------------ the standing rule

export const RULING_RULE_ID = 'ruling';

/**
 * Standing rulings (PLAN §6.4): every live ruling with `standing` proposes its change on each
 * record that matches it and is not right yet — a record that matched later, or one that drifted
 * back. One proposal per (ruling, record), discriminator = the ruling id. Accept writes the change
 * as a `Ruling` op with the ruling's text and id (`engine.decide`). Records a preview unticked
 * (`except`) are never proposed.
 */
export const RulingRule: Rule = {
  id: RULING_RULE_ID,
  title: 'Standing ruling',
  text: 'A standing ruling proposes its change on every record that matches it later (PLAN §6.4); Accept writes it as a Ruling change with the ruling\'s reason.',
  run(ctx: RuleContext) {
    for (const row of ctx.snap.rulings ?? []) {
      if (row.deleted_at != null || !row.standing) continue;
      const d = parseRuling(row);
      if (!d || checkRuling(d).length) continue;
      const preview = previewRuling(ctx.snap, ctx.index, d);
      const inputs = { filter: d.filter, action: d.action, scope: d.scope_levels };
      for (const r of preview.rows) {
        const subject: Subject = { entity_kind: r.entity, entity_id: r.id, level_id: r.levelId };
        const why = `Standing ruling "${d.text}": ${r.create ? `item "${r.now}"` : `${r.label} "${r.was ?? ''}" → "${r.now}"`}`;
        if (r.create) {
          ctx.propose({ subject, discriminator: row.id, kind: 'punch', payload: { ...r.create, ruling_id: row.id }, inputs: { ...inputs, ruling: row.id }, why });
        } else {
          ctx.propose({
            subject,
            discriminator: row.id,
            kind: r.field === 'status' ? 'status' : 'note',
            payload: { field: r.field, now: r.now, ruling_id: row.id, text: `${r.label}: ${r.now}` },
            inputs: { ...inputs, ruling: row.id, was: r.was },
            why,
          });
        }
      }
    }
  },
};
