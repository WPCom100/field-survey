import {
  DEFAULT_PRESSURE,
  Editor,
  Store,
  emptyStrokeList,
  makeStroke,
  parseStrokeList,
  serializeStrokeList,
  uuidv7,
  withStroke,
  withStrokeColor,
  withoutStroke,
  SyncEngine,
  type Op,
  type StrokeList,
} from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DEMO_LEVEL_ID, DEMO_SHEET_ID, DEMO_SHEET_SIZE, ensureDemoLevel } from '../plan/demo';
import { loadLevelPlan } from '../plan/data';
import { INK_CONTEXT, INK_MERGE_PREFIX, listToSave, loadInkLayers, ownLayer, reconcileInkLayer, saveInkLayer } from './model';
import { createInkBus, parseInkMessage } from './touches';

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

  it("one layer per (sheet, user); since D129 anyone writes anyone's layer, which stays its owner's", async () => {
    const { store, ann, bob } = await setup();
    const a = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(3), at: '2026-10-10T15:00:00.000Z' });
    const b = await saveInkLayer(bob, { sheetId: DEMO_SHEET_ID, layerId: null, sha256: sha(4), at: '2026-10-10T15:01:00.000Z' });
    let layers = await loadInkLayers(store, DEMO_SHEET_ID);
    expect(layers.map((l) => l.userId)).toEqual([BOB, ANN]); // newest first
    expect(ownLayer(layers, ANN)!.id).toBe(a.layerId);
    const edit = await saveInkLayer(ann, { sheetId: DEMO_SHEET_ID, layerId: b.layerId, sha256: sha(5), at: '2026-10-10T15:02:00.000Z' });
    expect(edit.ops.every((o) => o.user_id === ANN && o.kind === 'set')).toBe(true); // Ann's edit, Bob's layer
    layers = await loadInkLayers(store, DEMO_SHEET_ID);
    expect(layers.find((l) => l.id === b.layerId)).toMatchObject({ userId: BOB, blob: sha(5) });
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

describe('draw-mode touches from the PDF view (T69, D129)', () => {
  it('parses start / move with coalesced samples / end / cancel; a finger draws at the default pressure', () => {
    expect(parseInkMessage('ink|start|10.5|20|-1.000000')).toEqual({ phase: 'start', points: [{ x: 10.5, y: 20, p: DEFAULT_PRESSURE }] });
    expect(parseInkMessage('ink|move|1|2|0.25|3|4|1.4')).toEqual({
      phase: 'move',
      points: [
        { x: 1, y: 2, p: 0.25 },
        { x: 3, y: 4, p: 1 },
      ],
    });
    expect(parseInkMessage('ink|end')).toEqual({ phase: 'end', points: [] });
    expect(parseInkMessage('ink|cancel')).toEqual({ phase: 'cancel', points: [] });
    expect(parseInkMessage('ink|move')).toBeNull(); // a move needs a point
    expect(parseInkMessage('viewport|1|0|0|1|0|0|0|0|10|10|1')).toBeNull();
    expect(parseInkMessage('ink|wiggle|1|2|3')).toBeNull();
  });

  it('delivers parsed touches to every listener until it unsubscribes', () => {
    const bus = createInkBus();
    const seen: string[] = [];
    const off = bus.listen((t) => seen.push(`${t.phase}:${t.points.length}`));
    bus.emit('ink|start|1|1|-1');
    bus.emit('pageSingleTap|1|2|3|4|5'); // not ink: ignored
    bus.emit('ink|cancel');
    off();
    bus.emit('ink|end');
    expect(seen).toEqual(['start:1', 'cancel:0']);
  });
});

