/**
 * T131 — where the time goes with a catalogue-size app library (D197: ≈ 1,130 `library_type`
 * rows with JSON cables, aliases and accessories) and a real project. A Node reproduction of the
 * iPad's steps over better-sqlite3 (statements cost far less here than over expo-sqlite, so
 * these numbers are the JS-side floor; the iPad's own come from the on-device checklist):
 *
 *   1. a pull page of library ops through `Store.applyRemoteMany` (the first library pull);
 *   2. the Tower master replayed through the same path (`fixtures/master-ops.json`, skipped
 *      with a reason when the fixture is missing);
 *   3. the Levels home read model (`listProjects` + `loadProjectHome` + `loadLockTable`);
 *   4. the rule engine: `loadSnapshot`, a first run (writes), a quiet second run;
 *   5. a quiet sync cycle (empty pulls) through the real `SyncEngine`.
 *
 * The ceilings are loose (CI machines vary) and only catch an order-of-magnitude regression;
 * the printed table is the measurement (`docs/perf/t131.md`). `T131_LIBRARY=<n>` sets the
 * library size (0 shows the project's own cost).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LIBRARY_STREAM, Store, SyncEngine, uuidv7, type Op, type PullResponse, type PushBody, type PushResponse, type SyncTransport } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { RULES, RuleEngine } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { listProjects, loadProjectHome } from '../home/data';
import { loadLockTable } from '../setup/lock';

const MASTER = fileURLToPath(new URL('../../../fixtures/master-ops.json', import.meta.url));
const ME = '0199e000-0000-7000-8000-00000000c0de';
const SERVER_INSTALL = '00000000-0000-5000-8000-00000000f1e1';
const NOW = '2026-10-19T12:00:00.000Z';
/** The real catalogue (T111 on the Tower iPads): 501 placeable types and 631 accessories. */
const LIBRARY_SIZE = Number(process.env.T131_LIBRARY ?? 1132);

const ROLES = ['other', 'relay_panel', 'station', 'equipment_rack', 'touchscreen', 'sensor', 'foundry_panel', 'nsps', 'ebdk'] as const;

/**
 * Library create ops shaped like the DaVinci import's (D197): model, ~3 aliases, cables on half,
 * accessories on a third, a `source_ref` of a dozen keys — the median row is ≈ 900 bytes of JSON.
 */
function libraryOps(n: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const accessory = i >= Math.floor(n * 0.44);
    const role = accessory ? null : ROLES[i % ROLES.length]!;
    const id = uuidv7();
    const model = `T131-${i.toString(36).toUpperCase()}`;
    ops.push({
      op_id: uuidv7(),
      project_id: LIBRARY_STREAM,
      user_id: ME,
      install_id: SERVER_INSTALL,
      client_ts: NOW,
      server_seq: i + 1,
      server_ts: NOW,
      entity_kind: 'library_type',
      entity_id: id,
      kind: 'create',
      change_type: 'Master edit',
      reason: 'DaVinci library import',
      payload: {
        id,
        project_id: null,
        model,
        aliases: [`${model} Display Name`, `7180A${(1000 + i).toString()}-5`, `7180A${(1000 + i).toString()}-4`],
        category: accessory ? null : 'Touchscreen',
        default_cables: i % 2 ? [{ code: 'NG', from: null, to: null, far: null, single_row: false, qty: 1, status: null }, { code: '120V', from: null, to: '120v Power', far: null, single_row: true, qty: 1, status: null }] : null,
        optional_accessories: i % 3 ? null : [{ model: `T131-ACC-${i}`, expected_qty: 1, max_quantity: 1 }, { model: `T131-ACC-${i}-B`, expected_qty: 0, max_quantity: 2 }],
        needs_neuron_id: accessory ? null : true,
        state: 'accepted',
        description: `Catalogue type ${i} (a description of about the median length of the real ones)`,
        datasheet_url: 'https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737514939',
        source_ref: {
          kind: 'davinci',
          type_id: uuidv7(),
          display_name: `${model} Display Name`,
          family: 'Mosaic',
          category: 'Mosaic Accessories',
          mapped_to: accessory ? 'Ignore' : 'Touchscreen',
          classification: accessory ? 'Accessory' : 'Product',
          legacy: false,
          model_pattern: `${model}-{Colours}`,
          part_numbers: [`7180A${(1000 + i).toString()}-5`, `7180A${(1000 + i).toString()}-4`],
          ports: [{ protocol: 'Ethernet', direction: 'Bidirectional', count: 1 }],
          library_timestamp: '2026-10-13T18:57:47.923Z',
          file: 'library.json',
        },
        accessory_only: accessory ? true : null,
        role,
      },
    });
  }
  return ops;
}

