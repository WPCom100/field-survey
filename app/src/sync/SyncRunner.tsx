import { HttpTransport } from '@field-survey/core';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { ExpoBlobTransport } from '../blobs/expo-blob-transport';
import { getBlobFiles, getBlobQueue, setBlobUser } from '../blobs/queue';
import { useIdentity } from '../identity/IdentityGate';
import { syncDataKey } from './dataKey';
import { getSyncEngine } from './engine';

/**
 * Runs the sync engine and the blob queue while the app is open: a pass at start, one on every
 * return to the foreground, and every 5 s in between (T11, T12, D130). A sync that brings new
 * ops also nudges the blob queue, so new photos' thumbnails prefetch without waiting a minute.
 * Renders nothing. Being offline is just a failed pass with backoff; editing never waits.
 */
export function SyncRunner() {
  const identity = useIdentity();

  useEffect(() => {
    let active = true;
    const connection = {
      serverUrl: identity.serverUrl,
      token: identity.token,
      userName: identity.user.name,
    };
    setBlobUser(identity.user.id);
    let stop = () => {};
    Promise.all([getSyncEngine(), getBlobQueue()]).then(([engine, blobs]) => {
      if (!active) return;
      engine.setTransport(new HttpTransport(connection));
      blobs.setTransport(new ExpoBlobTransport(connection, getBlobFiles()));
      engine.start();
      blobs.start();
      // Nudge the blob queue only when a pull brought new ops (new photos to prefetch), not on
      // every 5 s cycle (D130); its own 60 s timer and capture kicks cover the rest.
      let lastData: string | null = null;
      const offSync = engine.subscribe((s) => {
        const key = syncDataKey(s);
        if (s.lastSyncAt && key !== lastData) {
          lastData = key;
          blobs.kick();
        }
      });
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void engine.requestSync();
          void blobs.requestRun();
        }
      });
      stop = () => {
        sub.remove();
        offSync();
        engine.stop();
        blobs.stop();
      };
    });
    return () => {
      active = false;
      stop();
    };
  }, [identity.serverUrl, identity.token, identity.user.name, identity.user.id]);

  return null;
}
