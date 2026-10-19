import type { SyncStatus } from '@field-survey/core';
import { useEffect, useState } from 'react';

import { getSyncEngine } from './engine';

const INITIAL: SyncStatus = {
  state: 'no_token',
  pendingOps: 0,
  quarantinedOps: 0,
  willReview: 0,
  lastSyncAt: null,
  lastServerSeq: {},
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  lastCycle: null,
};

/** Live sync status for the global status bar (T18) and the Sync screen (T25). */
export function useSyncStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(INITIAL);
  useEffect(() => {
    let off = () => {};
    let active = true;
    getSyncEngine().then((engine) => {
      if (active) off = engine.subscribe(setStatus);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return status;
}

/** One line for the status bar: "Synced 09:41 · 3 pending" and the like. */
export function describeSync(s: SyncStatus): string {
  const pending = s.pendingOps ? ` · ${s.pendingOps} pending` : '';
  const held = s.quarantinedOps ? ` · ${s.quarantinedOps} need attention` : '';
  const review = s.willReview ? ` · ${s.willReview} will be reviewed` : '';
  switch (s.state) {
    case 'syncing':
      return `Syncing…${pending}`;
    case 'offline':
      return `Offline${pending}${held}${review}`;
    case 'error':
      return `Sync error: ${s.lastError ?? 'unknown'}${pending}${held}`;
    case 'no_token':
      return `Not connected${pending}`;
    case 'idle':
      return (s.lastSyncAt ? `Synced ${new Date(s.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet') + pending + held + review;
  }
}
