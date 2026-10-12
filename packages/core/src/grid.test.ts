import { describe, expect, it } from 'vitest';

import {
  chooseGridSet,
  drawingPosition,
  gridSummary,
  labelKey,
  labelKind,
  labelSequence,
  manualGridSet,
  nearestRoom,
  parseGridSets,
  parseSheetFeatures,
  roomText,
  snapLabel,
  type GridSet,
} from './grid';
import sets06m from './testing/grid-06m.json';

/** The three sets the server's text pass found on the 06M composite (test_plans.py). */
const SETS = parseGridSets(sets06m);

describe('the 06M sets as the server wrote them', () => {
  it('parse to three auto sets with unit frames', () => {
    expect(SETS.map((s) => [s.name, s.mode])).toEqual([
      ['A–H / 13.5–5', 'auto'],
      ['A.–F. / 15.–5.', 'auto'],
      ['R.–K. / 16.–13. (+22°)', 'auto'],
    ]);
    for (const s of SETS) {
      expect(s.residual).toBeLessThan(2);
      expect(Math.hypot(s.affine.a, s.affine.c)).toBeCloseTo(1, 1);
      expect(Math.hypot(s.affine.b, s.affine.d)).toBeCloseTo(1, 1);
    }
    expect(SETS[0]!.col_labels.map((l) => l.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'G.9', 'H']);
    expect(SETS[2]!.angle).toBeCloseTo(22, 0);
  });

  it('gives the master wording for a point (same cases as the Python twin)', () => {
    const dp = (x: number, y: number) => drawingPosition(SETS, { x, y });
    expect(dp(1100, 2200)).toBe('Grid B-C / 9-8');
    expect(dp(1248, 2054)).toBe('Grid C / 9');
    expect(dp(300, 2200)).toBe('Grid West of A / 9-8');
    expect(dp(1100, 500)).toBe('Grid B-C / North of 13.5');
    expect(dp(1100, 3500)).toBe('Grid B-C / South of 5');
    expect(dp(3300, 2600)).toBe('Grid C.-D. / 7.-6.');
    expect(dp(-5000, -5000)).toBeNull();
    const centennial = SETS.filter((s) => s.name.startsWith('A–H'));
    expect(drawingPosition(centennial, { x: 3000, y: 2200 })).toBe('Grid East of H / 9-8');
    const wt = SETS.filter((s) => s.name.startsWith('A.–F.')).map((s) => ({ ...s, prefix: 'WT' }));
    expect(drawingPosition(wt, { x: 3300, y: 2600 })).toBe('WT Grid C.-D. / 7.-6.');
  });

  it('chooses the set a point sits deepest in where two overlap, and none far away', () => {
    expect(chooseGridSet(SETS, { x: 1100, y: 2200 })).toBe(0);
    expect(chooseGridSet(SETS, { x: 3300, y: 2600 })).toBe(1);
    expect(chooseGridSet(SETS, { x: 9000, y: 9000 })).toBeNull();
    expect(chooseGridSet(SETS.map((s) => ({ ...s, mode: 'none' as const })), { x: 1100, y: 2200 })).toBeNull();
  });

  it('summarises for the Sources table', () => {
    expect(gridSummary(SETS)).toBe('auto ✓ 3 sets');
    expect(gridSummary([])).toBe('no grid found');
    expect(gridSummary([{ ...SETS[0]!, mode: 'none', residual: 4.1 }])).toBe('needs calibration (residual 4.1 pt)');
    expect(gridSummary([SETS[0]!, { ...SETS[1]!, mode: 'manual' }, { ...SETS[2]!, mode: 'none' }])).toBe('auto + manual ✓ 2 sets, 1 to calibrate');
  });
});

