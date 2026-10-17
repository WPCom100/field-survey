/**
 * Draft review read model (T44, Phase 3 §3.3, PLAN §7.1): the BOM and riser extraction drafts
 * (`draft_device`, `draft_cable`, T42 / T43) per level with their confidence, sources, conflicts
 * and the choices a person must make before Accept (D28: nothing is picked for them), the
 * mismatch list, and the endpoints a cable draft can be given (D6). Hand-entered drafts (the K12
 * fallback) read the same way. Pure: a `Store` in, plain rows out; tested in Node.
 */

import { canonicalCategory, isRole, roleOfCategory, type Role, type Store } from '@field-survey/core';
import { cableCodes, loadRuleParams } from '@field-survey/rules';

import { loadDeviceTypes, roleOfDevice } from '../library/neuron';

// ------------------------------------------------------------------ shapes

export type DraftState = 'proposed' | 'accepted' | 'edited' | 'rejected';

/** A level key: a level id, `pool` (no level: a pooled BOM venue or the Material List), or `code:09` (a floor the project lacks). */
export type LevelKey = string;
export const POOL = 'pool';

export type ReviewLevel = { key: LevelKey; code: string; title: string; levelId: string | null; inScope: boolean; devices: number; cables: number; open: number };

/** Where a draft came from, for its crop: the stored PDF (by file name and kind), a page and a box in points ([x, y, w, h], top-left). */
export type DraftSource = { kind: 'bom' | 'riser'; label: string; file: string | null; batchId: string | null; page: number; bbox: [number, number, number, number] | null };

export type ModelChoice = { options: string[] };
export type QtyChoice = { bom: number | null; riser: number | null };
export type LevelChoice = { options: { id: string; code: string }[] };

export type DeviceDraftRow = {
  id: string;
  levelId: string | null;
  levelCode: string | null;
  levelBasis: string | null;
  model: string | null;
  modelRaw: string | null;
  candidates: string[];
  name: string | null;
  category: string | null;
  /** T115 (D201): what the extraction read the device as; null = its category's role. */
  role: Role | null;
  qty: number | null;
  accessories: { model: string; qty: number | null; role: string }[];
  confidence: number | null;
  conflicts: string[];
  state: DraftState;
  extraction: string | null;
  src: string;
  sources: DraftSource[];
  /** Under 0.7 or carrying a conflict: waits in Needs review (D11). */
  flagged: boolean;
  /** Choices Accept needs first (D28). */
  needs: { model?: ModelChoice; qty?: QtyChoice; level?: LevelChoice; category?: true };
  /** Devices made from this draft (T46) and live devices of its model already on its level (the master, D30). */
  placed: number;
  onLevel: number;
  reviewItemId: string | null;
  sourceRef: Record<string, unknown> | null;
  importBatchId: string | null;
};

export type EndpointKind = 'device' | 'draft_device' | 'placeholder';
export type Endpoint = { kind: EndpointKind; id: string; label: string; levelId: string | null; confidence?: number | null };
export type Side = 'from' | 'to';

export type CableDraftRow = {
  id: string;
  levelId: string | null;
  levelCode: string | null;
  toLevelId: string | null;
  toLevelCode: string | null;
  code: string | null;
  qty: number | null;
  fromLabel: string | null;
  toLabel: string | null;
  origin: string | null;
  candidates: Record<Side, Endpoint[]>;
  /** The endpoint each side resolves to: a chosen one, else the only candidate. */
  ends: Record<Side, Endpoint | null>;
  chosen: Record<Side, boolean>;
  /** A side a person decided: chosen among several candidates, or picked outside them. */
  handPicked: Record<Side, boolean>;
  /** Confirm endpoint was tapped (D6) — kept on the chosen entries until the cable is made. */
  confirmed: boolean;
  confidence: number | null;
  conflicts: string[];
  state: DraftState;
  extraction: string | null;
  src: string;
  sources: DraftSource[];
  flagged: boolean;
  /** Accepted and its cable made (`placed` = 1), or accepted and waiting for an endpoint device to be placed (T46). */
  committed: boolean;
  waiting: boolean;
  sourceRef: Record<string, unknown> | null;
  importBatchId: string | null;
  /** A riser line with no wire bubble (T108, D192): the reviewer says what it is. */
  unknownCode: boolean;
  /** The extraction's guess at its code (`candidates` side `code`); never written as the code. */
  codeGuess: CodeGuess | null;
};

export type CodeGuess = { value: string; confidence: number | null; source: 'label' | 'model' | null };

export type Mismatch = { draftId: string; kind: 'device' | 'cable'; text: string };

