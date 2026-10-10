import { describe, expect, it } from 'vitest';

import { dummyPins, nearestPin, pinShape, pinStyle, DEVICE_CATEGORIES, CONNECTION_STATUSES } from './pins';
import {
  apply,
  compose,
  invert,
  pageToSheet,
  scaleOf,
  sheetToView,
  toSkiaMatrix,
  viewToSheet,
  type PdfViewport,
} from './viewport';

// The 06M composite as PDFKit reports it: 4235.48 × 3604.72 pt, CropBox at the origin, no rotation.
const CROP = { x: 0, y: 0, width: 4235.48, height: 3604.7203 };

/** PDFKit's page→view map for an unrotated page: y flips, scaled by s, page top-left at (ox, oy). */
function unrotated(s: number, ox: number, oy: number): PdfViewport {
  return { a: s, b: 0, c: 0, d: -s, tx: ox, ty: oy + s * CROP.height, cropBox: CROP, page: 1 };
}

const close = (p: { x: number; y: number }, q: { x: number; y: number }) => {
  expect(p.x).toBeCloseTo(q.x, 6);
  expect(p.y).toBeCloseTo(q.y, 6);
};

describe('viewport affine maps', () => {
  it('maps the sheet top-left to the page top-left in view space at three zoom levels', () => {
    for (const s of [0.28, 1, 4]) {
      const vp = unrotated(s, 12, -300);
      const m = sheetToView(vp);
      close(apply(m, { x: 0, y: 0 }), { x: 12, y: -300 });
      close(apply(m, { x: CROP.width, y: CROP.height }), { x: 12 + s * CROP.width, y: -300 + s * CROP.height });
      expect(scaleOf(m)).toBeCloseTo(s, 9);
    }
  });

  it('view → sheet inverts sheet → view', () => {
    const vp = unrotated(2.5, -1000, -740);
    const fwd = sheetToView(vp);
    const back = viewToSheet(vp);
    const p = { x: 1234.5, y: 987.25 };
    close(apply(back, apply(fwd, p)), p);
    const id = compose(fwd, back);
    expect(id.a).toBeCloseTo(1);
    expect(id.d).toBeCloseTo(1);
    expect(id.b).toBeCloseTo(0);
    expect(id.c).toBeCloseTo(0);
    expect(id.tx).toBeCloseTo(0);
    expect(id.ty).toBeCloseTo(0);
  });

  it('agrees with PDFKit page coordinates (pageToSheet) for the same view point', () => {
    const vp = unrotated(0.5, 40, 20);
    const sheet = { x: 2000, y: 1500 };
    const view = apply(sheetToView(vp), sheet);
    // PDFKit would report the page point (x, height − y) for that view point.
    const pagePoint = { x: 2000, y: CROP.height - 1500 };
    close(pageToSheet(vp, pagePoint), sheet);
    close(apply(viewToSheet(vp), view), sheet);
  });

  it('handles a rotated page (90°) through the general affine', () => {
    // A 90° rotation: page x runs down the view, page y runs right.
    const s = 1;
    const vp: PdfViewport = { a: 0, b: s, c: s, d: 0, tx: 0, ty: 0, cropBox: CROP, page: 1 };
    const m = sheetToView(vp);
    // sheet (0,0) = page (0, height) → view (s·height, 0)
    close(apply(m, { x: 0, y: 0 }), { x: CROP.height, y: 0 });
    expect(scaleOf(m)).toBeCloseTo(1);
    const back = invert(m);
    close(apply(back, apply(m, { x: 5, y: 7 })), { x: 5, y: 7 });
  });

  it('serialises row-major for Skia', () => {
    expect(toSkiaMatrix({ a: 1, b: 2, c: 3, d: 4, tx: 5, ty: 6 })).toEqual([1, 3, 5, 2, 4, 6, 0, 0, 1]);
  });

  it('refuses a singular transform', () => {
    expect(() => invert({ a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 })).toThrow(/singular/);
  });
});

describe('pins', () => {
  it('gives every category a shape and every status a style', () => {
    for (const c of DEVICE_CATEGORIES) expect(pinShape(c, 28)).toBeTruthy();
    for (const s of CONNECTION_STATUSES) expect(pinStyle(s).fill).toMatch(/^#/);
    expect(pinStyle('Not installed')).toMatchObject({ hollow: true, glyph: 'NI' });
    expect(pinShape('Station', 28)).toEqual({ kind: 'circle', radius: 14 });
    const diamond = pinShape('Sensor', 20);
    expect(diamond.kind).toBe('polygon');
    if (diamond.kind === 'polygon') expect(diamond.points[0].y).toBeLessThan(0); // vertex up
  });

  it('places 40 deterministic dummy pins inside the sheet with the project ID formats', () => {
    const a = dummyPins(40, CROP.width, CROP.height);
    const b = dummyPins(40, CROP.width, CROP.height);
    expect(a).toEqual(b);
    expect(a).toHaveLength(40);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(CROP.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(CROP.height);
      expect(p.id).toMatch(/^06M-(\d\d|S\d+|D\d+)$/);
    }
    expect(new Set(a.map((p) => p.id)).size).toBe(40);
    expect(a.filter((p) => p.category === 'Station').every((p) => p.id.startsWith('06M-S'))).toBe(true);
  });

  it('hit-tests the nearest pin within a radius', () => {
    const pins = [
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 130, y: 100 },
    ];
    expect(nearestPin(pins, { x: 118, y: 102 }, 20)?.id).toBe('b');
    expect(nearestPin(pins, { x: 500, y: 500 }, 20)).toBeNull();
  });
});
