import type { SyncStatus } from '@field-survey/core';
import { useEffect, useState } from 'react';

import { getSyncEngine } from './engine';

export { describeSync } from './describe';

const INITIAL: SyncStatus = {
  state: 'no_token',
  pendingOps: 0,
  quarantinedOps: 0,
  willReview: 0,
  lastSyncAt: null,
  lastServerSeq: {},
  lastError: null,
  lastFailure: null,
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
