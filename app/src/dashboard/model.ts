/**
 * Dashboard read model (T38, PLAN §5, Phase 3 §7, D17, D181): the export's four Summary tables,
 * drill-down lists behind every count, as-found counts, per-level readiness and the project-wide
 * search. Reads only; no React or Expo imports, so it is tested in Node over `BetterSqliteDriver`.
 *
 * The tables count what `server/app/jobs/export_xlsx.py` counts (`load` + `_counts`): live records
 * on the project's in-scope levels, keyed by level (or owner) and status; a status outside the
 * table's columns (an empty device status = `Unsurveyed`, D110) is in no column and not in Total,
 * as the master's SUMPRODUCT formulas. The rows are loaded once and every count, chart bar and
 * drill-down list is computed from the same rows, so a list always has as many rows as its count.
 */

import { vocab, type Store } from '@field-survey/core';

import { deviceNeedsNeuron, loadNeuronTypes } from '../library/neuron';
import { connectionMatches } from '../plan/lists';

export const UNSURVEYED = 'Unsurveyed';

/** The Summary's device columns, in the export's order (`DEVICE_STATUS_COLUMNS`). */
export const DEVICE_STATUS_COLUMNS = ['Installed, untested', 'Issue', 'Not installed', 'No access', 'Complete'] as const;

export type TableId = 'devices' | 'punchByFloor' | 'punchByOwner' | 'parts';
export type Entity = 'device' | 'punch_item' | 'missing_part';

/** One record behind the tables, already labelled for a list row. */
export type DashRow = {
  entity: Entity;
  id: string;
  levelId: string;
  levelCode: string;
  status: string;
  owner: string | null;
  /** `06M-04`, `#12`; `06M-? NEW` before the server numbers it. */
  label: string;
  text: string;
  /** The device whose card a tap opens (the record itself for a device). */
  deviceId: string | null;
};

export type DashLevel = {
  id: string;
  code: string;
  surveyed: string | null;
  updated: string | null;
};

export type Readiness = {
  levelId: string;
  code: string;
  /** PLAN §2.4: `setup` until the baseline is locked (unreviewed drafts and review items counted), `ready` once locked, `surveying` once any edit lands after the lock. */
  state: 'setup' | 'ready' | 'surveying';
  /** Unreviewed import drafts + open Needs review items on the level. */
  toReview: number;
};

export type AsFound = {
  fieldAdditions: number;
  neverFound: number;
  /** Captured among the devices that need one. */
  neuronCaptured: number;
  /** Devices whose type needs a Neuron ID (T68, D185: not racks or NSPS by default). */
  neuronDevices: number;
  devices: number;
};

export type DashboardData = {
  levels: DashLevel[];
  rows: DashRow[];
  /** Device facts the as-found line counts, by device id. */
  deviceFacts: Map<string, { fieldAddition: boolean; neverFound: boolean; neuron: boolean; needsNeuron: boolean }>;
  readiness: Readiness[];
};

export type DashFilter = { levelId?: string | null; owner?: vocab.Owner | null };

export type SummaryTable = {
  id: TableId;
  title: string;
  keyHeader: 'Floor' | 'Owner';
  keys: string[];
  statuses: readonly string[];
  /** counts[key][status] */
  counts: number[][];
  rowTotals: number[];
  columnTotals: number[];
  total: number;
  /** Surveyed / Updated per key on the device table (the Summary's extra columns). */
  dates?: { surveyed: (string | null)[]; updated: (string | null)[] };
  /** Rows in the table's scope whose status is in no column (Unsurveyed devices, empty statuses). */
  outside: number;
};

/** A tapped count: one table, one key (null = the Total row), one status (null = the Total column). */
export type Drill = { table: TableId; key: string | null; status: string | null } | { table: 'asFound'; key: 'fieldAdditions' | 'neverFound' | 'neuronMissing'; status: null };

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const join = (...parts: unknown[]) => parts.map(str).filter(Boolean).join(' · ');

