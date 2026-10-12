import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, type EditContext } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import { Store } from './store';
import { SyncEngine, TransportError, knownProjects, rememberProjects, type SyncStatus } from './sync';
import { FakeServer } from './testing/fake-server';

const PROJECT = uuidv7();
const LEVEL = uuidv7();
const ANN = uuidv7();
const BOB = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

let clock = 1_760_000_000_000;
const now = () => clock;
const tsNext = () => new Date((clock += 1000)).toISOString();

interface Client {
  store: Store;
  editor: Editor;
  engine: SyncEngine;
}

async function client(server: FakeServer | null, user: string, install: string, extra = {}): Promise<Client> {
  const store = await Store.open(new BetterSqliteDriver(), { installId: install, search: 'like' });
  // The project row exists locally (T41 creates it server-side and it arrives by pull; here we seed it).
  await store.applyRemote({
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: tsNext(),
    entity_kind: 'project', entity_id: PROJECT, kind: 'create', payload: { name: 'Tower' },
    change_type: 'Master edit', server_seq: 0, server_ts: tsNext(), state: 'applied',
  } as Op);
  const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
  const engine = new SyncEngine(store, server, { now, log: () => {}, ...extra });
  return { store, editor, engine };
}

async function newDevice(c: Client, extra: Record<string, unknown> = {}): Promise<string> {
  const { id } = await c.editor.create(
    'device',
    { level_id: LEVEL, display_id: '06M-04', category: 'Relay panel', status: 'Installed, untested', ...extra },
    CTX,
  );
  return id;
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push', () => {
  it('drains the outbox in client_ts order, acknowledges results and clears the outbox', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const d = await newDevice(a);
    await a.editor.setField('device', d, 'status', 'Issue', CTX);
    const { id: p } = await a.editor.create('punch_item', { level_id: LEVEL, device_id: d, item: 'Run X' }, CTX);
    expect(await a.store.outboxCount()).toBe(3);

    const report = await a.engine.sync();
    expect(report).toMatchObject({ outcome: 'ran', pushed: 3, projects: [PROJECT] });
    expect(server.pushes).toHaveLength(1);
    expect(server.pushes[0]!.ops.map((o) => o.kind)).toEqual(['create', 'set', 'create']);
    expect(server.pushes[0]!.since).toBe(0); // first push: never pulled
    expect(server.pushes[0]!.ops[0]).not.toHaveProperty('state'); // local-only columns stripped

    expect(await a.store.outboxCount()).toBe(0);
    const ops = await a.store.opsFor(d);
    expect(ops.map((o) => [o.state, o.server_seq])).toEqual([['applied', 1], ['applied', 2]]);
    // The assign op came back in server_ops and was materialised: the punch item has its number.
    expect((await a.store.get('punch_item', p))!.number).toBe(1);
    // Pull after push: the echoes complete server_ts, the cursor is at the top.
    expect((await a.store.getOp(ops[0]!.op_id))!.server_ts).not.toBeNull();
    expect(a.engine.status()).toMatchObject({ state: 'idle', pendingOps: 0, lastServerSeq: { [PROJECT]: 4 }, failures: 0 });
    expect((await a.store.get('device', d))!.head_seq).toBe(2);
  });

  it('sends batches of at most batchSize and never splits a group across batches', async () => {
    const a = await client(server, ANN, 'ipad-a', { batchSize: 10 });
    const d = await newDevice(a);
    for (let i = 0; i < 7; i++) await a.editor.setField('device', d, 'notes', `n${i}`, CTX);
    // 8 ops so far; a 4-op group would straddle the boundary at 10.
    const group = await a.editor.group(CTX, async (g) => {
      await g.setField('device', d, 'status', 'Issue');
      await g.setField('device', d, 'room_location', 'ERP');
      await g.setField('device', d, 'drawing_position', 'C-9');
      await g.setField('device', d, 'panel_name', 'LP-6');
    });
    for (let i = 0; i < 5; i++) await a.editor.setField('device', d, 'notes', `m${i}`, CTX);
    expect(await a.store.outboxCount()).toBe(17);

    await a.engine.sync();
    const sizes = server.pushes.map((p) => p.ops.length);
    expect(sizes).toEqual([8, 9]); // the group moved whole into the second batch
    const gid = group[0]!.group_id;
    const inBatch = server.pushes.map((p) => p.ops.filter((o) => o.group_id === gid).length);
    expect(inBatch).toEqual([0, 4]);
    // client_ts order across the whole drain
    const sent = server.pushes.flatMap((p) => p.ops.map((o) => o.client_ts));
    expect(sent).toEqual([...sent].sort());
    expect(await a.store.outboxCount()).toBe(0);
  });

  it('respects the 500 cap by default', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const d = await newDevice(a);
    for (let i = 0; i < 520; i++) await a.editor.setField('device', d, 'notes', `n${i}`, CTX);
    await a.engine.sync();
    expect(server.pushes.map((p) => p.ops.length)).toEqual([500, 21]);
    expect(server.pushes[1]!.since).toBe(0); // still before any pull in this cycle
  });

  it('sends since = the pull cursor as of the push', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b');
    await newDevice(a);
    await a.engine.sync();
    await b.engine.sync(); // pulls 1 op
    const d2 = await newDevice(b);
    await b.engine.sync();
    expect(server.pushes[1]!.since).toBe(1);
    expect(server.pushes[1]!.ops[0]!.entity_id).toBe(d2);
  });

  it('re-pushes after a lost response and gets duplicates, never double numbers', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const { id: p } = await a.editor.create('punch_item', { level_id: LEVEL, item: 'Run X' }, CTX);
    server.fail({ on: 'push', failure: 'network', afterApply: true });
    const first = await a.engine.sync();
    expect(first.outcome).toBe('failed');
    expect(a.engine.status()).toMatchObject({ state: 'offline', failures: 1 });
    expect(await a.store.outboxCount()).toBe(1); // still ours to send
    const row = await a.store.db.query<{ attempts: number; last_error: string }>('SELECT attempts, last_error FROM outbox');
    expect(row[0]).toMatchObject({ attempts: 1 });
    expect(row[0]!.last_error).toMatch(/network/);

    clock += 10_000;
    const second = await a.engine.requestSync();
    expect(second.outcome).toBe('ran');
    expect(server.pushes).toHaveLength(2);
    expect(server.ops().filter((o) => o.kind === 'create')).toHaveLength(1); // applied once
    expect((await a.store.get('punch_item', p))!.number).toBe(1);
    const op = (await a.store.opsFor(p))[0]!;
    expect([op.state, op.server_seq]).toEqual(['applied', 1]); // duplicate → echo completed it
    expect(await a.store.outboxCount()).toBe(0);
  });
});

