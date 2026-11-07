import { Editor, Store, type BlobFiles } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { formatLine, rotationNames } from '../log/format';
import { listProjects } from '../home/data';
import { ensureDemoLevel } from '../plan/demo';
import {
  carryOver,
  describeCycle,
  formatBytes,
  freeUploadedPhotos,
  loadServerVersion,
  loadSyncScreen,
  retryFailedUploads,
  unknownUserNotice,
  type QuarantinedEdit,
} from './screen';

async function open() {
  return Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
}

class MemFiles implements BlobFiles {
  removed: string[] = [];
  pathFor(sha: string) { return `blobs/${sha}`; }
  async exists() { return true; }
  async remove(p: string) { this.removed.push(p); }
}

async function addBlob(store: Store, sha: string, kind: string, size: number, state: string) {
  await store.db.exec(
    `INSERT INTO blob (sha256, size, mime, upload_state, local_path, kind) VALUES (?, ?, 'x', ?, ?, ?)`,
    [sha, size, state, `blobs/${sha}`, kind],
  );
}

describe('loadSyncScreen', () => {
  it('summarises the outbox, failed uploads and storage from the local store', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    await addBlob(store, 'a', 'image', 1000, 'complete');
    await addBlob(store, 'b', 'image', 500, 'local');
    await addBlob(store, 'c', 'sheet', 4000, 'complete');
    await store.db.exec(
      `INSERT INTO blob_queue (sha256, direction, kind, state, attempts, last_error, created_at) VALUES ('b', 'upload', 'image', 'failed', 3, 'file missing', '2026-01-01')`,
    );
    await store.db.exec(
      `INSERT INTO outbox (op_id, project_id, client_ts, attempts, last_error, created_at) VALUES
       ('o1', ?, '2026-01-01T00:00:00Z', 2, 'boom', '2026-01-01T00:00:01Z'), ('o2', ?, '2026-01-01T00:00:02Z', 0, NULL, '2026-01-01T00:00:03Z')`,
      [project!.id, project!.id],
    );

    const d = await loadSyncScreen(store, project!.id);
    expect(d.outbox.pending).toBe(2);
    expect(d.outbox.oldestAt).toBe('2026-01-01T00:00:01Z');
    expect(d.outbox.failing).toBe(1);
    expect(d.outbox.lastError).toBe('boom');
    expect(d.failedUploads).toEqual([{ sha256: 'b', kind: 'image', attempts: 3, error: 'file missing' }]);
    expect(d.storage).toEqual({ photosBytes: 1500, plansBytes: 4000, otherBytes: 0, reclaimableBytes: 1000 });
    expect(d.levels.length).toBeGreaterThanOrEqual(0);
  });

  it('lists quarantined edits apart from pending ones (T75)', async () => {
    const store = await open();
    await ensureDemoLevel(store);
    const [project] = await listProjects(store);
    const [device] = await store.list<{ id: string }>('device', { limit: 1 });
    const editor = new Editor(store, { projectId: project!.id, userId: 'u', now: () => '2026-01-02T00:00:00Z' });
    const bad = await editor.setField('device', device!.id, 'notes', 'refused', { change_type: 'Field survey', reason: 't' });
    await editor.setField('device', device!.id, 'status', 'Issue', { change_type: 'Field survey', reason: 't' });
    await store.quarantine([bad!.op_id], 'POST /ops → 422');

    const d = await loadSyncScreen(store, project!.id);
    expect(d.outbox.pending).toBe(2); // still unsynced, so the export gate stays shut
    expect(d.outbox.failing).toBe(0); // the pending one never failed
    expect(d.outbox.lastError).toBeNull();
    expect(d.outbox.quarantined).toEqual([
      { opId: bad!.op_id, what: 'device notes', at: '2026-01-02T00:00:00Z', attempts: 1, error: 'POST /ops → 422' },
    ]);
    // every project's refused edits are listed, as the status bar counts them (T160)
    expect((await loadSyncScreen(store, null)).outbox.quarantined.map((q) => q.opId)).toEqual([bad!.op_id]);
    expect(await store.requeueQuarantined(project!.id)).toBe(1);
    expect((await loadSyncScreen(store, project!.id)).outbox.quarantined).toEqual([]);
  });

  it('is empty-safe with no project', async () => {
    const d = await loadSyncScreen(await open(), null);
    expect(d.outbox.pending).toBe(0);
    expect(d.levels).toEqual([]);
  });
});

describe('actions', () => {
  it('retryFailedUploads requeues only failed uploads', async () => {
    const store = await open();
    await store.db.exec(
      `INSERT INTO blob_queue (sha256, direction, kind, state, attempts, last_error, created_at) VALUES
       ('x', 'upload', 'image', 'failed', 4, 'e', '2026-01-01'), ('y', 'upload', 'thumb', 'done', 0, NULL, '2026-01-01')`,
    );
    expect(await retryFailedUploads(store)).toBe(1);
    const rows = await store.db.query<{ sha256: string; state: string; attempts: number; last_error: string | null }>(
      `SELECT sha256, state, attempts, last_error FROM blob_queue ORDER BY sha256`,
    );
    expect(rows).toEqual([
      { sha256: 'x', state: 'queued', attempts: 0, last_error: null },
      { sha256: 'y', state: 'done', attempts: 0, last_error: null },
    ]);
  });

  it('freeUploadedPhotos removes only uploaded full-size images', async () => {
    const store = await open();
    await addBlob(store, 'up', 'image', 1000, 'complete');
    await addBlob(store, 'local', 'image', 700, 'local');
    await addBlob(store, 'th', 'thumb', 10, 'complete');
    await addBlob(store, 'sh', 'sheet', 10, 'complete');
    const files = new MemFiles();
    expect(await freeUploadedPhotos(store, files)).toEqual({ files: 1, bytes: 1000 });
    expect(files.removed).toEqual(['blobs/up']);
    const left = await store.db.query<{ sha256: string }>(`SELECT sha256 FROM blob WHERE local_path IS NOT NULL ORDER BY sha256`);
    expect(left.map((r) => r.sha256)).toEqual(['local', 'sh', 'th']);
  });
});

