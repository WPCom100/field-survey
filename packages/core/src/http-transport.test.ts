import { describe, expect, it } from 'vitest';
import { HttpTransport } from './http-transport';
import { LIBRARY_STREAM } from './library-stream';
import { TransportError } from './sync';

type Call = { url: string; init: RequestInit };

function stub(responses: Array<() => Response | Promise<Response>>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpTransport', () => {
  it('pushes with the shared token and user header, and parses the response', async () => {
    const s = stub([() => json(200, { results: [], server_ops: [], server_seq: 7 })]);
    const t = new HttpTransport({ serverUrl: 'https://survey.example.com/', token: 'tok', userName: 'Landry', fetch: s.fetch });
    const out = await t.push({ project_id: 'p', since: 3, ops: [] });
    expect(out.server_seq).toBe(7);
    const [call] = s.calls;
    expect(call!.url).toBe('https://survey.example.com/ops');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Survey-User': 'Landry', 'Content-Type': 'application/json' });
    expect(JSON.parse(call!.init.body as string)).toEqual({ project_id: 'p', since: 3, ops: [] });
  });

  it('pulls with query parameters', async () => {
    const s = stub([() => json(200, { ops: [], server_seq: 0, has_more: false })]);
    const t = new HttpTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch });
    await t.pull('p1', 42, 500);
    expect(s.calls[0]!.url).toBe('https://s/ops?project_id=p1&since=42&limit=500');
    expect(s.calls[0]!.init.method).toBe('GET');
    expect(s.calls[0]!.init.headers).not.toHaveProperty('X-Survey-User');
  });

  it('sends the app library stream to /library/ops, without a project (D184)', async () => {
    const s = stub([() => json(200, { results: [], server_ops: [], server_seq: 1 }), () => json(200, { ops: [], server_seq: 1, has_more: false })]);
    const t = new HttpTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch });
    await t.push({ project_id: LIBRARY_STREAM, since: 0, ops: [] });
    await t.pull(LIBRARY_STREAM, 1, 500);
    expect(s.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST https://s/library/ops', 'GET https://s/library/ops?since=1&limit=500']);
    expect(JSON.parse(s.calls[0]!.init.body as string)).toEqual({ since: 0, ops: [] });
  });

  it('pings GET /health and maps a dead network to a network failure', async () => {
    const s = stub([
      () => json(200, { status: 'ok' }),
      () => Promise.reject(new TypeError('Network request failed')),
    ]);
    const t = new HttpTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch });
    await t.ping();
    expect(s.calls[0]!.url).toBe('https://s/health');
    await expect(t.ping()).rejects.toMatchObject({ failure: 'network' });
  });

  it('maps failures: network, 401 auth, 409/422 rejected, 5xx server', async () => {
    const s = stub([
      () => Promise.reject(new TypeError('Network request failed')),
      () => json(401, { detail: 'Missing or invalid token' }),
      () => json(409, { detail: { error: 'integrity' } }),
      () => json(422, { detail: { index: 1 } }),
      () => new Response('boom', { status: 503 }),
    ]);
    const t = new HttpTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch });
    const failures: string[] = [];
    for (let i = 0; i < 5; i++) {
      try {
        await t.pull('p', 0, 10);
      } catch (e) {
        expect(e).toBeInstanceOf(TransportError);
        failures.push((e as TransportError).failure);
        if (i === 2) expect((e as TransportError).detail).toEqual({ detail: { error: 'integrity' } });
      }
    }
    expect(failures).toEqual(['network', 'auth', 'rejected', 'rejected', 'server']);
  });

  it('asks a token source for every request and tells it about a 401 (T04)', async () => {
    const s = stub([
      () => json(200, { ops: [], server_seq: 0, has_more: false }),
      () => json(401, { detail: 'Missing or invalid token' }),
      () => json(200, { status: 'ok' }),
    ]);
    let n = 0;
    const rejected: string[] = [];
    const tokenSource = { token: async () => `entra-${++n}`, rejected: (t: string) => rejected.push(t) };
    const t = new HttpTransport({ serverUrl: 'https://s', token: '', tokenSource, userName: 'Landry', fetch: s.fetch });
    await t.pull('p', 0, 10);
    await expect(t.pull('p', 0, 10)).rejects.toMatchObject({ failure: 'auth', status: 401 });
    await t.ping();
    expect(s.calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['Bearer entra-1', 'Bearer entra-2', undefined]);
    expect(s.calls[0]!.init.headers).toMatchObject({ 'X-Survey-User': 'Landry' });
    expect(rejected).toEqual(['entra-2']); // /health is public: no token asked, none rejected
  });

  it('a token source that cannot give a token fails the request without sending it', async () => {
    const s = stub([]);
    const tokenSource = {
      token: async () => {
        throw new TransportError('auth', 'Sign-in needed');
      },
    };
    const t = new HttpTransport({ serverUrl: 'https://s', token: '', tokenSource, fetch: s.fetch });
    await expect(t.push({ project_id: 'p', since: 0, ops: [] })).rejects.toMatchObject({ failure: 'auth', message: 'Sign-in needed' });
    expect(s.calls).toEqual([]);
  });
});
