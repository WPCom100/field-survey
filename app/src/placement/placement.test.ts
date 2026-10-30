/**
 * Place devices (T46, Phase 3 §3.4, D205): the unplaced list (pinless devices, draft units left
 * after the master's devices that stand for them, the pool), the dashed proposals from the
 * sheet's text tags, placing a device / a draft unit / a pooled unit (type, role, accessories,
 * the waiting cable), the not-on-this-sheet flag, and the progress per level.
 */

import { Editor, OpError, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLockTable, lockQuestion, lockWarnings } from '../setup/lock';
import { flagNotOnSheet, perUnit, placeItem } from './actions';
import { itemLine, itemsIn, loadPlacementProgress, loadUnplaced, rolesIn, tagProposals, type UnplacedDraft, type UnplacedItem } from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_900_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const ids = {
    l02: uuidv7(), l06m: uuidv7(), l09: uuidv7(), s06m: uuidv7(), s02: uuidv7(),
    panel: uuidv7(), rack: uuidv7(), sensor: uuidv7(), pinned: uuidv7(), tPI: uuidv7(),
    dPanel: uuidv7(), dRack: uuidv7(), dSensor: uuidv7(), dUfmp: uuidv7(), dPool: uuidv7(), dOpen: uuidv7(), d09: uuidv7(), dNew: uuidv7(),
    cable: uuidv7(),
  };
  const ops: Op[] = [];
  let seq = 0;
  const create = (entity_kind: Op['entity_kind'], payload: Record<string, unknown>) => {
    const { id, ...rest } = payload;
    const ts = now();
    ops.push({ op_id: uuidv7(), project_id: PROJECT, user_id: ME, install_id: 'server', client_ts: ts, server_seq: ++seq, server_ts: ts, entity_kind, entity_id: String(id), kind: 'create', payload: rest, change_type: 'Master edit', reason: 'seed', state: 'applied' } as Op);
  };
  create('project', { id: PROJECT, name: 'Tower' });
  create('level', { id: ids.l02, project_id: PROJECT, level: '02', floor_order: 1, numbering_group_id: uuidv7(), in_scope: true });
  create('level', { id: ids.l06m, project_id: PROJECT, level: '06M', floor_order: 2, numbering_group_id: uuidv7(), in_scope: true });
  create('level', { id: ids.l09, project_id: PROJECT, level: '09', floor_order: 3, numbering_group_id: uuidv7(), in_scope: false });
  // the app library has the station; the project nothing
  create('library_type', { id: ids.tPI, project_id: null, model: 'PI1002', category: 'Station', role: 'station', state: 'accepted' });
  // the master's 06M devices, none pinned but one
  create('device', { id: ids.panel, level_id: ids.l06m, display_id: '06M-04', category: 'Relay panel', device: 'ERP48', panel_name: 'CT06LCPA', drawing_position: 'Grid C / 9' });
  create('device', { id: ids.rack, level_id: ids.l06m, display_id: '06M-01', category: 'Equipment rack', device: 'Equipment Rack 18U' });
  create('device', { id: ids.sensor, level_id: ids.l06m, display_id: '06M-D1', category: 'Sensor', device: 'P-DOC-C-LR' });
  create('device', { id: ids.pinned, level_id: ids.l06m, display_id: '06M-S1', category: 'Station', device: 'PI1004', pin: { sheet: ids.s06m, x: 100, y: 100 } });

  const dd = (id: string, f: Record<string, unknown>) => create('draft_device', { id, project_id: PROJECT, state: 'accepted', confidence: 0.9, ...f });
  // stands for the master's panel by its tag, the rack as the only rack of the level
  dd(ids.dPanel, { level_id: ids.l06m, model: 'ERP48-FT-481P', name: 'CT06LCPA', category: 'Power Distribution', role: 'relay_panel', qty: 1 });
  dd(ids.dRack, { level_id: ids.l06m, model: 'ERN4-RM-120', name: 'Equipment Rack 18U', category: 'Equipment Panels', role: 'equipment_rack', qty: 1 });
  // three sensors where the master has one: two to place
  dd(ids.dSensor, { level_id: ids.l06m, model: 'P-DOC-C-LR', category: 'Sensor', role: 'sensor', qty: 3 });
  // a Foundry panel on 02, an end of a waiting cable
  dd(ids.dUfmp, { level_id: ids.l02, model: 'UFMP4', category: 'Power Distribution', role: 'foundry_panel', qty: 1, accessories: [{ model: 'ERM VDK', qty: 1, role: 'accessory' }] });
  // the pool: stations with their faceplates, three of them
  dd(ids.dPool, { level_id: null, model: 'PI1002', category: 'Station', qty: 3, accessories: [{ model: '1IFP', qty: 3, role: 'accessory' }, { model: 'X-ODD', qty: 2, role: 'accessory' }] });
  // not placed: still proposed; a floor the project lacks
  dd(ids.dOpen, { level_id: ids.l06m, model: 'UFMP8', category: 'Power Distribution', qty: 1, state: 'proposed' });
  dd(ids.d09, { level_id: null, model: 'PI1002', category: 'Station', qty: 8, source_ref: { kind: 'riser_symbol', level_code: '09', page: 1 } });
  // NSPS the library lacks
  dd(ids.dNew, { level_id: ids.l02, model: 'P-NSPS-D', category: 'Equipment', role: 'nsps', qty: 2 });
  // accepted cable 06M panel → 02 UFMP4, waiting for the UFMP4
  create('draft_cable', {
    id: ids.cable, project_id: PROJECT, level_id: ids.l06m, to_level_id: ids.l02, code: 'X', qty: 1, origin: 'riser', state: 'accepted', from_label: 'CT06LCPA', to_label: 'UFMP4',
    candidates: [{ side: 'from', kind: 'draft_device', id: ids.dPanel, label: 'CT06LCPA' }, { side: 'to', kind: 'draft_device', id: ids.dUfmp, label: 'UFMP4' }],
  });
  for (const r of await store.applyRemoteMany(ops)) if (r.outcome !== 'applied') throw new Error(`seed op ${r.outcome}`);
  return { store, editor, ids };
}

