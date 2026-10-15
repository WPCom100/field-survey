/**
 * Vocabulary and placeholder editors (T40, PLAN §2.2, D26, D182): reads and edits of a project's
 * `vocab` lists and `placeholder` rows. A value added to a list is a draft, usable at once and
 * flagged until accepted (D43/D48); removing is a soft delete. Every write is one op through
 * `Editor`. No React or Expo imports: tested in Node.
 */

import { OpError, type EditContext, type Editor, type Store } from '@field-survey/core';

import { SEED_PLACEHOLDERS, SEED_VOCAB, VOCAB_LISTS, type PlaceholderKind, type VocabListKey } from './seed';

type Row = Record<string, unknown>;

const VOCAB_CTX: EditContext = { change_type: 'Master edit', reason: 'Vocabulary' };
const PLACEHOLDER_CTX: EditContext = { change_type: 'Master edit', reason: 'Placeholders' };

export interface VocabEntry {
  id: string;
  value: string;
  draft: boolean;
}
export type VocabView = Record<VocabListKey, VocabEntry[]>;

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

export async function loadVocab(store: Store, projectId: string): Promise<VocabView> {
  const rows = await store.list<Row>('vocab', { where: 'project_id = ? AND canonical_of_id IS NULL', params: [projectId], orderBy: 'id' });
  const view = Object.fromEntries(VOCAB_LISTS.map((l) => [l.list, [] as VocabEntry[]])) as VocabView;
  for (const r of rows) view[String(r.list) as VocabListKey]?.push({ id: String(r.id), value: String(r.value), draft: r.state === 'draft' });
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
  const have = (await loadVocab(store, editor.projectId))[list];
  if (have.some((e) => e.value.toLowerCase() === value.toLowerCase())) throw new OpError(`"${value}" is already in this list.`);
  const { id } = await editor.create('vocab', { project_id: editor.projectId, list, value, state: 'draft' }, VOCAB_CTX);
  return id;
}

/** Rename in place (records that used the old spelling are retrofitted by a rename ruling, T37). */
export async function renameValue(editor: Editor, store: Store, id: string, text: string): Promise<void> {
  const value = cleanValue(text);
  if (!value) throw new OpError('A value cannot be empty; remove it instead.');
  const row = await store.get<Row>('vocab', id);
  if (!row) throw new OpError('This value is not on this iPad.');
  const have = (await loadVocab(store, editor.projectId))[String(row.list) as VocabListKey] ?? [];
  if (have.some((e) => e.id !== id && e.value.toLowerCase() === value.toLowerCase())) throw new OpError(`"${value}" is already in this list.`);
  await editor.setField('vocab', id, 'value', value, VOCAB_CTX);
}

export async function acceptValue(editor: Editor, id: string): Promise<void> {
  await editor.setField('vocab', id, 'state', 'accepted', VOCAB_CTX);
}

export async function removeValue(editor: Editor, id: string): Promise<void> {
  await editor.delete('vocab', id, VOCAB_CTX);
}

/** Create the standard values and placeholders the project does not have yet; returns counts. Idempotent. */
export async function loadStandard(editor: Editor, store: Store): Promise<{ values: number; placeholders: number }> {
  const view = await loadVocab(store, editor.projectId);
  const known = new Map(Object.entries(view).map(([l, es]) => [l, new Set(es.map((e) => e.value.toLowerCase()))]));
  const existing = new Set((await loadPlaceholders(store, editor.projectId)).map((p) => p.label.toLowerCase()));
  let values = 0;
  let placeholders = 0;
  await editor.group(VOCAB_CTX, async (g) => {
    for (const { list } of VOCAB_LISTS) {
      for (const value of SEED_VOCAB[list]) {
        if (known.get(list)!.has(value.toLowerCase())) continue;
        await g.create('vocab', { project_id: editor.projectId, list, value, state: 'accepted' });
        values++;
      }
    }
    for (const p of SEED_PLACEHOLDERS) {
      if (existing.has(p.label.toLowerCase())) continue;
      await g.create('placeholder', { project_id: editor.projectId, label: p.label, kind: p.kind });
      placeholders++;
    }
  });
  return { values, placeholders };
}

/** Add a placeholder (from the endpoint picker or the editor); a label already in use returns that placeholder. */
export async function addPlaceholder(editor: Editor, store: Store, text: string, kind: PlaceholderKind = 'custom', levelId: string | null = null): Promise<string> {
  const label = cleanValue(text);
  if (!label) throw new OpError('Type a label first.');
  const same = (await loadPlaceholders(store, editor.projectId)).find((p) => p.label.toLowerCase() === label.toLowerCase());
  if (same) return same.id;
  const { id } = await editor.create('placeholder', { project_id: editor.projectId, label, kind, level_id: levelId }, PLACEHOLDER_CTX);
  return id;
}

export async function editPlaceholder(editor: Editor, store: Store, id: string, patch: { label?: string; kind?: PlaceholderKind }): Promise<void> {
  const values: Row = {};
  if (patch.label !== undefined) {
    const label = cleanValue(patch.label);
    if (!label) throw new OpError('A label cannot be empty.');
    const clash = (await loadPlaceholders(store, editor.projectId)).some((p) => p.id !== id && p.label.toLowerCase() === label.toLowerCase());
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
