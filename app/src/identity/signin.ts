/**
 * "Sign in with Microsoft" end to end (T04, D264, D265): the server's registration, the
 * interactive sign-in, then `GET /me`. A first sign-in with a team-picker user to merge answers
 * 409 `merge_pending`; the person is asked (`confirmMerge`) and `POST /me/merge` adopts that user
 * (same id and name, so every edit keeps its author) or starts a new one. Only then is anything
 * saved, so a sign-in abandoned half-way leaves the iPad as it was.
 */

import { HttpClient, errorCode, type TransportError } from '@field-survey/core';

import { microsoftAccount, saveMicrosoft, type Identity, type TeamMember } from './api';
import { fetchAuthConfig, microsoftSignIn } from './microsoft';
import { jwtClaims, mergePendingOf, type MergePending } from './session';

type Me = { id: string; name: string; email: string | null };

export async function signInWithMicrosoft(
  serverUrl: string,
  opts: { interimName?: string; confirmMerge: (p: MergePending) => Promise<boolean> },
): Promise<Identity> {
  const base = serverUrl.replace(/\/+$/, '');
  const cfg = await fetchAuthConfig(base);
  if (!cfg.entra) throw new Error('This server does not offer Microsoft sign-in.');
  const tokens = await microsoftSignIn(cfg.entra);
  const claims = jwtClaims(tokens.accessToken);
  const account = microsoftAccount(
    { config: cfg.entra, oid: typeof claims.oid === 'string' ? claims.oid : null, email: null },
    tokens.refreshToken ?? null,
    tokens,
    false, // nothing reaches the keychain until the sign-in is finished
  );
  // The name this iPad used with the team picker tells the server which interim user to offer.
  const http = new HttpClient({ serverUrl: base, token: '', tokenSource: account.session, userName: opts.interimName });
  let me: Me;
  try {
    me = await http.json<Me>('GET', '/me');
  } catch (e) {
    const pending = errorCode(e) === 'merge_pending' ? mergePendingOf((e as TransportError).detail) : null;
    if (!pending) throw e;
    const yes = await opts.confirmMerge(pending);
    me = await http.json<Me>('POST', '/me/merge', { user_id: yes ? pending.merge_candidate.id : null });
  }
  const user: TeamMember = { id: me.id, name: me.name };
  const done = { ...account, email: me.email };
  await saveMicrosoft(base, done, user);
  return { serverUrl: base, token: '', user, microsoft: done };
}
