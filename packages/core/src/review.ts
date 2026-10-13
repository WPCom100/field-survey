/**
 * Review resolution (T15, PLAN §3.3, D90, D91). A `review_item(sync_conflict)` reaches every iPad
 * as a server `create` op (D84). Resolving it is ordinary ops, built here and applied through
 * the `Editor` as one group:
 *
 * 1. the `Reconcile` op(s) on the subject: the chosen value re-asserted as a `set` (written even
 *    when the resolver's own row already shows it, so the iPad that lost converges on pull),
 *    or the `delete`/`restore`/`link_add`/`link_remove` the choice implies;
 * 2. `set`s on the item: `resolution`, `resolved_by_id`, `resolved_at`, then `state = resolved`.
 *
 * Materialising `state = resolved` settles the ops the item held (store and server alike): the
 * loser `rejected`; a winning side B `superseded`, since its value now lives in the Reconcile op.
 *
 * Side A is the official head (first arrived), side B the op(s) that went to review. Choices:
 * `A` keeps the official value, `B` takes the reviewed one, `combine` (free text) writes
 * "A; B" or an edited text, `value` (numbers) writes a typed value. A field group (one item,
 * several B ops) is resolved as one with `A` or `B`.
 */

import type { EditBatch, Editor } from './editor';
import type { Op, StoredOp } from './op';
import { entity, isOpTarget, type EntityKind } from './schema/entities';
import type { Store } from './store';

export const IN_REVIEW_BADGE = 'IN REVIEW';

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** One side of a conflict as the server records it (`server/app/sync.py` `candidate`). */
export interface Candidate {
  side: 'A' | 'B';
  op_id: string;
  user_id: string;
  install_id: string;
  client_ts: string;
  entity_kind: EntityKind;
  entity_id: string;
  /** Column name, `deleted_at` for delete/restore, `link:{…}` for link ops. */
  field: string;
  kind: Op['kind'];
  /** The value the op gives `field`; `true`/`false` for delete/restore; the payload for links. */
  value: unknown;
}

export interface ReviewSubject {
  entity_kind: EntityKind;
  entity_id: string;
  field: string;
  group_id?: string;
  fields?: string[];
  level_id?: string;
}

export interface ReviewItem {
  id: string;
  project_id: string;
  level_id: string | null;
  kind: string;
  subject: ReviewSubject;
  op_a_id: string | null;
  op_b_id: string | null;
  candidates: Candidate[];
  ruling: boolean;
  state: 'open' | 'resolved' | 'dismissed';
  resolved_by_id: string | null;
  resolved_at: string | null;
  resolution: Resolution | null;
  deleted_at: string | null;
}

export type ResolveChoice =
  | { choice: 'A' }
  | { choice: 'B' }
  /** Free text only; `text` defaults to "A; B" (`combineText`). */
  | { choice: 'combine'; text?: string }
  /** Numbers only. */
  | { choice: 'value'; value: number };

export type ChoiceName = ResolveChoice['choice'];

/** Stored in `review_item.resolution`; the settle step reads the two op lists. */
export interface Resolution {
  /** `link`: a punch item linked to its device from Needs review (T81, `./punch`). */
  choice: ChoiceName | 'link';
  value?: unknown;
  reason: string;
  reconcile_op_ids: string[];
  rejected_op_ids: string[];
  superseded_op_ids: string[];
}

export interface ResolveOptions {
  /**
   * Display name for a user id in the auto-filled reason; default: `app_user.name`, else
   * "user …<last 6 of the id>". `app_user` rows are not synced to the iPad yet, so screens pass
   * the team list here (T26).
   */
  userName?: (userId: string) => string | null | undefined;
  /** Clock for `resolved_at`; tests inject one. */
  now?: () => string;
}

export interface ResolveResult {
  item_id: string;
  reason: string;
  resolution: Resolution;
  /** The Reconcile ops on the subject. */
  reconcile: Op[];
  /** Every op applied, in order (Reconcile ops, then the item's fields). */
  ops: Op[];
}

