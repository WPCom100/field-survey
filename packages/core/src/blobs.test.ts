import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobQueue, type BlobKind, type BlobQueueOptions, type BlobQueueStatus } from './blobs';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import { Store } from './store';
import { TransportError } from './sync';
import { CHUNK, FakeBlobServer, NodeBlobFiles, sha256 } from './testing/fake-blob-server';

const PROJECT = uuidv7();
const L1 = uuidv7();
const L2 = uuidv7();
const GROUP = uuidv7();
const ANN = uuidv7();
const BOB = uuidv7();

let clock = 1_760_000_000_000;
const now = () => clock;
let seq = 0;

let dir: string;
let server: FakeBlobServer;
let files: NodeBlobFiles;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blobs-'));
  server = new FakeBlobServer();
  files = new NodeBlobFiles(join(dir, 'sandbox'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

/** An op another install made, already applied on the server. */
function remote(entity_kind: string, entity_id: string, kind: Op['kind'], extra: Partial<Op> = {}): Op {
  seq++;
  return {
    op_id: uuidv7(),
    project_id: PROJECT,
    user_id: BOB,
    install_id: 'other-ipad',
    client_ts: new Date(clock + seq).toISOString(),
    entity_kind,
    entity_id,
    kind,
    change_type: 'Field survey',
    reason: 'test',
    server_seq: seq,
    server_ts: new Date(clock + seq).toISOString(),
    state: 'applied',
    ...extra,
  } as Op;
}

async function openStore(path = ':memory:'): Promise<{ store: Store; driver: BetterSqliteDriver }> {
  const driver = new BetterSqliteDriver(path);
  const store = await Store.open(driver, { installId: 'ipad-a', search: 'like' });
  return { store, driver };
}

async function seedLevels(store: Store): Promise<void> {
  await store.applyRemoteMany([
    remote('project', PROJECT, 'create', { payload: { name: 'Tower' } }),
    remote('level', L1, 'create', { payload: { project_id: PROJECT, level: '06M', numbering_group_id: GROUP } }),
    remote('level', L2, 'create', { payload: { project_id: PROJECT, level: '07', numbering_group_id: GROUP } }),
  ]);
}

async function addPhoto(store: Store, level: string, blobs: { image?: string; thumb?: string; markup?: string }): Promise<string> {
  const id = uuidv7();
  await store.applyRemote(
    remote('photo', id, 'create', {
      payload: { level_id: level, image_blob: blobs.image ?? null, thumb_blob: blobs.thumb ?? null, markup_blob: blobs.markup ?? null },
    }),
  );
  return id;
}

async function assign(store: Store, level: string, user: string): Promise<void> {
  await store.applyRemote(remote('assignment', level, 'link_add', { payload: { user_id: user } }));
}

function queue(store: Store, transport: FakeBlobServer | null = server, extra: BlobQueueOptions = {}): BlobQueue {
  return new BlobQueue(store, transport, files, { now, log: () => {}, userId: () => ANN, ...extra });
}

/** Capture: write the bytes into the sandbox and register them. */
async function capture(q: BlobQueue, data: Uint8Array, kind: BlobKind): Promise<string> {
  const f = await files.put(data, kind);
  await q.addLocal({ sha256: f.sha256, kind, path: f.path, size: f.size, mime: kind === 'markup' ? 'application/json' : 'image/jpeg' });
  return f.sha256;
}

async function queueRow(store: Store, sha: string, direction = 'upload') {
  const rows = await store.db.query<{ state: string; attempts: number; next_attempt_at: string | null; last_error: string | null }>(
    `SELECT state, attempts, next_attempt_at, last_error FROM blob_queue WHERE sha256 = ? AND direction = ?`,
    [sha, direction],
  );
  return rows[0] ?? null;
}

async function blobRow(store: Store, sha: string) {
  const rows = await store.db.query<{ upload_state: string; chunks_received: string; local_path: string | null; kind: string | null; last_used_at: string | null }>(
    `SELECT upload_state, chunks_received, local_path, kind, last_used_at FROM blob WHERE sha256 = ?`,
    [sha],
  );
  return rows[0] ?? null;
}

describe('uploads', () => {
  it('sends thumbnails first, in 2-MB chunks, and the server ends up with the exact bytes', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    const q = queue(store);
    // Two photos captured image-first; their thumbnails must still go before either image.
    const img1 = await capture(q, bytes(2 * CHUNK + 1000, 1), 'image');
    const th1 = await capture(q, bytes(30_000, 2), 'thumb');
    const img2 = await capture(q, bytes(CHUNK - 5, 3), 'image');
    const th2 = await capture(q, bytes(25_000, 4), 'thumb');
    await addPhoto(store, L1, { image: img1, thumb: th1 });
    await addPhoto(store, L1, { image: img2, thumb: th2 });
    expect((await q.refresh()).photosWaiting).toBe(2);
    expect(q.status().uploadsPending).toBe(4);

    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 4 });
    const completes = server.calls.filter((c) => c.startsWith('complete')).map((c) => c.slice(9));
    expect(new Set(completes.slice(0, 2))).toEqual(new Set([th1.slice(0, 8), th2.slice(0, 8)]));
    expect(new Set(completes.slice(2))).toEqual(new Set([img1.slice(0, 8), img2.slice(0, 8)]));
    expect(server.chunkCalls(img1)).toEqual([0, 1, 2]);
    expect(server.chunkCalls(img2)).toEqual([0]);
    expect(sha256(server.blobs.get(img1)!.complete!)).toBe(sha256(bytes(2 * CHUNK + 1000, 1)));
    expect(await blobRow(store, img1)).toMatchObject({ upload_state: 'complete', chunks_received: '[0,1,2]', kind: 'image' });
    expect(await queueRow(store, img1)).toMatchObject({ state: 'done' });
    expect(q.status()).toMatchObject({ photosWaiting: 0, uploadsPending: 0, state: 'idle' });
  });

  it('TP-2: resumes after the app is killed between chunks, sending only what the server lacks', async () => {
    const dbPath = join(dir, 'store.db');
    const first = await openStore(dbPath);
    await seedLevels(first.store);
    const q1 = queue(first.store);
    const data = bytes(3 * CHUNK + 777, 9);
    const img = await capture(q1, data, 'image');
    const th = await capture(q1, bytes(20_000, 8), 'thumb');
    await addPhoto(first.store, L1, { image: img, thumb: th });

    // The app dies after chunk 1 reached the server but before the response came back.
    const killed = server.killAt({ sha256: img, chunk: 1, when: 'after' });
    void q1.run(); // never settles: the process is gone
    await killed;
    expect(await queueRow(first.store, img)).toMatchObject({ state: 'active' });
    expect(await blobRow(first.store, img)).toMatchObject({ upload_state: 'partial', chunks_received: '[0]' });
    first.driver.close();

    // Relaunch: a new store on the same file, a new queue.
    const second = await openStore(dbPath);
    const q2 = queue(second.store);
    expect((await q2.refresh()).photosWaiting).toBe(1);
    const report = await q2.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 1 });
    expect(server.chunkCalls(img)).toEqual([0, 1, 2, 3]); // each chunk sent exactly once overall
    expect(sha256(server.blobs.get(img)!.complete!)).toBe(sha256(data));
    expect(await blobRow(second.store, img)).toMatchObject({ upload_state: 'complete' });
    expect(q2.status().photosWaiting).toBe(0);
    second.driver.close();
  });

  it('TP-2: a chunk lost in flight when the app died is sent again after relaunch', async () => {
    const dbPath = join(dir, 'store.db');
    const first = await openStore(dbPath);
    const q1 = queue(first.store);
    const data = bytes(2 * CHUNK + 1, 5);
    const img = await capture(q1, data, 'image');
    const killed = server.killAt({ sha256: img, chunk: 1, when: 'before' });
    void q1.run();
    await killed;
    first.driver.close();

    const second = await openStore(dbPath);
    await queue(second.store).run();
    expect(server.chunkCalls(img)).toEqual([0, 1, 2]);
    expect(sha256(server.blobs.get(img)!.complete!)).toBe(sha256(data));
    second.driver.close();
  });

  it('goes offline on a network error, backs off, and resumes without resending acknowledged chunks', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const data = bytes(3 * CHUNK, 4);
    const img = await capture(q, data, 'image');
    server.fail({ on: 'declare', failure: 'network' }); // first attempt never reaches the server
    let report = await q.run();
    expect(report.outcome).toBe('failed');
    expect(q.status()).toMatchObject({ state: 'offline', failures: 1 });
    expect(await queueRow(store, img)).toMatchObject({ state: 'queued', attempts: 1 });
    expect((await q.run()).outcome).toBe('skipped'); // inside the backoff

    clock += 10_000;
    // Now the connection drops while chunk 1 is on its way (chunk 0 got through).
    const orig = server.putChunk.bind(server);
    let dropped = false;
    server.putChunk = async (sha, n, src) => {
      if (n === 1 && !dropped) {
        dropped = true;
        throw new TransportError('network', 'connection lost');
      }
      return orig(sha, n, src);
    };
    report = await q.run();
    expect(report.outcome).toBe('failed');
    expect(await blobRow(store, img)).toMatchObject({ upload_state: 'partial', chunks_received: '[0]' });
    clock += 60_000;
    report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 1 });
    expect(sha256(server.blobs.get(img)!.complete!)).toBe(sha256(data));
    expect(server.chunkCalls(img)).toEqual([0, 1, 2]); // chunk 0 was not sent again
    expect(q.status()).toMatchObject({ state: 'idle', failures: 0 });
  });

  it('skips the bytes when the server already has the blob (dedup)', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const data = bytes(CHUNK + 10, 6);
    server.seed(data);
    const sha = await capture(q, data, 'image');
    await q.run();
    expect(server.chunkCalls(sha)).toEqual([]);
    expect(await blobRow(store, sha)).toMatchObject({ upload_state: 'complete' });
  });

  it('marks an upload failed when the file no longer matches its hash, and carries on with the rest', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    const q = queue(store);
    const bad = await capture(q, bytes(1000, 1), 'image');
    const good = await capture(q, bytes(1000, 2), 'image');
    await addPhoto(store, L1, { image: bad });
    writeFileSync(files.pathFor(bad, 'image'), bytes(1000, 3)); // same length, different bytes
    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 1 });
    expect(await queueRow(store, bad)).toMatchObject({ state: 'failed' });
    expect((await queueRow(store, bad))!.last_error).toMatch(/SHA-256/);
    expect(server.blobs.get(good)!.complete).not.toBeNull();
    expect(q.status()).toMatchObject({ uploadsFailed: 1, photosWaiting: 1 });
  });

  it('marks an upload failed when the local file is gone', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const sha = await capture(q, bytes(500), 'thumb');
    rmSync(files.pathFor(sha, 'thumb'));
    await q.run();
    expect(await queueRow(store, sha)).toMatchObject({ state: 'failed' });
    expect(server.calls).toEqual([]);
  });

  it('sends a chunk again when the server lost it before completing', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const data = bytes(2 * CHUNK + 3, 7);
    const sha = await capture(q, data, 'image');
    server.fail({ on: 'complete', failure: 'rejected', status: 409, detail: { detail: { error: 'missing_chunks', missing: [1] } } });
    // Simulate the loss: the fake drops chunk 1 when complete is refused.
    const origComplete = server.complete.bind(server);
    let first = true;
    server.complete = async (s: string) => {
      if (first) {
        first = false;
        server.blobs.get(s)!.chunks.delete(1);
      }
      return origComplete(s);
    };
    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 1 });
    expect(server.chunkCalls(sha)).toEqual([0, 1, 2, 1]);
    expect(sha256(server.blobs.get(sha)!.complete!)).toBe(sha256(data));
  });

  it('retries a refused upload later without stopping the others', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const a = await capture(q, bytes(100, 1), 'thumb');
    const b = await capture(q, bytes(100, 2), 'thumb');
    server.fail({ on: 'declare', failure: 'server', status: 503 });
    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', uploaded: 1 });
    const [first, second] = [await queueRow(store, a), await queueRow(store, b)];
    const retried = first!.state === 'queued' ? first! : second!;
    expect(retried).toMatchObject({ state: 'queued', attempts: 1 });
    expect(retried.next_attempt_at! > new Date(clock).toISOString()).toBe(true);
    clock += 10_000;
    expect((await q.run()).uploaded).toBe(1);
  });

  it('works with no server: captures are kept and counted, nothing is sent', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    const q = queue(store, null);
    const th = await capture(q, bytes(100), 'thumb');
    await addPhoto(store, L1, { thumb: th });
    const report = await q.run();
    expect(report.outcome).toBe('no_token');
    expect(q.status()).toMatchObject({ state: 'no_token', photosWaiting: 1, uploadsPending: 1 });
    q.setTransport(server);
    expect((await q.run()).uploaded).toBe(1);
    expect(q.status().photosWaiting).toBe(0);
  });

  it('notifies subscribers and kicks a run on capture when started', async () => {
    const { store } = await openStore();
    const timers: Array<() => void> = [];
    const q = queue(store, server, { setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
    const seen: BlobQueueStatus[] = [];
    q.subscribe((s) => seen.push(s));
    q.start();
    await new Promise((r) => setTimeout(r, 10));
    const sha = await capture(q, bytes(100), 'thumb');
    await new Promise((r) => setTimeout(r, 20));
    expect(server.blobs.get(sha)?.complete).toBeTruthy();
    expect(seen.some((s) => s.uploadsPending === 1)).toBe(true);
    expect(seen.at(-1)!.uploadsPending).toBe(0);
    q.stop();
  });
});

