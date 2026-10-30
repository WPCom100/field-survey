/**
 * The server side of the draft review (T44): the project's import batches (`GET /imports`, for
 * the excluded BOM lines, D188, and the riser blob, D191), source crop URLs (`GET
 * /imports/{id}/crop`, PNG), and the BOM / riser uploads (`POST /imports kind=bom|riser`, T42 /
 * T43). The pure helpers are tested in Node; the fetches need a connection.
 */

import { HttpClient } from '@field-survey/core';

import type { Identity } from '../identity/api';
import type { ImportBatch } from '../setup/imports';
import { uploadForm, type UploadPart } from '../setup/upload';
import { excludedKey, type ExcludedLine } from './actions';
import type { DraftSource } from './model';

export type Batch = ImportBatch & { kind: string; files?: { name: string; sha256?: string; pages?: number }[]; created_at?: string | null };
export type ExtractionKind = 'bom' | 'riser' | 'davinci';

function client(identity: Identity, timeoutMs = 30_000): HttpClient {
  return new HttpClient({ serverUrl: identity.serverUrl, token: identity.token, userName: identity.user?.name, timeoutMs });
}

export const listImports = (identity: Identity, projectId: string): Promise<Batch[]> =>
  client(identity).json<Batch[]>('GET', `/imports?project_id=${encodeURIComponent(projectId)}`);

/**
 * Upload a BOM or riser PDF for extraction, or DaVinci's `library.json` (with the category mapping
 * workbook as `categories` the first time, T111); the drafts arrive with the next sync.
 */
export async function startExtraction(
  identity: Identity,
  projectId: string,
  kind: ExtractionKind,
  file: UploadPart,
  more: { categories?: UploadPart; retireHandMade?: boolean } = {},
): Promise<Batch> {
  const c = client(identity, kind === 'davinci' ? 300_000 : 120_000);
  const fields = { project_id: projectId, kind, retire_hand_made: more.retireHandMade ? 'true' : undefined };
  const res = await c.send('POST', '/imports', { headers: c.headers(), body: uploadForm(file, fields, undefined, { categories: more.categories }) });
  return (await res.json()) as Batch;
}

/** The headers an `<Image>` needs to load a crop. */
export const authHeaders = (identity: Identity): Record<string, string> => client(identity).headers();

const fileOf = (b: Batch): string | null => (typeof b.stats?.file === 'string' ? b.stats.file : (b.files?.[0]?.name ?? null));

/** The batch that stored a source's PDF: its own batch when it is that kind, else the latest finished one of that kind and file name. */
export function batchFor(batches: readonly Batch[], s: Pick<DraftSource, 'kind' | 'file' | 'batchId'>): Batch | null {
  const own = s.batchId ? batches.find((b) => b.id === s.batchId && b.kind === s.kind) : undefined;
  if (own) return own;
  const done = batches.filter((b) => b.kind === s.kind && b.job_state === 'done' && (!s.file || fileOf(b) === s.file));
  return done.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;
}

/** `GET /imports/{batch}/crop?…` for a source (null without a box or a batch). */
export function cropUrl(serverUrl: string, batch: Batch | null, s: DraftSource, opts: { px?: number; pad?: number } = {}): string | null {
  if (!batch || !s.bbox) return null;
  const q = new URLSearchParams({ page: String(s.page), bbox: s.bbox.map((n) => String(Math.round(n * 10) / 10)).join(','), pad: String(opts.pad ?? (s.kind === 'riser' ? 120 : 24)), px: String(opts.px ?? 900) });
  return `${serverUrl.replace(/\/+$/, '')}/imports/${batch.id}/crop?${q.toString()}`;
}

/** The riser PDF's blob (D191) for a riser source file, from its batch's stats. */
export function riserBlobFor(batches: readonly Batch[], file: string | null): string | null {
  const b = batchFor(batches, { kind: 'riser', file, batchId: null });
  return typeof b?.stats?.blob === 'string' ? b.stats.blob : null;
}

