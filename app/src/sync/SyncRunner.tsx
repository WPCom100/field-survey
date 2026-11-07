import { HttpTransport } from '@field-survey/core';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { ExpoBlobTransport } from '../blobs/expo-blob-transport';
import { getBlobFiles, getBlobQueue, setBlobUser } from '../blobs/queue';
import { loadSignedUsers, saveSignedUsers } from '../identity/api';
import { useIdentity } from '../identity/IdentityGate';
import { logTo } from '../log';
import { syncDataKey } from './dataKey';
import { getSyncEngine } from './engine';
import { carryOver, type SignedUser } from './screen';

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
    Promise.all([getSyncEngine(), getBlobQueue()]).then(async ([engine, blobs]) => {
      if (!active) return;
      engine.setTransport(new HttpTransport(connection));
      await carryQueuedEdits(engine, { serverUrl: identity.serverUrl, id: identity.user.id, name: identity.user.name });
      if (!active) return;
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

/**
 * T160 (D252): a sign-in under a name this iPad saw on this server with another id means the
 * server lost that `app_user` row; the name's queued edits are stamped with the new id and sent.
 * Never blocks sync: a failure is logged and the edits stay refused on the Sync screen.
 */
async function carryQueuedEdits(engine: Awaited<ReturnType<typeof getSyncEngine>>, now: SignedUser): Promise<void> {
  try {
    const { from, seen } = carryOver(await loadSignedUsers(), now);
    for (const id of from) {
      await engine.reattribute(id, now.id); // logs `reattributed` with the count
    }
    await saveSignedUsers(seen);
  } catch (e) {
    logTo('sync', 'error', 'reattribute_failed', { error: String(e) });
  }
}
