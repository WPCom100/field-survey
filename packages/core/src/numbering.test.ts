import { beforeEach, describe, expect, it } from 'vitest';
import { Editor, type EditContext } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import { displayNumber, isNew, NUMBERED, unnumbered, type NumberedKind } from './numbering';
import { Store } from './store';
import { SyncEngine } from './sync';
import { FakeServer } from './testing/fake-server';

const PROJECT = uuidv7();
const ANN = uuidv7();
const BOB = uuidv7();
const G0606M = uuidv7();
const G07 = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

interface Client {
  store: Store;
  editor: Editor;
  engine: SyncEngine;
}

async function client(server: FakeServer, user: string, install: string): Promise<Client> {
  const store = await Store.open(new BetterSqliteDriver(), { installId: install, search: 'like' });
  await store.applyRemote({
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: tsNext(),
    entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
    change_type: 'Master edit', server_seq: 0, server_ts: tsNext(), state: 'applied',
  } as Op);
  const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
  const engine = new SyncEngine(store, server, { now: () => clock, log: () => {} });
  return { store, editor, engine };
}

const PAYLOAD: Record<NumberedKind, (level: string) => Record<string, unknown>> = {
  punch_item: (level_id) => ({ level_id, item: 'Run X', type: 'Cable not run' }),
  missing_part: (level_id) => ({ level_id, part: 'LVD card' }),
  photo: (level_id) => ({ level_id }),
  cable_end: (level_id) => ({ level_id, cable_id: uuidv7(), side: 'A' }),
};

let server: FakeServer;
let a: Client;
let b: Client;
let L06: string;
let L06M: string;
let L07: string;

beforeEach(async () => {
  server = new FakeServer();
  a = await client(server, ANN, 'ipad-ann');
  b = await client(server, BOB, 'ipad-bob');
  const level = async (code: string, group: string) =>
    (await a.editor.create('level', { project_id: PROJECT, level: code, numbering_group_id: group }, CTX)).id;
  L06 = await level('06', G0606M);
  L06M = await level('06M', G0606M);
  L07 = await level('07', G07);
  await a.engine.sync();
  await b.engine.sync();
});

async function sync(...clients: Client[]): Promise<void> {
  for (const c of clients) await c.engine.sync();
}

describe('NEW state', () => {
  it('a record has no number and shows NEW until the assign op arrives', async () => {
    const { id } = await a.editor.create('punch_item', PAYLOAD.punch_item(L06), CTX);
    const row = (await a.store.get<Record<string, unknown>>('punch_item', id))!;
    expect(row.number).toBeNull();
    expect(isNew('punch_item', row)).toBe(true);
    expect(displayNumber('punch_item', row)).toBe('NEW');
    expect(await unnumbered(a.store, PROJECT)).toMatchObject([
      { entity_kind: 'punch_item', id, level_id: L06, reason: 'waiting', attempts: 0 },
    ]);

    await sync(a);
    const after = (await a.store.get<Record<string, unknown>>('punch_item', id))!;
    expect(isNew('punch_item', after)).toBe(false);
    expect(displayNumber('punch_item', after)).toBe('1');
    expect(await unnumbered(a.store, PROJECT)).toEqual([]);
  });

  it('formats cable ends as C-nn once numbered', async () => {
    const { id } = await a.editor.create('cable_end', PAYLOAD.cable_end(L06), CTX);
    await sync(a);
    expect(displayNumber('cable_end', (await a.store.get('cable_end', id))!)).toBe('C-01');
  });

  it('the client can never write a number itself', async () => {
    await expect(a.editor.create('punch_item', { ...PAYLOAD.punch_item(L06), number: 7 }, CTX)).rejects.toThrow(
      /assigned by the server/,
    );
    const { id } = await a.editor.create('photo', PAYLOAD.photo(L06), CTX);
    await expect(a.editor.setField('photo', id, 'number', 3, CTX)).rejects.toThrow(/assigned by the server/);
  });

  it('reports a refused create (409) and a create the server could not number', async () => {
    const { id: refused } = await a.editor.create('punch_item', PAYLOAD.punch_item(L06), CTX);
    server.fail({ on: 'push', failure: 'rejected', status: 409 });
    await sync(a);
    const { id: orphan } = await b.editor.create('cable_end', { cable_id: uuidv7(), side: 'A' }, CTX); // no level
    const { id: offline } = await b.editor.create('photo', PAYLOAD.photo(L07), CTX);
    await b.store.noteOutboxFailure(
      (await b.store.outbox()).filter((o) => o.entity_id === offline).map((o) => o.op_id),
      'Network request failed',
    );
    await b.engine.sync(); // pushes both; photo gets a number, the cable end does not

    expect(await unnumbered(a.store, PROJECT)).toMatchObject([
      { id: refused, reason: 'refused', attempts: 1, last_error: expect.stringMatching(/409/) },
    ]);
    expect(await unnumbered(b.store, PROJECT)).toMatchObject([{ id: orphan, reason: 'unnumbered', attempts: 0 }]);
    expect((await b.store.get('photo', offline))!.number).toBe(1);

    // Deleted records are not reported.
    await b.editor.delete('cable_end', orphan, CTX);
    expect(await unnumbered(b.store, PROJECT)).toEqual([]);
  });

  it('a network failure leaves the record waiting, not refused', async () => {
    const { id } = await a.editor.create('punch_item', PAYLOAD.punch_item(L06), CTX);
    server.fail({ on: 'push', failure: 'network' });
    await sync(a);
    expect(await unnumbered(a.store, PROJECT)).toMatchObject([{ id, reason: 'waiting', attempts: 1 }]);
  });
});

