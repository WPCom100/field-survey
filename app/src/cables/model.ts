/**
 * Read model of the cable / riser view (T39, Phase 3 §5): every cable of the project with both
 * ends, grouped by vertical, level or code, and the consistency checks per cable (D180): missing
 * far end, code mismatch, status mismatch, To ≠ riser (the `riserCheck` matcher of T22 and R2b),
 * unconfirmed endpoint (D6) and `Not started` on an in-scope level. Loading reads the store once;
 * grouping and filtering are pure so the screen's filters never re-query. No React or Expo imports.
 */

import { displayNumber, riserCheck, type Store } from '@field-survey/core';

import { CABLE_NAME } from '../ends/model';
import type { Rect } from '../plan/viewport';

export type CheckId = 'far_end' | 'code' | 'status' | 'riser' | 'unconfirmed' | 'not_started';

/** The checks in the footer's order (Phase 3 §5), with what to do about each. */
export const CABLE_CHECKS: readonly { id: CheckId; title: string; hint: string }[] = [
  { id: 'far_end', title: 'missing far end', hint: 'Open the end and pick the far end (a device or a placeholder).' },
  { id: 'code', title: 'code mismatch', hint: 'The cable code is missing, not a cable code, or not what the riser label names.' },
  { id: 'status', title: 'status mismatch', hint: 'A wire is run or not: survey both ends again and correct one.' },
  { id: 'riser', title: 'To ≠ riser', hint: 'The riser governs To (R2): correct the To text, or keep the guess in the note.' },
  { id: 'unconfirmed', title: 'unconfirmed endpoint', hint: 'Check the far end against the riser, then Confirm endpoint (D6).' },
  { id: 'not_started', title: 'Not started on in-scope level', hint: 'Not started is for runs to levels out of scope: survey this end.' },
];

/** Shown and filtered as a status; stored empty (D110). */
export const UNSURVEYED = 'Unsurveyed';

export type CableCheck = { id: CheckId; message: string };

export type CableEndCell = {
  id: string;
  side: 'A' | 'B';
  /** `C-03`, or `NEW` until the server numbers it. */
  label: string;
  levelId: string | null;
  levelCode: string | null;
  /** The device's ID (`06M-02`), the placeholder's label, or null when the end names neither. */
  endpoint: string | null;
  deviceId: string | null;
  status: string | null;
  /** The end is on a level out of scope, or is a "level not in scope" placeholder. */
  outOfScope: boolean;
};

/** Where a cable's riser crop comes from: the riser PDF's blob and page (D191), or a `sheet` row (D180, unused). */
export type RiserRef =
  | { kind: 'blob'; blob: string | null; file: string | null; page: number; bbox: Rect; draftId: string | null }
  | { kind: 'sheet'; sheetId: string; bbox: Rect };

export type CableRow = {
  id: string;
  code: string | null;
  qty: number | null;
  singleRow: boolean;
  origin: string | null;
  vertical: string | null;
  riserToLabel: string | null;
  riserRef: RiserRef | null;
  endpointConfirmed: boolean;
  a: CableEndCell | null;
  b: CableEndCell | null;
  /** Levels its ends are on, in floor order. */
  levelIds: string[];
  checks: CableCheck[];
  /** An open Needs review item on the cable or one of its ends. */
  reviewItemId: string | null;
};

export type CableData = {
  rows: CableRow[];
  levels: { id: string; code: string; inScope: boolean }[];
  /** Cables per check, over the whole project. */
  totals: Record<CheckId, number>;
};

export type GroupBy = 'vertical' | 'level' | 'code';

export type CableFilter = {
  code?: string | null;
  /** A connection status, or `Unsurveyed`: some end has it. */
  status?: string | null;
  /** `any`: cables with at least one check; a check id: cables with that one. */
  check?: CheckId | 'any' | null;
  levelId?: string | null;
};

export type CableGroup = { key: string; title: string; rows: CableRow[] };

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The signal a riser label names, as the cable codes it allows; null when it names none. */
export function riserSignal(label: string | null | undefined): readonly string[] | null {
  const t = ` ${(label ?? '').toUpperCase().replace(/[^A-Z0-9-]+/g, ' ')} `;
  if (/ DMX /.test(t)) return ['X'];
  if (/ UNISON /.test(t)) return ['U'];
  if (/ FIBER | FIBRE /.test(t)) return ['F'];
  if (/ PANIC /.test(t)) return ['P'];
  if (/ 0-10V /.test(t)) return ['0-10V'];
  if (/ 120V /.test(t)) return ['120V'];
  if (/ NETWORK | NET /.test(t)) return ['N', 'NG'];
  return null;
}

