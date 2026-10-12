import { Store } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { compareLabels, loadLevelPlan } from './data';
import { DEMO_LEVEL_ID, DEMO_SHEET_SIZE, ensureDemoLevel } from './demo';
import {
  DEFAULT_LAYERS,
  NO_STATUS,
  UNSURVEYED,
  EMPTY_FILTER,
  matchesFilter,
  ownerMatches,
  parsePrefs,
  statusKey,
  toggle,
  type Filterable,
  type PlanFilter,
} from './filters';
import { hitTest, layoutPins, type RenderPin } from './layout';
import { pinShape, pinStyleFor, statusRank } from './pins';
import { focusRect, inView, sheetRectToPage, sheetToView, apply, type PdfViewport } from './viewport';

const CROP = { x: 0, y: 0, width: 4235.48, height: 3604.72 };

/** PDFKit's page→view map for an unrotated page at zoom s with the page's top-left at (ox, oy). */
function vp(s: number, ox = 0, oy = 0): PdfViewport {
  return { a: s, b: 0, c: 0, d: -s, tx: ox, ty: oy + s * CROP.height, cropBox: CROP, page: 1 };
}

function dev(p: Partial<Filterable>): Filterable {
  return { category: 'Relay panel', status: 'Issue', openOwners: [], openPunch: 0, ...p };
}

function pin(id: string, x: number, y: number, status: string | null = 'Issue'): RenderPin {
  const st = pinStyleFor(status);
  return { id, x, y, category: 'Station', fill: st.fill, hollow: st.hollow, glyph: st.glyph, label: id, plus: false, isNew: false, photos: 0, rank: statusRank(status) };
}

