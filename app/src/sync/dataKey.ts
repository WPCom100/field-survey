import type { SyncStatus } from '@field-survey/core';

/**
 * Changes only when a pull brought new ops (a project's cursor moved), not on every sync cycle.
 * Screens reload on this instead of `lastSyncAt`, so a 5 s sync interval (D130) does not
 * re-query the store every 5 s while nothing changes. Local edits reload through the screen's
 * own path, and their echo moves the cursor once after they are pushed.
 */
export function syncDataKey(s: Pick<SyncStatus, 'lastServerSeq'>): string {
  return Object.keys(s.lastServerSeq)
    .sort()
    .map((p) => `${p}:${s.lastServerSeq[p]}`)
    .join(',');
}
