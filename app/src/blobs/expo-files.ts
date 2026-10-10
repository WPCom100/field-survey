import type { BlobFiles, BlobKind } from '@field-survey/core';
import { Directory, File, Paths } from 'expo-file-system';

const EXT: Record<BlobKind, string> = {
  thumb: 'jpg',
  image: 'jpg',
  markup: 'json',
  ink: 'json',
  sheet: 'pdf',
  export: 'bin',
};

/**
 * The blob sandbox: `Documents/blobs/<sha>.<ext>` (Documents, not Caches, so iOS never purges
 * bytes that have not been uploaded; the LRU in core manages the size).
 *
 * Paths handed to core are **relative to Documents** (`blobs/<sha>.jpg`): iOS moves the app
 * container on every app update, so an absolute URI stored in SQLite would point nowhere after
 * the next TestFlight build. `file()` resolves one for the native APIs.
 */
export class ExpoBlobFiles implements BlobFiles {
  static readonly DIR = 'blobs';

  constructor() {
    const dir = new Directory(Paths.document, ExpoBlobFiles.DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  }

  pathFor(sha256: string, kind: BlobKind): string {
    return `${ExpoBlobFiles.DIR}/${sha256}.${EXT[kind]}`;
  }

  /** The native file for a stored path (relative, or an absolute `file://` URI). */
  file(path: string): File {
    return path.startsWith('file:') ? new File(path) : new File(Paths.document, path);
  }

  async exists(path: string): Promise<boolean> {
    return this.file(path).exists;
  }

  async remove(path: string): Promise<void> {
    const f = this.file(path);
    if (f.exists) f.delete();
  }
}
