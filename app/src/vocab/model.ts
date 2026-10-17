/**
 * Vocabulary and placeholder editors (T40, T104; PLAN §2.2, D26, D182, D187, D214): reads and
 * edits of the `vocab` lists and a project's `placeholder` rows. Vocabulary lives at two scopes,
 * like the device-type library (D65): a project's own rows and the app library's (`project_id`
 * null, written through an `Editor` on `LIBRARY_STREAM`). Every function takes the scope from its
 * editor (`scopeOf`) or a `scope` argument (a project id, or null for the app library). A value
 * added to a list is a draft, usable at once and flagged until accepted (D43/D48); removing is a
 * soft delete. A project reads its own rows only; app values reach it by copying (project
 * creation on the server, or "Copy from app library"). Every write is one op through `Editor`.
 * No React or Expo imports: tested in Node.
 */

import { LIBRARY_STREAM, OpError, isLibraryStream, type EditBatch, type EditContext, type Editor, type Store } from '@field-survey/core';

import { SEED_PLACEHOLDERS, SEED_VOCAB, SEED_VOCAB_VARIANTS, VOCAB_LISTS, VOCAB_PAIR_LISTS, type PlaceholderKind, type VocabListKey, type VocabPairListKey } from './seed';

type Row = Record<string, unknown>;

const VOCAB_CTX: EditContext = { change_type: 'Master edit', reason: 'Vocabulary' };
const PLACEHOLDER_CTX: EditContext = { change_type: 'Master edit', reason: 'Placeholders' };

export interface VocabEntry {
  id: string;
  value: string;
  draft: boolean;
}
export type VocabView = Record<VocabListKey, VocabEntry[]>;

/** A canonical value of a pair list (D187) with the raw spellings that stand for it. */
export interface VocabPair extends VocabEntry {
  variants: VocabEntry[];
}
export type VocabPairView = Record<VocabPairListKey, VocabPair[]>;

export interface PlaceholderEntry {
  id: string;
  label: string;
  kind: PlaceholderKind;
  levelId: string | null;
}