describe('downloads', () => {
  it('prefetches thumbnails, markup and display sheets of assigned levels only, never full-size images', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    await assign(store, L1, ANN);
    await assign(store, L2, BOB);
    const t1 = server.seed(bytes(3000, 1));
    const t2 = server.seed(bytes(3000, 2));
    const i1 = server.seed(bytes(9000, 3));
    const tOther = server.seed(bytes(3000, 4));
    const tDeleted = server.seed(bytes(3000, 5));
    const sheet = server.seed(bytes(50_000, 6), 'application/pdf');
    const srcSheet = server.seed(bytes(40_000, 7), 'application/pdf');
    const m1 = server.seed(bytes(400, 8), 'application/json');
    await addPhoto(store, L1, { image: i1, thumb: t1, markup: m1 });
    await addPhoto(store, L1, { thumb: t2 });
    await addPhoto(store, L2, { thumb: tOther });
    const gone = await addPhoto(store, L1, { thumb: tDeleted });
    await store.applyRemote(remote('photo', gone, 'delete', { reason: 'dup' }));
    await store.applyRemoteMany([
      remote('sheet', uuidv7(), 'create', { payload: { level_id: L1, kind: 'display', blob: sheet } }),
      remote('sheet', uuidv7(), 'create', { payload: { level_id: L1, kind: 'source', blob: srcSheet } }),
    ]);

    const q = queue(store);
    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', downloaded: 4 });
    const downloads = server.calls.filter((c) => c.startsWith('download')).map((c) => c.slice(9));
    expect(downloads[0]).toBe(sheet.slice(0, 8)); // the plan first
    expect(new Set(downloads)).toEqual(new Set([sheet, t1, t2, m1].map((s) => s.slice(0, 8)))); // markup too (T21)
    expect(await blobRow(store, m1)).toMatchObject({ kind: 'markup' });
    const path = await q.localPath(t1);
    expect(path).toBe(files.pathFor(t1, 'thumb'));
    expect(new Uint8Array(await readFile(path!))).toEqual(bytes(3000, 1));
    expect(await blobRow(store, sheet)).toMatchObject({ upload_state: 'complete', kind: 'sheet' });
    // A second run finds everything cached.
    server.calls.length = 0;
    await q.run();
    expect(server.calls).toEqual([]);
  });

  it('waits quietly for a thumbnail its author has not uploaded yet', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    await assign(store, L1, ANN);
    const data = bytes(2000, 1);
    const th = sha256(data);
    await addPhoto(store, L1, { thumb: th });
    const q = queue(store);
    const report = await q.run();
    expect(report).toMatchObject({ outcome: 'ran', downloaded: 0 });
    expect(q.status()).toMatchObject({ state: 'idle', downloadsPending: 1 });
    expect(await queueRow(store, th, 'download')).toMatchObject({ state: 'queued', attempts: 1 });
    server.seed(data);
    expect((await q.run()).downloaded).toBe(0); // not due yet
    clock += 5 * 60_000;
    expect((await q.run()).downloaded).toBe(1);
  });

  it('fetches full-size on demand, caches it, and dedups concurrent requests', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const data = bytes(CHUNK + 50, 2);
    const sha = server.seed(data);
    const [a, b] = await Promise.all([q.ensureLocal(sha, 'image'), q.ensureLocal(sha, 'image')]);
    expect(a).toBe(files.pathFor(sha, 'image'));
    expect(b).toBe(a);
    expect(server.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect(sha256(new Uint8Array(await readFile(a!)))).toBe(sha256(data));
    clock += 1000;
    expect(await q.ensureLocal(sha, 'image')).toBe(a);
    expect(server.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect((await blobRow(store, sha))!.last_used_at).toBe(new Date(clock).toISOString());
  });

  it('returns null on demand when offline, not uploaded, or without a server', async () => {
    const { store } = await openStore();
    const sha = server.seed(bytes(10));
    expect(await queue(store, null).ensureLocal(sha, 'image')).toBeNull();
    server.fail({ on: 'download', failure: 'network' });
    expect(await queue(store).ensureLocal(sha, 'image')).toBeNull();
    expect(await queue(store).ensureLocal('f'.repeat(64), 'image')).toBeNull();
    expect(await queue(store).ensureLocal(sha, 'image')).not.toBeNull();
  });

  it('downloads again when a cached file disappeared', async () => {
    const { store } = await openStore();
    const q = queue(store);
    const sha = server.seed(bytes(100));
    const path = (await q.ensureLocal(sha, 'image'))!;
    rmSync(path);
    expect(await q.localPath(sha)).toBeNull();
    expect(await q.ensureLocal(sha, 'image')).toBe(path);
    expect(server.calls.filter((c) => c.startsWith('download'))).toHaveLength(2);
  });
});