describe('parsing is defensive', () => {
  it('drops malformed sets and labels, reads JSON text too', () => {
    expect(parseGridSets(null)).toEqual([]);
    expect(parseGridSets('not json')).toEqual([]);
    expect(parseGridSets([{ name: 'x' }])).toEqual([]); // no affine
    const one = parseGridSets(JSON.stringify([{ affine: { a: 1, b: 0, c: 0, d: 1 }, col_labels: [{ label: 'A', pos: 5 }, { pos: 1 }, { label: 'B', pos: 1 }], mode: 'weird' }]));
    expect(one).toHaveLength(1);
    expect(one[0]!.mode).toBe('none');
    expect(one[0]!.col_labels).toEqual([
      { label: 'B', pos: 1 },
      { label: 'A', pos: 5 },
    ]);
    expect(one[0]!.name).toBe('Grid');
  });

  it('reads features and tolerates anything missing', () => {
    expect(parseSheetFeatures(undefined)).toEqual({ rooms: [], tags: [], bubbles: [], boundaries: [], boundary_labels: [] });
    const f = parseSheetFeatures({
      rooms: [{ code: 'XX06M-1E05', name: 'Elec', x: 1, y: 2 }, { code: 3 }],
      boundaries: [{ points: [[0, 0], [10, 0], ['x', 1]] }, { points: [[1, 1]] }],
      boundary_labels: [{ text: 'Ef.106.5.A', x: 5, y: 6 }],
      tags: [{ text: 'EBDK', x: 1, y: 1, size: 8 }],
    });
    expect(f.rooms).toEqual([{ code: 'XX06M-1E05', name: 'Elec', x: 1, y: 2 }]);
    expect(f.boundaries).toEqual([{ points: [[0, 0], [10, 0]] }]);
    expect(f.boundary_labels).toHaveLength(1);
    expect(f.tags[0]!.size).toBe(8);
  });
});

describe('rooms', () => {
  const f = parseSheetFeatures({
    rooms: [
      { code: 'XX06M-2SV01', name: 'Stair A Vestibule', x: 1300, y: 791 },
      { code: 'XX06M-1E05', name: 'Elec', x: 1633, y: 1054 },
      { code: 'XX06M-C004', name: null, x: 2392, y: 2867 },
    ],
  });
  it('finds the nearest code within reach and words it like the master', () => {
    expect(roomText(nearestRoom(f, { x: 1350, y: 800 })!)).toBe('Stair A Vestibule XX06M-2SV01');
    expect(roomText(nearestRoom(f, { x: 2400, y: 2900 })!)).toBe('XX06M-C004');
    expect(nearestRoom(f, { x: 100, y: 100 })).toBeNull();
    expect(nearestRoom(f, { x: 100, y: 100 }, 5000)!.code).toBe('XX06M-2SV01');
  });
});

describe('labels', () => {
  it('knows kinds, order and the dotted style', () => {
    expect(labelKind('A')).toBe('alpha');
    expect(labelKind('c.')).toBe('alpha');
    expect(labelKind('13.5')).toBe('num');
    expect(labelKind('OF')).toBeNull();
    expect(labelKind('')).toBeNull();
    expect(labelKey('A')).toBe(1);
    expect(labelKey('AA')).toBe(27);
    expect(labelKey('G.9')).toBeCloseTo(7.9);
    expect(labelKey('9.')).toBe(9);
    expect(labelSequence('A', 'D')).toEqual(['A', 'B', 'C', 'D']);
    expect(labelSequence('D', 'A')).toEqual(['D', 'C', 'B', 'A']);
    expect(labelSequence('C.', 'F.')).toEqual(['C.', 'D.', 'E.', 'F.']);
    expect(labelSequence('9', '12')).toEqual(['9', '10', '11', '12']);
    expect(labelSequence('9.5', '12')).toEqual(['9.5', '12']);
    expect(labelSequence('A', '3')).toBeNull();
  });
});

