/**
 * The real rules over a store (T34): idempotent runs, R3c's upkeep as ops (D170), a cable draft
 * accepted into a cable with two ends (D173), a status draft accepted without copying anything
 * (D171), and the E6 / E7 / E9 quick actions.
 */

import { Editor, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from '../engine';
import type { ProposalRow } from '../snapshot';
import { RULES } from './index';
import { runQuickAction } from './quick';

const PROJECT = uuidv7();
const ME = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
let clock = 1_760_500_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

type Row = Record<string, unknown>;

async function project() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now: tsNext });
  const ids = { l06: uuidv7(), l06m: uuidv7(), group: uuidv7(), panel: uuidv7(), rack: uuidv7(), station: uuidv7(), bus: uuidv7(), fixtures: uuidv7() };
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l06, project_id: PROJECT, level: '06', floor_order: 7, numbering_group_id: ids.group, in_scope: true, surveyed: '2026-10-13' });
    await g.create('level', { id: ids.l06m, project_id: PROJECT, level: '06M', floor_order: 8, numbering_group_id: ids.group, in_scope: true, surveyed: '2026-10-13' });
    await g.create('device', { id: ids.panel, level_id: ids.l06m, display_id: '06M-01', category: 'Relay panel', device: 'CT06LCPA', panel_name: 'CT06LCPA', status: 'Installed, untested', room_location: 'XX06M-1E05 Elec Rm' });
    await g.create('device', { id: ids.rack, level_id: ids.l06, display_id: '06-01', category: 'Equipment rack', device: 'Equipment rack' });
    await g.create('device', { id: ids.station, level_id: ids.l06m, display_id: '06M-S1', category: 'Station', device: 'PI1002', room_location: 'Corridor XX06M-C006' });
    await g.create('placeholder', { id: ids.bus, project_id: PROJECT, label: 'Stations & Sensors', kind: 'station_bus' });
    await g.create('placeholder', { id: ids.fixtures, project_id: PROJECT, label: 'Fixtures', kind: 'fixtures' });
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now: tsNext });
  return { store, editor, engine, ids };
}

const open = async (store: Store) => store.list<ProposalRow>('proposal', { where: `project_id = ? AND state = 'proposed'`, params: [PROJECT], orderBy: 'rule_id, discriminator, id' });

