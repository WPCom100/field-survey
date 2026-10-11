import { Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLevelPlan } from './data';
import { DEMO_LEVEL_ID, DEMO_SHEET_SIZE, demoOps, ensureDemoLevel } from './demo';
import { EMPTY_FILTER, matchesFilter } from './filters';
import { hitTest, layoutPins, LAYOUT_DEFAULTS, type RenderPin } from './layout';
import { loadLevelLists, rowMatches, searchIds } from './lists';
import { DEVICE_CATEGORIES, pinStyleFor, statusRank } from './pins';
import { sheetToView, type PdfViewport } from './viewport';

/** A realistic busy sheet: 500 pins, most in tight electrical-room and corridor groups. */
const N = 500;
const { width: W, height: H } = DEMO_SHEET_SIZE;
const STATUSES = ['Complete', 'Installed, untested', 'Issue', 'Not installed', 'No access', null] as const;

function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function sheetPoints(n: number): { x: number; y: number }[] {
  const rand = seeded(7);
  const pts: { x: number; y: number }[] = [];
  const rooms = Array.from({ length: 12 }, () => ({ x: W * (0.05 + 0.9 * rand()), y: H * (0.05 + 0.9 * rand()) }));
  for (let i = 0; i < n; i++) {
    if (i % 5 < 3) {
      const r = rooms[i % rooms.length]!; // 60 % in 12 rooms, within ~25 ft
      pts.push({ x: r.x + (rand() - 0.5) * 140, y: r.y + (rand() - 0.5) * 140 });
    } else if (i % 5 === 3) {
      pts.push({ x: W * (0.05 + 0.9 * (i / n)), y: H * 0.5 + (rand() - 0.5) * 30 }); // a corridor of stations
    } else {
      pts.push({ x: W * (0.04 + 0.92 * rand()), y: H * (0.04 + 0.92 * rand()) }); // scattered
    }
  }
  return pts;
}

function renderPins(n: number): RenderPin[] {
  return sheetPoints(n).map((p, i) => {
    const status = STATUSES[i % STATUSES.length] ?? null;
    const st = pinStyleFor(status);
    return {
      id: `p${i}`, x: p.x, y: p.y, category: DEVICE_CATEGORIES[i % DEVICE_CATEGORIES.length]!,
      fill: st.fill, hollow: st.hollow, glyph: st.glyph, label: `06M-${i + 1}`,
      plus: i % 11 === 5, isNew: false, photos: i % 6 === 2 ? 2 : 0, rank: statusRank(status),
    };
  });
}

/** An iPad-like viewport of 1100 × 800 pt, PDFKit style (y flips), at `zoom` view pt per sheet pt. */
function viewAt(zoom: number, ox = 0, oy = 0): PdfViewport {
  const crop = { x: 0, y: 0, width: W, height: H };
  return { a: zoom, b: 0, c: 0, d: -zoom, tx: ox, ty: oy + zoom * H, cropBox: crop, page: 1 };
}

describe(`${N} pins on one sheet`, () => {
  const pins = renderPins(N);
  const fit = 1100 / W; // the sheet fits the 1100 pt wide plan area
  const zooms = [fit, fit * 2, fit * 4, fit * 8, 2.5, 6];

  it('lays out every frame well inside the frame budget at every zoom', () => {
    const out: string[] = [];
    for (const z of zooms) {
      const m = sheetToView(viewAt(z));
      layoutPins(pins, m, 1100, 800); // warm up
      const runs = 200;
      const t0 = performance.now();
      for (let i = 0; i < runs; i++) layoutPins(pins, m, 1100, 800);
      const ms = (performance.now() - t0) / runs;
      out.push(`zoom ${z.toFixed(2)}: ${ms.toFixed(3)} ms`);
      expect(ms).toBeLessThan(4); // Node is faster than the iPad's JS engine; 4 ms leaves ~4× margin at 120 fps
    }
    console.log(`[density] layout of ${N} pins — ${out.join(' · ')}`);
  });

  it('accounts for every pin exactly once and keeps clusters tight', () => {
    for (const z of zooms) {
      const lay = layoutPins(pins, sheetToView(viewAt(z)), 1e6, 1e6, { clusterPx: 30, offZoom: 2, marginPx: 1e7 });
      const seen = new Set<number>();
      for (const p of lay.pins) seen.add(p.index);
      for (const c of lay.clusters) {
        expect(c.members.length).toBeGreaterThan(1);
        const seed = pins[c.members[0]!]!;
        const m = sheetToView(viewAt(z));
        for (const i of c.members) {
          seen.add(i);
          const d = Math.hypot((pins[i]!.x - seed.x) * m.a, (pins[i]!.y - seed.y) * m.a);
          expect(d).toBeLessThanOrEqual(30 + 1e-6);
        }
      }
      expect(seen.size).toBe(N);
    }
  });

  it('shows clusters at fit, shrinking to singles once past the cut-off zoom', () => {
    const atFit = layoutPins(pins, sheetToView(viewAt(fit)), 1e6, 1e6, { ...LAYOUT_DEFAULTS, marginPx: 1e7 });
    expect(atFit.clusters.length).toBeGreaterThan(5);
    expect(atFit.clusters.length + atFit.pins.length).toBeLessThan(N / 2);
    const deep = layoutPins(pins, sheetToView(viewAt(2.5)), 1e6, 1e6, { ...LAYOUT_DEFAULTS, marginPx: 1e7 });
    expect(deep.clusters).toHaveLength(0);
    expect(deep.pins).toHaveLength(N);
  });

  it('hits the pin that was tapped when zoomed in, and a cluster at fit', () => {
    const m = sheetToView(viewAt(2.5));
    const lay = layoutPins(pins, m, 1e6, 1e6, { ...LAYOUT_DEFAULTS, marginPx: 1e7 });
    let hits = 0;
    for (const p of lay.pins) {
      const h = hitTest(lay, p.vx, p.vy, 14);
      // The nearest pin wins, so a tap exactly on a pin finds it (ties only between identical points).
      if (h?.kind === 'pin' && h.index === p.index) hits++;
    }
    expect(hits).toBe(N);
    const atFit = layoutPins(pins, sheetToView(viewAt(fit)), 1100, 800);
    const c = atFit.clusters[0]!;
    expect(hitTest(atFit, c.vx, c.vy, 14)).toMatchObject({ kind: 'cluster' });
  });
});

