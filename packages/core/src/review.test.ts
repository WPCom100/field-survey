/**
 * Review resolution (T15): one test per resolver choice of PLAN §3.3 (A, B, Combine, value, field
 * group A/B, delete vs edit restore/keep deleted in both directions, links keep/remove), the
 * settle step (loser `rejected`, winning B `superseded`), the `IN REVIEW` state per field and
 * convergence of the losing iPad. Same-field conflicts go through `SyncEngine` + `FakeServer`;
 * the other shapes are delivered by hand exactly as `server/app/sync.py` decides them (the twin
 * harness checks the same flows against the real server).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { Editor, type EditContext } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import {
  IN_REVIEW_BADGE,
  ReviewError,
  choicesFor,
  combineText,
  isInReview,
  openReviewItems,
  reviewFields,
  type Candidate,
  type ReviewItem,
} from './review';
import { Store } from './store';
import { SyncEngine } from './sync';
import { FakeServer } from './testing/fake-server';

const PROJECT = uuidv7();
const LEVEL = uuidv7();
const ANN = uuidv7();
const BOB = uuidv7();
const CAT = uuidv7();
const NAMES: Record<string, string> = { [ANN]: 'Ann', [BOB]: 'Bob', [CAT]: 'Cat' };
const userName = (id: string) => NAMES[id];
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
const SERVER_INSTALL = '00000000-0000-5000-8000-00000000f1e1';

let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

type Row = Record<string, unknown>;

interface Client {
  name: string;
  user: string;
  store: Store;
  editor: Editor;
  engine: SyncEngine;
}

async function client(server: FakeServer | null, user: string): Promise<Client> {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  await store.applyRemote({
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: tsNext(),
    entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
    change_type: 'Master edit', server_seq: 0, server_ts: tsNext(), state: 'applied',
  } as Op);
  const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
  const engine = new SyncEngine(store, server, { log: () => {} });
  return { name: NAMES[user]!, user, store, editor, engine };
}

async function sync(...cs: Client[]): Promise<void> {
  for (const c of cs) expect((await c.engine.sync()).outcome).toBe('ran');
}

const row = (c: Client, kind: Parameters<Store['get']>[0], id: string) => c.store.get<Row>(kind, id);
const state = async (c: Client, opId: string) => (await c.store.getOp(opId))!.state;
const item = async (c: Client, id: string) => (await c.store.get<ReviewItem>('review_item', id))!;

/** Rows equal apart from `version` (local and remote applies count differently on a reviewed field). */
async function expectSameRow(kind: Parameters<Store['get']>[0], id: string, ...cs: Client[]): Promise<void> {
  const strip = (r: Row | null) => (r ? { ...r, version: null } : r);
  const first = strip(await row(cs[0]!, kind, id));
  for (const c of cs.slice(1)) expect(strip(await row(c, kind, id)), `${c.name} ${kind}`).toEqual(first);
}

// ============================================================ same field (FakeServer)

