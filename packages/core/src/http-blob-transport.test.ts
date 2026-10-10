import { describe, expect, it } from 'vitest';
import { HttpBlobTransport } from './http-blob-transport';
import { errorCode } from './http';
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

const SHA = 'a'.repeat(64);
const REMOTE = {
  sha256: SHA, size: 5, mime: 'image/jpeg', width: null, height: null, upload_state: 'partial',
  chunk_size: 2097152, chunks_total: 1, chunks_received: [],
};

describe('HttpBlobTransport', () => {
  it('declares, sends a chunk read from the file, completes, with the identity headers', async () => {
    const s = stub([() => json(200, REMOTE), () => json(200, REMOTE), () => json(200, { ...REMOTE, upload_state: 'complete' })]);
    const reads: unknown[] = [];
    const t = new HttpBlobTransport({
      serverUrl: 'https://s/', token: 'tok', userName: 'Landry', fetch: s.fetch,
      readRange: async (path, offset, length) => {
        reads.push([path, offset, length]);
        return new Uint8Array([1, 2, 3]);
      },
    });
    expect(await t.declare(SHA, { size: 5, mime: 'image/jpeg', width: 10 })).toEqual(REMOTE);
    await t.putChunk(SHA, 3, { path: '/sandbox/x.jpg', offset: 6291456, length: 3 });
    expect((await t.complete(SHA)).upload_state).toBe('complete');

    expect(s.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST https://s/blobs/${SHA}`,
      `PUT https://s/blobs/${SHA}/chunks/3`,
      `POST https://s/blobs/${SHA}/complete`,
    ]);
    expect(JSON.parse(s.calls[0]!.init.body as string)).toEqual({ size: 5, mime: 'image/jpeg', width: 10, height: null });
    for (const c of s.calls) expect(c.init.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Survey-User': 'Landry' });
    expect(s.calls[1]!.init.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' });
    expect(s.calls[1]!.init.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(reads).toEqual([['/sandbox/x.jpg', 6291456, 3]]);
  });

  it('status of an unknown blob is null; other failures throw', async () => {
    const s = stub([() => json(404, { detail: { error: 'unknown_blob' } }), () => json(503, {})]);
    const t = new HttpBlobTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch });
    expect(await t.status(SHA)).toBeNull();
    await expect(t.status(SHA)).rejects.toMatchObject({ failure: 'server', status: 503 });
  });

  it('downloads the content into the file and reports size and type', async () => {
    const s = stub([() => new Response(new Uint8Array([9, 8, 7, 6]), { status: 200, headers: { 'Content-Type': 'application/pdf' } })]);
    const written: Array<[string, Uint8Array]> = [];
    const t = new HttpBlobTransport({
      serverUrl: 'https://s', token: 'tok', fetch: s.fetch,
      writeFile: async (p, b) => {
        written.push([p, b]);
      },
    });
    expect(await t.download(SHA, '/sandbox/s.pdf')).toEqual({ size: 4, mime: 'application/pdf' });
    expect(s.calls[0]!.url).toBe(`https://s/blobs/${SHA}/content`);
    expect(written).toEqual([['/sandbox/s.pdf', new Uint8Array([9, 8, 7, 6])]]);
  });

  it('maps a not-yet-uploaded download to 404 and exposes the server error code', async () => {
    const s = stub([
      () => json(404, { detail: { error: 'not_available', upload_state: 'partial' } }),
      () => json(422, { detail: { error: 'hash_mismatch', got: 'x' } }),
      () => Promise.reject(new TypeError('Network request failed')),
    ]);
    const t = new HttpBlobTransport({ serverUrl: 'https://s', token: 'tok', fetch: s.fetch, writeFile: async () => {} });
    const e1 = await t.download(SHA, '/x').catch((e) => e);
    expect(e1).toBeInstanceOf(TransportError);
    expect(e1).toMatchObject({ failure: 'rejected', status: 404 });
    expect(errorCode(await t.complete(SHA).catch((e) => e))).toBe('hash_mismatch');
    expect(await t.declare(SHA, { size: 1, mime: 'a/b' }).catch((e) => e)).toMatchObject({ failure: 'network' });
  });

  it('refuses to move bytes without file access', async () => {
    const t = new HttpBlobTransport({ serverUrl: 'https://s', token: 'tok', fetch: stub([]).fetch });
    await expect(t.putChunk(SHA, 0, { path: 'p', offset: 0, length: 1 })).rejects.toThrow(/readRange/);
    await expect(t.download(SHA, 'p')).rejects.toThrow(/writeFile/);
  });
});