// ------------------------------------------------------------------- reading

export async function getReviewItem(store: Store, itemId: string): Promise<ReviewItem | null> {
  return store.get<ReviewItem>('review_item', itemId);
}

/** Open items of a project (or every project), oldest first. D90: one item per conflicting op. */
export async function openReviewItems(store: Store, projectId?: string): Promise<ReviewItem[]> {
  return store.list<ReviewItem>('review_item', {
    where: `state = 'open'` + (projectId ? ` AND project_id = ?` : ''),
    params: projectId ? [projectId] : [],
    orderBy: 'id',
  });
}

/** Fields an item touches: the subject field(s) plus every candidate's field. */
export function reviewItemFields(item: Pick<ReviewItem, 'subject' | 'candidates'>): string[] {
  const out = new Set<string>(item.subject.fields ?? [item.subject.field]);
  for (const c of item.candidates ?? []) {
    if (c.entity_id === item.subject.entity_id) out.add(c.field);
  }
  return [...out];
}

/**
 * The `IN REVIEW` state of one record, per field: field → open item ids (PLAN §5 record badges).
 * A delete-vs-edit item marks both the edited field and `deleted_at`.
 */
export async function reviewFields(store: Store, entityId: string): Promise<Record<string, string[]>> {
  const items = await store.list<ReviewItem>('review_item', {
    where: `state = 'open' AND json_extract(subject, '$.entity_id') = ?`,
    params: [entityId],
    orderBy: 'id',
  });
  const out: Record<string, string[]> = {};
  for (const item of items) {
    for (const f of reviewItemFields(item)) (out[f] ??= []).push(item.id);
  }
  return out;
}

/** True when the record (or, with `field`, that field) has an open review item. */
export async function isInReview(store: Store, entityId: string, field?: string): Promise<boolean> {
  const fields = await reviewFields(store, entityId);
  return field === undefined ? Object.keys(fields).length > 0 : (fields[field]?.length ?? 0) > 0;
}

export function sideOf(item: Pick<ReviewItem, 'candidates'>, side: 'A' | 'B'): Candidate[] {
  return (item.candidates ?? []).filter((c) => c.side === side);
}

/** The pre-filled Combine text (PLAN §3.3): "A; B". */
export function combineText(item: Pick<ReviewItem, 'candidates'>): string {
  const a = sideOf(item, 'A')[0]?.value;
  const b = sideOf(item, 'B')[0]?.value;
  return [a, b].filter((v) => v != null && String(v).trim() !== '').map(String).join('; ');
}

/**
 * Choices the item allows (PLAN §3.3): A and B always; `combine` for one free-text field
 * (not an enum, not an id); `value` for one number field. Field groups, pins, Neuron IDs,
 * links and delete/restore are A/B only.
 */
export function choicesFor(item: Pick<ReviewItem, 'subject' | 'candidates'>): ChoiceName[] {
  const out: ChoiceName[] = ['A', 'B'];
  const b = sideOf(item, 'B');
  const a = sideOf(item, 'A');
  if (b.length !== 1 || b[0]!.kind !== 'set' || (item.subject.fields?.length ?? 1) > 1) return out;
  if (a.length > 0 && (a[0]!.field !== b[0]!.field || !['set', 'create', 'assign'].includes(a[0]!.kind))) {
    return out;
  }
  if (!isOpTarget(item.subject.entity_kind)) return out;
  const col = entity(item.subject.entity_kind).columns[b[0]!.field];
  if (!col) return out;
  if (col.type === 'text' && !col.check && !b[0]!.field.endsWith('_id')) out.push('combine');
  if (col.type === 'int' || col.type === 'real') out.push('value');
  return out;
}

// ------------------------------------------------------------------ official

function touches(op: StoredOp, field: string): boolean {
  if (field === 'deleted_at') return op.kind === 'delete' || op.kind === 'restore';
  if (op.kind === 'set' || op.kind === 'assign') return op.field === field;
  if (op.kind === 'create') return op.payload != null && field in op.payload;
  return false;
}

