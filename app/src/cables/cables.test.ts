/**
 * Cable / riser view (T39): rows with both ends, the six consistency checks, grouping by vertical
 * / level / code, filters, Confirm endpoint, and — over the seeded master — the same far-end count
 * the rule engine's `lint.far_end` raises (TP-8).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Editor, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { RULES, RuleEngine } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { confirmEndpoint } from './actions';
import { cableChecks, groupCables, loadCables, parseRiserRef, riserSignal, statusCell, verticalOf } from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_700_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const id = { l03: uuidv7(), l06m: uuidv7(), l09: uuidv7(), panel: uuidv7(), ufmp: uuidv7(), rack: uuidv7(), nsps: uuidv7(), fixtures: uuidv7(), lvl9: uuidv7(), review: uuidv7() };
  const cables: Record<string, string> = {};
  const ends: Record<string, string> = {};
  // Seeded as server ops (the pull path): display numbers are the server's to assign.
  const ops: Op[] = [];
  let seq = 0;
  const g = {
    create: async (entity_kind: Op['entity_kind'], payload: Record<string, unknown>) => {
      const { id: given, ...rest } = payload;
      const entity_id = typeof given === 'string' ? given : uuidv7();
      const ts = now();
      ops.push({ op_id: uuidv7(), project_id: PROJECT, user_id: ME, install_id: 'server', client_ts: ts, server_seq: ++seq, server_ts: ts, entity_kind, entity_id, kind: 'create', payload: rest, change_type: 'Master edit', reason: 'seed', state: 'applied' } as Op);
      return { entity_id };
    },
  };
  {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    const group = uuidv7();
    await g.create('level', { id: id.l03, project_id: PROJECT, level: '03', floor_order: 4, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('level', { id: id.l06m, project_id: PROJECT, level: '06M', floor_order: 7, numbering_group_id: group, in_scope: true });
    await g.create('level', { id: id.l09, project_id: PROJECT, level: '09', floor_order: 9, numbering_group_id: uuidv7(), in_scope: false });
    await g.create('device', { id: id.panel, level_id: id.l06m, display_id: '06M-02', category: 'Relay panel' });
    await g.create('device', { id: id.rack, level_id: id.l06m, display_id: '06M-01', category: 'Equipment rack' });
    await g.create('device', { id: id.nsps, level_id: id.l06m, display_id: '06M-03', category: 'NSPS' });
    await g.create('device', { id: id.ufmp, level_id: id.l03, display_id: '03-05', category: 'Foundry panel' });
    await g.create('placeholder', { id: id.fixtures, project_id: PROJECT, label: 'Fixtures', kind: 'fixtures' });
    await g.create('placeholder', { id: id.lvl9, project_id: PROJECT, label: 'Level 09', kind: 'level_not_in_scope', level_id: id.l09 });
    const cable = async (name: string, c: Record<string, unknown>, a: Record<string, unknown>, b: Record<string, unknown> | null) => {
      const cid = uuidv7();
      cables[name] = cid;
      await g.create('cable', { id: cid, project_id: PROJECT, qty: 1, origin: 'riser', endpoint_confirmed: true, ...c });
      ends[`${name}A`] = (await g.create('cable_end', { cable_id: cid, side: 'A', ...a })).entity_id;
      if (b) ends[`${name}B`] = (await g.create('cable_end', { cable_id: cid, side: 'B', ...b })).entity_id;
    };
    const dev = (d: string, level: string, n: string, extra: Record<string, unknown> = {}) => ({ endpoint_kind: 'device', device_id: d, level_id: level, display_id: n, ...extra });
    // clean riser run 06M → 03, riser label matches
    await cable('ok', { cable: 'X', riser_to_label: 'DMX TO LEVEL 03 UFMP', vertical: 'Rack 06M DMX' }, dev(id.rack, id.l06m, 'C-03', { to_text: 'DMX to Level 3 UFMP4s', status: 'Issue' }), dev(id.ufmp, id.l03, 'C-13', { status: 'Issue' }));
    // status mismatch + To ≠ riser + code mismatch (riser says DMX, code N), unconfirmed
    await cable(
      'bad',
      { cable: 'N', riser_to_label: 'DMX TO LEVEL 03', endpoint_confirmed: false },
      dev(id.rack, id.l06m, 'C-04', { to_text: 'Network to 03-05', status: 'Not installed' }),
      dev(id.ufmp, id.l03, 'C-14', { status: 'Installed, untested' }),
    );
    // missing far end (one end only) and no code
    await cable('lone', { cable: null }, dev(id.rack, id.l06m, 'C-05', { status: 'Issue' }), null);
    // far end naming nothing; Not started on in-scope 03
    await cable('empty', { cable: 'F' }, dev(id.rack, id.l06m, 'C-06'), { level_id: id.l03, status: 'Not started' });
    // a run to a level out of scope, Not started at both ends (the master's form): fine
    await cable('nine', { cable: 'X' }, dev(id.rack, id.l06m, 'C-07', { status: 'Not started' }), { endpoint_kind: 'placeholder', placeholder_id: id.lvl9, level_id: id.l09, status: 'Not started' });
    // single row
    await cable('tenv', { cable: '0-10V', single_row: true }, dev(id.panel, id.l06m, 'C-08', { status: 'Issue' }), { endpoint_kind: 'placeholder', placeholder_id: id.fixtures });
    // same floor Unison, unnumbered A end
    await cable('uni', { cable: 'U', qty: null }, { endpoint_kind: 'device', device_id: id.nsps, level_id: id.l06m }, dev(id.rack, id.l06m, 'C-09'));
    await g.create('review_item', { id: id.review, project_id: PROJECT, level_id: id.l03, kind: 'import_pair', subject: { entity_kind: 'cable_end', entity_id: ends.okB, field: 'device_id' }, state: 'open' });
  }
  for (const r of await store.applyRemoteMany(ops)) if (r.outcome !== 'applied') throw new Error(`seed op ${r.outcome}`);
  return { store, editor, id, cables, ends };
}

describe('cable / riser view (T39)', () => {
  it('loads every cable with both ends, Unsurveyed for an empty status, and the open review item', async () => {
    const { store, cables } = await setup();
    const data = await loadCables(store, PROJECT);
    expect(data.rows).toHaveLength(7);
    expect(data.levels.map((l) => [l.code, l.inScope])).toEqual([['03', true], ['06M', true], ['09', false]]);
    const ok = data.rows.find((r) => r.id === cables.ok)!;
    expect(ok).toMatchObject({ code: 'X', vertical: 'Rack 06M DMX', a: { label: 'C-03', endpoint: '06M-01', levelCode: '06M', status: 'Issue' }, b: { label: 'C-13', endpoint: '03-05', levelCode: '03' }, checks: [] });
    expect(ok.reviewItemId).toBeTruthy();
    expect(ok.levelIds).toHaveLength(2);
    const uni = data.rows.find((r) => r.id === cables.uni)!;
    expect(uni.a).toMatchObject({ label: 'NEW', endpoint: '06M-03', status: null });
    expect(statusCell(uni.a)).toBe('Unsurveyed');
    expect(statusCell(null)).toBe('⚠ missing end');
    const ten = data.rows.find((r) => r.id === cables.tenv)!;
    expect(ten.b).toMatchObject({ endpoint: 'Fixtures', levelId: null });
  });

  it('raises the six checks where they apply and counts cables per check', async () => {
    const { store, cables } = await setup();
    const data = await loadCables(store, PROJECT);
    const ids = (name: string) => data.rows.find((r) => r.id === cables[name])!.checks.map((c) => c.id);
    expect(ids('ok')).toEqual([]);
    expect(ids('bad')).toEqual(['code', 'status', 'riser', 'unconfirmed']);
    expect(ids('lone')).toEqual(['far_end', 'code']);
    expect(ids('empty')).toEqual(['far_end', 'not_started']);
    expect(ids('nine')).toEqual([]); // Not started on a run to an out-of-scope level is right, at either end
    expect(ids('tenv')).toEqual([]);
    expect(ids('uni')).toEqual([]);
    expect(data.totals).toEqual({ far_end: 2, code: 2, status: 1, riser: 1, unconfirmed: 1, not_started: 1 });
    const bad = data.rows.find((r) => r.id === cables.bad)!;
    expect(bad.checks.find((c) => c.id === 'status')!.message).toBe('C-04: Not installed here, Installed, untested at C-14');
    expect(bad.checks.find((c) => c.id === 'riser')!.message).toBe('To "Network to 03-05" does not match the riser "DMX TO LEVEL 03"');
    expect(data.rows.find((r) => r.id === cables.empty)!.checks[0]!.message).toBe('NEW (side B) names no device or placeholder');
  });

  it('groups by vertical (stored, runs, same-floor, single-row), by level (a riser run under each) and by code', async () => {
    const { store, id } = await setup();
    const data = await loadCables(store, PROJECT);
    const titles = (by: 'vertical' | 'level' | 'code', f = {}) => groupCables(data, by, f).map((g) => `${g.title} ${g.rows.length}`);
    expect(titles('vertical')).toEqual(['Vertical: Rack 06M DMX 1', '06M-01 → N (network) 1', '06M-01 → No code 1', '06M-01 → F (fiber) 1', '06M-01 → X (DMX) 1', 'Same-floor: U (Unison) 1', 'Single-row: P · 0-10V · 120V 1']);
    expect(titles('level')).toEqual(['Level 03 3', 'Level 06M 7', 'Level 09 1']);
    expect(titles('level', { levelId: id.l03 })).toEqual(['Level 03 3']);
    expect(titles('code')).toEqual(['X (DMX) 2', 'N (network) 1', 'U (Unison) 1', 'F (fiber) 1', '0-10V 1', 'No code 1']);
  });

  it('filters by code, end status (Unsurveyed too) and check', async () => {
    const { store } = await setup();
    const data = await loadCables(store, PROJECT);
    const count = (f: object) => groupCables(data, 'code', f).reduce((n, g) => n + g.rows.length, 0);
    expect(count({ code: 'X' })).toBe(2);
    expect(count({ status: 'Not started' })).toBe(2);
    expect(count({ status: 'Unsurveyed' })).toBe(3); // tenv B, uni A + B … and empty A
    expect(count({ check: 'any' })).toBe(3);
    expect(count({ check: 'far_end' })).toBe(2);
    expect(count({ check: 'riser', code: 'X' })).toBe(0);
  });

  it('Confirm endpoint is one Riser cross-check op and clears the check; repeating writes nothing', async () => {
    const { store, editor, cables } = await setup();
    const op = await confirmEndpoint(editor, cables.bad!);
    expect(op).toMatchObject({ entity_kind: 'cable', field: 'endpoint_confirmed', change_type: 'Riser cross-check', reason: 'Endpoint confirmed against the riser' });
    expect(await confirmEndpoint(editor, cables.bad!)).toBeNull();
    const data = await loadCables(store, PROJECT);
    expect(data.rows.find((r) => r.id === cables.bad)!.checks.map((c) => c.id)).not.toContain('unconfirmed');
    expect(data.totals.unconfirmed).toBe(0);
  });

  it('reads the riser label signal and the riser_ref crop', () => {
    expect(riserSignal('DMX TO LEVEL 03 UFMP')).toEqual(['X']);
    expect(riserSignal('NETWORK TO LEVEL 07 RACK')).toEqual(['N', 'NG']);
    expect(riserSignal('0-10V TO FIXTURES')).toEqual(['0-10V']);
    expect(riserSignal('TO LEVEL 03')).toBeNull();
    expect(parseRiserRef({ sheet: 's1', bbox: [10, 20, 300, 200] })).toEqual({ sheetId: 's1', bbox: { x: 10, y: 20, width: 300, height: 200 } });
    expect(parseRiserRef({ sheet: 's1', bbox: { x: 1, y: 2, width: 3, height: 4 } })).toMatchObject({ bbox: { width: 3 } });
    expect(parseRiserRef({ sheet: 's1', bbox: [0, 0, 0, 10] })).toBeNull();
    expect(parseRiserRef(null)).toBeNull();
    expect(cableChecks({ code: 'X', riserToLabel: null, endpointConfirmed: true }, [], () => true)).toEqual([{ id: 'far_end', message: 'No ends' }]);
    expect(verticalOf({ vertical: null, singleRow: false, a: null, b: null, levelIds: [], code: 'X' } as never).title).toBe('(no endpoint) → X (DMX)');
  });
});

// ------------------------------------------------------------------ TP-8 over the seeded master

const FILE = fileURLToPath(new URL('../../../fixtures/master-ops.json', import.meta.url));
const missing = !existsSync(FILE);

describe.skipIf(missing)(`cable view over the seeded master${missing ? ' — SKIPPED: fixtures/master-ops.json is missing (run server/tests/dump_master_ops.py)' : ''}`, () => {
  it('counts the far ends the rule engine flags, no other mismatches (the 06M runs to 09–11 are Not started by design), every imported cable unconfirmed (D6)', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    const dump = JSON.parse(readFileSync(FILE, 'utf8')) as { project_id: string; ops: Op[] };
    for (let i = 0; i < dump.ops.length; i += 500) await store.applyRemoteMany(dump.ops.slice(i, i + 500));
    const engine = new RuleEngine(store, { projectId: dump.project_id, userId: ME, rules: RULES, now: () => '2026-10-15T12:00:00.000Z' });
    await engine.run();
    const findings = await engine.openFindings();
    const data = await loadCables(store, dump.project_id);
    const lint = (id: string) => findings.filter((f) => f.lint_id === id).length;
    expect(data.totals.far_end).toBe(lint('lint.far_end'));
    expect(data.totals.far_end).toBe(12);
    expect(data.totals.status).toBe(lint('lint.end_status'));
    expect(data.totals.riser).toBe(lint('R2b'));
    expect(data.totals.unconfirmed).toBe(data.rows.length);
    expect(data.totals).toMatchInlineSnapshot(`
      {
        "code": 0,
        "far_end": 12,
        "not_started": 0,
        "riser": 0,
        "status": 0,
        "unconfirmed": 80,
      }
    `);
    const grouped = groupCables(data, 'vertical');
    expect(grouped.reduce((n, g) => n + g.rows.length, 0)).toBe(data.rows.length);
  }, 60_000);
});
