/**
 * The shell's data (T177, T189): the project name and count pills for the rail and its sidebar
 * overlay, and the signed-in person's row, as the Levels home builds them (T176). The plan and
 * every section screen read it for their project. Reloads when a sync brought data (`reloadKey`)
 * or the rules ran (the Lint pill), this project's only (T186). With no project (Sync on a fresh
 * iPad) only the person's row loads.
 */

import type { Store } from '@field-survey/core';
import { useState } from 'react';

import type { ShellNav } from '../ui';
import { useRulesVersion } from '../rules/useRulesVersion';
import { useReload } from '../sync/useReload';
import { homeIdentityLine, installName, loadInstallLabels } from '../sync/install';
import { loadProjectShellNav } from './data';

export type ShellData = Omit<ShellNav, 'projectId'>;

export function useShell(store: Store | null, projectId: string | null, user: { name: string }, reloadKey: string): ShellData {
  const rules = useRulesVersion(projectId);
  const [shell, setShell] = useState<ShellData>({
    projectName: null,
    counts: {},
    user: { name: user.name, sub: '', label: `Signed in as ${user.name}` },
  });
  useReload({
    name: 'shell',
    subject: store ? `${projectId ?? ''}|${user.name}` : null,
    reloadKey: `${reloadKey}|${rules}`,
    load: async () => ({ nav: projectId ? await loadProjectShellNav(store!, projectId) : null, labels: await loadInstallLabels(store!) }),
    apply: ({ nav, labels }) =>
      setShell({
        projectName: nav?.projectName ?? null,
        counts: { review: nav?.reviewOpen, lint: nav?.lintOpen },
        user: {
          name: user.name,
          sub: `This iPad: ${installName(store!.installId, labels)}`,
          label: homeIdentityLine(user.name, store!.installId, labels),
        },
      }),
    fail: (e) => console.warn('[shell] load', e),
  });
  return shell;
}
