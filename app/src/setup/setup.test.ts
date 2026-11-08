import { Editor, Store, SyncEngine, TransportError, rememberProjects, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import {
  SetupActions,
  SetupError,
  addDraftLevels,
  createFailureText,
  loadProjectSetup,
  mezzanineBase,
  mezzanineParent,
  normLevelCode,
  parseLevelDate,
  parseLevelRange,
  shareProblem,
} from './model';

const ME = uuidv7();

let ts = 1_760_000_000_000;
const CTX = { change_type: 'Master edit' as const, reason: 'Project created' };

/** What `POST /projects` writes (as local ops here, so a FakeServer can receive them): Tower with B2, 06, 06M (shared, split), 09 (far end). */
async function tower() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'ipad', search: 'like' });
  const pid = uuidv7();
  const editor = new Editor(store, { projectId: pid, userId: ME, now: () => new Date((ts += 1000)).toISOString() });
  await editor.create('project', {
    id: pid, name: 'Tower', site: 'Houston, TX', parties: { ec: 'Acme', etc: 'ETC Field Service', gc: '' },
    settings: { export_title: 'ETC Lighting Controls Survey', disclaimer: 'rev F' },
  }, CTX);
  const group = async (label: string) => (await editor.create('numbering_group', { project_id: pid, label }, CTX)).id;
  const [gB2, g06, g09] = [await group('B2'), await group('06/06M'), await group('09')];
  const level = async (code: string, floor_order: number, numbering_group_id: string, extra: Record<string, unknown> = {}) =>
    (await editor.create('level', { project_id: pid, level: code, floor_order, numbering_group_id, in_scope: true, state: 'setup', ...extra }, CTX)).id;
  const B2 = await level('B2', 1, gB2);
  const L06 = await level('06', 2, g06);
  const L06M = await level('06M', 3, g06, { split_of_id: L06 });
  const L09 = await level('09', 4, g09, { in_scope: false });
  return { store, pid, ids: { B2, L06, L06M, L09 }, groups: { gB2, g06, g09 }, actions: new SetupActions(store, pid, ME), setupOps: await store.outboxCount() };
}

/** A level that arrived by pull without its group row (the seed import creates groups as rows, not ops). */
function pulledLevel(pid: string, id: string, payload: Record<string, unknown>): Op {
  return {
    op_id: uuidv7(), project_id: pid, user_id: ME, install_id: 'server', client_ts: new Date((ts += 1000)).toISOString(),
    change_type: 'Master edit', entity_kind: 'level', entity_id: id, kind: 'create', payload,
    server_seq: 99, server_ts: new Date(ts).toISOString(), state: 'applied',
  } as Op;
}

describe('level codes and ranges', () => {
  it('normalises codes and expands ranges', () => {
    expect(['6', '6m', 'b2', ' 06M '].map(normLevelCode)).toEqual(['06', '06M', 'B2', '06M']);
    expect(parseLevelRange('09-12')).toEqual(['09', '10', '11', '12']);
    expect(parseLevelRange('9 – 11, 28, b3')).toEqual(['09', '10', '11', '28', 'B3']);
    expect(parseLevelRange('06M')).toEqual(['06M']);
    expect(() => parseLevelRange('12-09')).toThrow(SetupError);
    expect(() => parseLevelRange('B2-B1')).toThrow(/not a level code/);
    expect(() => parseLevelRange('')).toThrow(SetupError);
  });
});