describe('RULES over a store', () => {
  it('writes the drafts and findings once; a second run writes nothing', async () => {
    const { store, engine } = await project();
    const r1 = await engine.run();
    expect(r1.problems).toBe(0);
    expect(r1.ops).toBeGreaterThan(0);
    const rows = await open(store);
    // library drafts for the panel (0-10V, P) and the rack (120V), the Unison pair of 06 (06M has
    // no NSPS or rack to host one), the Neuron ID item
    expect(rows.map((p) => `${p.rule_id}:${p.discriminator ?? ''}`).sort()).toEqual(['R2c:0-10V', 'R2c:P', 'R2d:120V', 'R2e:U', 'R3c:'].sort());
    expect((await engine.run()).ops).toBe(0);
  });

  it('R3c: Accept makes the item; afterwards the engine keeps its Notes, closes and reopens it as "Rule engine R3c" ops (D170)', async () => {
    const { store, editor, engine, ids } = await project();
    await engine.run();
    const neuron = (await open(store)).find((p) => p.rule_id === 'R3c')!;
    expect(neuron.payload).toMatchObject({ level_id: ids.l06, item: 'Missing all Device Neuron IDs', notes: '06-01, 06M-01, 06M-S1', sort_last: true, device_text: 'All devices' });
    const res = await engine.decide(neuron.id, { kind: 'accept' });
    const itemId = res.recordIds[0]!;
    expect(await store.get<Row>('punch_item', itemId)).toMatchObject({ level_id: ids.l06, item: 'Missing all Device Neuron IDs', type: 'Information', owner: 'EC', tracking_status: 'Open', sort_last: true, rule_id: 'R3c', proposal_id: neuron.id, notes: '06-01, 06M-01, 06M-S1' });
    expect((await engine.run()).ops).toBe(0);
    // a capture → Notes rewritten by the engine, one op, naming the rule, carrying the proposal
    await editor.setField('device', ids.panel, 'neuron_id', '00A1B2C3D4E5', CTX);
    const r = await engine.run();
    expect(r).toMatchObject({ upkeep: 1, ops: 1 });
    const item = (await store.get<Row>('punch_item', itemId))!;
    expect(item.notes).toBe('06-01, 06M-S1');
    const ops = await store.opsFor(itemId);
    expect(ops.at(-1)).toMatchObject({ kind: 'set', field: 'notes', now: '06-01, 06M-S1', change_type: 'Field survey', reason: 'Rule engine R3c', proposal_id: neuron.id, user_id: ME });
    // the rewrite is not a person's Edit: the row stays accepted and the next run is quiet
    expect((await engine.run()).ops).toBe(0);
    expect(await store.get<ProposalRow>('proposal', neuron.id)).toMatchObject({ state: 'accepted' });
    // every ID captured → Closed with today's date
    await editor.setField('device', ids.rack, 'neuron_id', '00A1B2C3D4E6', CTX);
    await editor.setField('device', ids.station, 'neuron_id', '00A1B2C3D4E7', CTX);
    await engine.run();
    const closed = (await store.get<Row>('punch_item', itemId))!;
    expect(closed).toMatchObject({ notes: null, tracking_status: 'Closed' });
    expect(closed.date_closed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // a new device without an ID → reopened
    await editor.create('device', { level_id: ids.l06m, category: 'Sensor', device: 'UHCI-WM' }, CTX);
    await engine.run();
    expect(await store.get<Row>('punch_item', itemId)).toMatchObject({ notes: '06M-?', tracking_status: 'Open', date_closed: null });
    // the proposal row stays accepted throughout (no second item)
    expect(await store.get<ProposalRow>('proposal', neuron.id)).toMatchObject({ state: 'accepted' });
    expect((await store.list('punch_item', { where: 'level_id IN (?, ?)', params: [ids.l06, ids.l06m] })).length).toBe(1);
  });

  it('accepting a library draft (R2c) makes the cable with both ends; the device then has the code and the draft stays accepted', async () => {
    const { store, engine, ids } = await project();
    await engine.run();
    const p = (await open(store)).find((x) => x.rule_id === 'R2c' && x.discriminator === '0-10V')!;
    const res = await engine.decide(p.id, { kind: 'accept' });
    expect(res.recordIds).toHaveLength(3);
    const cable = (await store.get<Row>('cable', res.recordIds[0]!))!;
    expect(cable).toMatchObject({ cable: '0-10V', qty: 1, single_row: true, origin: 'library', project_id: PROJECT, end_a_id: res.recordIds[1], end_b_id: res.recordIds[2] });
    expect(await store.get<Row>('cable_end', res.recordIds[1]!)).toMatchObject({ side: 'A', device_id: ids.panel, from_text: 'CT06LCPA', to_text: 'Fixtures', status: null });
    expect(await store.get<Row>('cable_end', res.recordIds[2]!)).toMatchObject({ side: 'B', endpoint_kind: 'placeholder', placeholder_id: ids.fixtures });
    await engine.run();
    expect(await store.get<ProposalRow>('proposal', p.id)).toMatchObject({ state: 'accepted' });
    expect((await open(store)).some((x) => x.rule_id === 'R2c' && x.discriminator === '0-10V')).toBe(false);
    // the new unsurveyed 0-10V end has no status and gets none from anywhere (D171); the Issue
    // panel-side rules say nothing about it until someone surveys it
    expect((await open(store)).filter((x) => x.subject?.entity_id === res.recordIds[1])).toEqual([]);
  });

  it('a status draft (R2f) accepted sets the end derived, never copying the other end', async () => {
    const { store, editor, engine, ids } = await project();
    const l09 = uuidv7();
    const far = uuidv7();
    const endA = uuidv7();
    const endB = uuidv7();
    await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
      await g.create('level', { id: l09, project_id: PROJECT, level: '09', floor_order: 9, numbering_group_id: uuidv7(), in_scope: false });
      await g.create('device', { id: far, level_id: l09, display_id: '09-01', category: 'Equipment rack' });
      const cable = uuidv7();
      await g.create('cable', { id: cable, project_id: PROJECT, cable: 'N', end_a_id: endA, end_b_id: endB });
      await g.create('cable_end', { id: endA, cable_id: cable, side: 'A', endpoint_kind: 'device', device_id: ids.panel, level_id: ids.l06m, to_text: 'Network to Level 09', status: 'Issue', note: 'Run, not terminated', status_source: 'surveyed', surveyed_at: tsNext() });
      await g.create('cable_end', { id: endB, cable_id: cable, side: 'B', endpoint_kind: 'device', device_id: far, level_id: l09 });
    });
    await engine.run();
    const rows = await open(store);
    const r2f = rows.filter((p) => p.rule_id === 'R2f');
    expect(r2f.map((p) => p.subject?.entity_id)).toEqual([endB]); // the surveyed near end is left alone
    const res = await engine.decide(r2f[0]!.id, { kind: 'accept' });
    expect(res.recordIds).toEqual([]);
    expect(await store.get<Row>('cable_end', endB)).toMatchObject({ status: 'Not started', status_source: 'derived', note: null, surveyed_by_id: null });
    await engine.run();
    expect(await store.get<ProposalRow>('proposal', r2f[0]!.id)).toMatchObject({ state: 'accepted' });
    // the near end's Issue produced its Termination draft, nothing was copied to or from it
    expect(rows.map((p) => p.payload?.item).filter(Boolean)).toContain('Terminate network to Level 09');
  });
});