export type DraftFilter = 'open' | 'review' | 'conflict' | 'accepted' | 'rejected' | 'all';
export const FILTERS: readonly [DraftFilter, string][] = [
  ['open', 'Open'],
  ['review', 'Needs review'],
  ['conflict', 'Conflict'],
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
  ['all', 'All'],
];

export type DraftReviewData = {
  levels: ReviewLevel[];
  devices: DeviceDraftRow[];
  cables: CableDraftRow[];
  placeholders: { id: string; label: string; kind: string; levelId: string | null }[];
  /** Live devices of the project, for the endpoint pickers. */
  devicesLive: { id: string; levelId: string; label: string; displayId: string | null; panelName: string | null; category: string | null; role: Role; device: string | null; baselineRef: string | null }[];
  /** The project's cable codes (`cableCodes`: the master's, then any its Rules give a signal word — T121). */
  codes: string[];
};

/** The minimum for Accept all (Phase 3 §3.3); each accept is still recorded as a reviewed op. */
export const BULK_MIN = 0.9;
/** Under this a draft waits in Needs review (D11). */
export const REVIEW_BELOW = 0.7;

// ------------------------------------------------------------------ small parsers

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function json<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function strings(v: unknown): string[] {
  const a = json<unknown[]>(v);
  return Array.isArray(a) ? a.map((x) => str(x)).filter((x): x is string => !!x) : [];
}

/**
 * A source_ref's box as [x, y, w, h]: the riser writes that form; a BOM line writes
 * [x0, top, x1, bottom] (T42), told apart by its `kind`.
 */
export function cropBox(ref: Record<string, unknown> | null | undefined): [number, number, number, number] | null {
  const b = ref?.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [a, c, d, e] = b as number[];
  if (ref?.kind === 'bom_line') return d! > a! && e! > c! ? [a!, c!, d! - a!, e! - c!] : null;
  return d! > 0 && e! > 0 ? [a!, c!, d!, e!] : null;
}

export const RISER_KINDS: ReadonlySet<string> = new Set(['riser_symbol', 'riser_bubble', 'riser_text', 'riser_line']);

function sourceOf(ref: Record<string, unknown>, batchId: string | null): DraftSource | null {
  const page = num(ref.page);
  if (page == null) return null;
  if (ref.kind === 'bom_line') {
    const line = ref.line != null ? ` line ${String(ref.line)}` : '';
    const job = str(ref.job) ? ` (job ${String(ref.job)})` : '';
    return { kind: 'bom', label: `BOM p.${page}${line}${job}`, file: str(ref.file), batchId, page, bbox: cropBox(ref) };
  }
  if (RISER_KINDS.has(String(ref.kind))) {
    const sheet = str(ref.sheet) ?? `p.${page}`;
    const lvl = str(ref.level_code);
    const mark = ref.bubble ? ` · bubble ${String(ref.bubble)}` : ref.line ? ` · line ${String(ref.line)}` : '';
    return { kind: 'riser', label: `Riser ${sheet}${lvl ? ` · level ${lvl}` : ''}${mark}`, file: str(ref.file), batchId, page, bbox: cropBox(ref) };
  }
  return null;
}

/**
 * Every source of a draft, primary first: its own `source_ref`, the riser symbol a BOM draft met
 * (`source_ref.riser`, D28), the pooled BOM line a riser draft drew down (`source_ref.bom`, whose
 * box is on that BOM draft — `bomRefs` maps draft id → its source_ref).
 */
export function sourcesOf(ref: Record<string, unknown> | null, batchId: string | null, bomRefs?: ReadonlyMap<string, Record<string, unknown>>): DraftSource[] {
  if (!ref) return [];
  const out: DraftSource[] = [];
  const own = sourceOf(ref, RISER_KINDS.has(String(ref.kind)) || ref.kind === 'bom_line' ? batchId : null);
  if (own) out.push(own);
  const riser = json<Record<string, unknown>>(ref.riser);
  if (riser) {
    const s = sourceOf(riser, null);
    if (s) out.push(s);
  }
  const bom = json<Record<string, unknown>>(ref.bom);
  if (bom) {
    const id = str(bom.draft_id);
    const pooled = id ? bomRefs?.get(id) : undefined;
    const s = pooled ? sourceOf({ ...pooled, kind: 'bom_line' }, null) : null;
    if (s) out.push({ ...s, label: `${s.label}${bom.venue ? ` · ${String(bom.venue)}` : ''} (pooled)` });
  }
  return out;
}