describe('loadProjectSetup', () => {
  it('reads the project, parties, settings and the levels table with sharing and splits', async () => {
    const { store, pid, ids } = await tower();
    const s = (await loadProjectSetup(store, pid))!;
    expect(s.project).toMatchObject({
      name: 'Tower', site: 'Houston, TX', parties: { ec: 'Acme', etc: 'ETC Field Service', gc: '' },
      settings: { export_title: 'ETC Lighting Controls Survey', disclaimer: 'rev F' }, copiedFromId: null,
    });
    expect(s.levels.map((l) => [l.code, l.floorOrder, l.inScope, l.groupLabel, l.shared, l.splitOfCode, l.records])).toEqual([
      ['B2', 1, true, 'B2', false, null, 0],
      ['06', 2, true, '06/06M', true, null, 0],
      ['06M', 3, true, '06/06M', true, '06', 0],
      ['09', 4, false, '09', false, null, 0],
    ]);
    expect(s.levels[2]!.splitOfId).toBe(ids.L06);
    expect(await loadProjectSetup(store, uuidv7())).toBeNull();
  });

  it('counts records per level and derives a group label when the group row is missing (T27 imports)', async () => {
    const { store, pid, ids, actions } = await tower();
    const editor = actions['editor'];
    const ctx = { change_type: 'Field survey' as const, reason: 'test' };
    const { id: d } = await editor.create('device', { level_id: ids.L06M, display_id: '06M-01', category: 'Relay panel' }, ctx);
    await editor.create('punch_item', { level_id: ids.L06M, device_id: d, item: 'Run X' }, ctx);
    await editor.create('photo', { level_id: ids.L06 }, ctx);
    // A level whose group row never arrived (the seed import creates groups as rows, not ops).
    const orphanGroup = uuidv7();
    const l07 = uuidv7();
    await store.applyRemote(pulledLevel(pid, l07, { project_id: pid, level: '07', floor_order: 5, numbering_group_id: orphanGroup, in_scope: true, state: 'setup' }));
    const s = (await loadProjectSetup(store, pid))!;
    const by = Object.fromEntries(s.levels.map((l) => [l.code, l]));
    expect(by['06M']!.records).toBe(2);
    expect(by['06']!.records).toBe(1);
    expect(by['07']!.groupLabel).toBe('07');
    expect(by['07']!.shared).toBe(false);
  });
});

