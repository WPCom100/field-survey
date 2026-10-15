/**
 * Accept / Edit / Reject of a proposal (Phase 3 §4.3, PLAN §6), as a pure plan the engine
 * applies through the `Editor` in one group. What a payload means, by `kind`:
 *
 * | kind     | payload                                                        | on Accept |
 * |----------|----------------------------------------------------------------|-----------|
 * | `punch`  | `punch_item` columns (`item`, `type`, `owner`, `notes`, `tracking_status`, `date_closed`, `device_id`, `cable_end_id`, `device_text`, `sort_last`, `level_id`) | one `punch_item` create |
 * | `part`   | `missing_part` columns (`part`, `part_no`, `qty`, `owner`, `part_status`, `notes`, `device_id`, `device_location`, `level_id`) + `sources: [{target_kind, target_id}]` | one `missing_part` create + `part_source` links |
 * | `status` | `now` (the status), optional `field` (default `status`), optional `extra` (more columns to set) | `set`s on the subject |
 * | `note`   | `now` (the text), optional `field` (default `note` on an end, `notes` on a device), optional `extra` | `set`s on the subject |
 * | `cable`  | `cable: {…cable columns}`, `ends: [{…end columns}, {…}]`       | the cable and its ends, linked |
 *
 * `level_id` falls back to the subject's `level_id`; `rule_id` and `proposal_id` are stamped
 * by the engine. `why` is never written to a record. Edit = Accept with an edited payload
 * (merged over the proposal's) and the row marked `edited`. Reject writes the row only.
 */

import { uuidv7, type EntityKind } from '@field-survey/core';
import type { ProposalRow, Subject } from './snapshot';

export type RecordPlan =
  | { kind: 'create'; entity: EntityKind; id: string; payload: Record<string, unknown> }
  | { kind: 'set'; entity: EntityKind; id: string; fields: Record<string, unknown> }
  | { kind: 'link'; entity: EntityKind; ownerId: string; key: Record<string, unknown> };

export class DecideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecideError';
  }
}

const PUNCH_COLUMNS = ['level_id', 'device_id', 'cable_end_id', 'device_text', 'item', 'type', 'owner', 'tracking_status', 'date_closed', 'notes', 'sort_last'] as const;
const PART_COLUMNS = ['level_id', 'device_id', 'device_location', 'part', 'part_no', 'qty', 'owner', 'part_status', 'notes'] as const;
const CABLE_COLUMNS = ['cable', 'qty', 'origin', 'single_row', 'riser_ref', 'riser_to_label', 'vertical', 'endpoint_confirmed'] as const;
const END_COLUMNS = ['side', 'endpoint_kind', 'device_id', 'placeholder_id', 'level_id', 'from_text', 'to_text', 'status', 'note', 'surveyed_by_id', 'surveyed_at', 'status_source'] as const;

/** The keys of a payload a person may edit on the card (strings and numbers, not ids or `why`). */
export function editableKeys(kind: ProposalRow['kind'], payload: Record<string, unknown>): string[] {
  const allowed: readonly string[] =
    kind === 'punch' ? PUNCH_COLUMNS : kind === 'part' ? PART_COLUMNS : kind === 'status' || kind === 'note' ? ['now'] : [];
  return Object.keys(payload).filter((k) => allowed.includes(k) && !k.endsWith('_id') && (typeof payload[k] === 'string' || typeof payload[k] === 'number'));
}

function pick(payload: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) if (payload[c] !== undefined) out[c] = payload[c];
  return out;
}

function levelOf(payload: Record<string, unknown>, subject: Subject | null, what: string): string {
  const level = (payload.level_id as string | undefined) ?? subject?.level_id ?? null;
  if (!level) throw new DecideError(`${what} needs a level_id (payload or subject)`);
  return level;
}

