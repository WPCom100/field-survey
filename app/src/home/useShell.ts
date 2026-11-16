/**
 * The plan's shell (T177): the project name and count pills for its rail and sidebar overlay, and
 * the signed-in person's row, as the Levels home builds them (T176). Reloads when a sync brought
 * data (`reloadKey`) or the rules ran (the Lint pill), this project's only (T186).
 */

import type { Store } from '@field-survey/core';
import { useState } from 'react';

import type { PlanShell } from '../plan/PlanScreen';
import { useRulesVersion } from '../rules/useRulesVersion';
import { useReload } from '../sync/useReload';
import { homeIdentityLine, installName, loadInstallLabels } from '../sync/install';
import { loadShellNav } from './data';

export function useShell(store: Store | null, levelId: string | undefined, projectId: string | null, user: { name: string }, reloadKey: string): PlanShell {
  const rules = useRulesVersion(projectId);
  const [shell, setShell] = useState<PlanShell>({
    projectName: null,
    counts: {},
    user: { name: user.name, sub: '', label: `Signed in as ${user.name}` },
  });
  useReload({
    name: 'shell',
    subject: store && levelId ? `${levelId}|${user.name}` : null,
    reloadKey: `${reloadKey}|${rules}`,
    load: async () => ({ nav: await loadShellNav(store!, levelId!), labels: await loadInstallLabels(store!) }),
    apply: ({ nav, labels }) =>
      setShell({
        projectName: nav?.projectName ?? null,
        counts: { review: nav?.reviewOpen, lint: nav?.lintOpen },
        user: {
          name: user.name,
          sub: `This iPad: ${installName(store!.installId, labels)}${labels.has(store!.installId) ? '' : ' (name it on the Sync screen)'}`,
          label: homeIdentityLine(user.name, store!.installId, labels),
        },
      }),
    fail: (e) => console.warn('[plan] shell', e),
  });
  return shell;
}