describe("editing other people's ink (T72, D129)", () => {
  const PROJECT = uuidv7();
  const SHEET = uuidv7();
  let clock = 1_760_600_000_000;
  const tsNext = () => new Date((clock += 60_000)).toISOString();
  const at = '2026-10-12T10:00:00.000Z';
  const st = (id: string) => makeStroke({ id, tool: 'pen', color: '#e53935', width: 2, points: [{ x: 10, y: 10, p: 0.5 }], at });
  const listOf = (...ids: string[]) => ids.reduce((l, id) => withStroke(l, st(id)), emptyStrokeList('sheet', 100, 100));
  const ids = (l: { strokes: { id: string }[] } | null) => (l?.strokes ?? []).map((s) => s.id);

  /** The blob store every iPad shares in these tests: content-addressed like the real one. */
  const blobs = new Map<string, StrokeList>();
  const put = (l: StrokeList) => {
    const key = createHash('sha256').update(serializeStrokeList(l)).digest('hex');
    blobs.set(key, l);
    return key;
  };
  const read = async (key: string) => blobs.get(key) ?? null;
  const head = async (c: Client, layerId: string) => read(String((await c.store.get<{ drawing_blob: string }>('ink_layer', layerId))!.drawing_blob));

  type Client = { store: Store; editor: Editor; engine: SyncEngine };
  async function client(server: FakeServer, user: string): Promise<Client> {
    const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    await store.applyRemote({
      op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: '2026-10-01T00:00:00.000Z',
      entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
      change_type: 'Master edit', server_seq: 0, server_ts: '2026-10-01T00:00:00.000Z', state: 'applied',
    } as Op);
    const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
    return { store, editor, engine: new SyncEngine(store, server, { log: () => {} }) };
  }
  async function sync(...cs: Client[]) {
    for (const c of cs) expect((await c.engine.sync()).outcome).toBe('ran');
  }
  /** Bob's layer with three strokes, on every iPad. */
  async function world() {
    const server = new FakeServer();
    const ann = await client(server, ANN);
    const bob = await client(server, BOB);
    const base = listOf('s1', 's2', 's3');
    const { layerId } = await saveInkLayer(bob.editor, { sheetId: SHEET, layerId: null, sha256: put(base), at });
    await sync(bob, ann);
    expect(ids(await head(ann, layerId))).toEqual(['s1', 's2', 's3']);
    return { ann, bob, base, layerId, baseBlob: put(base) };
  }

  it('a save merges with a copy pulled since the edit started (edit after a pull)', async () => {
    const { ann, bob, base, layerId, baseBlob } = await world();
    const annErased = withoutStroke(base, 's1'); // Ann erases one of Bob's strokes…
    await saveInkLayer(bob.editor, { sheetId: SHEET, layerId, sha256: put(withStroke(base, st('s4'))), at }); // …while Bob draws on
    await sync(bob, ann);
    const toWrite = await listToSave(ann.store, { layerId, base, baseBlob, list: annErased }, read);
    expect(toWrite !== 'wait' && ids(toWrite)).toEqual(['s2', 's3', 's4']); // Bob's new stroke kept, Ann's erase kept
    // no newer copy: the edit is written as it is; a newer copy not downloaded yet: wait
    expect(await listToSave(ann.store, { layerId, base: toWrite as StrokeList, baseBlob: put(toWrite as StrokeList), list: annErased }, read)).not.toBe('wait');
    expect(await listToSave(ann.store, { layerId, base, baseBlob, list: annErased }, async () => null)).toBe('wait');
  });

  it("two iPads edit another user's layer offline, then sync: nothing is lost, and the merge is done once", async () => {
    const { ann, bob, base, layerId } = await world();
    // both offline from the same copy: Ann erases s1 and recolours s2 in Bob's layer, Bob erases s3 and draws s4
    const annList = withStrokeColor(withoutStroke(base, 's1'), 's2', '#1e88e5');
    await saveInkLayer(ann.editor, { sheetId: SHEET, layerId, sha256: put(annList), at });
    const bobList = withStroke(withoutStroke(base, 's3'), st('s4'));
    await saveInkLayer(bob.editor, { sheetId: SHEET, layerId, sha256: put(bobList), at });
    await sync(ann, bob, ann); // the server keeps the last write (Bob's): Ann's erase and recolour are not in it
    expect(ids(await head(ann, layerId))).toEqual(['s1', 's2', 's4']);

    // after the pull, the writes made from the same copy are merged (on either iPad: same result)
    const onAnn = (await reconcileInkLayer(ann.store, layerId, read))!;
    const onBob = (await reconcileInkLayer(bob.store, layerId, read))!;
    expect(serializeStrokeList(onAnn.merged)).toBe(serializeStrokeList(onBob.merged));
    expect(onAnn.merged.strokes.map((s) => [s.id, s.color])).toEqual([
      ['s2', '#1e88e5'],
      ['s4', '#e53935'],
    ]);
    await saveInkLayer(ann.editor, { sheetId: SHEET, layerId, sha256: put(onAnn.merged), at, reason: `${INK_MERGE_PREFIX}${onAnn.mergedOpIds.join(',')}` });
    await sync(ann, bob);
    expect(ids(await head(bob, layerId))).toEqual(['s2', 's4']);
    // merged once: neither iPad finds anything left to merge, so a later change is never undone
    expect(await reconcileInkLayer(ann.store, layerId, read)).toBeNull();
    expect(await reconcileInkLayer(bob.store, layerId, read)).toBeNull();
    const layer = (await loadInkLayers(bob.store, SHEET)).find((l) => l.id === layerId)!;
    expect(layer.userId).toBe(BOB); // still Bob's layer: the strokes keep their author
  });

  it('a merge waits while a needed copy is not on this iPad', async () => {
    const { ann, bob, base, layerId } = await world();
    await saveInkLayer(ann.editor, { sheetId: SHEET, layerId, sha256: put(withoutStroke(base, 's1')), at });
    await saveInkLayer(bob.editor, { sheetId: SHEET, layerId, sha256: put(withoutStroke(base, 's2')), at });
    await sync(ann, bob, ann);
    expect(await reconcileInkLayer(ann.store, layerId, async () => null)).toBeNull();
    expect(ids((await reconcileInkLayer(ann.store, layerId, read))!.merged)).toEqual(['s3']);
  });
});