describe('helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(14.2 * 1024 ** 2)).toBe('14.2 MB');
    expect(formatBytes(1.9 * 1024 ** 3)).toBe('1.9 GB');
  });
  it('formats log lines and rotation names', () => {
    expect(formatLine(new Date('2026-10-11T10:00:00Z'), 'sync', 'warn', 'x', { a: 1 })).toBe('2026-10-11T10:00:00.000Z WARN [sync] x {"a":1}\n');
    expect(rotationNames(3)).toEqual(['app.log', 'app.1.log', 'app.2.log']);
  });
});

describe('loadServerVersion', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('shows the short commit and the migration from /health', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ status: 'ok', commit: '0123456789abcdef', migration: '0005' }));
    }) as unknown as typeof fetch;
    expect(await loadServerVersion('https://s/', f)).toBe('commit 0123456 · migration 0005');
    expect(url).toBe('https://s/health');
  });

  it('degrades to a plain line for an old server, an error status or no network', async () => {
    expect(await loadServerVersion('https://s', answer(200, { status: 'ok' }))).toBe('commit not reported');
    expect(await loadServerVersion('https://s', answer(503, {}))).toBe('server answered 503');
    const offline = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await loadServerVersion('https://s', offline)).toBe('commit unknown (not connected)');
  });
});

describe('describeCycle (T131)', () => {
  it('says what the last cycle and the last rules pass cost, in seconds', () => {
    const cycle = { at: '2026-10-19T10:00:00Z', ms: 412, pushMs: 90, pullMs: 230, applyMs: 51, pushed: 3, pulled: 12, projects: 2, failed: false };
    expect(describeCycle(cycle, { projects: 2, ms: 310, ops: 0 })).toBe(
      'Last cycle 0.4 s · push 0.1 s · pull 0.2 s · apply 0.1 s · 3 pushed, 12 pulled · rules 0.3 s (2 projects, 0 writes)',
    );
    expect(describeCycle({ ...cycle, failed: true, pulled: 0 }, null)).toBe('Last cycle 0.4 s (failed) · push 0.1 s · pull 0.2 s · apply 0.1 s · 3 pushed, 0 pulled');
    expect(describeCycle(null, { projects: 1, ms: 1200, ops: 1 })).toBe('No cycle yet · rules 1.2 s (1 project, 1 write)');
    expect(describeCycle(null, null)).toBe('No cycle yet');
  });
});

describe('a user the server does not know (T160)', () => {
  const ANN = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const OTHER = '0190a1b2-c3d4-7e5f-8a9b-00000099aa01';
  const refused = (error: string | null): QuarantinedEdit => ({ opId: 'o', what: 'device notes', at: '2026-11-06T00:00:00Z', attempts: 1, error });

  it('says the iPad\'s user is not on the server and to re-sign in under the same name', () => {
    const q = [refused(`POST /ops → 422: unknown user ${ANN}`), refused(`POST /ops → 422: unknown user ${ANN}`)];
    expect(unknownUserNotice(q, { id: ANN, name: 'Ann' })).toBe(
      "The server has no record of this iPad's user, Ann (as after a restore from an old backup), so it refuses their edits. " +
        'Re-sign in and pick Ann again: the 2 refused edits are then sent as Ann.',
    );
  });

  it('names another user by the end of their id, and says nothing for other refusals', () => {
    expect(unknownUserNotice([refused(`POST /ops → 422: unknown user ${OTHER}`), refused('POST /ops → 409: integrity')], { id: ANN, name: 'Ann' })).toBe(
      "The server has no record of the user who made 1 refused edit (user …99aa01). Re-sign in under that person's name to send them as that person.",
    );
    expect(unknownUserNotice([refused('POST /ops → 422: bad op'), refused(null)], { id: ANN, name: 'Ann' })).toBeNull();
    expect(unknownUserNotice([], { id: ANN, name: 'Ann' })).toBeNull();
  });

  it('carryOver: the same name on the same server with a new id carries the old ids over', () => {
    const srv = 'https://survey.example.com';
    const seen = [
      { serverUrl: srv, id: ANN, name: 'Ann' },
      { serverUrl: srv, id: 'bob-1', name: 'Bob' },
      { serverUrl: 'http://127.0.0.1:8010', id: 'ann-rig', name: 'Ann' },
    ];
    const r = carryOver(seen, { serverUrl: `${srv}/`, id: 'ann-2', name: ' ann ' });
    expect(r.from).toEqual([ANN]); // never the rig server's Ann, never Bob
    expect(r.seen).toEqual([seen[1], seen[2], { serverUrl: `${srv}/`, id: 'ann-2', name: ' ann ' }]);
    // Signing in again as the same user carries nothing; a first sign-in carries nothing.
    expect(carryOver(r.seen, { serverUrl: srv, id: 'ann-2', name: 'Ann' }).from).toEqual([]);
    expect(carryOver([], { serverUrl: srv, id: ANN, name: 'Ann' })).toEqual({ from: [], seen: [{ serverUrl: srv, id: ANN, name: 'Ann' }] });
  });
});
