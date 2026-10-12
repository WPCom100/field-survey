/**
 * The client side of the seed import (T28, PLAN §7.5): `POST /imports/preview` for the workbook's
 * headers and default matches, `POST /imports` to queue the job, `GET /imports/{id}` to follow it.
 * The mapping helpers are pure so they run in Node tests; the upload takes a React Native file part.
 */

import { HttpClient } from '@field-survey/core';

import type { Identity } from '../identity/api';

export type ImportKind = 'master_xlsx' | 'floor_xlsx';
export const KIND_LABEL: Record<ImportKind, string> = { master_xlsx: 'Master workbook', floor_xlsx: 'Floor workbook' };

export type FieldPreview = { field: string; default: string; header: string | null };
export type TabPreview = { tab: string; found: boolean; headers: string[]; fields: FieldPreview[]; rows: number };
export type ImportPreview = { name: string; tabs: TabPreview[]; levels: string[]; images: number; checks: string[] };

/** `{tab: {field: header}}`; '' = "not in this workbook" (the server then reports the column missing). */
export type Mapping = Record<string, Record<string, string>>;

export type JobState = 'queued' | 'running' | 'done' | 'skipped' | 'failed';
export type ImportBatch = {
  id: string;
  job_state: JobState;
  stats: {
    review_items?: number;
    findings?: number;
    unpaired_ends?: number;
    checks_list?: string[];
    skipped?: string;
    error?: string;
    [k: string]: unknown;
  } | null;
};

/** A file as React Native's FormData takes it (a picked document). */
export type FilePart = { uri: string; name: string; type: string };

/** The mapping the picker starts from: each field's matched header, or '' where none matched. */
export function initialMapping(p: ImportPreview): Mapping {
  const out: Mapping = {};
  for (const t of p.tabs) {
    if (!t.found) continue;
    out[t.tab] = Object.fromEntries(t.fields.map((f) => [f.field, f.header ?? '']));
  }
  return out;
}

/** Only what differs from the server's defaults is sent (`mapping` overrides, `workbook.py`). */
export function overrides(p: ImportPreview, chosen: Mapping): Mapping {
  const out: Mapping = {};
  for (const t of p.tabs) {
    for (const f of t.fields) {
      const pick = chosen[t.tab]?.[f.field];
      if (pick === undefined || pick.toLowerCase() === f.default.toLowerCase()) continue;
      if (pick === '' && f.header === null) continue; // unmatched by default, left unmatched
      (out[t.tab] ??= {})[f.field] = pick;
    }
  }
  return out;
}

/** Fields still unmatched under `chosen`, per tab (the "checks" before Import). */
export function unmatched(p: ImportPreview, chosen: Mapping): { tab: string; field: string }[] {
  return p.tabs.flatMap((t) => (t.found ? t.fields.filter((f) => !chosen[t.tab]?.[f.field]).map((f) => ({ tab: t.tab, field: f.field })) : []));
}

export const FIELD_LABEL: Record<string, string> = {
  display_id: 'ID', room_location: 'Room / Location', drawing_position: 'Drawing Position', from_text: 'From', to_text: 'To',
  tracking_status: 'Tracking status', date_closed: 'Date closed', device_location: 'Device / Location', part_no: 'Part no.',
  part_status: 'Part status', what_it_shows: 'What it shows', device_id: 'Device ID', qty: 'Qty', number: '#',
};
export const fieldLabel = (f: string): string => FIELD_LABEL[f] ?? f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, ' ');

export const isFinished = (s: JobState): boolean => s === 'done' || s === 'skipped' || s === 'failed';

/** One line for the job card. */
export function jobLine(b: ImportBatch): string {
  switch (b.job_state) {
    case 'queued':
      return 'Queued — the server picks it up within a few seconds';
    case 'running':
      return 'Importing…';
    case 'skipped':
      return 'Already imported — this exact file was imported before, nothing changed';
    case 'failed':
      return `Failed: ${b.stats?.error ?? 'see the server log'}`;
    default:
      return 'Imported';
  }
}

function client(identity: Identity): HttpClient {
  return new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name, timeoutMs: 120_000 });
}

function form(file: FilePart, fields: Record<string, string | undefined>): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.append(k, v);
  body.append('file', file as unknown as Blob);
  return body;
}

export async function previewWorkbook(identity: Identity, file: FilePart, mapping?: Mapping): Promise<ImportPreview> {
  const c = client(identity);
  const res = await c.send('POST', '/imports/preview', {
    headers: c.headers(),
    body: form(file, { mapping: mapping && Object.keys(mapping).length ? JSON.stringify(mapping) : undefined }),
  });
  return (await res.json()) as ImportPreview;
}

export async function startImport(identity: Identity, projectId: string, kind: ImportKind, file: FilePart, mapping: Mapping): Promise<ImportBatch> {
  const c = client(identity);
  const res = await c.send('POST', '/imports', {
    headers: c.headers(),
    body: form(file, { project_id: projectId, kind, mapping: Object.keys(mapping).length ? JSON.stringify(mapping) : undefined }),
  });
  return (await res.json()) as ImportBatch;
}

export const getImport = (identity: Identity, id: string): Promise<ImportBatch> => client(identity).json<ImportBatch>('GET', `/imports/${id}`);
