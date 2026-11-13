import { LIBRARY_STREAM, type SyncStatus } from '@field-survey/core';

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

/**
 * `syncDataKey` for a screen that shows one project (T185, D277): that project's cursor and the
 * app library's (cards, lists and the rules read library types, chips and vocab). A pull for
 * another project — a teammate's seed copy, 1,845 ops on the rig — no longer reloads the plan,
 * the card, Lint and the home of this one. Before the project is known: `syncDataKey`.
 */
export function projectDataKey(s: Pick<SyncStatus, 'lastServerSeq'>, projectId: string | null | undefined): string {
  if (!projectId) return syncDataKey(s);
  return `${projectId}:${s.lastServerSeq[projectId] ?? 0},library:${s.lastServerSeq[LIBRARY_STREAM] ?? 0}`;
}
