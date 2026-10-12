import { Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { filterLevels, listProjects, loadProjectHome } from './data';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, ensureDemoLevel } from '../plan/demo';

const ME = uuidv7();
const OTHER = uuidv7();

let ts = 1_760_000_000_000;
function op(entity_kind: Op['entity_kind'], entity_id: string, kind: Op['kind'], project_id: string, payload: Record<string, unknown>): Op {
  return {
    op_id: uuidv7(), project_id, user_id: ME, install_id: 'i', client_ts: new Date((ts += 1000)).toISOString(),
    change_type: 'Master edit', entity_kind, entity_id, kind, payload,
  };
}

async function open() {
  return Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
}

describe('loadProjectHome', () => {
  it('counts devices, Issue/NI, open items and reviews per level from the local store', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    const home = (await loadProjectHome(store, project!.id, ME))!;
    expect(home.project.name).toMatch(/Demo/);
    const l = home.levels.find((x) => x.id === DEMO_LEVEL_ID)!;
    expect(l).toMatchObject({ code: '06M', state: 'baseline_locked', inScope: true, assignedToMe: false });
    expect(l.devices).toBe(48);
    expect(l.issueOrNi).toBeGreaterThan(0);
    expect(l.issueOrNi).toBeLessThan(l.devices);
    expect(l.openItems).toBeGreaterThanOrEqual(16);
    expect(l.reviews).toBe(0);
    // The demo sheet has no bytes (blob null): nothing to cache.
    expect(l.cache).toBe('no sheet');
  });

  it('reviews, assignment and cache state', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    const pid = project!.id;
    const level2 = uuidv7();
    const sheet = uuidv7();
    const sha = 'a'.repeat(64);
    await store.apply(op('level', level2, 'create', pid, { project_id: pid, level: '07', floor_order: 8, numbering_group_id: uuidv7(), display_sheet_id: sheet }));
    await store.apply(op('sheet', sheet, 'create', pid, { level_id: level2, kind: 'display', blob: sha, page: 1 }));
    await store.apply(op('review_item', uuidv7(), 'create', pid, { project_id: pid, level_id: level2, kind: 'sync_conflict', state: 'open' }));
    await store.apply(op('review_item', uuidv7(), 'create', pid, { project_id: pid, level_id: level2, kind: 'sync_conflict', state: 'resolved' }));
    await store.apply(op('assignment', level2, 'link_add', pid, { user_id: ME }));
    await store.apply(op('assignment', DEMO_LEVEL_ID, 'link_add', pid, { user_id: OTHER }));

    let home = (await loadProjectHome(store, pid, ME))!;
    const l7 = home.levels.find((x) => x.id === level2)!;
    expect(home.levels.map((x) => x.code)).toEqual(['06M', '07']);
    expect(l7).toMatchObject({ reviews: 1, assignedToMe: true, devices: 0, state: 'setup', cache: 'not cached' });
    expect(filterLevels(home.levels, true).map((x) => x.code)).toEqual(['07']);
    expect(filterLevels(home.levels, false)).toHaveLength(2);

    await store.db.exec(
      `INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at) VALUES (?, 'download', 'sheet', 0, 'queued', 0, ?)`,
      [sha, new Date().toISOString()],
    );
    home = (await loadProjectHome(store, pid, ME))!;
    expect(home.levels.find((x) => x.id === level2)!.cache).toBe('downloading');

    await store.db.exec(
      `INSERT INTO blob (sha256, size, mime, upload_state, chunks_received, local_path, kind) VALUES (?, 1, 'application/pdf', 'complete', '[]', '/x.pdf', 'sheet')`,
      [sha],
    );
    home = (await loadProjectHome(store, pid, ME))!;
    expect(home.levels.find((x) => x.id === level2)!.cache).toBe('cached');
    expect(await loadProjectHome(store, 'nope', ME)).toBeNull();
  });

  it('a level with no plan sheet still opens its plan data (T71)', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    const pid = project!.id;
    const bare = uuidv7();
    const dev = uuidv7();
    await store.apply(op('level', bare, 'create', pid, { project_id: pid, level: 'B2', floor_order: 1, numbering_group_id: uuidv7() }));
    await store.apply(op('device', dev, 'create', pid, { level_id: bare, category: 'Relay panel', status: 'Issue' }));

    const home = (await loadProjectHome(store, pid, ME))!;
    expect(home.levels.find((x) => x.id === bare)).toMatchObject({ code: 'B2', cache: 'no sheet', devices: 1, issueOrNi: 1 });

    const plan = (await loadLevelPlan(store, bare))!;
    expect(plan.level.code).toBe('B2');
    expect(plan.sheet).toBeNull();
    expect(plan.devices.map((d) => d.id)).toEqual([dev]);
    expect(plan.devices[0]!.pin).toBeNull();
  });
});