describe('quick actions E6 / E7 / E9', () => {
  it('E6 writes a Closed Information item for ETC with the master\'s note; E7 marks the device Not installed and asks to confirm; E9 appends the move', async () => {
    const { store, editor, ids } = await project();
    const e6 = await runQuickAction(editor, ids.station, { kind: 'E6', found: 'Wagos used like wire nuts' }, () => '2026-10-15T14:00:00.000Z');
    expect(await store.get<Row>('punch_item', e6.punchItemId!)).toMatchObject({
      level_id: ids.l06m, device_id: ids.station, item: 'Spot check: Wagos used like wire nuts', type: 'Information', owner: 'ETC', tracking_status: 'Closed', date_closed: '2026-10-15', notes: 'Reterminated - all good', rule_id: 'E6',
    });
    expect(e6.ops.every((o) => o.reason === 'Quick action E6: Spot-check fixed' && o.change_type === 'Field survey')).toBe(true);
    expect((await store.get<Row>('device', ids.station))!.notes).toBeNull(); // device Notes untouched

    const sensor = (await editor.create('device', { level_id: ids.l06m, category: 'Sensor', device: 'P-DOC-C-LR', notes: 'Ceiling open' }, CTX)).id;
    const e7 = await runQuickAction(editor, sensor, { kind: 'E7', make: 'Wattstopper' });
    expect(await store.get<Row>('device', sensor)).toMatchObject({ status: 'Not installed', notes: 'Ceiling open; Not Installed; installed sensor at location appears to be a Wattstopper, confirm.' });
    expect(await store.get<Row>('punch_item', e7.punchItemId!)).toMatchObject({ item: 'Confirm existing sensor at location is a Wattstopper, not a P-DOC-C-LR', type: 'Information', owner: 'EC', tracking_status: 'Open', rule_id: 'E7', device_id: sensor });
    expect(new Set(e7.ops.map((o) => o.group_id)).size).toBe(1);
    await expect(runQuickAction(editor, sensor, { kind: 'E7', make: '  ' })).rejects.toThrow(/what make/);

    const e9 = await runQuickAction(editor, ids.station, { kind: 'E9', room: 'Corridor XX06M-C007' });
    expect(e9.punchItemId).toBeNull();
    expect((await store.get<Row>('device', ids.station))!.room_location).toBe('Corridor XX06M-C007; moved from Corridor XX06M-C006');
    await expect(runQuickAction(editor, uuidv7(), { kind: 'E9', room: 'x' })).rejects.toThrow(/not on this iPad/);
  });
});
