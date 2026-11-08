/**
 * Microsoft sign-in on the iPad (T04, PLAN §4, D265): authorization code + PKCE with
 * `expo-auth-session` against the tenant's v2.0 endpoints, redirect `fieldsurvey://auth`. The
 * registration (tenant, client id, scopes) comes from the server's public `GET /auth/config`, so
 * changing it needs no new build. The pure session logic is in `session.ts`.
 */

import * as AuthSession from 'expo-auth-session';

import { SignInNeeded, refreshRefused, type EntraConfig, type Tokens } from './session';

/** Registered as a "Mobile and desktop applications" redirect URI on the registration (docs/ops.md §4.3). */
export const REDIRECT_URI = 'fieldsurvey://auth';

export type AuthConfig = { mode: string; entra: EntraConfig | null };

/** `GET /auth/config` (public). Throws with a readable message when the server cannot say. */
export async function fetchAuthConfig(serverUrl: string, timeoutMs = 10_000): Promise<AuthConfig> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${serverUrl.replace(/\/+$/, '')}/auth/config`, { signal: ctl.signal });
    if (r.status === 404) return { mode: 'token', entra: null }; // a server from before T04
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    return (await r.json()) as AuthConfig;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Server error')) throw e;
    throw new Error('Cannot reach the server');
  } finally {
    clearTimeout(timer);
  }
}

function discovery(cfg: EntraConfig): AuthSession.DiscoveryDocument {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant_id)}/oauth2/v2.0`;
  return { authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token` };
}

function tokensOf(r: AuthSession.TokenResponse): Tokens {
  const issued = (r.issuedAt ?? Math.floor(Date.now() / 1000)) * 1000;
  return { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: issued + (r.expiresIn ?? 3600) * 1000 };
}

/** Thrown when the person closed the Microsoft sheet: nothing changes, nothing is said. */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelled';
  }
}

/**
 * The interactive sign-in: Microsoft's page in an in-app browser sheet (ephemeral, so the next
 * person on a shared iPad is never signed in by a leftover cookie), then the code exchange.
 */
export async function microsoftSignIn(cfg: EntraConfig): Promise<Tokens> {
  const d = discovery(cfg);
  const request = new AuthSession.AuthRequest({
    clientId: cfg.client_id,
    redirectUri: REDIRECT_URI,
    scopes: cfg.scopes,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    prompt: AuthSession.Prompt.SelectAccount,
  });
  const result = await request.promptAsync(d, { preferEphemeralSession: true });
  if (result.type === 'cancel' || result.type === 'dismiss') throw new SignInCancelled();
  if (result.type !== 'success') {
    const why = result.type === 'error' ? (result.params.error_description ?? result.error?.message ?? result.params.error) : result.type;
    throw new Error(`Microsoft sign-in failed: ${why ?? 'unknown error'}`);
  }
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: cfg.client_id,
      code: result.params.code ?? '',
      redirectUri: REDIRECT_URI,
      scopes: cfg.scopes,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
    },
    d,
  );
  if (!tokens.refreshToken) throw new Error('Microsoft gave no refresh token (is offline_access granted?)');
  return tokensOf(tokens);
}

/** One silent refresh. A refusal (expired, revoked, MFA needed) is `SignInNeeded`; anything else is retried later. */
export async function refreshTokens(cfg: EntraConfig, refreshToken: string): Promise<Tokens> {
  try {
    return tokensOf(await AuthSession.refreshAsync({ clientId: cfg.client_id, refreshToken, scopes: cfg.scopes }, discovery(cfg)));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && refreshRefused(code)) throw new SignInNeeded(code);
    throw e;
  }
}
