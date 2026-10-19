/**
 * Read model and actions of the Sync & uploads screen (T25, Phase 3 §12). No React or Expo
 * imports, so it is tested in Node over `BetterSqliteDriver`. Everything is read from the local
 * store, so the screen works offline.
 */

import type { BlobFiles, CycleTiming, Store } from '@field-survey/core';

export type OutboxSummary = {
  /** Every op still in the outbox, quarantined ones included. */
  pending: number;
  /** `created_at` of the oldest unsent op, null when the outbox is empty. */
  oldestAt: string | null;
  /** Ops still pending that failed to send at least once, with the last error seen. */
  failing: number;
  lastError: string | null;
  /** Ops the server refused (409/422), parked until Retry (T75, D145). */
  quarantined: QuarantinedEdit[];
};

export type QuarantinedEdit = {
  opId: string;
  /** "device status", "photo create", "cable_end delete"… */
  what: string;
  at: string;
  attempts: number;
  error: string | null;
};

export type FailedUpload = { sha256: string; kind: string; attempts: number; error: string | null };

export type CachedLevel = { id: string; code: string; cache: 'cached' | 'downloading' | 'not cached' };

export type SyncScreenData = {
  outbox: OutboxSummary;
  failedUploads: FailedUpload[];
  /** Open review items in the project (D90: one per conflicting op). */
  openReviews: number;
  levels: CachedLevel[];
  /** Bytes by kind of the files held on this iPad. */
  storage: { photosBytes: number; plansBytes: number; otherBytes: number; reclaimableBytes: number };
};


export async function loadSyncScreen(store: Store, projectId: string | null): Promise<SyncScreenData> {
  const db = store.db;
  const ob = await db.query<{ n: number; oldest: string | null; failing: number; err: string | null }>(
    `SELECT count(*) AS n, min(created_at) AS oldest,
            sum(CASE WHEN attempts > 0 AND state = 'pending' THEN 1 ELSE 0 END) AS failing,
            (SELECT last_error FROM outbox WHERE last_error IS NOT NULL AND state = 'pending' ORDER BY created_at DESC LIMIT 1) AS err
     FROM outbox ${projectId ? 'WHERE project_id = ?' : ''}`,
    projectId ? [projectId] : [],
  );
  const quarantined = (await store.quarantined(projectId ?? undefined)).map((q) => ({
    opId: q.op.op_id,
    what: `${q.op.entity_kind} ${q.op.field ?? q.op.kind}`,
    at: q.op.client_ts,
    attempts: q.attempts,
    error: q.error,
  }));
  const failed = await db.query<{ sha256: string; kind: string; attempts: number; last_error: string | null }>(
    `SELECT sha256, kind, attempts, last_error FROM blob_queue
     WHERE direction = 'upload' AND state = 'failed' ORDER BY created_at`,
  );
  const reviews = projectId
    ? await db.query<{ n: number }>(
        `SELECT count(*) AS n FROM review_item WHERE deleted_at IS NULL AND state = 'open' AND project_id = ?`,
        [projectId],
      )
    : [{ n: 0 }];
  const levels = projectId
    ? await db.query<{ id: string; level: string; local_path: string | null; queued: number | null }>(
        `SELECT l.id AS id, l.level AS level, b.local_path AS local_path,
                (SELECT count(*) FROM blob_queue q WHERE q.sha256 = s.blob AND q.direction = 'download'
                   AND q.state IN ('queued', 'active')) AS queued
         FROM level l
         JOIN sheet s ON s.id = l.display_sheet_id AND s.deleted_at IS NULL AND s.blob IS NOT NULL
         LEFT JOIN blob b ON b.sha256 = s.blob
         WHERE l.project_id = ? AND l.deleted_at IS NULL
         ORDER BY l.floor_order, l.level`,
        [projectId],
      )
    : [];
  const bytes = await db.query<{ kind: string | null; bytes: number | null; reclaim: number | null }>(
    `SELECT kind, sum(size) AS bytes,
            sum(CASE WHEN upload_state = 'complete' THEN size ELSE 0 END) AS reclaim
     FROM blob WHERE local_path IS NOT NULL GROUP BY kind`,
  );
  const storage = { photosBytes: 0, plansBytes: 0, otherBytes: 0, reclaimableBytes: 0 };
  for (const r of bytes) {
    const n = r.bytes ?? 0;
    if (r.kind === 'image' || r.kind === 'thumb' || r.kind === 'markup' || r.kind === null) storage.photosBytes += n;
    else if (r.kind === 'sheet') storage.plansBytes += n;
    else storage.otherBytes += n;
    if (r.kind === 'image') storage.reclaimableBytes += r.reclaim ?? 0;
  }
  return {
    outbox: { pending: ob[0]?.n ?? 0, oldestAt: ob[0]?.oldest ?? null, failing: ob[0]?.failing ?? 0, lastError: ob[0]?.err ?? null, quarantined },
    failedUploads: failed.map((f) => ({ sha256: f.sha256, kind: f.kind, attempts: f.attempts, error: f.last_error })),
    openReviews: reviews[0]?.n ?? 0,
    levels: levels.map((l) => ({
      id: l.id,
      code: l.level,
      cache: l.local_path ? 'cached' : l.queued ? 'downloading' : 'not cached',
    })),
    storage,
  };
}

