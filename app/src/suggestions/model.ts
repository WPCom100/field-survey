/**
 * Library suggestion chips (T99, D172, D174, D212): one `suggestion` row per phrase, hung off a
 * device type (`ref` = its id), a device category (the canonical name) or a cable code, and
 * offered in one place (`target`): a device's Notes, a connection end's Note, a punch item's
 * Item, a missing part's Part. Rows live at the library's two scopes (D65): the app library
 * (`project_id` null, written to the library stream, D184) and a project's own. A project reads
 * its own category and code chips and its types' chips; the app library's reach it by copying
 * (project creation, "Copy from app library", or with a copied type). Chips are suggestions a
 * person picks: free typing stays, and the rules keep raising their own drafts (D174 (4)).
 * No React or Expo imports: tested in Node.
 */

import { LIBRARY_STREAM, OpError, canonicalCategory, type EditBatch, type EditContext, type Editor, type Store, type vocab } from '@field-survey/core';
import { DEFAULT_PARAMS, RuleParams, fillTemplate, loadRuleParamRows, textParam } from '@field-survey/rules';

import { SUGGESTION_SEED } from './seed';

export type SuggestionScope = (typeof vocab.SUGGESTION_SCOPE)[number];
export type SuggestionTarget = (typeof vocab.SUGGESTION_TARGET)[number];
export type SuggestionState = 'draft' | 'accepted' | 'rejected';

export const SUGGESTION_CTX: EditContext = { change_type: 'Master edit', reason: 'Library suggestions' };

/** Where a chip is offered, in the editor's order and words. */
export const TARGETS: readonly { target: SuggestionTarget; label: string }[] = [
  { target: 'device_note', label: 'Device Notes' },
  { target: 'connection_note', label: 'End Note' },
  { target: 'punch_item', label: 'Punch item' },
  { target: 'part', label: 'Part' },
];

/** The network codes: their terminations are missing parts only where they take kits (R4, D213). */
export const NETWORK_CODES: readonly string[] = ['N', 'NG'];

/** The end-Note chip of a run pulled but waiting on its kits (CLAUDE.md §3): offered only on a cable that takes kits (R2a lints it elsewhere). */
export const NO_TERM_KIT = 'Run, not terminated; no term kit';

/** Does a cable of `code` take termination kits (T118, D213)? The cable's own `term_kit` when set, else the code's `R4b.kit`. */
export function codeTakesKits(params: RuleParams, code: string | null | undefined, termKit?: boolean | null): boolean {
  if (termKit != null) return termKit;
  return !!code && params.flagCode('R4b', 'kit', code);
}

/**
 * Does a cable code offer Part chips (R4, D213)? Every code does, except a network code whose
 * kits are off (in the scope's `R4b.kit`, or on the one cable through `termKit`).
 */
export function offersPartChips(params: RuleParams, code: string, termKit?: boolean | null): boolean {
  const c = code.toUpperCase();
  return !NETWORK_CODES.includes(c) || codeTakesKits(params, c, termKit);
}

/**
 * The kit's Part chip for a code: the scope's `R4b.part` up to its far end ("DMX termination kit",
 * "Network termination kit"), else "<Signal> termination kit".
 */
