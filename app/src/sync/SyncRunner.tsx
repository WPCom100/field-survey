import { HttpTransport } from '@field-survey/core';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useIdentity } from '../identity/IdentityGate';
import { getSyncEngine } from './engine';

/**
 * Runs the sync engine while the app is open: a cycle at start, one on every return to the
 * foreground, and one every 60 s in between (T11 DoD). Renders nothing. Being offline is just a
 * failed cycle with backoff; editing never waits for any of this.
 */
export function SyncRunner() {
  const identity = useIdentity();

  useEffect(() => {
    let active = true;
    const transport = new HttpTransport({
      serverUrl: identity.serverUrl,
      token: identity.token,
      userName: identity.user.name,
    });
    let stop = () => {};
    getSyncEngine().then((engine) => {
      if (!active) return;
      engine.setTransport(transport);
      engine.start();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void engine.requestSync();
      });
      stop = () => {
        sub.remove();
        engine.stop();
      };
    });
    return () => {
      active = false;
      stop();
    };
  }, [identity.serverUrl, identity.token, identity.user.name]);

  return null;
}
