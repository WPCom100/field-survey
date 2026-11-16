import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { logTo } from '../log';
import { Reloader } from './reload';

/** A load slower than this is logged (`[store] slow_load`), the trail T185 needed. */
const SLOW_MS = 1500;

/**
 * Load a screen's data and reload it when `reloadKey` changes, through a `Reloader` (T185,
 * D277): a reload asked for during a load never discards it — the running load applies, then one
 * more runs. `subject` names what is shown (project, device, filter); when it changes, a load of
 * the old one is dropped. `null` loads nothing (store not open yet).
 *
 * A screen that is not focused (under another one on the stack) does not reload; it reloads once
 * when it comes back. Every Lint, card or Dashboard left on the stack used to rerun its whole
 * load on every pull, all through the store's one queue — four Lint copies made each load 10 s.
 */
export function useReload<T>(opts: {
  /** For the slow-load log line. */
  name: string;
  subject: string | null;
  reloadKey: unknown;
  load: () => Promise<T>;
  apply: (value: T) => void;
  fail: (e: unknown) => void;
}): void {
  const latest = useRef(opts);
  latest.current = opts;
  const [reloader] = useState(
    () =>
      new Reloader<T>(
        (v) => latest.current.apply(v),
        (e) => latest.current.fail(e),
        (ms) => {
          if (ms >= SLOW_MS) logTo('store', 'info', 'slow_load', { screen: latest.current.name, ms });
        },
      ),
  );
  const focused = useIsFocused();
  /** The key last loaded for: a key change while blurred waits for the focus. */
  const loaded = useRef<{ subject: string | null; key: unknown } | null>(null);
  const { subject, reloadKey } = opts;

  // a new subject (or unmount) drops what the old one was loading; declared first, so on a
  // subject change it runs before the request below
  useEffect(() => {
    reloader.reset();
    loaded.current = null;
    return () => reloader.reset();
  }, [reloader, subject]);

  useEffect(() => {
    if (subject === null) return;
    const seen = loaded.current;
    if (seen && seen.subject === subject && Object.is(seen.key, reloadKey)) return;
    // the first load of a subject runs even blurred (a screen pushed and covered at once);
    // later reloads wait for the focus
    if (seen && !focused) return;
    loaded.current = { subject, key: reloadKey };
    reloader.request(() => latest.current.load());
  }, [reloader, subject, reloadKey, focused]);
}

/**
 * A `reloadKey` for values compared by identity (a Map of names, a loaded plan, a jobs list): a
 * new object whenever one of them changes, the same one otherwise (T186). The number of values
 * must not change between renders.
 */
export function useIdentityKey(...values: unknown[]): object {
  return useMemo(() => ({}), values);
}