describe('pull', () => {
  it('pages through every op after the cursor and materialises other installs', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b', { pullLimit: 3 });
    const d = await newDevice(a);
    for (let i = 0; i < 6; i++) await a.editor.setField('device', d, 'notes', `n${i}`, CTX);
    await a.engine.sync();
    expect(server.serverSeq).toBe(7);
    server.pulls.length = 0;

    const report = await b.engine.sync();
    expect(report).toMatchObject({ outcome: 'ran', pushed: 0, pulled: 7 });
    expect(server.pulls.map((p) => p.since)).toEqual([0, 3, 6]);
    expect(await b.store.get('device', d)).toMatchObject({ notes: 'n5', version: 7, head_seq: 7 });
    expect(await b.store.fieldHead(d, 'notes')).toBe(server.head(d, 'notes')!.op_id);
    expect(await b.store.getState(`last_server_seq:${PROJECT}`)).toBe(7);
    expect(b.engine.status().lastServerSeq[PROJECT]).toBe(7);

    // Caught up: the next cycle pulls once and gets nothing.
    server.pulls.length = 0;
    await b.engine.sync();
    expect(server.pulls).toEqual([{ project: PROJECT, since: 7, limit: 3 }]);
  });

  it('never advances the cursor past ops it was not given: an empty page under a higher top is a gap (T74, D144)', async () => {
    const events: Record<string, unknown>[] = [];
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b', { log: (_l: string, e: string, d?: Record<string, unknown>) => events.push({ e, ...d }) });
    const d = await newDevice(a);
    await a.engine.sync();
    await b.engine.sync(); // Bob is caught up at seq 1 (create) + its assign
    const caughtUp = await b.store.getState<number>(`last_server_seq:${PROJECT}`);
    await a.editor.setField('device', d, 'notes', 'landed between the reads', CTX);
    await a.engine.sync();

    // A racy server: the page was read before Ann's push, the top after it.
    let racy = true;
    b.engine.setTransport({
      push: server.push.bind(server),
      pull: async (project, since, limit) => {
        const page = await server.pull(project, since, limit);
        if (racy) {
          racy = false;
          return { ops: [], server_seq: page.server_seq, has_more: false };
        }
        return page;
      },
    });
    expect((await b.engine.sync()).pulled).toBe(0);
    expect(await b.store.getState(`last_server_seq:${PROJECT}`)).toBe(caughtUp); // not moved
    expect(events).toContainEqual({ e: 'pull_gap', project: PROJECT, since: caughtUp, server_seq: server.serverSeq });
    expect((await b.store.get('device', d))!.notes).toBeNull();

    // The next cycle gets the ops the gap hid.
    expect((await b.engine.sync()).pulled).toBe(1);
    expect((await b.store.get('device', d))!.notes).toBe('landed between the reads');
    expect(await b.store.getState(`last_server_seq:${PROJECT}`)).toBe(server.serverSeq);
  });

  it('two iPads converge: edits on different fields merge both ways', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b');
    const d = await newDevice(a);
    await a.engine.sync();
    await b.engine.sync();
    await a.editor.setField('device', d, 'status', 'Issue', CTX);
    await b.editor.setField('device', d, 'notes', 'LVD missing', CTX);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const ra = await a.store.get('device', d);
    const rb = await b.store.get('device', d);
    expect(ra).toMatchObject({ status: 'Issue', notes: 'LVD missing' });
    expect(rb).toMatchObject({ status: 'Issue', notes: 'LVD missing' });
    expect(ra!.version).toBe(rb!.version);
    expect(await a.store.fieldHeads(d)).toEqual(await b.store.fieldHeads(d));
  });

  it('same field, different values: the first arrival stays official; the loser is in review on both', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b');
    const d = await newDevice(a);
    await a.engine.sync();
    await b.engine.sync();
    await a.editor.setField('device', d, 'status', 'Issue', CTX);
    const bobOp = await b.editor.setField('device', d, 'status', 'No access', CTX);
    await a.engine.sync(); // Ann first
    const report = await b.engine.sync();
    expect(report.outcome).toBe('ran');

    expect((await b.store.get('device', d))!.status).toBe('Issue'); // official value replaced Bob's
    const stored = await b.store.getOp(bobOp!.op_id);
    expect(stored).toMatchObject({ state: 'review' });
    expect(stored!.server_seq).not.toBeNull();
    expect(await b.store.outboxCount()).toBe(0);
    const itemsB = await b.store.list('review_item');
    expect(itemsB).toHaveLength(1);
    expect(itemsB[0]).toMatchObject({ kind: 'sync_conflict', state: 'open' });
    expect((itemsB[0]!.subject as { field: string }).field).toBe('status');
    await a.engine.sync();
    expect(await a.store.list('review_item')).toHaveLength(1);
    expect((await a.store.get('device', d))!.status).toBe('Issue');
    expect(await b.engine.willBeReviewed(PROJECT)).toEqual([]); // acknowledged: no longer "will be"
  });

  it('marks local pending ops that a pulled op collides with as "will be reviewed", then clears them', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b');
    const d = await newDevice(a);
    await a.engine.sync();
    await b.engine.sync();
    await a.editor.setField('device', d, 'status', 'Issue', CTX);
    await a.engine.sync();
    const pending = await b.editor.setField('device', d, 'status', 'No access', CTX);
    await b.editor.setField('device', d, 'notes', 'unrelated', CTX);

    // Bob's status edit is refused for good (409 naming no op): it is quarantined, the notes edit
    // still goes, and the pull still runs and finds the collision (T75).
    server.poisonOp(pending!.op_id, 409);
    const report = await b.engine.sync();
    expect(report.outcome).toBe('ran');
    expect(b.engine.status()).toMatchObject({ state: 'idle', willReview: 1, pendingOps: 1, quarantinedOps: 1 });
    const marks = await b.engine.willBeReviewed(PROJECT);
    expect(marks).toEqual([
      { op_id: pending!.op_id, entity_kind: 'device', entity_id: d, field: 'status', source: 'pull' },
    ]);
    expect((await b.store.get('device', d))!.status).toBe('Issue'); // Ann's value landed

    clock += 10_000;
    server.curePoison(pending!.op_id);
    await b.engine.retryQuarantined(PROJECT);
    expect(await b.engine.willBeReviewed(PROJECT)).toEqual([]);
    expect((await b.store.getOp(pending!.op_id))!.state).toBe('review');
    expect(b.engine.status()).toMatchObject({ state: 'idle', willReview: 0, pendingOps: 0 });
  });

  it('logs an orphan (op on a record this iPad never received) without failing', async () => {
    const events: string[] = [];
    const a = await client(server, ANN, 'ipad-a');
    const b = await client(server, BOB, 'ipad-b', { log: (_l: string, e: string) => events.push(e) });
    const ghost = uuidv7();
    await a.store.apply({
      op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'ipad-a', client_ts: tsNext(),
      entity_kind: 'device', entity_id: ghost, kind: 'create', payload: { level_id: LEVEL }, change_type: 'Field survey',
    });
    await a.engine.sync();
    // Make the create invisible to Bob by moving his cursor past it, then let a set on it arrive.
    await b.store.setState(`last_server_seq:${PROJECT}`, 1);
    await a.editor.setField('device', ghost, 'notes', 'x', CTX);
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report.outcome).toBe('ran');
    expect(events).toContain('orphan');
    expect(await b.store.get('device', ghost)).toBeNull();
  });
});

