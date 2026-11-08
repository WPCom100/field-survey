/**
 * The Microsoft (Entra ID) session behind every server request once this iPad signed in (T04,
 * PLAN §4, D265). Pure: no Expo imports, so it is tested in Node; `microsoft.ts` supplies the
 * token endpoint calls.
 *
 * The access token lives in memory only; the refresh token is in the keychain (`identity/api.ts`)
 * and rotates on every refresh. `token()` is asked before each request (core's `TokenSource`): it
 * returns the cached access token while it has more than five minutes left, else refreshes once
 * (concurrent callers share the refresh). Offline, a refresh fails as `network`, so the iPad reads
 * "Offline" and tries again later; a refresh Microsoft refuses (expired or revoked refresh token,
 * MFA or consent needed) makes the session `needs-sign-in`, and every request then fails as
 * `auth` without touching the network until someone signs in again. Editing never asks for any of
 * this (PLAN §4).
 */

import { TransportError, type TokenSource } from '@field-survey/core';

/** What `GET /auth/config` says about the tenant's "Field Survey" registration (D265). */
export type EntraConfig = { tenant_id: string; client_id: string; scopes: string[] };

/** A token endpoint answer: access token, its expiry (ms since epoch), the rotated refresh token. */
export type Tokens = { accessToken: string; expiresAt: number; refreshToken?: string };

export type SessionState = 'ok' | 'needs-sign-in';

/** Thrown by a refresh that Microsoft refused (OAuth error answer): only a new sign-in helps. */
export class SignInNeeded extends Error {
  constructor(readonly code: string) {
    super(`Microsoft refused the refresh (${code})`);
    this.name = 'SignInNeeded';
  }
}

/**
 * OAuth error codes from the token endpoint that a retry will not fix (RFC 6749 §5.2, OpenID
 * Connect §3.1.2.6). Anything else (`server_error`, `temporarily_unavailable`, no answer) is
 * retried as if offline.
 */
const REFUSED = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
  'interaction_required',
  'login_required',
  'consent_required',
  'account_selection_required',
]);

export const refreshRefused = (code: string | null | undefined): boolean => !!code && REFUSED.has(code);

/** Shown on the Sync screen and in the status line when a sign-in is needed. */
export const SIGN_IN_NEEDED = 'Sign-in needed to sync';

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** A token this young that the server refuses means the server will not take this sign-in at all. */
const FRESH_MS = 2 * 60_000;

export interface EntraSessionOptions {
  refreshToken: string | null;
  /** The access token from the interactive sign-in, if there is one. */
  access?: Tokens | null;
  refresh: (refreshToken: string) => Promise<Tokens>;
  /** Called with each rotated refresh token (the keychain write). */
  save?: (refreshToken: string) => Promise<void>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class EntraTokenSource implements TokenSource {
  private access: { token: string; expiresAt: number } | null = null;
  private obtainedAt = 0;
  private refreshToken: string | null;
  private inflight: Promise<string> | null = null;
  private current: SessionState = 'ok';
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly now: () => number;

  constructor(private readonly opts: EntraSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.refreshToken = opts.refreshToken;
    if (opts.access) this.take(opts.access);
    if (!this.refreshToken && !this.access) this.current = 'needs-sign-in';
  }

  get state(): SessionState {
    return this.current;
  }

  /** The refresh token to keep (it rotates). */
  get refreshTokenValue(): string | null {
    return this.refreshToken;
  }

  /** Where rotated refresh tokens go from now on (set once the sign-in is saved). */
  setSave(save: (refreshToken: string) => Promise<void>): void {
    this.opts.save = save;
  }

  subscribe(listener: (s: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async token(): Promise<string> {
    if (this.current === 'needs-sign-in') throw new TransportError('auth', SIGN_IN_NEEDED);
    if (this.access && this.access.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.access.token;
    if (!this.inflight) {
      this.inflight = this.refreshNow().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  rejected(token: string): void {
    if (!this.access || this.access.token !== token) return;
    const fresh = this.now() - this.obtainedAt < FRESH_MS;
    this.access = null;
    this.opts.log?.('token_rejected', { fresh });
    // An old token may have been revoked early: the next request refreshes. One just obtained
    // and refused means this server does not accept the sign-in (wrong tenant or mode).
    if (fresh) this.setState('needs-sign-in');
  }

  private take(t: Tokens): void {
    this.access = { token: t.accessToken, expiresAt: t.expiresAt };
    this.obtainedAt = this.now();
  }

  private async refreshNow(): Promise<string> {
    const rt = this.refreshToken;
    if (!rt) {
      this.setState('needs-sign-in');
      throw new TransportError('auth', SIGN_IN_NEEDED);
    }
    let t: Tokens;
    try {
      t = await this.opts.refresh(rt);
    } catch (e) {
      if (e instanceof SignInNeeded) {
        this.access = null;
        this.opts.log?.('refresh_refused', { code: e.code });
        this.setState('needs-sign-in');
        throw new TransportError('auth', SIGN_IN_NEEDED);
      }
      this.opts.log?.('refresh_failed', { error: e instanceof Error ? e.message : String(e) });
      throw new TransportError('network', `Could not refresh the Microsoft sign-in: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.take(t);
    this.opts.log?.('refreshed', { expires_in_s: Math.round((t.expiresAt - this.now()) / 1000) });
    if (t.refreshToken && t.refreshToken !== rt) {
      this.refreshToken = t.refreshToken;
      try {
        await this.opts.save?.(t.refreshToken);
      } catch (e) {
        this.opts.log?.('refresh_token_save_failed', { error: String(e) });
      }
    }
    return t.accessToken;
  }

  private setState(s: SessionState): void {
    if (s === this.current) return;
    this.current = s;
    for (const l of this.listeners) l(s);
  }
}

/** The claims of a JWT (unverified: the server verifies; the iPad only reads `oid` and names). */
export function jwtClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    const parsed = JSON.parse(utf8(base64url(part))) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(s: string): number[] {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s.replace(/=+$/, '')) {
    const v = ALPHABET.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) throw new Error('bad base64url');
    buf = ((buf << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function utf8(bytes: number[]): string {
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
}

/** The 409 `merge_pending` body of a first sign-in (T03, D264; `server/docs/auth.md`). */
export type MergePending = { name: string; email: string | null; merge_candidate: { id: string; name: string } };

export function mergePendingOf(detail: unknown): MergePending | null {
  const d = (detail as { detail?: unknown } | null | undefined)?.detail as Record<string, unknown> | undefined;
  if (!d || d.error !== 'merge_pending') return null;
  const c = d.merge_candidate as { id?: unknown; name?: unknown } | undefined;
  if (typeof c?.id !== 'string' || typeof c.name !== 'string') return null;
  return { name: String(d.name ?? ''), email: typeof d.email === 'string' ? d.email : null, merge_candidate: { id: c.id, name: c.name } };
}

/** The confirmation the iPad shows before merging (D264: the person confirms, the server merges). */
export function mergeQuestion(p: MergePending): { title: string; message: string; yes: string; no: string } {
  const who = p.email ? `${p.name} (${p.email})` : p.name;
  const old = p.merge_candidate.name;
  return {
    title: `Are you ${old}?`,
    message:
      `This server has a team-picker user "${old}". If that is you, signing in as ${who} keeps "${old}" ` +
      `as your name and everything "${old}" did stays yours. If not, you start as a new user.`,
    yes: `Yes, I am ${old}`,
    no: 'No, start a new user',
  };
}