/** The Src column: B (BOM), R (riser), R+B (both, D28), hand (typed in, K12), BOM↑ (a promoted excluded line, D12). */
export function srcBadge(ref: Record<string, unknown> | null, extraction: string | null): string {
  if (!ref) return extraction === 'manual' ? 'hand' : '—';
  if (ref.promoted) return 'BOM↑';
  const bom = ref.kind === 'bom_line' || !!ref.bom;
  const riser = RISER_KINDS.has(String(ref.kind)) || !!ref.riser;
  return bom && riser ? 'R+B' : riser ? 'R' : bom ? 'B' : extraction === 'manual' ? 'hand' : '—';
}

// ------------------------------------------------------------------ device choices

const CHOICE_CONFLICTS = new Set(['model:SR/LR', 'qty:bom≠riser', 'level:06/06M']);

/** The choices Accept needs on a device draft (D28): model among candidates, BOM or riser quantity, 06 or 06M, a category. */
export function deviceNeeds(
  d: { candidates: string[]; conflicts: string[]; qty: number | null; category: string | null; sourceRef: Record<string, unknown> | null; levelId: string | null },
  levels: readonly { id: string; code: string; splitOfId: string | null }[],
): DeviceDraftRow['needs'] {
  const out: DeviceDraftRow['needs'] = {};
  if (d.candidates.length > 1) out.model = { options: d.candidates };
  if (d.conflicts.includes('qty:bom≠riser')) {
    const ref = d.sourceRef ?? {};
    const riserRef = json<Record<string, unknown>>(ref.riser);
    const bomRef = json<Record<string, unknown>>(ref.bom);
    // a BOM draft the riser met: own qty = BOM, the riser's in source_ref.riser.qty;
    // a riser draft that drew down a pooled line: own qty = riser, the pooled line's in source_ref.bom.qty
    const riser = riserRef ? num(riserRef.qty) : RISER_KINDS.has(String(ref.kind)) ? d.qty : null;
    const bom = bomRef ? num(bomRef.qty) : ref.kind === 'bom_line' ? d.qty : null;
    if (riser !== bom) out.qty = { bom, riser };
  }
  if (d.conflicts.includes('level:06/06M')) {
    const here = levels.find((l) => l.id === d.levelId);
    const parentId = here?.splitOfId ?? here?.id;
    const options = levels.filter((l) => l.id === parentId || (parentId != null && l.splitOfId === parentId)).map((l) => ({ id: l.id, code: l.code }));
    if (options.length > 1) out.level = { options };
  }
  if (!d.category) out.category = true;
  return out;
}

/** True when the conflict is one Accept itself settles by a choice (as opposed to one it only acknowledges). */
export const isChoiceConflict = (c: string): boolean => CHOICE_CONFLICTS.has(c);

// ------------------------------------------------------------------ cable endpoints

function endpointOf(v: Record<string, unknown>): (Endpoint & { side: Side; chosen: boolean; manual: boolean; confirmed: boolean }) | null {
  const side = v.side === 'from' || v.side === 'to' ? v.side : null;
  const kind = v.kind === 'device' || v.kind === 'draft_device' || v.kind === 'placeholder' ? v.kind : null;
  const id = str(v.id);
  if (!side || !kind || !id) return null;
  return { side, kind, id, label: str(v.label) ?? id, levelId: str(v.level_id), confidence: num(v.confidence), chosen: v.chosen === true, manual: v.manual === true, confirmed: v.confirmed === true };
}

/** A cable draft's candidates per side, and the endpoint each side resolves to: the chosen one, else the only candidate. */
export function cableEnds(raw: unknown): Pick<CableDraftRow, 'candidates' | 'ends' | 'chosen' | 'handPicked' | 'confirmed'> {
  const list = (json<unknown[]>(raw) ?? []).map((v) => (v && typeof v === 'object' ? endpointOf(v as Record<string, unknown>) : null)).filter((e): e is NonNullable<typeof e> => !!e);
  const candidates: Record<Side, Endpoint[]> = { from: [], to: [] };
  const ends: Record<Side, Endpoint | null> = { from: null, to: null };
  const chosen: Record<Side, boolean> = { from: false, to: false };
  const handPicked: Record<Side, boolean> = { from: false, to: false };
  let confirmed = true;
  for (const side of ['from', 'to'] as const) {
    const mine = list.filter((e) => e.side === side);
    candidates[side] = mine.filter((e) => !e.manual).map((e) => ({ kind: e.kind, id: e.id, label: e.label, levelId: e.levelId, confidence: e.confidence }));
    const pick = mine.find((e) => e.chosen);
    const only = mine.length === 1 ? mine[0] : undefined;
    const e = pick ?? only ?? null;
    ends[side] = e ? { kind: e.kind, id: e.id, label: e.label, levelId: e.levelId, confidence: e.confidence } : null;
    chosen[side] = !!pick;
    handPicked[side] = !!pick && (pick.manual || mine.length > 1);
    if (!pick?.confirmed) confirmed = false;
  }
  return { candidates, ends, chosen, handPicked, confirmed };
}

