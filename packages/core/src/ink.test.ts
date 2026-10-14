import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { BetterSqliteDriver } from './better-sqlite-driver';
import { Editor } from './editor';
import { uuidv7 } from './ids';
import { INK_MERGE_PREFIX, reconcileInkLayer } from './ink';
import type { Op } from './op';
import { Store } from './store';
import { emptyStrokeList, makeStroke, serializeStrokeList, withStroke, withoutStroke, type StrokeList } from './strokes';
import { SyncEngine } from './sync';
import { FakeServer } from './testing/fake-server';

/**
 * T87: the M3 round's lost ink. Both iPads ran under one team name (D160) and wrote that person's
 * layer offline from the same copy; B synced first, and A's write — older by `client_ts` — was
 * stored `superseded` (D37), which the after-pull merge used to ignore.
 */
describe('ink layer merge after a pull (T72 D133, T87)', () => {
  const PROJECT = uuidv7();
  const SHEET = uuidv7();
  const LANDRY = uuidv7();
  const CTX = { change_type: 'Field survey', reason: 'Plan ink' } as const;
  let clock = 1_760_700_000_000;
  const tsNext = () => new Date((clock += 60_000)).toISOString();
  const at = '2026-10-13T23:40:00.000Z';
  const st = (id: string) => makeStroke({ id, tool: 'pen', color: '#e53935', width: 2, points: [{ x: 10, y: 10, p: 0.5 }], at });
  const listOf = (...ids: string[]) => ids.reduce((l, id) => withStroke(l, st(id)), emptyStrokeList('sheet', 100, 100));
  const ids = (l: StrokeList | null) => (l?.strokes ?? []).map((s) => s.id);

  const blobs = new Map<string, StrokeList>();
  const put = (l: StrokeList) => {
    const key = createHash('sha256').update(serializeStrokeList(l)).digest('hex');
    blobs.set(key, l);
    return key;
  };
  const read = async (key: string) => blobs.get(key) ?? null;

  type Client = { store: Store; editor: Editor; engine: SyncEngine };
  async function client(server: FakeServer, user: string): Promise<Client> {
    const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    await store.applyRemote({
      op_id: uuidv7(), project_id: PROJECT, user_id: user, install_id: 'seed', client_ts: '2026-10-01T00:00:00.000Z',
      entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
      change_type: 'Master edit', server_seq: 0, server_ts: '2026-10-01T00:00:00.000Z', state: 'applied',
    } as Op);
    return { store, editor: new Editor(store, { projectId: PROJECT, userId: user, now: tsNext }), engine: new SyncEngine(store, server, { log: () => {} }) };
  }
  async function sync(...cs: Client[]) {
    for (const c of cs) expect((await c.engine.sync()).outcome).toBe('ran');
  }
  const write = (c: Client, layerId: string, list: StrokeList, reason?: string) =>
    c.editor.setFields('ink_layer', layerId, { drawing_blob: put(list), updated_at: tsNext() }, { ...CTX, reason: reason ?? CTX.reason });
  const headOf = async (c: Client, layerId: string) => read(String((await c.store.get<{ drawing_blob: string }>('ink_layer', layerId))!.drawing_blob));

  /** One person, two iPads, their layer with s1 s2 s3 on both. */
  async function world() {
    const server = new FakeServer();
    const a = await client(server, LANDRY);
    const b = await client(server, LANDRY);
    const base = listOf('s1', 's2', 's3');
    const { id: layerId } = await a.editor.create('ink_layer', { sheet_id: SHEET, user_id: LANDRY, drawing_blob: put(base), updated_at: tsNext() }, CTX);
    await sync(a, b);
    return { server, a, b, base, layerId };
  }

  it('same person on two iPads: the write that lost by client_ts (superseded) is merged in, once', async () => {
    const { server, a, b, base, layerId } = await world();
    // offline: A draws a1 and erases s1 first, B draws b1 a little later
    const aWrite = (await write(a, layerId, withStroke(withoutStroke(base, 's1'), st('a1'))))!.find((o) => o.field === 'drawing_blob')!;
    await write(b, layerId, withStroke(base, st('b1')));
    await sync(b, a, b); // B first; A's write arrives older than B's → superseded (D37), the head is B's
    expect(server.ops().find((o) => o.op_id === aWrite.op_id)!.state).toBe('superseded');
    for (const c of [a, b]) {
      expect(await c.store.getOp(aWrite.op_id)).toMatchObject({ state: 'superseded' });
      expect(ids(await headOf(c, layerId))).toEqual(['s1', 's2', 's3', 'b1']); // A's strokes not shown: the M3 fail
    }

    // either iPad merges to the same list: A's erase and stroke and B's stroke all kept
    const onA = (await reconcileInkLayer(a.store, layerId, read))!;
    const onB = (await reconcileInkLayer(b.store, layerId, read))!;
    expect(serializeStrokeList(onA.merged)).toBe(serializeStrokeList(onB.merged));
    expect(ids(onA.merged).sort()).toEqual(['a1', 'b1', 's2', 's3']);
    expect(onA.mergedOpIds).toEqual([aWrite.op_id]);

    const merge = (await write(a, layerId, onA.merged, `${INK_MERGE_PREFIX}${onA.mergedOpIds.join(',')}`))!.find((o) => o.field === 'drawing_blob')!;
    expect(merge.base_op_id).not.toBe(aWrite.op_id); // based on the official head, so the merge sits on its line
    await sync(a, b);
    for (const c of [a, b]) {
      expect(ids(await headOf(c, layerId)).sort()).toEqual(['a1', 'b1', 's2', 's3']);
      expect(await reconcileInkLayer(c.store, layerId, read)).toBeNull();
    }
    // a later deliberate erase is never undone by merging the old writes again
    await write(b, layerId, withoutStroke(onA.merged, 'a1'));
    await sync(b, a);
    expect(await reconcileInkLayer(a.store, layerId, read)).toBeNull();
  });

  it('two saves on the losing iPad: only the last is merged, so its erase holds', async () => {
    const { a, b, base, layerId } = await world();
    const first = withStroke(base, st('a1'));
    await write(a, layerId, first);
    const second = (await write(a, layerId, withoutStroke(first, 'a1')))!.find((o) => o.field === 'drawing_blob')!; // drew a1, then erased it
    await write(b, layerId, withStroke(base, st('b1')));
    await sync(b, a, b);
    const r = (await reconcileInkLayer(a.store, layerId, read))!;
    expect(r.mergedOpIds).toEqual([second.op_id]);
    expect(ids(r.merged).sort()).toEqual(['b1', 's1', 's2', 's3']); // a1 stays erased
  });

  it('no common copy: a write not on the head line and sharing no base with it is unioned', async () => {
    const { a, b, layerId } = await world();
    // a write whose base is unknown on this iPad (e.g. history cut off): merged against nothing
    await write(a, layerId, listOf('x1'));
    await write(b, layerId, listOf('y1'));
    await sync(b, a, b);
    const ops = (await b.store.opsFor(layerId)).filter((o) => o.field === 'drawing_blob');
    const lost = ops.find((o) => o.state === 'superseded')!;
    // cut its line: pretend its base never reached this store
    await b.store['db'].exec(`UPDATE op SET base_op_id = NULL WHERE op_id = ?`, [lost.op_id]);
    const r = (await reconcileInkLayer(b.store, layerId, read))!;
    expect(ids(r.merged).sort()).toEqual(['x1', 'y1']);
  });
});