describe('SetupActions', () => {
  it('adds a level on its own group, a split after its parent, and a shared level that relabels the group', async () => {
    const { store, pid, ids, actions, setupOps } = await tower();
    const id10 = await actions.addLevel({ code: '10' });
    let s = (await loadProjectSetup(store, pid))!;
    expect(s.levels.map((l) => l.code)).toEqual(['B2', '06', '06M', '09', '10']);
    expect(s.levels.at(-1)).toMatchObject({ id: id10, floorOrder: 5, inScope: true, groupLabel: '10', shared: false });

    // 06X is a split of 06, sharing its group: placed right after 06, 06M and the rest shift down.
    const id06x = await actions.addLevel({ code: '6x', splitOfLevelId: ids.L06, shareWithLevelId: ids.L06 });
    s = (await loadProjectSetup(store, pid))!;
    expect(s.levels.map((l) => [l.code, l.floorOrder])).toEqual([['B2', 1], ['06', 2], ['06X', 3], ['06M', 4], ['09', 5], ['10', 6]]);
    const l06x = s.levels.find((l) => l.id === id06x)!;
    expect(l06x).toMatchObject({ splitOfCode: '06', shared: true, groupLabel: '06/06X/06M' });
    expect((await store.get<Record<string, unknown>>('numbering_group', l06x.groupId))!.label).toBe('06/06X/06M');

    await expect(actions.addLevel({ code: '06m' })).rejects.toThrow(/already exists/);
    await expect(actions.addLevel({ code: '  ' })).rejects.toThrow(SetupError);
    // Every change is an op in the outbox, none written directly.
    const mine = (await store.outbox(pid)).filter((o) => o.reason === 'Project setup');
    expect(mine.length).toBe((await store.outboxCount()) - setupOps);
    expect(mine.map((o) => [o.entity_kind, o.kind])).toContainEqual(['numbering_group', 'create']);
  });

  it('"Add range" creates out-of-scope far-end levels and skips codes already there', async () => {
    const { store, pid, actions } = await tower();
    const ids = await actions.addRange('09-12, 28');
    expect(ids).toHaveLength(4); // 09 exists already
    const s = (await loadProjectSetup(store, pid))!;
    expect(s.levels.slice(4).map((l) => [l.code, l.floorOrder, l.inScope, l.groupLabel, l.shared])).toEqual([
      ['10', 5, false, '10', false],
      ['11', 6, false, '11', false],
      ['12', 7, false, '12', false],
      ['28', 8, false, '28', false],
    ]);
    // Everything of one Add range is one op group.
    const groups = new Set((await store.outbox(pid)).filter((o) => o.reason === 'Project setup').map((o) => o.group_id));
    expect(groups.size).toBe(1);
    await expect(actions.addRange('x-y')).rejects.toThrow(SetupError);
  });

  it('in scope, split of, move and reorder', async () => {
    const { store, pid, ids, actions } = await tower();
    await actions.setInScope(ids.L09, true);
    await actions.setSplitOf(ids.L09, ids.B2);
    let s = (await loadProjectSetup(store, pid))!;
    expect(s.levels[3]).toMatchObject({ code: '09', inScope: true, splitOfCode: 'B2' });
    await expect(actions.setSplitOf(ids.L06, ids.L06M)).rejects.toThrow(/already a split/);
    await expect(actions.setSplitOf(ids.L06, ids.L06)).rejects.toThrow(/itself/);
    await actions.setSplitOf(ids.L09, null);

    await actions.move(ids.L09, -1);
    s = (await loadProjectSetup(store, pid))!;
    expect(s.levels.map((l) => [l.code, l.floorOrder])).toEqual([['B2', 1], ['06', 2], ['09', 3], ['06M', 4]]);
    await actions.move(ids.B2, -1); // already first: nothing
    await actions.reorder([ids.L06M, ids.L06, ids.B2, ids.L09]);
    s = (await loadProjectSetup(store, pid))!;
    expect(s.levels.map((l) => [l.code, l.floorOrder, l.groupLabel])).toEqual([['06M', 1, '06M/06'], ['06', 2, '06M/06'], ['B2', 3, 'B2'], ['09', 4, '09']]);
    await expect(actions.reorder([ids.B2])).rejects.toThrow(/every level/);
  });

  it('level Surveyed / Updated dates: set, clear, refuse invalid, no-op when unchanged', async () => {
    const { store, pid, ids, actions } = await tower();
    const get = async () => (await loadProjectSetup(store, pid))!.levels.find((l) => l.id === ids.L06M)!;
    expect(await get()).toMatchObject({ surveyed: null, updated: null });
    await actions.setLevelDate(ids.L06M, 'surveyed', ' 2026-10-13 ');
    await actions.setLevelDate(ids.L06M, 'updated', '2026-10-14');
    expect(await get()).toMatchObject({ surveyed: '2026-10-13', updated: '2026-10-14' });
    await expect(actions.setLevelDate(ids.L06M, 'surveyed', '2026-02-30')).rejects.toThrow(/not a date/);
    await expect(actions.setLevelDate(ids.L06M, 'surveyed', '10/13/2026')).rejects.toThrow(/not a date/);
    expect((await get()).surveyed).toBe('2026-10-13');
    await actions.setLevelDate(ids.L06M, 'surveyed', '');
    expect((await get()).surveyed).toBeNull();
    expect(parseLevelDate('')).toBeNull();
  });

  it('numbering sharing: share, separate, and refuse once a level has numbered records', async () => {
    const { store, pid, ids, groups, actions } = await tower();
    await actions.shareNumbering(ids.L09, ids.B2);
    let s = (await loadProjectSetup(store, pid))!;
    const by = () => Object.fromEntries(s.levels.map((l) => [l.code, l]));
    expect(by()['09']).toMatchObject({ groupId: groups.gB2, shared: true, groupLabel: 'B2/09' });
    expect(by()['B2']).toMatchObject({ shared: true, groupLabel: 'B2/09' });
    expect((await store.get<Record<string, unknown>>('numbering_group', groups.g09))!.label).toBe('09'); // the empty group keeps its label

    await actions.separateNumbering(ids.L06M);
    s = (await loadProjectSetup(store, pid))!;
    expect(by()['06M']).toMatchObject({ shared: false, groupLabel: '06M' });
    expect(by()['06M']!.groupId).not.toBe(groups.g06);
    expect(by()['06']).toMatchObject({ shared: false, groupLabel: '06' });
    await actions.separateNumbering(ids.L06); // not shared: no-op
    expect(by()['06']!.groupId).toBe(groups.g06);

    const ctx = { change_type: 'Field survey' as const, reason: 'test' };
    await actions['editor'].create('device', { level_id: ids.B2, display_id: 'B2-01', category: 'Relay panel' }, ctx);
    await expect(actions.shareNumbering(ids.B2, ids.L06)).rejects.toThrow(/numbered records/);
    await expect(actions.separateNumbering(ids.B2)).rejects.toThrow(/numbered records/);
    await expect(actions.shareNumbering(ids.B2, ids.B2)).rejects.toThrow(/another level/);
    await actions.shareNumbering(ids.L09, ids.B2); // same group already: nothing
  });

  it('project fields: name, site, parties and export settings', async () => {
    const { store, pid, actions } = await tower();
    await actions.setProject({ name: '  Centennial Tower ', site: '', parties: { gc: 'Big GC' }, settings: { disclaimer: 'rev G' } });
    let s = (await loadProjectSetup(store, pid))!;
    expect(s.project).toMatchObject({
      name: 'Centennial Tower', site: '', parties: { ec: 'Acme', etc: 'ETC Field Service', gc: 'Big GC' },
      settings: { export_title: 'ETC Lighting Controls Survey', disclaimer: 'rev G' },
    });
    await actions.setProject({ settings: { export_title: '   ', disclaimer: 'rev H' } });
    s = (await loadProjectSetup(store, pid))!;
    expect(s.project.settings).toEqual({ export_title: 'ETC Lighting Controls Survey', disclaimer: 'rev H' }); // empty title falls back to the default
    await expect(actions.setProject({ name: ' ' })).rejects.toThrow(/needs a name/);
    const ops = await store.opsFor(pid);
    expect(ops.filter((o) => o.kind === 'set').map((o) => o.field).sort()).toEqual(['name', 'parties', 'settings', 'settings', 'site']);
  });

  it('the levels edited on the iPad reach the server as ordinary ops, and a project learned by id is pulled whole', async () => {
    // The server holds the project as ops; a fresh iPad knows only its id.
    const server = new FakeServer();
    const { store: seeder, pid, actions } = await tower();
    void seeder;
    await actions.addRange('10-11');
    await new SyncEngine(seeder, server, { log: () => {} }).sync();
    expect(server.ops(pid).filter((o) => o.entity_kind === 'level')).toHaveLength(6);

    const fresh = await Store.open(new BetterSqliteDriver(), { installId: 'ipad-2', search: 'like' });
    await rememberProjects(fresh, [pid]);
    await new SyncEngine(fresh, server, { log: () => {} }).sync();
    const s = (await loadProjectSetup(fresh, pid))!;
    expect(s.project.name).toBe('Tower');
    expect(s.levels.map((l) => l.code)).toEqual(['B2', '06', '06M', '09', '10', '11']);
    expect(s.levels[1]!.groupLabel).toBe('06/06M');
  });
});

