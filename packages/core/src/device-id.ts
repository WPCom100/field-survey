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
 * The scheme comes from the device's library type (`id_scheme`); without one, from the device's
 * **role** (T112, D201): `station` and `sensor` are `level_tag` with their letter, every other
 * role `level_number`. The role is the type's, else the category's (`roleOfCategory`). A
 * duplicate tag is reported (`taken_by`), not enforced: it is a lint, never a refusal (D76), so
 * offline edits always apply.
 */

import { ROLE_LABEL, isRole, roleOf, roleOfCategory, type Role } from './roles';
import type { Store } from './store';
import type { ID_SCHEME } from './vocab';

export type IdScheme = (typeof ID_SCHEME)[number];

export class DeviceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIdError';
  }
}

/** Tag letter per role (master: stations `S`, sensors `D`). */
export const TAG_PREFIX: Readonly<Partial<Record<Role, string>>> = { station: 'S', sensor: 'D' };

/** A role's ID scheme: `level_tag` for stations and sensors, `level_number` for the rest. */
export function defaultIdSchemeForRole(role: Role): IdScheme {
  return role in TAG_PREFIX ? 'level_tag' : 'level_number';
}

/** The scheme a category implies for a device with no type (`roleOfCategory`). */
export function defaultIdScheme(category: string | null | undefined): IdScheme {
  return defaultIdSchemeForRole(roleOfCategory(category));
}

/** A role, or the role a category implies: the tag helpers accept either. */
function asRole(v: Role | string | null | undefined): Role {
  return isRole(v) ? v : roleOfCategory(v);
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
 * The confirmed drawing tag as an ID: `tagDeviceId('01', 'station', ' s15 ')` → `01-S15`.
 * A bare number takes the role's letter; a letter that contradicts it is refused. A full
 * ID (`01-S15`) is accepted when its level matches. The second argument is the device's role,
 * or a category (its role is looked up).
 */
export function tagDeviceId(level: string, roleOrCategory: Role | string | null | undefined, tag: string): string {
  const role = asRole(roleOrCategory);
  let t = tag.replace(/\s+/g, '').toUpperCase();
  const full = parseDeviceId(t);
  if (full) {
    if (full.level !== level) throw new DeviceIdError(`Tag ${tag} is for level ${full.level}, not ${level}`);
    t = `${full.prefix}${full.n}`;
  }
  const m = /^([A-Z]*)(\d+)$/.exec(t);
  if (!m) throw new DeviceIdError(`Tag must be a letter and a number, like S15 (got "${tag}")`);
  const expected = TAG_PREFIX[role];
  const letter = m[1] || expected;
  const what = role !== 'other' ? ROLE_LABEL[role] : typeof roleOrCategory === 'string' && roleOrCategory && !isRole(roleOrCategory) ? roleOrCategory : 'device';
  if (!letter) throw new DeviceIdError(`Tag needs its letter for a ${what} (got "${tag}")`);
  if (expected && letter !== expected) {
    throw new DeviceIdError(`A ${what} tag starts with ${expected} (got "${tag}")`);
  }
  const n = Number(m[2]);
  if (n < 1) throw new DeviceIdError(`Tag number must be ≥ 1 (got "${tag}")`);
  return `${level}-${letter}${n}`;
}

export interface DeviceIdRequest {
  projectId: string;
  levelId: string;
  category?: string | null;
  /** The device's role when the caller knows it; else the type's, else the category's. */
  role?: Role | null;
  /** The device's library type; its `id_scheme` wins over the role's default. */
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
  const type = req.libraryTypeId ? await store.get<{ id_scheme: IdScheme | null; role: string | null; category: string | null }>('library_type', req.libraryTypeId) : null;
  const role = req.role ?? roleOf(type, { category: req.category });
  const scheme = type?.id_scheme ?? defaultIdSchemeForRole(role);
  if (scheme === 'level_number' || !req.tag || !req.tag.trim()) return { scheme, pending: true };
  const display_id = tagDeviceId(level.level, role, req.tag);
  const taken_by = (await projectDeviceIds(store, req.projectId))
    .filter((u) => u.id !== req.deviceId && u.display_id === display_id)
    .map((u) => u.id);
  return { scheme, pending: false, display_id, taken_by };
}
