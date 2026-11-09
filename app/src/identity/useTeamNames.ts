import type { Store } from '@field-survey/core';
import { useEffect, useMemo, useState } from 'react';

import { fetchTeam, type TeamMember } from './api';
import { useIdentity } from './IdentityGate';

/** Last team list fetched, so names show offline too (client-only `sync_state`, never synced). */
const KEY = 'team_names';

/** The team with the current user always in it (and never retired: they are using the app). */
export function withCurrentUser(team: readonly TeamMember[], me: TeamMember): TeamMember[] {
  return [...team.filter((m) => m.id !== me.id), { id: me.id, name: me.name }];
}

/**
 * Everyone `GET /team` knows, retired people included with `retired: true` (D269), cached in the
 * store so the list is there offline; the current user is always in it.
 */
export function useTeamMembers(store: Store | null): TeamMember[] {
  const identity = useIdentity();
  const [team, setTeam] = useState<TeamMember[]>(() => withCurrentUser([], identity.user));

  useEffect(() => {
    if (!store) return;
    let active = true;
    const merge = (list: TeamMember[]) => {
      if (active) setTeam(withCurrentUser(list, identity.user));
    };
    store.getState<TeamMember[]>(KEY).then((cached) => cached && merge(cached), () => {});
    fetchTeam(identity)
      .then((list) => {
        merge(list);
        return store.setState(KEY, list);
      })
      .catch(() => {}); // offline: the cached list stays
    return () => {
      active = false;
    };
  }, [store, identity]);

  return team;
}

/**
 * User id → name for history lines (T20). `app_user` rows are not on the iPad (T41/T04 may change
 * that), so the list comes from `GET /team`; retired people keep their names here (D269).
 */
export function useTeamNames(store: Store | null): ReadonlyMap<string, string> {
  const team = useTeamMembers(store);
  return useMemo(() => new Map(team.map((m): [string, string] => [m.id, m.name])), [team]);
}
