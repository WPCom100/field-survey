/**
 * Read model and editor helpers of the Rulings screen (T37, Phase 3 §8): the project's rulings
 * with their standing proposals, and the pure steps the editor takes on a draft (pick the entity,
 * add a condition, switch the action, copy a stored ruling). Preview and Apply go through
 * `RuleEngine.previewRuling` / `applyRuling`. No React or Expo imports.
 */

import type { Store } from '@field-survey/core';
import {
  actionFields,
  actionsFor,
  describeAction,
  describeFilter,
  parseRuling,
  RULING_FIELDS,
  RULING_RULE_ID,
  type ActionKind,
  type Condition,
  type RulingAction,
  type RulingDraft,
  type RulingEntity,
  type RulingPreview,
  cableCodes,
  loadRuleParams,
} from '@field-survey/rules';

import { describeSubject, levelCodes } from '../review/model';

type Row = Record<string, unknown>;

export type RulingListRow = {
  id: string;
  text: string;
  /** "Connection end · Cable = "0-10V" → set To = "Fixtures"", or why it cannot be read. */
  filter: string;
  action: string;
  scope: string;
  standing: boolean;
  appliedAt: string | null;
  opCount: number;
  createdBy: string | null;
  createdAt: string | null;
  /** Open proposals the standing ruling raised. */
  open: number;
  /** Null when the stored ruling is another app version's shape. */
  draft: RulingDraft | null;
};

export type RulingProposalRow = { id: string; rulingId: string; subject: string; levelCode: string | null; change: string; why: string | null; deviceId: string | null; levelId: string | null };

