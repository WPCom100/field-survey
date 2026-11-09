import { Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { filterLevels, homeSummary, homeTiles, levelName, levelSubline, listProjects, loadProjectHome } from './data';
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

describe('the shell (T176)', () => {
  it('surveyed, open and closed punch, shares-numbers, the review and lint counts', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    const pid = project!.id;
    const group = uuidv7();
    const l06 = uuidv7();
    const l06m = uuidv7();
    await store.apply(op('level', l06, 'create', pid, { project_id: pid, level: '06', floor_order: 6, numbering_group_id: group }));
    await store.apply(op('level', l06m, 'create', pid, { project_id: pid, level: '06Q', floor_order: 7, numbering_group_id: group }));
    const d1 = uuidv7();
    const d2 = uuidv7();
    await store.apply(op('device', d1, 'create', pid, { level_id: l06, category: 'Station', status: 'Complete' }));
    await store.apply(op('device', d2, 'create', pid, { level_id: l06, category: 'Station' }));
    await store.apply(op('punch_item', uuidv7(), 'create', pid, { level_id: l06, device_id: d1, item: 'a', tracking_status: 'Open' }));
    await store.apply(op('punch_item', uuidv7(), 'create', pid, { level_id: l06, device_id: d1, item: 'b', tracking_status: 'Closed' }));
    await store.apply(op('punch_item', uuidv7(), 'create', pid, { level_id: l06, device_id: d2, item: 'c' }));
    await store.apply(op('review_item', uuidv7(), 'create', pid, { project_id: pid, kind: 'sync_conflict', state: 'open' }));
    await store.apply(op('finding', uuidv7(), 'create', pid, { project_id: pid, lint_id: 'E1', state: 'open', message: 'x' }));
    await store.apply(op('finding', uuidv7(), 'create', pid, { project_id: pid, lint_id: 'E2', state: 'dismissed', message: 'y' }));

    const home = (await loadProjectHome(store, pid, ME))!;
    const six = home.levels.find((x) => x.id === l06)!;
    expect(six).toMatchObject({ devices: 2, surveyed: 1, openPunch: 2, closedPunch: 1, openItems: 2, sharesWith: [] });
    expect(home.levels.find((x) => x.id === l06m)!.sharesWith).toEqual(['06']);
    expect(home.reviewOpen).toBe(1); // no level: counted for the project, not on a row
    expect(six.reviews).toBe(0);
    expect(home.lintOpen).toBe(1);

    const tiles = homeTiles(home);
    expect(tiles.map((t) => t.key)).toEqual(['devices', 'issues', 'punch', 'review']);
    const demo = home.levels.find((x) => x.id === DEMO_LEVEL_ID)!;
    expect(tiles[0]).toMatchObject({ value: demo.devices + 2, sub: `${demo.surveyed + 1} surveyed` });
    expect(tiles[2]).toMatchObject({ value: demo.openPunch + 2, sub: `${demo.closedPunch + 1} closed` });
    expect(tiles[3]).toMatchObject({ value: 1, sub: 'on 0 levels', tone: 'warning' });
  });

  it('level names, the line under the code, the summary and the tiles', () => {
    expect(['B2', '01', '06', '06M', '10', 'R', 'P1'].map(levelName)).toEqual(['Basement 2', 'Level 1', 'Level 6', 'Level 6 mezzanine', 'Level 10', null, null]);
    expect(levelSubline({ code: '06M', assignedToMe: false, sharesWith: ['06'], inScope: true })).toBe('Level 6 mezzanine · shares numbers with 06');
    expect(levelSubline({ code: '01', assignedToMe: true, sharesWith: [], inScope: true })).toBe('Level 1 · assigned to me');
    expect(levelSubline({ code: 'R', assignedToMe: false, sharesWith: [], inScope: false })).toBe('out of scope');

    const lv = (code: string, locked: boolean, extra: Partial<Parameters<typeof homeTiles>[0]['levels'][number]> = {}) => ({
      id: code, code, floorOrder: null, inScope: true, state: locked ? ('baseline_locked' as const) : ('setup' as const),
      devices: 10, issueOrNi: 0, openItems: 0, reviews: 0, surveyed: 4, openPunch: 1, closedPunch: 2, cache: 'cached' as const,
      assignedToMe: false, sharesWith: [], ...extra,
    });
    const levels = [lv('B2', true, { issueOrNi: 2 }), lv('B1', true, { reviews: 1 }), lv('01', false, { reviews: 2, issueOrNi: 1 }), lv('07', false)];
    expect(homeSummary(levels)).toBe('4 levels · B2 to 07 · 2 locked');
    expect(homeSummary([lv('06M', false)])).toBe('1 level · 06M · 0 locked');
    expect(homeSummary([])).toBe('0 levels');
    expect(homeTiles({ levels, reviewOpen: 3 })).toEqual([
      { key: 'devices', label: 'Devices', value: 40, sub: '16 surveyed', tone: 'text' },
      { key: 'issues', label: 'Issue or not installed', value: 3, sub: 'on 2 levels', tone: 'danger' },
      { key: 'punch', label: 'Open punch items', value: 4, sub: '8 closed', tone: 'text' },
      { key: 'review', label: 'Needs review', value: 3, sub: 'on B1 and 01', tone: 'warning' },
    ]);
    expect(homeTiles({ levels: [lv('B2', true, { reviews: 1 }), lv('B1', true, { reviews: 1 }), lv('01', true, { reviews: 1 })], reviewOpen: 3 })[3]!.sub).toBe('on 3 levels');
    expect(homeTiles({ levels: [lv('B2', true, { reviews: 1 })], reviewOpen: 1 })[3]!.sub).toBe('on B2');
  });
});