const keyOf = (items: readonly UnplacedItem[]) => items.map((i) => i.key);
const draftOf = (items: readonly UnplacedItem[], id: string) => items.find((i) => i.kind === 'draft' && i.draftId === id) as UnplacedDraft;

describe('unplaced list (T46)', () => {
  it('lists pinless devices, the draft units the master does not stand for, then the pool', async () => {
    const { store, ids } = await setup();
    const u = (await loadUnplaced(store, PROJECT, ids.l06m))!;
    // the panel, rack and sensor have no pin; the station is pinned
    expect(keyOf(u.items.filter((i) => i.kind === 'device'))).toEqual([`device:${ids.rack}`, `device:${ids.panel}`, `device:${ids.sensor}`]);
    // the panel and rack drafts are the master's devices; the sensor draft has 2 left; the pool 3; nothing proposed or for 09
    expect(keyOf(u.items.filter((i) => i.kind === 'draft'))).toEqual([`draft:${ids.dSensor}`, `draft:${ids.dPool}`]);
    const sensor = draftOf(u.items, ids.dSensor);
    expect(sensor).toMatchObject({ qty: 3, covered: 1, placed: 0, remaining: 2, pool: false, role: 'sensor', deviceCategory: 'Sensor' });
    const pool = draftOf(u.items, ids.dPool);
    expect(pool).toMatchObject({ pool: true, remaining: 3, role: 'station', libraryTypeId: ids.tPI });
    expect(itemLine(pool)).toBe('PI1002 · pool ×3');
    expect(itemLine(u.items[1]!)).toBe('06M-04 · CT06LCPA');
    expect(u.progress).toMatchObject({ code: '06M', devices: 4, placed: 1, unplacedDevices: 3, draftUnits: 2, flagged: 0 });
    // filters
    expect(keyOf(itemsIn(u, 'pool'))).toEqual([`draft:${ids.dPool}`]);
    expect(itemsIn(u, 'level').length).toBe(4);
    expect(keyOf(itemsIn(u, 'level', 'sensor'))).toEqual([`device:${ids.sensor}`, `draft:${ids.dSensor}`]);
    expect(rolesIn(u)).toEqual(['equipment_rack', 'relay_panel', 'sensor', 'station']);
    // an out-of-scope level is not offered the pool
    expect((await loadUnplaced(store, PROJECT, ids.l09))!.items).toEqual([]);
  });

  it('never offers a draft whose model is an accessory-only type (T126)', async () => {
    const { store, editor, ids } = await setup();
    const before = (await loadPlacementProgress(store, PROJECT)).levels.find((l) => l.levelId === ids.l06m)!;
    const tAcc = uuidv7();
    // the catalogue's 8 Outlet Strip, matched by alias; accepted as a device before T126
    await editor.create('library_type', { id: tAcc, project_id: null, model: 'SGE1552', aliases: ['8 Outlet Strip'], accessory_only: true, state: 'draft' }, { change_type: 'Master edit', reason: 'test' });
    const dAcc = (await editor.create('draft_device', { project_id: PROJECT, level_id: ids.l06m, model: '8 Outlet Strip', category: 'Equipment', qty: 2, state: 'accepted' }, { change_type: 'Master edit', reason: 'test' })).id;
    const u = (await loadUnplaced(store, PROJECT, ids.l06m))!;
    expect(u.items.some((i) => i.key === `draft:${dAcc}`)).toBe(false);
    expect(u.flagged.some((i) => i.key === `draft:${dAcc}`)).toBe(false);
    const after = (await loadPlacementProgress(store, PROJECT)).levels.find((l) => l.levelId === ids.l06m)!;
    expect(after.draftUnits).toBe(before.draftUnits);
  });

  it('places a device of the baseline: its pin and the fields that change, then it leaves the list', async () => {
    const { store, editor, ids } = await setup();
    const u = (await loadUnplaced(store, PROJECT, ids.l06m))!;
    const panel = u.items.find((i) => i.key === `device:${ids.panel}`)!;
    const r = await placeItem(editor, store, panel, { levelId: ids.l06m, sheetId: ids.s06m, at: { x: 512.34, y: 300.06 }, drawingPosition: 'Grid C / 9', room: 'Elec Rm XX06M-1E05', panelName: 'CT06LCPA' });
    expect(r).toMatchObject({ deviceId: ids.panel, created: false });
    // pin and room written; the Drawing Position and tag were unchanged
    expect(r.ops.map((o) => o.field).sort()).toEqual(['pin', 'room_location']);
    expect(r.ops.every((o) => o.change_type === 'Master edit' && o.reason === 'Place devices: 06M-04' && o.group_id === r.ops[0]!.group_id)).toBe(true);
    const dev = await store.get<Record<string, unknown>>('device', ids.panel);
    expect(dev).toMatchObject({ pin: { sheet: ids.s06m, x: 512.3, y: 300.1 }, room_location: 'Elec Rm XX06M-1E05', drawing_position: 'Grid C / 9' });
    const after = (await loadUnplaced(store, PROJECT, ids.l06m))!;
    expect(after.items.some((i) => i.key === panel.key)).toBe(false);
    expect(after.progress).toMatchObject({ placed: 2, unplacedDevices: 2 });
  });

  it('places a draft unit: a device from the draft, its type and role, no ID, the waiting cable made', async () => {
    const { store, editor, ids } = await setup();
    const u = (await loadUnplaced(store, PROJECT, ids.l02))!;
    const ufmp = draftOf(u.items, ids.dUfmp);
    expect(ufmp).toMatchObject({ remaining: 1, role: 'foundry_panel', libraryTypeId: null });
    const r = await placeItem(editor, store, ufmp, { levelId: ids.l02, sheetId: ids.s02, at: { x: 40, y: 50 }, drawingPosition: 'Grid A / 1', room: null, panelName: null });
    expect(r.created).toBe(true);
    const dev = await store.get<Record<string, unknown>>('device', r.deviceId);
    expect(dev).toMatchObject({ level_id: ids.l02, baseline_ref_id: ids.dUfmp, device: 'UFMP4', category: 'Power Distribution', origin: 'baseline', drawing_position: 'Grid A / 1', pin: { sheet: ids.s02, x: 40, y: 50 } });
    expect(dev!.display_id ?? null).toBeNull();
    // no library type for UFMP4: a draft project type carrying the draft's role
    const type = await store.get<Record<string, unknown>>('library_type', String(dev!.library_type_id));
    expect(type).toMatchObject({ project_id: PROJECT, model: 'UFMP4', role: 'foundry_panel', state: 'draft' });
    const acc = await store.list<Record<string, unknown>>('accessory', { where: 'device_id = ?', params: [r.deviceId] });
    expect(acc.map((a) => [a.model, a.expected_qty])).toEqual([['ERM VDK', 1]]);
    // the cable waiting on it is made (its other end is the master's panel, by its tag)
    expect(r.cablesMade).toBe(1);
    const cables = await store.list<Record<string, unknown>>('cable', { where: 'project_id = ?', params: [PROJECT] });
    expect(cables).toHaveLength(1);
    expect((await loadUnplaced(store, PROJECT, ids.l02))!.items.some((i) => i.key === ufmp.key)).toBe(false);
    // placing it again is refused before anything is written
    await expect(placeItem(editor, store, { ...ufmp, remaining: 0 }, { levelId: ids.l02, sheetId: ids.s02, at: { x: 1, y: 1 } })).rejects.toThrow(OpError);
    // a level's draft goes on its own level's plan only
    const sensor = draftOf((await loadUnplaced(store, PROJECT, ids.l06m))!.items, ids.dSensor);
    await expect(placeItem(editor, store, sensor, { levelId: ids.l02, sheetId: ids.s02, at: { x: 1, y: 1 } })).rejects.toThrow(/another level/);
  });

  it('a pooled unit takes the level of the sheet and counts the pool down on every level', async () => {
    const { store, editor, ids } = await setup();
    const place = async (levelId: string, sheetId: string) => {
      const pool = draftOf((await loadUnplaced(store, PROJECT, levelId))!.items, ids.dPool);
      return placeItem(editor, store, pool, { levelId, sheetId, at: { x: 10, y: 10 } });
    };
    const a = await place(ids.l06m, ids.s06m);
    const dev = await store.get<Record<string, unknown>>('device', a.deviceId);
    expect(dev).toMatchObject({ level_id: ids.l06m, baseline_ref_id: ids.dPool, library_type_id: ids.tPI, category: 'Station', device: 'PI1002' });
    // faceplates 3 for 3 stations → 1 each; 2 for 3 does not divide → left to count
    const acc = await store.list<Record<string, unknown>>('accessory', { where: 'device_id = ?', params: [a.deviceId], orderBy: 'model' });
    expect(acc.map((x) => [x.model, x.expected_qty ?? null])).toEqual([['1IFP', 1], ['X-ODD', null]]);
    expect(draftOf((await loadUnplaced(store, PROJECT, ids.l02))!.items, ids.dPool).remaining).toBe(2);
    await place(ids.l02, ids.s02);
    await place(ids.l02, ids.s02);
    expect(draftOf((await loadUnplaced(store, PROJECT, ids.l06m))!.items, ids.dPool)).toBeUndefined();
    expect((await loadPlacementProgress(store, PROJECT)).pool).toEqual({ draftUnits: 0, flagged: 0 });
    expect(perUnit({ qty: 4 }, 1)).toBe(4);
    expect(perUnit({ qty: null }, 2)).toBeNull();
  });

  it('a model the library lacks becomes a draft type with the role; the second unit reuses it', async () => {
    const { store, editor, ids } = await setup();
    const nsps = draftOf((await loadUnplaced(store, PROJECT, ids.l02))!.items, ids.dNew);
    expect(nsps.role).toBe('nsps');
    const r = await placeItem(editor, store, nsps, { levelId: ids.l02, sheetId: ids.s02, at: { x: 5, y: 5 } });
    const dev = await store.get<Record<string, unknown>>('device', r.deviceId);
    const again = draftOf((await loadUnplaced(store, PROJECT, ids.l02))!.items, ids.dNew);
    expect(again).toMatchObject({ remaining: 1, libraryTypeId: dev!.library_type_id, role: 'nsps' });
    const r2 = await placeItem(editor, store, again, { levelId: ids.l02, sheetId: ids.s02, at: { x: 50, y: 5 } });
    expect((await store.get<Record<string, unknown>>('device', r2.deviceId))!.library_type_id).toBe(dev!.library_type_id);
    const types = await store.list<Record<string, unknown>>('library_type', { where: `model = 'P-NSPS-D'` });
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ id: dev!.library_type_id, role: 'nsps', category: 'Equipment', state: 'draft' });
  });

  it('flag not on this sheet: out of the list into Flagged, counted, and back', async () => {
    const { store, editor, ids } = await setup();
    const sensor = draftOf((await loadUnplaced(store, PROJECT, ids.l06m))!.items, ids.dSensor);
    const op = await flagNotOnSheet(editor, sensor, true);
    expect(op).toMatchObject({ entity_kind: 'draft_device', field: 'not_on_sheet', change_type: 'Master edit' });
    const u = (await loadUnplaced(store, PROJECT, ids.l06m))!;
    expect(u.items.some((i) => i.key === sensor.key)).toBe(false);
    expect(keyOf(itemsIn(u, 'flagged'))).toEqual([sensor.key]);
    expect(u.progress).toMatchObject({ draftUnits: 0, flagged: 1 });
    await flagNotOnSheet(editor, draftOf(u.flagged, ids.dSensor), false);
    expect((await loadUnplaced(store, PROJECT, ids.l06m))!.items.some((i) => i.key === sensor.key)).toBe(true);
  });

  it('the Lock table counts drafts, flags and unconfirmed cables, and warns of unreviewed drafts', async () => {
    const { store, editor, ids } = await setup();
    await flagNotOnSheet(editor, draftOf((await loadUnplaced(store, PROJECT, ids.l06m))!.items, ids.dSensor), true);
    const ufmp = draftOf((await loadUnplaced(store, PROJECT, ids.l02))!.items, ids.dUfmp);
    await placeItem(editor, store, ufmp, { levelId: ids.l02, sheetId: ids.s02, at: { x: 40, y: 50 } });
    const t = await loadLockTable(store, PROJECT);
    const l06m = t.find((l) => l.id === ids.l06m)!;
    // one proposed draft (UFMP8), the flagged sensors, the cable made unconfirmed with an end here
    expect(l06m).toMatchObject({ drafts: 1, flagged: 1, cablesUnconfirmed: 1, toPlace: 0 });
    expect(lockWarnings(l06m)).toEqual(['3 devices not placed', '1 unreviewed draft']);
    const l02 = t.find((l) => l.id === ids.l02)!;
    expect(l02).toMatchObject({ drafts: 0, flagged: 0, cablesUnconfirmed: 1, toPlace: 2 });
    expect(lockQuestion(l02)).toBe('Lock 02 with 2 draft devices to place?');
  });
});

