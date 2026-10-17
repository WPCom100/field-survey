/**
 * Read model of the Lint view (T36, Phase 3 §9): the project's findings grouped by check (PLAN
 * §6.3, `LINT_CHECKS`) or by level, open and — on request — dismissed, the "fix all via ruling"
 * seeds of the vocabulary check (handed to T37), and this iPad's records the server has not
 * numbered (T13 → T36: refused or unnumbered creates; local, never a synced finding), and the rule
 * drafts no device card shows (T100, D209). Reads only; Dismiss / Reopen go through
 * `RuleEngine.dismiss` / `reopen`, a draft's Accept / Edit / Reject through the card's
 * `ProposalDecider`. No React or Expo imports.
 */

import { unnumbered, type Store } from '@field-survey/core';
import { checkOf, checkOrder, rulingSeeds, type RulingSeed } from '@field-survey/rules';

import { cardDraftOf, type CardDraft } from '../card/model';
import { describeSubject, levelCodes } from '../review/model';

type Row = Record<string, unknown>;

export type LintRow = {
  id: string;
  lintId: string;
  checkId: string;
  checkTitle: string;
  hint: string;
  state: 'open' | 'dismissed';
  dismissedReason: string | null;
  levelId: string | null;
  levelCode: string | null;
  /** "06M-02 Relay panel", "Punch #12 Pull missing DMX cable", "Level B2". */
  subject: string;
  message: string;
  /** The device to open the card on (the subject, or the device of the subject record). */
  deviceId: string | null;
  entityKind: string;
  entityId: string;
};

export type LintGroup = {
  key: string;
  title: string;
  hint: string;
  rows: LintRow[];
  /** "Fix all via ruling" seeds (vocabulary check only), largest first. */
  seeds: RulingSeed[];
};

/** A record this iPad holds that the server has not numbered and why (never synced). */
export type LocalRow = { id: string; kind: string; levelCode: string | null; reason: 'refused' | 'unnumbered'; text: string };

/**
 * An open rule draft no device card lists (T100, D209): its subject is a numbering group (R3c's
 * Neuron ID item), a level (R2e's Unison pair) or a punch item with no device (R4b's part). The
 * card shows drafts on a device and its ends only; ruling proposals stay on the Rulings screen.
 */
export type LintDraft = CardDraft & {
  levelId: string | null;
  levelCode: string | null;
  /** "Levels 06/06M", "Level 03", "Punch #12 …". */
  subject: string;
  /** The device the draft writes on (R2e's host NSPS / rack), for its label and Open card. */
  deviceId: string | null;
  /** "03-01 NSPS"; null when the draft names no device. */
  device: string | null;
  /** The finding that points at the same subject (`lint.neuron_item` names the group). */
  findingIds: string[];
};

/** Subjects a device card lists drafts for; anything else is listed in the Lint view. */
const CARD_SUBJECTS = ['device', 'cable_end'];

export type LintView = {
  open: number;
  dismissed: number;
  groups: LintGroup[];
  levels: { id: string; code: string }[];
  local: LocalRow[];
  /** Drafts without a device, in floor order (open view only; filtered by level). */
  drafts: LintDraft[];
};

export type LintQuery = { levelId?: string | null; groupBy?: 'check' | 'level'; dismissed?: boolean };

const LOCAL_TEXT: Record<LocalRow['reason'], string> = {
  refused: 'The server refused its create (it names a record the server does not know). It stays on this iPad until the data is fixed: see Sync.',
  unnumbered: 'The server accepted it but gave it no number (its level has no numbering group or code).',
};

async function subjectLabel(store: Store, kind: string, id: string, codes: ReadonlyMap<string, string>): Promise<{ label: string; levelId: string | null; deviceId: string | null }> {
  if (kind === 'level') return { label: `Level ${codes.get(id) ?? '?'}`, levelId: id, deviceId: null };
  if (kind === 'numbering_group') {
    const levels = await store.list<Row>('level', { where: 'numbering_group_id = ?', params: [id], orderBy: 'floor_order, level' });
    return { label: levels.length ? `Levels ${levels.map((l) => String(l.level)).join('/')}` : 'Numbering group', levelId: null, deviceId: null };
  }
  if (kind === 'cable') {
    const ends = await store.list<Row>('cable_end', { where: 'cable_id = ?', params: [id], orderBy: 'side' });
    const first = ends[0];
    if (first) {
      const d = await describeSubject(store, 'cable_end', String(first.id), codes);
      return { label: `Cable ${d.label}`, levelId: d.levelId, deviceId: d.deviceId };
    }
    return { label: 'Cable', levelId: null, deviceId: null };
  }
  const d = await describeSubject(store, kind, id, codes);
  return { label: d.label, levelId: d.levelId, deviceId: d.deviceId };
}