describe('manual three-tap calibration', () => {
  // an orthogonal grid: columns A..H every 300 pt from x=600, rows 1..13 every 300 pt from y=3300 upward
  const colX = (k: number) => 600 + (k - 1) * 300;
  const rowY = (n: number) => 3300 - (n - 1) * 300;

  it('two column bubbles and one row bubble make a usable set', () => {
    const gs = manualGridSet([
      { x: colX(1), y: 400, label: 'A' },
      { x: colX(8), y: 400, label: 'H' },
      { x: 450, y: rowY(9), label: '9' },
    ]);
    expect(gs.mode).toBe('manual');
    expect(gs.col_labels.map((l) => l.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(gs.col_labels[2]!.pos).toBeCloseTo(colX(3));
    // rows: the tapped 9 and its neighbours at the column spacing, numbers growing northward
    expect(gs.row_labels.map((l) => l.label)).toEqual(['12', '11', '10', '9', '8', '7', '6']);
    expect(gs.row_labels.find((l) => l.label === '9')!.pos).toBeCloseTo(rowY(9));
    expect(gs.row_labels.find((l) => l.label === '8')!.pos).toBeCloseTo(rowY(8));
    expect(drawingPosition([gs], { x: colX(2) + 150, y: rowY(9) + 150 })).toBe('Grid B-C / 9-8');
    expect(drawingPosition([gs], { x: colX(5), y: rowY(7) })).toBe('Grid E / 7');
    expect(drawingPosition([gs], { x: colX(8) + 200, y: rowY(9) })).toBe('Grid East of H / 9');
    expect(gs.name).toBe('A–H / 12–6');
  });

  it('a fourth tap fixes the other axis spacing; taps can come in any order', () => {
    const gs = manualGridSet(
      [
        { x: 450, y: rowY(13), label: '13' },
        { x: colX(3), y: 400, label: 'C' },
        { x: 450, y: rowY(1), label: '1' },
        { x: colX(1), y: 400, label: 'A' },
      ],
      { prefix: 'WT', name: 'Main' },
    );
    expect(gs.row_labels.map((l) => l.label)).toEqual(['13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    expect(gs.row_labels[0]!.pos).toBeCloseTo(rowY(13));
    expect(drawingPosition([gs], { x: colX(1) + 150, y: rowY(5) - 150 })).toBe('WT Grid A-B / 6-5');
    expect(gs.name).toBe('Main');
  });

  it('works on a rotated grid', () => {
    // columns along a line rotated 30°: the normal of the column lines is that direction
    const rot = (x: number, y: number) => ({ x: x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), y: x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6) });
    const a = rot(0, 0);
    const d = rot(900, 0);
    const r1 = rot(-100, 600);
    const gs = manualGridSet([
      { ...a, label: 'A' },
      { ...d, label: 'D' },
      { ...r1, label: '1' },
    ]);
    expect(gs.angle).toBeCloseTo(30, 0);
    // rows grow northward from the tapped 1 at the column spacing of 300
    expect(drawingPosition([gs], rot(450, 300))).toBe('Grid B-C / 2');
    expect(drawingPosition([gs], rot(450, 450))).toBe('Grid B-C / 2-1');
    expect(drawingPosition([gs], rot(450, -300))).toBe('Grid B-C / 4');
  });

  it('refuses taps that cannot make a grid', () => {
    expect(() => manualGridSet([{ x: 0, y: 0, label: 'A' }, { x: 300, y: 0, label: 'B' }])).toThrow(/three/);
    expect(() => manualGridSet([{ x: 0, y: 0, label: 'A' }, { x: 300, y: 0, label: 'B' }, { x: 0, y: 300, label: 'OF' }])).toThrow(/not a grid label/);
    expect(() => manualGridSet([{ x: 0, y: 0, label: 'A' }, { x: 300, y: 0, label: 'B' }, { x: 0, y: 300, label: 'C' }])).toThrow(/both axes/);
    expect(() => manualGridSet([{ x: 0, y: 0, label: 'A' }, { x: 300, y: 0, label: 'A' }, { x: 0, y: 300, label: '1' }])).toThrow(/different/);
    expect(() => manualGridSet([{ x: 0, y: 0, label: 'A' }, { x: 0, y: 0, label: 'B' }, { x: 0, y: 300, label: '1' }])).toThrow(/same spot/);
  });

  it('snaps a tap to the printed label nearest it', () => {
    const f = parseSheetFeatures({ bubbles: [{ text: '22', x: 1671, y: 1931 }] });
    expect(snapLabel(SETS, f, { x: 655, y: 418 })).toBe('A');
    expect(snapLabel(SETS, f, { x: 1680, y: 1940 })).toBe('22');
    expect(snapLabel(SETS, f, { x: 100, y: 100 })).toBeNull();
  });
});

describe('a set with no labels on one axis', () => {
  it('claims nothing', () => {
    const gs: GridSet = { ...SETS[0]!, row_labels: [] };
    expect(drawingPosition([gs], { x: 1100, y: 2200 })).toBeNull();
  });
});
