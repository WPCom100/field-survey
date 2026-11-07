import { Editor, OpError, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_07_ID, DEMO_LEVEL_ID, ensureDemoJumpExtras, ensureDemoLevel } from '../plan/demo';
import { SEED_VOCAB } from '../vocab/seed';
import { localDate, setItemNotes, setItemOwner, setPartStatus, setTrackingStatus } from './actions';
import { loadItem } from './model';

const ME = uuidv7();
const FS = { change_type: 'Field survey', reason: 'Field survey' } as const;

type Row = Record<string, unknown>;

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  await ensureDemoJumpExtras(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  let clock = 1_760_300_000_000;
  const editor = new Editor(store, { projectId: plan.level.projectId, userId: ME, now: () => new Date((clock += 1000)).toISOString() });
  const openPunch = (await store.list<Row>('punch_item', { where: `level_id = ? AND tracking_status = 'Open' AND device_id IS NOT NULL`, params: [DEMO_LEVEL_ID], orderBy: 'number' }))[0]!;
  const part = (await store.list<Row>('missing_part', { where: 'level_id = ?', params: [DEMO_LEVEL_ID], orderBy: 'number' }))[0]!;
  return { store, editor, plan, openPunch, part };
}

describe('punch item / part editor read model (T162)', () => {
  it('reads a punch item with its device, status, owner, the punch_note chips and an empty history', async () => {
    const { store, plan, openPunch } = await setup();
    const v = (await loadItem(store, 'punch', String(openPunch.id), DEMO_LEVEL_ID))!;
    const device = plan.devices.find((d) => d.id === openPunch.device_id)!;
    expect(v).toMatchObject({
      kind: 'punch',
      label: String(openPunch.number),
      title: 'Run, not terminated',
      sub: 'Termination',
      levelCode: '06M',
      status: 'Open',
      dateClosed: null,
      owner: openPunch.owner,
      deleted: false,
      rule: null,
      phrases: SEED_VOCAB.punch_note,
      device: { id: device.id, label: device.label, deleted: false, jump: { deviceId: device.id, label: device.label, sameLevel: true } },
    });
    // opened from another level's plan, the device jump opens 06M
    expect((await loadItem(store, 'punch', String(openPunch.id), DEMO_LEVEL_07_ID))!.device!.jump!.sameLevel).toBe(false);
    expect(await loadItem(store, 'punch', uuidv7(), DEMO_LEVEL_ID)).toBeNull();
  });

  it('reads a part: Part status (none reads Needed), part_note chips, project vocabulary first', async () => {
    const { store, editor, part } = await setup();
    const v = (await loadItem(store, 'part', String(part.id), DEMO_LEVEL_ID))!;
    expect(v).toMatchObject({ kind: 'part', title: 'DMX termination kit ×1', status: 'Needed', dateClosed: null, notes: 'Need to be ordered', deviceText: null, phrases: SEED_VOCAB.part_note });
    await editor.create('vocab', { project_id: editor.projectId, list: 'part_note', value: 'Left in the gang box' }, { change_type: 'Master edit', reason: 'test' });
    expect((await loadItem(store, 'part', String(part.id), DEMO_LEVEL_ID))!.phrases).toEqual(['Left in the gang box']);
  });
});

