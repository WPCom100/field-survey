import { beforeEach, describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from './node';
import { Editor, OpError, type EditContext } from './editor';
import { Store } from './store';
import { isUuid, uuidv7 } from './ids';

const PROJECT = uuidv7();
const LANDRY = uuidv7();
const ZACH = uuidv7();
const LEVEL = uuidv7();
const INSTALL = 'install-A';

const SURVEY: EditContext = { change_type: 'Field survey', reason: 'Surveyed 06M' };
const FIX: EditContext = { change_type: 'Correction', reason: 'Duplicate of 06M-03' };

let store: Store;
let editor: Editor;
let ts = 1_760_000_000_000;

function tsNext(): string {
  ts += 1000;
  return new Date(ts).toISOString();
}

async function newDevice(extra: Record<string, unknown> = {}): Promise<string> {
  const { id } = await editor.create(
    'device',
    { level_id: LEVEL, display_id: '06M-04', category: 'Relay panel', status: 'Installed, untested', ...extra },
    SURVEY,
  );
  return id;
}

beforeEach(async () => {
  store = await Store.open(new BetterSqliteDriver(), { installId: INSTALL, search: 'like' });
  editor = new Editor(store, { projectId: PROJECT, userId: LANDRY, now: tsNext });
});

describe('context', () => {
  it('requires a change_type from the list and a non-empty reason', async () => {
    const bad = (ctx: unknown) => editor.create('device', { level_id: LEVEL }, ctx as EditContext);
    await expect(bad({ reason: 'x' })).rejects.toThrow(/change_type is required/);
    await expect(bad({ change_type: 'Edit', reason: 'x' })).rejects.toThrow(OpError);
    await expect(bad({ change_type: 'Field survey' })).rejects.toThrow(/reason is required/);
    await expect(bad({ change_type: 'Field survey', reason: '   ' })).rejects.toThrow(/reason is required/);
    expect(await store.outboxCount()).toBe(0);
  });

  it('requires a project and a user', async () => {
    await expect(new Editor(store, { projectId: '', userId: LANDRY }).group(SURVEY, async () => {})).rejects.toThrow(/projectId/);
    await expect(new Editor(store, { projectId: PROJECT, userId: '' }).group(SURVEY, async () => {})).rejects.toThrow(/userId/);
  });
});

describe('create', () => {
  it('stamps who/where/when, the full payload with id, pending state, and seeds the heads', async () => {
    const before = ts;
    const { id, op } = await editor.create('device', { level_id: LEVEL, display_id: '06M-04', status: 'Issue' }, SURVEY);
    expect(isUuid(id)).toBe(true);
    expect(op).toMatchObject({
      project_id: PROJECT, user_id: LANDRY, install_id: INSTALL, entity_kind: 'device', entity_id: id,
      kind: 'create', payload: { id, level_id: LEVEL, display_id: '06M-04', status: 'Issue' },
      field: null, was: null, now: null, base_op_id: null, group_id: null,
      change_type: 'Field survey', reason: 'Surveyed 06M', ruling_id: null, proposal_id: null, state: 'pending',
    });
    expect(isUuid(op.op_id)).toBe(true);
    expect(op.client_ts).toBe(new Date(before + 1000).toISOString());
    expect(await store.get('device', id)).toMatchObject({ display_id: '06M-04', status: 'Issue', version: 1 });
    expect(await store.fieldHeads(id)).toEqual({ level_id: op.op_id, display_id: op.op_id, status: op.op_id });
    expect(await store.outboxCount(PROJECT)).toBe(1);
  });

  it('keeps a caller-supplied id and drops undefined values', async () => {
    const wanted = uuidv7();
    const { id, op } = await editor.create('punch_item', { id: wanted, level_id: LEVEL, item: 'Run DMX', notes: undefined }, SURVEY);
    expect(id).toBe(wanted);
    expect(op.payload).toEqual({ id: wanted, level_id: LEVEL, item: 'Run DMX' });
  });

  it('refuses unknown, protected, server-assigned and off-list values, duplicates and links', async () => {
    await expect(editor.create('device', { level_id: LEVEL, colour: 'red' }, SURVEY)).rejects.toThrow(/Unknown column/);
    await expect(editor.create('device', { level_id: LEVEL, version: 3 }, SURVEY)).rejects.toThrow(/not editable/);
    await expect(editor.create('punch_item', { level_id: LEVEL, number: 3 }, SURVEY)).rejects.toThrow(/assigned by the server/);
    await expect(editor.create('device', { level_id: LEVEL, status: 'Done' }, SURVEY)).rejects.toThrow(/must be one of/);
    const id = await newDevice();
    await expect(editor.create('device', { id, level_id: LEVEL }, SURVEY)).rejects.toThrow(/already exists/);
    await expect(editor.create('assignment', { level_id: LEVEL, user_id: ZACH }, SURVEY)).rejects.toThrow(/Use link/);
    await expect(editor.create('outbox', {}, SURVEY)).rejects.toThrow(/bad entity kind/);
    expect(await store.outboxCount()).toBe(1);
  });
});

describe('setField', () => {
  it('records was/now, takes base_op_id from the field head and chains heads across edits', async () => {
    const id = await newDevice();
    const create = (await store.opsFor(id))[0]!;
    const first = await editor.setField('device', id, 'status', 'Issue', { change_type: 'Field survey', reason: 'LVD card missing' });
    expect(first).toMatchObject({
      kind: 'set', field: 'status', was: 'Installed, untested', now: 'Issue', base_op_id: create.op_id,
      group_id: null, reason: 'LVD card missing', state: 'pending',
    });
    expect(await store.get('device', id)).toMatchObject({ status: 'Issue', version: 2 });

    const second = await editor.setField('device', id, 'status', 'No access', SURVEY);
    expect(second).toMatchObject({ was: 'Issue', now: 'No access', base_op_id: first!.op_id });
    expect(await store.fieldHead(id, 'status')).toBe(second!.op_id);
  });

  it('uses a null base and null was for a field never set, and handles JSON values', async () => {
    const id = await newDevice();
    const op = await editor.setField('device', id, 'pin', { sheet: 's', x: 1, y: 2 }, SURVEY);
    expect(op).toMatchObject({ was: null, now: { sheet: 's', x: 1, y: 2 }, base_op_id: null });
    expect((await store.get('device', id))!.pin).toEqual({ sheet: 's', x: 1, y: 2 });
    const cleared = await editor.setField('device', id, 'pin', null, SURVEY);
    expect(cleared).toMatchObject({ was: { sheet: 's', x: 1, y: 2 }, now: null, base_op_id: op!.op_id });
  });

  it('writes nothing when the value is unchanged', async () => {
    const id = await newDevice();
    expect(await editor.setField('device', id, 'status', 'Installed, untested', SURVEY)).toBeNull();
    expect(await editor.setField('device', id, 'notes', null, SURVEY)).toBeNull();
    expect((await store.opsFor(id)).length).toBe(1);
  });

  it('refuses unknown records, deleted records, bad fields and off-list values', async () => {
    const id = await newDevice();
    await expect(editor.setField('device', uuidv7(), 'notes', 'x', SURVEY)).rejects.toThrow(/Unknown device/);
    await expect(editor.setField('device', id, 'colour', 'x', SURVEY)).rejects.toThrow(/Unknown column/);
    await expect(editor.setField('device', id, 'id', 'x', SURVEY)).rejects.toThrow(/not editable/);
    await expect(editor.setField('device', id, 'head_seq', 4, SURVEY)).rejects.toThrow(/not editable/);
    await expect(editor.setField('device', id, 'status', 'Fine', SURVEY)).rejects.toThrow(/must be one of/);
    await expect(editor.setField('assignment', LEVEL, 'user_id', ZACH, SURVEY)).rejects.toThrow(/use link/);
    const punch = await editor.create('punch_item', { level_id: LEVEL, item: 'x' }, SURVEY);
    await expect(editor.setField('punch_item', punch.id, 'number', 3, SURVEY)).rejects.toThrow(/assigned by the server/);
    await editor.delete('device', id, FIX);
    await expect(editor.setField('device', id, 'notes', 'x', SURVEY)).rejects.toThrow(/restore it first/);
    expect((await store.opsFor(id)).map((o) => o.kind)).toEqual(['create', 'delete']);
  });

  it('passes ruling_id and proposal_id through', async () => {
    const id = await newDevice();
    const ruling = uuidv7();
    const real = await editor.setField('device', id, 'notes', 'Land 0-10V control wiring', { change_type: 'Ruling', reason: '0-10V rows read Fixtures', ruling_id: ruling, proposal_id: 'p1' });
    expect(real).toMatchObject({ change_type: 'Ruling', ruling_id: ruling, proposal_id: 'p1' });
  });
});

describe('delete and restore', () => {
  it('delete carries the reason into delete_reason with the deleted_at head as base; restore bases on the delete', async () => {
    const id = await newDevice();
    const del = await editor.delete('device', id, FIX);
    expect(del).toMatchObject({ kind: 'delete', change_type: 'Correction', reason: 'Duplicate of 06M-03', base_op_id: null, group_id: null });
    expect(await store.get('device', id)).toMatchObject({ deleted_at: del.client_ts, deleted_by_id: LANDRY, delete_reason: 'Duplicate of 06M-03', version: 2 });
    await expect(editor.delete('device', id, FIX)).rejects.toThrow(/already deleted/);

    const back = await editor.restore('device', id, { change_type: 'Correction', reason: 'not a duplicate' });
    expect(back).toMatchObject({ kind: 'restore', base_op_id: del.op_id, reason: 'not a duplicate' });
    expect(await store.get('device', id)).toMatchObject({ deleted_at: null, delete_reason: null, version: 3 });
    await expect(editor.restore('device', id, FIX)).rejects.toThrow(/is not deleted/);
    expect(await store.fieldHead(id, 'deleted_at')).toBe(back.op_id);
  });

  it('refuses unknown records and non-record entities', async () => {
    await expect(editor.delete('device', uuidv7(), FIX)).rejects.toThrow(/Unknown device/);
    await expect(editor.delete('assignment', LEVEL, FIX)).rejects.toThrow(/not allowed/);
    await expect(editor.restore('blob', 'abc', FIX)).rejects.toThrow(/not allowed/);
  });
});

describe('link and unlink', () => {
  it('link_add on part_source and assignment, link_remove reverses, entity_id is the owner', async () => {
    const part = uuidv7();
    const punch = uuidv7();
    const add = await editor.link('part_source', part, { target_kind: 'punch', target_id: punch }, SURVEY);
    expect(add).toMatchObject({ kind: 'link_add', entity_kind: 'part_source', entity_id: part, payload: { target_kind: 'punch', target_id: punch }, base_op_id: null, reason: 'Surveyed 06M' });
    expect(await store.list('part_source')).toHaveLength(1);
    const remove = await editor.unlink('part_source', part, { target_kind: 'punch', target_id: punch }, FIX);
    expect(remove).toMatchObject({ kind: 'link_remove', entity_id: part, payload: { target_kind: 'punch', target_id: punch } });
    expect(await store.list('part_source')).toEqual([]);

    const assign = await editor.link('assignment', LEVEL, { user_id: ZACH, assigned_by_id: LANDRY, assigned_at: '2026-10-10T00:00:00Z' }, { change_type: 'Master edit', reason: 'Zach takes 06M' });
    expect(assign.payload).toEqual({ user_id: ZACH, assigned_by_id: LANDRY, assigned_at: '2026-10-10T00:00:00Z' });
    expect(await store.list('assignment')).toMatchObject([{ level_id: LEVEL, user_id: ZACH }]);
  });

  it('refuses records, missing keys, owner-in-key and bad columns', async () => {
    await expect(editor.link('device', LEVEL, {}, SURVEY)).rejects.toThrow(/not allowed/);
    await expect(editor.link('assignment', LEVEL, {}, SURVEY)).rejects.toThrow(/needs user_id/);
    await expect(editor.link('assignment', '', { user_id: ZACH }, SURVEY)).rejects.toThrow(/owning level_id/);
    await expect(editor.link('assignment', LEVEL, { level_id: LEVEL, user_id: ZACH }, SURVEY)).rejects.toThrow(/not part of the key/);
    await expect(editor.link('part_source', uuidv7(), { target_kind: 'photo', target_id: 'x' }, SURVEY)).rejects.toThrow(/must be one of/);
    await expect(editor.unlink('part_source', uuidv7(), { nope: 1 }, SURVEY)).rejects.toThrow(/Unknown column/);
    expect(await store.outboxCount()).toBe(0);
  });
});

describe('group', () => {
  it('gives every op one group_id, applies atomically and chains heads inside the group', async () => {
    const punch = await editor.create('punch_item', { level_id: LEVEL, item: 'Land 0-10V control wiring', tracking_status: 'Open' }, SURVEY);
    const ops = await editor.group({ change_type: 'Field survey', reason: 'Reterminated - all good' }, async (g) => {
      await g.setField('punch_item', punch.id, 'tracking_status', 'Closed');
      await g.setField('punch_item', punch.id, 'date_closed', '2026-10-10');
      await g.setField('punch_item', punch.id, 'tracking_status', 'In progress'); // same field twice
      await g.setField('punch_item', punch.id, 'item', 'Land 0-10V control wiring'); // unchanged → skipped
    });
    expect(ops).toHaveLength(3);
    const group = ops[0]!.group_id;
    expect(isUuid(group!)).toBe(true);
    expect(ops.every((o) => o.group_id === group)).toBe(true);
    expect(ops[0]).toMatchObject({ field: 'tracking_status', was: 'Open', now: 'Closed', base_op_id: punch.op.op_id });
    expect(ops[1]).toMatchObject({ field: 'date_closed', was: null, now: '2026-10-10', base_op_id: null });
    expect(ops[2]).toMatchObject({ field: 'tracking_status', was: 'Closed', now: 'In progress', base_op_id: ops[0]!.op_id });
    expect(await store.get('punch_item', punch.id)).toMatchObject({ tracking_status: 'In progress', date_closed: '2026-10-10', version: 4 });
    expect(await store.fieldHead(punch.id, 'tracking_status')).toBe(ops[2]!.op_id);
    expect((await store.outbox(PROJECT)).filter((o) => o.group_id === group)).toHaveLength(3);
  });

  it('setFields is a group over one record', async () => {
    const id = await newDevice();
    const ops = await editor.setFields('device', id, { status: 'Issue', notes: 'Empty box on wall.', category: 'Relay panel' }, SURVEY);
    expect(ops.map((o) => o.field)).toEqual(['status', 'notes']);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(ops[0]!.group_id).not.toBeNull();
    expect(await editor.setFields('device', id, { status: 'Issue' }, SURVEY)).toEqual([]);
  });

  it('a create followed by edits on the new record inside one group bases on the create', async () => {
    const ops = await editor.group(SURVEY, async (g) => {
      const { id, op } = await g.create('missing_part', { level_id: LEVEL, part: 'ERP-FT-LVD', qty: 1, owner: 'EC', part_status: 'Needed' });
      const set = await g.setField('missing_part', id, 'notes', 'Need to be ordered');
      expect(set).toMatchObject({ was: null, base_op_id: null });
      const qty = await g.setField('missing_part', id, 'qty', 2);
      expect(qty).toMatchObject({ was: 1, now: 2, base_op_id: op.op_id });
      await g.link('part_source', id, { target_kind: 'device', target_id: uuidv7() });
      await g.delete('missing_part', id);
      await expect(g.setField('missing_part', id, 'qty', 3)).rejects.toThrow(/restore it first/);
      await g.restore('missing_part', id);
    });
    expect(ops.map((o) => o.kind)).toEqual(['create', 'set', 'set', 'link_add', 'delete', 'restore']);
    const id = ops[0]!.entity_id;
    expect(ops[5]!.base_op_id).toBe(ops[4]!.op_id);
    expect(await store.get('missing_part', id)).toMatchObject({ qty: 2, notes: 'Need to be ordered', deleted_at: null, version: 5 });
    expect(await store.list('part_source', { where: 'missing_part_id = ?', params: [id] })).toHaveLength(1);
  });

  it('writes nothing when one op of the group is refused by the store, or when the group is empty', async () => {
    const id = await newDevice();
    await expect(editor.group(SURVEY, async (g) => {
      await g.setField('device', id, 'status', 'Issue');
      // bypass the editor's checks to reach the store's own validation
      g.ops.push({ ...g.ops[0]!, op_id: uuidv7(), field: 'nope' });
    })).rejects.toThrow(/Unknown column/);
    expect((await store.get('device', id))!.status).toBe('Installed, untested');
    expect(await store.outboxCount()).toBe(1);
    expect(await editor.group(SURVEY, async () => {})).toEqual([]);
  });
});

describe('ops from two users on one store never share identity', () => {
  it('stamps each editor\'s user, same install', async () => {
    const zach = new Editor(store, { projectId: PROJECT, userId: ZACH, now: tsNext });
    const id = await newDevice();
    const op = await zach.setField('device', id, 'notes', 'per Zach', SURVEY);
    expect(op).toMatchObject({ user_id: ZACH, install_id: INSTALL });
    expect((await store.opsFor(id)).map((o) => o.user_id)).toEqual([LANDRY, ZACH]);
  });
});
