/**
 * Photo records (T21, PLAN §2.2 `photo`, §3.4, Phase 3 §4.4): what the photo screen reads and the
 * ops it writes. Capture and JPEG work live in `capture.ts` (Expo); this file has no React or Expo
 * imports and runs in Node.
 *
 * A photo is one `create` op carrying its blobs (image, 320-px thumbnail, optional markup stroke
 * list), its caption fields and the device it was taken from, grouped with one `photo_link`
 * `link_add` per further device, connection end or punch item (D128, `links.ts`). The record
 * syncs at once; the bytes follow through the blob queue (thumbnails first). The photo number is
 * assigned by the server (`NEW` until then). Later caption/markup edits are plain `set`s and link
 * changes `link_add`/`link_remove`, so they never conflict with each other; a new markup is a new
 * blob (the original JPEG is never touched).
 */

import { displayNumber, isNew, type Editor, type Op, type Store } from '@field-survey/core';

import { FIELD_SURVEY } from '../card/actions';
import { STANDARD_PHRASES } from '../card/model';
import { hasLink, linksOf, type LinkRef } from './links';

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
  /** D128: further devices, connection ends and punch items (never the photo's own device). */
  links: LinkRef[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Defaults of a new photo's caption sheet: Location from the device's Room / Location, the end or punch item it was taken from. */
export async function newPhotoFields(store: Store, t: PhotoTarget): Promise<PhotoFields> {
  const d = t.deviceId ? await store.get<Row>('device', t.deviceId) : null;
  const links: LinkRef[] = [];
  if (t.cableEndId) links.push({ kind: 'cable_end', id: t.cableEndId });
  if (t.punchItemId) links.push({ kind: 'punch', id: t.punchItemId });
  return {
    subject: null,
    whatItShows: null,
    location: d ? str(d.room_location) : str(t.location),
    links,
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

const linkKey = (l: LinkRef) => ({ target_kind: l.kind, target_id: l.id });

/** The photo record as one `create` op plus its links, one group. Blobs must already be registered with the queue. */
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
): Promise<{ id: string; op: Op; links: Op[] }> {
  const f = input.fields;
  let made: { id: string; op: Op } | null = null;
  const ops = await editor.group(FIELD_SURVEY, async (g) => {
    made = await g.create('photo', {
      level_id: input.target.levelId,
      device_id: input.target.deviceId,
      subject: str(f.subject),
      what_it_shows: str(f.whatItShows),
      location: str(f.location),
      image_blob: input.image.sha256,
      thumb_blob: input.thumb.sha256,
      markup_blob: input.markupSha,
      taken_by_id: editor.userId,
      taken_at: input.takenAt,
    });
    for (const l of f.links) {
      if (l.kind === 'device' && l.id === input.target.deviceId) continue;
      await g.link('photo_link', made.id, linkKey(l));
    }
  });
  const { id, op } = made!;
  return { id, op, links: ops.filter((o) => o.kind === 'link_add') };
}

/**
 * Caption, links and markup of an existing photo as one group; only changes are written. A link
 * held in a legacy column (`punch_item_id` / `cable_end_id`) is cleared there when unticked.
 */
export async function updatePhoto(editor: Editor, store: Store, photoId: string, fields: PhotoFields, markupSha: string | null): Promise<Op[]> {
  const row = await store.get<Row>('photo', photoId);
  if (!row) return [];
  const before = await linksOf(store, row);
  const legacyPunch = str(row.punch_item_id);
  const legacyEnd = str(row.cable_end_id);
  return editor.group(FIELD_SURVEY, async (g) => {
    await g.setFields('photo', photoId, {
      subject: str(fields.subject),
      what_it_shows: str(fields.whatItShows),
      location: str(fields.location),
      markup_blob: markupSha,
      ...(legacyPunch && !hasLink(fields.links, { kind: 'punch', id: legacyPunch }) ? { punch_item_id: null } : {}),
      ...(legacyEnd && !hasLink(fields.links, { kind: 'cable_end', id: legacyEnd }) ? { cable_end_id: null } : {}),
    });
    for (const l of fields.links) {
      if (l.kind === 'device' && l.id === str(row.device_id)) continue;
      if (!hasLink(before, l)) await g.link('photo_link', photoId, linkKey(l));
    }
    for (const l of before) {
      const legacy = (l.kind === 'punch' && l.id === legacyPunch) || (l.kind === 'cable_end' && l.id === legacyEnd);
      if (!legacy && !hasLink(fields.links, l)) await g.unlink('photo_link', photoId, linkKey(l));
    }
  });
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
      links: await linksOf(store, p),
    },
    takenAt: str(p.taken_at),
    takenBy: str(p.taken_by_id),
    thumbOnly: !!p.seed_thumbnail_only,
  };
}