describe('same-field conflict through SyncEngine + FakeServer', () => {
  let server: FakeServer;
  let a: Client;
  let b: Client;
  let c: Client;
  let d: string;
  let bobOp: Op;
  let annOp: Op;
  let itemId: string;

  /** Bob's note arrives first and is official; Ann's goes to review (TP-1 notes). */
  async function conflict(kind: 'device' | 'missing_part' = 'device'): Promise<void> {
    if (kind === 'device') {
      d = (await a.editor.create('device', { level_id: LEVEL, display_id: '06M-02', status: 'Issue', notes: 'as found' }, CTX)).id;
    } else {
      d = (await a.editor.create('missing_part', { level_id: LEVEL, part: 'LVD card', qty: 1 }, CTX)).id;
    }
    await sync(a, b, c);
    const field = kind === 'device' ? 'notes' : 'qty';
    bobOp = (await b.editor.setField(kind, d, field, kind === 'device' ? 'Cover plate loose' : 2, CTX))!;
    annOp = (await a.editor.setField(kind, d, field, kind === 'device' ? 'LVD card missing' : 4, CTX))!;
    await sync(b, a, b, c);
    const items = await openReviewItems(a.store, PROJECT);
    expect(items).toHaveLength(1);
    itemId = items[0]!.id;
    expect(items[0]).toMatchObject({ op_a_id: bobOp.op_id, op_b_id: annOp.op_id });
  }

  beforeEach(async () => {
    server = new FakeServer();
    a = await client(server, ANN);
    b = await client(server, BOB);
    c = await client(server, CAT);
  });

  it('IN REVIEW per field while open; choices are A, B, Combine for free text', async () => {
    await conflict();
    for (const x of [a, b, c]) {
      expect(await reviewFields(x.store, d)).toEqual({ notes: [itemId] });
      expect(await isInReview(x.store, d)).toBe(true);
      expect(await isInReview(x.store, d, 'notes')).toBe(true);
      expect(await isInReview(x.store, d, 'status')).toBe(false);
    }
    expect(IN_REVIEW_BADGE).toBe('IN REVIEW');
    const it_ = await item(a, itemId);
    expect(choicesFor(it_)).toEqual(['A', 'B', 'combine']);
    expect(combineText(it_)).toBe('Cover plate loose; LVD card missing');
  });

  it('A: one Reconcile set re-asserts the official value, the loser is rejected everywhere', async () => {
    await conflict();
    const r = await c.editor.resolve(itemId, { choice: 'A' }, { userName });
    expect(r.reason).toMatch(/^Review: chose A \(Bob \d{4}-\d\d-\d\d \d\d:\d\d\) over B \(Ann \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    expect(r.reconcile).toHaveLength(1);
    expect(r.reconcile[0]).toMatchObject({
      kind: 'set', entity_id: d, field: 'notes', was: 'Cover plate loose', now: 'Cover plate loose',
      base_op_id: bobOp.op_id, change_type: 'Reconcile', reason: r.reason, user_id: CAT,
    });
    // One group: the subject op, then resolution, resolved_by_id, resolved_at, state.
    expect(r.ops.map((o) => [o.entity_kind, o.field])).toEqual([
      ['device', 'notes'], ['review_item', 'resolution'], ['review_item', 'resolved_by_id'],
      ['review_item', 'resolved_at'], ['review_item', 'state'],
    ]);
    expect(new Set(r.ops.map((o) => o.group_id)).size).toBe(1);
    expect(r.ops[0]!.group_id).not.toBeNull();
    expect(r.ops.every((o) => o.change_type === 'Reconcile')).toBe(true);
    expect(r.resolution).toMatchObject({ choice: 'A', rejected_op_ids: [annOp.op_id], superseded_op_ids: [], reconcile_op_ids: [r.reconcile[0]!.op_id] });

    expect(await state(c, annOp.op_id)).toBe('rejected'); // settled on the resolver's iPad at once
    expect(await state(a, annOp.op_id)).toBe('review');
    await sync(c, a, b);
    for (const x of [a, b, c]) {
      expect(await item(x, itemId)).toMatchObject({ state: 'resolved', resolved_by_id: CAT });
      expect(await state(x, annOp.op_id)).toBe('rejected');
      expect(await state(x, bobOp.op_id)).toBe('applied');
      expect((await row(x, 'device', d))!.notes).toBe('Cover plate loose');
      expect(await reviewFields(x.store, d)).toEqual({});
    }
    expect(server.head(d, 'notes')!.op_id).toBe(r.reconcile[0]!.op_id);
    await expectSameRow('device', d, a, b, c);
    await expectSameRow('review_item', itemId, a, b, c);
  });

  it('B on the losing iPad itself: based on the official head, the reviewed op becomes superseded', async () => {
    await conflict();
    const r = await a.editor.resolve(itemId, { choice: 'B' }, { userName });
    expect(r.reason).toMatch(/^Review: chose B \(Ann .*\) over A \(Bob .*\)$/);
    expect(r.reconcile[0]).toMatchObject({ field: 'notes', now: 'LVD card missing', base_op_id: bobOp.op_id });
    expect(r.resolution).toMatchObject({ choice: 'B', rejected_op_ids: [], superseded_op_ids: [annOp.op_id] });
    await sync(a, b, c);
    for (const x of [a, b, c]) {
      expect((await row(x, 'device', d))!.notes).toBe('LVD card missing');
      expect(await state(x, annOp.op_id)).toBe('superseded');
    }
    // The server applied the Reconcile op on its head (no second review).
    expect(server.ops().filter((o) => o.state === 'review').map((o) => o.op_id)).toEqual([annOp.op_id]);
    await expectSameRow('device', d, a, b, c);
  });

  it('Combine: pre-filled "A; B", or an edited text', async () => {
    await conflict();
    const r = await b.editor.resolve(itemId, { choice: 'combine' }, { userName });
    expect(r.reason).toMatch(/^Review: combined A \(Bob .*\) and B \(Ann .*\)$/);
    expect(r.reconcile[0]).toMatchObject({ now: 'Cover plate loose; LVD card missing', base_op_id: bobOp.op_id });
    expect(r.resolution).toMatchObject({ choice: 'combine', value: 'Cover plate loose; LVD card missing', rejected_op_ids: [annOp.op_id] });
    await sync(b, a, c);
    for (const x of [a, b, c]) expect((await row(x, 'device', d))!.notes).toBe('Cover plate loose; LVD card missing');
    await expectSameRow('device', d, a, b, c);
  });

  it('Combine with an edited text', async () => {
    await conflict();
    const r = await b.editor.resolve(itemId, { choice: 'combine', text: 'Cover plate loose; LVD card missing (both seen)' });
    await sync(b, a);
    expect((await row(a, 'device', d))!.notes).toBe('Cover plate loose; LVD card missing (both seen)');
    expect(r.resolution.value).toBe('Cover plate loose; LVD card missing (both seen)');
    await expect(b.editor.resolve(uuidv7(), { choice: 'A' })).rejects.toThrow(ReviewError);
  });

  it('without names the reason tells users apart by the tail of their id', async () => {
    await conflict();
    const r = await c.editor.resolve(itemId, { choice: 'A' });
    expect(r.reason).toContain(`A (user …${BOB.slice(-6)} `);
    expect(r.reason).toContain(`B (user …${ANN.slice(-6)} `);
  });

  it('value: a number field takes a typed value; A/B/value are its choices', async () => {
    await conflict('missing_part');
    const it_ = await item(c, itemId);
    expect(choicesFor(it_)).toEqual(['A', 'B', 'value']);
    await expect(c.editor.resolve(itemId, { choice: 'combine' })).rejects.toThrow(/not a choice/);
    await expect(c.editor.resolve(itemId, { choice: 'value', value: Number.NaN })).rejects.toThrow(/needs a number/);
    const r = await c.editor.resolve(itemId, { choice: 'value', value: 3 }, { userName });
    expect(r.reason).toMatch(/^Review: set 3 over A \(Bob .*\) and B \(Ann .*\)$/);
    expect(r.reconcile[0]).toMatchObject({ field: 'qty', was: 2, now: 3 });
    expect(r.resolution).toMatchObject({ choice: 'value', value: 3, rejected_op_ids: [annOp.op_id] });
    await sync(c, a, b);
    for (const x of [a, b, c]) {
      expect((await row(x, 'missing_part', d))!.qty).toBe(3);
      expect(await state(x, annOp.op_id)).toBe('rejected');
    }
  });

  it('an enum is A/B only; a resolved item cannot be resolved again', async () => {
    d = (await a.editor.create('device', { level_id: LEVEL, status: 'Issue' }, CTX)).id;
    await sync(a, b);
    await b.editor.setField('device', d, 'status', 'No access', CTX);
    await a.editor.setField('device', d, 'status', 'Not installed', CTX);
    await sync(b, a, b);
    const [it_] = await openReviewItems(b.store, PROJECT);
    expect(choicesFor(it_!)).toEqual(['A', 'B']);
    await expect(b.editor.resolve(it_!.id, { choice: 'value', value: 1 })).rejects.toThrow(ReviewError);
    await b.editor.resolve(it_!.id, { choice: 'A' });
    await expect(b.editor.resolve(it_!.id, { choice: 'B' })).rejects.toThrow(/already resolved/);
    expect(await openReviewItems(b.store, PROJECT)).toEqual([]);
  });
});

// ================================================== other shapes, delivered by hand

/**
 * A minimal stand-in for the server's verdicts: ops are stamped with the next `server_seq` and
 * delivered (echo to the pusher, pull to the others) in the order the test gives.
 */
class Hand {
  seq = 0;

  async deliver(ops: Op[], state: Op['state'], to: Client[]): Promise<Op[]> {
    const out = ops.map((o) => ({ ...o, server_seq: ++this.seq, server_ts: tsNext(), state }));
    for (const c of to) await c.store.applyRemoteMany(out);
    return out;
  }

  /** The `review_item(sync_conflict)` create op the server emits (`Push.review`). */
  async reviewItem(cause: Op, a: Op[], b: Op[], fields: string[], to: Client[], extraSubject: Row = {}): Promise<string> {
    const id = uuidv7();
    const subject: Row = { entity_kind: b[0]!.entity_kind, entity_id: b[0]!.entity_id, field: fields[0], ...extraSubject };
    if (b.length > 1) Object.assign(subject, { group_id: b[0]!.group_id, fields });
    const op: Op = {
      op_id: uuidv7(), project_id: PROJECT, user_id: cause.user_id, install_id: SERVER_INSTALL, client_ts: tsNext(),
      entity_kind: 'review_item', entity_id: id, kind: 'create', base_op_id: cause.op_id, change_type: cause.change_type,
      reason: 'Sync conflict', group_id: null,
      payload: {
        id, project_id: PROJECT, level_id: LEVEL, kind: 'sync_conflict', subject,
        op_a_id: a[0]?.op_id ?? null, op_b_id: b[0]!.op_id,
        candidates: [...a.map((o) => cand('A', o)), ...b.map((o) => cand('B', o))],
        ruling: false, state: 'open',
      },
    };
    await this.deliver([op], 'applied', to);
    return id;
  }
}

function fieldOf(o: Op): string {
  if (o.kind === 'delete' || o.kind === 'restore') return 'deleted_at';
  if (o.kind === 'link_add' || o.kind === 'link_remove') return `link:${JSON.stringify(o.payload)}`;
  return o.field!;
}

function cand(side: 'A' | 'B', o: Op): Candidate {
  const field = fieldOf(o);
  const value =
    o.kind === 'delete' ? true : o.kind === 'restore' ? false : o.kind.startsWith('link') ? o.payload : o.kind === 'create' ? (o.payload ?? {})[field] : o.now;
  return {
    side, op_id: o.op_id, user_id: o.user_id, install_id: o.install_id, client_ts: o.client_ts,
    entity_kind: o.entity_kind, entity_id: o.entity_id, field, kind: o.kind, value: value ?? null,
  };
}

describe('delete vs edit (PLAN §3.3: restore / keep deleted)', () => {
  let h: Hand;
  let a: Client;
  let b: Client;
  let d: string;
  let create: Op;

  beforeEach(async () => {
    h = new Hand();
    a = await client(null, ANN);
    b = await client(null, BOB);
    const made = await a.editor.create('device', { level_id: LEVEL, display_id: '06M-02', notes: 'as found' }, CTX);
    d = made.id;
    create = (await h.deliver([made.op], 'applied', [a, b]))[0]!;
  });

  /** TP-11 (1): Bob's edit arrived first; Ann's delete is in review. Ann's row stays deleted. */
  async function editFirst(): Promise<{ del: Op; edit: Op; itemId: string }> {
    const del = await a.editor.delete('device', d, { ...CTX, reason: 'Duplicate of 06M-01' });
    const edit = (await b.editor.setField('device', d, 'notes', 'Neuron ID read', CTX))!;
    await h.deliver([edit], 'applied', [b, a]);
    await h.deliver([del], 'review', [a, b]);
    const itemId = await h.reviewItem(del, [edit], [del], ['deleted_at'], [a, b]);
    expect((await row(a, 'device', d))!.deleted_at).not.toBeNull();
    expect((await row(b, 'device', d))!.deleted_at).toBeNull();
    return { del, edit, itemId };
  }

  /** TP-11 (2): Ann's delete arrived first; Bob's edit is in review. Bob keeps his note. */
  async function deleteFirst(): Promise<{ del: Op; edit: Op; itemId: string }> {
    const del = await a.editor.delete('device', d, { ...CTX, reason: 'Duplicate of 06M-01' });
    const edit = (await b.editor.setField('device', d, 'notes', 'Neuron ID read', CTX))!;
    await h.deliver([del], 'applied', [a, b]);
    await h.deliver([edit], 'review', [b, a]);
    const itemId = await h.reviewItem(edit, [del], [edit], ['notes'], [a, b]);
    expect((await row(b, 'device', d))!.notes).toBe('Neuron ID read');
    expect((await row(a, 'device', d))!.notes).toBe('as found');
    return { del, edit, itemId };
  }

  it('IN REVIEW marks both the edited field and deleted_at', async () => {
    const { itemId } = await editFirst();
    expect(await reviewFields(a.store, d)).toEqual({ deleted_at: [itemId], notes: [itemId] });
    expect(choicesFor(await item(a, itemId))).toEqual(['A', 'B']);
  });

  it('edit first, A (restore): a Reconcile restore brings the deleting iPad back', async () => {
    const { del, itemId } = await editFirst();
    const r = await b.editor.resolve(itemId, { choice: 'A' }, { userName });
    expect(r.reconcile.map((o) => [o.kind, o.base_op_id])).toEqual([['restore', null]]);
    expect(r.reason).toMatch(/^Review: chose A \(Bob .*\) over B \(Ann .*\)$/);
    await h.deliver(r.ops, 'applied', [b, a]);
    for (const x of [a, b]) {
      expect(await row(x, 'device', d)).toMatchObject({ deleted_at: null, notes: 'Neuron ID read' });
      expect(await state(x, del.op_id)).toBe('rejected');
    }
    await expectSameRow('device', d, a, b);
  });

  it('edit first, B (keep deleted): a Reconcile delete on the official head', async () => {
    const { del, itemId } = await editFirst();
    // Ann's own reviewed delete is her local head; the base is the official one (none).
    expect(await a.store.fieldHead(d, 'deleted_at')).toBe(del.op_id);
    const r = await a.editor.resolve(itemId, { choice: 'B' });
    expect(r.reconcile.map((o) => [o.kind, o.base_op_id])).toEqual([['delete', null]]);
    const [delivered] = await h.deliver(r.ops, 'applied', [a, b]);
    for (const x of [a, b]) {
      // `deleted_at` is the server's timestamp on both iPads (re-stamped from the echo on Ann's).
      expect(await row(x, 'device', d)).toMatchObject({ deleted_at: delivered!.server_ts, deleted_by_id: ANN });
      expect(await state(x, del.op_id)).toBe('superseded');
    }
    await expectSameRow('device', d, a, b);
  });

  it('delete first, A (keep deleted): the in-review note goes back to the official value on the editing iPad', async () => {
    const { edit, itemId } = await deleteFirst();
    // Bob's local head on notes is his reviewed op; the Reconcile set bases on the create.
    expect(await b.store.fieldHead(d, 'notes')).toBe(edit.op_id);
    const r = await b.editor.resolve(itemId, { choice: 'A' });
    expect(r.reconcile.map((o) => [o.kind, o.field, o.now, o.base_op_id])).toEqual([['set', 'notes', 'as found', create.op_id]]);
    await h.deliver(r.ops, 'applied', [b, a]);
    for (const x of [a, b]) {
      expect((await row(x, 'device', d))!.notes).toBe('as found');
      expect((await row(x, 'device', d))!.deleted_at).not.toBeNull();
      expect(await state(x, edit.op_id)).toBe('rejected');
    }
    await expectSameRow('device', d, a, b);
  });

  it('delete first, B (restore with the edit): restore then set, one group', async () => {
    const { del, edit, itemId } = await deleteFirst();
    const r = await a.editor.resolve(itemId, { choice: 'B' });
    expect(r.reconcile.map((o) => [o.kind, o.field, o.base_op_id])).toEqual([
      ['restore', null, del.op_id],
      ['set', 'notes', create.op_id],
    ]);
    expect(r.reconcile[1]!.now).toBe('Neuron ID read');
    await h.deliver(r.ops, 'applied', [a, b]);
    for (const x of [a, b]) {
      expect(await row(x, 'device', d)).toMatchObject({ deleted_at: null, notes: 'Neuron ID read' });
      expect(await state(x, edit.op_id)).toBe('superseded');
    }
    await expectSameRow('device', d, a, b);
  });
});

describe('field group (Tracking status + Date closed) is resolved as one', () => {
  let h: Hand;
  let a: Client;
  let b: Client;
  let p: string;
  let bobOp: Op;
  let annOps: Op[];
  let itemId: string;

  beforeEach(async () => {
    h = new Hand();
    a = await client(null, ANN);
    b = await client(null, BOB);
    const made = await a.editor.create('punch_item', { level_id: LEVEL, item: 'Run X', type: 'Cable not run', tracking_status: 'Open' }, CTX);
    p = made.id;
    await h.deliver([made.op], 'applied', [a, b]);
    bobOp = (await b.editor.setField('punch_item', p, 'tracking_status', 'In progress', CTX))!;
    annOps = await a.editor.setFields('punch_item', p, { tracking_status: 'Closed', date_closed: '2026-10-10' }, CTX);
    await h.deliver([bobOp], 'applied', [b, a]);
    // Server: the group conflicts on tracking_status; both members go to review under one item.
    await h.deliver(annOps, 'review', [a, b]);
    itemId = await h.reviewItem(annOps[0]!, [bobOp], annOps, ['tracking_status', 'date_closed'], [a, b]);
  });

  it('IN REVIEW on both fields; A/B only', async () => {
    expect(await reviewFields(b.store, p)).toEqual({ tracking_status: [itemId], date_closed: [itemId] });
    expect(choicesFor(await item(b, itemId))).toEqual(['A', 'B']);
    await expect(b.editor.resolve(itemId, { choice: 'combine' })).rejects.toThrow(/not a choice/);
  });

  it('A: both fields back to the official values on the losing iPad; both members rejected', async () => {
    expect(await row(a, 'punch_item', p)).toMatchObject({ tracking_status: 'In progress', date_closed: '2026-10-10' });
    const r = await b.editor.resolve(itemId, { choice: 'A' });
    expect(r.reconcile.map((o) => [o.field, o.now])).toEqual([['tracking_status', 'In progress'], ['date_closed', null]]);
    expect(r.resolution.rejected_op_ids).toEqual(annOps.map((o) => o.op_id));
    await h.deliver(r.ops, 'applied', [b, a]);
    expect(await row(a, 'punch_item', p)).toMatchObject({ tracking_status: 'In progress', date_closed: null });
    for (const o of annOps) for (const x of [a, b]) expect(await state(x, o.op_id)).toBe('rejected');
    await expectSameRow('punch_item', p, a, b);
  });

  it('B: both of the reviewed values, superseded', async () => {
    const r = await b.editor.resolve(itemId, { choice: 'B' });
    expect(r.reconcile.map((o) => [o.field, o.now])).toEqual([['tracking_status', 'Closed'], ['date_closed', '2026-10-10']]);
    expect(r.reconcile[0]!.base_op_id).toBe(bobOp.op_id);
    await h.deliver(r.ops, 'applied', [b, a]);
    for (const x of [a, b]) {
      expect(await row(x, 'punch_item', p)).toMatchObject({ tracking_status: 'Closed', date_closed: '2026-10-10' });
      for (const o of annOps) expect(await state(x, o.op_id)).toBe('superseded');
    }
    await expectSameRow('punch_item', p, a, b);
  });
});

describe('links: remove vs newer add (keep / remove)', () => {
  let h: Hand;
  let a: Client;
  let b: Client;
  let add: Op;
  let remove: Op;
  let itemId: string;
  const key = { user_id: CAT };

  beforeEach(async () => {
    h = new Hand();
    a = await client(null, ANN);
    b = await client(null, BOB);
    const first = await a.editor.link('assignment', LEVEL, key, CTX);
    await h.deliver([first], 'applied', [a, b]);
    // Ann removes Cat's assignment offline; Bob, unseen by her, re-adds it with a new assigner.
    remove = await a.editor.unlink('assignment', LEVEL, key, CTX);
    add = await b.editor.link('assignment', LEVEL, { ...key, assigned_by_id: BOB }, CTX);
    await h.deliver([add], 'applied', [b, a]);
    await h.deliver([remove], 'review', [a, b]);
    itemId = await h.reviewItem(remove, [add], [remove], [fieldOf(remove)], [a, b]);
  });

  const live = async (c: Client) => (await c.store.list<Row>('assignment')).map((r) => r.user_id);

  it('A (keep): a Reconcile link_add revives the link on the removing iPad', async () => {
    // Bob's add was pulled after Ann's remove, so Ann's iPad already shows it; the add re-asserts it.
    const r = await b.editor.resolve(itemId, { choice: 'A' });
    expect(r.reconcile.map((o) => [o.kind, o.payload])).toEqual([['link_add', { user_id: CAT, assigned_by_id: BOB }]]);
    await h.deliver(r.ops, 'applied', [b, a]);
    for (const x of [a, b]) {
      expect(await live(x)).toEqual([CAT]);
      expect(await state(x, remove.op_id)).toBe('rejected');
    }
  });

  it('B (remove): a Reconcile link_remove', async () => {
    const r = await a.editor.resolve(itemId, { choice: 'B' });
    expect(r.reconcile.map((o) => [o.kind, o.payload])).toEqual([['link_remove', key]]);
    await h.deliver(r.ops, 'applied', [a, b]);
    for (const x of [a, b]) {
      expect(await live(x)).toEqual([]);
      expect(await state(x, remove.op_id)).toBe('superseded');
    }
  });
});