export type ExcludedRow = ExcludedLine & { key: string; batch: { id: string; file: string | null }; levelCode: string | null };

/** Every excluded BOM line of the project's finished BOM batches (D188), newest batch first. */
export function excludedLines(batches: readonly Batch[]): ExcludedRow[] {
  const out: ExcludedRow[] = [];
  for (const b of batches) {
    if (b.kind !== 'bom' || b.job_state !== 'done') continue;
    const lines = Array.isArray(b.stats?.excluded_lines) ? (b.stats.excluded_lines as ExcludedLine[]) : [];
    for (const l of lines) {
      const ref = l.source_ref ?? {};
      out.push({ ...l, key: excludedKey(b.id, ref), batch: { id: b.id, file: fileOf(b) }, levelCode: typeof ref.level_code === 'string' ? ref.level_code : null });
    }
  }
  return out;
}

/** The excluded lines already promoted: drafts that carry a promoted `source_ref` from that batch. */
export function promotedKeys(drafts: readonly { importBatchId: string | null; sourceRef: Record<string, unknown> | null }[]): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) if (d.importBatchId && d.sourceRef?.promoted) out.add(excludedKey(d.importBatchId, d.sourceRef));
  return out;
}

function davinciLine(s: Record<string, unknown>, n: (k: string) => number | null): string {
  const clashes = Array.isArray(s.clashes) ? s.clashes.length : 0;
  const retired = Array.isArray(s.retired) ? s.retired.length : 0;
  const kept = (n('kept_accepted') ?? 0) + (n('kept_rejected') ?? 0);
  const parts = [
    `Done: ${n('created') ?? 0} new drafts, ${n('updated') ?? 0} updated, ${n('unchanged') ?? 0} unchanged (${n('placeable') ?? '?'} device types, ${n('accessory_only') ?? 0} accessories)`,
    `${n('vocab_drafts') ?? 0} protocol drafts`,
  ];
  if (kept) parts.push(`${kept} accepted or rejected left alone`);
  const corrected = n('neuron_flags_corrected') ?? 0;
  if (corrected) parts.push(`${corrected} Neuron flag${corrected === 1 ? '' : 's'} corrected`);
  if (retired) parts.push(`${retired} hand-made type${retired === 1 ? '' : 's'} retired`);
  if (clashes) parts.push(`${clashes} model clash${clashes === 1 ? '' : 'es'}`);
  return parts.join(', ');
}

/** One line for an extraction job card. */
export function extractionLine(kind: ExtractionKind, b: Batch): string {
  const s = b.stats ?? {};
  switch (b.job_state) {
    case 'queued':
      return 'Queued — the server picks it up within a few seconds';
    case 'running':
      if (kind === 'davinci') return 'Reading the DaVinci library into app-library drafts…';
      return kind === 'riser' ? 'Reading the riser (bands, devices, bubbles; endpoints by the Claude API — about 12 minutes)…' : 'Reading the BOM (text, OCR where a page has none)…';
    case 'skipped':
      return kind === 'davinci' ? 'Already imported — this library and mapping were imported before' : 'Already uploaded — this exact file was extracted for this project before';
    case 'failed':
      return `Failed: ${typeof s.error === 'string' ? s.error : 'see the server log'}`;
    default: {
      const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
      if (kind === 'bom') return `Done: ${n('drafts') ?? '?'} device drafts, ${n('excluded') ?? 0} excluded lines, ${n('flagged') ?? 0} flagged`;
      if (kind === 'davinci') return davinciLine(s, n);
      const cost = s.claude && typeof s.claude === 'object' && typeof (s.claude as Record<string, unknown>).cost_usd === 'number' ? ` · Claude $${((s.claude as Record<string, unknown>).cost_usd as number).toFixed(2)}` : '';
      return `Done: ${n('device_drafts') ?? '?'} device drafts (${n('merged_into_bom') ?? 0} merged into the BOM's), ${n('cable_drafts') ?? '?'} cable drafts, ${n('endpoints_unresolved') ?? 0} far ends to pick${cost}`;
    }
  }
}
