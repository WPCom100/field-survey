/**
 * Dashboard (T38): the four Summary tables counted as the export counts them, drill-down lists that
 * hold exactly the counted rows, as-found counts, readiness, project search — and, over the seeded
 * master, every number equal to the master workbook's Summary tab (which the export reproduces, TP-4).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Editor, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { asFound, chartData, drillRows, loadDashboard, readinessLine, searchProject, summaryTables, type SummaryTable } from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_700_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const id = { l01: uuidv7(), l06m: uuidv7(), l09: uuidv7(), d1: uuidv7(), d2: uuidv7(), d3: uuidv7(), d4: uuidv7(), d9: uuidv7() };
  const ops: Op[] = [];
  let seq = 0;
  const create = (entity_kind: Op['entity_kind'], payload: Record<string, unknown>) => {
    const { id: given, ...rest } = payload;
    const ts = now();
    ops.push({ op_id: uuidv7(), project_id: PROJECT, user_id: ME, install_id: 'server', client_ts: ts, server_seq: ++seq, server_ts: ts, entity_kind, entity_id: typeof given === 'string' ? given : uuidv7(), kind: 'create', payload: rest, change_type: 'Master edit', reason: 'seed', state: 'applied' } as Op);
  };
  create('project', { id: PROJECT, name: 'Tower' });
  // 06M before 01 in id order, after it in floor order; 09 is out of scope (far ends only)
  create('level', { id: id.l06m, numbering_group_id: uuidv7(), project_id: PROJECT, level: '06M', floor_order: 7, in_scope: true, surveyed: '2026-10-07' });
  create('level', { id: id.l01, numbering_group_id: uuidv7(), project_id: PROJECT, level: '01', floor_order: 2, in_scope: true, state: 'baseline_locked', baseline_locked_at: '2025-10-17T12:00:00.000Z' }); // after the seed ops
  create('level', { id: id.l09, numbering_group_id: uuidv7(), project_id: PROJECT, level: '09', floor_order: 9, in_scope: false });
  create('device', { id: id.d1, level_id: id.l01, display_id: '01-01', category: 'Relay panel', device: 'ERP', status: 'Issue', room_location: 'ELEC 101', neuron_id: '01-AA' });
  create('device', { id: id.d2, level_id: id.l01, display_id: '01-S2', category: 'Station', status: 'Issue', origin: 'field_addition' });
  create('device', { id: id.d3, level_id: id.l01, category: 'Station', found_on_site: false }); // NEW, Unsurveyed
  create('device', { id: id.d4, level_id: id.l06m, display_id: '06M-04', category: 'NSPS', status: 'Installed, untested', notes: 'Empty box on wall.' });
  create('device', { id: id.d9, level_id: id.l09, display_id: '09-01', category: 'Equipment rack', status: 'No access' });
  create('punch_item', { level_id: id.l01, number: 2, device_id: id.d1, item: 'Run DMX to 01-02', type: 'Cable not run', owner: 'EC', tracking_status: 'Open' });
  create('punch_item', { level_id: id.l01, number: 1, device_id: id.d2, item: 'Terminate DMX to 01-01', type: 'Missing part', owner: 'EC/ETC', tracking_status: 'In progress' });
  create('punch_item', { level_id: id.l06m, number: 1, item: 'Missing all Device Neuron IDs', type: 'Information', owner: 'EC', tracking_status: 'Closed', sort_last: true });
  create('punch_item', { level_id: id.l06m, number: 2, item: 'Odd', owner: 'ETC' }); // no tracking status: in no column
  create('punch_item', { level_id: id.l09, number: 1, item: 'Out of scope', owner: 'EC', tracking_status: 'Open' });
  create('missing_part', { level_id: id.l01, number: 1, device_id: id.d1, part: 'DMX termination kit', owner: 'EC', part_status: 'Needed' });
  create('missing_part', { level_id: id.l06m, number: 1, part: 'P-NSPS-D', owner: 'EC', part_status: 'On site' });
  create('photo', { level_id: id.l06m, number: 3, device_id: id.d4, subject: 'NSPS backbox' });
  const cable = uuidv7();
  create('cable', { id: cable, project_id: PROJECT, cable: 'X', qty: 1 });
  create('cable_end', { cable_id: cable, side: 'A', level_id: id.l01, device_id: id.d1, display_id: 'C-14', from_text: '01-01', to_text: 'DMX to 06M-04', status: 'Issue' });
  create('cable_end', { cable_id: cable, side: 'B', level_id: id.l06m, device_id: id.d4, display_id: 'C-140', from_text: '06M-04', to_text: '01-01', status: 'Issue' });
  for (const r of await store.applyRemoteMany(ops)) if (r.outcome !== 'applied') throw new Error(`seed op ${r.outcome}`);
  return { store, id, editor: new Editor(store, { projectId: PROJECT, userId: ME, now }) };
}

const grid = (t: SummaryTable) => [[t.keyHeader, ...t.statuses, 'Total'], ...t.keys.map((k, i) => [k, ...t.counts[i]!, t.rowTotals[i]!]), ['Total', ...t.columnTotals, t.total]];

describe('dashboard (T38)', () => {
  it('counts the four Summary tables as the export does: in-scope levels in floor order, statuses outside the columns in no column', async () => {
    const { store } = await setup();
    const data = await loadDashboard(store, PROJECT);
    const [devices, byFloor, byOwner, parts] = summaryTables(data);
    expect(grid(devices!)).toEqual([
      ['Floor', 'Installed, untested', 'Issue', 'Not installed', 'No access', 'Complete', 'Total'],
      ['01', 0, 2, 0, 0, 0, 2],
      ['06M', 1, 0, 0, 0, 0, 1],
      ['Total', 1, 2, 0, 0, 0, 3],
    ]);
    expect(devices!.outside).toBe(1); // the NEW station is Unsurveyed (D110)
    expect(devices!.dates).toEqual({ surveyed: [null, '2026-10-07'], updated: [null, null] });
    expect(grid(byFloor!)).toEqual([['Floor', 'Open', 'In progress', 'Closed', 'Total'], ['01', 1, 1, 0, 2], ['06M', 0, 0, 1, 1], ['Total', 1, 1, 1, 3]]);
    expect(grid(byOwner!)).toEqual([['Owner', 'Open', 'In progress', 'Closed', 'Total'], ['EC', 1, 0, 1, 2], ['ETC', 0, 0, 0, 0], ['EC/ETC', 0, 1, 0, 1], ['Total', 1, 1, 1, 3]]);
    expect(grid(parts!)).toEqual([['Floor', 'Needed', 'Ordered', 'On site', 'Installed', 'Total'], ['01', 1, 0, 0, 0, 1], ['06M', 0, 0, 1, 0, 1], ['Total', 1, 0, 1, 0, 2]]);
    expect(chartData(parts!)).toEqual([{ i: 0, Needed: 1, Ordered: 0, 'On site': 0, Installed: 0 }, { i: 1, Needed: 0, Ordered: 0, 'On site': 1, Installed: 0 }]);
  });

  it('drills down to exactly the counted rows, and filters by level and (exact) owner', async () => {
    const { store, id } = await setup();
    const data = await loadDashboard(store, PROJECT);
    expect(drillRows(data, { table: 'devices', key: '01', status: 'Issue' }).map((r) => [r.label, r.text])).toEqual([['01-01', 'ERP · ELEC 101'], ['01-S2', 'Station']]);
    expect(drillRows(data, { table: 'devices', key: null, status: null }).map((r) => r.label)).toEqual(['01-01', '01-S2', '06M-04']); // Total: Unsurveyed not in it
    const punch = drillRows(data, { table: 'punchByFloor', key: '01', status: null });
    expect(punch.map((r) => [r.label, r.text, r.deviceId])).toEqual([['#1', '01-S2 · Terminate DMX to 01-01', id.d2], ['#2', '01-01 · Run DMX to 01-02', id.d1]]);
    expect(drillRows(data, { table: 'punchByOwner', key: 'EC', status: 'Closed' }).map((r) => r.text)).toEqual(['Missing all Device Neuron IDs']);
    for (const t of summaryTables(data)) {
      t.keys.forEach((k, i) => t.statuses.forEach((s, j) => expect(drillRows(data, { table: t.id, key: k, status: s })).toHaveLength(t.counts[i]![j]!)));
      expect(drillRows(data, { table: t.id, key: null, status: null })).toHaveLength(t.total);
    }
    const ec = summaryTables(data, { owner: 'EC' });
    expect(ec[0]!.total).toBe(3); // devices have no owner: unchanged
    expect(ec[1]!.total).toBe(2); // EC only — EC/ETC is its own row (D181)
    expect(ec[3]!.total).toBe(2);
    const only06m = summaryTables(data, { levelId: id.l06m });
    expect(only06m[0]!.keys).toEqual(['06M']);
    expect(only06m[2]!.total).toBe(1);
    expect(drillRows(data, { table: 'parts', key: null, status: null }, { levelId: id.l06m }).map((r) => r.text)).toEqual(['P-NSPS-D']);
  });

  it('counts as-found facts and drills into them', async () => {
    const { store } = await setup();
    const data = await loadDashboard(store, PROJECT);
    expect(asFound(data)).toEqual({ fieldAdditions: 1, neverFound: 1, neuronCaptured: 1, devices: 4 });
    expect(drillRows(data, { table: 'asFound', key: 'neverFound', status: null }).map((r) => r.label)).toEqual(['01-? NEW']);
    expect(drillRows(data, { table: 'asFound', key: 'neuronMissing', status: null })).toHaveLength(3);
  });

  it('derives readiness: setup with review count, ready once locked, surveying after an edit past the lock', async () => {
    const { store, editor, id } = await setup();
    let data = await loadDashboard(store, PROJECT);
    expect(readinessLine(data.readiness)).toBe('01 ready · 06M setup');
    await store.db.exec(`INSERT INTO review_item (id, project_id, level_id, kind, state) VALUES (?, ?, ?, 'sync_conflict', 'open')`, [uuidv7(), PROJECT, id.l06m]);
    clock += 3_600_000;
    await editor.setField('device', id.d1, 'notes', 'Reterminated - all good', { change_type: 'Field survey', reason: 'survey' });
    data = await loadDashboard(store, PROJECT);
    expect(readinessLine(data.readiness)).toBe('01 surveying · 06M setup (1 review)');
  });

  it('searches the whole project, grouped Devices · Connections · Punch · Parts · Photos', async () => {
    const { store } = await setup();
    const titles = async (q: string) => (await searchProject(store, PROJECT, q)).map((g) => `${g.title}: ${g.results.map((r) => `${r.levelCode} ${r.label}`).join(', ')}`);
    expect(await titles('06M-04')).toEqual(['Devices: 06M 06M-04', 'Connections: 01 C-14, 06M C-140']);
    expect(await titles('c-14')).toEqual(['Connections: 01 C-14']); // the number exactly (D163)
    expect(await titles('dmx')).toEqual(['Connections: 01 C-14', 'Punch: 01 #1, 01 #2', 'Parts: 01 #1']);
    expect(await titles('01-AA')).toEqual(['Devices: 01 01-01']); // Neuron ID
    expect(await titles('backbox')).toEqual(['Photos: 06M #3']);
    expect(await titles('09-01')).toEqual(['Devices: 09 09-01']); // out-of-scope levels are searched too
    expect(await searchProject(store, PROJECT, '  ')).toEqual([]);
  });
});

// ------------------------------------------------------------------ the seeded master (TP-8 fixture)

const FILE = fileURLToPath(new URL('../../../fixtures/master-ops.json', import.meta.url));
const missing = !existsSync(FILE);

/**
 * The master workbook's Summary tab, cached values (fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx,
 * read with openpyxl `data_only=True`). The export writes the same numbers (TP-4 round trip).
 */
