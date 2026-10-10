/**
 * Read model of the project home (T18, PLAN §5): the levels table for one project. Reads only
 * (writes go through `Store.apply`); no React or Expo imports, so it is tested in Node over
 * `BetterSqliteDriver`. Everything comes from the local store, so it works offline.
 */

import type { Store } from '@field-survey/core';

export type CacheState = 'cached' | 'downloading' | 'not cached' | 'no sheet';

export type HomeLevel = {
  id: string;
  code: string;
  floorOrder: number | null;
  inScope: boolean;
  /** `setup` until the baseline is locked. */
  state: 'setup' | 'baseline_locked';
  devices: number;
  /** Devices whose status is `Issue` or `Not installed`. */
  issueOrNi: number;
  /** Punch items not `Closed` plus parts not `Installed` (same rule as the plan filter, D99). */
  openItems: number;
  /** Open `review_item`s on the level. */
  reviews: number;
  cache: CacheState;
  assignedToMe: boolean;
};

export type HomeProject = { id: string; name: string; site: string | null };

export type ProjectHome = { project: HomeProject; levels: HomeLevel[] };

type Row = Record<string, unknown>;

/** Live projects in the local store, oldest first. */
export async function listProjects(store: Store): Promise<HomeProject[]> {
  const rows = await store.list<Row>('project', { orderBy: 'created_at' });
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), site: typeof r.site === 'string' ? r.site : null }));
}

async function counts(store: Store, sql: string, params: unknown[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await store.db.query<{ level_id: string; n: number }>(sql, params as never)) out.set(r.level_id, r.n);
  return out;
}

/** The levels table of one project, in floor order; null if the project is unknown. */
export async function loadProjectHome(store: Store, projectId: string, userId: string | null): Promise<ProjectHome | null> {
  const pr = await store.get<Row>('project', projectId);
  if (!pr || pr.deleted_at) return null;

  const levels = await store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });

  const devices = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM device WHERE deleted_at IS NULL GROUP BY level_id`,
    [],
  );
  const issues = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM device
     WHERE deleted_at IS NULL AND status IN ('Issue', 'Not installed') GROUP BY level_id`,
    [],
  );
  const open = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM (
       SELECT d.level_id FROM punch_item p JOIN device d ON d.id = p.device_id
       WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL AND coalesce(p.tracking_status, '') <> 'Closed'
       UNION ALL
       SELECT d.level_id FROM missing_part m JOIN device d ON d.id = m.device_id
       WHERE m.deleted_at IS NULL AND d.deleted_at IS NULL AND coalesce(m.part_status, '') <> 'Installed'
     ) GROUP BY level_id`,
    [],
  );
  const reviews = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM review_item
     WHERE deleted_at IS NULL AND state = 'open' AND level_id IS NOT NULL GROUP BY level_id`,
    [],
  );

  // Cache state of the display sheet: bytes on disk, queued for download, or neither.
  const cacheRows = await store.db.query<{ level_id: string; local_path: string | null; queued: number | null }>(
    `SELECT l.id AS level_id, b.local_path AS local_path,
            (SELECT count(*) FROM blob_queue q
             WHERE q.sha256 = s.blob AND q.direction = 'download' AND q.state IN ('queued', 'active')) AS queued
     FROM level l
     JOIN sheet s ON s.id = l.display_sheet_id AND s.deleted_at IS NULL AND s.blob IS NOT NULL
     LEFT JOIN blob b ON b.sha256 = s.blob
     WHERE l.project_id = ?`,
    [projectId],
  );
  const cache = new Map<string, CacheState>();
  for (const r of cacheRows) cache.set(r.level_id, r.local_path ? 'cached' : r.queued ? 'downloading' : 'not cached');

  const mine = new Set<string>();
  if (userId) {
    for (const a of await store.list<Row>('assignment', { where: 'user_id = ?', params: [userId] })) mine.add(String(a.level_id));
  }

  return {
    project: { id: projectId, name: String(pr.name), site: typeof pr.site === 'string' ? pr.site : null },
    levels: levels.map((l): HomeLevel => {
      const id = String(l.id);
      return {
        id,
        code: String(l.level),
        floorOrder: typeof l.floor_order === 'number' ? l.floor_order : null,
        inScope: l.in_scope !== 0 && l.in_scope !== false,
        state: l.state === 'baseline_locked' ? 'baseline_locked' : 'setup',
        devices: devices.get(id) ?? 0,
        issueOrNi: issues.get(id) ?? 0,
        openItems: open.get(id) ?? 0,
        reviews: reviews.get(id) ?? 0,
        cache: cache.get(id) ?? 'no sheet',
        assignedToMe: mine.has(id),
      };
    }),
  };
}

/** "Assigned to me" keeps only the user's levels. */
export function filterLevels(levels: HomeLevel[], assignedToMeOnly: boolean): HomeLevel[] {
  return assignedToMeOnly ? levels.filter((l) => l.assignedToMe) : levels;
}