/** The project's findings for the Lint view. Open ones always; dismissed ones when asked. */
export async function loadLintView(store: Store, projectId: string, q: LintQuery = {}): Promise<LintView> {
  const codes = await levelCodes(store, projectId);
  const found = await store.list<Row>('finding', {
    where: `project_id = ? AND state IN ('open', 'dismissed')`,
    params: [projectId],
    orderBy: 'lint_id, id',
  });
  const all: LintRow[] = [];
  const values = new Map<string, string>();
  for (const f of found) {
    const s = (f.subject && typeof f.subject === 'object' ? f.subject : {}) as Row;
    const kind = typeof s.entity_kind === 'string' ? s.entity_kind : typeof s.entity === 'string' ? s.entity : '';
    const entityId = typeof s.entity_id === 'string' ? s.entity_id : '';
    const d = kind && entityId ? await subjectLabel(store, kind, entityId, codes) : null;
    const levelId = typeof f.level_id === 'string' ? f.level_id : (d?.levelId ?? null);
    const lintId = String(f.lint_id);
    const check = checkOf(lintId);
    if (lintId === 'R3f' && kind === 'punch_item') {
      const p = await store.get<Row>('punch_item', entityId);
      if (typeof p?.item === 'string') values.set(String(f.id), p.item);
    }
    all.push({
      id: String(f.id),
      lintId,
      checkId: check.id,
      checkTitle: check.title,
      hint: check.hint,
      state: f.state === 'dismissed' ? 'dismissed' : 'open',
      dismissedReason: typeof f.dismissed_reason === 'string' ? f.dismissed_reason : null,
      levelId,
      levelCode: levelId ? (codes.get(levelId) ?? null) : null,
      subject: d?.label ?? '—',
      message: typeof f.message === 'string' && f.message.trim() ? f.message.trim() : lintId,
      deviceId: d?.deviceId ?? null,
      entityKind: kind,
      entityId,
    });
  }
  const open = all.filter((r) => r.state === 'open').length;
  const dismissed = all.length - open;
  const used = new Set(all.map((r) => r.levelId).filter(Boolean));
  const levels = [...codes].filter(([id]) => used.has(id)).map(([id, code]) => ({ id, code }));
  const levelOrder = new Map([...codes.keys()].map((id, i) => [id, i] as const));

  const shown = all.filter((r) => (q.dismissed ? r.state === 'dismissed' : r.state === 'open') && (!q.levelId || r.levelId === q.levelId));
  const groups = new Map<string, LintGroup & { order: number }>();
  for (const r of shown) {
    const byLevel = q.groupBy === 'level';
    const key = byLevel ? (r.levelId ?? 'none') : r.checkId;
    let g = groups.get(key);
    if (!g) {
      const check = checkOf(r.lintId);
      g = byLevel
        ? { key, title: r.levelCode ? `Level ${r.levelCode}` : 'No level', hint: '', rows: [], seeds: [], order: r.levelId ? (levelOrder.get(r.levelId) ?? 999) : 1000 }
        : { key, title: check.title, hint: check.hint, rows: [], seeds: [], order: checkOrder(check) };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  const fixOf = async (r: LintRow) => {
    const row = await store.get<Row>('finding', r.id);
    const s = (row?.subject ?? {}) as Row;
    const fix = s.fix as { field?: unknown; from?: unknown; to?: unknown } | undefined;
    return fix && typeof fix.field === 'string' && typeof fix.from === 'string'
      ? { field: fix.field, from: fix.from, to: typeof fix.to === 'string' ? fix.to : null }
      : null;
  };
  for (const g of groups.values()) {
    g.rows.sort((a, b) => (a.levelId ? (levelOrder.get(a.levelId) ?? 999) : 1000) - (b.levelId ? (levelOrder.get(b.levelId) ?? 999) : 1000) || a.subject.localeCompare(b.subject, 'en', { numeric: true }));
    if (q.groupBy !== 'level' && checkOf(g.rows[0]!.lintId).ruling && !q.dismissed) {
      const inputs = [];
      for (const r of g.rows) {
        inputs.push({ findingId: r.id, lintId: r.lintId, entityKind: r.entityKind, entityId: r.entityId, levelId: r.levelId, fix: await fixOf(r), value: values.get(r.id) ?? null });
      }
      g.seeds = rulingSeeds(inputs);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)).map((g): LintGroup => ({ key: g.key, title: g.title, hint: g.hint, rows: g.rows, seeds: g.seeds }));

  const local: LocalRow[] = [];
  for (const u of await unnumbered(store, projectId)) {
    if (u.reason !== 'refused' && u.reason !== 'unnumbered') continue;
    if (q.levelId && u.level_id !== q.levelId) continue;
    local.push({ id: u.id, kind: u.entity_kind.replace(/_/g, ' '), levelCode: u.level_id ? (codes.get(u.level_id) ?? null) : null, reason: u.reason, text: LOCAL_TEXT[u.reason] });
  }
  const drafts = q.dismissed ? [] : await loadDrafts(store, projectId, codes, all, q.levelId ?? null);
  return { open, dismissed, groups: sorted, levels, local, drafts };
}

/** The project's open drafts on a subject no card shows (T100). */
async function loadDrafts(store: Store, projectId: string, codes: ReadonlyMap<string, string>, findings: readonly LintRow[], levelId: string | null): Promise<LintDraft[]> {
  const rows = await store.list<Row>('proposal', {
    where: `project_id = ? AND state = 'proposed' AND rule_id <> 'ruling' AND deleted_at IS NULL AND COALESCE(json_extract(subject, '$.entity_kind'), '') NOT IN (${CARD_SUBJECTS.map(() => '?').join(', ')})`,
    params: [projectId, ...CARD_SUBJECTS],
    orderBy: 'rule_id, id',
  });
  const order = new Map([...codes.keys()].map((id, i) => [id, i] as const));
  const out: LintDraft[] = [];
  for (const p of rows) {
    const s = (p.subject && typeof p.subject === 'object' ? p.subject : {}) as Row;
    const kind = typeof s.entity_kind === 'string' ? s.entity_kind : '';
    const entityId = typeof s.entity_id === 'string' ? s.entity_id : '';
    const d = kind && entityId ? await subjectLabel(store, kind, entityId, codes) : null;
    const lvl = typeof s.level_id === 'string' ? s.level_id : (d?.levelId ?? null);
    if (levelId && lvl !== levelId) continue;
    const draft = cardDraftOf(p);
    const deviceId = typeof draft.payload.device_id === 'string' ? draft.payload.device_id : null;
    out.push({
      ...draft,
      deviceId,
      device: deviceId ? (await describeSubject(store, 'device', deviceId, codes)).label : null,
      levelId: lvl,
      levelCode: lvl ? (codes.get(lvl) ?? null) : null,
      subject: d?.label ?? '—',
      findingIds: findings.filter((f) => f.state === 'open' && f.entityKind === kind && f.entityId === entityId).map((f) => f.id),
    });
  }
  const rank = (d: LintDraft) => (d.levelId ? (order.get(d.levelId) ?? 999) : 1000);
  return out.sort((a, b) => rank(a) - rank(b) || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
}

/** "06M-04 · NSPS without a 120V row" style detail title. */
export function detailTitle(r: LintRow): string {
  return `${r.subject} · ${r.checkTitle}`;
}

/** What "Fix all via ruling" will hand to the ruling editor once T37 lands, in words. */
export function seedSummary(s: RulingSeed, codes: ReadonlyMap<string, string>): string {
  const levels = s.levelIds.map((id) => codes.get(id) ?? '?').join(', ');
  const n = s.recordIds.length;
  return `${s.text} in ${s.field} on ${n} record${n === 1 ? '' : 's'}${levels ? ` (levels ${levels})` : ''}`;
}
