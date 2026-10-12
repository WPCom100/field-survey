import { Editor, Store, type BlobFiles } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { formatLine, rotationNames } from '../log/format';
import { listProjects } from '../home/data';
import { ensureDemoLevel } from '../plan/demo';
import { formatBytes, freeUploadedPhotos, loadSyncScreen, retryFailedUploads } from './screen';

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
