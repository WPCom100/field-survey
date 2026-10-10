/**
 * In-process stand-in for the `/blobs` routes (server/app/blobs.py) for `BlobQueue` tests, plus a
 * Node sandbox. Same rules as the server: chunk size 2 MB, exact chunk lengths, any order,
 * `complete` checks size and SHA-256 (mismatch discards the chunks), declare after complete
 * answers "complete". Fault injection: transport failures per call, and a **kill** that freezes
 * the client in the middle of a chunk (the promise never settles, as when iOS kills the app).
 * Test-only: never imported by the app or the public entry.
 */

import { createHash } from 'node:crypto';
import { access, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BlobFiles, BlobKind, BlobMeta, BlobTransport, ChunkSource, RemoteBlob } from '../blobs';
import { TransportError, type TransportFailure } from '../sync';

export const CHUNK = 2 * 1024 * 1024;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** The sandbox for Node tests: one directory, `<sha>.<ext>`. */
export class NodeBlobFiles implements BlobFiles {
  constructor(readonly dir: string) {}

  pathFor(sha: string, kind: BlobKind): string {
    const ext = kind === 'sheet' ? 'pdf' : kind === 'markup' || kind === 'ink' ? 'json' : 'jpg';
    return join(this.dir, `${sha}.${ext}`);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Write bytes into the sandbox as a capture would; returns path, sha and size. */
  async put(bytes: Uint8Array, kind: BlobKind): Promise<{ path: string; sha256: string; size: number }> {
    await mkdir(this.dir, { recursive: true });
    const sha = sha256(bytes);
    const path = this.pathFor(sha, kind);
    await writeFile(path, bytes);
    return { path, sha256: sha, size: bytes.byteLength };
  }
}

interface Stored {
  meta: BlobMeta;
  chunks: Map<number, Uint8Array>;
  complete: Uint8Array | null;
}

export type BlobCall = 'declare' | 'status' | 'chunk' | 'complete' | 'download';

export interface BlobFault {
  on: BlobCall | 'any';
  failure: TransportFailure;
  status?: number;
  detail?: unknown;
}

export interface Kill {
  sha256?: string;
  chunk: number;
  /** `before`: the chunk never reaches the server; `after`: stored, but the client never hears back. */
  when: 'before' | 'after';
}

export class FakeBlobServer implements BlobTransport {
  readonly blobs = new Map<string, Stored>();
  /** Every call in order, e.g. `chunk <sha8> 2`, `complete <sha8>`. */
  readonly calls: string[] = [];
  private faults: BlobFault[] = [];
  private kill: (Kill & { fired: () => void }) | null = null;

  fail(...faults: BlobFault[]): void {
    this.faults.push(...faults);
  }

  /** Freeze the client at a chunk; resolves when it happened. */
  killAt(kill: Kill): Promise<void> {
    return new Promise((resolve) => {
      this.kill = { ...kill, fired: resolve };
    });
  }

  /** Put finished bytes on the server directly (another iPad uploaded them). */
  seed(bytes: Uint8Array, mime = 'image/jpeg'): string {
    const sha = sha256(bytes);
    this.blobs.set(sha, { meta: { size: bytes.byteLength, mime }, chunks: new Map(), complete: bytes });
    return sha;
  }

  chunkCalls(sha: string): number[] {
    const tag = `chunk ${sha.slice(0, 8)} `;
    return this.calls.filter((c) => c.startsWith(tag)).map((c) => Number(c.slice(tag.length)));
  }

  private fault(call: BlobCall): void {
    const i = this.faults.findIndex((f) => f.on === call || f.on === 'any');
    if (i < 0) return;
    const [f] = this.faults.splice(i, 1);
    throw new TransportError(f!.failure, `fake ${call} failure`, f!.status, f!.detail);
  }

