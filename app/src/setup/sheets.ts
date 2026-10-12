/**
 * Plan sheets in project setup (T45, Phase 3 §3.2 "Floor plans"): upload a level's display sheet
 * (the composite) or source sheets to `POST /imports` (kind `plans`), follow the job, and read
 * what the local store knows about each level's sheets after the sync. The read model is pure
 * SQL over the store so it runs in Node tests; the upload takes a React Native file part.
 */

import { HttpClient, gridSummary, parseGridSets, type Store } from '@field-survey/core';

import type { Identity } from '../identity/api';
import type { FilePart, ImportBatch } from './imports';

export type SheetKind = 'display' | 'source';

export type LevelSheets = {
  levelId: string;
  code: string;
  /** The display sheet (composite) and its grid summary, or null. */
  display: { sheetId: string; title: string | null; cached: boolean; grid: string; sets: number } | null;
  /** Source sheets uploaded for the level (one per page). */
  sources: { sheetId: string; title: string | null; page: number }[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Every level of the project with its sheets, in floor order. */
export async function loadLevelSheets(store: Store, projectId: string): Promise<LevelSheets[]> {
  const levels = await store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  if (!levels.length) return [];
  const ids = levels.map((l) => String(l.id));
  const sheets = await store.list<Row>('sheet', { where: `level_id IN (${ids.map(() => '?').join(', ')})`, params: ids, orderBy: 'page' });
  const cached = new Set(
    (await store.db.query<{ sha256: string }>(`SELECT sha256 FROM blob WHERE local_path IS NOT NULL`)).map((r) => r.sha256),
  );
  return levels.map((l): LevelSheets => {
    const levelId = String(l.id);
    const displayId = str(l.display_sheet_id);
    const display = displayId ? sheets.find((s) => String(s.id) === displayId) : undefined;
    const sets = display ? parseGridSets(display.grid_sets) : [];
    return {
      levelId,
      code: String(l.level),
      display: display
        ? { sheetId: displayId!, title: str(display.title), cached: typeof display.blob === 'string' && cached.has(display.blob), grid: gridSummary(sets), sets: sets.length }
        : null,
      sources: sheets
        .filter((s) => String(s.level_id) === levelId && s.kind === 'source')
        .map((s) => ({ sheetId: String(s.id), title: str(s.title), page: typeof s.page === 'number' ? s.page : 1 })),
    };
  });
}

function client(identity: Identity): HttpClient {
  return new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name, timeoutMs: 300_000 });
}

/** Upload one PDF for a level; the server analyses it and the sheet arrives with the next sync. */
export async function startSheetImport(identity: Identity, projectId: string, levelId: string, kind: SheetKind, file: FilePart): Promise<ImportBatch> {
  const c = client(identity);
  const body = new FormData();
  body.append('project_id', projectId);
  body.append('kind', 'plans');
  body.append('level_id', levelId);
  body.append('sheet_kind', kind);
  body.append('file', file as unknown as Blob);
  const res = await c.send('POST', '/imports', { headers: c.headers(), body });
  return (await res.json()) as ImportBatch;
}

/** One line for a plans job card. */
export function sheetJobLine(b: ImportBatch): string {
  switch (b.job_state) {
    case 'queued':
      return 'Queued — the server picks it up within a few seconds';
    case 'running':
      return 'Reading the sheet (grid bubbles, rooms, tags, boundaries)…';
    case 'skipped':
      return 'Already uploaded — this exact file was imported for this level before';
    case 'failed':
      return `Failed: ${b.stats?.error ?? 'see the server log'}`;
    default: {
      const n = typeof b.stats?.grid_sets === 'number' ? b.stats.grid_sets : 0;
      const auto = typeof b.stats?.auto_sets === 'number' ? b.stats.auto_sets : 0;
      const sheets = Array.isArray(b.stats?.sheets) ? (b.stats.sheets as unknown[]).length : 1;
      return `Done: ${sheets} sheet${sheets === 1 ? '' : 's'}, ${n} grid set${n === 1 ? '' : 's'}${n ? ` (${auto} auto)` : ''} — arrives with the next sync`;
    }
  }
}