describe('filters (D99)', () => {
  it('Owner: EC and ETC each also match EC/ETC; EC/ETC matches only EC/ETC', () => {
    expect(ownerMatches(['EC'], 'EC')).toBe(true);
    expect(ownerMatches(['EC'], 'EC/ETC')).toBe(true);
    expect(ownerMatches(['ETC'], 'EC/ETC')).toBe(true);
    expect(ownerMatches(['EC'], 'ETC')).toBe(false);
    expect(ownerMatches(['EC/ETC'], 'EC')).toBe(false);
    expect(ownerMatches(['EC/ETC'], 'ETC')).toBe(false);
    expect(ownerMatches(['EC/ETC'], 'EC/ETC')).toBe(true);
    expect(ownerMatches([], 'anything')).toBe(true);
  });

  it('combines category, status (incl. no status), owner and open punch', () => {
    const f: PlanFilter = { ...EMPTY_FILTER, categories: ['Station'], statuses: ['none', 'No access'] };
    expect(matchesFilter(dev({ category: 'Station', status: null }), f)).toBe(true);
    expect(matchesFilter(dev({ category: 'Station', status: 'No access' }), f)).toBe(true);
    expect(matchesFilter(dev({ category: 'Station', status: 'Issue' }), f)).toBe(false);
    expect(matchesFilter(dev({ category: 'Sensor', status: null }), f)).toBe(false);
    expect(matchesFilter(dev({ openOwners: ['EC/ETC'] }), { ...EMPTY_FILTER, owners: ['ETC'] })).toBe(true);
    expect(matchesFilter(dev({ openOwners: [] }), { ...EMPTY_FILTER, owners: ['ETC'] })).toBe(false);
    expect(matchesFilter(dev({ openPunch: 0 }), { ...EMPTY_FILTER, openPunch: true })).toBe(false);
    expect(matchesFilter(dev({ openPunch: 2 }), { ...EMPTY_FILTER, openPunch: true })).toBe(true);
    expect(matchesFilter(dev({}), EMPTY_FILTER)).toBe(true);
    expect(statusKey('Something old')).toBe('none');
  });

  it('toggle keeps the canonical order', () => {
    expect(toggle(['C', 'A'], 'B', ['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
    expect(toggle(['A', 'B'], 'A', ['A', 'B', 'C'])).toEqual(['B']);
  });

  it('stored prefs are read defensively and boundaries stay off until T45 (D100)', () => {
    expect(parsePrefs(null)).toEqual({ filter: EMPTY_FILTER, layers: DEFAULT_LAYERS });
    const p = parsePrefs({
      filter: { categories: ['Station', 7], statuses: ['Issue', 'Bogus'], owners: ['ETC/EC', 'EC'], openPunch: true },
      layers: { labels: false, boundaries: true, photos: 'yes' },
    });
    expect(p.filter).toEqual({ categories: ['Station'], statuses: ['Issue'], owners: ['EC'], openPunch: true });
    expect(p.layers).toEqual({ ...DEFAULT_LAYERS, labels: false, boundaries: false });
  });
});

describe('pins', () => {
  it('unknown categories get an octagon; missing status is grey with a dash', () => {
    const s = pinShape('Dimmer rack', 20);
    expect(s.kind === 'polygon' && s.points.length).toBe(8);
    expect(pinStyleFor(null)).toEqual({ fill: '#757575', hollow: false, glyph: '–' });
    expect(pinStyleFor('Not installed').hollow).toBe(true);
    expect(statusRank('Issue')).toBeGreaterThan(statusRank('Not installed'));
    expect(statusRank(null)).toBeGreaterThan(statusRank('Installed, untested'));
  });
});

describe('layout and clustering', () => {
  const pins = [pin('a', 1000, 1000, 'Complete'), pin('b', 1020, 1000, 'Issue'), pin('c', 1100, 1000), pin('d', 3000, 2500)];

  it('merges pins closer than clusterPx on screen at low zoom; cluster takes the most urgent colour', () => {
    const lay = layoutPins(pins, sheetToView(vp(0.2)), 1000, 800);
    // a–b are 4 px apart, c is 20 px from a: one cluster of three; d alone.
    expect(lay.clusters).toHaveLength(1);
    expect(lay.clusters[0]!.members).toEqual([0, 1, 2]);
    expect(lay.clusters[0]!.fill).toBe(pinStyleFor('Issue').fill);
    expect(lay.pins.map((p) => p.index)).toEqual([3]);
  });

  it('solo pins (both sides of a pin conflict, T26) never join a cluster', () => {
    const solo = pins.map((p, i) => (i < 2 ? { ...p, solo: true } : p));
    const lay = layoutPins(solo, sheetToView(vp(0.2)), 1000, 800);
    expect(lay.clusters).toEqual([]);
    expect(lay.pins.map((p) => p.index).sort()).toEqual([0, 1, 2, 3]);
  });

  it('splits as the zoom grows and never clusters at or above offZoom', () => {
    const mid = layoutPins(pins, sheetToView(vp(0.5)), 4000, 4000);
    expect(mid.clusters.map((c) => c.members)).toEqual([[0, 1]]);
    expect(layoutPins(pins, sheetToView(vp(1)), 5000, 5000).clusters.map((c) => c.members)).toEqual([[0, 1]]);
    const close = layoutPins(pins, sheetToView(vp(2)), 9000, 9000);
    expect(close.clusters).toHaveLength(0);
    expect(close.pins).toHaveLength(4);
  });

  it('does not depend on panning', () => {
    const a = layoutPins(pins, sheetToView(vp(0.3, 0, 0)), 1e5, 1e5, { clusterPx: 30, offZoom: 1, marginPx: 1e5 });
    const b = layoutPins(pins, sheetToView(vp(0.3, -537, 211)), 1e5, 1e5, { clusterPx: 30, offZoom: 1, marginPx: 1e5 });
    expect(b.clusters.map((c) => c.members)).toEqual(a.clusters.map((c) => c.members));
  });

  it('culls items outside the view plus margin', () => {
    const lay = layoutPins(pins, sheetToView(vp(1, -2900, -2400)), 300, 300, { clusterPx: 30, offZoom: 1, marginPx: 10 });
    expect(lay.pins.map((p) => p.index)).toEqual([3]);
  });

  it('hit-tests pins and clusters in view points', () => {
    const lay = layoutPins(pins, sheetToView(vp(0.2)), 1000, 800);
    const d = lay.pins[0]!;
    expect(hitTest(lay, d.vx + 5, d.vy - 5, 24)).toEqual({ kind: 'pin', index: 3 });
    const c = lay.clusters[0]!;
    expect(hitTest(lay, c.vx, c.vy, 24)).toEqual({ kind: 'cluster', members: [0, 1, 2] });
    expect(hitTest(lay, 5, 5, 24)).toBeNull();
  });
});

describe('focus and fit', () => {
  const view = { width: 800, height: 600 };

  it('shows one pin at maxZoom, centred, with the view aspect', () => {
    const r = focusRect([{ x: 1000, y: 500 }], view, 1.5);
    expect(r.width).toBeCloseTo(800 / 1.5);
    expect(r.height).toBeCloseTo(600 / 1.5);
    expect(r.x + r.width / 2).toBeCloseTo(1000);
    expect(r.y + r.height / 2).toBeCloseTo(500);
  });

  it('fits a cluster with padding, zooming no further than maxZoom', () => {
    const pts = [{ x: 0, y: 0 }, { x: 70, y: 10 }];
    const r = focusRect(pts, view, 10, 50);
    const zoom = view.width / r.width;
    expect(zoom).toBeCloseTo(700 / 70); // width-bound: (800 − 2·50) / 70
    expect(focusRect(pts, view, 2, 50).width).toBeCloseTo(400);
  });

  it('converts sheet rects to page space (y up) and tests visibility', () => {
    const v = vp(0.25);
    expect(sheetRectToPage(v, { x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 10, y: CROP.height - 70, width: 100, height: 50,
    });
    expect(inView(v, view, { x: 100, y: 100 })).toBe(true);
    expect(inView(v, view, { x: 4000, y: 100 })).toBe(false);
    const centre = apply(sheetToView(v), { x: 0, y: 0 });
    expect(centre).toEqual({ x: 0, y: 0 });
  });
});

describe('loadLevelPlan over the demo level', () => {
  it('loads devices with labels, pins, photo counts, open punch and owners', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { search: 'like' });
    expect(await ensureDemoLevel(store)).toBe(DEMO_LEVEL_ID);
    await ensureDemoLevel(store); // idempotent
    const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    expect(plan.level.code).toBe('06M');
    expect(plan.sheet).toMatchObject({ widthPt: DEMO_SHEET_SIZE.width, blob: null });
    expect(plan.devices).toHaveLength(36 + 6 + 4 + 2);
    expect(await store.outboxCount()).toBe(0);

    const labels = plan.devices.map((d) => d.label);
    expect(labels.slice(0, 3)).toEqual(['06M-01', '06M-02', '06M-03']);
    expect(labels[labels.length - 1]).toBe('06M-?');
    const fresh = plan.devices.find((d) => d.isNew)!;
    expect(fresh).toMatchObject({ label: '06M-?', fieldAddition: true, status: 'Issue' });

    const unplaced = plan.devices.filter((d) => !d.pin);
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0]!.pinElsewhere).toBe(false);

    // Every third device has one open punch item; closed items never count.
    expect(plan.devices.filter((d) => d.openPunch > 0)).toHaveLength(16);
    expect(plan.devices.every((d) => d.openPunch <= 1)).toBe(true);
    // Owners come from open punch items and open parts.
    const ecOnly = plan.devices.filter((d) => matchesFilter(d, { ...EMPTY_FILTER, owners: ['EC/ETC'] }));
    expect(ecOnly.every((d) => d.openOwners.includes('EC/ETC'))).toBe(true);
    expect(ecOnly.length).toBeGreaterThan(0);
    expect(plan.devices.reduce((n, d) => n + d.photos, 0)).toBeGreaterThan(0);
  });

  it('a soft-deleted device, photo or closed item drops out; unknown level is null', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { search: 'like' });
    await ensureDemoLevel(store);
    expect(await loadLevelPlan(store, 'nope')).toBeNull();
    const before = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    const target = before.devices.find((d) => d.photos > 0)!;
    await store.db.exec(`UPDATE photo SET deleted_at = '2026-10-10' WHERE device_id = ?`, [target.id]);
    await store.db.exec(`UPDATE device SET deleted_at = '2026-10-10' WHERE id = ?`, [before.devices[0]!.id]);
    const after = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    expect(after.devices).toHaveLength(before.devices.length - 1);
    expect(after.devices.find((d) => d.id === target.id)?.photos ?? 0).toBe(0);
  });

  it('orders IDs naturally', () => {
    const ids = ['06M-S12', '06M-?', '06M-10', '06M-S2', '06M-02', '06M-D1'];
    expect([...ids].sort(compareLabels)).toEqual(['06M-02', '06M-10', '06M-D1', '06M-S2', '06M-S12', '06M-?']);
  });
});

describe('Unsurveyed (D110)', () => {
  it('is the name of the empty status; the stored value stays empty', () => {
    expect(UNSURVEYED).toBe('Unsurveyed');
    expect(statusKey(null)).toBe(NO_STATUS);
    expect(statusKey('Unsurveyed')).toBe(NO_STATUS);
  });
});

describe('pin labels show the device type (Landry, iPad retest)', () => {
  it('prefers Type, then Device, then category, and shortens long names', async () => {
    const { pinLabel } = await import('./data');
    expect(pinLabel({ type: 'Echo relay panel', device: 'CT06LCPA', category: 'Relay panel' })).toBe('Echo relay panel');
    expect(pinLabel({ type: null, device: 'P-NSPS-D', category: 'NSPS' })).toBe('P-NSPS-D');
    expect(pinLabel({ type: null, device: null, category: 'Station' })).toBe('Station');
    expect(pinLabel({ type: ' ', device: null, category: null })).toBe('Device');
    expect(pinLabel({ type: 'Paradigm architectural control processor', device: null, category: null })).toBe('Paradigm architectura…');
  });
});
