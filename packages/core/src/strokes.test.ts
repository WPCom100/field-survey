import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRESSURE,
  StrokeFormatError,
  emptyStrokeList,
  makeStroke,
  parseStrokeList,
  pressureScale,
  serializeStrokeList,
  strokeAt,
  strokeBounds,
  unpackPoints,
  withStroke,
  withoutLast,
  mergeStrokeLists,
  withStrokeColor,
  withoutStroke,
  type StrokePoint,
} from './strokes';

const AT = '2026-10-10T12:00:00.000Z';
const P = (x: number, y: number, p = DEFAULT_PRESSURE): StrokePoint => ({ x, y, p });

describe('stroke lists', () => {
  it('round-trips through canonical JSON byte for byte', () => {
    let list = emptyStrokeList('image', 4032, 3024);
    list = withStroke(list, makeStroke({ id: 's1', tool: 'pen', color: '#e53935', width: 12, points: [P(10.04, 20.06, 0.333), P(30, 40, 1.4)], at: AT }));
    list = withStroke(list, makeStroke({ id: 's2', tool: 'text', color: '#000000', width: 60, points: [P(5, 5)], text: '  LVD missing ', at: AT }));
    const json = serializeStrokeList(list);
    const back = parseStrokeList(json);
    expect(back.skipped).toBe(0);
    expect(serializeStrokeList(back)).toBe(json);
    expect(back.strokes[0]!.points).toEqual([10, 20.1, 0.33, 30, 40, 1]); // rounded, pressure clamped
    expect(back.strokes[1]!.text).toBe('LVD missing');
    expect(json.startsWith('{"format":"field-survey/strokes","version":1,"space":"image"')).toBe(true);
  });

  it('keeps exactly the points a shape needs and thins freehand jitter', () => {
    const arrow = makeStroke({ id: 'a', tool: 'arrow', color: '#000000', width: 2, points: [P(0, 0), P(1, 1), P(5, 5)], at: AT });
    expect(unpackPoints(arrow.points).map((q) => [q.x, q.y])).toEqual([[0, 0], [5, 5]]);
    const pen = makeStroke({ id: 'p', tool: 'pen', color: '#000000', width: 2, points: [P(0, 0), P(0.2, 0), P(0.4, 0), P(3, 0), P(3.1, 0)], at: AT, minStep: 1 });
    expect(unpackPoints(pen.points).map((q) => q.x)).toEqual([0, 3.1]); // the end point always survives
    expect(() => makeStroke({ id: 'e', tool: 'ellipse', color: '#000000', width: 2, points: [P(0, 0)], at: AT })).toThrow(StrokeFormatError);
    expect(() => makeStroke({ id: 't', tool: 'text', color: '#000000', width: 2, points: [P(0, 0)], text: ' ', at: AT })).toThrow(StrokeFormatError);
    expect(() => makeStroke({ id: 'm', tool: 'marker', color: '#000000', width: 2, points: [P(0, 0)], at: AT })).toThrow(StrokeFormatError);
  });

  it('undoes, removes and finds strokes', () => {
    let list = emptyStrokeList('sheet', 1000, 800);
    expect(withoutLast(list)).toBe(list);
    list = withStroke(list, makeStroke({ id: 'line', tool: 'pen', color: '#000000', width: 2, points: [P(0, 0), P(100, 0)], at: AT }));
    list = withStroke(list, makeStroke({ id: 'oval', tool: 'ellipse', color: '#000000', width: 2, points: [P(200, 200), P(400, 300)], at: AT }));
    list = withStroke(list, makeStroke({ id: 'cam', tool: 'marker', color: '#000000', width: 10, points: [P(600, 600)], ref: { kind: 'photo', id: 'ph' }, at: AT }));
    expect(strokeAt(list, 50, 1.5, 1)?.id).toBe('line');
    expect(strokeAt(list, 50, 30, 1)).toBeNull();
    expect(strokeAt(list, 300, 200, 1)?.id).toBe('oval'); // top of the outline
    expect(strokeAt(list, 300, 250, 1)).toBeNull(); // centre is not the outline
    expect(strokeAt(list, 605, 600, 1)?.id).toBe('cam');
    expect(strokeBounds(list.strokes[1]!)).toEqual({ x0: 200, y0: 200, x1: 400, y1: 300 });
    expect(withoutStroke(list, 'oval').strokes.map((s) => s.id)).toEqual(['line', 'cam']);
    expect(withoutLast(list).strokes.map((s) => s.id)).toEqual(['line', 'oval']);
  });

  it('refuses foreign or newer formats and drops a single bad stroke', () => {
    expect(() => parseStrokeList('nope')).toThrow(StrokeFormatError);
    expect(() => parseStrokeList('{"format":"pkdrawing"}')).toThrow(StrokeFormatError);
    expect(() => parseStrokeList('{"format":"field-survey/strokes","version":2,"space":"sheet","width":1,"height":1,"strokes":[]}')).toThrow(/version 2/);
    const good = { id: 'g', tool: 'pen', color: '#112233', width: 2, points: [1, 2, 0.5], at: AT };
    const bad = { id: 'b', tool: 'pen', color: 'red', width: 2, points: [1, 2], at: AT };
    const r = parseStrokeList(JSON.stringify({ format: 'field-survey/strokes', version: 1, space: 'sheet', width: 10, height: 10, strokes: [good, bad] }));
    expect(r.strokes.map((s) => s.id)).toEqual(['g']);
    expect(r.skipped).toBe(1);
  });

  it('scales width by pressure around the default', () => {
    expect(pressureScale(DEFAULT_PRESSURE)).toBeCloseTo(1);
    expect(pressureScale(0)).toBeCloseTo(0.4);
    expect(pressureScale(2)).toBeCloseTo(1.6);
  });
});