export function kitPartChip(params: RuleParams, code: string): string {
  const word = params.code('R3', 'signal', code);
  const cut = textParam(params, 'R4b', 'part', code).split('<far end>')[0]!;
  const text = fillTemplate(cut, { signal: word }).replace(/[\s\-–—:,(]+$/, '').trim() || `${word} termination kit`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface Suggestion {
  id: string;
  projectId: string | null;
  scope: SuggestionScope;
  ref: string;
  target: SuggestionTarget;
  text: string;
  state: SuggestionState;
  promotedFromId: string | null;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const key = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

function toSuggestion(r: Row): Suggestion {
  return {
    id: String(r.id),
    projectId: str(r.project_id),
    scope: r.scope as SuggestionScope,
    ref: String(r.ref),
    target: r.target as SuggestionTarget,
    text: String(r.text),
    state: (str(r.state) ?? 'draft') as SuggestionState,
    promotedFromId: str(r.promoted_from_id),
  };
}

/** The key a scope's `ref` is stored and compared under: the canonical category; a code or a type id as is. */
export function refOf(scope: SuggestionScope, ref: string): string {
  const r = ref.trim();
  return scope === 'category' ? (canonicalCategory(r) ?? r) : r;
}

function sameRef(scope: SuggestionScope, a: string, b: string): boolean {
  return scope === 'code' ? a.toUpperCase() === b.toUpperCase() : refOf(scope, a) === refOf(scope, b);
}

/** Every live chip of one library (`library` = project id, null = the app library), oldest first. */
export async function loadSuggestions(store: Store, library: string | null): Promise<Suggestion[]> {
  const rows = await store.list<Row>('suggestion', library ? { where: 'project_id = ?', params: [library], orderBy: 'id' } : { where: 'project_id IS NULL', orderBy: 'id' });
  return rows.map(toSuggestion);
}

/** The chips a project's screens draw from: its own category and code chips, and the chips of `typeIds` (whatever library the type is in). Rejected ones left out. */
export async function loadChipRows(store: Store, projectId: string, typeIds: readonly (string | null | undefined)[] = []): Promise<Suggestion[]> {
  const ids = typeIds.filter((t): t is string => !!t);
  const byType = ids.length ? ` OR (scope = 'type' AND ref IN (${ids.map(() => '?').join(', ')}))` : '';
  const rows = await store.list<Row>('suggestion', {
    where: `state <> 'rejected' AND ((project_id = ? AND scope IN ('category', 'code'))${byType})`,
    params: [projectId, ...ids],
    orderBy: 'id',
  });
  return rows.map(toSuggestion);
}

/** What a chip strip is for: the device's type and category, the cable codes in play. */
export interface ChipContext {
  typeId?: string | null;
  category?: string | null;
  codes?: readonly (string | null | undefined)[];
  /** The scope's rule parameters the kit chips follow (`R4b.kit`, `R4b.part`, `R3.signal`); absent = the built-in defaults. */
  params?: RuleParams;
  /** The one cable's own Termination kits setting (`cable.term_kit`), over its code's; null = the code's. */
  termKit?: boolean | null;
}

/**
 * The chips one field offers (D174 (2)): the type's, then the category's, then the codes', then
 * `fallback` (the project's `vocab` list), most specific first; the same phrase once (the first
 * place wins, ignoring case and spacing); rejected rows never. Kits follow D213 (T118): a code
 * that takes kits also offers the "; no term kit" end Note and its kit's Part chip; with codes
 * given and none taking kits, no "no term kit" Note is offered; a network code with kits off
 * offers no Part chips.
 */
export function chipsFor(rows: readonly Suggestion[], ctx: ChipContext, target: SuggestionTarget, fallback: readonly string[] = []): string[] {
  const live = rows.filter((r) => r.target === target && r.state !== 'rejected');
  const ordered: string[] = [];
  if (ctx.typeId) ordered.push(...live.filter((r) => r.scope === 'type' && r.ref === ctx.typeId).map((r) => r.text));
  const category = ctx.category;
  if (category) ordered.push(...live.filter((r) => r.scope === 'category' && sameRef('category', r.ref, category)).map((r) => r.text));
  const params = ctx.params ?? DEFAULT_PARAMS;
  const codes = (ctx.codes ?? []).filter((c): c is string => !!c);
  const listed = new Set(fallback.map(key));
  for (const code of codes) {
    if (target === 'part' && !offersPartChips(params, code, ctx.termKit)) continue;
    ordered.push(...live.filter((r) => r.scope === 'code' && sameRef('code', r.ref, code)).map((r) => r.text));
    if (!codeTakesKits(params, code, ctx.termKit)) continue;
    // the kit chips, unless the project's list offers them already (its order stands)
    const kit = target === 'connection_note' ? NO_TERM_KIT : target === 'part' ? kitPartChip(params, code) : null;
    if (kit && !listed.has(key(kit))) ordered.push(kit);
  }
  ordered.push(...fallback);
  const noKits = codes.length > 0 && !codes.some((c) => codeTakesKits(params, c, ctx.termKit));
  const seen = new Set<string>();
  return ordered.filter((t) => {
    const k = key(t);
    if (!k || seen.has(k)) return false;
    if (noKits && /no term kit/i.test(t)) return false;
    seen.add(k);
    return true;
  });
}

export interface SuggestionInput {
  scope: SuggestionScope;
  ref: string;
  target: SuggestionTarget;
  text: string;
}

/** The accepted rule parameters of a library (a project's, or the app library's): what its kit settings read. */
async function libraryParams(store: Store, library: string | null): Promise<RuleParams> {
  return new RuleParams(await loadRuleParamRows(store, library));
}

function check(input: SuggestionInput, params: RuleParams): SuggestionInput {
  const text = input.text.trim().replace(/\s+/g, ' ');
  const ref = refOf(input.scope, input.ref);
  if (!text) throw new OpError('Type the phrase first.');
  if (!ref) throw new OpError('Pick what the chip is for.');
  if (input.scope === 'code' && input.target === 'part' && !offersPartChips(params, ref))
    throw new OpError(`A ${ref} cable offers no Part chips: its termination kits are off in the Rules (R4b), so network terminations are never missing parts (R4). Offer it as an End Note or a Punch item.`);
  return { scope: input.scope, ref, target: input.target, text };
}

function duplicate(list: readonly Suggestion[], s: SuggestionInput, exceptId: string | null = null): Suggestion | undefined {
  return list.find((x) => x.id !== exceptId && x.state !== 'rejected' && x.scope === s.scope && sameRef(s.scope, x.ref, s.ref) && x.target === s.target && key(x.text) === key(s.text));
}

/** "+ add": a draft chip in `library` (the editor writes to that library's stream). A chip already there is refused. */
export async function addSuggestion(editor: Editor, store: Store, library: string | null, input: SuggestionInput): Promise<string> {
  const s = check(input, await libraryParams(store, library));
  const clash = duplicate(await loadSuggestions(store, library), s);
  if (clash) throw new OpError(`"${clash.text}" is already offered there.`);
  const { id } = await editor.create('suggestion', { project_id: library, ...s, state: 'draft', created_by_id: editor.userId }, SUGGESTION_CTX);
  return id;
}

export async function editSuggestion(editor: Editor, store: Store, id: string, text: string): Promise<void> {
  const row = await store.get<Row>('suggestion', id);
  if (!row || row.deleted_at) throw new OpError('That chip is gone.');
  const cur = toSuggestion(row);
  const s = check({ ...cur, text }, await libraryParams(store, cur.projectId));
  if (s.text === cur.text) return;
  const clash = duplicate(await loadSuggestions(store, cur.projectId), s, id);
  if (clash) throw new OpError(`"${clash.text}" is already offered there.`);
  await editor.setField('suggestion', id, 'text', s.text, SUGGESTION_CTX);
}

export async function acceptSuggestion(editor: Editor, id: string): Promise<void> {
  await editor.setField('suggestion', id, 'state', 'accepted', SUGGESTION_CTX);
}

/** Reject a draft: it leaves the chips, and stays listed so the seed does not offer it again. */
export async function rejectSuggestion(editor: Editor, id: string): Promise<void> {
  await editor.setField('suggestion', id, 'state', 'rejected', SUGGESTION_CTX);
}

export async function reopenSuggestion(editor: Editor, id: string): Promise<void> {
  await editor.setField('suggestion', id, 'state', 'draft', SUGGESTION_CTX);
}

/** Remove a chip (a soft delete: nothing is hard-deleted). */
export async function removeSuggestion(editor: Editor, id: string): Promise<void> {
  await editor.delete('suggestion', id, SUGGESTION_CTX);
}

/**
 * Inside a type copy's group (`copyTypes`): the accepted chips of `fromTypeId` onto its copy
 * `toTypeId` in `library`, accepted like the type; a promotion records `promoted_from_id`.
 */
export async function copyTypeChips(g: EditBatch, store: Store, fromTypeId: string, toTypeId: string, library: string | null, userId: string): Promise<number> {
  const rows = await store.list<Row>('suggestion', { where: `scope = 'type' AND ref = ? AND state = 'accepted'`, params: [fromTypeId], orderBy: 'id' });
  for (const r of rows) {
    await g.create('suggestion', {
      project_id: library,
      scope: 'type',
      ref: toTypeId,
      target: r.target,
      text: r.text,
      state: 'accepted',
      created_by_id: userId,
      ...(library === null && r.project_id ? { promoted_from_id: r.id } : {}),
    });
  }
  return rows.length;
}

/**
 * "Promote to app library" for one accepted project chip (D65): a category or code chip becomes
 * the app library's; a type's chip goes onto the app type promoted from that type (promote the
 * type first). Refused when the app library already offers it.
 */
export async function promoteSuggestion(libraryEditor: Editor, store: Store, id: string): Promise<string> {
  if (libraryEditor.projectId !== LIBRARY_STREAM) throw new OpError('Promotion writes to the app library.');
  const row = await store.get<Row>('suggestion', id);
  if (!row || row.deleted_at || !row.project_id) throw new OpError('Only a project chip can be promoted.');
  const s = toSuggestion(row);
  if (s.state !== 'accepted') throw new OpError('Accept the chip before promoting it.');
  let ref = s.ref;
  if (s.scope === 'type') {
    const app = await store.list<Row>('library_type', { where: 'project_id IS NULL AND promoted_from_id = ?', params: [s.ref], orderBy: 'id' });
    if (!app.length) throw new OpError('Promote the type to the app library first; its chips go with it.');
    ref = String(app.at(-1)!.id);
  }
  const target: SuggestionInput = { scope: s.scope, ref, target: s.target, text: s.text };
  if (duplicate(await loadSuggestions(store, null), target)) throw new OpError(`The app library already offers "${s.text}" there.`);
  const { id: made } = await libraryEditor.create('suggestion', { project_id: null, ...target, state: 'accepted', created_by_id: libraryEditor.userId, promoted_from_id: s.id }, SUGGESTION_CTX);
  return made;
}

/**
 * "Copy from app library" for a project that exists already (project creation copies them on
 * the server): the app library's accepted category and code chips this project lacks, accepted,
 * in one group. A type's chips come with the type (Copy from… in the type list).
 */
export async function copyAppSuggestions(editor: Editor, store: Store, projectId: string): Promise<number> {
  const have = await loadSuggestions(store, projectId);
  const app = (await loadSuggestions(store, null)).filter((s) => s.state === 'accepted' && s.scope !== 'type');
  const add = app.filter((s, i) => !duplicate(have, s) && !duplicate(app.slice(0, i), s));
  if (!add.length) return 0;
  await editor.group({ ...SUGGESTION_CTX, reason: 'Library suggestions: copied from the app library' }, async (g) => {
    for (const s of add) {
      await g.create('suggestion', { project_id: projectId, scope: s.scope, ref: s.ref, target: s.target, text: s.text, state: 'accepted', created_by_id: editor.userId });
    }
  });
  return add.length;
}

/**
 * "Load standard suggestions" in the app library (D174 (3)): the seed per category and cable
 * code as drafts for Landry to accept, only what is missing (a rejected one is not offered again).
 */
export async function loadStandardSuggestions(libraryEditor: Editor, store: Store): Promise<number> {
  if (libraryEditor.projectId !== LIBRARY_STREAM) throw new OpError('The standard suggestions go to the app library.');
  const all = await loadSuggestions(store, null);
  const add = SUGGESTION_SEED.filter((s) => !all.some((x) => x.scope === s.scope && sameRef(s.scope, x.ref, s.ref) && x.target === s.target && key(x.text) === key(s.text)));
  if (!add.length) return 0;
  await libraryEditor.group({ ...SUGGESTION_CTX, reason: 'Library suggestions: standard seed' }, async (g) => {
    for (const s of add) await g.create('suggestion', { project_id: null, ...s, state: 'draft', created_by_id: libraryEditor.userId });
  });
  return add.length;
}