describe('New project: numbering shares and the server reason (T142)', () => {
  const lv = (code: string, shareWith: string | null = null) => ({ code, shareWith });

  it('accepts shares that point at a level with its own group', () => {
    expect(shareProblem([lv('06'), lv('06M', '06'), lv('07')])).toBeNull();
    expect(shareProblem([lv('06'), lv('06M', '06'), lv('06X', '06')])).toBeNull();
    expect(shareProblem([])).toBeNull();
  });

  it('names a two-way share and the fix', () => {
    expect(shareProblem([lv('06', '06M'), lv('06M', '06')])).toBe(
      'Levels 06 and 06M share numbering with each other. Set it on one level only: 06 shares with 06M, and 06M keeps "own group".',
    );
  });

  it('names a longer loop and a chain', () => {
    expect(shareProblem([lv('A', 'B'), lv('B', 'C'), lv('C', 'A')])).toMatch(/^Numbering sharing loops: A → B → C → A\. Set it on one level only/);
    expect(shareProblem([lv('A', 'B'), lv('B', 'C'), lv('C')])).toBe(
      'Level A shares with B, which itself shares with C. Set it on one level only: A shares with C directly.',
    );
    expect(shareProblem([lv('A', 'B'), lv('B', 'C'), lv('C', 'D'), lv('D')])).toMatch(/A shares with D directly\.$/);
  });

  it('says the server detail on a refusal', () => {
    const loop = new TransportError('rejected', 'POST /projects → 422', 422, { detail: 'numbering sharing loops at level 06' });
    expect(createFailureText(loop)).toBe('Could not create the project: the server answered 422 (numbering sharing loops at level 06).');
    const invalid = new TransportError('rejected', 'POST /projects → 422', 422, { detail: [{ loc: ['body', 'name'], msg: 'Field required' }] });
    expect(createFailureText(invalid)).toBe('Could not create the project: the server answered 422 (Field required).');
    expect(createFailureText(new TransportError('rejected', 'POST /projects → 400', 400, null))).toBe('Could not create the project: the server answered 400.');
    expect(createFailureText(new TransportError('network', 'Network request failed'))).toMatch(/not reachable/);
    expect(createFailureText(new Error('disk full'))).toBe('Could not create the project: disk full');
  });
});

