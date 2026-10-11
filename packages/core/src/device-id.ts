/**
 * Device IDs on the iPad (T13, T63, PLAN §2.3, D93):
 *
 * - `level_number` (panels, racks, NSPS, touchscreens…): `<level>-<nn>` is **assigned by the
 *   server** (D93). The iPad creates the device without `display_id`, shows `<level>-?` with the
 *   `NEW` badge (`displayNumber('device', row, level)`), and the ID arrives as an `assign` op
 *   within one sync. Two iPads adding devices offline on one level therefore never share an ID.
 * - `level_tag` (stations, sensors): `<level>-S<n>` / `<level>-D<n>`. Since D118 the server
 *   numbers these too (next free per letter) when the create carries no ID, so the app never asks
 *   for a tag; a tag that is given (seed import, setup placement) is still validated and kept
 *   (`S15`, `15`, `s 15` → `S15`; no zero padding: `01-S9`).
 *
 * The scheme comes from the device's library type; without one, `Station` and `Sensor` are
 * `level_tag` and every other category `level_number`. A duplicate tag is reported
 * (`taken_by`), not enforced: it is a lint, never a refusal (D76), so offline edits always apply.
 */

import type { Store } from './store';
import type { ID_SCHEME } from './vocab';

export type IdScheme = (typeof ID_SCHEME)[number];

export class DeviceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIdError';
  }
}

/** Tag letter per category (master: stations `S`, sensors `D`). */
export const TAG_PREFIX: Readonly<Record<string, string>> = { Station: 'S', Sensor: 'D' };

export function defaultIdScheme(category: string | null | undefined): IdScheme {
  return category != null && category in TAG_PREFIX ? 'level_tag' : 'level_number';
}

export interface ParsedDeviceId {
  level: string;
  /** '' for `level_number` IDs, the tag letter(s) otherwise. */
  prefix: string;
  n: number;
}

/** `06M-04` → {06M, '', 4}; `01-S15` → {01, S, 15}; anything else → null. */
export function parseDeviceId(id: string | null | undefined): ParsedDeviceId | null {
  const m = /^([A-Z0-9]+)-([A-Z]*)(\d+)$/.exec((id ?? '').trim());
  if (!m) return null;
  return { level: m[1]!, prefix: m[2]!, n: Number(m[3]) };
}

/**
 * The confirmed drawing tag as an ID: `tagDeviceId('01', 'Station', ' s15 ')` → `01-S15`.
 * A bare number takes the category's letter; a letter that contradicts it is refused. A full
 * ID (`01-S15`) is accepted when its level matches.
 */
export function tagDeviceId(level: string, category: string | null | undefined, tag: string): string {
  let t = tag.replace(/\s+/g, '').toUpperCase();
  const full = parseDeviceId(t);
  if (full) {
    if (full.level !== level) throw new DeviceIdError(`Tag ${tag} is for level ${full.level}, not ${level}`);
    t = `${full.prefix}${full.n}`;
  }
  const m = /^([A-Z]*)(\d+)$/.exec(t);
  if (!m) throw new DeviceIdError(`Tag must be a letter and a number, like S15 (got "${tag}")`);
  const expected = category != null ? TAG_PREFIX[category] : undefined;
  const letter = m[1] || expected;
  if (!letter) throw new DeviceIdError(`Tag needs its letter for a ${category ?? 'device'} (got "${tag}")`);
  if (expected && letter !== expected) {
    throw new DeviceIdError(`A ${category} tag starts with ${expected} (got "${tag}")`);
  }
  const n = Number(m[2]);
  if (n < 1) throw new DeviceIdError(`Tag number must be ≥ 1 (got "${tag}")`);
  return `${level}-${letter}${n}`;
}

export interface DeviceIdRequest {
  projectId: string;
  levelId: string;
  category?: string | null;
  /** The device's library type; its `id_scheme` wins over the category default. */
  libraryTypeId?: string | null;
  /** `level_tag`: a drawing tag to keep (optional since D118: none → the server numbers it). */
  tag?: string | null;
  /** The device being (re)tagged, left out of `taken_by`. */
  deviceId?: string | null;
}

/** `level_tag`: the ID to store, with any other device already carrying it. */
export interface TaggedDeviceId {
  scheme: 'level_tag';
  pending: false;
  display_id: string;
  /** Other devices in the project (deleted included) already carrying this ID. */
  taken_by: string[];
}

/** Create without `display_id`; the server assigns it (D93, D118 for stations and sensors). */
export interface PendingDeviceId {
  scheme: IdScheme;
  pending: true;
}

export type DeviceIdProposal = TaggedDeviceId | PendingDeviceId;

/** Every device ID used in the project, deleted devices included (they stay used). */
async function projectDeviceIds(
  store: Store,
  projectId: string,
): Promise<{ id: string; display_id: string }[]> {
  return store.db.query<{ id: string; display_id: string }>(
    `SELECT d.id AS id, d.display_id AS display_id
       FROM device d JOIN level l ON l.id = d.level_id
      WHERE l.project_id = ? AND d.display_id IS NOT NULL`,
    [projectId],
  );
}

/**
 * The ID a new or placed device gets on `levelId`: the confirmed tag for `level_tag`, or
 * `{ pending: true }` for `level_number` (leave `display_id` out of the create). Reads the level
 * code and the library type's scheme from the store; throws `DeviceIdError` for an unknown level
 * or a bad/missing tag.
 */
export async function deviceIdFor(store: Store, req: DeviceIdRequest): Promise<DeviceIdProposal> {
  const level = await store.get<{ level: string; project_id: string }>('level', req.levelId);
  if (!level) throw new DeviceIdError(`Unknown level ${req.levelId}`);
  let scheme = defaultIdScheme(req.category);
  if (req.libraryTypeId) {
    const type = await store.get<{ id_scheme: IdScheme | null }>('library_type', req.libraryTypeId);
    if (type?.id_scheme) scheme = type.id_scheme;
  }
  if (scheme === 'level_number' || !req.tag || !req.tag.trim()) return { scheme, pending: true };
  const display_id = tagDeviceId(level.level, req.category, req.tag);
  const taken_by = (await projectDeviceIds(store, req.projectId))
    .filter((u) => u.id !== req.deviceId && u.display_id === display_id)
    .map((u) => u.id);
  return { scheme, pending: false, display_id, taken_by };
}