describe('merging two edits of one ink layer (D129, T72)', () => {
  const at = '2026-10-12T10:00:00.000Z';
  const st = (id: string, color = '#e53935') => makeStroke({ id, tool: 'pen', color, width: 2, points: [{ x: 1, y: 1, p: 0.5 }], at });
  const list = (...ids: (string | ReturnType<typeof st>)[]) => {
    let l = emptyStrokeList('sheet', 100, 100);
    for (const s of ids) l = withStroke(l, typeof s === 'string' ? st(s) : s);
    return l;
  };
  const ids = (l: { strokes: { id: string }[] }) => l.strokes.map((s) => s.id);

  it('keeps an add on one side and an erase on the other (concurrent add + erase)', () => {
    const base = list('01', '02');
    const a = withStroke(base, st('03')); // Ann adds (her own layer is elsewhere; an undo restore here)
    const b = withoutStroke(base, '01'); // Bob erases
    expect(ids(mergeStrokeLists(base, a, b))).toEqual(['02', '03']);
    expect(mergeStrokeLists(base, a, b)).toEqual(mergeStrokeLists(base, b, a)); // either side gets the same list
  });

  it('both erase (the same or different strokes): every erased stroke stays gone', () => {
    const base = list('01', '02', '03');
    expect(ids(mergeStrokeLists(base, withoutStroke(base, '01'), withoutStroke(base, '01')))).toEqual(['02', '03']);
    expect(ids(mergeStrokeLists(base, withoutStroke(base, '01'), withoutStroke(base, '03')))).toEqual(['02']);
  });

  it('a recolour on one side survives an erase of another stroke on the other; both recolour → the same winner either way', () => {
    const base = list('01', '02');
    const a = withStrokeColor(base, '01', '#1e88e5');
    const b = withoutStroke(base, '02');
    const m = mergeStrokeLists(base, a, b);
    expect(m.strokes).toEqual([{ ...st('01'), color: '#1e88e5' }]);
    const c = withStrokeColor(base, '01', '#43a047');
    expect(mergeStrokeLists(base, a, c)).toEqual(mergeStrokeLists(base, c, a));
    // erase beats recolour: an erased stroke is gone
    expect(ids(mergeStrokeLists(base, a, withoutStroke(base, '01')))).toEqual(['02']);
  });

  it('an edit made before a pull is replayed on the pulled copy (edit after a pull)', () => {
    const base = list('01', '02');
    const mine = withoutStroke(base, '02'); // erased offline
    const pulled = withStroke(withStrokeColor(base, '01', '#111111'), st('04')); // owner recoloured + drew
    const merged = mergeStrokeLists(base, mine, pulled);
    expect(merged.strokes).toEqual([{ ...st('01'), color: '#111111' }, st('04')]);
    expect(serializeStrokeList(mergeStrokeLists(base, merged, pulled))).toBe(serializeStrokeList(merged)); // merging again changes nothing
    expect(withStrokeColor(base, 'zz', '#111111')).toBe(base);
  });
});
