/**
 * Photo records (T21, PLAN §2.2 `photo`, §3.4, Phase 3 §4.4): what the photo screen reads and the
 * ops it writes. Capture and JPEG work live in `capture.ts` (Expo); this file has no React or Expo
 * imports and runs in Node.
 *
 * A photo is one `create` op carrying its blobs (image, 320-px thumbnail, optional markup stroke
 * list), its caption fields and its links (device and optionally one punch item or one cable end).
 * The record syncs at once; the bytes follow through the blob queue (thumbnails first). The photo
 * number is assigned by the server (`NEW` until then). Later caption/link/markup edits are plain
 * `set`s; a new markup is a new blob (the original JPEG is never touched).
 */

import { displayNumber, isNew, type Editor, type Op, type Store } from '@field-survey/core';

import { FIELD_SURVEY } from '../card/actions';
import { STANDARD_PHRASES } from '../card/model';

/** D38: the thumbnail's longer side, in pixels. */
export const THUMB_PX = 320;
/** D38: JPEG quality of the full-size image. */
export const JPEG_QUALITY = 0.9;

/** Thumbnail size for an image: the longer side `THUMB_PX`, never upscaled. */
export function thumbSize(width: number, height: number, max = THUMB_PX): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Lower-case hex of a digest (`expo-crypto` returns an ArrayBuffer). */
export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** One processed blob ready to reference from the record. */
export type StoredBlob = { sha256: string; size: number; width?: number; height?: number };

/** What a photo can be linked to besides its device. */
export type PhotoLink = { kind: 'punch' | 'end'; id: string; label: string };

export type PhotoTarget = {
  projectId: string;
  levelId: string;
  deviceId: string | null;
  /** Preselected link (a photo taken from a punch item or a connection end). */
  punchItemId?: string | null;
  cableEndId?: string | null;
  /** Location text when there is no device to take it from ("Photo here" on the plan, T23). */
  location?: string | null;
};

export type PhotoFields = {
  subject: string | null;
  whatItShows: string | null;
  location: string | null;
  punchItemId: string | null;
  cableEndId: string | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The device's punch items and connection ends a photo can be linked to (live ones only). */
export async function photoLinks(store: Store, deviceId: string | null): Promise<PhotoLink[]> {
  if (!deviceId) return [];
  const out: PhotoLink[] = [];
  const punch = await store.list<Row>('punch_item', { where: 'device_id = ? AND deleted_at IS NULL', params: [deviceId] });
  punch.sort((a, b) => Number(a.number ?? 1e9) - Number(b.number ?? 1e9));
  for (const p of punch) {
    const n = displayNumber('punch_item', p);
    out.push({ kind: 'punch', id: String(p.id), label: `${n === 'NEW' ? 'NEW' : `#${n}`} ${str(p.item) ?? ''}`.trim() });
  }
  const ends = await store.list<Row>('cable_end', { where: 'device_id = ? AND deleted_at IS NULL', params: [deviceId] });
  for (const e of ends) {
    const cable = await store.get<Row>('cable', String(e.cable_id));
    if (!cable || cable.deleted_at) continue;
    out.push({ kind: 'end', id: String(e.id), label: `${displayNumber('cable_end', e)} ${str(cable.cable) ?? ''} → ${str(e.to_text) ?? '…'}` });
  }
  return out;
}

/** Defaults of a new photo's caption sheet: Location from the device's Room / Location. */
export async function newPhotoFields(store: Store, t: PhotoTarget): Promise<PhotoFields> {
  const d = t.deviceId ? await store.get<Row>('device', t.deviceId) : null;
  return {
    subject: null,
    whatItShows: null,
    location: d ? str(d.room_location) : str(t.location),
    punchItemId: t.punchItemId ?? null,
    cableEndId: t.cableEndId ?? null,
  };
}

/** Caption chips: the project's `photo_caption` vocabulary, else the standard phrases. */
export async function captionPhrases(store: Store, projectId: string): Promise<readonly string[]> {
  const rows = await store.list<Row>('vocab', {
    where: `project_id = ? AND list = 'photo_caption' AND canonical_of_id IS NULL`,
    params: [projectId],
    orderBy: 'id',
  });
  return rows.length ? rows.map((v) => String(v.value)) : STANDARD_PHRASES;
}

/** The photo record as one `create` op. Blobs must already be registered with the queue. */
export async function createPhoto(
  editor: Editor,
  input: {
    target: PhotoTarget;
    fields: PhotoFields;
    image: StoredBlob;
    thumb: StoredBlob;
    markupSha: string | null;
    takenAt: string;
  },
): Promise<{ id: string; op: Op }> {
  const f = input.fields;
  return editor.create(
    'photo',
    {
      level_id: input.target.levelId,
      device_id: input.target.deviceId,
      punch_item_id: f.punchItemId,
      cable_end_id: f.cableEndId,
      subject: str(f.subject),
      what_it_shows: str(f.whatItShows),
      location: str(f.location),
      image_blob: input.image.sha256,
      thumb_blob: input.thumb.sha256,
      markup_blob: input.markupSha,
      taken_by_id: editor.userId,
      taken_at: input.takenAt,
    },
    FIELD_SURVEY,
  );
}

/** Caption, links and markup of an existing photo as one group; only changed fields are written. */
export function updatePhoto(editor: Editor, photoId: string, fields: PhotoFields, markupSha: string | null): Promise<Op[]> {
  return editor.setFields(
    'photo',
    photoId,
    {
      subject: str(fields.subject),
      what_it_shows: str(fields.whatItShows),
      location: str(fields.location),
      punch_item_id: fields.punchItemId,
      cable_end_id: fields.cableEndId,
      markup_blob: markupSha,
    },
    FIELD_SURVEY,
  );
}

export type ExistingPhoto = {
  id: string;
  label: string;
  isNew: boolean;
  levelId: string;
  deviceId: string | null;
  image: string | null;
  thumb: string | null;
  markup: string | null;
  fields: PhotoFields;
  takenAt: string | null;
  takenBy: string | null;
  /** Seeded from the master's Photo Log: only a 320×240 thumbnail exists (D40). */
  thumbOnly: boolean;
};

export async function loadPhoto(store: Store, photoId: string): Promise<ExistingPhoto | null> {
  const p = await store.get<Row>('photo', photoId);
  if (!p) return null;
  return {
    id: photoId,
    label: displayNumber('photo', p),
    isNew: isNew('photo', p),
    levelId: String(p.level_id),
    deviceId: str(p.device_id),
    image: str(p.image_blob),
    thumb: str(p.thumb_blob),
    markup: str(p.markup_blob),
    fields: {
      subject: str(p.subject),
      whatItShows: str(p.what_it_shows),
      location: str(p.location),
      punchItemId: str(p.punch_item_id),
      cableEndId: str(p.cable_end_id),
    },
    takenAt: str(p.taken_at),
    takenBy: str(p.taken_by_id),
    thumbOnly: !!p.seed_thumbnail_only,
  };
}