/**
 * `riser_ref` in either form: the blob form (D191) `{blob, file, page, bbox, draft}` that riser
 * drafts write (T44; `blob` null when accepted offline, found later by `file`), bbox in the page's
 * display frame (`plan/viewport.ts` `displayRectToPage`); or the `{sheet, bbox}` form of D180, bbox
 * in sheet coordinates, which nothing writes since D191. bbox as `[x, y, width, height]` or
 * `{x, y, width, height}`.
 */
export function parseRiserRef(v: unknown): RiserRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const bbox = parseBox(o.bbox);
  if (!bbox) return null;
  const sheetId = str(o.sheet) ?? str(o.sheet_id);
  if (sheetId) return { kind: 'sheet', sheetId, bbox };
  const blob = str(o.blob);
  const file = str(o.file);
  if (!blob && !file) return null;
  const page = num(o.page);
  return { kind: 'blob', blob, file, page: page != null && page >= 1 ? Math.floor(page) : 1, bbox, draftId: str(o.draft) };
}

/** The riser PDF's blob for a blob-form ref: its own, else by file name from the project's import batches (`riserBlobFor`). */
export function riserBlobOf(ref: RiserRef, lookup: (file: string | null) => string | null): string | null {
  if (ref.kind !== 'blob') return null;
  return ref.blob ?? (ref.file ? lookup(ref.file) : null);
}

function parseBox(b: unknown): Rect | null {
  let r: Rect | null = null;
  if (Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    r = { x: b[0] as number, y: b[1] as number, width: b[2] as number, height: b[3] as number };
  } else if (b && typeof b === 'object') {
    const q = b as Record<string, unknown>;
    const [x, y, width, height] = [num(q.x), num(q.y), num(q.width), num(q.height)];
    if (x != null && y != null && width != null && height != null) r = { x, y, width, height };
  }
  return r && r.width > 0 && r.height > 0 ? r : null;
}

const RUN: readonly (string | null)[] = ['Complete', 'Installed, untested'];

/** The checks on one cable (pure; the same conditions as `lint.far_end`, `lint.end_status` and R2b). */
export function cableChecks(
  c: { code: string | null; riserToLabel: string | null; endpointConfirmed: boolean },
  ends: readonly (CableEndCell & { toText: string | null })[],
  inScope: (levelId: string) => boolean,
): CableCheck[] {
  const out: CableCheck[] = [];
  const sorted = [...ends].sort((x, y) => x.side.localeCompare(y.side));
  // missing far end
  if (sorted.length < 2) out.push({ id: 'far_end', message: sorted.length ? `${sorted[0]!.label}: no far end` : 'No ends' });
  else {
    const missing = sorted.filter((e) => !e.endpoint);
    if (missing.length === 2) out.push({ id: 'far_end', message: 'Neither end names a device or placeholder' });
    else if (missing.length) out.push({ id: 'far_end', message: `${missing[0]!.label} (side ${missing[0]!.side}) names no device or placeholder` });
  }
  // code mismatch
  if (!c.code) out.push({ id: 'code', message: 'Cable has no code' });
  else if (!CABLE_NAME[c.code]) out.push({ id: 'code', message: `"${c.code}" is not a cable code` });
  else {
    const want = riserSignal(c.riserToLabel);
    if (want && !want.includes(c.code)) out.push({ id: 'code', message: `Riser "${c.riserToLabel}" names ${want.join('/')}, cable code is ${c.code}` });
  }
  // status mismatch
  for (const e of sorted) {
    const o = sorted.find((x) => x !== e);
    if (e.status === 'Not installed' && o && RUN.includes(o.status)) {
      out.push({ id: 'status', message: `${e.label}: Not installed here, ${o.status} at ${o.label}` });
    }
  }
  // To ≠ riser (the end R2b reads: A's To, else any To)
  const label = c.riserToLabel;
  const toEnd = sorted.find((e) => e.side === 'A' && e.toText) ?? sorted.find((e) => e.toText);
  if (label && toEnd) {
    const r = riserCheck(label, toEnd.toText);
    if (r.state === 'differs') out.push({ id: 'riser', message: `To "${toEnd.toText}" does not match the riser "${r.riser}"` });
  }
  // unconfirmed endpoint
  if (!c.endpointConfirmed) out.push({ id: 'unconfirmed', message: 'Endpoint not confirmed against the riser (D6)' });
  // Not started on an in-scope level, unless the run goes to a level out of scope (the master's
  // reading: the run to 09 has not started, on the 06M end too)
  for (const e of sorted) {
    const far = sorted.find((x) => x !== e);
    if (e.status === 'Not started' && e.levelId && inScope(e.levelId) && !far?.outOfScope) {
      out.push({ id: 'not_started', message: `${e.label}: Not started on in-scope level ${e.levelCode ?? '?'}` });
    }
  }
  return out;
}

