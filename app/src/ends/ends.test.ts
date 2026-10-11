import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_07_ID, DEMO_LEVEL_ID, ensureDemoCardExtras, ensureDemoJumpExtras, ensureDemoLevel } from '../plan/demo';
import { setEndNote, setEndStatus, setEndText } from './actions';
import { CONNECTION_PHRASES, loadCableEnds, riserCheck } from './model';

const ME = uuidv7();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  await ensureDemoCardExtras(store);
  await ensureDemoJumpExtras(store);
  await ensureDemoJumpExtras(store); // idempotent
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  let clock = 1_760_300_000_000;
  const editor = new Editor(store, { projectId: plan.level.projectId, userId: ME, now: () => new Date((clock += 1000)).toISOString() });
  const panel = plan.devices.find((d) => d.label === '06M-01')!;
  const card = (await loadDeviceCard(store, panel.id))!;
  const end = (label: string) => card.connections.find((c) => c.label === label)!;
  return { store, editor, panel, card, end };
}

describe('riser label check (T22)', () => {
  it('matches leniently but needs every riser word in order', () => {
    expect(riserCheck('DMX TO LEVEL 03 UFMP', 'DMX to Level 3 UFMP4s')).toEqual({ state: 'match', riser: 'DMX TO LEVEL 03 UFMP' });
    expect(riserCheck('DMX TO 06M-03', 'DMX to 06M-03')).toMatchObject({ state: 'match' });
    expect(riserCheck('UNISON TO 06M STATIONS', 'Stations & Sensors')).toMatchObject({ state: 'differs', to: 'Stations & Sensors' });
    expect(riserCheck('DMX TO LEVEL 03', 'Level 03 DMX')).toMatchObject({ state: 'differs' }); // order matters
    expect(riserCheck('DMX TO LEVEL 03', null)).toMatchObject({ state: 'differs', to: null });
    expect(riserCheck(null, 'x')).toEqual({ state: 'none' });
    expect(riserCheck('  ', 'x')).toEqual({ state: 'none' });
  });
});

describe('connection end editor (T22)', () => {
  it('stacks this end first, then the far end on another level with a jump to it', async () => {
    const { store, end } = await setup();
    const v = (await loadCableEnds(store, end('C-11').id))!;
    expect(v).toMatchObject({ code: 'N', vertical: 'V1', riserToLabel: 'NETWORK TO LEVEL 07 RACK', riser: { state: 'match' }, phrases: CONNECTION_PHRASES });
    const [mine, other] = v.ends;
    expect(mine).toMatchObject({ label: 'C-11', side: 'A', levelCode: '06M', toText: 'Network to Level 07 rack', status: 'Installed, untested', endpoint: { kind: 'device', label: '06M-01' } });
    expect(other).toMatchObject({ label: 'C-01', side: 'B', levelCode: '07', fromText: 'Network from Level 06M 06M-01', status: null });
    expect(other!.endpoint).toMatchObject({ kind: 'device', label: '07-01', levelCode: '07' });
    expect(other!.jump).toMatchObject({ levelId: DEMO_LEVEL_07_ID, label: '07-01', sameLevel: false });
    // opened from the far end, the 06M end is "other" and its jump stays on… 06M, i.e. another level
    const back = (await loadCableEnds(store, other!.id))!;
    expect(back.ends[0].label).toBe('C-01');
    expect(back.ends[1]!.jump).toMatchObject({ levelId: DEMO_LEVEL_ID, label: '06M-01', sameLevel: false });
  });

  it('shows a same-level far end, a placeholder end, and a riser label that differs', async () => {
    const { store, end } = await setup();
    const dmx = (await loadCableEnds(store, end('C-03').id))!;
    expect(dmx.riser).toMatchObject({ state: 'match', riser: 'DMX TO 06M-03' });
    expect(dmx.ends[1]!.jump).toMatchObject({ label: '06M-03', sameLevel: true });
    const tenV = (await loadCableEnds(store, end('C-08').id))!;
    expect(tenV.singleRow).toBe(true);
    expect(tenV.ends[1]!.endpoint).toEqual({ kind: 'placeholder', label: 'Fixtures' });
    expect(tenV.ends[1]!.jump).toBeNull();
    const uni = (await loadCableEnds(store, end('NEW').id))!;
    expect(uni.riser).toMatchObject({ state: 'differs', riser: 'UNISON TO 06M STATIONS', to: 'Stations & Sensors' });
  });

  it('a status tap writes status, surveyor, time and source as one group; repeating it writes nothing', async () => {
    const { store, editor, end } = await setup();
    const far = (await loadCableEnds(store, end('C-11').id))!.ends[1]!;
    const ops = await setEndStatus(editor, far.id, 'Issue', '2026-10-10T15:00:00.000Z');
    expect(ops.map((o) => o.field).sort()).toEqual(['status', 'status_source', 'surveyed_at', 'surveyed_by_id']);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(ops[0]).toMatchObject({ change_type: 'Field survey', reason: 'Field survey' });
    const after = (await loadCableEnds(store, end('C-11').id))!.ends[1]!;
    expect(after).toMatchObject({ status: 'Issue', statusSource: 'surveyed', surveyedBy: ME, surveyedAt: '2026-10-10T15:00:00.000Z' });
    expect(after.pending.has('status')).toBe(true);
    expect(await setEndStatus(editor, far.id, 'Issue')).toEqual([]);
    await expect(setEndStatus(editor, far.id, 'Bogus' as never)).rejects.toThrow(/Not a connection status/);
  });

  it('edits note and From/To text (D32) one op each, trimmed, empty clears', async () => {
    const { store, editor, end } = await setup();
    const id = end('C-03').id;
    expect(await setEndNote(editor, id, '  Reterminated - all good ')).toMatchObject({ field: 'note', now: 'Reterminated - all good' });
    expect(await setEndNote(editor, id, 'Reterminated - all good')).toBeNull();
    expect(await setEndText(editor, id, 'to_text', 'DMX to 06M-03 EBDK')).toMatchObject({ field: 'to_text', was: 'DMX to 06M-03' });
    expect(await setEndText(editor, id, 'from_text', '')).toBeNull(); // was empty already
    const v = (await loadCableEnds(store, id))!;
    expect(v.ends[0]).toMatchObject({ note: 'Reterminated - all good', toText: 'DMX to 06M-03 EBDK' });
    expect(v.riser.state).toBe('match'); // riser words still all there, in order
    await setEndText(editor, id, 'to_text', '   ');
    expect((await loadCableEnds(store, id))!.ends[0].toText).toBeNull();
  });

  it('level 07 has a display sheet whose bytes are not on the iPad, and its devices load', async () => {
    const { store } = await setup();
    const p07 = (await loadLevelPlan(store, DEMO_LEVEL_07_ID))!;
    expect(p07.level.code).toBe('07');
    expect(p07.sheet?.blob).toMatch(/^f{64}$/);
    expect(p07.devices.map((d) => d.label)).toEqual(['07-01', '07-02', '07-S1']);
  });
});
