/**
 * Plan view filters and layers (PLAN §5, D99). Pure: runs in Node tests.
 *
 * Filters: Category, Status, Owner, Open punch. An empty list means "any". Filters and layer
 * toggles are view preferences of this iPad, kept per level in `sync_state` (never synced).
 *
 * - **Status** includes `none` for devices nobody has given a status yet.
 * - **Owner** (D99): a device matches when it has at least one open punch item (Tracking status
 *   not `Closed`) or open missing part (Part status not `Installed`) whose Owner matches.
 *   Picking `EC` also matches `EC/ETC`, and so does picking `ETC`; picking `EC/ETC` matches
 *   only `EC/ETC`.
 * - **Open punch**: at least one open punch item.
 * - There is no "Mine" filter (Landry, D99).
 */

import { vocab } from '@field-survey/core';

export const OWNERS = vocab.OWNER;
export type Owner = vocab.Owner;

export const NO_STATUS = 'none' as const;
/** What a device with no status is called everywhere (D110); the stored value stays empty. */
export const UNSURVEYED = 'Unsurveyed';
export type StatusKey = vocab.DeviceStatus | typeof NO_STATUS;
export const STATUS_KEYS: readonly StatusKey[] = [...vocab.DEVICE_STATUS, NO_STATUS];

export type PlanFilter = {
  categories: string[];
  statuses: StatusKey[];
  owners: Owner[];
  openPunch: boolean;
};

export type PlanLayers = {
  pins: boolean;
  labels: boolean;
  /** Source-sheet boundaries: no data until T45 extracts them (D100); the toggle is disabled. */
  boundaries: boolean;
  /** Ink of all users; drawn once T24 stores stroke lists. */
  ink: boolean;
  /** Camera mark with a count beside devices that have photos (D100). */
  photos: boolean;
};

export const EMPTY_FILTER: PlanFilter = { categories: [], statuses: [], owners: [], openPunch: false };
export const DEFAULT_LAYERS: PlanLayers = { pins: true, labels: true, boundaries: false, ink: true, photos: true };

/** What a filter needs to know about one device. */
export type Filterable = {
  category: string | null;
  status: string | null;
  /** Owners of the device's open punch items and open missing parts (duplicates allowed). */
  openOwners: readonly string[];
  openPunch: number;
};

export function statusKey(status: string | null): StatusKey {
  return status && (vocab.DEVICE_STATUS as readonly string[]).includes(status)
    ? (status as vocab.DeviceStatus)
    : NO_STATUS;
}

/** Does an item owned by `itemOwner` satisfy the Owner filter `selected`? */
export function ownerMatches(selected: readonly Owner[], itemOwner: string): boolean {
  if (selected.length === 0) return true;
  if (selected.includes(itemOwner as Owner)) return true;
  return itemOwner === 'EC/ETC' && (selected.includes('EC') || selected.includes('ETC'));
}

export function matchesFilter(d: Filterable, f: PlanFilter): boolean {
  if (f.categories.length && !f.categories.includes(d.category ?? '')) return false;
  if (f.statuses.length && !f.statuses.includes(statusKey(d.status))) return false;
  if (f.owners.length && !d.openOwners.some((o) => ownerMatches(f.owners, o))) return false;
  if (f.openPunch && d.openPunch === 0) return false;
  return true;
}

export function isFiltering(f: PlanFilter): boolean {
  return f.categories.length > 0 || f.statuses.length > 0 || f.owners.length > 0 || f.openPunch;
}

/** Toggle `value` in a multi-select list, keeping the order of `all`. */
export function toggle<T>(list: readonly T[], value: T, all: readonly T[]): T[] {
  const on = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return all.filter((v) => on.includes(v)).concat(on.filter((v) => !all.includes(v)));
}

// ------------------------------------------------------------------ persistence

export type PlanPrefs = { filter: PlanFilter; layers: PlanLayers };

export function prefsKey(levelId: string): string {
  return `plan_view:${levelId}`;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Read stored prefs defensively: unknown values are dropped (a vocabulary or app change must
 * never leave a level stuck behind an impossible filter), missing keys take the defaults.
 */
export function parsePrefs(raw: unknown): PlanPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = (r.filter && typeof r.filter === 'object' ? r.filter : {}) as Record<string, unknown>;
  const l = (r.layers && typeof r.layers === 'object' ? r.layers : {}) as Record<string, unknown>;
  const flag = (key: keyof PlanLayers) => (typeof l[key] === 'boolean' ? (l[key] as boolean) : DEFAULT_LAYERS[key]);
  return {
    filter: {
      categories: strings(f.categories),
      statuses: strings(f.statuses).filter((s): s is StatusKey => (STATUS_KEYS as readonly string[]).includes(s)),
      owners: strings(f.owners).filter((s): s is Owner => (OWNERS as readonly string[]).includes(s)),
      openPunch: f.openPunch === true,
    },
    layers: {
      pins: flag('pins'),
      labels: flag('labels'),
      boundaries: false, // nothing to draw until T45 (D100)
      ink: flag('ink'),
      photos: flag('photos'),
    },
  };
}