/** Collapse spaces, trim; empty → null. */
export function cleanValue(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The scope an editor writes to: its project, or null (the app library) on `LIBRARY_STREAM`. */
export function scopeOf(editor: Editor): string | null {
  return isLibraryStream(editor.projectId) ? null : editor.projectId;
}

function scopeWhere(scope: string | null): { where: string; params: string[] } {
  return scope == null ? { where: 'project_id IS NULL', params: [] } : { where: 'project_id = ?', params: [scope] };
}

/** Every live row of the scope (canonicals and variants), in creation order. */
async function rowsOf(store: Store, scope: string | null, list?: string): Promise<Row[]> {
  const s = scopeWhere(scope);
  return store.list<Row>('vocab', { where: list ? `${s.where} AND list = ?` : s.where, params: list ? [...s.params, list] : s.params, orderBy: 'id' });
}

const entryOf = (r: Row): VocabEntry => ({ id: String(r.id), value: String(r.value), draft: r.state === 'draft' });

export async function loadVocab(store: Store, scope: string | null): Promise<VocabView> {
  const view = Object.fromEntries(VOCAB_LISTS.map((l) => [l.list, [] as VocabEntry[]])) as VocabView;
  for (const r of await rowsOf(store, scope)) if (!r.canonical_of_id) view[String(r.list) as VocabListKey]?.push(entryOf(r));
  return view;
}

/** The pair lists (`model_map`, `level_alias`): each canonical row with its variant rows. */
export async function loadPairs(store: Store, scope: string | null): Promise<VocabPairView> {
  const view = Object.fromEntries(VOCAB_PAIR_LISTS.map((l) => [l.list, [] as VocabPair[]])) as VocabPairView;
  const rows = (await rowsOf(store, scope)).filter((r) => VOCAB_PAIR_LISTS.some((l) => l.list === r.list));
  const byId = new Map<string, VocabPair>();
  for (const r of rows) {
    if (r.canonical_of_id) continue;
    const p: VocabPair = { ...entryOf(r), variants: [] };
    byId.set(p.id, p);
    view[String(r.list) as VocabPairListKey].push(p);
  }
  for (const r of rows) if (r.canonical_of_id) byId.get(String(r.canonical_of_id))?.variants.push(entryOf(r));
  return view;
}

export async function loadPlaceholders(store: Store, projectId: string): Promise<PlaceholderEntry[]> {
  const rows = await store.list<Row>('placeholder', { where: 'project_id = ?', params: [projectId], orderBy: 'id' });
  return rows.map((r) => ({ id: String(r.id), label: String(r.label), kind: r.kind as PlaceholderKind, levelId: r.level_id ? String(r.level_id) : null }));
}

/** Add a value to a list as a draft; a spelling already in the list (any case) is refused. */
export async function addValue(editor: Editor, store: Store, list: VocabListKey, text: string): Promise<string> {
  const value = cleanValue(text);
  if (!value) throw new OpError('Type a value first.');
  const scope = scopeOf(editor);
  const have = (await loadVocab(store, scope))[list];
  if (have.some((e) => same(e.value, value))) throw new OpError(`"${value}" is already in this list.`);
  const { id } = await editor.create('vocab', { project_id: scope, list, value, state: 'draft' }, VOCAB_CTX);
  return id;
}

/**
 * Add a raw spelling → canonical pair to `model_map` or `level_alias` (D187), as drafts: the
 * variant row points at the canonical row, created too when the list does not have it yet (any
 * case). A raw spelling the list already has (canonical or variant) is refused.
 */
export async function addPair(editor: Editor, store: Store, list: VocabPairListKey, rawText: string, canonicalText: string): Promise<string> {
  const raw = cleanValue(rawText);
  const canonical = cleanValue(canonicalText);
  if (!raw || !canonical) throw new OpError('Type both the spelling and what it stands for.');
  if (same(raw, canonical)) throw new OpError('The spelling and what it stands for are the same.');
  const scope = scopeOf(editor);
  const rows = await rowsOf(store, scope, list);
  if (rows.some((r) => same(String(r.value), raw))) throw new OpError(`"${raw}" is already in this list.`);
  const target = rows.find((r) => !r.canonical_of_id && same(String(r.value), canonical));
  let made = '';
  await editor.group(VOCAB_CTX, async (g) => {
    const canonicalId = target ? String(target.id) : (await g.create('vocab', { project_id: scope, list, value: canonical, state: 'draft' })).id;
    made = (await g.create('vocab', { project_id: scope, list, value: raw, canonical_of_id: canonicalId, state: 'draft' })).id;
  });
  return made;
}

/**
 * Rename in place (records that used the old spelling are retrofitted by a rename ruling, T37).
 * Refused when another row of the list in the same scope (canonical or variant) has that spelling.
 */
export async function renameValue(editor: Editor, store: Store, id: string, text: string): Promise<void> {
  const value = cleanValue(text);
  if (!value) throw new OpError('A value cannot be empty; remove it instead.');
  const row = await store.get<Row>('vocab', id);
  if (!row || row.deleted_at) throw new OpError('This value is not on this iPad.');
  const rows = await rowsOf(store, (row.project_id as string | null) ?? null, String(row.list));
  if (rows.some((r) => r.id !== id && same(String(r.value), value))) throw new OpError(`"${value}" is already in this list.`);
  await editor.setField('vocab', id, 'value', value, VOCAB_CTX);
}

export async function acceptValue(editor: Editor, id: string): Promise<void> {
  await editor.setField('vocab', id, 'state', 'accepted', VOCAB_CTX);
}

/** Remove a value; a canonical value takes its variants (old spellings, pair spellings) with it. */
export async function removeValue(editor: Editor, id: string, store?: Store): Promise<void> {
  const variants = store ? await store.list<Row>('vocab', { where: 'canonical_of_id = ?', params: [id] }) : [];
  if (!variants.length) {
    await editor.delete('vocab', id, VOCAB_CTX);
    return;
  }
  await editor.group(VOCAB_CTX, async (g) => {
    for (const v of variants) await g.delete('vocab', String(v.id));
    await g.delete('vocab', id);
  });
}

/**
 * Create the standard values the scope does not have yet, and in a project its placeholders;
 * returns counts. Idempotent. In a project they are accepted; in the app library they are drafts
 * for Landry to accept (T104, D214), and placeholders stay per project. The seed's old spellings
 * (`SEED_VOCAB_VARIANTS`, T112) are recorded as variants of their canonical value: a row the
 * scope already has with that spelling is re-pointed, a missing one is created pointing at the
 * canonical row — so the vocabulary lint flags the records still using it and the rename ruling
 * can fix them all (counted under `values`).
 */
export async function loadStandard(editor: Editor, store: Store): Promise<{ values: number; placeholders: number }> {
  const scope = scopeOf(editor);
  const state = scope == null ? 'draft' : 'accepted';
  const existing = new Set(scope == null ? [] : (await loadPlaceholders(store, scope)).map((p) => p.label.toLowerCase()));
  // Every live row, variants included. A seed value matches a row spelled the same in any case
  // ("sensor" stands for `Sensor`) — unless the row's spelling is itself another seed spelling:
  // the master's `Equipment rack` (an old spelling of `Equipment Panels`) never stands for the
  // D196 `Equipment Rack` (DIN rail enclosures).
  const allRows = await rowsOf(store, scope);
  const seedSpellings = new Map(VOCAB_LISTS.map(({ list }) => [list, new Set<string>([...SEED_VOCAB[list], ...Object.keys(SEED_VOCAB_VARIANTS[list] ?? {})])]));
  const rowOf = (list: string, value: string): Row | null => {
    const exact = (r: Row) => r.list === list && String(r.value) === value;
    const loose = (r: Row) => r.list === list && same(String(r.value), value) && !seedSpellings.get(list as VocabListKey)?.has(String(r.value));
    return allRows.find(exact) ?? allRows.find(loose) ?? null;
  };
  let values = 0;
  let placeholders = 0;
  await editor.group(VOCAB_CTX, async (g) => {
    const created = new Map<string, string>(); // `${list}|${value}` → id, for variants of a value created in this group
    for (const { list } of VOCAB_LISTS) {
      for (const value of SEED_VOCAB[list]) {
        if (rowOf(list, value)) continue;
        const { id } = await g.create('vocab', { project_id: scope, list, value, state });
        created.set(`${list}|${value.toLowerCase()}`, id);
        values++;
      }
      for (const [variant, canonical] of Object.entries(SEED_VOCAB_VARIANTS[list] ?? {})) {
        const canonicalRow = rowOf(list, canonical);
        const canonicalId = created.get(`${list}|${canonical.toLowerCase()}`) ?? (canonicalRow && !canonicalRow.canonical_of_id ? String(canonicalRow.id) : null);
        if (!canonicalId) continue;
        const row = rowOf(list, variant);
        if (!row) {
          await g.create('vocab', { project_id: scope, list, value: variant, canonical_of_id: canonicalId, state });
          values++;
        } else if (row.canonical_of_id !== canonicalId && String(row.id) !== canonicalId) {
          await g.setFields('vocab', String(row.id), { canonical_of_id: canonicalId });
          values++;
        }
      }
    }
    if (scope == null) return;
    for (const p of SEED_PLACEHOLDERS) {
      if (existing.has(p.label.toLowerCase())) continue;
      await g.create('placeholder', { project_id: scope, label: p.label, kind: p.kind });
      placeholders++;
    }
  });
  return { values, placeholders };
}

/**
 * Copy rows into `scope` with their canonical / variant links: a canonical the scope already has
 * (same list and spelling, any case) is reused, a row the scope already has is skipped. `rows`
 * come canonicals first. Returns how many rows were created.
 */
async function copyRows(g: EditBatch, have: Row[], rows: Row[], scope: string | null, state: string, extra: Row = {}): Promise<number> {
  const idOf = new Map<string, string>(); // source id → id in the scope
  const find = (list: unknown, value: unknown) => have.find((h) => h.list === list && same(String(h.value), String(value)));
  let n = 0;
  for (const r of rows) {
    const hit = find(r.list, r.value);
    if (hit) {
      idOf.set(String(r.id), String(hit.id));
      continue;
    }
    const canonical = r.canonical_of_id ? idOf.get(String(r.canonical_of_id)) : null;
    if (r.canonical_of_id && !canonical) continue;
    const payload = { project_id: scope, list: r.list, value: r.value, canonical_of_id: canonical ?? null, state, ...extra };
    const { id } = await g.create('vocab', payload);
    idOf.set(String(r.id), id);
    have.push({ ...payload, id });
    n++;
  }
  return n;
}

const canonicalsFirst = (rows: Row[]) => [...rows].sort((a, b) => Number(!!a.canonical_of_id) - Number(!!b.canonical_of_id));

/**
 * "Promote to app library" for one accepted project value (D65, D214): the value, with its
 * variants (a canonical) or its canonical (a variant), becomes an app-library draft for Landry to
 * accept. Refused when the app library already has all of it.
 */
export async function promoteValue(libraryEditor: Editor, store: Store, id: string): Promise<number> {
  if (libraryEditor.projectId !== LIBRARY_STREAM) throw new OpError('Promotion writes to the app library.');
  const row = await store.get<Row>('vocab', id);
  if (!row || row.deleted_at || !row.project_id) throw new OpError('Only a project value can be promoted.');
  if (row.state !== 'accepted') throw new OpError('Accept the value before promoting it.');
  const projectRows = await rowsOf(store, String(row.project_id), String(row.list));
  const canonical = row.canonical_of_id ? projectRows.find((r) => r.id === row.canonical_of_id) : row;
  if (!canonical) throw new OpError('Its canonical value is not on this iPad.');
  const rows = row.canonical_of_id ? [canonical, row] : [row, ...projectRows.filter((r) => r.canonical_of_id === row.id)];
  const have = await rowsOf(store, null, String(row.list));
  let n = 0;
  await libraryEditor.group({ ...VOCAB_CTX, reason: 'Vocabulary: promoted to the app library' }, async (g) => {
    n = await copyRows(g, have, rows, null, 'draft');
  });
  if (!n) throw new OpError(`The app library already has "${String(row.value)}".`);
  return n;
}

/**
 * "Copy from app library" for a project that exists already (project creation copies them on
 * the server): the app library's accepted values this project lacks, accepted, canonicals before
 * their variants, in one group.
 */
export async function copyAppVocab(editor: Editor, store: Store, projectId: string): Promise<number> {
  const app = (await rowsOf(store, null)).filter((r) => r.state === 'accepted');
  const accepted = new Set(app.map((r) => String(r.id)));
  const rows = canonicalsFirst(app.filter((r) => !r.canonical_of_id || accepted.has(String(r.canonical_of_id))));
  const have = await rowsOf(store, projectId);
  let n = 0;
  await editor.group({ ...VOCAB_CTX, reason: 'Vocabulary: copied from the app library' }, async (g) => {
    n = await copyRows(g, have, rows, projectId, 'accepted');
  });
  return n;
}

/** Add a placeholder (from the endpoint picker or the editor); a label already in use returns that placeholder. */
export async function addPlaceholder(editor: Editor, store: Store, text: string, kind: PlaceholderKind = 'custom', levelId: string | null = null): Promise<string> {
  const label = cleanValue(text);
  if (!label) throw new OpError('Type a label first.');
  const hit = (await loadPlaceholders(store, editor.projectId)).find((p) => same(p.label, label));
  if (hit) return hit.id;
  const { id } = await editor.create('placeholder', { project_id: editor.projectId, label, kind, level_id: levelId }, PLACEHOLDER_CTX);
  return id;
}

export async function editPlaceholder(editor: Editor, store: Store, id: string, patch: { label?: string; kind?: PlaceholderKind }): Promise<void> {
  const values: Row = {};
  if (patch.label !== undefined) {
    const label = cleanValue(patch.label);
    if (!label) throw new OpError('A label cannot be empty.');
    const clash = (await loadPlaceholders(store, editor.projectId)).some((p) => p.id !== id && same(p.label, label));
    if (clash) throw new OpError(`"${label}" is already a placeholder.`);
    values.label = label;
  }
  if (patch.kind) values.kind = patch.kind;
  await editor.group(PLACEHOLDER_CTX, (g) => g.setFields('placeholder', id, values));
}

/** Remove a placeholder; refused while a connection end still names it. */
export async function removePlaceholder(editor: Editor, store: Store, id: string): Promise<void> {
  const used = await store.list<Row>('cable_end', { where: 'placeholder_id = ? AND deleted_at IS NULL', params: [id] });
  if (used.length) throw new OpError(`${used.length} connection end${used.length === 1 ? '' : 's'} still use this placeholder.`);
  await editor.delete('placeholder', id, PLACEHOLDER_CTX);
}
