import { useEffect, useState } from 'react';

import { rulesVersion, subscribeRules } from './engine';

/** Changes after each engine run that wrote something and after every decision: put it in a reloadKey. */
export function useRulesVersion(): number {
  const [v, setV] = useState(rulesVersion());
  useEffect(() => subscribeRules(() => setV(rulesVersion())), []);
  return v;
}
