/**
 * TP-1, TP-7, TP-10 and TP-11 automated (T14): two iPads (core stores) against the real server
 * in Docker. Scripts follow docs/history/Phase4_Delivery_Plan.md §4; expectations cite PLAN
 * §3.2/§3.3. Opt-in: see ./harness.ts and packages/core/docs/e2e.md.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { deviceIdFor } from '../device-id';
import { HttpTransport } from '../http-transport';
import type { Op } from '../op';
import { NUMBERED, displayNumber, type NumberedKind } from '../numbering';
import { openReviewItems, reviewFields } from '../review';
import {
  CTX,
  ENABLED,
  Flapper,
  RESTART_ENABLED,
  SKIP_REASON,
  TOKEN,
  URL_,
  drain,
  expectConverged,
  makeWorld,
  namesOf,
  newDevice,
  outboxBody,
  restartApi,
  squareWave,
  sync,
  waitForHealth,
  type Client,
} from './harness';

type Row = Record<string, unknown>;

const get = (c: Client, kind: Parameters<Client['store']['get']>[0], id: string) => c.store.get<Row>(kind, id);

describe.skipIf(!ENABLED)(`twin clients against ${URL_ || 'the Docker server'} (${SKIP_REASON})`, () => {
  beforeAll(async () => {
    await waitForHealth();
  }, 70_000);

  // ------------------------------------------------------------------ TP-1

  describe('TP-1: two iPads edit the same floor offline, then sync (B first, then A)', () => {
    it('same field → review with the first arrival official; different fields, photos and field additions merge', async () => {
      const { a, b, w } = await makeWorld();
      const { L06M } = w.levels;
      // Both cache 06M: two devices and one punch item exist before anyone goes offline.
      const d2 = await newDevice(a, L06M, '06M-02');
      const d3 = await newDevice(a, L06M, '06M-03');
      const { id: p0 } = await a.editor.create('punch_item', { level_id: L06M, device_id: d2, item: 'Run X', type: 'Cable not run' }, CTX);
      await sync(a, b);
      expect((await get(b, 'punch_item', p0))!.number).toBe(1);

      // Airplane mode on both.
      await a.editor.setField('device', d2, 'status', 'Issue', CTX);
      const annNotes = (await a.editor.setField('device', d2, 'notes', 'LVD card missing', CTX))!;
      const bobNotes = (await b.editor.setField('device', d2, 'notes', 'Cover plate loose', CTX))!;
      await b.editor.setField('device', d3, 'status', 'Issue', CTX);
      const { id: photoA } = await a.editor.create('photo', { level_id: L06M, device_id: d2, subject: 'Ann: relay panel' }, CTX);
      const { id: photoB } = await b.editor.create('photo', { level_id: L06M, device_id: d2, subject: 'Bob: relay panel' }, CTX);
      // A field addition each: both pickers propose the same next free number offline (D88).
      const idA = await deviceIdFor(a.store, { projectId: w.projectId, levelId: L06M, category: 'Touchscreen' });
      const idB = await deviceIdFor(b.store, { projectId: w.projectId, levelId: L06M, category: 'Touchscreen' });
      expect([idA.display_id, idB.display_id]).toEqual(['06M-04', '06M-04']);
      const addA = await newDevice(a, L06M, idA.display_id, { category: 'Touchscreen', origin: 'field_addition' });
      const addB = await newDevice(b, L06M, idB.display_id, { category: 'Touchscreen', origin: 'field_addition' });
      const { id: pA } = await a.editor.create('punch_item', { level_id: L06M, device_id: addA, item: 'Run N', type: 'Cable not run' }, CTX);
      const { id: pB } = await b.editor.create('punch_item', { level_id: L06M, device_id: addB, item: 'Run N', type: 'Cable not run' }, CTX);
      expect(displayNumber('punch_item', (await get(a, 'punch_item', pA))!)).toBe('NEW');

      // Reconnect B first, then A, then B again to receive A's ops.
      await sync(b, a, b);

      // 06M-03 merged silently (only Bob touched it); 06M-02 status applied (different field).
      for (const c of [a, b]) {
        expect((await get(c, 'device', d3))!.status).toBe('Issue');
        expect((await get(c, 'device', d2))).toMatchObject({ status: 'Issue', notes: 'Cover plate loose' });
      }
      // 06M-02 Notes: Bob's value is official (first arrived, D37); Ann's op is in review on both.
      expect(await a.store.getOp(annNotes.op_id)).toMatchObject({ state: 'review' });
      expect(await b.store.getOp(annNotes.op_id)).toMatchObject({ state: 'review' });
      expect(await a.store.getOp(bobNotes.op_id)).toMatchObject({ state: 'applied' });
      for (const c of [a, b]) {
        const items = await c.store.list<Row>('review_item');
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'sync_conflict', state: 'open', op_a_id: bobNotes.op_id, op_b_id: annNotes.op_id });
        expect(items[0]!.subject).toMatchObject({ entity_kind: 'device', entity_id: d2, field: 'notes' });
        const cands = items[0]!.candidates as { side: string; value: unknown }[];
        expect(cands.map((x) => [x.side, x.value])).toEqual([['A', 'Cover plate loose'], ['B', 'LVD card missing']]);
      }
      expect(await a.engine.willBeReviewed(w.projectId)).toEqual([]);

      // Photos merge with distinct numbers, Bob's first.
      expect((await get(a, 'photo', photoB))!.number).toBe(1);
      expect((await get(a, 'photo', photoA))!.number).toBe(2);
      // Both field additions exist on both iPads with distinct punch numbers…
      expect([(await get(b, 'punch_item', pB))!.number, (await get(b, 'punch_item', pA))!.number]).toEqual([2, 3]);
      expect(await get(a, 'device', addB)).toMatchObject({ display_id: '06M-04', origin: 'field_addition' });
      expect(await get(b, 'device', addA)).toMatchObject({ display_id: '06M-04', origin: 'field_addition' });
      // …and the colliding display ID is reported, not refused (D88): next free is now 5.
      const after = await deviceIdFor(a.store, { projectId: w.projectId, levelId: L06M, category: 'Touchscreen', number: 4 });
      expect(after.taken_by.sort()).toEqual([addA, addB].sort());
      expect(after.next_free).toBe(5);

      await expectConverged(a, b, w.projectId);

      // T15: Bob combines the two notes; Ann's op is rejected on both iPads and the server.
      const itemId = (await openReviewItems(b.store, w.projectId))[0]!.id;
      expect(await reviewFields(a.store, d2)).toEqual({ notes: [itemId] });
      const r = await b.editor.resolve(itemId, { choice: 'combine' }, { userName: namesOf(a, b) });
      expect(r.reconcile[0]).toMatchObject({ field: 'notes', now: 'Cover plate loose; LVD card missing', change_type: 'Reconcile' });
      expect(r.reason).toMatch(/^Review: combined A \(Bob .*\) and B \(Ann .*\)$/);
      await sync(b, a);
      for (const c of [a, b]) {
        expect((await get(c, 'device', d2))!.notes).toBe('Cover plate loose; LVD card missing');
        expect(await c.store.getOp(annNotes.op_id)).toMatchObject({ state: 'rejected' });
        expect(await openReviewItems(c.store, w.projectId)).toEqual([]);
        expect(await reviewFields(c.store, d2)).toEqual({});
      }
      const server = await expectConverged(a, b, w.projectId);
      expect(server.find((o) => o.op_id === annNotes.op_id)!.state).toBe('rejected');
      expect(server.filter((o) => o.change_type === 'Reconcile').every((o) => o.state === 'applied')).toBe(true);
    }, 60_000);
  });

  // ------------------------------------------------------------------ TP-7

  describe('TP-7: sync resilience', () => {
    it('network flaps and lost responses during a 1,200-op push converge with no duplicate ops and no gaps', async () => {
      const flapA = new Flapper({ down: squareWave(300, 0.4), loseResponseEvery: 4 });
      const flapB = new Flapper({ down: squareWave(250, 0.3), loseResponseEvery: 5 });
      flapA.active = false;
      flapB.active = false;
      const { a, b, w } = await makeWorld({ flapper: flapA, engine: { batchSize: 100 } }, { flapper: flapB, engine: { batchSize: 100 } });
      const { L06M, L07 } = w.levels;
      const devsA: string[] = [];
      for (let i = 0; i < 10; i++) devsA.push(await newDevice(a, L06M, `06M-${String(i + 1).padStart(2, '0')}`));
      const devsB: string[] = [];
      for (let i = 0; i < 10; i++) devsB.push(await newDevice(b, L07, `07-${String(i + 1).padStart(2, '0')}`));
      for (let i = 0; i < 790; i++) await a.editor.setField('device', devsA[i % 10]!, 'notes', `a${i}`, CTX);
      for (let i = 0; i < 390; i++) await b.editor.setField('device', devsB[i % 10]!, 'notes', `b${i}`, CTX);
      for (let i = 0; i < 5; i++) await a.editor.create('punch_item', { level_id: L06M, device_id: devsA[i], item: `Run ${i}`, type: 'Cable not run' }, CTX);
      for (let i = 0; i < 5; i++) await b.editor.create('photo', { level_id: L07, device_id: devsB[i] }, CTX);
      expect((await a.store.outboxCount()) + (await b.store.outboxCount())).toBe(1210);

      flapA.active = true;
      flapB.active = true;
      const [triesA, triesB] = await Promise.all([drain(a, 120_000), drain(b, 120_000)]);
      flapA.active = false;
      flapB.active = false;
      await sync(a, b, a);

      expect(flapA.dropped + flapB.dropped, 'the flapper dropped requests').toBeGreaterThan(0);
      expect(flapA.lostResponses + flapB.lostResponses, 'the flapper lost responses').toBeGreaterThan(0);
      expect(triesA + triesB).toBeGreaterThan(2);

      const server = await expectConverged(a, b, w.projectId);
      const clientOps = server.filter((o) => o.install_id === a.installId || o.install_id === b.installId);
      expect(clientOps).toHaveLength(3 + 1210); // levels + everything above, each exactly once
      expect(server.filter((o) => o.kind === 'assign')).toHaveLength(10);
      expect(server.every((o) => o.state === 'applied')).toBe(true); // disjoint records: nothing in review
      for (let i = 0; i < 10; i++) {
        expect((await get(b, 'device', devsA[i]!))!.notes).toBe(`a${780 + i}`);
        expect((await get(a, 'device', devsB[i]!))!.notes).toBe(`b${380 + i}`);
      }
      expect((await a.store.list<Row>('photo')).map((p) => p.number).sort()).toEqual([1, 2, 3, 4, 5]);
    }, 240_000);

    it.skipIf(!RESTART_ENABLED)('a server restart mid-push: the client converges after the server is back, nothing applied twice', async () => {
      const restart: { done: Promise<void> | null } = { done: null };
      const flap = new Flapper({
        onPost: (n) => {
          // The second batch goes out while the API is being restarted.
          if (n === 2) restart.done = restartApi();
        },
      });
      flap.active = false;
      const { a, b, w } = await makeWorld({ flapper: flap });
      const { L06M } = w.levels;
      const devs: string[] = [];
      for (let i = 0; i < 4; i++) devs.push(await newDevice(a, L06M, `06M-${String(i + 1).padStart(2, '0')}`));
      for (let i = 0; i < 990; i++) await a.editor.setField('device', devs[i % 4]!, 'notes', `n${i}`, CTX);
      for (let i = 0; i < 6; i++) await a.editor.create('missing_part', { level_id: L06M, device_id: devs[i % 4], part: `Part ${i}` }, CTX);
      expect(await a.store.outboxCount()).toBe(1000);

      flap.active = true;
      const tries = await drain(a, 180_000);
      flap.active = false;
      expect(restart.done, 'the restart was triggered').not.toBeNull();
      await restart.done;
      await waitForHealth();
      await sync(a, b, a);
      expect(tries).toBeGreaterThan(1);

      const server = await expectConverged(a, b, w.projectId);
      expect(server.filter((o) => o.install_id === a.installId)).toHaveLength(3 + 1000);
      expect(server.filter((o) => o.kind === 'assign').map((o) => o.now).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      // The last of 990 round-robin sets on device i is index 989 - ((989 - i) % 4).
      for (let i = 0; i < 4; i++) expect((await get(b, 'device', devs[i]!))!.notes).toBe(`n${989 - ((989 - i) % 4)}`);
    }, 300_000);

    it('a duplicate push answers duplicate with the same seq and server ops; numbers never change', async () => {
      const { a, b, w } = await makeWorld();
      const { L06M } = w.levels;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await a.editor.create('photo', { level_id: L06M, subject: `p${i}` }, CTX)).id);
      for (let i = 0; i < 2; i++) ids.push((await a.editor.create('punch_item', { level_id: L06M, item: `Run ${i}`, type: 'Cable not run' }, CTX)).id);
      const body = await outboxBody(a, w.projectId);
      expect(body.ops).toHaveLength(5);

      const raw = new HttpTransport({ serverUrl: URL_, token: TOKEN, userName: 'Ann' });
      const first = await raw.push(body);
      const second = await raw.push(body);
      expect(first.results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
      expect(second.results.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect(second.results.map((r) => r.server_seq)).toEqual(first.results.map((r) => r.server_seq));
      expect(second.server_seq).toBe(first.server_seq);
      const assigns = (ops: Op[]) => ops.filter((o) => o.kind === 'assign').map((o) => [o.op_id, o.entity_id, o.now]).sort();
      expect(assigns(second.server_ops)).toEqual(assigns(first.server_ops));
      expect(assigns(first.server_ops)).toHaveLength(5);

      // The engine now pushes the very same ops a third time and settles them through the echo.
      await sync(a, b);
      expect(await a.store.outboxCount()).toBe(0);
      expect((await a.store.list<Row>('photo')).map((p) => p.number).sort()).toEqual([1, 2, 3]);
      expect((await b.store.list<Row>('punch_item')).map((p) => p.number).sort()).toEqual([1, 2]);
      const server = await expectConverged(a, b, w.projectId);
      expect(server).toHaveLength(3 + 5 + 5);
    }, 60_000);
  });

  // ----------------------------------------------------------------- TP-10

  describe('TP-10 against the real server: numbers are never reused across two clients', () => {
    it.each(Object.keys(NUMBERED) as NumberedKind[])('%s: create, delete, create again', async (kind) => {
      const { a, b, w } = await makeWorld();
      const { L06, L06M, L07 } = w.levels;
      const field = NUMBERED[kind]!;
      const fmt = (n: number) => (kind === 'cable_end' ? `C-${String(n).padStart(2, '0')}` : n);
      const num = async (c: Client, id: string) => (await get(c, kind, id))![field];
      const payload = async (c: Client, level_id: string): Promise<Row> => {
        switch (kind) {
          case 'punch_item':
            return { level_id, item: 'Run X', type: 'Cable not run' };
          case 'missing_part':
            return { level_id, part: 'LVD card' };
          case 'photo':
            return { level_id };
          case 'cable_end': {
            // A real cable row for the end to hang off (the server keeps FKs, D76).
            const { id: cable_id } = await c.editor.create('cable', { project_id: w.projectId, cable: 'X' }, CTX);
            return { level_id, cable_id, side: 'A' };
          }
        }
      };

      // Offline on both iPads: Ann on 06, Bob on 06M (one numbering group, D33) and on 07.
      const { id: a1 } = await a.editor.create(kind, await payload(a, L06), CTX);
      const { id: b1 } = await b.editor.create(kind, await payload(b, L06M), CTX);
      const { id: b07 } = await b.editor.create(kind, await payload(b, L07), CTX);
      expect([await num(a, a1), await num(b, b1), await num(b, b07)]).toEqual([null, null, null]);
      await sync(a, b, a);
      expect([await num(a, a1), await num(a, b1), await num(a, b07)]).toEqual([fmt(1), fmt(2), fmt(1)]);

      // Bob deletes his record; Ann's next one does not take its number.
      await b.editor.delete(kind, b1, CTX);
      await sync(b, a);
      const { id: a2 } = await a.editor.create(kind, await payload(a, L06), CTX);
      expect(displayNumber(kind, (await get(a, kind, a2))!)).toBe('NEW');
      await sync(a, b);
      expect(await num(b, a2)).toBe(fmt(3));

      // Restoring keeps the old number; nothing is renumbered.
      await b.editor.restore(kind, b1, CTX);
      const { id: b2 } = await b.editor.create(kind, await payload(b, L06M), CTX);
      await sync(b, a, b);
      expect([await num(a, b1), await num(a, b2)]).toEqual([fmt(2), fmt(4)]);

      for (const c of [a, b]) {
        const rows = await c.store.list<Row>(kind, { includeDeleted: true });
        const inGroup = (levels: string[]) => rows.filter((r) => levels.includes(r.level_id as string)).map((r) => String(r[field])).sort();
        expect(inGroup([L06, L06M])).toEqual([fmt(1), fmt(2), fmt(3), fmt(4)].map(String).sort());
        expect(inGroup([L07])).toEqual([String(fmt(1))]);
      }
      const server = await expectConverged(a, b, w.projectId);
      const assigns = server.filter((o) => o.kind === 'assign');
      expect(assigns).toHaveLength(5);
      expect(new Set(assigns.map((o) => o.entity_id)).size).toBe(5);
    }, 60_000);
  });

  // ----------------------------------------------------------------- TP-11

  describe('TP-11: delete vs edit, restore keeps history', () => {
    async function deviceWithPunch(a: Client, b: Client, L06M: string) {
      const d = await newDevice(a, L06M, '06M-02', { notes: 'as found' });
      const p1 = (await a.editor.create('punch_item', { level_id: L06M, device_id: d, item: 'Run X', type: 'Cable not run' }, CTX)).id;
      const p2 = (await a.editor.create('punch_item', { level_id: L06M, device_id: d, item: 'Terminate X', type: 'Termination' }, CTX)).id;
      await sync(a, b);
      expect([(await get(b, 'punch_item', p1))!.number, (await get(b, 'punch_item', p2))!.number]).toEqual([1, 2]);
      return { d, p1, p2 };
    }

    it("A deletes while B edits; B's edit arrives first → the delete goes to review (PLAN §3.2 step 4)", async () => {
      const { a, b, w } = await makeWorld();
      const { d, p1, p2 } = await deviceWithPunch(a, b, w.levels.L06M);
      const del = await a.editor.delete('device', d, { ...CTX, reason: 'Duplicate of 06M-01' });
      const edit = (await b.editor.setField('device', d, 'notes', 'Neuron ID read', CTX))!;
      await sync(b, a, b);

      // Official: not deleted, with Bob's note (server and Bob). Ann keeps her own value while in review.
      expect(await get(b, 'device', d)).toMatchObject({ deleted_at: null, notes: 'Neuron ID read' });
      expect((await get(a, 'device', d))!.deleted_at).not.toBeNull();
      expect((await get(a, 'device', d))!.notes).toBe('Neuron ID read'); // Bob's applied edit still lands
      expect(await a.store.getOp(del.op_id)).toMatchObject({ state: 'review' });
      expect(await b.store.getOp(del.op_id)).toMatchObject({ state: 'review' });
      for (const c of [a, b]) {
        const items = await c.store.list<Row>('review_item');
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'sync_conflict', state: 'open', op_a_id: edit.op_id, op_b_id: del.op_id });
        expect(items[0]!.subject).toMatchObject({ entity_kind: 'device', entity_id: d, field: 'deleted_at' });
        // Punch items untouched, numbers kept.
        expect((await get(c, 'punch_item', p1))).toMatchObject({ device_id: d, number: 1, deleted_at: null });
        expect((await get(c, 'punch_item', p2))).toMatchObject({ device_id: d, number: 2, deleted_at: null });
      }

      // T15: Bob keeps the device (choose A); the Reconcile restore reaches Ann's iPad.
      const itemId = (await openReviewItems(b.store, w.projectId))[0]!.id;
      expect(await reviewFields(a.store, d)).toEqual({ deleted_at: [itemId], notes: [itemId] });
      const r = await b.editor.resolve(itemId, { choice: 'A' });
      expect(r.reconcile.map((o) => o.kind)).toEqual(['restore']);
      await sync(b, a);
      for (const c of [a, b]) {
        expect(await get(c, 'device', d)).toMatchObject({ deleted_at: null, notes: 'Neuron ID read' });
        expect(await c.store.getOp(del.op_id)).toMatchObject({ state: 'rejected' });
      }
      await expectConverged(a, b, w.projectId);
    }, 60_000);

    it("A's delete arrives first; B's edit goes to review; A's restore brings the device back with its history", async () => {
      const { a, b, w } = await makeWorld();
      const { d, p1, p2 } = await deviceWithPunch(a, b, w.levels.L06M);
      const del = await a.editor.delete('device', d, { ...CTX, reason: 'Duplicate of 06M-01' });
      const edit = (await b.editor.setField('device', d, 'notes', 'Neuron ID read', CTX))!;
      await sync(a, b, a);

      // Official: deleted with the old note. Bob's row is deleted too (pulled) but still shows his in-review note.
      expect((await get(a, 'device', d))).toMatchObject({ notes: 'as found', delete_reason: 'Duplicate of 06M-01' });
      expect((await get(a, 'device', d))!.deleted_at).not.toBeNull();
      expect((await get(b, 'device', d))!.deleted_at).not.toBeNull();
      expect((await get(b, 'device', d))!.notes).toBe('Neuron ID read');
      expect(await b.store.getOp(edit.op_id)).toMatchObject({ state: 'review' });
      for (const c of [a, b]) {
        const items = await c.store.list<Row>('review_item');
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ op_a_id: del.op_id, op_b_id: edit.op_id });
        expect(items[0]!.subject).toMatchObject({ entity_id: d, field: 'notes' });
      }

      // T15: Bob accepts it stays deleted (choose A): his in-review note goes back to the official
      // one. The Reconcile set lands on a record Ann deleted (D91: not reviewed again).
      const itemId = (await openReviewItems(b.store, w.projectId))[0]!.id;
      const r = await b.editor.resolve(itemId, { choice: 'A' });
      expect(r.reconcile.map((o) => [o.kind, o.field, o.now])).toEqual([['set', 'notes', 'as found']]);
      await sync(b, a);
      expect((await get(b, 'device', d))!.notes).toBe('as found');
      await expectConverged(a, b, w.projectId);

      // Restore: back on both iPads, punch items still attached, the op log tells the whole story.
      const back = await a.editor.restore('device', d, { ...CTX, change_type: 'Correction', reason: 'Not a duplicate after all' });
      await sync(a, b, a);
      for (const c of [a, b]) {
        expect(await get(c, 'device', d)).toMatchObject({ deleted_at: null, deleted_by_id: null, delete_reason: null, display_id: '06M-02' });
        expect((await get(c, 'punch_item', p1))).toMatchObject({ device_id: d, number: 1 });
        expect((await get(c, 'punch_item', p2))).toMatchObject({ device_id: d, number: 2 });
        const history = (await c.store.opsFor(d)).map((o) => [o.kind, o.state, o.server_seq]);
        expect(history).toEqual([
          ['create', 'applied', expect.any(Number)],
          ['delete', 'applied', (await a.store.getOp(del.op_id))!.server_seq],
          ['set', 'rejected', (await a.store.getOp(edit.op_id))!.server_seq],
          ['set', 'applied', (await a.store.getOp(r.reconcile[0]!.op_id))!.server_seq],
          ['restore', 'applied', (await a.store.getOp(back.op_id))!.server_seq],
        ]);
      }
      expect(await a.store.fieldHead(d, 'deleted_at')).toBe(back.op_id);
      // The ID stays with the device (D88): nothing else may take 06M-02.
      const idp = await deviceIdFor(b.store, { projectId: w.projectId, levelId: w.levels.L06M, category: 'Relay panel', number: 2 });
      expect(idp.taken_by).toEqual([d]);
      await expectConverged(a, b, w.projectId);
      expect((await get(b, 'device', d))!.notes).toBe('as found');
    }, 60_000);

    it('T15: delete first, B restores the device with the edit; a field group resolved as one', async () => {
      const { a, b, w } = await makeWorld();
      const { d } = await deviceWithPunch(a, b, w.levels.L06M);
      await a.editor.delete('device', d, { ...CTX, reason: 'Duplicate of 06M-01' });
      const edit = (await b.editor.setField('device', d, 'notes', 'Neuron ID read', CTX))!;
      await sync(a, b, a);
      const [item] = await openReviewItems(b.store, w.projectId);
      const r = await b.editor.resolve(item!.id, { choice: 'B' });
      expect(r.reconcile.map((o) => [o.kind, o.field])).toEqual([['restore', null], ['set', 'notes']]);
      await sync(b, a);
      for (const c of [a, b]) {
        expect(await get(c, 'device', d)).toMatchObject({ deleted_at: null, notes: 'Neuron ID read' });
        expect(await c.store.getOp(edit.op_id)).toMatchObject({ state: 'superseded' });
      }
      await expectConverged(a, b, w.projectId);

      // Field group: Bob moves the punch item on; Ann closes it offline (status + date as one group).
      const { id: p } = await a.editor.create('punch_item', { level_id: w.levels.L06M, device_id: d, item: 'Run N', type: 'Cable not run', tracking_status: 'Open' }, CTX);
      await sync(a, b);
      await b.editor.setField('punch_item', p, 'tracking_status', 'In progress', CTX);
      const closed = await a.editor.setFields('punch_item', p, { tracking_status: 'Closed', date_closed: '2026-10-10' }, CTX);
      await sync(b, a, b);
      const groupItem = (await openReviewItems(a.store, w.projectId)).find((i) => i.subject.entity_id === p)!;
      expect(groupItem.subject.fields).toEqual(['tracking_status', 'date_closed']);
      expect(await reviewFields(b.store, p)).toEqual({ tracking_status: [groupItem.id], date_closed: [groupItem.id] });
      // Ann's iPad still shows her date while in review; choosing A clears it everywhere.
      expect((await get(a, 'punch_item', p))!.date_closed).toBe('2026-10-10');
      const ra = await b.editor.resolve(groupItem.id, { choice: 'A' });
      expect(ra.reconcile.map((o) => [o.field, o.now])).toEqual([['tracking_status', 'In progress'], ['date_closed', null]]);
      await sync(b, a);
      for (const c of [a, b]) {
        expect(await get(c, 'punch_item', p)).toMatchObject({ tracking_status: 'In progress', date_closed: null });
        for (const o of closed) expect(await c.store.getOp(o.op_id)).toMatchObject({ state: 'rejected' });
      }
      await expectConverged(a, b, w.projectId);
    }, 60_000);

    it('delete vs delete merges; a clean delete then restore converges everywhere', async () => {
      const { a, b, w } = await makeWorld();
      const { d } = await deviceWithPunch(a, b, w.levels.L06M);
      await a.editor.delete('device', d, { ...CTX, reason: 'gone' });
      await b.editor.delete('device', d, { ...CTX, reason: 'gone too' });
      await sync(a, b, a);
      expect(await a.store.list('review_item')).toEqual([]);
      for (const c of [a, b]) expect((await get(c, 'device', d))!.deleted_at).not.toBeNull();
      await b.editor.restore('device', d, CTX);
      await sync(b, a);
      for (const c of [a, b]) expect((await get(c, 'device', d))!.deleted_at).toBeNull();
      const server = await expectConverged(a, b, w.projectId);
      expect(server.filter((o) => o.entity_id === d).map((o) => [o.kind, o.state])).toEqual([
        ['create', 'applied'], ['delete', 'applied'], ['delete', 'applied'], ['restore', 'applied'],
      ]);
    }, 60_000);
  });
});