function numberOf(label: string): number {
  const m = /(\d+)$/.exec(label);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Every live cable of the project with both ends and its checks. */
export async function loadCables(store: Store, projectId: string): Promise<CableData> {
  const levelRows = await store.list<Row>('level', { where: 'project_id = ? AND deleted_at IS NULL', params: [projectId], orderBy: 'floor_order, level' });
  const levels = levelRows.map((l) => ({ id: String(l.id), code: String(l.level), inScope: !!l.in_scope }));
  const levelById = new Map(levels.map((l, i) => [l.id, { ...l, order: i }]));
  const cables = await store.list<Row>('cable', { where: 'project_id = ? AND deleted_at IS NULL', params: [projectId], orderBy: 'id' });
  const ends = await store.db.query<Row>(
    `SELECT e.* FROM cable_end e JOIN cable c ON c.id = e.cable_id WHERE c.project_id = ? AND c.deleted_at IS NULL AND e.deleted_at IS NULL ORDER BY e.side, e.id`,
    [projectId],
  );
  const devices = await store.db.query<Row>(
    `SELECT d.id, d.level_id, d.display_id, d.category FROM device d JOIN level l ON l.id = d.level_id WHERE l.project_id = ?`,
    [projectId],
  );
  const deviceById = new Map(devices.map((d) => [String(d.id), d]));
  const placeholders = new Map((await store.list<Row>('placeholder', { where: 'project_id = ?', params: [projectId] })).map((p) => [String(p.id), p]));
  const reviews = await store.list<Row>('review_item', { where: `project_id = ? AND state = 'open'`, params: [projectId], orderBy: 'id' });
  const reviewBy = new Map<string, string>();
  for (const r of reviews) {
    const s = r.subject as { entity_id?: string } | null;
    if (s?.entity_id && !reviewBy.has(s.entity_id)) reviewBy.set(s.entity_id, String(r.id));
  }

  const endsBy = new Map<string, Row[]>();
  for (const e of ends) {
    const list = endsBy.get(String(e.cable_id));
    if (list) list.push(e);
    else endsBy.set(String(e.cable_id), [e]);
  }

  const inScope = (id: string) => levelById.get(id)?.inScope ?? false;
  const rows: CableRow[] = [];
  for (const c of cables) {
    const id = String(c.id);
    const cells = (endsBy.get(id) ?? []).map((e) => {
      const dev = str(e.device_id) ? deviceById.get(String(e.device_id)) : undefined;
      const levelId = str(e.level_id) ?? (dev ? String(dev.level_id) : null);
      const levelCode = levelId ? (levelById.get(levelId)?.code ?? null) : null;
      const devCode = dev ? (levelById.get(String(dev.level_id))?.code ?? null) : null;
      const ph = str(e.placeholder_id) ? placeholders.get(String(e.placeholder_id)) : undefined;
      const endpoint = dev ? displayNumber('device', dev, devCode) : str(e.placeholder_id) ? (ph ? String(ph.label) : '(placeholder)') : null;
      const outOfScope = (levelId != null && levelById.has(levelId) && !levelById.get(levelId)!.inScope) || ph?.kind === 'level_not_in_scope';
      return {
        id: String(e.id),
        side: e.side === 'B' ? ('B' as const) : ('A' as const),
        label: displayNumber('cable_end', e),
        levelId,
        levelCode,
        endpoint,
        deviceId: dev ? String(dev.id) : null,
        status: str(e.status),
        outOfScope,
        toText: str(e.to_text),
      };
    });
    const code = str(c.cable);
    const riserToLabel = str(c.riser_to_label);
    const endpointConfirmed = !!c.endpoint_confirmed;
    const a = cells.find((e) => e.side === 'A') ?? null;
    const b = cells.find((e) => e !== a) ?? null;
    const strip = (e: (typeof cells)[number] | null): CableEndCell | null => (e ? { id: e.id, side: e.side, label: e.label, levelId: e.levelId, levelCode: e.levelCode, endpoint: e.endpoint, deviceId: e.deviceId, status: e.status, outOfScope: e.outOfScope } : null);
    const levelIds = [...new Set(cells.map((e) => e.levelId).filter((l): l is string => !!l && levelById.has(l)))].sort((x, y) => levelById.get(x)!.order - levelById.get(y)!.order);
    rows.push({
      id,
      code,
      qty: num(c.qty),
      singleRow: !!c.single_row,
      origin: str(c.origin),
      vertical: str(c.vertical),
      riserToLabel,
      riserRef: parseRiserRef(c.riser_ref),
      endpointConfirmed,
      a: strip(a),
      b: strip(b),
      levelIds,
      checks: cableChecks({ code, riserToLabel, endpointConfirmed }, cells, inScope),
      reviewItemId: reviewBy.get(id) ?? cells.map((e) => reviewBy.get(e.id)).find(Boolean) ?? null,
    });
  }
  const order = (r: CableRow) => (r.a?.levelId ? (levelById.get(r.a.levelId)?.order ?? 999) : 999);
  rows.sort((x, y) => order(x) - order(y) || numberOf(x.a?.label ?? '') - numberOf(y.a?.label ?? '') || x.id.localeCompare(y.id));

  const totals = Object.fromEntries(CABLE_CHECKS.map((k) => [k.id, 0])) as Record<CheckId, number>;
  for (const r of rows) for (const id of new Set(r.checks.map((k) => k.id))) totals[id] += 1;
  return { rows, levels, totals };
}

export function matches(r: CableRow, f: CableFilter): boolean {
  if (f.code && r.code !== f.code) return false;
  if (f.status) {
    const st = [r.a, r.b].filter((e): e is CableEndCell => !!e).map((e) => e.status ?? UNSURVEYED);
    if (!st.includes(f.status)) return false;
  }
  if (f.check === 'any' && !r.checks.length) return false;
  if (f.check && f.check !== 'any' && !r.checks.some((k) => k.id === f.check)) return false;
  if (f.levelId && !r.levelIds.includes(f.levelId)) return false;
  return true;
}

export function codeTitle(code: string | null): string {
  if (!code) return 'No code';
  const name = CABLE_NAME[code];
  return name && name !== code ? `${code} (${name})` : code;
}

const CODE_ORDER = Object.keys(CABLE_NAME);
const codeRank = (c: string | null) => (c && CODE_ORDER.includes(c) ? CODE_ORDER.indexOf(c) : CODE_ORDER.length);

/**
 * The vertical a cable belongs to (Phase 3 §5): its stored `vertical`, else derived (D180) —
 * single-row codes together, a run whose ends are on one level as "Same-floor", and every other
 * run under the device (or placeholder) at its A end and its code.
 */
export function verticalOf(r: CableRow): { key: string; title: string; rank: number } {
  if (r.vertical) return { key: `v:${r.vertical}`, title: `Vertical: ${r.vertical}`, rank: 0 };
  if (r.singleRow) return { key: 'single', title: 'Single-row: P · 0-10V · 120V', rank: 3 };
  if (r.a && r.b && r.levelIds.length === 1) return { key: `same:${r.code ?? ''}`, title: `Same-floor: ${codeTitle(r.code)}`, rank: 2 };
  const from = r.a?.endpoint ?? r.b?.endpoint ?? '(no endpoint)';
  return { key: `run:${from}:${r.code ?? ''}`, title: `${from} → ${codeTitle(r.code)}`, rank: 1 };
}

/** The rows that pass the filter, grouped; a cable spanning levels shows under each when grouped by level. */
export function groupCables(data: CableData, by: GroupBy, f: CableFilter = {}): CableGroup[] {
  const rows = data.rows.filter((r) => matches(r, f));
  const groups = new Map<string, CableGroup & { rank: number; order: number }>();
  const add = (key: string, title: string, rank: number, r: CableRow) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, title, rows: [], rank, order: groups.size }));
    g.rows.push(r);
  };
  const levelOrder = new Map(data.levels.map((l, i) => [l.id, i]));
  for (const r of rows) {
    if (by === 'code') add(`code:${r.code ?? ''}`, codeTitle(r.code), codeRank(r.code), r);
    else if (by === 'level') {
      const ids = f.levelId ? [f.levelId] : r.levelIds;
      if (!ids.length) add('level:none', 'No level', Number.MAX_SAFE_INTEGER, r);
      for (const id of ids) add(`level:${id}`, `Level ${data.levels.find((l) => l.id === id)?.code ?? '?'}`, levelOrder.get(id) ?? 0, r);
    } else {
      const v = verticalOf(r);
      add(v.key, v.title, v.rank, r);
    }
  }
  return [...groups.values()]
    .sort((x, y) => x.rank - y.rank || (by === 'vertical' && x.rank === 0 ? x.title.localeCompare(y.title) : x.order - y.order))
    .map(({ key, title, rows: rs }) => ({ key, title, rows: rs }));
}

/** A row's status cell: the stored status, `Unsurveyed`, or the missing end. */
export function statusCell(e: CableEndCell | null): string {
  if (!e) return '⚠ missing end';
  return e.status ?? UNSURVEYED;
}

/** A row's end cell: `06M-02 C-03`, a placeholder, or the missing end. */
export function endCell(e: CableEndCell | null): string {
  if (!e) return '—';
  return `${e.endpoint ?? '⚠ no endpoint'} ${e.label}`;
}
