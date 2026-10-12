import { SyncEngine, type SyncLog } from '@field-survey/core';

import { openAppStore } from '../db';
import { logTo } from '../log';

const log: SyncLog = (level, event, data) => logTo('sync', level, event, data);

let engine: Promise<SyncEngine> | null = null;

/**
 * The app's one sync engine over the app's one store. Created without a transport; the
 * `SyncRunner` attaches one once the identity (server, token, user) is known and starts it.
 */
export function getSyncEngine(): Promise<SyncEngine> {
  if (!engine) {
    engine = openAppStore().then((store) => new SyncEngine(store, null, { log }));
  }
  return engine;
}