describe(`${N} devices in the side lists`, () => {
  const ME = uuidv7();
  let ts = 1_760_000_000_000;
  const op = (kind: Op['entity_kind'], id: string, project_id: string, payload: Record<string, unknown>): Op => ({
    op_id: uuidv7(), project_id, user_id: ME, install_id: 'i', client_ts: new Date((ts += 1000)).toISOString(),
    change_type: 'Field survey', entity_kind: kind, entity_id: id, kind: 'create', payload,
  });

  it('loads, filters and searches 500 devices with ~1,500 punch items, parts and connections', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'auto' });
    await ensureDemoLevel(store);
    const pid = (await loadLevelPlan(store, DEMO_LEVEL_ID))!.level.projectId;
    const pts = sheetPoints(N);
    const ids: string[] = [];
    const cable = uuidv7();
    await store.apply(op('cable', cable, pid, { project_id: pid, cable: 'N' }));
    for (let i = 0; i < N; i++) {
      const id = uuidv7();
      ids.push(id);
      await store.apply(op('device', id, pid, {
        level_id: DEMO_LEVEL_ID, category: DEVICE_CATEGORIES[i % DEVICE_CATEGORIES.length], device: `Dev ${i}`,
        status: STATUSES[i % STATUSES.length],
        pin: { sheet: (await loadLevelPlan(store, DEMO_LEVEL_ID))!.sheet!.id, x: Math.round(pts[i]!.x), y: Math.round(pts[i]!.y) },
      }));
      if (i % 2 === 0) await store.apply(op('punch_item', uuidv7(), pid, { level_id: DEMO_LEVEL_ID, device_id: id, item: `Run ${i}`, owner: i % 4 === 0 ? 'EC' : 'ETC', tracking_status: 'Open' }));
      if (i % 3 === 0) await store.apply(op('missing_part', uuidv7(), pid, { level_id: DEMO_LEVEL_ID, device_id: id, part: 'Wagos', owner: 'EC', part_status: 'Needed' }));
      if (i % 3 === 1) await store.apply(op('cable_end', uuidv7(), pid, { cable_id: cable, side: 'A', level_id: DEMO_LEVEL_ID, device_id: id, status: 'Issue', to_text: `Rack ${i}` }));
    }

    const t0 = performance.now();
    const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    const lists = await loadLevelLists(store, pid, DEMO_LEVEL_ID, plan.level.code, plan.devices);
    const loadMs = performance.now() - t0;
    expect(plan.devices.length).toBeGreaterThanOrEqual(N);
    expect(lists.punch.length).toBeGreaterThanOrEqual(N / 2);
    expect(lists.connections.length).toBeGreaterThanOrEqual(N / 3);

    const t1 = performance.now();
    const f = { ...EMPTY_FILTER, statuses: ['Issue' as const], owners: ['EC' as const], openPunch: true };
    const devs = plan.devices.filter((d) => matchesFilter(d, f));
    const punch = lists.punch.filter((r) => rowMatches(r, f));
    const hits = await searchIds(store, DEMO_LEVEL_ID, 'rack 4', lists.connections);
    const filterMs = performance.now() - t1;
    expect(devs.length).toBeGreaterThan(0);
    expect(punch.length).toBeGreaterThan(0);
    expect(hits!.size).toBeGreaterThan(0);
    console.log(`[density] ${plan.devices.length} devices / ${lists.punch.length} punch / ${lists.parts.length} parts / ${lists.connections.length} conns — load ${loadMs.toFixed(0)} ms, filter+search ${filterMs.toFixed(0)} ms`);
    expect(loadMs).toBeLessThan(1500);
    expect(filterMs).toBeLessThan(500);
  });
});

describe('the 500-pin demo level', () => {
  it('seeds 500 placed devices plus one unplaced, with punch items and parts', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
    await ensureDemoLevel(store, () => {}, 500);
    const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    expect(plan.devices).toHaveLength(501);
    expect(plan.devices.filter((d) => d.pin)).toHaveLength(500);
    expect(new Set(plan.devices.map((d) => d.label)).size).toBe(501);
    const lists = await loadLevelLists(store, plan.level.projectId, DEMO_LEVEL_ID, plan.level.code, plan.devices);
    expect(lists.punch.length).toBeGreaterThan(100);
    expect(lists.parts.length).toBeGreaterThan(100);
    expect(demoOps(0).length).toBeLessThan(demoOps(500).length); // the normal demo is unchanged in kind
  });
});
