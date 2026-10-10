import { SyncEngine, type SyncLog } from '@field-survey/core';

import { openAppStore } from '../db';

// Until the rotating file logger lands (T25), sync events go to the Metro console under the
// `sync` category the Sync screen will later export.
const log: SyncLog = (level, event, data) => {
  const line = `[sync] ${event}${data ? ' ' + JSON.stringify(data) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

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