/** A server with nothing new: every pull is empty at the cursor, pushes are acknowledged. */
class QuietServer implements SyncTransport {
  calls = 0;
  async push(body: PushBody): Promise<PushResponse> {
    this.calls++;
    return { results: body.ops.map((o, i) => ({ op_id: o.op_id, outcome: 'applied', server_seq: 100_000 + i })), server_ops: [], server_seq: 100_000 + body.ops.length };
  }
  async pull(_project: string, since: number): Promise<PullResponse> {
    this.calls++;
    return { ops: [], server_seq: since, has_more: false };
  }
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

describe('T131 — timings with a catalogue-size library', () => {
  it.skipIf(!existsSync(MASTER))('replays the master and the library, then times the home, the rules and a quiet cycle', async () => {
    const out: Record<string, Record<string, number | string>> = {};
    const store = await Store.open(new BetterSqliteDriver(), { installId: '0199e000-0000-7000-8000-000000000001', search: 'like' });

    // 1. the library pull: 1,132 creates in pages of 500 (the first pull after the T111 import)
    const lib = libraryOps(LIBRARY_SIZE);
    let t0 = performance.now();
    for (let i = 0; i < lib.length; i += 500) await store.applyRemoteMany(lib.slice(i, i + 500));
    out.libraryPull = { ops: lib.length, ms: ms(t0), msPerOp: Math.round(((performance.now() - t0) / lib.length) * 100) / 100 };

    // 2. the Tower master through the same path
    const dump = JSON.parse(readFileSync(MASTER, 'utf8')) as { project_id: string; ops: Op[] };
    t0 = performance.now();
    for (let i = 0; i < dump.ops.length; i += 500) await store.applyRemoteMany(dump.ops.slice(i, i + 500));
    out.masterPull = { ops: dump.ops.length, ms: ms(t0), msPerOp: Math.round(((performance.now() - t0) / dump.ops.length) * 100) / 100 };
    const project = dump.project_id;

    // 3. the Levels home read model, as the screen's effect runs it
    t0 = performance.now();
    const projects = await listProjects(store);
    const home = await loadProjectHome(store, project, ME);
    const locks = await loadLockTable(store, project);
    out.levelsHome = { projects: projects.length, levels: home?.levels.length ?? 0, locks: locks.length, ms: ms(t0) };

    // 4. the rule engine over the project with the library in the store
    const engine = new RuleEngine(store, { projectId: project, userId: ME, rules: RULES, now: () => NOW });
    t0 = performance.now();
    const snap = await engine.loadSnapshot();
    out.loadSnapshot = { libraryTypes: snap.libraryTypes.length, devices: snap.devices.length, ms: ms(t0) };
    t0 = performance.now();
    const first = await engine.run();
    out.firstRun = { ms: ms(t0), engineMs: first.ms, ops: first.ops, created: first.created };
    t0 = performance.now();
    const second = await engine.run();
    out.quietRun = { ms: ms(t0), engineMs: second.ms, ops: second.ops };
    expect(second.ops).toBe(0);

    // 5. a quiet sync cycle: the library stream and the project, nothing new on either
    const server = new QuietServer();
    const sync = new SyncEngine(store, server, { library: true, log: () => undefined });
    await sync.requestSync(); // pushes the engine's own writes
    t0 = performance.now();
    const r = await sync.requestSync();
    out.quietCycle = { outcome: r.outcome, projects: r.projects.length, calls: server.calls, ms: ms(t0) };
    expect(r.outcome).toBe('ran');

    console.table(out);
    // Loose ceilings: an order of magnitude above the PC numbers, enough to catch a regression.
    expect(out.quietRun.ms).toBeLessThan(2000);
    expect(out.quietCycle.ms).toBeLessThan(500);
    expect(out.levelsHome.ms).toBeLessThan(500);
  }, 120_000);
});
