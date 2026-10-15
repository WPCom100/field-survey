import { beforeEach, describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from './node';
import { Store, StoreError } from './store';
import type { Op } from './op';
import { uuidv7 } from './ids';

const PROJECT = uuidv7();
const LANDRY = uuidv7();
const ZACH = uuidv7();
const LEVEL = uuidv7();
const INSTALL = 'install-A';

let store: Store;
let ts = 1_760_000_000_000;

function tsNext(): string {
  ts += 1000;
  return new Date(ts).toISOString();
}

function op(partial: Partial<Op> & Pick<Op, 'entity_kind' | 'entity_id' | 'kind'>): Op {
  return {
    op_id: uuidv7(),
    project_id: PROJECT,
    user_id: LANDRY,
    install_id: INSTALL,
    client_ts: tsNext(),
    change_type: 'Field survey',
    ...partial,
  };
}

function remote(partial: Partial<Op> & Pick<Op, 'entity_kind' | 'entity_id' | 'kind'>, seq: number): Op {
  return { ...op({ user_id: ZACH, install_id: 'install-B', ...partial }), server_seq: seq, server_ts: tsNext(), state: 'applied' };
}

async function newDevice(extra: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  await store.apply(op({
    entity_kind: 'device', entity_id: id, kind: 'create',
    payload: { level_id: LEVEL, display_id: '06M-04', category: 'Relay panel', status: 'Installed, untested', pin: { sheet: 's', x: 1.5, y: 2 }, ...extra },
  }));
  return id;
}

beforeEach(async () => {
  store = await Store.open(new BetterSqliteDriver(), { installId: INSTALL, search: 'like' });
});

describe('Store.open', () => {
  it('keeps the install id across opens and generates one when none is given', async () => {
    const db = new BetterSqliteDriver();
    const a = await Store.open(db, { search: 'like' });
    const b = await Store.open(db, { search: 'like' });
    expect(a.installId).toBe(b.installId);
    expect(a.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.installId).toBe(INSTALL);
  });
});

describe('create', () => {
  it('materialises the payload, sets version 1, no head_seq, and a field head per column', async () => {
    const id = await newDevice();
    const row = await store.get('device', id);
    expect(row).toMatchObject({ id, display_id: '06M-04', category: 'Relay panel', status: 'Installed, untested', version: 1, head_seq: null, deleted_at: null });
    expect(row!.pin).toEqual({ sheet: 's', x: 1.5, y: 2 });
    const ops = await store.opsFor(id);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.state).toBe('pending');
    const heads = await store.fieldHeads(id);
    expect(Object.keys(heads).sort()).toEqual(['category', 'display_id', 'level_id', 'pin', 'status']);
    expect(new Set(Object.values(heads))).toEqual(new Set([ops[0]!.op_id]));
    expect(await store.outboxCount(PROJECT)).toBe(1);
  });

  it('rejects unknown columns, protected columns and server-assigned numbers', async () => {
    const bad = (payload: Record<string, unknown>, kind: Op['entity_kind'] = 'device') =>
      store.apply(op({ entity_kind: kind, entity_id: uuidv7(), kind: 'create', payload }));
    await expect(bad({ level_id: LEVEL, colour: 'red' })).rejects.toThrow(/Unknown column/);
    await expect(bad({ level_id: LEVEL, version: 7 })).rejects.toThrow(/not settable/);
    await expect(bad({ level_id: LEVEL, number: 3 }, 'punch_item')).rejects.toThrow(/assigned by the server/);
    expect(await store.outboxCount()).toBe(0);
  });

  it('is idempotent by op_id', async () => {
    const o = op({ entity_kind: 'device', entity_id: uuidv7(), kind: 'create', payload: { level_id: LEVEL } });
    expect(await store.apply(o)).toBe('applied');
    expect(await store.apply(o)).toBe('duplicate');
    expect(await store.outboxCount()).toBe(1);
  });

  it('encodes booleans and JSON for every column type', async () => {
    const id = uuidv7();
    await store.apply(op({ entity_kind: 'punch_item', entity_id: id, kind: 'create', payload: { level_id: LEVEL, item: 'Missing all Device Neuron IDs', type: 'Information', owner: 'EC', sort_last: true } }));
    const row = await store.get('punch_item', id);
    expect(row!.sort_last).toBe(true);
    expect(row!.number).toBeNull();
    const raw = await store.db.query<{ sort_last: number }>('SELECT sort_last FROM punch_item WHERE id = ?', [id]);
    expect(raw[0]!.sort_last).toBe(1);
  });
});