describe('quarantine (T75, D145)', () => {
  it('a 422 naming an op quarantines that op with its group; the rest of the outbox still goes', async () => {
    const events: Record<string, unknown>[] = [];
    const a = await client(server, ANN, 'ipad-a', { log: (_l: string, e: string, d?: Record<string, unknown>) => events.push({ e, ...d }) });
    const d1 = await newDevice(a);
    const bad = await a.editor.group(CTX, async (g) => {
      await g.setField('device', d1, 'status', 'Issue');
      await g.setField('device', d1, 'notes', 'grouped with the bad one');
    });
    const d2 = await newDevice(a);
    server.poisonOp(bad[0]!.op_id, 422);

    const report = await a.engine.sync();
    expect(report.outcome).toBe('ran'); // not a failed cycle: the other ops were applied
    expect(report.pushed).toBe(2);
    expect(server.ops(PROJECT).map((o) => o.entity_id)).toContain(d2);
    expect(await a.store.outboxCount()).toBe(2);
    expect(a.engine.status()).toMatchObject({ state: 'idle', pendingOps: 2, quarantinedOps: 2 });
    const q = await a.store.quarantined(PROJECT);
    expect(q.map((x) => x.op.op_id).sort()).toEqual(bad.map((o) => o.op_id).sort());
    expect(q[0]!.error).toMatch(/422/);
    expect(q[0]!.attempts).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ e: 'quarantined', status: 422 }));

    // Quarantined ops are not pushed again on their own…
    server.pushes.length = 0;
    await a.engine.sync();
    expect(server.pushes).toHaveLength(0);
    // …until Retry; the server still refusing puts them straight back.
    expect(await a.engine.retryQuarantined(PROJECT)).toBe(2);
    expect(a.engine.status().quarantinedOps).toBe(2);
    // Once the server accepts them, Retry drains the outbox.
    server.curePoison(bad[0]!.op_id);
    await a.engine.retryQuarantined(PROJECT);
    expect(a.engine.status()).toMatchObject({ pendingOps: 0, quarantinedOps: 0, state: 'idle' });
    expect((await a.store.getOp(bad[0]!.op_id))!.state).toBe('applied');
  });

  it('a 409 naming no op is narrowed by halving the batch until the one bad group stands alone', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await newDevice(a));
    const ops = await a.store.outbox(PROJECT);
    const culprit = ops[3]!;
    server.poisonOp(culprit.op_id, 409);

    const report = await a.engine.sync();
    expect(report.outcome).toBe('ran');
    expect(report.pushed).toBe(6);
    expect(server.pushes.length).toBeLessThanOrEqual(8); // ≤ 1 + 2·log2(7) attempts
    const q = await a.store.quarantined();
    expect(q.map((x) => x.op.op_id)).toEqual([culprit.op_id]);
    expect(q[0]!.error).toMatch(/409.*narrowed/);
    // Order was kept: the six accepted creates arrived in client_ts order.
    const applied = server.ops(PROJECT).filter((o) => o.kind === 'create' && o.entity_kind === 'device').map((o) => o.entity_id);
    expect(applied).toEqual(ids.filter((id) => id !== culprit.entity_id));
  });

  it('5xx and 401 still retry with backoff, nothing is quarantined', async () => {
    const a = await client(server, ANN, 'ipad-a');
    await newDevice(a);
    server.fail({ on: 'push', failure: 'server', status: 503 });
    expect((await a.engine.sync()).outcome).toBe('failed');
    expect(a.engine.status()).toMatchObject({ state: 'error', pendingOps: 1, quarantinedOps: 0 });
  });
});