const MASTER_SUMMARY = {
  devices: [
    ['B2', 1, 3, 1, 0, 0, 5],
    ['B1', 6, 9, 12, 12, 0, 39],
    ['01', 6, 7, 22, 1, 0, 36],
    ['02', 26, 4, 15, 0, 0, 45],
    ['03', 16, 9, 11, 0, 0, 36],
    ['04', 2, 15, 14, 0, 0, 31],
    ['06', 12, 0, 2, 0, 0, 14],
    ['06M', 1, 3, 0, 0, 0, 4],
    ['Total', 70, 50, 77, 13, 0, 210],
  ],
  punchByFloor: [
    ['B2', 9, 0, 0, 9],
    ['B1', 28, 0, 0, 28],
    ['01', 46, 1, 6, 53],
    ['02', 27, 0, 5, 32],
    ['03', 29, 0, 2, 31],
    ['04', 41, 0, 3, 44],
    ['06', 3, 0, 0, 3],
    ['06M', 15, 0, 0, 15],
    ['Total', 198, 1, 16, 215],
  ],
  punchByOwner: [
    ['EC', 168, 0, 1, 169],
    ['ETC', 9, 0, 15, 24],
    ['EC/ETC', 21, 1, 0, 22],
    ['Total', 198, 1, 16, 215],
  ],
  parts: [
    ['B2', 3, 0, 0, 0, 3],
    ['B1', 8, 0, 0, 0, 8],
    ['01', 17, 0, 1, 2, 20],
    ['02', 10, 0, 0, 0, 10],
    ['03', 16, 0, 0, 0, 16],
    ['04', 12, 0, 1, 0, 13],
    ['06', 2, 0, 0, 0, 2],
    ['06M', 13, 0, 0, 0, 13],
    ['Total', 81, 0, 2, 2, 85],
  ],
};
const MASTER_DATES = {
  surveyed: ['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-07', '2026-10-07', '2026-10-07', '2026-10-07', '2026-10-07'],
  updated: [null, null, '2026-10-08', '2026-10-08', '2026-10-08', '2026-10-08', null, null],
};

