/**
 * The plan's shell (T177): the project name and count pills for its rail and sidebar overlay, and
 * the signed-in person's row, as the Levels home builds them (T176). Reloads when a sync brought
 * data (`reloadKey`) or the rules ran (the Lint pill).
 */

import type { Store } from '@field-survey/core';
import { useEffect, useState } from 'react';

import type { PlanShell } from '../plan/PlanScreen';
import { useRulesVersion } from '../rules/useRulesVersion';
import { homeIdentityLine, installName, loadInstallLabels } from '../sync/install';
import { loadShellNav } from './data';

export function useShell(store: Store | null, levelId: string | undefined, user: { name: string }, reloadKey: unknown): PlanShell {
  const rules = useRulesVersion();
  const [shell, setShell] = useState<PlanShell>({
    projectName: null,
    counts: {},
    user: { name: user.name, sub: '', label: `Signed in as ${user.name}` },
  });
  useEffect(() => {
    if (!store || !levelId) return;
    let live = true;
    (async () => {
      const nav = await loadShellNav(store, levelId);
      const labels = await loadInstallLabels(store);
      if (!live) return;
      setShell({
        projectName: nav?.projectName ?? null,
        counts: { review: nav?.reviewOpen, lint: nav?.lintOpen },
        user: {
          name: user.name,
          sub: `This iPad: ${installName(store.installId, labels)}${labels.has(store.installId) ? '' : ' (name it on the Sync screen)'}`,
          label: homeIdentityLine(user.name, store.installId, labels),
        },
      });
    })().catch((e: unknown) => console.warn('[plan] shell', e));
    return () => {
      live = false;
    };
  }, [store, levelId, user.name, reloadKey, rules]);
  return shell;
}