/** Put every failed upload back in the queue (files that are still missing fail again, with the reason). */
export async function retryFailedUploads(store: Store): Promise<number> {
  const n = (await store.db.query<{ n: number }>(`SELECT count(*) AS n FROM blob_queue WHERE direction = 'upload' AND state = 'failed'`))[0]?.n ?? 0;
  await store.db.exec(
    `UPDATE blob_queue SET state = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL
     WHERE direction = 'upload' AND state = 'failed'`,
  );
  return n;
}

/**
 * Remove the local copies of full-size photos the server already has (they download again on
 * demand). Never touches bytes that have not reached the server, thumbnails, plans or ink.
 */
export async function freeUploadedPhotos(store: Store, files: BlobFiles): Promise<{ files: number; bytes: number }> {
  const rows = await store.db.query<{ sha256: string; size: number; local_path: string }>(
    `SELECT sha256, size, local_path FROM blob
     WHERE local_path IS NOT NULL AND kind = 'image' AND upload_state = 'complete'`,
  );
  let bytes = 0;
  for (const r of rows) {
    await files.remove(r.local_path);
    await store.db.exec(`UPDATE blob SET local_path = NULL WHERE sha256 = ?`, [r.sha256]);
    bytes += r.size;
  }
  return { files: rows.length, bytes };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}


/**
 * The server's deployed commit and Alembic revision from public `GET /health` (D154 (4)), shown
 * beside the server URL so JS/server skew is visible. Never throws: offline or an older server
 * gives a plain line instead.
 */
export async function loadServerVersion(serverUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 5000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${serverUrl.replace(/\/+$/, '')}/health`, { signal: ctl.signal });
    if (!r.ok) return `server answered ${r.status}`;
    const h = (await r.json()) as { commit?: string; migration?: string };
    if (!h.commit) return 'commit not reported';
    return `commit ${h.commit.slice(0, 7)} · migration ${h.migration ?? '?'}`;
  } catch {
    return 'commit unknown (not connected)';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Sync screen's timing line (T131): what the last cycle cost and where, and the last rules
 * pass. One line, so a regression is seen on the iPad without Metro:
 * "Last cycle 0.4 s · push 0.1 s · pull 0.2 s · apply 0.0 s · 0 pushed, 0 pulled · rules 0.3 s (2 projects, 0 writes)".
 */
export function describeCycle(
  cycle: CycleTiming | null,
  rules: { projects: number; ms: number; ops: number } | null,
): string {
  const s = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const parts: string[] = [];
  if (cycle) {
    parts.push(`Last cycle ${s(cycle.ms)}${cycle.failed ? ' (failed)' : ''}`);
    parts.push(`push ${s(cycle.pushMs)}`, `pull ${s(cycle.pullMs)}`, `apply ${s(cycle.applyMs)}`);
    parts.push(`${cycle.pushed} pushed, ${cycle.pulled} pulled`);
  } else {
    parts.push('No cycle yet');
  }
  if (rules) {
    parts.push(`rules ${s(rules.ms)} (${rules.projects} project${rules.projects === 1 ? '' : 's'}, ${rules.ops} write${rules.ops === 1 ? '' : 's'})`);
  }
  return parts.join(' · ');
}
