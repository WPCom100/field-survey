/**
 * `BlobTransport` over HTTPS (server/docs/blobs.md). The JSON calls (declare, status, complete)
 * are plain `fetch`. Moving bytes depends on the runtime, so `putChunk`/`download` read and write
 * files through injected functions; the iPad subclass (`app/src/blobs/`) overrides both with
 * `expo-file-system` upload tasks and downloads instead.
 */

import type { BlobMeta, BlobTransport, ChunkSource, RemoteBlob } from './blobs';
import { HttpClient, type HttpClientOptions } from './http';
import { TransportError } from './sync';

export interface HttpBlobTransportOptions extends HttpClientOptions {
  /** Bytes `[offset, offset + length)` of a local file (Node: `fs`). */
  readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array>;
  /** Write a downloaded file, replacing any old one (Node: `fs`). */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export class HttpBlobTransport implements BlobTransport {
  protected readonly http: HttpClient;

  constructor(protected readonly opts: HttpBlobTransportOptions) {
    this.http = new HttpClient(opts);
  }

  declare(sha256: string, meta: BlobMeta): Promise<RemoteBlob> {
    return this.http.json<RemoteBlob>('POST', `/blobs/${sha256}`, {
      size: meta.size,
      mime: meta.mime,
      width: meta.width ?? null,
      height: meta.height ?? null,
    });
  }

  async status(sha256: string): Promise<RemoteBlob | null> {
    try {
      return await this.http.json<RemoteBlob>('GET', `/blobs/${sha256}`);
    } catch (e) {
      if (e instanceof TransportError && e.status === 404) return null;
      throw e;
    }
  }

  complete(sha256: string): Promise<RemoteBlob> {
    return this.http.json<RemoteBlob>('POST', `/blobs/${sha256}/complete`);
  }

  /** Path of chunk `n` (for native upload tasks). */
  chunkPath(sha256: string, n: number): string {
    return `/blobs/${sha256}/chunks/${n}`;
  }

  contentPath(sha256: string): string {
    return `/blobs/${sha256}/content`;
  }

  async putChunk(sha256: string, n: number, source: ChunkSource): Promise<void> {
    if (!this.opts.readRange) throw new Error('HttpBlobTransport: no readRange for chunk uploads');
    const bytes = await this.opts.readRange(source.path, source.offset, source.length);
    await this.http.send('PUT', this.chunkPath(sha256, n), {
      headers: { ...this.http.headers(), 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    });
  }

  async download(sha256: string, destPath: string): Promise<{ size: number; mime: string | null }> {
    if (!this.opts.writeFile) throw new Error('HttpBlobTransport: no writeFile for downloads');
    const res = await this.http.send('GET', this.contentPath(sha256));
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new TransportError('network', e instanceof Error ? e.message : String(e));
    }
    await this.opts.writeFile(destPath, bytes);
    return { size: bytes.byteLength, mime: res.headers.get('content-type') };
  }
}
