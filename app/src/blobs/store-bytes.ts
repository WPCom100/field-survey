import type { BlobKind, BlobQueue } from '@field-survey/core';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';

import { toHex } from '../photo/model';
import { getBlobFiles } from './queue';

/**
 * Bytes written into the blob sandbox under their SHA-256 (`Documents/blobs/<sha>.<ext>`, path
 * relative to Documents — T12) but **not yet queued for upload**: a capture the surveyor may
 * still cancel. `register()` hands it to the queue; `discard()` removes a file this call created.
 */
export type PreparedBlob = {
  sha256: string;
  kind: BlobKind;
  path: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  /** The file did not exist before (so discarding may delete it). */
  created: boolean;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await digest(CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>));
}

/** Copy a file (camera/manipulator output in Caches) into the sandbox under its hash. */
export async function prepareFile(
  srcUri: string,
  kind: BlobKind,
  mime: string,
  dims?: { width: number; height: number },
): Promise<PreparedBlob> {
  const src = new File(srcUri);
  const bytes = await src.bytes();
  const sha256 = await sha256Hex(bytes);
  const files = getBlobFiles();
  const path = files.pathFor(sha256, kind);
  const dest = files.file(path);
  const created = !dest.exists;
  if (created) await src.copy(dest);
  return { sha256, kind, path, size: bytes.length, mime, created, ...(dims ?? {}) };
}

/** Write bytes (a stroke list) into the sandbox under their hash. */
export async function prepareBytes(bytes: Uint8Array, kind: BlobKind, mime: string): Promise<PreparedBlob> {
  const sha256 = await sha256Hex(bytes);
  const files = getBlobFiles();
  const path = files.pathFor(sha256, kind);
  const dest = files.file(path);
  const created = !dest.exists;
  if (created) dest.write(bytes);
  return { sha256, kind, path, size: bytes.length, mime, created };
}

export function prepareText(text: string, kind: BlobKind): Promise<PreparedBlob> {
  return prepareBytes(new TextEncoder().encode(text), kind, 'application/json');
}

/** Queue the upload (idempotent; the queue sends thumbnails first). */
export function register(queue: Pick<BlobQueue, 'addLocal'>, b: PreparedBlob): Promise<void> {
  return queue.addLocal({ sha256: b.sha256, kind: b.kind, path: b.path, size: b.size, mime: b.mime, width: b.width, height: b.height });
}

/** Remove a prepared file nobody registered (a cancelled capture). */
export function discard(b: PreparedBlob | null | undefined): void {
  if (!b?.created) return;
  try {
    const f = getBlobFiles().file(b.path);
    if (f.exists) f.delete();
  } catch (e) {
    console.warn(`[blobs] discard ${b.sha256} failed: ${String(e)}`);
  }
}

/** The text of a cached blob (a stroke list), or null when the bytes are not on this iPad. */
export async function readCachedText(queue: Pick<BlobQueue, 'ensureLocal'>, sha: string, kind: BlobKind): Promise<string | null> {
  const path = await queue.ensureLocal(sha, kind);
  if (!path) return null;
  const f = getBlobFiles().file(path);
  return f.exists ? f.text() : null;
}