describe('set', () => {
  it('updates the field, bumps version, moves the field head and records was/now', async () => {
    const id = await newDevice();
    const head0 = await store.fieldHead(id, 'status');
    const set = op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'status', was: 'Installed, untested', now: 'Issue', base_op_id: head0, reason: 'wire nuts' });
    await store.apply(set);
    const row = await store.get('device', id);
    expect(row).toMatchObject({ status: 'Issue', version: 2 });
    expect(await store.fieldHead(id, 'status')).toBe(set.op_id);
    expect(await store.fieldHead(id, 'category')).toBe(head0 === null ? null : (await store.opsFor(id))[0]!.op_id);
    const stored = await store.getOp(set.op_id);
    expect(stored).toMatchObject({ was: 'Installed, untested', now: 'Issue', base_op_id: head0, state: 'pending', server_seq: null });
  });

  it('writes JSON fields (pin) and nulls', async () => {
    const id = await newDevice();
    await store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'pin', now: { sheet: 's', x: 9, y: 9 } }));
    expect((await store.get('device', id))!.pin).toEqual({ sheet: 's', x: 9, y: 9 });
    await store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: null }));
    expect((await store.get('device', id))!.notes).toBeNull();
  });

  it('refuses server-assigned, protected and unknown fields, and unknown records', async () => {
    const punch = uuidv7();
    await store.apply(op({ entity_kind: 'punch_item', entity_id: punch, kind: 'create', payload: { level_id: LEVEL, item: 'x' } }));
    await expect(store.apply(op({ entity_kind: 'punch_item', entity_id: punch, kind: 'set', field: 'number', now: 4 }))).rejects.toThrow(/assigned by the server/);
    await expect(store.apply(op({ entity_kind: 'punch_item', entity_id: punch, kind: 'set', field: 'version', now: 4 }))).rejects.toThrow(/not settable/);
    await expect(store.apply(op({ entity_kind: 'punch_item', entity_id: punch, kind: 'set', field: 'colour', now: 4 }))).rejects.toThrow(/Unknown column/);
    await expect(store.apply(op({ entity_kind: 'punch_item', entity_id: uuidv7(), kind: 'set', field: 'item', now: 'y' }))).rejects.toThrow(/unknown punch_item/);
    expect((await store.get('punch_item', punch))!.version).toBe(1);
    expect(await store.outboxCount()).toBe(1);
  });

  it('rejects a local assign and a non-pending local state', async () => {
    const id = await newDevice();
    await expect(store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'assign', field: 'display_id', now: 'x' }))).rejects.toThrow(/server-only/);
    await expect(store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'x', state: 'applied' }))).rejects.toThrow(StoreError);
  });

  it('applies grouped edits atomically', async () => {
    const id = await newDevice();
    const group = uuidv7();
    await expect(store.applyMany([
      op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'status', now: 'Issue', group_id: group }),
      op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'nope', now: 'x', group_id: group }),
    ])).rejects.toThrow(/Unknown column/);
    expect((await store.get('device', id))!.status).toBe('Installed, untested');
    expect(await store.outboxCount()).toBe(1);
  });
});

describe('delete and restore', () => {
  it('soft-deletes with who/when/why, drops the row from list(), and restore reverses it', async () => {
    const id = await newDevice();
    const del = op({ entity_kind: 'device', entity_id: id, kind: 'delete', change_type: 'Correction', reason: 'Duplicate of 06M-03' });
    await store.apply(del);
    const row = await store.get('device', id);
    expect(row).toMatchObject({ deleted_at: del.client_ts, deleted_by_id: LANDRY, delete_reason: 'Duplicate of 06M-03', version: 2 });
    expect(await store.list('device')).toEqual([]);
    expect(await store.list('device', { includeDeleted: true })).toHaveLength(1);
    expect(await store.fieldHead(id, 'deleted_at')).toBe(del.op_id);

    const restore = op({ entity_kind: 'device', entity_id: id, kind: 'restore', change_type: 'Correction', reason: 'not a duplicate' });
    await store.apply(restore);
    expect(await store.get('device', id)).toMatchObject({ deleted_at: null, deleted_by_id: null, delete_reason: null, version: 3, status: 'Installed, untested' });
    expect(await store.list('device')).toHaveLength(1);
    expect((await store.opsFor(id)).map((o) => o.kind)).toEqual(['create', 'delete', 'restore']);
    expect(await store.outboxCount()).toBe(3);
  });

  it('refuses delete on link and plain entities', async () => {
    await expect(store.apply(op({ entity_kind: 'assignment', entity_id: LEVEL, kind: 'delete' }))).rejects.toThrow(/not allowed/);
    await expect(store.apply(op({ entity_kind: 'blob', entity_id: 'abc', kind: 'delete' }))).rejects.toThrow(/not allowed/);
  });
});

