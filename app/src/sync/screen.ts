/**
 * Read model and actions of the Sync & uploads screen (T25, Phase 3 §12). No React or Expo
 * imports, so it is tested in Node over `BetterSqliteDriver`. Everything is read from the local
 * store, so the screen works offline.
 */

import { unknownUserOf, type BlobFiles, type CycleTiming, type Store, type SyncStatus } from '@field-survey/core';

import { clock } from './describe';

export type OutboxSummary = {
  /** Every op still in the outbox, quarantined ones included. */
  pending: number;
  /** `created_at` of the oldest unsent op, null when the outbox is empty. */
  oldestAt: string | null;
  /** Ops still pending that failed to send at least once, with the last error seen. */
  failing: number;
  lastError: string | null;
  /** Ops the server refused (409/422), parked until Retry (T75, D145); every project's (T160). */
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

/** A level's plan on this iPad: the display sheet's bytes on disk, queued for download, neither, or no sheet yet. */
export type LevelCache = 'cached' | 'downloading' | 'not cached' | 'no sheet';

/** One row of "Levels on this iPad" (T178): every live level of the project, in floor order. */
export type CachedLevel = {
  id: string;
  code: string;
  cache: LevelCache;
  inScope: boolean;
  assignedToMe: boolean;
  /** Bytes on disk of the level's sheet files (display and source; each file once). */
  planBytes: number;
  /** Bytes on disk of its live photos' image, thumbnail and markup files (each file once). */
  photoBytes: number;
  /** Size of the display sheet's file when the iPad knows it (also while it downloads); null otherwise. */
  sheetBytes: number | null;
};

export type SyncScreenData = {
  outbox: OutboxSummary;
  failedUploads: FailedUpload[];
  /** Open review items in the project (D90: one per conflicting op). */
  openReviews: number;
  levels: CachedLevel[];
  /** Bytes by kind of the files held on this iPad. */
  storage: { photosBytes: number; plansBytes: number; otherBytes: number; reclaimableBytes: number };
};

/** `user_id`'s assigned levels feed "assigned to me" on the level rows; null reads none. */
export async function loadSyncScreen(store: Store, projectId: string | null, userId: string | null = null): Promise<SyncScreenData> {
  const db = store.db;
  const ob = await db.query<{ n: number; oldest: string | null; failing: number; err: string | null }>(
    `SELECT count(*) AS n, min(created_at) AS oldest,
            sum(CASE WHEN attempts > 0 AND state = 'pending' THEN 1 ELSE 0 END) AS failing,
            (SELECT last_error FROM outbox WHERE last_error IS NOT NULL AND state = 'pending' ORDER BY created_at DESC LIMIT 1) AS err
     FROM outbox ${projectId ? 'WHERE project_id = ?' : ''}`,
    projectId ? [projectId] : [],
  );
  // every project's, as the status bar counts them and Retry sends them (T160: a lost user's edits
  // in a project the home is not on were counted "need attention" and listed nowhere)
  const quarantined = (await store.quarantined()).map((q) => ({
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
    ? await db.query<{
        id: string;
        level: string;
        in_scope: number | null;
        blob: string | null;
        local_path: string | null;
        size: number | null;
        queued: number | null;
      }>(
        `SELECT l.id AS id, l.level AS level, l.in_scope AS in_scope, s.blob AS blob, b.local_path AS local_path, b.size AS size,
                (SELECT count(*) FROM blob_queue q WHERE q.sha256 = s.blob AND q.direction = 'download'
                   AND q.state IN ('queued', 'active')) AS queued
         FROM level l
         LEFT JOIN sheet s ON s.id = l.display_sheet_id AND s.deleted_at IS NULL AND s.blob IS NOT NULL
         LEFT JOIN blob b ON b.sha256 = s.blob
         WHERE l.project_id = ? AND l.deleted_at IS NULL
         ORDER BY l.floor_order, l.level`,
        [projectId],
      )
    : [];
  // Bytes on disk per level, from the blob rows: each file counted once per level.
  const perLevel = async (sql: string) => {
    const out = new Map<string, number>();
    if (!projectId) return out;
    for (const r of await db.query<{ level_id: string; n: number | null }>(sql, [projectId])) out.set(r.level_id, r.n ?? 0);
    return out;
  };
  const planBytes = await perLevel(
    `SELECT level_id, sum(size) AS n FROM (
       SELECT DISTINCT s.level_id AS level_id, b.sha256, b.size AS size
       FROM sheet s JOIN level l ON l.id = s.level_id
       JOIN blob b ON b.sha256 = s.blob AND b.local_path IS NOT NULL
       WHERE l.project_id = ? AND s.deleted_at IS NULL)
     GROUP BY level_id`,
  );
  const photoBytes = await perLevel(
    `SELECT level_id, sum(size) AS n FROM (
       SELECT DISTINCT p.level_id AS level_id, b.sha256, b.size AS size
       FROM photo p JOIN level l ON l.id = p.level_id
       JOIN blob b ON b.sha256 IN (p.image_blob, p.thumb_blob, p.markup_blob) AND b.local_path IS NOT NULL
       WHERE l.project_id = ? AND p.deleted_at IS NULL)
     GROUP BY level_id`,
  );
  const mine = new Set<string>();
  if (projectId && userId) {
    for (const a of await db.query<{ level_id: string }>(`SELECT level_id FROM assignment WHERE user_id = ? AND deleted_at IS NULL`, [userId])) {
      mine.add(a.level_id);
    }
  }
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
      cache: !l.blob ? 'no sheet' : l.local_path ? 'cached' : l.queued ? 'downloading' : 'not cached',
      inScope: l.in_scope !== 0,
      assignedToMe: mine.has(l.id),
      planBytes: planBytes.get(l.id) ?? 0,
      photoBytes: photoBytes.get(l.id) ?? 0,
      sheetBytes: l.size ?? null,
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

// ------------------------------------------------------------- the board's copy (T178)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12,345": digits grouped by thousands, the same on every locale. */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05" today, "Nov 9, 14:05" on another day: an edit can wait offline for days. */
export function stamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return same ? clock(d) : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock(d)}`;
}

export type TileTone = 'text' | 'success' | 'warning' | 'danger';

/**
 * The Connection tile: a short state, its tone and icon, and the line under it ("14:05 · server
 * sequence 12,345"; "Last synced 13:40 · next try 14:10" while it cannot sync).
 */
export function connectionTile(
  s: Pick<SyncStatus, 'state' | 'lastSyncAt' | 'lastFailure' | 'lastError' | 'nextAttemptAt'>,
  seq: number,
  now: Date = new Date(),
): { value: string; sub: string; tone: TileTone; icon: 'check' | 'sync' | 'offline' | 'warning' | 'error' | null } {
  const last = s.lastSyncAt ? `Last synced ${stamp(s.lastSyncAt, now)}` : 'Never synced';
  const next = s.nextAttemptAt ? `next try ${stamp(s.nextAttemptAt, now)}` : null;
  const behind = [last, next].filter(Boolean).join(' · ');
  switch (s.state) {
    case 'syncing':
      return { value: 'Syncing…', sub: s.lastSyncAt ? last : 'First sync', tone: 'text', icon: 'sync' };
    case 'idle':
      if (!s.lastSyncAt) return { value: 'Not synced yet', sub: 'The server answered; nothing has synced', tone: 'text', icon: null };
      return {
        value: 'Synced',
        sub: [stamp(s.lastSyncAt, now), seq ? `server sequence ${groupDigits(seq)}` : null].filter(Boolean).join(' · '),
        tone: 'success',
        icon: 'check',
      };
    case 'offline':
      return { value: 'Offline', sub: behind, tone: 'warning', icon: 'offline' };
    case 'error':
      if (s.lastFailure === 'auth') return { value: 'Sign-in needed', sub: behind, tone: 'warning', icon: 'warning' };
      return { value: 'Sync error', sub: [s.lastError ?? 'unknown error', behind].join(' · '), tone: 'danger', icon: 'error' };
    case 'no_token':
      return { value: 'Not connected', sub: 'Sign in to sync', tone: 'warning', icon: 'offline' };
  }
}

/** The Photos waiting tile's line: "3 files · 1.4 MB · thumbnails go first", or "Nothing to upload". */
export function photosTileSub(b: { uploadsPending: number; uploadBytesPending: number }): string {
  if (!b.uploadsPending) return 'Nothing to upload';
  return `${plural(b.uploadsPending, 'file')} · ${formatBytes(b.uploadBytesPending)} · thumbnails go first`;
}

/** The Edits waiting tile's line: "Oldest Nov 9, 13:40 · sent in order when online", or the board's reassurance. */
export function editsTileSub(oldestAt: string | null, now: Date = new Date()): string {
  return oldestAt ? `Oldest ${stamp(oldestAt, now)} · sent in order when online` : 'Sent in order when online. Nothing is lost.';
}

/** A level row's state: On iPad · Downloading… · Not on iPad · No sheet yet. */
export function levelStateLabel(cache: LevelCache): string {
  switch (cache) {
    case 'cached':
      return 'On iPad';
    case 'downloading':
      return 'Downloading…';
    case 'not cached':
      return 'Not on iPad';
    case 'no sheet':
      return 'No sheet yet';
  }
}

/** A level row's sub-line: "plan 12 MB · photos 2.1 MB", "plan 13 MB, downloading", "assigned to me". */
export function levelBytesLine(l: Pick<CachedLevel, 'cache' | 'planBytes' | 'photoBytes' | 'sheetBytes'>): string {
  const parts: string[] = [];
  if (l.cache === 'cached') parts.push(`plan ${formatBytes(l.planBytes)}`);
  else if (l.cache === 'downloading') parts.push(l.sheetBytes ? `plan ${formatBytes(l.sheetBytes)}, downloading` : 'plan downloading');
  else if (l.cache === 'not cached') parts.push(l.sheetBytes ? `plan ${formatBytes(l.sheetBytes)} to download` : 'plan not downloaded');
  if (l.photoBytes) parts.push(`photos ${formatBytes(l.photoBytes)}`);
  return parts.join(' · ');
}

/** The card's caption: "6 of 9 levels on this iPad · 84 MB" (plans and photos of those levels). */
export function levelsCaption(levels: readonly Pick<CachedLevel, 'cache' | 'planBytes' | 'photoBytes'>[]): string {
  if (!levels.length) return '';
  const on = levels.filter((l) => l.cache === 'cached').length;
  const bytes = levels.reduce((n, l) => n + l.planBytes + l.photoBytes, 0);
  return `${on} of ${plural(levels.length, 'level')} on this iPad · ${formatBytes(bytes)}`;
}

/** The storage bar's shares (0–1 each) and total; shares are 0 when nothing is stored. */
export function storageShares(s: SyncScreenData['storage']): { plans: number; photos: number; other: number; total: number } {
  const total = s.plansBytes + s.photosBytes + s.otherBytes;
  if (!total) return { plans: 0, photos: 0, other: 0, total: 0 };
  return { plans: s.plansBytes / total, photos: s.photosBytes / total, other: s.otherBytes / total, total };
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

/** A user signed in on this iPad against one server (T160; kept in the keychain by `identity/api.ts`). */
export type SignedUser = { serverUrl: string; id: string; name: string; /** Microsoft sign-in's object id (T04). */ oid?: string };

const sameServer = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * T160 (D252): on sign-in as `now`, the earlier ids of the same name on the same server. The
 * server keys interim users by name (`upsert_user`), so a name with a new id means it lost the
 * old `app_user` row; that person's queued edits are re-attributed to the new id (`from`). `seen`
 * is the list to keep: the same-name entries replaced by `now`.
 *
 * T04 (D265, re-reading D252 (5)): a Microsoft sign-in is keyed by its `oid`: two entries that
 * both carry one are the same person exactly when the oids match, whatever the names (a server that
 * lost the row recreates it under the Entra display name). A Microsoft sign-in and a team-picker
 * entry are never matched by name: the merge prompt is where a person says they are that user.
 */
export function carryOver(seen: readonly SignedUser[], now: SignedUser): { from: string[]; seen: SignedUser[] } {
  const samePerson = (u: SignedUser) => (u.oid || now.oid ? u.oid === now.oid : sameName(u.name, now.name));
  const same = (u: SignedUser) => sameServer(u.serverUrl, now.serverUrl) && samePerson(u);
  const from = [...new Set(seen.filter((u) => same(u) && u.id !== now.id).map((u) => u.id))];
  return { from, seen: [...seen.filter((u) => !same(u)), now] };
}

/**
 * T160: what the Sync screen says when the server refused edits because it has no record of their
 * user ("unknown user …", e.g. after a restore from an old backup). Null when no refusal says so.
 */
export function unknownUserNotice(quarantined: readonly QuarantinedEdit[], me: { id: string; name: string }, microsoft = false): string | null {
  const ids = new Set(quarantined.map((q) => unknownUserOf(q.error)).filter((x): x is string => x !== null));
  if (ids.size === 0) return null;
  const n = quarantined.filter((q) => unknownUserOf(q.error) !== null).length;
  const edits = `${n} refused edit${n === 1 ? '' : 's'}`;
  if (ids.has(me.id.toLowerCase())) {
    return (
      `The server has no record of this iPad's user, ${me.name} (as after a restore from an old backup), so it refuses their edits. ` +
      (microsoft
        ? `Sign in with Microsoft again to send the ${edits} as you.`
        : `Re-sign in and pick ${me.name} again: the ${edits} are then sent as ${me.name}.`)
    );
  }
  const who = [...ids].map((id) => `user …${id.slice(-6)}`).join(', ');
  return `The server has no record of the user who made ${edits} (${who}). Re-sign in under that person's name to send them as that person.`;
}
