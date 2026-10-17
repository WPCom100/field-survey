import { Editor, Store, SyncEngine, rememberProjects, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { filterLevels, loadProjectHome } from '../home/data';
import { AssignmentActions, assigneeColumns, loadAssignments } from './assignments';

const [ME, ANN, BOB] = [uuidv7(), uuidv7(), uuidv7()];
const CTX = { change_type: 'Master edit' as const, reason: 'Project created' };
let ts = 1_760_000_000_000;
const now = () => new Date((ts += 1000)).toISOString();

/** Tower with B2, 06, 06M in scope and 09 a far end, as `POST /projects` would write it. */
async function tower(installId = 'ipad') {
  const store = await Store.open(new BetterSqliteDriver(), { installId, search: 'like' });
  const pid = uuidv7();
  const editor = new Editor(store, { projectId: pid, userId: ME, now });
  await editor.create('project', { id: pid, name: 'Tower' }, CTX);
  const level = async (code: string, floor_order: number, in_scope = true) => {
    const g = (await editor.create('numbering_group', { project_id: pid, label: code }, CTX)).id;
    return (await editor.create('level', { project_id: pid, level: code, floor_order, numbering_group_id: g, in_scope, state: 'setup' }, CTX)).id;
  };
  const ids = { B2: await level('B2', 1), L06: await level('06', 2), L06M: await level('06M', 3), L09: await level('09', 4, false) };
  return { store, pid, ids, actions: new AssignmentActions(store, pid, ME, now) };
}

const assignees = async (store: Store, pid: string) =>
  Object.fromEntries((await loadAssignments(store, pid)).map((l) => [l.code, l.userIds]));

describe('level assignments (T97, D168)', () => {
  it('assigns several people to a level as link ops, unassigns, re-assigns; repeats are no-ops', async () => {
    const { store, pid, ids, actions } = await tower();
    expect(await assignees(store, pid)).toEqual({ B2: [], '06': [], '06M': [], '09': [] });
    const before = await store.outboxCount();

    await actions.set(ids.L06, ANN, true);
    await actions.set(ids.L06, BOB, true);
    await actions.set(ids.L06, ANN, true); // already assigned: nothing written
    expect(await assignees(store, pid)).toMatchObject({ '06': [ANN, BOB], B2: [] });
    expect(await store.outboxCount()).toBe(before + 2);
    expect(await store.list('assignment')).toEqual(
      expect.arrayContaining([expect.objectContaining({ level_id: ids.L06, user_id: ANN, assigned_by_id: ME })]),
    );

    await actions.set(ids.L06, ANN, false);
    await actions.set(ids.L06, ANN, false); // not assigned: nothing written
    expect((await assignees(store, pid))['06']).toEqual([BOB]);
    expect(await store.outboxCount()).toBe(before + 3);

    await actions.set(ids.L06, ANN, true); // a removed link comes back
    expect([...(await assignees(store, pid))['06']!].sort()).toEqual([ANN, BOB].sort());

    const ops = await store.db.query<{ kind: string; change_type: string; entity_kind: string }>(
      `SELECT kind, change_type, entity_kind FROM op WHERE entity_kind = 'assignment' ORDER BY client_ts`, [],
    );
    expect(ops.map((o) => o.kind)).toEqual(['link_add', 'link_add', 'link_remove', 'link_add']);
    expect(new Set(ops.map((o) => o.change_type))).toEqual(new Set(['Master edit']));
    await expect(actions.set(uuidv7(), ANN, true)).rejects.toThrow(/Unknown level/);
    await expect(actions.set(ids.L06, '', true)).rejects.toThrow(/Pick a person/);
  });

  it('all in scope / none for one person, as one op group; far-end levels are skipped', async () => {
    const { store, pid, ids, actions } = await tower();
    await actions.set(ids.L06, ANN, true);
    expect(await actions.setAll(ANN, true)).toBe(2); // B2 and 06M; 06 already, 09 out of scope
    expect(await assignees(store, pid)).toEqual({ B2: [ANN], '06': [ANN], '06M': [ANN], '09': [] });
    const groups = await store.db.query<{ n: number }>(
      `SELECT count(DISTINCT group_id) AS n FROM op WHERE entity_kind = 'assignment' AND group_id IS NOT NULL`, [],
    );
    expect(groups[0]!.n).toBe(1);
    await actions.set(ids.L09, ANN, true); // a far end can still be assigned one by one
    expect(await actions.setAll(ANN, false)).toBe(4);
    expect(await assignees(store, pid)).toEqual({ B2: [], '06': [], '06M': [], '09': [] });
    expect(await actions.setAll(ANN, false)).toBe(0);
  });

  it('columns: the team in its order, then anyone assigned who is no longer on it', () => {
    const levels = [{ id: 'l', code: '06', inScope: true, userIds: [BOB, ME] }];
    expect(assigneeColumns([{ id: ME, name: 'Landry' }, { id: ANN, name: 'Ann' }], levels)).toEqual([
      { id: ME, name: 'Landry' }, { id: ANN, name: 'Ann' }, { id: BOB, name: `user …${BOB.slice(-6)}` },
    ]);
  });

  it("after a sync, the assignee's Levels home shows ● and the filter on their levels only", async () => {
    const server = new FakeServer();
    const { store: landry, pid, ids, actions } = await tower('ipad-landry');
    await actions.set(ids.L06, ANN, true);
    await actions.set(ids.L06M, ANN, true);
    await actions.set(ids.L06M, BOB, true);
    await new SyncEngine(landry, server, { log: () => {} }).sync();

    const ann = await Store.open(new BetterSqliteDriver(), { installId: 'ipad-ann', search: 'like' });
    await rememberProjects(ann, [pid]);
    await new SyncEngine(ann, server, { log: () => {} }).sync();
    const home = (await loadProjectHome(ann, pid, ANN))!;
    expect(home.levels.filter((l) => l.assignedToMe).map((l) => l.code)).toEqual(['06', '06M']);
    expect(filterLevels(home.levels, true).map((l) => l.code)).toEqual(['06', '06M']);
    expect((await assignees(ann, pid))['06M']).toEqual([ANN, BOB]);

    // Ann takes herself off 06 on her iPad; Landry sees it after both sync.
    await new AssignmentActions(ann, pid, ANN, now).set(ids.L06, ANN, false);
    await new SyncEngine(ann, server, { log: () => {} }).sync();
    await new SyncEngine(landry, server, { log: () => {} }).sync();
    expect((await assignees(landry, pid))['06']).toEqual([]);
  });
});
