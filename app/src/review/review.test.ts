/**
 * Needs review read model (T26): list by kind/level/sort, the A/B panel (who/when/install, was,
 * choices, Combine pre-filled), field groups as pairs, pin conflicts for the plan, and the
 * badges clearing on the other iPads once the resolution is pulled. Conflicts are made through
 * `SyncEngine` + `FakeServer`; the field group is delivered by hand as `server/app/sync.py`
 * decides it (the same shape as core's `review.test.ts`).
 */

import { Editor, Store, SyncEngine, isInReview, openReviewItems, reviewFields, uuidv7, type EditContext, type Op, type ReviewItem } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadLevelPlan } from '../plan/data';
import { fieldLabel, formatValue, loadPinConflict, loadReviewDetail, loadReviewList, shortStamp, uuidTime } from './model';

const PROJECT = uuidv7();
const PROJECT_OP = uuidv7();
const ANN = uuidv7();
const BOB = uuidv7();
const CAT = uuidv7();
const NAMES = new Map([
  [ANN, 'Ann'],
  [BOB, 'Bob'],
  [CAT, 'Cat'],
]);
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 60_000)).toISOString();

type Client = { store: Store; editor: Editor; engine: SyncEngine };

async function client(server: FakeServer | null, user: string): Promise<Client> {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  await store.applyRemote({
    op_id: PROJECT_OP, project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: '2026-10-01T00:00:00.000Z',
    entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
    change_type: 'Master edit', server_seq: 0, server_ts: '2026-10-01T00:00:00.000Z', state: 'applied',
  } as Op);
  const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
  return { store, editor, engine: new SyncEngine(store, server, { log: () => {} }) };
}
async function sync(...cs: Client[]): Promise<void> {
  for (const c of cs) expect((await c.engine.sync()).outcome).toBe('ran');
}

