import { useEffect, useState } from 'react';

import { rulesVersion, subscribeRules } from './engine';

/**
 * Changes after each engine run that wrote something and after every decision: put it in a
 * reloadKey. With a project, a run that wrote only to another project leaves it alone (T185).
 */
export function useRulesVersion(projectId?: string | null): number {
  const [v, setV] = useState(() => rulesVersion(projectId));
  useEffect(() => {
    setV(rulesVersion(projectId));
    return subscribeRules(() => setV(rulesVersion(projectId)));
  }, [projectId]);
  return v;
}
