/**
 * Plan ink layers (T24, D53, PLAN §2.2 `ink_layer`): one stroke-list blob per (sheet, user). The
 * owner writes theirs; everyone else's are shown read-only. Saving a layer writes a **new** blob
 * (new SHA-256) and points the record at it — `drawing_blob` + `updated_at` in one group — so two
 * saves never merge and never conflict (the server applies `ink_layer` last-write-wins, PLAN §3.3).
 * No React or Expo imports: runs in Node.
 */

import type { Editor, Op, Store } from '@field-survey/core';

/** Ink edits are survey data like a status tap (D96), named for the history. */
export const INK_CONTEXT = { change_type: 'Field survey', reason: 'Plan ink' } as const;

export type InkLayerRow = { id: string; userId: string; blob: string | null; updatedAt: string | null };

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Every live layer on a sheet, newest first. Should one user have two rows for a sheet (two iPads
 * of the same person creating it offline at once), the newest is theirs to edit; the others are
 * still drawn, so nothing drawn is lost.
 */
export async function loadInkLayers(store: Store, sheetId: string): Promise<InkLayerRow[]> {
  const rows = await store.list<Row>('ink_layer', { where: 'sheet_id = ?', params: [sheetId] });
  return rows
    .map((r) => ({ id: String(r.id), userId: String(r.user_id), blob: str(r.drawing_blob), updatedAt: str(r.updated_at) }))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.id.localeCompare(a.id));
}

/** The user's own layer on the sheet (the newest of theirs), or null. */
export function ownLayer(layers: readonly InkLayerRow[], userId: string): InkLayerRow | null {
  return layers.find((l) => l.userId === userId) ?? null;
}

/**
 * Point the user's layer at a newly written blob: create the layer the first time, else set
 * `drawing_blob` and `updated_at` as one group. The blob must already be registered with the queue.
 */
export async function saveInkLayer(
  editor: Editor,
  input: { sheetId: string; layerId: string | null; sha256: string; at: string },
): Promise<{ layerId: string; ops: Op[] }> {
  if (!input.layerId) {
    const r = await editor.create(
      'ink_layer',
      { sheet_id: input.sheetId, user_id: editor.userId, drawing_blob: input.sha256, updated_at: input.at },
      INK_CONTEXT,
    );
    return { layerId: r.id, ops: [r.op] };
  }
  const row = await editor.store.get<Row>('ink_layer', input.layerId);
  if (row && row.user_id !== editor.userId) throw new Error('An ink layer is written by its owner only (D53).');
  const ops = await editor.setFields('ink_layer', input.layerId, { drawing_blob: input.sha256, updated_at: input.at }, INK_CONTEXT);
  return { layerId: input.layerId, ops };
}
