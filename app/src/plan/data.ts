/**
 * Read model of the plan view (T17): one level, its display sheet, and its devices with what
 * the pins, filters and side list need. Reads only (writes go through `Store.apply`); no React
 * or Expo imports, so it is tested in Node over `BetterSqliteDriver`.
 */

import { displayNumber, isNew, type Store } from '@field-survey/core';

import type { Filterable } from './filters';

export type PlanLevel = {
  id: string;
  projectId: string;
  code: string;
  displaySheetId: string | null;
};

export type PlanSheet = {
  id: string;
  blob: string | null;
  page: number;
  title: string | null;
  widthPt: number | null;
  heightPt: number | null;
};

export type PlanDevice = Filterable & {
  id: string;
  /** `06M-04`, `01-S15`, or `06M-?` while the server has not numbered it (D93). */
  label: string;
  isNew: boolean;
  device: string | null;
  /** The master's Type column ("Echo relay panel"), when the device has one. */
  type: string | null;
  room: string | null;
  /** On this level's display sheet, in sheet coordinates; null when unplaced or elsewhere. */
  pin: { x: number; y: number } | null;
  /** Pinned, but on another sheet than the display sheet. */
  pinElsewhere: boolean;
  fieldAddition: boolean;
  photos: number;
  /** Soft-deleted; only loaded with `includeDeleted`, never pinned. */
  deleted: boolean;
};

export type LevelPlan = { level: PlanLevel; sheet: PlanSheet | null; devices: PlanDevice[] };

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const PIN_LABEL_MAX = 22;

/**
 * What a pin's label says on the plan (Landry, iPad retest: "when looking around the drawing I want
 * to know what kind of device each pin is, not its ID"): the Type, else the Device (model), else
 * the category; long names are cut with an ellipsis. IDs stay in the lists and on the card.
 */
export function pinLabel(d: { type: string | null; device: string | null; category: string | null }): string {
  const s = (d.type ?? d.device ?? d.category ?? '').trim() || 'Device';
  return s.length > PIN_LABEL_MAX ? `${s.slice(0, PIN_LABEL_MAX - 1).trimEnd()}…` : s;
}

/** Natural order of device IDs: `06M-02` < `06M-10` < `06M-S1` < `06M-S12`; `-?` last. */
export function compareLabels(a: string, b: string): number {
  const ka = a.endsWith('-?') ? 1 : 0;
  const kb = b.endsWith('-?') ? 1 : 0;
  return ka - kb || a.localeCompare(b, 'en', { numeric: true });
}

function pinOn(pin: unknown, sheetId: string | null): { at: { x: number; y: number } | null; elsewhere: boolean } {
  if (!pin || typeof pin !== 'object') return { at: null, elsewhere: false };
  const p = pin as Row;
  const x = num(p.x);
  const y = num(p.y);
  if (x === null || y === null) return { at: null, elsewhere: false };
  if (sheetId && p.sheet === sheetId) return { at: { x, y }, elsewhere: false };
  return { at: null, elsewhere: true };
}

/** The level, its display sheet and its live devices, sorted by ID; null if the level is unknown. */
export async function loadLevelPlan(
  store: Store,
  levelId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<LevelPlan | null> {
  const lv = await store.get<Row>('level', levelId);
  if (!lv || lv.deleted_at) return null;
  const level: PlanLevel = {
    id: levelId,
    projectId: String(lv.project_id),
    code: String(lv.level),
    displaySheetId: str(lv.display_sheet_id),
  };

  let sheet: PlanSheet | null = null;
  if (level.displaySheetId) {
    const sh = await store.get<Row>('sheet', level.displaySheetId);
    if (sh && !sh.deleted_at) {
      sheet = {
        id: level.displaySheetId,
        blob: str(sh.blob),
        page: num(sh.page) ?? 1,
        title: str(sh.title),
        widthPt: num(sh.width_pt),
        heightPt: num(sh.height_pt),
      };
    }
  }

  const rows = await store.list<Row>('device', {
    where: 'level_id = ?',
    params: [levelId],
    includeDeleted: opts.includeDeleted,
  });

  const photos = new Map<string, number>();
  for (const r of await store.db.query<{ device_id: string; n: number }>(
    `SELECT p.device_id, count(*) AS n FROM photo p JOIN device d ON d.id = p.device_id
     WHERE d.level_id = ? AND p.deleted_at IS NULL GROUP BY p.device_id`,
    [levelId],
  )) {
    photos.set(r.device_id, r.n);
  }

  // Open = punch not Closed, part not Installed (D99). Items without a status count as open.
  const openPunch = new Map<string, number>();
  const owners = new Map<string, string[]>();
  const items = await store.db.query<{ device_id: string; owner: string | null; punch: number }>(
    `SELECT p.device_id, p.owner, 1 AS punch FROM punch_item p JOIN device d ON d.id = p.device_id
     WHERE d.level_id = ? AND p.deleted_at IS NULL AND coalesce(p.tracking_status, '') <> 'Closed'
     UNION ALL
     SELECT m.device_id, m.owner, 0 AS punch FROM missing_part m JOIN device d ON d.id = m.device_id
     WHERE d.level_id = ? AND m.deleted_at IS NULL AND coalesce(m.part_status, '') <> 'Installed'`,
    [levelId, levelId],
  );
  for (const it of items) {
    if (it.punch) openPunch.set(it.device_id, (openPunch.get(it.device_id) ?? 0) + 1);
    if (it.owner) owners.set(it.device_id, [...(owners.get(it.device_id) ?? []), it.owner]);
  }

  const devices = rows.map((r): PlanDevice => {
    const id = String(r.id);
    const deleted = !!r.deleted_at;
    const { at, elsewhere } = deleted ? { at: null, elsewhere: false } : pinOn(r.pin, sheet?.id ?? null);
    return {
      id,
      label: displayNumber('device', r, level.code),
      isNew: isNew('device', r),
      category: str(r.category),
      status: str(r.status),
      device: str(r.device),
      type: str(r.type),
      room: str(r.room_location),
      pin: at,
      pinElsewhere: elsewhere,
      fieldAddition: r.origin === 'field_addition',
      photos: photos.get(id) ?? 0,
      deleted,
      openPunch: openPunch.get(id) ?? 0,
      openOwners: owners.get(id) ?? [],
    };
  });
  devices.sort((a, b) => compareLabels(a.label, b.label) || a.id.localeCompare(b.id));
  return { level, sheet, devices };
}

/** Levels with a display sheet, for the temporary level picker on the home screen (T18 replaces it). */
export async function levelsWithPlans(store: Store): Promise<{ id: string; code: string; floorOrder: number | null }[]> {
  const rows = await store.list<Row>('level', {
    where: 'display_sheet_id IS NOT NULL',
    orderBy: 'floor_order, level',
  });
  return rows.map((r) => ({ id: String(r.id), code: String(r.level), floorOrder: num(r.floor_order) }));
}