describe('failures and backoff', () => {
  it('goes offline on a network error, backs off exponentially and recovers', async () => {
    const a = await client(server, ANN, 'ipad-a', { backoffMs: 5_000, maxBackoffMs: 20_000 });
    await newDevice(a);
    server.fail({ on: 'any', failure: 'network' }, { on: 'any', failure: 'network' }, { on: 'any', failure: 'network' });

    expect((await a.engine.sync()).outcome).toBe('failed');
    let s = a.engine.status();
    expect(s).toMatchObject({ state: 'offline', failures: 1, pendingOps: 1 });
    expect(s.nextAttemptAt).toBe(new Date(clock + 5_000).toISOString());

    expect((await a.engine.sync()).outcome).toBe('skipped'); // backoff not elapsed
    clock += 5_000;
    expect((await a.engine.sync()).outcome).toBe('failed');
    expect(a.engine.status().nextAttemptAt).toBe(new Date(clock + 10_000).toISOString());
    clock += 10_000;
    expect((await a.engine.sync()).outcome).toBe('failed');
    expect(a.engine.status().nextAttemptAt).toBe(new Date(clock + 20_000).toISOString()); // capped
    expect(a.engine.status().failures).toBe(3);

    clock += 20_000;
    expect((await a.engine.sync()).outcome).toBe('ran');
    s = a.engine.status();
    expect(s).toMatchObject({ state: 'idle', failures: 0, lastError: null, nextAttemptAt: null, pendingOps: 0 });
    expect(s.lastSyncAt).toBe(new Date(clock).toISOString());
    expect(server.pushes).toHaveLength(1);
  });

  it('a wrong token is an error state with the message, not a crash', async () => {
    const a = await client(server, ANN, 'ipad-a');
    await newDevice(a);
    server.fail({ on: 'push', failure: 'auth', status: 401 });
    expect((await a.engine.sync()).outcome).toBe('failed');
    expect(a.engine.status()).toMatchObject({ state: 'error', failures: 1 });
    expect(a.engine.status().lastError).toMatch(/401/);
    // Ops are untouched and the pull still ran.
    expect(await a.store.outboxCount()).toBe(1);
    expect(server.pulls).toHaveLength(1);
  });

  it('stops for the cycle on a network error instead of trying every project', async () => {
    const other = uuidv7();
    const a = await client(server, ANN, 'ipad-a', { projects: async () => [PROJECT, other] });
    await newDevice(a);
    server.fail({ on: 'push', failure: 'network' });
    await a.engine.sync();
    expect(server.pulls).toHaveLength(0);
    expect(server.pushes).toHaveLength(0);
  });

  it('coalesces concurrent sync calls into one cycle', async () => {
    const a = await client(server, ANN, 'ipad-a');
    await newDevice(a);
    const [r1, r2] = await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(r1).toBe(r2);
    expect(server.pushes).toHaveLength(1);
  });
});

