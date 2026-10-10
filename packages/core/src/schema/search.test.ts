import { describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from '../node';
import { Store } from '../store';
import type { Op } from '../op';
import { uuidv7 } from '../ids';
import { ftsQuery } from './search';

const PROJECT = uuidv7();
const USER = uuidv7();
const LEVEL = uuidv7();
const OTHER_LEVEL = uuidv7();

function create(kind: Op['entity_kind'], payload: Record<string, unknown>): Op {
  return {
    op_id: uuidv7(),
    project_id: PROJECT,
    user_id: USER,
    install_id: 'i',
    client_ts: new Date().toISOString(),
    entity_kind: kind,
    entity_id: uuidv7(),
    kind: 'create',
    payload,
    change_type: 'Field survey',
  };
}

async function seeded(search: 'auto' | 'like'): Promise<Store> {
  const store = await Store.open(new BetterSqliteDriver(), { search });
  await store.applyMany([
    create('level', { project_id: PROJECT, level: '06M', numbering_group_id: 'g' }),
    create('device', { level_id: LEVEL, display_id: '06M-04', category: 'Relay panel', room_location: 'ELEC 6M-01', notes: 'Empty box on wall.' }),
    create('device', { level_id: LEVEL, display_id: '06M-S3', category: 'Station', neuron_id: '00A1B2C3D4E5' }),
    create('device', { level_id: OTHER_LEVEL, display_id: '02-04', category: 'Relay panel' }),
    create('punch_item', { level_id: LEVEL, item: 'Run DMX to 06M-04', type: 'Cable not run', owner: 'EC' }),
    create('missing_part', { level_id: LEVEL, part: 'DMX termination kit', owner: 'EC', notes: 'Need to be ordered' }),
    create('photo', { level_id: LEVEL, subject: 'Relay panel interior', what_it_shows: 'wire nuts' }),
  ]);
  return store;
}

describe.each(['auto', 'like'] as const)('search (%s)', (mode) => {
  it('uses the expected mode', async () => {
    const store = await seeded(mode);
    expect(store.searchMode).toBe(mode === 'auto' ? 'fts5' : 'like');
    expect(await store.getState('search_mode')).toBe(store.searchMode);
  });

  it('finds devices by ID, room, notes and Neuron ID', async () => {
    const store = await seeded(mode);
    const kinds = async (q: string) => (await store.search(q)).map((h) => h.entity_kind);
    expect(await kinds('06M-04')).toEqual(expect.arrayContaining(['device', 'punch_item']));
    expect(await kinds('elec')).toEqual(['device']);
    expect(await kinds('empty box')).toEqual(['device']);
    expect(await kinds('00A1B2C3')).toEqual(['device']);
    expect(await kinds('wire nuts')).toEqual(['photo']);
    expect(await kinds('termination')).toEqual(['missing_part']);
    expect(await kinds('nothing-here')).toEqual([]);
  });

  it('filters by level, kind and project', async () => {
    const store = await seeded(mode);
    // 06M: the relay panel device and the "Relay panel interior" photo; level 02 adds one device
    expect((await store.search('relay', { levelId: LEVEL })).length).toBe(2);
    expect((await store.search('relay')).length).toBe(3);
    expect((await store.search('relay', { levelId: LEVEL, kinds: ['device'] })).length).toBe(1);
    expect((await store.search('06M', { kinds: ['device'] })).length).toBe(2);
    expect((await store.search('relay', { projectId: uuidv7() })).length).toBe(0);
  });

  it('drops deleted records from results', async () => {
    const store = await seeded(mode);
    const [hit] = await store.search('empty box');
    await store.apply({
      op_id: uuidv7(), project_id: PROJECT, user_id: USER, install_id: 'i',
      client_ts: new Date().toISOString(), entity_kind: 'device', entity_id: hit!.entity_id,
      kind: 'delete', change_type: 'Correction', reason: 'duplicate pin',
    });
    expect(await store.search('empty box')).toEqual([]);
  });
});

describe('ftsQuery', () => {
  it('quotes every term as a prefix phrase so punctuation never breaks the parser', () => {
    expect(ftsQuery('06M-04 "wall"')).toBe('"06M-04"* """wall"""*');
    expect(ftsQuery('   ')).toBe('');
  });
});