describe('Needs review over a same-field conflict', () => {
  let server: FakeServer;
  let a: Client;
  let b: Client;
  let c: Client;
  let level: string;
  let sheet: string;
  let d: string;

  beforeEach(async () => {
    server = new FakeServer();
    a = await client(server, ANN);
    b = await client(server, BOB);
    c = await client(server, CAT);
    const group = (await a.editor.create('numbering_group', { project_id: PROJECT, label: '06' }, CTX)).id;
    level = (await a.editor.create('level', { project_id: PROJECT, level: '06M', numbering_group_id: group }, CTX)).id;
    sheet = (await a.editor.create('sheet', { level_id: level, kind: 'display', page: 1 }, CTX)).id;
    await a.editor.setField('level', level, 'display_sheet_id', sheet, CTX);
    d = (
      await a.editor.create(
        'device',
        { level_id: level, display_id: '06M-02', category: 'Relay panel', type: 'Echo relay panel', notes: 'as found', pin: { sheet, x: 100, y: 200 } },
        CTX,
      )
    ).id;
    await sync(a, b, c);
  });

  /** Bob's edit arrives first (official, side A); Ann's goes to review (side B). */
  async function conflict(field: string, bob: unknown, ann: unknown): Promise<string> {
    await b.editor.setField('device', d, field, bob, CTX);
    await a.editor.setField('device', d, field, ann, CTX);
    await sync(b, a, b, c);
    const items = await openReviewItems(c.store, PROJECT);
    expect(items).toHaveLength(1);
    return items[0]!.id;
  }

  it('lists the item under its kind and level, and shows A/B with who, when, install and was', async () => {
    const itemId = await conflict('notes', 'Cover plate loose', 'LVD card missing');

    const list = await loadReviewList(c.store, PROJECT);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({
      id: itemId,
      kind: 'sync_conflict',
      levelId: level,
      levelCode: '06M',
      subject: '06M-02 Echo relay panel',
      field: 'Notes',
      pin: false,
      deviceId: d,
    });
    expect(list.tabs.map((t) => [t.label, t.count])).toEqual([
      ['All', 1],
      ['Sync conflict', 1],
      ['Extraction', 0],
      ['Source conflict', 0],
      ['Import pair', 0],
    ]);
    expect(list.levels).toEqual([{ id: level, code: '06M' }]);
    expect((await loadReviewList(c.store, PROJECT, { kind: 'extraction' })).rows).toEqual([]);
    expect((await loadReviewList(c.store, PROJECT, { levelId: uuidv7() })).rows).toEqual([]);

    const detail = (await loadReviewDetail(c.store, itemId, NAMES))!;
    expect(detail.a).toMatchObject({ who: 'Bob', install: expect.stringMatching(/^iPad …/) });
    expect(detail.b).toMatchObject({ who: 'Ann', install: `iPad …${a.store.installId.slice(-6)}` });
    expect(detail.fields).toEqual([{ field: 'notes', label: 'Notes', a: 'Cover plate loose', b: 'LVD card missing', was: 'as found' }]);
    expect(detail.choices).toEqual(['A', 'B', 'combine']);
    expect(detail.combine).toBe('Cover plate loose; LVD card missing');
    expect(detail.resolvable).toBe(true);
    expect(detail.pins).toBeNull();
    // On Ann's own iPad side B is "this iPad".
    expect((await loadReviewDetail(a.store, itemId, NAMES))!.b!.install).toBe('this iPad');
    // Without the team list the names fall back to the id tail.
    expect((await loadReviewDetail(c.store, itemId, new Map()))!.a!.who).toBe(`user …${BOB.slice(-6)}`);
  });

  it('IN REVIEW badges (card fields, plan pin) clear on every iPad once the Combine resolution is pulled', async () => {
    const itemId = await conflict('notes', 'Cover plate loose', 'LVD card missing');
    for (const x of [a, b, c]) {
      expect(await isInReview(x.store, d, 'notes')).toBe(true);
      expect((await loadLevelPlan(x.store, level))!.devices[0]!.inReview).toBe(true);
    }
    const detail = (await loadReviewDetail(c.store, itemId, NAMES))!;
    await c.editor.resolve(itemId, { choice: 'combine', text: `${detail.combine} (both seen)` }, { userName: (id) => NAMES.get(id) });
    // The resolver's iPad clears at once; the others still show it until they pull.
    expect((await loadReviewList(c.store, PROJECT)).rows).toEqual([]);
    expect(await isInReview(a.store, d)).toBe(true);
    await sync(c, a, b);
    for (const x of [a, b, c]) {
      expect(await reviewFields(x.store, d)).toEqual({});
      expect((await loadLevelPlan(x.store, level))!.devices[0]!.inReview).toBe(false);
      expect((await loadReviewList(x.store, PROJECT)).rows).toEqual([]);
      expect((await x.store.get<Record<string, unknown>>('device', d))!.notes).toBe('Cover plate loose; LVD card missing (both seen)');
    }
    // A resolved item still opens, read-only.
    const after = (await loadReviewDetail(a.store, itemId, NAMES))!;
    expect(after.item.state).toBe('resolved');
    expect(after.resolvable).toBe(false);
    expect(after.choices).toEqual([]);
  });

  it('a pin conflict gives the plan both positions; Choose B moves the pin everywhere', async () => {
    const itemId = await conflict('pin', { sheet, x: 300, y: 200 }, { sheet, x: 120, y: 260 });
    const row = (await loadReviewList(b.store, PROJECT)).rows[0]!;
    expect(row).toMatchObject({ field: 'Pin position', pin: true });
    const detail = (await loadReviewDetail(b.store, itemId, NAMES))!;
    expect(detail.choices).toEqual(['A', 'B']);
    expect(detail.fields[0]).toMatchObject({ a: 'x 300, y 200', b: 'x 120, y 260', was: 'x 100, y 200' });

    const pc = (await loadPinConflict(b.store, itemId, sheet, NAMES))!;
    expect(pc).toMatchObject({ deviceId: d, a: { x: 300, y: 200 }, b: { x: 120, y: 260 } });
    expect(pc.aLabel).toMatch(/^A — Bob \d\d\/\d\d \d\d:\d\d \(solid\)$/);
    expect(pc.bLabel).toMatch(/^B — Ann .* \(dashed\)$/);
    expect(await loadPinConflict(b.store, itemId, uuidv7(), NAMES)).toMatchObject({ a: null, b: null });

    await b.editor.resolve(itemId, { choice: 'B' }, { userName: (id) => NAMES.get(id) });
    expect(await loadPinConflict(b.store, itemId, sheet, NAMES)).toBeNull(); // resolved: no overlay
    await sync(b, a, c);
    for (const x of [a, b, c]) {
      expect((await loadLevelPlan(x.store, level))!.devices[0]).toMatchObject({ pin: { x: 120, y: 260 }, inReview: false });
    }
  });

  it('newest-first sort and one row per conflicting op (D90)', async () => {
    await b.editor.setField('device', d, 'notes', 'Bob', CTX);
    await sync(b);
    await a.editor.setField('device', d, 'notes', 'Ann', CTX);
    await sync(a);
    await c.editor.setField('device', d, 'notes', 'Cat', CTX);
    await sync(c, a, b);
    const oldest = await loadReviewList(b.store, PROJECT);
    expect(oldest.rows).toHaveLength(2);
    const newest = await loadReviewList(b.store, PROJECT, { sort: 'newest' });
    expect(newest.rows.map((r) => r.id)).toEqual(oldest.rows.map((r) => r.id).reverse());
  });
});