describe('no token', () => {
  it('edits are never blocked; the engine reports no_token and keeps the outbox', async () => {
    const a = await client(null, ANN, 'ipad-a');
    expect(a.engine.status().state).toBe('no_token');
    const d = await newDevice(a);
    await a.editor.setField('device', d, 'status', 'Issue', CTX);
    const report = await a.engine.sync();
    expect(report).toMatchObject({ outcome: 'no_token', pushed: 0, pulled: 0 });
    expect(a.engine.status()).toMatchObject({ state: 'no_token', pendingOps: 2 });

    // Connecting later drains everything.
    a.engine.setTransport(server);
    expect(a.engine.status().state).toBe('idle');
    expect((await a.engine.sync()).outcome).toBe('ran');
    expect(await a.store.outboxCount()).toBe(0);
    expect(server.ops()).toHaveLength(2);
  });
});

describe('reachability with no project yet (iPad round 2026-10-11, T25-3)', () => {
  it('a cycle with nothing to sync still asks the server, so airplane mode reads offline', async () => {
    let up = false;
    const transport = {
      push: server.push.bind(server),
      pull: server.pull.bind(server),
      ping: async () => {
        if (!up) throw new TransportError('network', 'Network request failed');
      },
    };
    const a = await client(server, ANN, 'ipad-a', { projects: async () => [] });
    a.engine.setTransport(transport);
    expect(await a.engine.sync()).toMatchObject({ outcome: 'failed', pushed: 0, pulled: 0, projects: [] });
    expect(a.engine.status()).toMatchObject({ state: 'offline', failures: 1 });
    expect(a.engine.status().lastSyncAt).toBeNull();

    up = true;
    expect((await a.engine.requestSync()).outcome).toBe('ran');
    expect(a.engine.status()).toMatchObject({ state: 'idle', failures: 0 });
    expect(a.engine.status().lastSyncAt).not.toBeNull();
  });

  it('a transport without ping keeps the old behaviour: idle with nothing to do', async () => {
    const a = await client(server, ANN, 'ipad-a', { projects: async () => [] });
    expect((await a.engine.sync()).outcome).toBe('ran');
    expect(a.engine.status().state).toBe('idle');
  });
});