describe('links', () => {
  it('link_add inserts, link_remove soft-deletes, link_add again revives', async () => {
    const part = uuidv7();
    const punch = uuidv7();
    await store.apply(op({ entity_kind: 'part_source', entity_id: part, kind: 'link_add', payload: { target_kind: 'punch', target_id: punch } }));
    expect(await store.list('part_source')).toEqual([{ missing_part_id: part, target_kind: 'punch', target_id: punch, deleted_at: null, deleted_by_id: null }]);
    await store.apply(op({ entity_kind: 'part_source', entity_id: part, kind: 'link_remove', payload: { target_kind: 'punch', target_id: punch } }));
    expect(await store.list('part_source')).toEqual([]);
    expect((await store.list('part_source', { includeDeleted: true }))[0]!.deleted_by_id).toBe(LANDRY);
    await store.apply(op({ entity_kind: 'part_source', entity_id: part, kind: 'link_add', payload: { target_kind: 'punch', target_id: punch } }));
    expect(await store.list('part_source')).toHaveLength(1);
  });

  it('photo_link (D128): several links per photo, each removed on its own', async () => {
    const photo = uuidv7();
    const [d1, d2, end] = [uuidv7(), uuidv7(), uuidv7()];
    for (const [k, t] of [['device', d1], ['device', d2], ['cable_end', end]] as const) {
      await store.apply(op({ entity_kind: 'photo_link', entity_id: photo, kind: 'link_add', payload: { target_kind: k, target_id: t } }));
    }
    expect(await store.list('photo_link')).toHaveLength(3);
    await store.apply(op({ entity_kind: 'photo_link', entity_id: photo, kind: 'link_remove', payload: { target_kind: 'device', target_id: d2 } }));
    expect((await store.list<{ target_id: string }>('photo_link')).map((l) => l.target_id).sort()).toEqual([d1, end].sort());
    await expect(
      store.apply(op({ entity_kind: 'photo_link', entity_id: photo, kind: 'link_add', payload: { target_kind: 'photo', target_id: d1 } })),
    ).rejects.toThrow();
  });

  it('assignment carries extra columns and needs its key', async () => {
    await store.apply(op({ entity_kind: 'assignment', entity_id: LEVEL, kind: 'link_add', payload: { user_id: ZACH, assigned_by_id: LANDRY, assigned_at: '2026-10-10T00:00:00Z' } }));
    expect(await store.list('assignment')).toMatchObject([{ level_id: LEVEL, user_id: ZACH, assigned_by_id: LANDRY }]);
    await expect(store.apply(op({ entity_kind: 'assignment', entity_id: LEVEL, kind: 'link_add', payload: {} }))).rejects.toThrow(/payload.user_id/);
    await expect(store.apply(op({ entity_kind: 'device', entity_id: LEVEL, kind: 'link_add', payload: {} }))).rejects.toThrow(/not allowed/);
  });
});

describe('outbox', () => {
  it('lists pending ops in client_ts order and clears on acknowledgement', async () => {
    const id = await newDevice();
    const create = (await store.opsFor(id))[0]!;
    const later = op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'b' });
    const earlier = { ...op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'a' }), client_ts: new Date(ts - 1500).toISOString() };
    await store.apply(later);
    await store.apply(earlier);
    expect((await store.outbox(PROJECT)).map((o) => o.op_id)).toEqual([create.op_id, earlier.op_id, later.op_id]);
    await store.applyRemote({ ...later, server_seq: 7, server_ts: tsNext(), state: 'applied' });
    expect((await store.outbox(PROJECT)).map((o) => o.op_id)).not.toContain(later.op_id);
    expect(await store.outboxCount(PROJECT)).toBe(2);
  });
});