describe.skipIf(missing)(`dashboard over the seeded master${missing ? ' — SKIPPED: fixtures/master-ops.json is missing (run server/tests/dump_master_ops.py)' : ''}`, () => {
  it('equals the master Summary: every table, every count, the Surveyed / Updated dates; each count drills to that many rows', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    const dump = JSON.parse(readFileSync(FILE, 'utf8')) as { project_id: string; ops: Op[] };
    for (let i = 0; i < dump.ops.length; i += 500) await store.applyRemoteMany(dump.ops.slice(i, i + 500));
    const data = await loadDashboard(store, dump.project_id);
    const tables = summaryTables(data);
    for (const t of tables) {
      expect(grid(t).slice(1), t.title).toEqual(MASTER_SUMMARY[t.id]);
      t.keys.forEach((k, i) => t.statuses.forEach((s, j) => expect(drillRows(data, { table: t.id, key: k, status: s }).length).toBe(t.counts[i]![j]!)));
    }
    expect(tables[0]!.dates).toEqual(MASTER_DATES);
    expect(tables.map((t) => t.outside)).toEqual([0, 0, 0, 0]);
    expect(asFound(data)).toMatchInlineSnapshot(`
      {
        "devices": 210,
        "fieldAdditions": 0,
        "neuronCaptured": 0,
        "neverFound": 0,
      }
    `);
    expect(readinessLine(data.readiness)).toMatchInlineSnapshot(`"B2 setup · B1 setup (2 review) · 01 setup (4 review) · 02 setup (3 review) · 03 setup (5 review) · 04 setup (6 review) · 06 setup · 06M setup (1 review)"`);
  }, 60_000);
});
