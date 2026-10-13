/**
 * The Export screen's model (T31, Phase 3 §11, PLAN §8 `/exports`): the D94 gate, the pre-flight
 * counts from the local store, the request body, the server calls and the history list (cached
 * on the iPad so earlier files stay listed offline). No React or Expo imports: tested in Node.
 *
 * Exports are server jobs over the server's tables (D18, D137): the iPad never builds one from
 * its local store (D94), it only asks, follows the job and downloads the finished file.
 */

import { HttpClient, openReviewItems, type Store, type SyncStatus } from '@field-survey/core';

import type { Identity } from '../identity/api';

export type ExportKind = 'xlsx' | 'floor_pdf';
export const KIND_LABEL: Record<ExportKind, string> = { xlsx: 'Master workbook', floor_pdf: 'Floor PDF' };

/** The workbook's data tabs, in workbook order; Summary and Lists are always written (D141). */
export const DATA_TABS = ['Devices', 'Connections', 'Punch List', 'Missing Parts', 'Photo Log'] as const;
export type DataTab = (typeof DATA_TABS)[number];
export const FIXED_TABS = ['Summary', 'Lists'] as const;

export type ExportState = 'queued' | 'running' | 'done' | 'failed';
export type TabDiff = { rows: number; added: number; removed: number; changed: number; examples: string[] };
export type ExportRow = {
  id: string;
  project_id: string;
  kind: ExportKind;
  params: { levels?: string[]; tabs?: string[]; level?: string; sections?: string[]; scheduled?: boolean; [k: string]: unknown } | null;
  job_state: ExportState;
  blob: string | null;
  filename: string | null;
  stats: {
    rows?: Record<string, number>;
    levels?: string[];
    bytes?: number;
    seconds?: number;
    error?: string;
    images_missing?: number;
    checks_list?: string[];
    [k: string]: unknown;
  } | null;
  diff_summary: { previous?: string; note?: string; tabs?: Record<string, TabDiff> } | null;
  created_by_id: string | null;
  created_at: string | null;
};

// ------------------------------------------------------------------ D94 gate

export type Gate = { ok: boolean; reason: string };

/**
 * *Start* is enabled only when the last sync cycle reached the server ("Synced") and nothing is
 * waiting in the outbox (D94). Anything else names what to do instead.
 */
export function startGate(s: SyncStatus): Gate {
  if (s.state === 'no_token') return { ok: false, reason: 'Not connected to the server. Connect on the Sync screen first.' };
  if (s.state === 'offline') return { ok: false, reason: 'Offline. Exports run on the server and need a connection.' };
  if (s.state === 'error') return { ok: false, reason: `Sync error: ${s.lastError ?? 'unknown'}. Sync first.` };
  if (s.state === 'syncing') return { ok: false, reason: 'Syncing… wait for "Synced".' };
  if (!s.lastSyncAt) return { ok: false, reason: 'Not synced yet. Sync first.' };
  if (s.pendingOps > 0) {
    return { ok: false, reason: `${s.pendingOps} edit${s.pendingOps === 1 ? '' : 's'} on this iPad not synced yet. Sync first: the export reads the server's data.` };
  }
  return { ok: true, reason: 'Synced — the export will include every edit on this iPad.' };
}

// ------------------------------------------------------------------ pre-flight

export type ExportLevel = { id: string; code: string; surveyed: string | null };
export type Preflight = {
  /** In-scope levels in floor order (what "All in scope" exports). */
  levels: ExportLevel[];
  /** Open lint findings in the project. */
  lint: number;
  /** Open review items in the project. */
  reviews: number;
};

type Row = Record<string, unknown>;

/** Counts and the level list from the local store (works offline; the gate decides Start). */
export async function loadPreflight(store: Store, projectId: string): Promise<Preflight> {
  const levels = await store.list<Row>('level', {
    where: 'project_id = ? AND in_scope = 1',
    params: [projectId],
    orderBy: 'floor_order, level',
  });
  const [lint] = await store.db.query<{ n: number }>(
    `SELECT count(*) AS n FROM finding WHERE project_id = ? AND state = 'open' AND deleted_at IS NULL`,
    [projectId],
  );
  return {
    levels: levels.map((l) => ({ id: String(l.id), code: String(l.level), surveyed: typeof l.surveyed === 'string' ? l.surveyed : null })),
    lint: Number(lint?.n ?? 0),
    reviews: (await openReviewItems(store, projectId)).length,
  };
}

