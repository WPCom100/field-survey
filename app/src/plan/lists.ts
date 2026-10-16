/**
 * Read model of the side lists (T19, Phase 3 §4.2): connections, punch items and missing parts of
 * one level beside the devices of `loadLevelPlan`, with the record badges of Phase 3 §2.3 and
 * the plan filters (D99) applied to every tab. Reads only; no React or Expo imports.
 *
 * Filter semantics on the other tabs (D108): a row inherits its device's Category and Status
 * (a connection uses its own end status, `Not started` counting as Unsurveyed (D110)); Owner is
 * the item's own for punch and parts and the device's open owners for a connection; Open punch
 * is "this item is open" for punch and parts and "the device has an open punch item" for a
 * connection. Rows without a device match only when Category is not being filtered.
 */

import { displayNumber, isNew, punchDeviceText, type Store } from '@field-survey/core';

import type { PlanDevice } from './data';
import { ownerMatches, statusKey, type PlanFilter } from './filters';

/** Cable codes (CLAUDE.md §3). A search term equal to one matches the cable type exactly. */
export const CABLE_CODES: readonly string[] = ['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V', 'D'];

export type Tab = 'devices' | 'connections' | 'punch' | 'parts';
export const TABS: readonly Tab[] = ['devices', 'connections', 'punch', 'parts'];
export const TAB_LABEL: Record<Tab, string> = { devices: 'Devices', connections: 'Conns', punch: 'Punch', parts: 'Parts' };

/** Record badges (Phase 3 §2.3). `pending` is the `↑n` count of unsynced ops. */
export type Badges = { isNew: boolean; pending: number; inReview: boolean; draft: boolean; deleted: boolean };
export const NO_BADGES: Badges = { isNew: false, pending: 0, inReview: false, draft: false, deleted: false };

export type ListRow = {
  id: string;
  tab: Exclude<Tab, 'devices'>;
  /** `C-07`, `12`, or `NEW` (never a guess, D25). */
  label: string;
  title: string;
  sub: string;
  deviceId: string | null;
  badges: Badges;
  /** The end's own status (connections); null for punch and parts. */
  endStatus: string | null;
  open: boolean;
  owner: string | null;
  /** Filter inputs inherited from the device. */
  category: string | null;
  deviceStatus: string | null;
  deviceOwners: readonly string[];
  deviceOpenPunch: number;
  /** Cable code of a connection (`N`, `NG`, `0-10V`…); null for punch and parts. */
  cable: string | null;
  /** Lower-cased text the in-memory search matches (connections are not in the FTS index). */
  text: string;
};

