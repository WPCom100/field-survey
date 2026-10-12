import { BlobQueue, type BlobLog } from '@field-survey/core';

import { openAppStore } from '../db';
import { logTo } from '../log';
import { ExpoBlobFiles } from './expo-files';

const log: BlobLog = (level, event, data) => logTo('sync', level, 'blobs.' + event, data);

let files: ExpoBlobFiles | null = null;
let queue: Promise<BlobQueue> | null = null;
let userId: string | null = null;

/** The sandbox the queue and capture code (T21) write into. */
export function getBlobFiles(): ExpoBlobFiles {
  if (!files) files = new ExpoBlobFiles();
  return files;
}

/** Whose assigned levels to prefetch; set by the `SyncRunner` from the identity. */
export function setBlobUser(id: string | null): void {
  userId = id;
}

/**
 * The app's one blob queue over the app's one store. Created without a transport; the
 * `SyncRunner` attaches one once the identity is known and starts it.
 */
export function getBlobQueue(): Promise<BlobQueue> {
  if (!queue) {
    queue = openAppStore().then(
      (store) => new BlobQueue(store, null, getBlobFiles(), { userId: () => userId, log }),
    );
  }
  return queue;
}
