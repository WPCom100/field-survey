import * as SecureStore from 'expo-secure-store';

// Interim identity (D69): a shared server token plus the name picked on this iPad.
// Both live in expo-secure-store; AUTH_MODE=entra (T04) replaces them with the Entra session.
const USER_KEY = 'survey.user';
const TOKEN_KEY = 'survey.token';
const SERVER_KEY = 'survey.server';

export type TeamMember = { id: string; name: string };
export type Identity = { serverUrl: string; token: string; user?: TeamMember };

export async function loadIdentity(): Promise<Identity | null> {
  const [serverUrl, token, user] = await Promise.all([
    SecureStore.getItemAsync(SERVER_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(USER_KEY),
  ]);
  if (!serverUrl || !token) return null;
  return { serverUrl, token, user: user ? (JSON.parse(user) as TeamMember) : undefined };
}

export async function saveConnection(serverUrl: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_KEY, serverUrl.replace(/\/+$/, ''));
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function saveUser(user: TeamMember): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

/** Headers for every server request; `userName` is stamped by the sync client (T10+). */
export function authHeaders(identity: Identity): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${identity.token}` };
  if (identity.user) h['X-Survey-User'] = identity.user.name;
  return h;
}

export async function fetchTeam(identity: Identity): Promise<TeamMember[]> {
  const r = await fetch(`${identity.serverUrl}/team`, { headers: authHeaders(identity) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Wrong token' : `Server error ${r.status}`);
  return r.json();
}

export async function addTeamMember(identity: Identity, name: string): Promise<TeamMember> {
  const r = await fetch(`${identity.serverUrl}/team`, {
    method: 'POST',
    headers: { ...authHeaders(identity), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`Server error ${r.status}`);
  return r.json();
}

/** Forget the server, token and user on this iPad (local data stays); the connect flow runs again. */
export async function clearIdentity(): Promise<void> {
  await Promise.all([SERVER_KEY, TOKEN_KEY, USER_KEY].map((k) => SecureStore.deleteItemAsync(k)));
}