/** The records an Accept creates or the fields it sets, with `rule_id` / `proposal_id` stamped. */
export function acceptPlan(row: ProposalRow, payload: Record<string, unknown> = row.payload ?? {}): RecordPlan[] {
  const subject = row.subject;
  const stamp = { rule_id: row.rule_id, proposal_id: row.id };
  switch (row.kind) {
    case 'punch': {
      const p = pick(payload, PUNCH_COLUMNS);
      p.level_id = levelOf(payload, subject, 'A punch proposal');
      if (!p.device_id && subject?.entity_kind === 'device') p.device_id = subject.entity_id;
      if (!p.cable_end_id && subject?.entity_kind === 'cable_end') p.cable_end_id = subject.entity_id;
      if (typeof p.item !== 'string' || !p.item) throw new DecideError('A punch proposal needs item text');
      p.tracking_status ??= 'Open';
      return [{ kind: 'create', entity: 'punch_item', id: uuidv7(), payload: { ...p, ...stamp } }];
    }
    case 'part': {
      const p = pick(payload, PART_COLUMNS);
      p.level_id = levelOf(payload, subject, 'A part proposal');
      if (!p.device_id && subject?.entity_kind === 'device') p.device_id = subject.entity_id;
      if (typeof p.part !== 'string' || !p.part) throw new DecideError('A part proposal needs the part text');
      p.part_status ??= 'Needed';
      const id = uuidv7();
      const plan: RecordPlan[] = [{ kind: 'create', entity: 'missing_part', id, payload: { ...p, ...stamp } }];
      const sources = Array.isArray(payload.sources) ? (payload.sources as Record<string, unknown>[]) : [];
      for (const s of sources) {
        if (typeof s?.target_kind === 'string' && typeof s?.target_id === 'string') {
          plan.push({ kind: 'link', entity: 'part_source', ownerId: id, key: { target_kind: s.target_kind, target_id: s.target_id } });
        }
      }
      return plan;
    }
    case 'status':
    case 'note': {
      if (!subject || (subject.entity_kind !== 'device' && subject.entity_kind !== 'cable_end')) {
        throw new DecideError(`A ${row.kind} proposal needs a device or cable end subject`);
      }
      if (payload.now === undefined) throw new DecideError(`A ${row.kind} proposal needs 'now'`);
      const field =
        typeof payload.field === 'string' ? payload.field : row.kind === 'status' ? 'status' : subject.entity_kind === 'device' ? 'notes' : 'note';
      const extra = payload.extra && typeof payload.extra === 'object' ? (payload.extra as Record<string, unknown>) : {};
      return [{ kind: 'set', entity: subject.entity_kind, id: subject.entity_id, fields: { [field]: payload.now, ...extra } }];
    }
    case 'cable': {
      const cable = payload.cable && typeof payload.cable === 'object' ? (payload.cable as Record<string, unknown>) : null;
      const ends = Array.isArray(payload.ends) ? (payload.ends as Record<string, unknown>[]) : [];
      if (!cable || ends.length === 0 || ends.length > 2) throw new DecideError('A cable proposal needs `cable` and one or two `ends`');
      const cableId = uuidv7();
      const endIds = ends.map(() => uuidv7());
      const plan: RecordPlan[] = [
        {
          kind: 'create',
          entity: 'cable',
          id: cableId,
          payload: { ...pick(cable, CABLE_COLUMNS), project_id: row.project_id, end_a_id: endIds[0] ?? null, end_b_id: endIds[1] ?? null },
        },
      ];
      ends.forEach((e, i) => {
        plan.push({ kind: 'create', entity: 'cable_end', id: endIds[i]!, payload: { ...pick(e, END_COLUMNS), side: e.side ?? (i === 0 ? 'A' : 'B'), cable_id: cableId } });
      });
      return plan;
    }
  }
  throw new DecideError(`Unknown proposal kind ${String(row.kind)}`);
}

/** Does a live record's content differ from the payload it was accepted from (an Edit)? */
export function recordDiffers(row: Pick<ProposalRow, 'kind' | 'payload'>, record: Record<string, unknown>): boolean {
  const payload = row.payload ?? {};
  const columns: readonly string[] = row.kind === 'punch' ? PUNCH_COLUMNS : row.kind === 'part' ? PART_COLUMNS : [];
  for (const c of columns) {
    if (c === 'level_id' || c.endsWith('_id')) continue;
    if (payload[c] === undefined) continue;
    if (JSON.stringify(payload[c] ?? null) !== JSON.stringify(record[c] ?? null)) return true;
  }
  return false;
}