describe('a <code>M joins its <code> by default (T172, D263)', () => {
  const lv = (code: string, shareWith: string | null = null, splitOf: string | null = null) => ({ code, inScope: true, shareWith, splitOf });

  it('knows the floor a mezzanine code splits', () => {
    expect(mezzanineBase('06M', ['06', '07'])).toBe('06');
    expect(mezzanineBase('06M', ['05', '07'])).toBeNull();
    expect(mezzanineBase('06', ['06M'])).toBeNull();
    expect(mezzanineBase('M', ['', 'M'])).toBeNull();
  });

  it('New project: Add level 06M after 06 sets Share numbering and Split of 06', () => {
    expect(addDraftLevels([lv('04'), lv('06')], [lv('06M')])).toEqual([lv('04'), lv('06'), lv('06M', '06', '06')]);
    // 06 added after 06M makes the pair too
    expect(addDraftLevels([lv('06M')], [lv('06')])).toEqual([lv('06M', '06', '06'), lv('06')]);
    // Add range brings both at once
    const range = addDraftLevels([], [lv('06'), lv('06M'), lv('07')]);
    expect(range.map((l) => [l.code, l.shareWith, l.splitOf])).toEqual([
      ['06', null, null],
      ['06M', '06', '06'],
      ['07', null, null],
    ]);
    expect(shareProblem(range)).toBeNull();
  });

  it('shares with the group 06 itself shares, so no chain is made', () => {
    const out = addDraftLevels([lv('05'), lv('06', '05')], [lv('06M')]);
    expect(out[2]).toEqual(lv('06M', '05', '06'));
    expect(shareProblem(out)).toBeNull();
  });

  it('leaves picks the user made, and pairs that stood before this add', () => {
    // 06M with its own picks
    expect(addDraftLevels([lv('06'), lv('07')], [lv('06M', '07', null)])[2]).toEqual(lv('06M', '07', null));
    // the user cleared 06M's pickers earlier; adding 07 does not set them again
    expect(addDraftLevels([lv('06'), lv('06M')], [lv('07')])).toEqual([lv('06'), lv('06M'), lv('07')]);
    // 06 already shares with 06M: joining back would loop
    expect(addDraftLevels([lv('06', '06M')], [lv('06M')])[1]).toEqual(lv('06M'));
  });

  it('Setup → Add level: a typed 06M defaults to 06', () => {
    const levels = [
      { id: 'a', code: '04' },
      { id: 'b', code: '06' },
    ];
    expect(mezzanineParent('6m', levels)).toEqual({ id: 'b', code: '06' });
    expect(mezzanineParent('06M', levels)?.id).toBe('b');
    expect(mezzanineParent('05M', levels)).toBeNull();
    expect(mezzanineParent('06', levels)).toBeNull();
    expect(mezzanineParent('', levels)).toBeNull();
    // 06M already there: Add refuses it, nothing to default
    expect(mezzanineParent('06M', [...levels, { id: 'c', code: '06M' }])).toBeNull();
  });

  it('Setup → Add level with the defaults puts 09M in the group of 09, right after it', async () => {
    const { store, pid, actions } = await tower();
    await actions.addLevel({ code: '10' });
    const s = (await loadProjectSetup(store, pid))!;
    const parent = mezzanineParent('9m', s.levels)!;
    expect(parent.code).toBe('09');
    await actions.addLevel({ code: '9m', shareWithLevelId: parent.id, splitOfLevelId: parent.id });
    const after = (await loadProjectSetup(store, pid))!;
    expect(after.levels.map((l) => l.code)).toEqual(['B2', '06', '06M', '09', '09M', '10']);
    expect(after.levels.find((l) => l.code === '09M')).toMatchObject({ splitOfId: parent.id, splitOfCode: '09', groupId: parent.groupId, groupLabel: '09/09M', shared: true });
  });
});