describe('applyRemote', () => {
  it('acknowledges our own op: server_seq, state, head_seq, outbox cleared, value untouched', async () => {
    const id = await newDevice();
    const create = (await store.opsFor(id))[0]!;
    const r = await store.applyRemote({ ...create, server_seq: 41, server_ts: tsNext(), state: 'applied' });
    expect(r.outcome).toBe('acknowledged');
    expect(await store.getOp(create.op_id)).toMatchObject({ server_seq: 41, state: 'applied' });
    expect(await store.get('device', id)).toMatchObject({ version: 1, head_seq: 41, display_id: '06M-04' });
    expect(await store.outboxCount()).toBe(0);
    expect((await store.applyRemote({ ...create, server_seq: 41, state: 'applied' })).outcome).toBe('duplicate');
  });

  it('ink layers and photo blobs never mark a pending local op for review (last write wins, T24)', async () => {
    const layer = uuidv7();
    await store.apply(op({ entity_kind: 'ink_layer', entity_id: layer, kind: 'create', payload: { id: layer, sheet_id: uuidv7(), user_id: LANDRY, drawing_blob: 'a'.repeat(64) } }));
    const heads = await store.fieldHeads(layer);
    const mine = op({ entity_kind: 'ink_layer', entity_id: layer, kind: 'set', field: 'drawing_blob', was: 'a'.repeat(64), now: 'b'.repeat(64), base_op_id: heads.drawing_blob });
    await store.apply(mine);
    const other = remote({ entity_kind: 'ink_layer', entity_id: layer, kind: 'set', field: 'drawing_blob', was: 'a'.repeat(64), now: 'c'.repeat(64), base_op_id: heads.drawing_blob }, 20);
    expect(await store.applyRemote(other)).toEqual({ outcome: 'applied', collided_pending: [] });
    const photo = uuidv7();
    await store.apply(op({ entity_kind: 'photo', entity_id: photo, kind: 'create', payload: { id: photo, level_id: LEVEL, markup_blob: null, subject: 'x' } }));
    const ph = await store.fieldHeads(photo);
    await store.apply(op({ entity_kind: 'photo', entity_id: photo, kind: 'set', field: 'markup_blob', was: null, now: 'd'.repeat(64), base_op_id: ph.markup_blob }));
    await store.apply(op({ entity_kind: 'photo', entity_id: photo, kind: 'set', field: 'subject', was: 'x', now: 'y', base_op_id: ph.subject }));
    const markup = remote({ entity_kind: 'photo', entity_id: photo, kind: 'set', field: 'markup_blob', was: null, now: 'e'.repeat(64), base_op_id: ph.markup_blob }, 21);
    expect((await store.applyRemote(markup)).collided_pending).toEqual([]);
    // a caption is ordinary survey text: that still collides
    const subject = remote({ entity_kind: 'photo', entity_id: photo, kind: 'set', field: 'subject', was: 'x', now: 'z', base_op_id: ph.subject }, 22);
    expect((await store.applyRemote(subject)).collided_pending).toHaveLength(1);
  });

  it('records our op put in review without changing the official (first-arrived) value', async () => {
    const id = await newDevice();
    const heads = await store.fieldHeads(id);
    // Zach's edit reached the server first …
    const zach = remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'status', was: 'Installed, untested', now: 'No access', base_op_id: heads.status }, 10);
    // … while Landry's conflicting edit was still local.
    const mine = op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'status', was: 'Installed, untested', now: 'Issue', base_op_id: heads.status });
    await store.apply(mine);
    expect((await store.get('device', id))!.status).toBe('Issue');

    const pulled = await store.applyRemote(zach);
    expect(pulled).toEqual({ outcome: 'applied', collided_pending: [mine.op_id] });
    expect(await store.get('device', id)).toMatchObject({ status: 'No access', version: 3, head_seq: 10 });
    expect(await store.fieldHead(id, 'status')).toBe(zach.op_id);

    const echo = await store.applyRemote({ ...mine, server_seq: 11, server_ts: tsNext(), state: 'review' });
    expect(echo.outcome).toBe('acknowledged');
    expect(await store.getOp(mine.op_id)).toMatchObject({ state: 'review', server_seq: 11 });
    expect((await store.get('device', id))!.status).toBe('No access');
    expect((await store.outbox()).map((o) => o.kind)).toEqual(['create']); // only the unacknowledged create remains
  });

  it('materialises another install\'s create/set/delete and records review ops without applying', async () => {
    const id = uuidv7();
    const create = remote({ entity_kind: 'device', entity_id: id, kind: 'create', payload: { level_id: LEVEL, display_id: '06M-05', status: 'Issue' } }, 1);
    expect((await store.applyRemote(create)).outcome).toBe('applied');
    expect(await store.get('device', id)).toMatchObject({ display_id: '06M-05', version: 1, head_seq: 1 });
    expect(await store.fieldHead(id, 'display_id')).toBe(create.op_id);

    const set = remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'Reterminated - all good' }, 2);
    const reviewed = { ...remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'something else' }, 3), state: 'review' as const };
    const results = await store.applyRemoteMany([set, reviewed]);
    expect(results.map((r) => r.outcome)).toEqual(['applied', 'recorded']);
    expect(await store.get('device', id)).toMatchObject({ notes: 'Reterminated - all good', version: 2, head_seq: 2 });
    expect(await store.getOp(reviewed.op_id)).toMatchObject({ state: 'review' });

    const del = remote({ entity_kind: 'device', entity_id: id, kind: 'delete', reason: 'gone' }, 4);
    await store.applyRemote(del);
    expect(await store.get('device', id)).toMatchObject({ deleted_at: del.server_ts, deleted_by_id: ZACH, delete_reason: 'gone', version: 3, head_seq: 4 });
    expect(await store.outboxCount()).toBe(0);
    expect((await store.opsFor(id)).map((o) => o.server_seq)).toEqual([1, 2, 3, 4]);
  });

  it('applies a server assign to a server-assigned field and keeps the head', async () => {
    const punch = uuidv7();
    await store.apply(op({ entity_kind: 'punch_item', entity_id: punch, kind: 'create', payload: { level_id: LEVEL, item: 'Run DMX', type: 'Cable not run', owner: 'EC' } }));
    expect((await store.get('punch_item', punch))!.number).toBeNull();
    const assign = remote({ entity_kind: 'punch_item', entity_id: punch, kind: 'assign', field: 'number', now: 12, user_id: LANDRY }, 5);
    expect((await store.applyRemote(assign)).outcome).toBe('applied');
    expect(await store.get('punch_item', punch)).toMatchObject({ number: 12, version: 2, head_seq: 5 });
    expect(await store.fieldHead(punch, 'number')).toBe(assign.op_id);
  });

  it('reports a pending local delete as colliding with any incoming set, and an orphan when the record is unknown', async () => {
    const id = await newDevice();
    const del = op({ entity_kind: 'device', entity_id: id, kind: 'delete', reason: 'x' });
    await store.apply(del);
    const r = await store.applyRemote(remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'n' }, 3));
    expect(r.collided_pending).toEqual([del.op_id]);
    const orphan = await store.applyRemote(remote({ entity_kind: 'device', entity_id: uuidv7(), kind: 'set', field: 'notes', now: 'n' }, 4));
    expect(orphan.outcome).toBe('orphan');
  });

  it('requires a server_seq', async () => {
    await expect(store.applyRemote(op({ entity_kind: 'device', entity_id: uuidv7(), kind: 'create', payload: { level_id: LEVEL } }))).rejects.toThrow(/server_seq/);
  });
});