describe('proposals from the sheet text tags (T46)', () => {
  const item = (key: string, f: Partial<UnplacedDraft>): UnplacedItem =>
    ({ kind: 'draft', key, draftId: key, levelId: 'L', pool: false, title: key, model: null, name: null, category: null, role: 'relay_panel', panelName: null, qty: 1, placed: 0, covered: 0, remaining: 1, notOnSheet: false, libraryTypeId: null, deviceCategory: null, accessories: [], ...f }) as UnplacedDraft;

  it('proposes a panel at its tag, merges repeated tags, skips taken tags and stations', () => {
    const items = [
      item('a', { panelName: 'CT06LCPA', model: 'ERP48-FT-481P' }),
      item('b', { model: 'EBDK', role: 'ebdk', remaining: 2 }),
      item('c', { model: 'P-NSPS-D', role: 'nsps' }),
      item('d', { model: 'UFMP8', role: 'foundry_panel' }),
      item('s', { model: 'PI1002', role: 'station' }),
    ];
    const tags = [
      { text: 'CT06LCPA', x: 100, y: 100 },
      { text: 'CT06LCPA', x: 101, y: 102 }, // the composite prints it twice
      { text: 'EBDK', x: 300, y: 100 },
      { text: 'EBDK', x: 900, y: 100 },
      { text: 'EBDK', x: 1500, y: 100 },
      { text: 'NSPS', x: 50, y: 400 },
      { text: 'UFMP8', x: 700, y: 700 }, // next to a pin already on the sheet
      { text: 'PI1002', x: 10, y: 10 },
    ];
    const p = tagProposals({ tags }, items, [{ x: 710, y: 705 }]);
    expect(p.map((x) => [x.itemKey, x.tag, x.at.x])).toEqual([
      ['a', 'CT06LCPA', 100],
      ['b', 'EBDK', 300],
      ['b', 'EBDK', 900],
      ['c', 'NSPS', 50],
    ]);
    // the exact tag goes before a model part: ERP48 is a part of a's model, but a is already proposed
    const q = tagProposals({ tags: [{ text: 'ERP48', x: 5, y: 5 }] }, [item('a', { model: 'ERP48-FT-481P' })], []);
    expect(q.map((x) => x.itemKey)).toEqual(['a']);
  });
});