export type LevelLists = {
  /** Badges of the level's devices, by id. */
  deviceBadges: Map<string, Badges>;
  connections: ListRow[];
  punch: ListRow[];
  parts: ListRow[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Badge sources: unsynced ops, open reviews, proposed drafts (by subject record id). */
async function loadBadgeSources(store: Store, projectId: string) {
  const pending = new Map<string, number>();
  for (const r of await store.db.query<{ entity_id: string; n: number }>(
    `SELECT entity_id, count(*) AS n FROM op WHERE project_id = ? AND state = 'pending' AND server_seq IS NULL GROUP BY entity_id`,
    [projectId],
  )) {
    pending.set(r.entity_id, r.n);
  }
  const review = new Set<string>();
  for (const r of await store.db.query<{ id: string | null }>(
    `SELECT json_extract(subject, '$.entity_id') AS id FROM review_item WHERE state = 'open' AND project_id = ?`,
    [projectId],
  )) {
    if (r.id) review.add(r.id);
  }
  const draft = new Set<string>();
  for (const r of await store.db.query<{ id: string | null }>(
    `SELECT json_extract(subject, '$.entity_id') AS id FROM proposal
     WHERE state = 'proposed' AND deleted_at IS NULL AND project_id = ?`,
    [projectId],
  )) {
    if (r.id) draft.add(r.id);
  }
  return { pending, review, draft };
}

export async function loadLevelLists(
  store: Store,
  projectId: string,
  levelId: string,
  levelCode: string,
  devices: readonly PlanDevice[],
  opts: { includeDeleted?: boolean } = {},
): Promise<LevelLists> {
  const src = await loadBadgeSources(store, projectId);
  const byDevice = new Map(devices.map((d) => [d.id, d]));
  const badgesOf = (id: string, isNewRecord: boolean, deleted: boolean): Badges => ({
    isNew: isNewRecord,
    pending: src.pending.get(id) ?? 0,
    inReview: src.review.has(id),
    draft: src.draft.has(id),
    deleted,
  });

  const deviceBadges = new Map<string, Badges>();
  for (const d of devices) deviceBadges.set(d.id, badgesOf(d.id, d.isNew, d.deleted));

  const inherit = (deviceId: string | null) => {
    const d = deviceId ? byDevice.get(deviceId) : undefined;
    return {
      deviceId,
      deviceLabel: d?.label ?? null,
      category: d?.category ?? null,
      deviceStatus: d?.status ?? null,
      deviceOwners: d?.openOwners ?? [],
      deviceOpenPunch: d?.openPunch ?? 0,
    };
  };
  const includeDeleted = opts.includeDeleted;
  const withText = (row: Omit<ListRow, 'text'>, extra: (string | null)[]): ListRow => ({
    ...row,
    text: [row.label, row.title, row.sub, ...extra].filter(Boolean).join(' ').toLowerCase(),
  });

  // --- connections: the ends on this level, titled with their cable code
  const ends = await store.list<Row>('cable_end', { where: 'level_id = ?', params: [levelId], includeDeleted });
  const cableIds = [...new Set(ends.map((e) => String(e.cable_id)))];
  const cables = new Map<string, Row>();
  if (cableIds.length) {
    const marks = cableIds.map(() => '?').join(',');
    for (const c of await store.db.query<Row>(`SELECT id, cable, deleted_at FROM cable WHERE id IN (${marks})`, cableIds)) {
      cables.set(String(c.id), c);
    }
  }
  const connections = ends.map((e): ListRow => {
    const id = String(e.id);
    const cable = cables.get(String(e.cable_id));
    const dev = inherit(str(e.device_id));
    const { deviceLabel, ...inherited } = dev;
    return withText(
      {
        id,
        tab: 'connections',
        label: displayNumber('cable_end', e),
        title: [str(cable?.cable), str(e.to_text) ?? str(e.from_text)].filter(Boolean).join(' → ') || '(no text yet)',
        sub: [deviceLabel, str(e.status) ?? 'Not started'].filter(Boolean).join(' · '),
        ...inherited,
        badges: badgesOf(id, isNew('cable_end', e), !!e.deleted_at || !!cable?.deleted_at),
        cable: str(cable?.cable),
        endStatus: str(e.status),
        open: true,
        owner: null,
      },
      [str(e.note)],
    );
  });

  // --- punch items and missing parts
  // A punch item's Device text follows its device (D148); an unlinked one shows the master's (D150).
  const deviceRows = new Map(
    (await store.list<Row>('device', { where: 'level_id = ?', params: [levelId], includeDeleted: true })).map((d) => [String(d.id), d]),
  );
  const punch = (await store.list<Row>('punch_item', { where: 'level_id = ?', params: [levelId], includeDeleted })).map((p): ListRow => {
    const id = String(p.id);
    const { deviceLabel, ...inherited } = inherit(str(p.device_id));
    const linked = str(p.device_id) ? deviceRows.get(String(p.device_id)) : undefined;
    const deviceText = punchDeviceText(p, linked && !linked.deleted_at ? linked : null);
    return withText(
      {
        id,
        tab: 'punch',
        label: displayNumber('punch_item', p),
        title: str(p.item) ?? '(no text)',
        sub: [deviceLabel, deviceText, str(p.type), str(p.owner), str(p.tracking_status) ?? 'Open'].filter(Boolean).join(' · '),
        ...inherited,
        badges: badgesOf(id, isNew('punch_item', p), !!p.deleted_at),
        cable: null,
        endStatus: null,
        open: str(p.tracking_status) !== 'Closed',
        owner: str(p.owner),
      },
      [str(p.notes)],
    );
  });
  const parts = (await store.list<Row>('missing_part', { where: 'level_id = ?', params: [levelId], includeDeleted })).map((m): ListRow => {
    const id = String(m.id);
    const { deviceLabel, ...inherited } = inherit(str(m.device_id));
    return withText(
      {
        id,
        tab: 'parts',
        label: displayNumber('missing_part', m),
        title: [str(m.part), m.qty != null ? `×${String(m.qty)}` : null].filter(Boolean).join(' ') || '(no part)',
        sub: [deviceLabel ?? str(m.device_location), str(m.owner), str(m.part_status) ?? 'Needed'].filter(Boolean).join(' · '),
        ...inherited,
        badges: badgesOf(id, isNew('missing_part', m), !!m.deleted_at),
        cable: null,
        endStatus: null,
        open: str(m.part_status) !== 'Installed',
        owner: str(m.owner),
      },
      [str(m.notes), str(m.part_no)],
    );
  });

  // Connections by their C-nn; punch and parts by number, NEW rows (no number yet) last.
  const byLabel = (a: ListRow, b: ListRow) =>
    Number(a.label === 'NEW') - Number(b.label === 'NEW') ||
    a.label.localeCompare(b.label, 'en', { numeric: true }) ||
    a.id.localeCompare(b.id);
  connections.sort(byLabel);
  punch.sort(byLabel);
  parts.sort(byLabel);

  return { deviceBadges, connections, punch, parts };
}

/** The plan filters (D99) applied to a non-device row; see the file header for the rules. */
export function rowMatches(row: ListRow, f: PlanFilter): boolean {
  if (f.categories.length && !f.categories.includes(row.category ?? '')) return false;
  if (f.statuses.length) {
    // A connection's `Not started` is Unsurveyed; statusKey maps anything unknown to it.
    const key = statusKey(row.tab === 'connections' ? row.endStatus : row.deviceStatus);
    if (!f.statuses.includes(key)) return false;
  }
  if (f.owners.length) {
    const owners = row.tab === 'connections' ? row.deviceOwners : row.owner ? [row.owner] : [];
    if (!owners.some((o) => ownerMatches(f.owners, o))) return false;
  }
  if (f.openPunch && !(row.tab === 'connections' ? row.deviceOpenPunch > 0 : row.open)) return false;
  return true;
}

/**
 * Ids matching a search on this level: FTS (or the LIKE fallback) for devices, punch and parts,
 * a text match for connections (not in the index). `null` means no query, so no restriction.
 */
export async function searchIds(
  store: Store,
  levelId: string,
  query: string,
  connections: readonly ListRow[],
): Promise<Set<string> | null> {
  const q = query.trim();
  if (!q) return null;
  const hits = await store.search(q, { levelId, limit: 5000 });
  const ids = new Set(hits.map((h) => h.entity_id));
  const terms = q.toLowerCase().split(/\s+/);
  for (const c of connections) if (connectionMatches(terms, c)) ids.add(c.id);
  return ids;
}

/**
 * Does a connection row match every search term? Shared by the side lists and the dashboard's
 * project search (T38). `text` is the row's lower-case searched text.
 */
export function connectionMatches(terms: readonly string[], c: { cable: string | null; label: string; text: string }): boolean {
  return terms.every((t) => {
    // A term that is a cable code ("n", "ng", "0-10v") means that cable type, not the letter anywhere.
    if (CABLE_CODES.some((k) => k.toLowerCase() === t)) return c.cable?.toLowerCase() === t;
    // A term shaped like a connection number ("c-14", "c14", "14") means that C-nn exactly (D163), so
    // "14" does not find C-140 or a "14" inside the text. A NEW end has no number and never matches.
    const n = /^(?:c-?)?(\d+)$/.exec(t)?.[1];
    if (n !== undefined) {
      const own = /^C-(\d+)$/.exec(c.label)?.[1];
      return own !== undefined && Number(own) === Number(n);
    }
    return c.text.includes(t);
  });
}
