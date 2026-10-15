import { useEffect } from 'react';

import { openAppStore } from '../db';
import { useCurrentUser } from '../identity/IdentityGate';
import { logTo } from '../log';
import { setRulesLog, startRules } from './engine';

setRulesLog((level, event, data) => logTo('rules', level, event, data));

/**
 * Runs the rule engine while the app is open (T33, PLAN §6): once at start for every project
 * on the iPad, then after each committed edit and each pull that brought ops, debounced. The
 * engine's own writes (proposal and finding rows) are ops like any other and sync. Renders
 * nothing; a failure is logged under `rules` and never blocks an edit.
 */
export function RulesRunner() {
  const user = useCurrentUser();

  useEffect(() => {
    let active = true;
    let stop = () => {};
    openAppStore().then(
      (store) => {
        if (!active) return;
        stop = startRules(store, user.id, async () => (await store.list<{ id: string }>('project')).map((p) => p.id));
      },
      (e: unknown) => logTo('rules', 'error', 'store_failed', { error: String(e) }),
    );
    return () => {
      active = false;
      stop();
    };
  }, [user.id]);

  return null;
}
