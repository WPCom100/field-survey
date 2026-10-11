import type { Store } from '@field-survey/core';
import { useEffect, useState } from 'react';

import { fetchTeam, type TeamMember } from './api';
import { useIdentity } from './IdentityGate';

/** Last team list fetched, so names show offline too (client-only `sync_state`, never synced). */
const KEY = 'team_names';

/**
 * User id → name for history lines (T20). `app_user` rows are not on the iPad (T41/T04 may change
 * that), so the list comes from `GET /team`, cached in the store; the current user is always known.
 */
export function useTeamNames(store: Store | null): ReadonlyMap<string, string> {
  const identity = useIdentity();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map([[identity.user.id, identity.user.name]]));

  useEffect(() => {
    if (!store) return;
    let active = true;
    const merge = (team: TeamMember[]) => {
      if (active) setNames(new Map([...team.map((m): [string, string] => [m.id, m.name]), [identity.user.id, identity.user.name]]));
    };
    store.getState<TeamMember[]>(KEY).then((cached) => cached && merge(cached), () => {});
    fetchTeam(identity)
      .then((team) => {
        merge(team);
        return store.setState(KEY, team);
      })
      .catch(() => {}); // offline: the cached names stay
    return () => {
      active = false;
    };
  }, [store, identity]);

  return names;
}