describe('head_seq', () => {
  it('is the highest server_seq applied to the record and never goes down', async () => {
    const id = uuidv7();
    await store.applyRemote(remote({ entity_kind: 'device', entity_id: id, kind: 'create', payload: { level_id: LEVEL } }, 20));
    await store.applyRemote(remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'a' }, 22));
    expect((await store.get('device', id))!.head_seq).toBe(22);
    // a local edit (no seq yet) leaves head_seq alone
    const local = op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'b' });
    await store.apply(local);
    expect(await store.get('device', id)).toMatchObject({ head_seq: 22, version: 3 });
    // its echo moves it forward
    await store.applyRemote({ ...local, server_seq: 30, server_ts: tsNext(), state: 'applied' });
    expect(await store.get('device', id)).toMatchObject({ head_seq: 30, version: 3, notes: 'b' });
  });
});

describe('validation', () => {
  it('rejects bad kinds, change types, entity kinds and missing identity', async () => {
    const base = op({ entity_kind: 'device', entity_id: uuidv7(), kind: 'create', payload: { level_id: LEVEL } });
    await expect(store.apply({ ...base, kind: 'upsert' as Op['kind'] })).rejects.toThrow(/Bad op kind/);
    await expect(store.apply({ ...base, change_type: 'Edit' as Op['change_type'] })).rejects.toThrow(/Bad change_type/);
    await expect(store.apply({ ...base, entity_kind: 'outbox' as Op['entity_kind'] })).rejects.toThrow(/Bad entity_kind/);
    await expect(store.apply({ ...base, user_id: '' })).rejects.toThrow(/user_id is required/);
    await expect(store.apply({ ...base, payload: null })).rejects.toThrow(/needs a payload/);
    expect(await store.outboxCount()).toBe(0);
  });
});