describe('field group (Tracking status + Date closed)', () => {
  it('shows both pairs and offers A/B only', async () => {
    const a = await client(null, ANN);
    const b = await client(null, BOB);
    let seq = 0;
    const deliver = async (ops: Op[], state: Op['state'], to: Client[]) => {
      const out = ops.map((o) => ({ ...o, server_seq: ++seq, server_ts: tsNext(), state }));
      for (const x of to) await x.store.applyRemoteMany(out);
    };
    const group = await a.editor.create('numbering_group', { project_id: PROJECT, label: '03' }, CTX);
    const lv = await a.editor.create('level', { project_id: PROJECT, level: '03', numbering_group_id: group.id }, CTX);
    const made = await a.editor.create('punch_item', { level_id: lv.id, item: 'Run X', type: 'Cable not run', tracking_status: 'Open' }, CTX);
    await deliver([group.op, lv.op, made.op], 'applied', [a, b]);
    const bobOp = (await b.editor.setField('punch_item', made.id, 'tracking_status', 'In progress', CTX))!;
    const annOps = await a.editor.setFields('punch_item', made.id, { tracking_status: 'Closed', date_closed: '2026-10-10' }, CTX);
    await deliver([bobOp], 'applied', [b, a]);
    await deliver(annOps, 'review', [a, b]);
    const id = uuidv7();
    const cand = (s: 'A' | 'B', o: Op) => ({
      side: s, op_id: o.op_id, user_id: o.user_id, install_id: o.install_id, client_ts: o.client_ts,
      entity_kind: o.entity_kind, entity_id: o.entity_id, field: o.field!, kind: o.kind, value: o.now ?? null,
    });
    await deliver(
      [
        {
          op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'server', client_ts: tsNext(),
          entity_kind: 'review_item', entity_id: id, kind: 'create', base_op_id: annOps[0]!.op_id, change_type: 'Field survey',
          reason: 'Sync conflict', group_id: null,
          payload: {
            id, project_id: PROJECT, level_id: lv.id, kind: 'sync_conflict',
            subject: { entity_kind: 'punch_item', entity_id: made.id, field: 'tracking_status', group_id: annOps[0]!.group_id, fields: ['tracking_status', 'date_closed'] },
            op_a_id: bobOp.op_id, op_b_id: annOps[0]!.op_id,
            candidates: [cand('A', bobOp), ...annOps.map((o) => cand('B', o))], ruling: false, state: 'open',
          },
        } as Op,
      ],
      'applied',
      [a, b],
    );

    const row = (await loadReviewList(b.store, PROJECT)).rows[0]!;
    expect(row).toMatchObject({ subject: 'Punch #NEW Run X', field: 'Tracking status + Date closed', levelCode: '03', deviceId: null });
    const detail = (await loadReviewDetail(b.store, id, NAMES))!;
    expect(detail.choices).toEqual(['A', 'B']);
    expect(detail.combine).toBeNull();
    expect(detail.fields).toEqual([
      { field: 'tracking_status', label: 'Tracking status', a: 'In progress', b: 'Closed', was: 'Open' },
      // A did not touch Date closed: the official (current) value on Bob's iPad.
      { field: 'date_closed', label: 'Date closed', a: '(blank)', b: '2026-10-10', was: '(blank)' },
    ]);
    const item = (await b.store.get<ReviewItem>('review_item', id))!;
    expect(item.subject.fields).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('labels fields and values the way the panel shows them', () => {
    expect(fieldLabel('tracking_status')).toBe('Tracking status');
    expect(fieldLabel('neuron_id')).toBe('Neuron ID');
    expect(fieldLabel('deleted_at')).toBe('Deleted');
    expect(fieldLabel('link:{"a":1}')).toBe('Link');
    expect(formatValue('deleted_at', true)).toBe('Deleted');
    expect(formatValue('deleted_at', false)).toBe('Restored');
    expect(formatValue('notes', '')).toBe('(blank)');
    expect(formatValue('pin', { sheet: 's', x: 10.4, y: 20.6 })).toBe('x 10, y 21');
    expect(uuidTime('0199c8a0-0000-7000-8000-000000000000')).toBe(new Date(0x0199c8a00000).toISOString());
    expect(shortStamp(null)).toBe('—');
  });
});