describe('LRU cache', () => {
  it('evicts least recently used full-size images first, keeps thumbnails/sheets, never un-uploaded bytes', async () => {
    const { store } = await openStore();
    await seedLevels(store);
    await assign(store, L1, ANN);
    const q = queue(store, server, { cacheBudgetBytes: 25_000, evictGraceMs: 60_000 });
    // A local capture not yet uploaded (no server for it yet): must survive any eviction.
    const offlineQ = queue(store, null);
    const mine = await capture(offlineQ, bytes(12_000, 9), 'image');
    // Cached downloads, used at different times.
    const old = server.seed(bytes(8000, 1));
    const newer = server.seed(bytes(8000, 2));
    const th = server.seed(bytes(4000, 3));
    await addPhoto(store, L1, { thumb: th });
    await q.ensureLocal(old, 'image');
    clock += 1000;
    await q.ensureLocal(newer, 'image');
    clock += 1000;
    await q.prefetch();
    // One run: a 503 keeps `mine` unsent; the prefetched thumbnail downloads.
    server.fail({ on: 'declare', failure: 'server', status: 503 });
    await q.run();
    expect(await q.localPath(th, { touch: false })).not.toBeNull();
    // Over budget now (12k + 8k + 8k + 4k = 32k) but everything is inside the grace period.
    expect(await q.evict()).toBe(0);

    clock += 120_000;
    const removed = await q.evict();
    expect(removed).toBe(1); // 32k - 8k = 24k ≤ 25k
    expect(await q.localPath(old, { touch: false })).toBeNull(); // oldest image went first
    expect(await q.localPath(newer, { touch: false })).not.toBeNull();
    expect(await q.localPath(th, { touch: false })).not.toBeNull();
    expect(await q.localPath(mine, { touch: false })).not.toBeNull();

    // Tighter budget: images go before the thumbnail; the un-uploaded capture never goes.
    const tight = queue(store, server, { cacheBudgetBytes: 1, evictGraceMs: 0 });
    await tight.evict();
    expect(await tight.localPath(newer, { touch: false })).toBeNull();
    expect(await tight.localPath(th, { touch: false })).toBeNull();
    expect(await tight.localPath(mine, { touch: false })).not.toBeNull();

    // An evicted prefetched thumbnail is queued again by the next prefetch.
    await tight.prefetch();
    expect(await queueRow(store, th, 'download')).toMatchObject({ state: 'queued' });
  });

  it('reports the cache size', async () => {
    const { store } = await openStore();
    const q = queue(store);
    await q.ensureLocal(server.seed(bytes(1234)), 'image');
    expect((await q.refresh()).cacheBytes).toBe(1234);
  });
});