describe('onChange (T33)', () => {
  it('announces applied local commits and pulls with their projects and kinds, not duplicates or recorded ops', async () => {
    const seen: { source: string; projectIds: string[]; kinds: string[] }[] = [];
    const off = store.onChange((c) => seen.push({ source: c.source, projectIds: c.projectIds, kinds: [...c.kinds].sort() }));
    const id = await newDevice();
    expect(seen).toEqual([{ source: 'local', projectIds: [PROJECT], kinds: ['device'] }]);
    const create = (await store.opsFor(id))[0]!;
    await store.apply(create); // duplicate: nothing applied, nothing announced
    expect(seen).toHaveLength(1);
    await store.applyRemoteMany([
      remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'a' }, 5),
      remote({ entity_kind: 'punch_item', entity_id: uuidv7(), kind: 'create', payload: { level_id: LEVEL, item: 'x' } }, 6),
      { ...remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'b' }, 7), state: 'review' as const },
    ]);
    expect(seen[1]).toEqual({ source: 'remote', projectIds: [PROJECT], kinds: ['device', 'punch_item'] });
    // only recorded (review) ops → nothing announced
    await store.applyRemote({ ...remote({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'c' }, 8), state: 'review' });
    expect(seen).toHaveLength(2);
    // a throwing listener never breaks the edit
    store.onChange(() => {
      throw new Error('boom');
    });
    await store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'd' }));
    expect(seen).toHaveLength(3);
    off();
    await store.apply(op({ entity_kind: 'device', entity_id: id, kind: 'set', field: 'notes', now: 'e' }));
    expect(seen).toHaveLength(3);
  });
});

describe('a second create of an existing row (deterministic ids, D169)', () => {
  it('applies without changing the row or its heads, locally and from a pull', async () => {
    const id = uuidv7();
    const first = op({ entity_kind: 'proposal', entity_id: id, kind: 'create', payload: { project_id: PROJECT, rule_id: 'R3a', kind: 'punch', state: 'proposed', inputs_hash: 'h1' } });
    await store.apply(first);
    // the same row made on another iPad arrives by pull
    const r = await store.applyRemote(
      remote({ entity_kind: 'proposal', entity_id: id, kind: 'create', payload: { project_id: PROJECT, rule_id: 'R3a', kind: 'punch', state: 'proposed', inputs_hash: 'h1' } }, 9),
    );
    expect(r.outcome).toBe('applied');
    expect(await store.get('proposal', id)).toMatchObject({ version: 1, inputs_hash: 'h1' });
    expect(await store.fieldHead(id, 'state')).toBe(first.op_id);
    // and a local create over a pulled row (the engine ran before the pull landed) does the same
    const other = uuidv7();
    await store.applyRemote(remote({ entity_kind: 'proposal', entity_id: other, kind: 'create', payload: { project_id: PROJECT, rule_id: 'R3a', kind: 'punch', state: 'proposed', inputs_hash: 'h2' } }, 10));
    const remoteCreate = (await store.opsFor(other))[0]!;
    await store.apply(op({ entity_kind: 'proposal', entity_id: other, kind: 'create', payload: { project_id: PROJECT, rule_id: 'R3a', kind: 'punch', state: 'proposed', inputs_hash: 'h2' } }));
    expect(await store.fieldHead(other, 'state')).toBe(remoteCreate.op_id);
    expect((await store.get('proposal', other))!.version).toBe(1);
  });
});