/** Levels as the export orders them: floor order (empty last), then code. */
function byFloor(a: Row, b: Row): number {
  const fa = typeof a.floor_order === 'number' ? a.floor_order : null;
  const fb = typeof b.floor_order === 'number' ? b.floor_order : null;
  if ((fa === null) !== (fb === null)) return fa === null ? 1 : -1;
  if (fa !== null && fb !== null && fa !== fb) return fa - fb;
  return String(a.level) < String(b.level) ? -1 : String(a.level) > String(b.level) ? 1 : 0;
}

export async function loadDashboard(store: Store, projectId: string): Promise<DashboardData> {
  const all = await store.db.query<Row>(`SELECT * FROM level WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
  const levels = all.filter((l) => l.in_scope !== 0 && l.in_scope !== false).sort(byFloor);
  const code = new Map(levels.map((l) => [String(l.id), String(l.level)] as const));
  const ids = [...code.keys()];
  const inLevels = `level_id IN (SELECT id FROM level WHERE project_id = ? AND deleted_at IS NULL AND in_scope <> 0)`;

  const rows: DashRow[] = [];
  const deviceFacts: DashboardData['deviceFacts'] = new Map();
  const devices = await store.db.query<Row>(`SELECT * FROM device WHERE deleted_at IS NULL AND ${inLevels}`, [projectId]);
  const deviceLabel = new Map<string, string>();
  const types = await loadNeuronTypes(store, projectId);
  for (const d of devices) {
    const levelId = String(d.level_id);
    const label = str(d.display_id) ?? `${code.get(levelId)}-? NEW`;
    deviceLabel.set(String(d.id), label);
    rows.push({ entity: 'device', id: String(d.id), levelId, levelCode: code.get(levelId)!, status: str(d.status) ?? UNSURVEYED, owner: null, label, text: join(d.device ?? d.type ?? d.category, d.room_location), deviceId: String(d.id) });
    deviceFacts.set(String(d.id), { fieldAddition: d.origin === 'field_addition', neverFound: d.found_on_site === 0 || d.found_on_site === false, neuron: !!str(d.neuron_id), needsNeuron: deviceNeedsNeuron(types, d) });
  }
  const punches = await store.db.query<Row>(`SELECT * FROM punch_item WHERE deleted_at IS NULL AND ${inLevels}`, [projectId]);
  for (const p of punches) {
    const levelId = String(p.level_id);
    const dev = str(p.device_id);
    rows.push({
      entity: 'punch_item',
      id: String(p.id),
      levelId,
      levelCode: code.get(levelId)!,
      status: str(p.tracking_status) ?? '',
      owner: str(p.owner),
      label: typeof p.number === 'number' ? `#${p.number}` : 'NEW',
      text: join((dev && deviceLabel.get(dev)) ?? p.device_text, p.item),
      deviceId: dev,
    });
  }
  const parts = await store.db.query<Row>(`SELECT * FROM missing_part WHERE deleted_at IS NULL AND ${inLevels}`, [projectId]);
  for (const p of parts) {
    const levelId = String(p.level_id);
    rows.push({
      entity: 'missing_part',
      id: String(p.id),
      levelId,
      levelCode: code.get(levelId)!,
      status: str(p.part_status) ?? '',
      owner: str(p.owner),
      label: typeof p.number === 'number' ? `#${p.number}` : 'NEW',
      text: join(p.device_location, p.part),
      deviceId: str(p.device_id),
    });
  }
  const order = new Map(ids.map((id, i) => [id, i] as const));
  const num = (r: DashRow) => Number(/\d+$/.exec(r.label.replace(/ NEW$/, ''))?.[0] ?? Infinity);
  rows.sort((a, b) => (order.get(a.levelId)! - order.get(b.levelId)!) || num(a) - num(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return {
    levels: levels.map((l) => ({ id: String(l.id), code: String(l.level), surveyed: str(l.surveyed), updated: str(l.updated) })),
    rows,
    deviceFacts,
    readiness: await loadReadiness(store, levels),
  };
}

async function loadReadiness(store: Store, levels: Row[]): Promise<Readiness[]> {
  const out: Readiness[] = [];
  for (const l of levels) {
    const id = String(l.id);
    const [review] = await store.db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM draft_device WHERE level_id = ? AND deleted_at IS NULL AND state = 'proposed')
            + (SELECT count(*) FROM draft_cable WHERE level_id = ? AND deleted_at IS NULL AND state = 'proposed')
            + (SELECT count(*) FROM review_item WHERE level_id = ? AND deleted_at IS NULL AND state = 'open') AS n`,
      [id, id, id],
    );
    const toReview = review?.n ?? 0;
    let state: Readiness['state'] = 'setup';
    const lockedAt = str(l.baseline_locked_at);
    if (l.state === 'baseline_locked' && lockedAt) {
      // As-found = any edit to the level's records after the lock (PLAN §2.4); ops in review or refused never changed anything.
      const [hit] = await store.db.query<{ n: number }>(
        `SELECT count(*) AS n FROM op o
         WHERE o.client_ts > ? AND o.state IN ('applied', 'pending') AND o.entity_id IN (
           SELECT id FROM device WHERE level_id = ? UNION ALL SELECT id FROM cable_end WHERE level_id = ?
           UNION ALL SELECT id FROM punch_item WHERE level_id = ? UNION ALL SELECT id FROM missing_part WHERE level_id = ?
           UNION ALL SELECT id FROM photo WHERE level_id = ?)`,
        [lockedAt, id, id, id, id, id],
      );
      state = (hit?.n ?? 0) > 0 ? 'surveying' : 'ready';
    }
    out.push({ levelId: id, code: String(l.level), state, toReview });
  }
  return out;
}

// ------------------------------------------------------------------ tables

const TABLES: readonly { id: TableId; title: string; entity: Entity; by: 'level' | 'owner'; statuses: readonly string[] }[] = [
  { id: 'devices', title: 'Device status by floor', entity: 'device', by: 'level', statuses: DEVICE_STATUS_COLUMNS },
  { id: 'punchByFloor', title: 'Outstanding items by floor', entity: 'punch_item', by: 'level', statuses: vocab.TRACKING_STATUS },
  { id: 'punchByOwner', title: 'Outstanding items by owner', entity: 'punch_item', by: 'owner', statuses: vocab.TRACKING_STATUS },
  { id: 'parts', title: 'Missing parts by floor', entity: 'missing_part', by: 'level', statuses: vocab.PART_STATUS },
];

export const TABLE_TITLE: Record<TableId, string> = Object.fromEntries(TABLES.map((t) => [t.id, t.title])) as Record<TableId, string>;

/** Rows of one table under the filter: level filter on every table, owner filter (exact, D181) on punch items and parts. */
function scoped(data: DashboardData, entity: Entity, f: DashFilter): DashRow[] {
  return data.rows.filter((r) => r.entity === entity && (!f.levelId || r.levelId === f.levelId) && (!f.owner || entity === 'device' || r.owner === f.owner));
}

export function summaryTables(data: DashboardData, f: DashFilter = {}): SummaryTable[] {
  const levels = f.levelId ? data.levels.filter((l) => l.id === f.levelId) : data.levels;
  return TABLES.map((t) => {
    const keys = t.by === 'level' ? levels.map((l) => l.code) : [...vocab.OWNER];
    const counts = keys.map(() => t.statuses.map(() => 0));
    let outside = 0;
    for (const r of scoped(data, t.entity, f)) {
      const k = keys.indexOf(t.by === 'level' ? r.levelCode : (r.owner ?? ''));
      const s = t.statuses.indexOf(r.status);
      if (k < 0 || s < 0) {
        outside++;
        continue;
      }
      counts[k]![s]!++;
    }
    const rowTotals = counts.map((c) => c.reduce((a, b) => a + b, 0));
    const columnTotals = t.statuses.map((_, s) => counts.reduce((a, c) => a + c[s]!, 0));
    return {
      id: t.id,
      title: t.title,
      keyHeader: t.by === 'level' ? 'Floor' : 'Owner',
      keys,
      statuses: t.statuses,
      counts,
      rowTotals,
      columnTotals,
      total: rowTotals.reduce((a, b) => a + b, 0),
      ...(t.id === 'devices' ? { dates: { surveyed: levels.map((l) => l.surveyed), updated: levels.map((l) => l.updated) } } : {}),
      outside,
    };
  });
}

/** The records behind a tapped count, in the export's order. */
export function drillRows(data: DashboardData, d: Drill, f: DashFilter = {}): DashRow[] {
  if (d.table === 'asFound') {
    return scoped(data, 'device', f).filter((r) => {
      const x = data.deviceFacts.get(r.id)!;
      return d.key === 'fieldAdditions' ? x.fieldAddition : d.key === 'neverFound' ? x.neverFound : x.needsNeuron && !x.neuron;
    });
  }
  const t = TABLES.find((x) => x.id === d.table)!;
  return scoped(data, t.entity, f).filter(
    (r) =>
      (d.status === null ? t.statuses.includes(r.status) : r.status === d.status) &&
      (d.key === null || (t.by === 'level' ? r.levelCode === d.key : r.owner === d.key)),
  );
}

export function drillTitle(d: Drill): string {
  if (d.table === 'asFound') return d.key === 'fieldAdditions' ? 'Field additions' : d.key === 'neverFound' ? 'Never found' : 'Devices without a Neuron ID';
  return [TABLE_TITLE[d.table], d.key ?? 'All', d.status ?? 'Total'].join(' · ');
}

export function asFound(data: DashboardData, f: DashFilter = {}): AsFound {
  const out: AsFound = { fieldAdditions: 0, neverFound: 0, neuronCaptured: 0, neuronDevices: 0, devices: 0 };
  for (const r of scoped(data, 'device', f)) {
    const x = data.deviceFacts.get(r.id)!;
    out.devices++;
    if (x.fieldAddition) out.fieldAdditions++;
    if (x.neverFound) out.neverFound++;
    if (x.needsNeuron) {
      out.neuronDevices++;
      if (x.neuron) out.neuronCaptured++;
    }
  }
  return out;
}

/** "06M surveying · 03 ready · 07 setup (5 review)" */
export function readinessLine(r: readonly Readiness[]): string {
  return r.map((x) => `${x.code} ${x.state}${x.toReview ? ` (${x.toReview} review)` : ''}`).join(' · ');
}

/** One chart bar per key (`i` = index into `t.keys`, the x label): the counts by status, for a stacked bar. */
export function chartData(t: SummaryTable): Record<string, number>[] {
  return t.keys.map((_, i) => Object.fromEntries([['i', i], ...t.statuses.map((s, j) => [s, t.counts[i]![j]!])]) as Record<string, number>);
}

// ------------------------------------------------------------------ search

export type SearchKind = 'device' | 'cable_end' | 'punch_item' | 'missing_part' | 'photo';
export const SEARCH_GROUPS: readonly { kind: SearchKind; title: string }[] = [
  { kind: 'device', title: 'Devices' },
  { kind: 'cable_end', title: 'Connections' },
  { kind: 'punch_item', title: 'Punch' },
  { kind: 'missing_part', title: 'Parts' },
  { kind: 'photo', title: 'Photos' },
];

export type SearchResult = { kind: SearchKind; id: string; levelId: string | null; levelCode: string; label: string; text: string; deviceId: string | null };
export type SearchGroup = { kind: SearchKind; title: string; results: SearchResult[] };

/**
 * Project-wide search (Phase 3 §7): FTS (or its LIKE fallback) over devices, punch items, parts
 * and photos — ID, tag, room, item text, notes, Neuron ID — and, as the plan's side lists do
 * (connections are not in the index), a text match over connection ends with T88's term rules:
 * a cable code term means that code, a `C-nn` / number term that connection number exactly.
 * Every level of the project, in scope or not; groups in the wireframe's order, empty ones left out.
 */
export async function searchProject(store: Store, projectId: string, query: string, limit = 2000): Promise<SearchGroup[]> {
  const q = query.trim();
  if (!q) return [];
  const levels = new Map((await store.db.query<Row>(`SELECT id, level FROM level WHERE project_id = ?`, [projectId])).map((l) => [String(l.id), String(l.level)] as const));
  const hits = await store.search(q, { projectId, limit });
  const byKind = new Map<string, string[]>();
  for (const h of hits) byKind.set(h.entity_kind, [...(byKind.get(h.entity_kind) ?? []), h.entity_id]);
  const fetch = async (table: string, ids: readonly string[]) => {
    if (!ids.length) return [] as Row[];
    const got = new Map((await store.db.query<Row>(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, [...ids])).map((r) => [String(r.id), r] as const));
    return ids.map((id) => got.get(id)).filter((r): r is Row => !!r && !r.deleted_at);
  };
  const lvl = (r: Row) => ({ levelId: str(r.level_id), levelCode: levels.get(String(r.level_id)) ?? '' });
  const numbered = (r: Row) => (typeof r.number === 'number' ? `#${r.number}` : 'NEW');
  const out: Record<SearchKind, SearchResult[]> = { device: [], cable_end: [], punch_item: [], missing_part: [], photo: [] };
  for (const d of await fetch('device', byKind.get('device') ?? [])) {
    const l = lvl(d);
    out.device.push({ kind: 'device', id: String(d.id), ...l, label: str(d.display_id) ?? `${l.levelCode}-? NEW`, text: join(d.device ?? d.type ?? d.category, d.room_location, d.neuron_id && `Neuron ${String(d.neuron_id)}`, d.notes), deviceId: String(d.id) });
  }
  for (const p of await fetch('punch_item', byKind.get('punch_item') ?? [])) out.punch_item.push({ kind: 'punch_item', id: String(p.id), ...lvl(p), label: numbered(p), text: join(p.item, p.owner, p.tracking_status, p.notes), deviceId: str(p.device_id) });
  for (const p of await fetch('missing_part', byKind.get('missing_part') ?? [])) out.missing_part.push({ kind: 'missing_part', id: String(p.id), ...lvl(p), label: numbered(p), text: join(p.device_location, p.part, p.part_status, p.notes), deviceId: str(p.device_id) });
  for (const p of await fetch('photo', byKind.get('photo') ?? [])) out.photo.push({ kind: 'photo', id: String(p.id), ...lvl(p), label: numbered(p), text: join(p.subject, p.location, p.what_it_shows), deviceId: str(p.device_id) });

  const ends = await store.db.query<Row>(
    `SELECT e.id, e.level_id, e.display_id, e.device_id, e.from_text, e.to_text, e.note, e.status, c.cable
     FROM cable_end e JOIN cable c ON c.id = e.cable_id AND c.deleted_at IS NULL
     WHERE e.deleted_at IS NULL AND c.project_id = ?`,
    [projectId],
  );
  const terms = q.toLowerCase().split(/\s+/);
  for (const e of ends) {
    const label = str(e.display_id) ?? 'NEW';
    const text = join(e.from_text, e.cable, e.to_text, e.status, e.note);
    if (!connectionMatches(terms, { cable: str(e.cable), label, text: `${label} ${text}`.toLowerCase() })) continue;
    out.cable_end.push({ kind: 'cable_end', id: String(e.id), ...lvl(e), label, text, deviceId: str(e.device_id) });
    if (out.cable_end.length >= limit) break;
  }
  // Within a group: floor order, then the number, as the lists and the export read.
  const floors = (await store.db.query<Row>(`SELECT id, level, floor_order FROM level WHERE project_id = ?`, [projectId])).sort(byFloor);
  const order = new Map(floors.map((l, i) => [String(l.id), i] as const));
  const num = (r: SearchResult) => Number(/(\d+)(?: NEW)?$/.exec(r.label)?.[1] ?? Infinity);
  const cmp = (a: SearchResult, b: SearchResult) =>
    (order.get(a.levelId ?? '') ?? Infinity) - (order.get(b.levelId ?? '') ?? Infinity) || num(a) - num(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return SEARCH_GROUPS.map((g) => ({ ...g, results: out[g.kind].sort(cmp) })).filter((g) => g.results.length > 0);
}