describe('TP-10: numbers are never reused across two clients', () => {
  it.each(Object.keys(NUMBERED) as NumberedKind[])('%s: create, delete, create again', async (kind) => {
    const field = NUMBERED[kind]!;
    const fmt = (n: number) => (kind === 'cable_end' ? `C-${String(n).padStart(2, '0')}` : n);
    const num = async (c: Client, id: string) => (await c.store.get<Record<string, unknown>>(kind, id))![field];

    // Offline on both iPads: Ann on 06, Bob on 06M (one numbering group, D33), Bob on 07.
    const { id: a1 } = await a.editor.create(kind, PAYLOAD[kind](L06), CTX);
    const { id: b1 } = await b.editor.create(kind, PAYLOAD[kind](L06M), CTX);
    const { id: b07 } = await b.editor.create(kind, PAYLOAD[kind](L07), CTX);
    expect([await num(a, a1), await num(b, b1), await num(b, b07)]).toEqual([null, null, null]);

    await sync(a, b, a);
    expect([await num(a, a1), await num(a, b1), await num(a, b07)]).toEqual([fmt(1), fmt(2), fmt(1)]);

    // Bob deletes his record; Ann's next one does not take its number.
    await b.editor.delete(kind, b1, CTX);
    await sync(b, a);
    const { id: a2 } = await a.editor.create(kind, PAYLOAD[kind](L06), CTX);
    expect(displayNumber(kind, (await a.store.get(kind, a2))!)).toBe('NEW');
    await sync(a, b);
    expect(await num(b, a2)).toBe(fmt(3));

    // Restoring keeps the old number; nothing is renumbered.
    await b.editor.restore(kind, b1, CTX);
    const { id: b2 } = await b.editor.create(kind, PAYLOAD[kind](L06M), CTX);
    await sync(b, a, b);
    expect([await num(a, b1), await num(a, b2)]).toEqual([fmt(2), fmt(4)]);

    // Both stores agree, and every number was assigned exactly once.
    for (const c of [a, b]) {
      const rows = await c.store.list<Record<string, unknown>>(kind, { includeDeleted: true });
      const inGroup = (levels: string[]) =>
        rows.filter((r) => levels.includes(r.level_id as string)).map((r) => String(r[field])).sort();
      expect(inGroup([L06, L06M])).toEqual([fmt(1), fmt(2), fmt(3), fmt(4)].map(String).sort());
      expect(inGroup([L07])).toEqual([String(fmt(1))]);
    }
    const assigns = server.ops(PROJECT).filter((o) => o.kind === 'assign');
    expect(assigns).toHaveLength(5);
    expect(new Set(assigns.map((o) => o.entity_id)).size).toBe(5);
  });
});