describe('known projects (T41, D127)', () => {
  it('a project learned from the server is pulled before any local row exists, and the pull brings the row', async () => {
    // The server holds the project as ops (what POST /projects writes): here a client pushes them.
    const seeder = await Store.open(new BetterSqliteDriver(), { installId: 'server', search: 'like' });
    const sEditor = new Editor(seeder, { projectId: PROJECT, userId: ANN, now: tsNext });
    await sEditor.create('project', { id: PROJECT, name: 'Tower', settings: { export_title: 'ETC Lighting Controls Survey' } }, CTX);
    const group = (await sEditor.create('numbering_group', { project_id: PROJECT, label: '06/06M' }, CTX)).id;
    await sEditor.create('level', { id: LEVEL, project_id: PROJECT, level: '06M', numbering_group_id: group, floor_order: 1 }, CTX);
    await new SyncEngine(seeder, server, { now, log: () => {} }).sync();
    expect(server.ops(PROJECT).map((o) => o.entity_kind)).toEqual(['project', 'numbering_group', 'level']);

    // A fresh iPad: no project row, only the id from GET /projects.
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'ipad-b', search: 'like' });
    const engine = new SyncEngine(store, server, { now, log: () => {} });
    expect(await store.list('project')).toEqual([]);
    expect((await engine.sync()).projects).toEqual([]);

    expect(await rememberProjects(store, [PROJECT])).toEqual([PROJECT]);
    expect(await rememberProjects(store, [PROJECT])).toEqual([PROJECT]); // idempotent
    expect(await knownProjects(store)).toEqual([PROJECT]);
    const report = await engine.sync();
    expect(report).toMatchObject({ outcome: 'ran', pulled: 3, projects: [PROJECT] });
    expect((await store.get('project', PROJECT))!.name).toBe('Tower');
    expect((await store.get('numbering_group', group))!.label).toBe('06/06M');
    expect((await store.get('level', LEVEL))!.numbering_group_id).toBe(group);
    expect(engine.status().lastServerSeq[PROJECT]).toBe(3);
  });
});

