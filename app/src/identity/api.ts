import { HttpClient } from '@field-survey/core';
import * as SecureStore from 'expo-secure-store';

import { logTo } from '../log';
import type { SignedUser } from '../sync/screen';
import { httpOptions } from './http';
import { refreshTokens } from './microsoft';
import { EntraTokenSource, type EntraConfig, type Tokens } from './session';

// Who this iPad is, in expo-secure-store. Interim identity (D69): a shared server token plus the
// name picked on this iPad. Microsoft sign-in (T04, D265): the registration it signed in against
// and the refresh token (the access token stays in memory, `session.ts`); no shared token then.
const USER_KEY = 'survey.user';
const TOKEN_KEY = 'survey.token';
const SERVER_KEY = 'survey.server';
const ENTRA_KEY = 'survey.entra';
const REFRESH_KEY = 'survey.entraRefresh';

/** A person from `GET /team`; `retired` (D269) keeps the name on history but off the picker and Assignments. */
export type TeamMember = { id: string; name: string; retired?: boolean };

/** A Microsoft sign-in on this iPad: the registration, who it is, and the live session. */
export type MicrosoftAccount = { config: EntraConfig; oid: string | null; email: string | null; session: EntraTokenSource };

export type Identity = {
  serverUrl: string;
  /** The shared token (interim, D69); empty once signed in with Microsoft. */
  token: string;
  user?: TeamMember;
  microsoft?: MicrosoftAccount;
};

type SavedAccount = { config: EntraConfig; oid: string | null; email: string | null };

/** The session object for a saved or fresh Microsoft sign-in; rotated refresh tokens go to the keychain. */
export function microsoftAccount(saved: SavedAccount, refreshToken: string | null, access?: Tokens, persist = true): MicrosoftAccount {
  const session = new EntraTokenSource({
    refreshToken,
    access,
    refresh: (rt) => refreshTokens(saved.config, rt),
    save: persist ? saveRefreshToken : undefined,
    log: (event, data) => logTo('sync', event.endsWith('failed') || event === 'refresh_refused' ? 'warn' : 'info', `auth_${event}`, data),
  });
  return { ...saved, session };
}

const saveRefreshToken = (rt: string) => SecureStore.setItemAsync(REFRESH_KEY, rt);

export async function loadIdentity(): Promise<Identity | null> {
  const [serverUrl, token, user, entra, refresh] = await Promise.all(
    [SERVER_KEY, TOKEN_KEY, USER_KEY, ENTRA_KEY, REFRESH_KEY].map((k) => SecureStore.getItemAsync(k)),
  );
  if (!serverUrl) return null;
  const member = user ? (JSON.parse(user) as TeamMember) : undefined;
  if (entra && member) {
    // A refresh token missing from the keychain leaves the session needing a sign-in; edits go on.
    return { serverUrl, token: '', user: member, microsoft: microsoftAccount(JSON.parse(entra) as SavedAccount, refresh) };
  }
  if (!token) return null;
  return { serverUrl, token, user: member };
}

export async function saveConnection(serverUrl: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, serverUrl.replace(/\/+$/, ''));
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function saveUser(user: TeamMember): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

/** A finished Microsoft sign-in replaces the shared token; rotated refresh tokens are kept from now on. */
export async function saveMicrosoft(serverUrl: string, account: MicrosoftAccount, user: TeamMember): Promise<void> {
  const saved: SavedAccount = { config: account.config, oid: account.oid, email: account.email };
  await SecureStore.setItemAsync(SERVER_KEY, serverUrl.replace(/\/+$/, ''));
  await SecureStore.setItemAsync(ENTRA_KEY, JSON.stringify(saved));
  const rt = account.session.refreshTokenValue;
  if (rt) await saveRefreshToken(rt);
  await saveUser(user);
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  account.session.setSave(saveRefreshToken);
}

/** Headers for one server request (refreshes the Microsoft token first when it is close to expiry). */
export function authHeaders(identity: Identity): Promise<Record<string, string>> {
  return new HttpClient(httpOptions(identity)).headers();
}

export async function fetchTeam(identity: Identity): Promise<TeamMember[]> {
  const r = await fetch(`${identity.serverUrl}/team`, { headers: await authHeaders(identity) });
  if (!r.ok) throw new Error(r.status === 401 ? (identity.microsoft ? 'Sign-in needed' : 'Wrong token') : `Server error ${r.status}`);
  return r.json();
}

export async function addTeamMember(identity: Identity, name: string): Promise<TeamMember> {
  const r = await fetch(`${identity.serverUrl}/team`, {
    method: 'POST',
    headers: { ...(await authHeaders(identity)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json();
}

/** Forget the server, token or Microsoft sign-in, and user on this iPad (local data stays); the connect flow runs again. */
export async function clearIdentity(): Promise<void> {
  await Promise.all([SERVER_KEY, TOKEN_KEY, USER_KEY, ENTRA_KEY, REFRESH_KEY].map((k) => SecureStore.deleteItemAsync(k)));
}

// T160: the users signed in on this iPad, per server, so a sign-in under a name the server now
// gives a new id can carry that name's queued edits over (`carryOver` in `sync/screen.ts`).
const SIGNED_USERS_KEY = 'survey.signedUsers';

export async function loadSignedUsers(): Promise<SignedUser[]> {
  const raw = await SecureStore.getItemAsync(SIGNED_USERS_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as SignedUser[]) : [];
  } catch {
    return [];
  }
}

export async function saveSignedUsers(list: SignedUser[]): Promise<void> {
  await SecureStore.setItemAsync(SIGNED_USERS_KEY, JSON.stringify(list));
}