/** The pre-flight line: "⚠ 3 lint findings · 2 review items open · 14 unsynced edits". */
export function preflightLine(p: Preflight, pendingOps: number, photosWaiting = 0): string {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (p.lint) parts.push(n(p.lint, 'lint finding', 'lint findings'));
  if (p.reviews) parts.push(n(p.reviews, 'review item open', 'review items open'));
  if (pendingOps) parts.push(n(pendingOps, 'unsynced edit on this iPad', 'unsynced edits on this iPad'));
  if (photosWaiting) parts.push(n(photosWaiting, 'photo still uploading (its picture will be missing)', 'photos still uploading (their pictures will be missing)'));
  return parts.length ? `⚠ ${parts.join(' · ')}` : '✓ No lint findings, no open review items, nothing unsynced';
}

// ------------------------------------------------------------------ request

export type WorkbookChoice = { levels: string[] | 'all'; tabs: DataTab[] };

/** `POST /exports` body for the workbook; only what differs from "everything" is sent. */
export function workbookBody(projectId: string, c: WorkbookChoice): { project_id: string; kind: 'xlsx'; params?: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  if (c.levels !== 'all') params.levels = c.levels;
  if (c.tabs.length !== DATA_TABS.length) params.tabs = DATA_TABS.filter((t) => c.tabs.includes(t));
  return { project_id: projectId, kind: 'xlsx', ...(Object.keys(params).length ? { params } : {}) };
}

/** Row 2 of every tab for this choice: "Levels B2-06" (06M folds into 06, D33). */
export function levelsTitle(levels: ExportLevel[], choice: string[] | 'all'): string {
  const codes = choice === 'all' ? levels.map((l) => l.code) : levels.map((l) => l.code).filter((c) => choice.includes(c));
  if (!codes.length) return 'Levels';
  const fold = (c: string) => c.replace(/M$/, '');
  return `Levels ${fold(codes[0]!)}-${fold(codes[codes.length - 1]!)}`;
}

// ------------------------------------------------------------------ floor PDF

/** The floor PDF's sections (T59, Phase 3 §11.2), in report order. */
export const FLOOR_SECTIONS = [
  { key: 'plan', label: 'Plan snapshot with pins' },
  { key: 'findings', label: 'Findings' },
  { key: 'connections', label: 'Connections' },
  { key: 'punch', label: 'Punch list' },
  { key: 'parts', label: 'Missing parts' },
  { key: 'photos', label: 'Photo appendix (markup flattened)' },
] as const;
export type FloorSection = (typeof FLOOR_SECTIONS)[number]['key'];

/** `POST /exports` body for one level's floor PDF; `sections` only when not all. */
export function floorBody(projectId: string, level: string, sections: FloorSection[]): { project_id: string; kind: 'floor_pdf'; params: Record<string, unknown> } {
  const all = FLOOR_SECTIONS.map((s) => s.key);
  const params: Record<string, unknown> = { level };
  if (sections.length !== all.length) params.sections = all.filter((k) => sections.includes(k));
  return { project_id: projectId, kind: 'floor_pdf', params };
}

/** The report's header: the survey date only, never a company name (R7). */
export function floorHeader(level: ExportLevel | undefined, title = 'ETC Lighting Controls Survey'): string {
  if (!level) return title;
  return `${title} — Level ${level.code} · Surveyed ${level.surveyed ?? '—'}`;
}

// ------------------------------------------------------------------ history

export const isFinished = (s: ExportState): boolean => s === 'done' || s === 'failed';