export type RulingsView = {
  rows: RulingListRow[];
  standing: number;
  applied: number;
  levels: { id: string; code: string }[];
  /** The project's cable codes (`cableCodes`, T121): the Cable field's suggestions. */
  cables: string[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export async function loadRulings(store: Store, projectId: string): Promise<RulingsView> {
  const codes = await levelCodes(store, projectId);
  const rulings = await store.list<Row>('ruling', { where: 'project_id = ?', params: [projectId], orderBy: 'created_at DESC, id' });
  const counts = new Map<string, number>();
  for (const p of await store.list<Row>('proposal', { where: `project_id = ? AND rule_id = ? AND state = 'proposed'`, params: [projectId, RULING_RULE_ID] })) {
    const k = String(p.discriminator ?? '');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const users = new Map((await store.list<Row>('app_user', {})).map((u) => [String(u.id), String(u.name)] as const));
  const rows = rulings.map((r): RulingListRow => {
    const draft = parseRuling(r as never);
    const scope = Array.isArray(r.scope_levels) && r.scope_levels.length ? `Levels ${(r.scope_levels as string[]).join(', ')}` : 'All levels';
    return {
      id: String(r.id),
      text: String(r.text ?? ''),
      filter: draft ? describeFilter(draft.filter) : 'Written by another app version',
      action: draft ? describeAction(draft.filter.entity, draft.action) : '—',
      scope,
      standing: !!r.standing,
      appliedAt: str(r.applied_at),
      opCount: typeof r.op_count === 'number' ? r.op_count : 0,
      createdBy: str(r.created_by_id) ? (users.get(String(r.created_by_id)) ?? null) : null,
      createdAt: str(r.created_at),
      open: counts.get(String(r.id)) ?? 0,
      draft,
    };
  });
  return {
    rows,
    standing: rows.filter((r) => r.standing).length,
    applied: rows.filter((r) => r.appliedAt).length,
    levels: [...codes].map(([id, code]) => ({ id, code })),
    cables: cableCodes(await loadRuleParams(store, projectId)),
  };
}

/** The open proposals of one standing ruling, named for the screen. */
export async function loadRulingProposals(store: Store, projectId: string, rulingId: string): Promise<RulingProposalRow[]> {
  const codes = await levelCodes(store, projectId);
  const rows = await store.list<Row>('proposal', {
    where: `project_id = ? AND rule_id = ? AND state = 'proposed' AND discriminator = ?`,
    params: [projectId, RULING_RULE_ID, rulingId],
    orderBy: 'id',
  });
  const out: RulingProposalRow[] = [];
  for (const p of rows) {
    const s = (p.subject ?? {}) as Row;
    const kind = String(s.entity_kind ?? '');
    const id = String(s.entity_id ?? '');
    const d = kind === 'cable' ? { label: 'Cable', levelId: null, deviceId: null } : await describeSubject(store, kind, id, codes);
    const payload = (p.payload ?? {}) as Row;
    const levelId = d.levelId ?? (typeof s.level_id === 'string' ? s.level_id : null);
    out.push({
      id: String(p.id),
      rulingId,
      subject: d.label,
      levelCode: levelId ? (codes.get(levelId) ?? null) : null,
      change: str(payload.item) ? `Item "${String(payload.item)}"` : (str(payload.text) ?? String(payload.now ?? '')),
      why: str(payload.why),
      deviceId: d.deviceId,
      levelId,
    });
  }
  return out.sort((a, b) => (a.levelCode ?? '').localeCompare(b.levelCode ?? '', 'en', { numeric: true }) || a.subject.localeCompare(b.subject, 'en', { numeric: true }));
}

/** The record kind of each side-list tab, for "Apply as ruling…" on a multi-selection. */
export const LIST_ENTITY: Readonly<Record<'devices' | 'connections' | 'punch' | 'parts', RulingEntity>> = {
  devices: 'device',
  connections: 'cable_end',
  punch: 'punch_item',
  parts: 'missing_part',
};

// ------------------------------------------------------------------ editor steps

export function blankCondition(entity: RulingEntity): Condition {
  return { field: RULING_FIELDS[entity][0]?.field ?? '', op: 'eq', value: '' };
}

export function defaultAction(entity: RulingEntity, kind: ActionKind): RulingAction {
  const field = actionFields(entity, kind)[0]?.field ?? '';
  switch (kind) {
    case 'set':
      return { kind, field, value: '' };
    case 'rename':
      return { kind, field, from: '', to: '' };
    case 'append':
      return { kind, field, text: '' };
    case 'item':
      return { kind, item: '', type: 'Information', owner: 'EC', notes: '' };
    case 'reword':
      return { kind, field };
  }
}

export function emptyDraft(entity: RulingEntity = 'cable_end'): RulingDraft {
  return { text: '', scope_levels: null, filter: { entity, where: [blankCondition(entity)] }, action: defaultAction(entity, 'set'), standing: true };
}

/** Another entity: its own fields, so conditions, chosen records and the action start over. */
export function withEntity(d: RulingDraft, entity: RulingEntity): RulingDraft {
  if (d.filter.entity === entity) return d;
  return { ...d, filter: { entity, where: [blankCondition(entity)] }, action: defaultAction(entity, actionsFor(entity).includes(d.action.kind) ? d.action.kind : 'set') };
}

/** Another action; a reword (T120) is applied once, so it is never standing. */
export function withActionKind(d: RulingDraft, kind: ActionKind): RulingDraft {
  return d.action.kind === kind ? d : { ...d, action: defaultAction(d.filter.entity, kind), ...(kind === 'reword' ? { standing: false } : {}) };
}

export function withCondition(d: RulingDraft, i: number, c: Partial<Condition>): RulingDraft {
  const where = d.filter.where.map((x, j) => (j === i ? { ...x, ...c } : x));
  return { ...d, filter: { ...d.filter, where } };
}

export function addCondition(d: RulingDraft): RulingDraft {
  return { ...d, filter: { ...d.filter, where: [...d.filter.where, blankCondition(d.filter.entity)] } };
}

export function removeCondition(d: RulingDraft, i: number): RulingDraft {
  return { ...d, filter: { ...d.filter, where: d.filter.where.filter((_, j) => j !== i) } };
}

/** Level codes in the scope: toggling one; "All" is `null`. */
export function toggleLevel(d: RulingDraft, code: string): RulingDraft {
  const cur = new Set(d.scope_levels ?? []);
  if (cur.has(code)) cur.delete(code);
  else cur.add(code);
  return { ...d, scope_levels: cur.size ? [...cur] : null };
}

/** A stored ruling as a new draft (Copy): no id, no unticked records, its text marked. */
export function copyOf(d: RulingDraft): RulingDraft {
  const { except: _except, ...filter } = d.filter;
  void _except;
  return { ...d, id: null, text: `${d.text} (copy)`, filter };
}

/** "9 changes on 6 levels" (Phase 3 §8). */
export function previewTitle(p: RulingPreview, ticked: number): string {
  const n = p.rows.length;
  const head = `${n} change${n === 1 ? '' : 's'} on ${p.levels} level${p.levels === 1 ? '' : 's'}`;
  return ticked === n ? head : `${head} · ${n - ticked} unticked`;
}

const UNWORDED_SHOWN = 12;

/** What the preview's footer says beside Apply. */
export function previewFooter(p: RulingPreview, d: RulingDraft): string[] {
  const out = ['Each ticked row becomes one Change Log line: Change = Ruling, Reason = the ruling text.'];
  if (p.excepted) out.push(p.excepted === 1 ? '1 record unticked in an earlier preview stays as it is.' : `${p.excepted} records unticked in an earlier preview stay as they are.`);
  const right = p.matched - p.rows.length - p.excepted - (p.byHand ?? 0) - (p.unworded?.length ?? 0);
  if (right > 0) out.push(`${right} matching record${right === 1 ? ' is' : 's are'} already right.`);
  if (p.note) out.push(p.note);
  if (p.byHand) out.push(`${p.byHand} record${p.byHand === 1 ? '' : 's'} changed by hand since the rule wrote ${p.byHand === 1 ? 'it' : 'them'}: left as ${p.byHand === 1 ? 'it is' : 'they are'}.`);
  if (p.unworded?.length) {
    const n = p.unworded.length;
    const refs = p.unworded.slice(0, UNWORDED_SHOWN).map((u) => `${u.levelCode ?? '—'} ${u.ref}`).join(', ');
    out.push(`${n} record${n === 1 ? '' : 's'} ${n === 1 ? 'its' : 'their'} rule no longer words, left as ${n === 1 ? 'it is' : 'they are'}: ${refs}${n > UNWORDED_SHOWN ? `, +${n - UNWORDED_SHOWN} more` : ''}.`);
  }
  if (d.action.kind === 'reword') out.push('Each row reads what its rule now words, the rule parameters as they stand.');
  if (d.standing) out.push('Standing: records that match later get this change as a proposal (Accept / Reject on the card or here).');
  out.push('Unticked rows are remembered: this ruling never changes or proposes them.');
  return out;
}
