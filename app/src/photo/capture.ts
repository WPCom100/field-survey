import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';

import { discard, prepareFile, type PreparedBlob } from '../blobs/store-bytes';
import { JPEG_QUALITY, thumbSize } from './model';

export type PreparedPhoto = { image: PreparedBlob; thumb: PreparedBlob; width: number; height: number };

function removeTemp(uri: string | null | undefined) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // a temp file the OS cleans up anyway
  }
}

/**
 * Camera or library image → the stored JPEG and thumbnail (D38, PLAN §3.4): decoded with UIKit
 * (first frame of a HEIC/MPO), orientation baked into the pixels, re-encoded as JPEG q 0.9, which
 * writes no EXIF/GPS; then a 320-px thumbnail from that JPEG. Both are written into the blob
 * sandbox under their SHA-256 but not queued: `register()` them when the photo is saved.
 */
export async function preparePhoto(sourceUri: string): Promise<PreparedPhoto> {
  const full = await ImageManipulator.manipulate(sourceUri).renderAsync();
  let fullUri: string | null = null;
  let thumbUri: string | null = null;
  try {
    const saved = await full.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
    fullUri = saved.uri;
    const t = thumbSize(saved.width, saved.height);
    const small = await ImageManipulator.manipulate(saved.uri).resize(t).renderAsync();
    const thumbSaved = await small.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
    small.release();
    thumbUri = thumbSaved.uri;
    const image = await prepareFile(saved.uri, 'image', 'image/jpeg', { width: saved.width, height: saved.height });
    const thumb = await prepareFile(thumbSaved.uri, 'thumb', 'image/jpeg', { width: thumbSaved.width, height: thumbSaved.height });
    console.log(`[blobs] photo prepared ${saved.width}×${saved.height} ${Math.round(image.size / 1024)} KB, thumb ${thumbSaved.width}×${thumbSaved.height}`);
    return { image, thumb, width: saved.width, height: saved.height };
  } finally {
    full.release();
    removeTemp(fullUri);
    removeTemp(thumbUri);
    if (sourceUri.startsWith('file:') && sourceUri.includes('/Caches/')) removeTemp(sourceUri);
  }
}

export function discardPhoto(p: PreparedPhoto | null | undefined): void {
  if (!p) return;
  discard(p.image);
  discard(p.thumb);
}
