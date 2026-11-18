/**
 * Library suggestion chips (T99, D172, D174, D212): one `suggestion` row per phrase, hung off a
 * device type (`ref` = its id), a device category (the canonical name) or a cable code, and
 * offered in one place (`target`): a device's Notes, a connection end's Note, a punch item's
 * Item, a missing part's Part. Every chip is the app library's (`project_id` null, written to the
 * library stream, D184; T196, D292 (9)): a project reads them directly (`loadChipRows`) and holds
 * none of its own, and the server refuses a chip in a project's stream. They are edited in the
 * Library only (T197): every write here refuses an editor on a project's stream. Chips are suggestions a
 * person picks: free typing stays, and the rules keep raising their own drafts (D174 (4)).
 * No React or Expo imports: tested in Node.
 */

import { OpError, canonicalCategory, isLibraryStream, type EditContext, type Editor, type Store, type vocab } from '@field-survey/core';
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
  scope: SuggestionScope;
  ref: string;
  target: SuggestionTarget;
  text: string;
  state: SuggestionState;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const key = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

function toSuggestion(r: Row): Suggestion {
  return {
    id: String(r.id),
    scope: r.scope as SuggestionScope,
    ref: String(r.ref),
    target: r.target as SuggestionTarget,
    text: String(r.text),
    state: (str(r.state) ?? 'draft') as SuggestionState,
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

/** Every live chip of the library (the app library's: every chip is app-level, D292 (9)), oldest first. */
export async function loadSuggestions(store: Store): Promise<Suggestion[]> {
  const rows = await store.list<Row>('suggestion', { where: 'project_id IS NULL', orderBy: 'id' });
  return rows.map(toSuggestion);
}

/** A chip is edited in the Library only (D292 (9)): an editor on a project's stream is refused. */
function libraryOnly(editor: Editor): void {
  if (!isLibraryStream(editor.projectId)) throw new OpError('Suggestion chips are edited in the Library.');
}

/**
 * The chips a project's screens draw from (T196, D292 (9)): the app library's — every chip is
 * app-level — its category and code chips and the chips of `typeIds`, accepted ones only (a draft
 * waits for its review in the Library, as the app library's drafts always did). The project's
 * `vocab` phrases follow them as `chipsFor`'s `fallback`.
 */
export async function loadChipRows(store: Store, typeIds: readonly (string | null | undefined)[] = []): Promise<Suggestion[]> {
  const ids = typeIds.filter((t): t is string => !!t);
  const byType = ids.length ? ` OR (scope = 'type' AND ref IN (${ids.map(() => '?').join(', ')}))` : '';
  const rows = await store.list<Row>('suggestion', {
    where: `project_id IS NULL AND state = 'accepted' AND (scope IN ('category', 'code')${byType})`,
    params: ids,
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

/** The app library's accepted rule parameters: what a chip's kit settings read when it is added. */
async function libraryParams(store: Store): Promise<RuleParams> {
  return new RuleParams(await loadRuleParamRows(store, null));
}

function check(input: SuggestionInput, params: RuleParams): SuggestionInput {
  const text = input.text.trim().replace(/\s+/g, ' ');
  const ref = refOf(input.scope, input.ref);
  if (!text) throw new OpError('Type the phrase first.');
  if (!ref) throw new OpError('Pick what the chip is for.');
  if (input.scope === 'code' && input.target === 'part' && !offersPartChips(params, ref))
    throw new OpError(`A ${ref} cable offers no Part chips: its termination kits are off in the Rules. Offer it as an End Note or a Punch item.`);
  return { scope: input.scope, ref, target: input.target, text };
}

function duplicate(list: readonly Suggestion[], s: SuggestionInput, exceptId: string | null = null): Suggestion | undefined {
  return list.find((x) => x.id !== exceptId && x.state !== 'rejected' && x.scope === s.scope && sameRef(s.scope, x.ref, s.ref) && x.target === s.target && key(x.text) === key(s.text));
}

/** "+ add": a draft chip in the library (on its stream). A chip already there is refused. */
export async function addSuggestion(editor: Editor, store: Store, input: SuggestionInput): Promise<string> {
  libraryOnly(editor);
  const s = check(input, await libraryParams(store));
  const clash = duplicate(await loadSuggestions(store), s);
  if (clash) throw new OpError(`"${clash.text}" is already offered there.`);
  const { id } = await editor.create('suggestion', { project_id: null, ...s, state: 'draft', created_by_id: editor.userId }, SUGGESTION_CTX);
  return id;
}

export async function editSuggestion(editor: Editor, store: Store, id: string, text: string): Promise<void> {
  libraryOnly(editor);
  const row = await store.get<Row>('suggestion', id);
  if (!row || row.deleted_at) throw new OpError('That chip is gone.');
  const cur = toSuggestion(row);
  const s = check({ ...cur, text }, await libraryParams(store));
  if (s.text === cur.text) return;
  const clash = duplicate(await loadSuggestions(store), s, id);
  if (clash) throw new OpError(`"${clash.text}" is already offered there.`);
  await editor.setField('suggestion', id, 'text', s.text, SUGGESTION_CTX);
}

export async function acceptSuggestion(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('suggestion', id, 'state', 'accepted', SUGGESTION_CTX);
}

/** Reject a draft: it leaves the chips, and stays listed so the seed does not offer it again. */
export async function rejectSuggestion(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('suggestion', id, 'state', 'rejected', SUGGESTION_CTX);
}

export async function reopenSuggestion(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('suggestion', id, 'state', 'draft', SUGGESTION_CTX);
}

/** Remove a chip (a soft delete: nothing is hard-deleted). */
export async function removeSuggestion(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.delete('suggestion', id, SUGGESTION_CTX);
}

/**
 * "Load standard suggestions" in the app library (D174 (3)): the seed per category and cable
 * code as drafts for Landry to accept, only what is missing (a rejected one is not offered again).
 */
export async function loadStandardSuggestions(libraryEditor: Editor, store: Store): Promise<number> {
  if (!isLibraryStream(libraryEditor.projectId)) throw new OpError('The standard suggestions go to the app library.');
  const all = await loadSuggestions(store);
  const add = SUGGESTION_SEED.filter((s) => !all.some((x) => x.scope === s.scope && sameRef(s.scope, x.ref, s.ref) && x.target === s.target && key(x.text) === key(s.text)));
  if (!add.length) return 0;
  await libraryEditor.group({ ...SUGGESTION_CTX, reason: 'Library suggestions: standard seed' }, async (g) => {
    for (const s of add) await g.create('suggestion', { project_id: null, ...s, state: 'draft', created_by_id: libraryEditor.userId });
  });
  return add.length;
}
