/**
 * The status bar's copy and tone (T18; the board's wording since T176, D266 (2)): "Synced 14:05",
 * "Offline · 3 edits waiting · 1 photo waiting · Last synced 13:40", "Syncing…", "Sign-in needed
 * to sync". The plan header, the Sync screen and Export read the same line. Pure: no React, no
 * Expo, so it is tested in Node.
 */

import type { BlobQueueStatus, SyncStatus } from '@field-survey/core';

/** "14:05": the local time, 24-hour, as the board writes it. */
export function clock(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 photos waiting", "1 upload failed", or null when there is nothing to say. */
export function describeBlobs(s: Pick<BlobQueueStatus, 'photosWaiting' | 'uploadsFailed'>): string | null {
  const parts: string[] = [];
  if (s.photosWaiting) parts.push(`${plural(s.photosWaiting, 'photo', 'photos')} waiting`);
  if (s.uploadsFailed) parts.push(`${plural(s.uploadsFailed, 'upload', 'uploads')} failed`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * One line for the status bar. `photos` is `describeBlobs(…)` (it goes before "Last synced").
 * The state comes first; then edits waiting, refused edits, edits that will be reviewed, photos;
 * "Last synced" only when the iPad cannot sync now (offline or an error).
 */
export function describeSync(s: SyncStatus, photos: string | null = null): string {
  let head: string;
  let last = false;
  switch (s.state) {
    case 'syncing':
      head = 'Syncing…';
      break;
    case 'offline':
      head = 'Offline';
      last = true;
      break;
    case 'error':
      // 401, or a Microsoft refresh that was refused (T04): only signing in again helps.
      head = s.lastFailure === 'auth' ? 'Sign-in needed to sync' : `Sync error: ${s.lastError ?? 'unknown'}`;
      last = true;
      break;
    case 'no_token':
      head = 'Not connected';
      break;
    case 'idle':
      head = s.lastSyncAt ? `Synced ${clock(s.lastSyncAt)}` : 'Not synced yet';
      break;
  }
  const parts = [head];
  if (s.pendingOps) parts.push(`${plural(s.pendingOps, 'edit', 'edits')} waiting`);
  if (s.quarantinedOps) parts.push(`${s.quarantinedOps} need attention`);
  if (s.willReview) parts.push(`${s.willReview} will be reviewed`);
  if (photos) parts.push(photos);
  if (last && s.lastSyncAt) parts.push(`Last synced ${clock(s.lastSyncAt)}`);
  return parts.join(' · ');
}

/**
 * How the strip is tinted: `ok` (white, a green check), `busy` (syncing), `warn` (offline, edits or
 * photos waiting, sign-in needed, not connected: the warning tint), `error` (a sync error other
 * than sign-in, or uploads that failed: the danger tint).
 */
export type StatusTone = 'ok' | 'busy' | 'warn' | 'error';

export function statusTone(s: SyncStatus, blobs: Pick<BlobQueueStatus, 'photosWaiting' | 'uploadsFailed'> | null = null): StatusTone {
  if ((s.state === 'error' && s.lastFailure !== 'auth') || blobs?.uploadsFailed) return 'error';
  if (s.state === 'offline' || s.state === 'error' || s.state === 'no_token') return 'warn';
  if (s.quarantinedOps) return 'error';
  if (s.state === 'syncing') return 'busy';
  if (s.pendingOps || blobs?.photosWaiting) return 'warn';
  return 'ok';
}
