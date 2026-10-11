import {
  Editor,
  Store,
  emptyStrokeList,
  makeStroke,
  parseStrokeList,
  serializeStrokeList,
  uuidv7,
  withStroke,
  type Op,
} from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { DEMO_LEVEL_ID, DEMO_SHEET_ID, DEMO_SHEET_SIZE, ensureDemoLevel } from '../plan/demo';
import { loadLevelPlan } from '../plan/data';
import { INK_CONTEXT, loadInkLayers, ownLayer, saveInkLayer } from './model';

const ANN = uuidv7();
const BOB = uuidv7();
const sha = (n: number) => n.toString(16).padStart(64, '0');

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  let clock = 1_760_500_000_000;
  const now = () => new Date((clock += 1000)).toISOString();
  const ann = new Editor(store, { projectId: plan.level.projectId, userId: ANN, now });
  const bob = new Editor(store, { projectId: plan.level.projectId, userId: BOB, now });
  return { store, ann, bob };
}

describe('plan ink layers (T24, D53)', () => {
  it('the first save creates the layer, later saves replace its blob with drawing_blob + updated_at in one group', async () => {
    const { store, ann } = await setup();
    const first = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(1), at: '2026-10-10T15:00:00.000Z' });
    expect(first.ops).toHaveLength(1);
    expect(first.ops[0]).toMatchObject({ kind: 'create', entity_kind: 'ink_layer', change_type: INK_CONTEXT.change_type, reason: 'Plan ink' });
    expect(first.ops[0]!.payload).toMatchObject({ sheet_id: DEMO_SHEET_ID, user_id: ANN, drawing_blob: sha(1), updated_at: '2026-10-10T15:00:00.000Z' });

    const second = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: first.layerId, sha256: sha(2), at: '2026-10-10T15:00:05.000Z' });
    expect(second.layerId).toBe(first.layerId);
    expect(second.ops.map((o: Op) => o.field).sort()).toEqual(['drawing_blob', 'updated_at']);
    expect(new Set(second.ops.map((o) => o.group_id)).size).toBe(1);
    expect(second.ops.find((o) => o.field === 'drawing_blob')).toMatchObject({ was: sha(1), now: sha(2) });

    const layers = await loadInkLayers(store, DEMO_SHEET_ID);
    expect(layers).toEqual([{ id: first.layerId, userId: ANN, blob: sha(2), updatedAt: '2026-10-10T15:00:05.000Z' }]);
    expect(ownLayer(layers, ANN)?.id).toBe(first.layerId);
    expect(ownLayer(layers, BOB)).toBeNull();
  });

  it('one layer per (sheet, user): others are listed for read-only drawing and cannot be written', async () => {
    const { store, ann, bob } = await setup();
    const a = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(3), at: '2026-10-10T15:00:00.000Z' });
    const b = await saveInkLayer(bob, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(4), at: '2026-10-10T15:01:00.000Z' });
    const layers = await loadInkLayers(store, DEMO_SHEET_ID);
    expect(layers.map((l) => l.userId)).toEqual([BOB, ANN]); // newest first
    expect(ownLayer(layers, ANN)!.id).toBe(a.layerId);
    await expect(saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: b.layerId, sha256: sha(5), at: '2026-10-10T15:02:00.000Z' })).rejects.toThrow(/owner only/);
    expect(await loadInkLayers(store, uuidv7())).toEqual([]);
  });

  it('the same user on two iPads may end with two rows: the newest is theirs to edit, both are drawn', async () => {
    const { store, ann } = await setup();
    await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(6), at: '2026-10-10T15:00:00.000Z' });
    const later = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(7), at: '2026-10-10T16:00:00.000Z' });
    const layers = await loadInkLayers(store, DEMO_SHEET_ID);
    expect(layers).toHaveLength(2);
    expect(ownLayer(layers, ANN)!.id).toBe(later.layerId);
  });

  it('a sheet-space stroke list with Pencil pressure, a note and a photo mark survives the blob round trip', () => {
    let list = emptyStrokeList('sheet', DEMO_SHEET_SIZE.width, DEMO_SHEET_SIZE.height);
    const at = '2026-10-10T15:00:00.000Z';
    list = withStroke(list, makeStroke({ id: uuidv7(), tool: 'pen', color: '#e53935', width: 3 / 0.2, points: [{ x: 1000, y: 900, p: 0.2 }, { x: 1050, y: 905, p: 0.9 }], at }));
    list = withStroke(list, makeStroke({ id: uuidv7(), tool: 'highlighter', color: '#fdd835', width: 60, points: [{ x: 10, y: 10, p: 0.5 }, { x: 400, y: 10, p: 0.5 }], at }));
    list = withStroke(list, makeStroke({ id: uuidv7(), tool: 'text', color: '#1e88e5', width: 70, points: [{ x: 2000, y: 1500, p: 1 }], text: 'Panel moved to east wall', at }));
    list = withStroke(list, makeStroke({ id: uuidv7(), tool: 'marker', color: '#37474f', width: 130, points: [{ x: 2100, y: 1600, p: 1 }], ref: { kind: 'photo', id: 'p1' }, at }));
    const back = parseStrokeList(serializeStrokeList(list));
    expect(back).toMatchObject({ space: 'sheet', width: 4235.5, height: 3604.7, skipped: 0 });
    expect(back.strokes.map((s) => s.tool)).toEqual(['pen', 'highlighter', 'text', 'marker']);
    expect(back.strokes[0]!.points).toEqual([1000, 900, 0.2, 1050, 905, 0.9]);
    expect(back.strokes[3]!.ref).toEqual({ kind: 'photo', id: 'p1' });
  });
});