/** The `{side: code, value, confidence, source}` candidate the riser job writes for a line with no bubble (D192). */
export function codeGuessOf(raw: unknown): CodeGuess | null {
  const g = (json<unknown[]>(raw) ?? []).find((v): v is Record<string, unknown> => !!v && typeof v === 'object' && (v as Record<string, unknown>).side === 'code');
  const value = str(g?.value);
  if (!g || !value) return null;
  return { value, confidence: num(g.confidence), source: g.source === 'label' || g.source === 'model' ? g.source : null };
}

/** The candidates list with `pick` as the side's chosen endpoint (added when it was not a candidate); null clears the choice. */
export function withChosen(raw: unknown, side: Side, pick: Endpoint | null, confirmed = false): Record<string, unknown>[] {
  const list = (json<unknown[]>(raw) ?? []).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  const flag = confirmed ? { confirmed: true } : {};
  const same = (v: Record<string, unknown>) => !!pick && v.kind === pick.kind && v.id === pick.id;
  const out = list
    .filter((v) => !(v.side === side && v.manual === true && !same(v)))
    .map((v) => {
      if (v.side !== side) return v;
      const rest = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'chosen' && k !== 'confirmed'));
      return same(v) ? { ...rest, chosen: true, ...flag } : rest;
    });
  if (pick && !out.some((v) => v.side === side && same(v))) {
    out.push({ side, kind: pick.kind, id: pick.id, label: pick.label, level_id: pick.levelId, confidence: null, chosen: true, manual: true, ...flag });
  }
  return out;
}

// ------------------------------------------------------------------ mismatch list

/** One sentence per conflict worth a reader's eye, for the level's mismatch list (Phase 3 §3.3). */
export function deviceMismatches(d: DeviceDraftRow, levelCode: (id: string | null) => string | null): string[] {
  const model = d.name ? `${d.model ?? '?'} ${d.name}` : (d.model ?? '?');
  const out: string[] = [];
  for (const c of d.conflicts) {
    if (c === 'qty:bom≠riser') out.push(d.needs.qty ? `BOM qty ${d.needs.qty.bom ?? '?'} ≠ riser ${d.needs.qty.riser ?? '?'} (${model})` : `BOM and riser quantities differ (${model})`);
    else if (c === 'model:SR/LR') out.push(`SR or LR? ${d.candidates.join(' / ')} — pick one`);
    else if (c === 'level:06/06M') out.push(`${model}: on 06 or 06M? — pick the level`);
    else if (c === 'source:riser_only') out.push(`Riser device not in the BOM: ${model}`);
    else if (c === 'cards:bom≠riser') out.push(`Option cards differ between the BOM and the riser (${model})`);
    else if (c === 'pairing:ebdk≠erp') out.push(`EBDK and relay panels do not pair one to one (${model})`);
    else if (c === 'network:no_N_run') out.push(`No network (N) run drawn to ${model} on the riser`);
  }
  const venue = str(d.sourceRef?.venue);
  const code = levelCode(d.levelId);
  if (venue && code && d.levelBasis === 'venue' && firstNumber(venue) !== firstNumber(code)) out.push(`BOM venue "${venue}" → ${code} (level alias)`);
  return out;
}

export function cableMismatches(c: CableDraftRow): string[] {
  const what = `${c.code ?? '?'} from ${c.fromLabel ?? c.ends.from?.label ?? '?'}`;
  const out: string[] = [];
  for (const k of c.conflicts) {
    if (k === 'endpoint:unresolved') out.push(`${what}: far end not found — pick it`);
    else if (k === 'endpoint:low_confidence') out.push(`${what}: far end "${c.toLabel ?? '?'}" is a guess (${pct(c.confidence)}) — check the crop`);
    else if (k === 'code:unknown' && c.state === 'proposed') {
      const guess = c.codeGuess ? ` (guess: ${c.codeGuess.value})` : '';
      out.push(`A riser line with no wire code from ${c.fromLabel ?? '?'}${c.toLabel ? ` → "${c.toLabel}"` : ''} — what is it?${guess}`);
    }
  }
  return out;
}