  private remote(sha: string, s: Stored): RemoteBlob {
    return {
      sha256: sha,
      size: s.meta.size,
      mime: s.meta.mime,
      width: s.meta.width ?? null,
      height: s.meta.height ?? null,
      upload_state: s.complete ? 'complete' : 'partial',
      chunk_size: CHUNK,
      chunks_total: Math.ceil(s.meta.size / CHUNK),
      chunks_received: [...s.chunks.keys()].sort((a, b) => a - b),
    };
  }

  private refuse(status: number, error: string, extra: Record<string, unknown> = {}): never {
    throw new TransportError(status === 401 ? 'auth' : status < 500 ? 'rejected' : 'server', `fake ${error}`, status, {
      detail: { error, ...extra },
    });
  }

  async declare(sha: string, meta: BlobMeta): Promise<RemoteBlob> {
    this.calls.push(`declare ${sha.slice(0, 8)}`);
    this.fault('declare');
    let s = this.blobs.get(sha);
    if (!s) {
      s = { meta: { ...meta }, chunks: new Map(), complete: null };
      this.blobs.set(sha, s);
    } else if (s.meta.size !== meta.size) {
      this.refuse(409, 'size_mismatch', { size: s.meta.size });
    }
    return this.remote(sha, s);
  }

  async status(sha: string): Promise<RemoteBlob | null> {
    this.calls.push(`status ${sha.slice(0, 8)}`);
    this.fault('status');
    const s = this.blobs.get(sha);
    return s ? this.remote(sha, s) : null;
  }

  async putChunk(sha: string, n: number, source: ChunkSource): Promise<void> {
    const k = this.kill;
    const killHere = k && k.chunk === n && (!k.sha256 || k.sha256 === sha);
    if (killHere && k.when === 'before') {
      this.kill = null;
      k.fired();
      return new Promise<void>(() => {}); // the app died while sending
    }
    this.calls.push(`chunk ${sha.slice(0, 8)} ${n}`);
    this.fault('chunk');
    const s = this.blobs.get(sha);
    if (!s) this.refuse(404, 'unknown_blob');
    if (s.complete) return;
    const total = Math.ceil(s.meta.size / CHUNK);
    if (n < 0 || n >= total) this.refuse(422, 'bad_chunk');
    const bytes = await readRange(source.path, source.offset, source.length);
    const expected = Math.min(CHUNK, s.meta.size - n * CHUNK);
    if (bytes.byteLength !== expected) this.refuse(422, 'bad_chunk_length');
    s.chunks.set(n, bytes);
    if (killHere && k.when === 'after') {
      this.kill = null;
      k.fired();
      return new Promise<void>(() => {}); // stored, but the response never arrives
    }
  }

  async complete(sha: string): Promise<RemoteBlob> {
    this.calls.push(`complete ${sha.slice(0, 8)}`);
    this.fault('complete');
    const s = this.blobs.get(sha);
    if (!s) this.refuse(404, 'unknown_blob');
    if (s.complete) return this.remote(sha, s);
    const total = Math.ceil(s.meta.size / CHUNK);
    const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !s.chunks.has(i));
    if (missing.length) this.refuse(409, 'missing_chunks', { missing });
    const all = Buffer.concat(Array.from({ length: total }, (_, i) => s.chunks.get(i)!));
    if (sha256(all) !== sha || all.byteLength !== s.meta.size) {
      s.chunks.clear();
      this.refuse(422, 'hash_mismatch', { got: sha256(all) });
    }
    s.complete = new Uint8Array(all);
    s.chunks.clear();
    return this.remote(sha, s);
  }

  async download(sha: string, destPath: string): Promise<{ size: number; mime: string | null }> {
    this.calls.push(`download ${sha.slice(0, 8)}`);
    this.fault('download');
    const s = this.blobs.get(sha);
    if (!s?.complete) this.refuse(404, 'not_available');
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, s.complete);
    return { size: s.complete.byteLength, mime: s.meta.mime };
  }
}