/**
 * The op that gives `field` its official value as this iPad knows it. Normally `field_head`;
 * on the iPad whose own op went to review the head is that op, so the latest applied op on
 * the field is used instead (that is the server's head, D81/A7).
 */
export async function officialHead(store: Store, entityId: string, field: string): Promise<StoredOp | null> {
  const headId = await store.fieldHead(entityId, field);
  if (headId) {
    const head = await store.getOp(headId);
    if (head && (head.state === 'applied' || head.state === 'pending')) return head;
  }
  let best: StoredOp | null = null;
  for (const op of await store.opsFor(entityId)) {
    if (op.state === 'applied' && touches(op, field)) best = op;
  }
  return best;
}

function valueOf(op: StoredOp | null, field: string): unknown {
  if (!op) return null;
  if (op.kind === 'create') return (op.payload ?? {})[field] ?? null;
  if (op.kind === 'set' || op.kind === 'assign') return op.now ?? null;
  return null;
}

async function officiallyDeleted(store: Store, entityId: string): Promise<{ deleted: boolean; head: StoredOp | null }> {
  const head = await officialHead(store, entityId, 'deleted_at');
  return { deleted: head?.kind === 'delete', head };
}

// ------------------------------------------------------------------- resolve

function stamp(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

async function nameOf(store: Store, opts: ResolveOptions, userId: string): Promise<string> {
  const given = opts.userName?.(userId);
  if (given) return given;
  const row = await store.get<{ name: string }>('app_user', userId);
  // UUID v7 ids share their leading timestamp; the tail tells two users apart.
  return row?.name ?? `user …${userId.slice(-6)}`;
}

async function who(store: Store, opts: ResolveOptions, c: Candidate | undefined): Promise<string> {
  if (!c) return 'official value';
  return `${await nameOf(store, opts, c.user_id)} ${stamp(c.client_ts)}`;
}

/** "Review: chose A (Bob 2026-10-10 14:03) over B (Ann 2026-10-10 14:05)" (PLAN §3.3). */
export async function resolutionReason(
  store: Store,
  item: Pick<ReviewItem, 'candidates'>,
  choice: ResolveChoice,
  opts: ResolveOptions = {},
): Promise<string> {
  const a = `A (${await who(store, opts, sideOf(item, 'A')[0])})`;
  const b = `B (${await who(store, opts, sideOf(item, 'B')[0])})`;
  switch (choice.choice) {
    case 'A':
      return `Review: chose ${a} over ${b}`;
    case 'B':
      return `Review: chose ${b} over ${a}`;
    case 'combine':
      return `Review: combined ${a} and ${b}`;
    case 'value':
      return `Review: set ${JSON.stringify(choice.value)} over ${a} and ${b}`;
  }
}

function linkKey(c: Candidate): Record<string, unknown> {
  return { ...((c.value as Record<string, unknown> | null) ?? {}) };
}

/** Build the Reconcile ops for one B candidate into the batch. */
async function reconcileOne(
  store: Store,
  g: EditBatch,
  item: ReviewItem,
  b: Candidate,
  choice: ResolveChoice,
): Promise<void> {
  const kind = b.entity_kind;
  const id = b.entity_id;
  const takeB = choice.choice !== 'A';
  switch (b.kind) {
    case 'set': {
      let value: unknown;
      if (choice.choice === 'A') value = valueOf(await officialHead(store, id, b.field), b.field);
      else if (choice.choice === 'B') value = b.value;
      else if (choice.choice === 'combine') value = choice.text ?? combineText(item);
      else value = choice.value;
      if (takeB) {
        // Taking an edit made on a record someone else deleted restores it first (PLAN §3.3).
        const del = await officiallyDeleted(store, id);
        const restored = g.ops.some((o) => o.entity_id === id && o.kind === 'restore');
        if (del.deleted && !restored) await g.reconcileDeleted(kind, id, false, del.head?.op_id ?? null);
      }
      const head = await officialHead(store, id, b.field);
      await g.reconcileSet(kind, id, b.field, value, head?.op_id ?? null);
      return;
    }
    case 'delete':
    case 'restore': {
      const del = await officiallyDeleted(store, id);
      const wantDeleted = takeB ? b.kind === 'delete' : del.deleted;
      await g.reconcileDeleted(kind, id, wantDeleted, del.head?.op_id ?? null);
      return;
    }
    case 'link_remove': {
      if (takeB) {
        await g.unlink(kind, id, linkKey(b));
      } else {
        const a = sideOf(item, 'A').find((c) => c.kind === 'link_add' && c.entity_id === id);
        await g.link(kind, id, a ? linkKey(a) : linkKey(b));
      }
      return;
    }
    default:
      throw new ReviewError(`a ${b.kind} op is never reviewed; cannot reconcile it`);
  }
}

/**
 * Resolve one review item (D90: each item on its own). Builds and applies, as one group with
 * `change_type = Reconcile` and the auto-filled reason, the Reconcile op(s) on the subject and
 * the item's `resolution` / `resolved_by_id` / `resolved_at` / `state`.
 */
export async function resolveReview(
  editor: Editor,
  itemId: string,
  choice: ResolveChoice,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const store = editor.store;
  const item = await getReviewItem(store, itemId);
  if (!item || item.deleted_at) throw new ReviewError(`Unknown review item ${itemId}`);
  if (item.kind !== 'sync_conflict') throw new ReviewError(`${item.kind} items are not resolved with resolve()`);
  if (item.state !== 'open') throw new ReviewError(`Review item ${itemId} is already ${item.state}`);
  const allowed = choicesFor(item);
  if (!allowed.includes(choice.choice)) {
    throw new ReviewError(`${choice.choice} is not a choice for this item (allowed: ${allowed.join(', ')})`);
  }
  if (choice.choice === 'value' && (typeof choice.value !== 'number' || !Number.isFinite(choice.value))) {
    throw new ReviewError('value needs a number');
  }
  if (choice.choice === 'combine' && choice.text !== undefined && choice.text.trim() === '') {
    throw new ReviewError('combine needs a non-empty text');
  }
  const bSide = sideOf(item, 'B');
  if (bSide.length === 0) throw new ReviewError(`Review item ${itemId} has no side B`);

  const reason = await resolutionReason(store, item, choice, opts);
  const bIds = bSide.map((c) => c.op_id);
  const reconcile: Op[] = [];
  let resolution: Resolution | null = null;
  const ops = await editor.group({ change_type: 'Reconcile', reason }, async (g) => {
    for (const b of bSide) await reconcileOne(store, g, item, b, choice);
    reconcile.push(...g.ops);
    resolution = {
      choice: choice.choice,
      ...(choice.choice === 'combine' ? { value: reconcile[reconcile.length - 1]?.now } : {}),
      ...(choice.choice === 'value' ? { value: choice.value } : {}),
      reason,
      reconcile_op_ids: reconcile.map((o) => o.op_id),
      rejected_op_ids: choice.choice === 'B' ? [] : bIds,
      superseded_op_ids: choice.choice === 'B' ? bIds : [],
    };
    await g.reconcileSet('review_item', itemId, 'resolution', resolution, await headId(store, itemId, 'resolution'));
    await g.reconcileSet('review_item', itemId, 'resolved_by_id', editor.userId, await headId(store, itemId, 'resolved_by_id'));
    await g.reconcileSet(
      'review_item',
      itemId,
      'resolved_at',
      (opts.now ?? (() => new Date().toISOString()))(),
      await headId(store, itemId, 'resolved_at'),
    );
    await g.reconcileSet('review_item', itemId, 'state', 'resolved', await headId(store, itemId, 'state'));
  });
  return { item_id: itemId, reason, resolution: resolution!, reconcile, ops };
}

async function headId(store: Store, entityId: string, field: string): Promise<string | null> {
  return (await officialHead(store, entityId, field))?.op_id ?? null;
}
