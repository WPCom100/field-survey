import { TransportError } from '@field-survey/core';
import { describe, expect, it } from 'vitest';

import { EntraTokenSource, REFRESH_MARGIN_MS, SIGN_IN_NEEDED, SignInNeeded, jwtClaims, mergePendingOf, mergeQuestion, refreshRefused, type Tokens } from './session';

const HOUR = 3_600_000;

function rig(opts: { refreshToken?: string | null; access?: Tokens | null } = {}) {
  let clock = 1_800_000_000_000;
  const refreshes: string[] = [];
  const saved: string[] = [];
  const answers: Array<(rt: string) => Promise<Tokens>> = [];
  let n = 0;
  const source = new EntraTokenSource({
    refreshToken: opts.refreshToken === undefined ? 'rt-0' : opts.refreshToken,
    access: opts.access,
    now: () => clock,
    refresh: (rt) => {
      refreshes.push(rt);
      const next = answers.shift();
      if (next) return next(rt);
      n += 1;
      return Promise.resolve({ accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: clock + HOUR });
    },
    save: async (rt) => {
      saved.push(rt);
    },
  });
  return {
    source,
    refreshes,
    saved,
    answers,
    tick: (ms: number) => {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as TransportError;
  }
  throw new Error('expected a failure');
};

describe('EntraTokenSource (T04)', () => {
  it('keeps the sign-in access token until five minutes before it expires, then refreshes and keeps the rotated refresh token', async () => {
    const r = rig({ access: { accessToken: 'first', refreshToken: 'rt-0', expiresAt: 1_800_000_000_000 + HOUR } });
    expect(await r.source.token()).toBe('first');
    r.tick(HOUR - REFRESH_MARGIN_MS - 1000);
    expect(await r.source.token()).toBe('first');
    expect(r.refreshes).toEqual([]);
    r.tick(2000); // inside the margin
    expect(await r.source.token()).toBe('at-1');
    expect(r.refreshes).toEqual(['rt-0']);
    expect(r.saved).toEqual(['rt-1']);
    expect(r.source.refreshTokenValue).toBe('rt-1');
    expect(await r.source.token()).toBe('at-1'); // cached again
    expect(r.refreshes).toHaveLength(1);
  });

  it('a saved session (refresh token only) refreshes on its first request, and concurrent requests share one refresh', async () => {
    const r = rig();
    let release!: () => void;
    r.answers.push((rt) => new Promise((res) => (release = () => res({ accessToken: 'shared', refreshToken: rt, expiresAt: r.now + HOUR }))));
    const all = Promise.all([r.source.token(), r.source.token(), r.source.token()]);
    release();
    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(r.refreshes).toEqual(['rt-0']);
    expect(r.saved).toEqual([]); // the same refresh token came back: nothing to write
  });

  it('offline: a refresh that cannot reach Microsoft is a network failure and the session stays usable', async () => {
    const r = rig();
    r.answers.push(() => Promise.reject(new TypeError('Network request failed')));
    const e = await failure(r.source.token());
    expect(e).toBeInstanceOf(TransportError);
    expect(e.failure).toBe('network');
    expect(r.source.state).toBe('ok');
    expect(await r.source.token()).toBe('at-1'); // back online: the silent refresh succeeds
  });

  it('a refused refresh needs a sign-in: every later request fails as auth without calling Microsoft', async () => {
    const r = rig();
    const states: string[] = [];
    r.source.subscribe((s) => states.push(s));
    r.answers.push(() => Promise.reject(new SignInNeeded('invalid_grant')));
    const e = await failure(r.source.token());
    expect(e.failure).toBe('auth');
    expect(e.message).toBe(SIGN_IN_NEEDED);
    expect(r.source.state).toBe('needs-sign-in');
    expect(states).toEqual(['needs-sign-in']);
    expect((await failure(r.source.token())).failure).toBe('auth');
    expect(r.refreshes).toHaveLength(1);
  });

  it('no refresh token at all: needs a sign-in from the start', async () => {
    const r = rig({ refreshToken: null });
    expect(r.source.state).toBe('needs-sign-in');
    expect((await failure(r.source.token())).failure).toBe('auth');
    expect(r.refreshes).toEqual([]);
  });

  it('a 401 to an older token refreshes on the next request; a 401 to a token just obtained needs a sign-in', async () => {
    const r = rig();
    expect(await r.source.token()).toBe('at-1');
    r.tick(10 * 60_000);
    r.source.rejected('someone-else'); // not ours: ignored
    expect(await r.source.token()).toBe('at-1');
    r.source.rejected('at-1');
    expect(await r.source.token()).toBe('at-2');
    expect(r.source.state).toBe('ok');
    r.source.rejected('at-2'); // refused straight after the refresh: the server will not take it
    expect(r.source.state).toBe('needs-sign-in');
    expect((await failure(r.source.token())).failure).toBe('auth');
  });

  it('a rotated refresh token is only written once a save is set (after the sign-in is finished)', async () => {
    const saved: string[] = [];
    let clock = 0;
    let n = 0;
    const s = new EntraTokenSource({
      refreshToken: 'rt-a',
      now: () => clock,
      refresh: async () => {
        n += 1;
        return { accessToken: `x${n}`, refreshToken: `rt-${n}`, expiresAt: clock + HOUR };
      },
    });
    await s.token(); // during the sign-in: nothing reaches the keychain
    expect(s.refreshTokenValue).toBe('rt-1');
    s.setSave(async (rt) => {
      saved.push(rt);
    });
    clock += HOUR; // expired: the next request refreshes and the rotation is written
    expect(await s.token()).toBe('x2');
    expect(saved).toEqual(['rt-2']);
  });
});

describe('refreshRefused', () => {
  it('only OAuth refusals need a sign-in; server trouble is retried', () => {
    expect(refreshRefused('invalid_grant')).toBe(true);
    expect(refreshRefused('interaction_required')).toBe(true);
    expect(refreshRefused('temporarily_unavailable')).toBe(false);
    expect(refreshRefused('server_error')).toBe(false);
    expect(refreshRefused(undefined)).toBe(false);
  });
});

describe('jwtClaims', () => {
  const enc = (o: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  it('reads the payload of a token (unicode names too) and never throws', () => {
    const jwt = `${enc({ alg: 'RS256' })}.${enc({ oid: 'aaaa-1', name: 'Zoë Ångström' })}.sig`;
    expect(jwtClaims(jwt)).toEqual({ oid: 'aaaa-1', name: 'Zoë Ångström' });
    expect(jwtClaims('garbage')).toEqual({});
    expect(jwtClaims('a.%%%.c')).toEqual({});
    expect(jwtClaims(`a.${enc([1, 2])}.c`)).toEqual({});
  });
});

describe('the merge prompt (D264)', () => {
  const body = {
    detail: { error: 'merge_pending', name: 'Landry Smith', email: 'landry@ltp.example', merge_candidate: { id: '0190-x', name: 'Landry' } },
  };

  it('reads the 409 merge_pending body, and nothing else', () => {
    expect(mergePendingOf(body)).toEqual({ name: 'Landry Smith', email: 'landry@ltp.example', merge_candidate: { id: '0190-x', name: 'Landry' } });
    expect(mergePendingOf({ detail: { error: 'already_signed_in' } })).toBeNull();
    expect(mergePendingOf({ detail: 'Missing or invalid token' })).toBeNull();
    expect(mergePendingOf(null)).toBeNull();
    expect(mergePendingOf({ detail: { error: 'merge_pending', merge_candidate: { id: 3 } } })).toBeNull();
  });

  it('asks whether the picker user is the person signing in', () => {
    const q = mergeQuestion(mergePendingOf(body)!);
    expect(q.title).toBe('Are you Landry?');
    expect(q.message).toContain('signing in as Landry Smith (landry@ltp.example) keeps "Landry" as your name');
    expect(q.yes).toBe('Yes, I am Landry');
    expect(q.no).toBe('No, start a new user');
  });
});
