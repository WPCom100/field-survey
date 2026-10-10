import { getRandomValues } from 'expo-crypto';
import { Store, setRandomSource } from '@field-survey/core';

import { ExpoSqliteDriver } from './expo-sqlite-driver';

// UUID v7 needs random bytes; the iPad runtime has no crypto.getRandomValues (D82).
setRandomSource((n) => getRandomValues(new Uint8Array(n)));

let opening: Promise<Store> | null = null;

/**
 * The app's one store: migrated on first use, FTS5 probed (A21), install id kept in
 * `sync_state`. Every screen and the sync engine (T11) share this instance.
 */
export function openAppStore(): Promise<Store> {
  if (!opening) {
    opening = ExpoSqliteDriver.open()
      .then((driver) => Store.open(driver))
      .catch((e) => {
        opening = null; // let the next call retry rather than cache the failure
        throw e;
      });
  }
  return opening;
}