function firstNumber(s: string): number | null {
  const m = /(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

export const pct = (c: number | null): string => (c == null ? '—' : c.toFixed(2));

// ------------------------------------------------------------------ the loader

type LevelRow = { id: string; level: string; floor_order: number | null; in_scope: number | boolean | null; split_of_id: string | null };

export function levelKeyOf(levelId: string | null, ref: Record<string, unknown> | null): LevelKey {
  if (levelId) return levelId;
  const code = str(ref?.level_code);
  return code ? `code:${code}` : POOL;
}

/** Everything the review screens show for one project (every level; the screen filters). */
export async function loadDraftReview(store: Store, projectId: string): Promise<DraftReviewData> {
  const levels = await store.list<LevelRow>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  const codeOf = new Map(levels.map((l) => [l.id, l.level]));
  const levelCode = (id: string | null) => (id ? (codeOf.get(id) ?? null) : null);
  const lvls = levels.map((l) => ({ id: l.id, code: l.level, splitOfId: l.split_of_id }));

  const rawDevices = await store.list<Record<string, unknown>>('draft_device', { where: 'project_id = ?', params: [projectId], includeDeleted: true });
  const rawCables = await store.list<Record<string, unknown>>('draft_cable', { where: 'project_id = ?', params: [projectId] });
  const live = await store.db.query<Record<string, unknown>>(
    `SELECT d.id, d.level_id, d.display_id, d.panel_name, d.category, d.device, d.library_type_id, d.baseline_ref_id FROM device d JOIN level l ON l.id = d.level_id
     WHERE l.project_id = ? AND d.deleted_at IS NULL`,
    [projectId],
  );
  const types = await loadDeviceTypes(store, projectId);
  const placeholders = await store.list<{ id: string; label: string; kind: string; level_id: string | null }>('placeholder', {
    where: 'project_id = ? AND deleted_at IS NULL',
    params: [projectId],
    orderBy: 'label',
  });
  const reviews = await store.list<Record<string, unknown>>('review_item', {
    where: `project_id = ? AND state = 'open' AND kind IN ('source_conflict', 'extraction')`,
    params: [projectId],
  });
  const reviewOf = new Map<string, string>();
  for (const r of reviews) {
    const subj = json<Record<string, unknown>>(r.subject);
    const id = str(subj?.entity_id);
    if (id) reviewOf.set(id, String(r.id));
  }

  const bomRefs = new Map<string, Record<string, unknown>>();
  for (const d of rawDevices) {
    const ref = json<Record<string, unknown>>(d.source_ref);
    if (ref?.kind === 'bom_line') bomRefs.set(String(d.id), ref);
  }

  const placedBy = new Map<string, number>();
  for (const d of live) if (d.baseline_ref_id) placedBy.set(String(d.baseline_ref_id), (placedBy.get(String(d.baseline_ref_id)) ?? 0) + 1);
  const modelKey = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
  const onLevel = new Map<string, number>();
  for (const d of live) {
    const k = `${String(d.level_id)}|${modelKey(d.device)}`;
    onLevel.set(k, (onLevel.get(k) ?? 0) + 1);
  }

  const devices: DeviceDraftRow[] = rawDevices
    .filter((d) => d.deleted_at == null)
    .map((d) => {
      const ref = json<Record<string, unknown>>(d.source_ref);
      const candidates = strings(d.candidates);
      const conflicts = strings(d.conflicts);
      const confidence = num(d.confidence);
      const levelId = str(d.level_id);
      const base = { candidates, conflicts, qty: num(d.qty), category: str(d.category), sourceRef: ref, levelId };
      const row: DeviceDraftRow = {
        id: String(d.id),
        levelId,
        levelCode: levelCode(levelId) ?? str(ref?.level_code),
        levelBasis: str(d.level_basis),
        model: str(d.model),
        modelRaw: str(d.model_raw),
        candidates,
        name: str(d.name),
        category: str(d.category),
        role: isRole(d.role) ? d.role : null,
        qty: num(d.qty),
        accessories: (json<Record<string, unknown>[]>(d.accessories) ?? []).map((a) => ({ model: str(a.model) ?? '?', qty: num(a.qty), role: str(a.role) ?? 'accessory' })),
        confidence,
        conflicts,
        state: (str(d.state) ?? 'proposed') as DraftState,
        extraction: str(d.extraction),
        src: srcBadge(ref, str(d.extraction)),
        sources: sourcesOf(ref, str(d.import_batch_id), bomRefs),
        flagged: conflicts.length > 0 || (confidence != null && confidence < REVIEW_BELOW),
        needs: deviceNeeds(base, lvls),
        placed: placedBy.get(String(d.id)) ?? 0,
        onLevel: levelId ? (onLevel.get(`${levelId}|${modelKey(d.model)}`) ?? 0) : 0,
        reviewItemId: reviewOf.get(String(d.id)) ?? null,
        sourceRef: ref,
        importBatchId: str(d.import_batch_id),
      };
      return row;
    });

  const draftDevice = new Map(devices.map((d) => [d.id, d]));
  const cables: CableDraftRow[] = rawCables.map((c) => {
    const ref = json<Record<string, unknown>>(c.source_ref);
    const conflicts = strings(c.conflicts);
    const confidence = num(c.confidence);
    const e = cableEnds(c.candidates);
    const state = (str(c.state) ?? 'proposed') as DraftState;
    const committed = c.placed === true || c.placed === 1;
    const levelId = str(c.level_id);
    const toLevelId = str(c.to_level_id);
    const decided = state === 'accepted' || state === 'edited';
    const row: CableDraftRow = {
      id: String(c.id),
      levelId,
      levelCode: levelCode(levelId) ?? str(ref?.level_code),
      toLevelId,
      toLevelCode: levelCode(toLevelId),
      code: str(c.code),
      qty: num(c.qty),
      fromLabel: str(c.from_label),
      toLabel: str(c.to_label),
      origin: str(c.origin),
      candidates: e.candidates,
      ends: e.ends,
      chosen: e.chosen,
      handPicked: e.handPicked,
      confirmed: e.confirmed,
      confidence,
      conflicts,
      state,
      extraction: str(c.extraction),
      src: srcBadge(ref, str(c.extraction)),
      sources: sourcesOf(ref, str(c.import_batch_id)),
      flagged: conflicts.length > 0 || (confidence != null && confidence < REVIEW_BELOW),
      committed,
      waiting: decided && !committed,
      sourceRef: ref,
      importBatchId: str(c.import_batch_id),
      unknownCode: conflicts.includes('code:unknown'),
      codeGuess: codeGuessOf(c.candidates),
    };
    // a draft-device endpoint shows that draft's current label
    for (const side of ['from', 'to'] as const) {
      const end = row.ends[side];
      const dd = end?.kind === 'draft_device' ? draftDevice.get(end.id) : undefined;
      if (end && dd && !end.levelId) end.levelId = dd.levelId;
    }
    return row;
  });

  const levelRows: ReviewLevel[] = levels.map((l) => ({
    key: l.id,
    code: l.level,
    title: l.level,
    levelId: l.id,
    inScope: l.in_scope === 1 || l.in_scope === true,
    devices: 0,
    cables: 0,
    open: 0,
  }));
  const byKey = new Map(levelRows.map((l) => [l.key, l]));
  const bump = (key: LevelKey, code: string | null, what: 'devices' | 'cables', open: boolean) => {
    let l = byKey.get(key);
    if (!l) {
      l = key === POOL
        ? { key, code: 'Pool', title: 'Pool (no level)', levelId: null, inScope: true, devices: 0, cables: 0, open: 0 }
        : { key, code: code ?? '?', title: `${code ?? '?'} (not in the project)`, levelId: null, inScope: false, devices: 0, cables: 0, open: 0 };
      byKey.set(key, l);
      levelRows.push(l);
    }
    l[what]++;
    if (open) l.open++;
  };
  for (const d of devices) bump(levelKeyOf(d.levelId, d.sourceRef), d.levelCode, 'devices', d.state === 'proposed');
  for (const c of cables) bump(levelKeyOf(c.levelId, c.sourceRef), c.levelCode, 'cables', c.state === 'proposed');

  return {
    levels: levelRows,
    devices,
    cables,
    codes: cableCodes(await loadRuleParams(store, projectId)),
    placeholders: placeholders.map((p) => ({ id: p.id, label: p.label, kind: p.kind, levelId: p.level_id })),
    devicesLive: live.map((d) => ({
      id: String(d.id),
      levelId: String(d.level_id),
      displayId: str(d.display_id),
      panelName: str(d.panel_name),
      category: str(d.category),
      role: roleOfDevice(types, d),
      device: str(d.device),
      baselineRef: str(d.baseline_ref_id),
      label: [str(d.display_id) ?? `${levelCode(String(d.level_id)) ?? '?'}-?`, str(d.panel_name) ?? str(d.device) ?? str(d.category)].filter(Boolean).join(' '),
    })),
  };
}

// ------------------------------------------------------------------ views

export function matchesFilter(r: { state: DraftState; flagged: boolean; conflicts: string[] }, f: DraftFilter): boolean {
  switch (f) {
    case 'open':
      return r.state === 'proposed';
    case 'review':
      return r.state === 'proposed' && r.flagged;
    case 'conflict':
      return r.state === 'proposed' && r.conflicts.length > 0;
    case 'accepted':
      return r.state === 'accepted' || r.state === 'edited';
    case 'rejected':
      return r.state === 'rejected';
    default:
      return true;
  }
}

export type SortKey = 'confidence' | 'model' | 'state';

/** The rows of one level under a filter; lowest confidence first by default (what needs eyes first). */
export function devicesOn(data: DraftReviewData, key: LevelKey, f: DraftFilter, sort: SortKey = 'confidence'): DeviceDraftRow[] {
  const rows = data.devices.filter((d) => levelKeyOf(d.levelId, d.sourceRef) === key && matchesFilter(d, f));
  return sortRows(rows, sort, (d) => d.model ?? '');
}

export function cablesOn(data: DraftReviewData, key: LevelKey, f: DraftFilter, sort: SortKey = 'confidence'): CableDraftRow[] {
  const rows = data.cables.filter((c) => levelKeyOf(c.levelId, c.sourceRef) === key && matchesFilter(c, f));
  // open lines with no wire code first (T108: "What is this cable?"), then by the sort
  const asking = (c: CableDraftRow) => c.state === 'proposed' && c.unknownCode;
  return sortRows(rows, sort, (c) => `${c.code ?? ''} ${c.fromLabel ?? ''}`).sort((a, b) => Number(asking(b)) - Number(asking(a)));
}

const STATE_ORDER: Record<DraftState, number> = { proposed: 0, edited: 1, accepted: 1, rejected: 2 };

function sortRows<T extends { confidence: number | null; state: DraftState; id: string }>(rows: T[], sort: SortKey, text: (r: T) => string): T[] {
  return [...rows].sort((a, b) => {
    if (sort === 'model') return text(a).localeCompare(text(b)) || a.id.localeCompare(b.id);
    if (sort === 'state') return STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.confidence ?? 2) - (b.confidence ?? 2) || a.id.localeCompare(b.id);
    return (a.confidence ?? 2) - (b.confidence ?? 2) || text(a).localeCompare(text(b)) || a.id.localeCompare(b.id);
  });
}

/** The header counts of one level: devices, cables, and the open drafts that wait in Needs review. */
export function levelCounts(data: DraftReviewData, key: LevelKey): { devices: number; cables: number; review: number; bulk: number } {
  const ds = data.devices.filter((d) => levelKeyOf(d.levelId, d.sourceRef) === key && d.state !== 'rejected');
  const cs = data.cables.filter((c) => levelKeyOf(c.levelId, c.sourceRef) === key && c.state !== 'rejected');
  const review = [...ds, ...cs].filter((r) => r.state === 'proposed' && r.flagged).length;
  return { devices: ds.length, cables: cs.length, review, bulk: bulkDevices(data, key).length + bulkCables(data, key).length };
}

/** Device drafts Accept all takes: open, ≥ 0.9, no conflict, nothing to choose, on a level. */
export function bulkDevices(data: DraftReviewData, key: LevelKey, min = BULK_MIN): DeviceDraftRow[] {
  return data.devices.filter(
    (d) =>
      levelKeyOf(d.levelId, d.sourceRef) === key &&
      d.state === 'proposed' &&
      d.levelId != null &&
      d.confidence != null &&
      d.confidence >= min &&
      d.conflicts.length === 0 &&
      Object.keys(d.needs).length === 0,
  );
}

/** Cable drafts Accept all takes: open, ≥ 0.9, no conflict, a code and both ends resolved. Their cables stay unconfirmed (D6). */
export function bulkCables(data: DraftReviewData, key: LevelKey, min = BULK_MIN): CableDraftRow[] {
  return data.cables.filter(
    (c) =>
      levelKeyOf(c.levelId, c.sourceRef) === key &&
      c.state === 'proposed' &&
      c.confidence != null &&
      c.confidence >= min &&
      c.conflicts.length === 0 &&
      c.code != null &&
      c.ends.from != null &&
      c.ends.to != null,
  );
}

/** The level's mismatch list: device sentences, then cable sentences, each pointing at its draft. */
export function mismatchList(data: DraftReviewData, key: LevelKey): Mismatch[] {
  const code = (id: string | null) => data.levels.find((l) => l.levelId === id)?.code ?? null;
  const out: Mismatch[] = [];
  for (const d of data.devices) {
    if (levelKeyOf(d.levelId, d.sourceRef) !== key || d.state === 'rejected') continue;
    for (const text of deviceMismatches(d, code)) out.push({ draftId: d.id, kind: 'device', text });
  }
  for (const c of data.cables) {
    if (levelKeyOf(c.levelId, c.sourceRef) !== key || c.state !== 'proposed') continue;
    for (const text of cableMismatches(c)) out.push({ draftId: c.id, kind: 'cable', text });
  }
  return out;
}

// ------------------------------------------------------------------ endpoint options

/**
 * The live device a draft device has become: one placed from it (`baseline_ref`, T46), else the
 * one device on its level that is plainly the same — the same panel tag, or the only device of
 * its role (T115; its category when the role is `other`) when the draft names no tag and counts
 * one (the seeded master's panels, racks and NSPS, D30). Null when there is none or more than one.
 */
export function deviceForDraft(
  data: Pick<DraftReviewData, 'devicesLive'>,
  d: Pick<DeviceDraftRow, 'id' | 'levelId' | 'name' | 'category' | 'qty'> & { role?: Role | null },
): DraftReviewData['devicesLive'][number] | null {
  const placed = data.devicesLive.filter((x) => x.baselineRef === d.id);
  if (placed.length === 1) return placed[0]!;
  if (placed.length > 1 || !d.levelId) return null;
  const here = data.devicesLive.filter((x) => x.levelId === d.levelId);
  const tag = d.name?.replace(/\s+/g, '').toUpperCase();
  const role = draftRole(d);
  if (tag && role !== 'equipment_rack') {
    const byTag = here.filter((x) => x.panelName?.replace(/\s+/g, '').toUpperCase() === tag);
    return byTag.length === 1 ? byTag[0]! : null;
  }
  if (d.qty === 1 && d.category) {
    // the draft writes the D196 category, the seeded master its own spelling: compare roles
    const same = role !== 'other' ? here.filter((x) => x.role === role) : here.filter((x) => canonicalCategory(x.category) === canonicalCategory(d.category));
    return same.length === 1 ? same[0]! : null;
  }
  return null;
}

/** A draft's role (T115): the one the extraction read, else its category's. */
export function draftRole(d: { role?: Role | null; category: string | null }): Role {
  return d.role ?? roleOfCategory(d.category);
}

/**
 * What a side can be set to, best first: the side's candidates (a draft device shown as the
 * device it has become when there is one), then devices and draft devices on the side's level,
 * then placeholders. `query` filters by text.
 */
export function endpointOptions(data: DraftReviewData, c: CableDraftRow, side: Side, query = ''): Endpoint[] {
  const q = query.trim().toUpperCase();
  const levelId = side === 'from' ? c.levelId : (c.toLevelId ?? c.levelId);
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  const add = (e: Endpoint) => {
    const k = `${e.kind}:${e.id}`;
    if (seen.has(k)) return;
    if (q && !e.label.toUpperCase().includes(q)) return;
    seen.add(k);
    out.push(e);
  };
  const draftById = new Map(data.devices.map((d) => [d.id, d]));
  const asDevice = (dd: DeviceDraftRow) => {
    const dev = deviceForDraft(data, dd);
    return dev ? { kind: 'device' as const, id: dev.id, label: `${dev.label} (in the baseline)`, levelId: dev.levelId } : null;
  };
  for (const e of c.candidates[side]) {
    const dd = e.kind === 'draft_device' ? draftById.get(e.id) : undefined;
    const dev = dd ? asDevice(dd) : null;
    if (dev) add(dev);
    add(e);
  }
  const scope = (id: string | null) => !levelId || !q ? id === levelId : true;
  for (const d of data.devicesLive) if (scope(d.levelId)) add({ kind: 'device', id: d.id, label: d.label, levelId: d.levelId });
  for (const d of data.devices) {
    if (d.state === 'rejected' || !scope(d.levelId)) continue;
    add({ kind: 'draft_device', id: d.id, label: `${d.name ?? d.model ?? '?'} (draft${d.levelCode ? `, ${d.levelCode}` : ''})`, levelId: d.levelId });
  }
  for (const p of data.placeholders) add({ kind: 'placeholder', id: p.id, label: p.label, levelId: p.levelId });
  return out;
}

/**
 * Open drafts that wait in Needs review (D11: under 0.7 or carrying a conflict), counted for the
 * Needs review screen's Extraction tab, which links to the draft review. No review items are
 * written for them: the draft's own state is the record.
 */
export async function flaggedDraftCounts(store: Store, projectId: string): Promise<{ devices: number; cables: number }> {
  const count = async (table: 'draft_device' | 'draft_cable') => {
    const rows = await store.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND deleted_at IS NULL AND state = 'proposed'
       AND ((conflicts IS NOT NULL AND conflicts NOT IN ('[]', 'null')) OR (confidence IS NOT NULL AND confidence < ?))`,
      [projectId, REVIEW_BELOW],
    );
    return Number(rows[0]?.n ?? 0);
  };
  return { devices: await count('draft_device'), cables: await count('draft_cable') };
}
