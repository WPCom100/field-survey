import type { BlobQueueStatus } from '@field-survey/core';
import { useEffect, useState } from 'react';

import { getBlobQueue } from './queue';

const INITIAL: BlobQueueStatus = {
  state: 'no_token',
  photosWaiting: 0,
  uploadsPending: 0,
  uploadBytesPending: 0,
  uploadsFailed: 0,
  downloadsPending: 0,
  cacheBytes: 0,
  lastRunAt: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
};

/** Live upload/download status for the status bar (T18) and the Sync screen (T25). */
export function useBlobStatus(): BlobQueueStatus {
  const [status, setStatus] = useState<BlobQueueStatus>(INITIAL);
  useEffect(() => {
    let off = () => {};
    let active = true;
    getBlobQueue().then((q) => {
      if (!active) return;
      off = q.subscribe(setStatus);
      void q.refresh();
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return status;
}

/** "3 photos waiting", "1 upload failed", or null when there is nothing to say. */
export function describeBlobs(s: BlobQueueStatus): string | null {
  const parts: string[] = [];
  if (s.photosWaiting) parts.push(`${s.photosWaiting} photo${s.photosWaiting === 1 ? '' : 's'} waiting`);
  if (s.uploadsFailed) parts.push(`${s.uploadsFailed} upload${s.uploadsFailed === 1 ? '' : 's'} failed`);
  return parts.length ? parts.join(' · ') : null;
}