describe('Pencil pressure from gesture-handler (T24 fix, D116)', () => {
  it('uses stylus pressure when the Pencil gives one, else the finger default', async () => {
    const { pressureOf } = await import('./pressure');
    expect(pressureOf({ pressure: 0.12 })).toBe(0.12);
    expect(pressureOf({ pressure: 1.7 })).toBe(1);
    expect(pressureOf({ pressure: 0 })).toBe(0.5);
    expect(pressureOf(undefined)).toBe(0.5);
    expect(pressureOf({ pressure: Number.NaN })).toBe(0.5);
  });
});

describe('undo history (T24-6 fix)', () => {
  it('steps back through strokes, notes and erases, and back to an empty layer', async () => {
    const { pushUndo, popUndo } = await import('./history');
    const at = '2026-10-11T10:00:00.000Z';
    const empty = emptyStrokeList('sheet', 100, 100);
    const a = withStroke(empty, makeStroke({ id: 'pen', tool: 'pen', color: '#111111', width: 2, points: [{ x: 1, y: 1, p: 0.5 }], at }));
    const b = withStroke(a, makeStroke({ id: 'note', tool: 'text', color: '#111111', width: 9, points: [{ x: 5, y: 5, p: 1 }], text: 'hi', at }));
    const c = { ...b, strokes: b.strokes.filter((s) => s.id !== 'note') }; // the note erased
    let stack = pushUndo([], null);
    stack = pushUndo(stack, a);
    stack = pushUndo(stack, b);
    let step = popUndo(stack, c)!; // undo the erase: the note is back
    expect(step.list!.strokes.map((s) => s.id)).toEqual(['pen', 'note']);
    step = popUndo(step.stack, step.list)!; // undo the note
    expect(step.list!.strokes.map((s) => s.id)).toEqual(['pen']);
    step = popUndo(step.stack, step.list)!; // undo the first stroke: empty, same surface
    expect(step.list).toMatchObject({ strokes: [], width: 100, height: 100 });
    expect(popUndo(step.stack, step.list)).toBeNull();
    expect(pushUndo(Array(100).fill(null), a, 100)).toHaveLength(100);
  });
});

describe('camera marks open their photo (T23-10 fix)', () => {
  it('finds the topmost photo mark near a sheet point in any layer', async () => {
    const { photoMarkAt } = await import('./geometry');
    const at = '2026-10-11T10:00:00.000Z';
    const mark = (id: string, x: number) =>
      makeStroke({ id: `m-${id}`, tool: 'marker', color: '#37474f', width: 130, points: [{ x, y: 500, p: 1 }], ref: { kind: 'photo', id }, at });
    const mine = withStroke(emptyStrokeList('sheet', 4000, 3000), mark('p1', 1000));
    const theirs = withStroke(withStroke(emptyStrokeList('sheet', 4000, 3000), mark('p2', 2000)), makeStroke({ id: 'pen', tool: 'pen', color: '#111111', width: 5, points: [{ x: 1000, y: 500, p: 0.5 }], at }));
    expect(photoMarkAt([theirs, mine], 1040, 520, 10)).toBe('p1');
    expect(photoMarkAt([theirs, mine], 2000, 560, 10)).toBe('p2');
    expect(photoMarkAt([theirs, mine], 1500, 500, 10)).toBeNull(); // between them
    expect(photoMarkAt([], 1000, 500, 10)).toBeNull();
  });
});
