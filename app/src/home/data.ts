/**
 * Read model of the project home (T18, PLAN §5; the shell's tiles, pills and level lines, T176):
 * the levels table for one project. Reads only
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
  /** Devices with a status (the rest are `Unsurveyed`, D110). */
  surveyed: number;
  /** Punch items not `Closed`, and `Closed` ones (the Open punch items tile). */
  openPunch: number;
  closedPunch: number;
  cache: CacheState;
  assignedToMe: boolean;
  /** Codes of the earlier levels in its numbering group ("shares numbers with 06", D33). */
  sharesWith: string[];
};

export type HomeProject = { id: string; name: string; site: string | null };

export type ProjectHome = {
  project: HomeProject;
  levels: HomeLevel[];
  /** Open `review_item`s of the project, level or not (the Needs review pill and tile). */
  reviewOpen: number;
  /** Open lint findings of the project (the Lint pill). */
  lintOpen: number;
};

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
  const surveyed = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM device
     WHERE deleted_at IS NULL AND coalesce(status, '') <> '' GROUP BY level_id`,
    [],
  );
  const punchSql = (closed: boolean) =>
    `SELECT d.level_id AS level_id, count(*) AS n FROM punch_item p JOIN device d ON d.id = p.device_id
     WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL AND coalesce(p.tracking_status, '') ${closed ? '=' : '<>'} 'Closed'
     GROUP BY d.level_id`;
  const openPunch = await counts(store, punchSql(false), []);
  const closedPunch = await counts(store, punchSql(true), []);
  const projectCount = async (sql: string) => (await store.db.query<{ n: number }>(sql, [projectId] as never))[0]?.n ?? 0;
  const reviewOpen = await projectCount(`SELECT count(*) AS n FROM review_item WHERE deleted_at IS NULL AND state = 'open' AND project_id = ?`);
  const lintOpen = await projectCount(`SELECT count(*) AS n FROM finding WHERE state = 'open' AND project_id = ?`);

  // Levels sharing a numbering group (06 / 06M, D33): each names the ones before it in floor order.
  const before = new Map<string, string[]>();
  const seen = new Map<string, string[]>();
  for (const l of levels) {
    const group = typeof l.numbering_group_id === 'string' ? l.numbering_group_id : null;
    if (!group) continue;
    const earlier = seen.get(group) ?? [];
    before.set(String(l.id), [...earlier]);
    seen.set(group, [...earlier, String(l.level)]);
  }

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
        surveyed: surveyed.get(id) ?? 0,
        openPunch: openPunch.get(id) ?? 0,
        closedPunch: closedPunch.get(id) ?? 0,
        cache: cache.get(id) ?? 'no sheet',
        assignedToMe: mine.has(id),
        sharesWith: before.get(id) ?? [],
      };
    }),
    reviewOpen,
    lintOpen,
  };
}

// ------------------------------------------------------------- the shell (T176)

export type ShellNavData = { projectId: string; projectName: string; reviewOpen: number; lintOpen: number };

/**
 * What the rail and its sidebar overlay show for a project (the plan's, T177; every section
 * screen's, T189): its name and the two count pills; null for a project not on this iPad or deleted.
 */
export async function loadProjectShellNav(store: Store, projectId: string): Promise<ShellNavData | null> {
  const pr = await store.get<Row>('project', projectId);
  if (!pr || pr.deleted_at) return null;
  const projectCount = async (sql: string) => (await store.db.query<{ n: number }>(sql, [projectId] as never))[0]?.n ?? 0;
  return {
    projectId,
    projectName: String(pr.name),
    reviewOpen: await projectCount(`SELECT count(*) AS n FROM review_item WHERE deleted_at IS NULL AND state = 'open' AND project_id = ?`),
    lintOpen: await projectCount(`SELECT count(*) AS n FROM finding WHERE state = 'open' AND project_id = ?`),
  };
}

/** "Basement 2", "Level 1", "Level 6 mezzanine" from the level code; null for any other code. */
export function levelName(code: string): string | null {
  let m = /^B(\d+)$/i.exec(code);
  if (m) return `Basement ${Number(m[1])}`;
  m = /^(\d+)$/.exec(code);
  if (m) return `Level ${Number(m[1])}`;
  m = /^(\d+)M$/i.exec(code);
  if (m) return `Level ${Number(m[1])} mezzanine`;
  return null;
}

/** The line under a level's code: "Level 6 mezzanine · shares numbers with 06", "Level 1 · assigned to me". */
export function levelSubline(l: Pick<HomeLevel, 'code' | 'assignedToMe' | 'sharesWith' | 'inScope'>): string {
  const parts = [levelName(l.code)];
  if (l.assignedToMe) parts.push('assigned to me');
  if (l.sharesWith.length) parts.push(`shares numbers with ${l.sharesWith.join(', ')}`);
  if (!l.inScope) parts.push('out of scope');
  return parts.filter(Boolean).join(' · ');
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The caption under the project name: "9 levels · B2 to 07 · 6 locked". */
export function homeSummary(levels: readonly Pick<HomeLevel, 'code' | 'state'>[]): string {
  if (!levels.length) return '0 levels';
  const first = levels[0]!.code;
  const last = levels[levels.length - 1]!.code;
  const locked = levels.filter((l) => l.state === 'baseline_locked').length;
  return [count(levels.length, 'level'), first === last ? first : `${first} to ${last}`, `${locked} locked`].join(' · ');
}

/** "on B1", "on B1 and 01", "on 3 levels". */
function onLevels(codes: readonly string[]): string {
  if (codes.length === 1) return `on ${codes[0]}`;
  if (codes.length === 2) return `on ${codes[0]} and ${codes[1]}`;
  return `on ${count(codes.length, 'level')}`;
}

export type HomeTile = { key: 'devices' | 'issues' | 'punch' | 'review'; label: string; value: number; sub: string; tone: 'text' | 'danger' | 'warning' };

/** The four tiles over the table: sums over the levels (and the project's open reviews). */
export function homeTiles(home: Pick<ProjectHome, 'levels' | 'reviewOpen'>): HomeTile[] {
  const sum = (f: (l: HomeLevel) => number) => home.levels.reduce((n, l) => n + f(l), 0);
  const issues = sum((l) => l.issueOrNi);
  const reviewLevels = home.levels.filter((l) => l.reviews > 0).map((l) => l.code);
  return [
    { key: 'devices', label: 'Devices', value: sum((l) => l.devices), sub: `${sum((l) => l.surveyed)} surveyed`, tone: 'text' },
    { key: 'issues', label: 'Issue or not installed', value: issues, sub: `on ${count(home.levels.filter((l) => l.issueOrNi > 0).length, 'level')}`, tone: issues ? 'danger' : 'text' },
    { key: 'punch', label: 'Open punch items', value: sum((l) => l.openPunch), sub: `${sum((l) => l.closedPunch)} closed`, tone: 'text' },
    { key: 'review', label: 'Needs review', value: home.reviewOpen, sub: reviewLevels.length ? onLevels(reviewLevels) : 'on 0 levels', tone: home.reviewOpen ? 'warning' : 'text' },
  ];
}

/** "Assigned to me" keeps only the user's levels. */
export function filterLevels(levels: HomeLevel[], assignedToMeOnly: boolean): HomeLevel[] {
  return assignedToMeOnly ? levels.filter((l) => l.assignedToMe) : levels;
}