/** "Exported 12 Oct 2026, 14:05" — every history item is labelled with its export time (D94). */
export function exportTime(iso: string | null, locale?: string): string {
  if (!iso) return 'Export time unknown';
  const d = new Date(iso);
  return `Exported ${d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
}

/** One line for the job state. */
export function jobLine(e: ExportRow): string {
  switch (e.job_state) {
    case 'queued':
      return 'Queued — the server starts it within a few seconds';
    case 'running':
      return e.kind === 'floor_pdf' ? 'Building the PDF…' : 'Building the workbook…';
    case 'failed':
      return `Failed: ${e.stats?.error ?? 'see the server log'}`;
    default: {
      const size = e.stats?.bytes ? ` · ${formatSize(e.stats.bytes)}` : '';
      return `Ready${size}`;
    }
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Levels B2-06 · all tabs" / "Level 06M · Devices, Punch List" for a history row. */
export function scopeLine(e: ExportRow): string {
  const lv = e.stats?.levels ?? e.params?.levels ?? (e.params?.level ? [e.params.level] : undefined);
  const levels = !lv?.length ? 'all in-scope levels' : lv.length === 1 ? `Level ${lv[0]}` : `Levels ${lv[0]}-${lv[lv.length - 1]}`;
  const sections = e.params?.sections;
  const tabs =
    e.kind === 'xlsx'
      ? e.params?.tabs?.length
        ? e.params.tabs.join(', ')
        : 'all tabs'
      : sections?.length
        ? FLOOR_SECTIONS.filter((s) => sections.includes(s.key)).map((s) => s.label.split(' (')[0]).join(', ')
        : 'all sections';
  const by = e.params?.scheduled ? ' · daily backup' : '';
  return [levels, tabs].filter(Boolean).join(' · ') + by;
}

/** "Diff vs previous export: +12 rows, −1 row, 31 changed" (null for the first export). */
export function diffLine(e: ExportRow): string | null {
  const d = e.diff_summary;
  if (!d) return e.job_state === 'done' && e.kind === 'xlsx' ? 'First export: nothing to compare with' : null;
  if (d.note) return `Diff vs previous export: ${d.note}`;
  const tabs = Object.values(d.tabs ?? {});
  const added = tabs.reduce((a, t) => a + t.added, 0);
  const removed = tabs.reduce((a, t) => a + t.removed, 0);
  const changed = tabs.reduce((a, t) => a + t.changed, 0);
  if (!added && !removed && !changed) return 'Diff vs previous export: no changes';
  const parts = [];
  if (added) parts.push(`+${added} row${added === 1 ? '' : 's'}`);
  if (removed) parts.push(`−${removed} row${removed === 1 ? '' : 's'}`);
  if (changed) parts.push(`${changed} changed`);
  return `Diff vs previous export: ${parts.join(', ')}`;
}

/** Per-tab detail for the expanded diff. */
export function diffDetail(e: ExportRow): string[] {
  return Object.entries(e.diff_summary?.tabs ?? {})
    .filter(([, t]) => t.added || t.removed || t.changed)
    .map(([tab, t]) => `${tab}: +${t.added} −${t.removed} ~${t.changed}${t.examples.length ? ` (e.g. ${t.examples.join(', ')})` : ''}`);
}

const HISTORY_KEY = (projectId: string) => `export_history:${projectId}`;

/** The last history list fetched for the project (offline view, D94). */
export async function cachedHistory(store: Store, projectId: string): Promise<ExportRow[]> {
  return (await store.getState<ExportRow[]>(HISTORY_KEY(projectId))) ?? [];
}

export async function rememberHistory(store: Store, projectId: string, rows: ExportRow[]): Promise<void> {
  await store.setState(HISTORY_KEY(projectId), rows.slice(0, 100));
}

const DOWNLOADED_KEY = 'export_downloaded';

/** Export ids whose file is on this iPad (named copy in the cache), so they open offline. */
export async function downloadedExports(store: Store): Promise<Record<string, string>> {
  return (await store.getState<Record<string, string>>(DOWNLOADED_KEY)) ?? {};
}

export async function rememberDownload(store: Store, exportId: string, path: string): Promise<void> {
  await store.setState(DOWNLOADED_KEY, { ...(await downloadedExports(store)), [exportId]: path });
}

/** The file name the iPad shares: the server's, made safe for the file system. */
export function shareName(e: ExportRow): string {
  const fallback = `export-${e.id}.${e.kind === 'floor_pdf' ? 'pdf' : 'xlsx'}`;
  return (e.filename ?? fallback).replace(/[/\\:*?"<>|]/g, '_');
}

// ------------------------------------------------------------------ server

function client(identity: Identity): HttpClient {
  return new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name, timeoutMs: 60_000 });
}

export const startExport = (identity: Identity, body: { project_id: string; kind: ExportKind; params?: Record<string, unknown> }): Promise<ExportRow> =>
  client(identity).json<ExportRow>('POST', '/exports', body);

export const getExport = (identity: Identity, id: string): Promise<ExportRow> => client(identity).json<ExportRow>('GET', `/exports/${id}`);

export const listExports = (identity: Identity, projectId: string): Promise<ExportRow[]> =>
  client(identity).json<ExportRow[]>('GET', `/exports?project_id=${encodeURIComponent(projectId)}`);