describe('punch item / part edits (T162)', () => {
  it('Closed stamps Date closed in the same group; reopening clears it; the same tap writes nothing', async () => {
    const { store, editor, openPunch } = await setup();
    const id = String(openPunch.id);
    const closed = await setTrackingStatus(editor, id, 'Closed', '2026-11-07');
    expect(closed).toHaveLength(2);
    expect(closed.map((o) => [o.field, o.was, o.now])).toEqual([
      ['tracking_status', 'Open', 'Closed'],
      ['date_closed', null, '2026-11-07'],
    ]);
    expect(closed[0]!.group_id).toBe(closed[1]!.group_id);
    expect(closed[0]).toMatchObject(FS);
    expect(await store.get<Row>('punch_item', id)).toMatchObject({ tracking_status: 'Closed', date_closed: '2026-11-07' });
    expect(await setTrackingStatus(editor, id, 'Closed', '2026-11-08')).toEqual([]); // already Closed: the date stands

    const progress = await setTrackingStatus(editor, id, 'In progress');
    expect(progress.map((o) => [o.field, o.now])).toEqual([
      ['tracking_status', 'In progress'],
      ['date_closed', null],
    ]);
    const v = (await loadItem(store, 'punch', id, DEMO_LEVEL_ID))!;
    expect(v).toMatchObject({ status: 'In progress', dateClosed: null });
    expect(v.pending).toEqual(new Set(['tracking_status', 'date_closed']));
    // History, newest first, in the item's own words
    expect(v.history.map((h) => [h.what, h.was, h.now])).toEqual([
      ['Date closed', '2026-11-07', '(blank)'],
      ['Tracking status', 'Closed', 'In progress'],
      ['Date closed', '(blank)', '2026-11-07'],
      ['Tracking status', 'Open', 'Closed'],
      ['(row added)', null, null],
    ]);
    expect(v.history[0]).toMatchObject({ changeType: 'Field survey', userId: ME, pending: true });
  });

  it('an item with no status reads Open: tapping Open writes nothing, Closed writes both fields', async () => {
    const { store, editor } = await setup();
    const { id } = await editor.create('punch_item', { level_id: DEMO_LEVEL_ID, item: 'Install cover', type: 'Information', owner: 'EC' }, FS);
    expect(await setTrackingStatus(editor, id, 'Open')).toEqual([]);
    expect((await setTrackingStatus(editor, id, 'Closed', '2026-11-07')).map((o) => [o.field, o.was])).toEqual([
      ['tracking_status', null],
      ['date_closed', null],
    ]);
    expect((await loadItem(store, 'punch', id, DEMO_LEVEL_ID))!).toMatchObject({ device: null, deviceText: null, status: 'Closed', dateClosed: '2026-11-07' });
  });

  it('Part status, Owner and Notes: one op each, none when unchanged; bad values and deleted items refused', async () => {
    const { store, editor, part, openPunch } = await setup();
    const id = String(part.id);
    expect(await setPartStatus(editor, id, 'Needed')).toBeNull(); // already Needed
    expect(await setPartStatus(editor, id, 'Ordered')).toMatchObject({ entity_kind: 'missing_part', field: 'part_status', was: 'Needed', now: 'Ordered', ...FS });
    expect(await setPartStatus(editor, id, 'Ordered')).toBeNull();
    expect(await setItemOwner(editor, 'part', id, 'EC/ETC')).toMatchObject({ field: 'owner', was: 'EC', now: 'EC/ETC' });
    expect(await setItemOwner(editor, 'part', id, 'EC/ETC')).toBeNull();
    expect(await setItemNotes(editor, 'part', id, '  Need to be ordered  ')).toBeNull(); // trimmed: unchanged
    expect(await setItemNotes(editor, 'part', id, '')).toMatchObject({ field: 'notes', was: 'Need to be ordered', now: null });
    expect(await setItemNotes(editor, 'punch', String(openPunch.id), 'Waiting on DMX Termination Kits')).toMatchObject({ entity_kind: 'punch_item', field: 'notes' });
    expect(await store.get<Row>('missing_part', id)).toMatchObject({ part_status: 'Ordered', owner: 'EC/ETC', notes: null });

    await expect(setPartStatus(editor, id, 'Lost' as never)).rejects.toThrow(OpError);
    await expect(setTrackingStatus(editor, String(openPunch.id), 'Done' as never)).rejects.toThrow(OpError);
    await expect(setItemOwner(editor, 'punch', String(openPunch.id), 'ETC/EC' as never)).rejects.toThrow(OpError);
    await editor.delete('punch_item', String(openPunch.id), { change_type: 'Correction', reason: 'test' });
    await expect(setTrackingStatus(editor, String(openPunch.id), 'Closed')).rejects.toThrow('deleted');
    expect((await loadItem(store, 'punch', String(openPunch.id), DEMO_LEVEL_ID))!.deleted).toBe(true);
  });

  it('localDate is the iPad calendar date', () => {
    expect(localDate(new Date(2026, 10, 7, 20, 30))).toBe('2026-11-07');
    expect(localDate(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});

describe('R3c address items in the editor (T162, D254)', () => {
  it('are recognised by text, kind and rule; the devices their Notes name are links per floor', async () => {
    const { store, editor, plan } = await setup();
    const [a, b] = plan.devices.filter((d) => /^06M-\d\d$/.test(d.label)).slice(0, 2).map((d) => d.label);
    const { id } = await editor.create(
      'punch_item',
      { level_id: DEMO_LEVEL_ID, item: 'Missing all Device Neuron IDs', type: 'Information', owner: 'EC', tracking_status: 'Open', sort_last: true, notes: `${a}, 07-S1, ${b}, 06M-?` },
      FS,
    );
    const v = (await loadItem(store, 'punch', id, DEMO_LEVEL_ID))!;
    expect(v.rule).toMatchObject({ kind: 'neuron', label: 'Neuron ID' });
    expect(v.rule!.missing.map((g) => [g.levelCode, g.devices.map((d) => [d.label, d.jump?.sameLevel ?? null])])).toEqual([
      ['06M', [[a, true], [b, true]]],
      ['07', [['07-S1', false]]],
      [null, [['06M-?', null]]],
    ]);

    const ip = await editor.create('punch_item', { level_id: DEMO_LEVEL_ID, item: 'Missing all Device IP addresses', type: 'Information', owner: 'ETC' }, FS);
    expect((await loadItem(store, 'punch', ip.id, DEMO_LEVEL_ID))!.rule).toMatchObject({ kind: 'ip', label: 'IP address', missing: [] });
    // an R3c item reworded by hand stays the Neuron item; an ordinary item is no rule's
    const reworded = await editor.create('punch_item', { level_id: DEMO_LEVEL_ID, item: 'Neuron IDs to collect', rule_id: 'R3c' }, FS);
    expect((await loadItem(store, 'punch', reworded.id, DEMO_LEVEL_ID))!.rule?.kind).toBe('neuron');
    const plain = await editor.create('punch_item', { level_id: DEMO_LEVEL_ID, item: 'Install cover' }, FS);
    expect((await loadItem(store, 'punch', plain.id, DEMO_LEVEL_ID))!.rule).toBeNull();
  });
});