describe('status and scheduling', () => {
  it('notifies subscribers of every change and unsubscribes cleanly', async () => {
    const a = await client(server, ANN, 'ipad-a');
    const seen: SyncStatus['state'][] = [];
    const off = a.engine.subscribe((s) => seen.push(s.state));
    await newDevice(a);
    await a.engine.sync();
    expect(seen[0]).toBe('idle'); // called at once
    expect(seen).toContain('syncing');
    expect(seen[seen.length - 1]).toBe('idle');
    off();
    const n = seen.length;
    await a.engine.sync();
    expect(seen).toHaveLength(n);
  });

  it('start() syncs at once, then every intervalMs; stop() ends it', async () => {
    vi.useFakeTimers();
    const a = await client(server, ANN, 'ipad-a', {
      intervalMs: 60_000,
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const d = await newDevice(a);
    a.engine.start();
    expect(a.engine.isStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.pushes).toHaveLength(1);

    await a.editor.setField('device', d, 'notes', 'later', CTX);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(server.pushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.pushes).toHaveLength(2);

    a.engine.stop();
    await a.editor.setField('device', d, 'notes', 'never sent', CTX);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.pushes).toHaveLength(2);
    expect(a.engine.isStarted).toBe(false);
  });

  it('while offline the timer waits for the backoff when that is longer than the interval', async () => {
    vi.useFakeTimers();
    let fake = 1_760_000_000_000;
    const a = await client(server, ANN, 'ipad-a', {
      intervalMs: 1_000,
      backoffMs: 5_000,
      now: () => fake,
      setTimer: (fn: () => void, ms: number) => setTimeout(() => { fake += ms; fn(); }, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    await newDevice(a);
    server.fail({ on: 'any', failure: 'network' });
    a.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.engine.status().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(server.pushes).toHaveLength(0); // not retried every second
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.pushes).toHaveLength(1);
    expect(a.engine.status().state).toBe('idle');
    a.engine.stop();
  });
});

describe('TransportError', () => {
  it('classifies failures', () => {
    const e = new TransportError('rejected', 'POST /ops → 409', 409, { error: 'integrity' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ failure: 'rejected', status: 409, name: 'TransportError' });
  });
});
