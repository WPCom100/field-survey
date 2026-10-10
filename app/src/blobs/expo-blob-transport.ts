import {
  HttpBlobTransport,
  TransportError,
  failureOf,
  httpFailure,
  type ChunkSource,
  type HttpClientOptions,
} from '@field-survey/core';
import { Directory, File, Paths, UploadType } from 'expo-file-system';

import type { ExpoBlobFiles } from './expo-files';

const UPLOAD_TMP = 'blob-upload';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `/blobs` over HTTPS on the iPad. Declare/status/complete are core's `fetch` calls; the bytes
 * move with `expo-file-system` network tasks (T12 DoD): each 2-MB chunk is cut from the source
 * file into a temporary file and sent with an `UploadTask` (background URL session, so a chunk in
 * flight survives the app being suspended); downloads go straight to the sandbox with
 * `File.downloadFileAsync`, which on iOS moves the file into place only on success.
 */
export class ExpoBlobTransport extends HttpBlobTransport {
  constructor(
    opts: HttpClientOptions,
    private readonly files: ExpoBlobFiles,
  ) {
    super(opts);
  }

  override async putChunk(sha256: string, n: number, source: ChunkSource): Promise<void> {
    const dir = new Directory(Paths.cache, UPLOAD_TMP);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const tmp = new File(dir, `${sha256}.${n}`);
    const handle = this.files.file(source.path).open();
    try {
      handle.offset = source.offset;
      const bytes = handle.readBytes(source.length);
      if (tmp.exists) tmp.delete();
      tmp.create();
      tmp.write(bytes);
    } finally {
      handle.close();
    }
    const path = this.chunkPath(sha256, n);
    let res: { status: number; body: string };
    try {
      res = await tmp
        .createUploadTask(this.http.url(path), {
          httpMethod: 'PUT',
          uploadType: UploadType.BINARY_CONTENT,
          mimeType: 'application/octet-stream',
          headers: { ...this.http.headers(), 'Content-Type': 'application/octet-stream' },
          sessionType: 'background',
        })
        .uploadAsync();
    } catch (e) {
      throw new TransportError('network', message(e));
    } finally {
      try {
        tmp.delete();
      } catch {
        /* the next attempt overwrites it */
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw await failureOf({ status: res.status, json: async () => JSON.parse(res.body) }, 'PUT', path);
    }
  }

  override async download(sha256: string, destPath: string): Promise<{ size: number; mime: string | null }> {
    const dest = this.files.file(destPath);
    const parent = dest.parentDirectory;
    if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
    try {
      const file = await File.downloadFileAsync(this.http.url(this.contentPath(sha256)), dest, {
        headers: this.http.headers(),
        idempotent: true,
      });
      return { size: file.size, mime: file.type || null };
    } catch (e) {
      // Non-2xx rejects with an error whose message carries the status code.
      const status = /\b([45]\d\d)\b/.exec(message(e));
      if (status) {
        const code = Number(status[1]);
        throw new TransportError(httpFailure(code), message(e), code);
      }
      throw new TransportError('network', message(e));
    }
  }
}
