/**
 * Plan ink layers (T24, D53, PLAN §2.2 `ink_layer`): one stroke-list blob per (sheet, user), so a
 * stroke always belongs to the layer of the person who drew it. Since D129 (T72) anyone may erase,
 * undo or recolour anyone's strokes; the change is written into **that** user's layer. Saving a
 * layer writes a **new** blob (new SHA-256) and points the record at it — `drawing_blob` +
 * `updated_at` in one group. The server applies `ink_layer` last-write-wins (PLAN §3.3), so the
 * client merges by stroke id instead of overwriting (`mergeStrokeLists`, `docs/strokes.md`):
 *
 * - a save merges the edit with the newest pulled copy of the layer (`useInkLayers`);
 * - after a pull, writes the server did not keep (two iPads offline, whoever's they are — another
 *   user's last-write-wins or the same user's `superseded`, T87) are merged and written once more
 *   (`reconcileInkLayer`, in core); the merge's reason names the writes it took in, so they are
 *   never merged twice and a later deliberate change is never undone.
 *
 * No React or Expo imports: runs in Node.
 */

import { mergeStrokeLists, type Editor, type Op, type Store, type StrokeList } from '@field-survey/core';

/** Ink edits are survey data like a status tap (D96), named for the history. */
export const INK_CONTEXT = { change_type: 'Field survey', reason: 'Plan ink' } as const;
// The after-pull merge lives in core since T87 (the twin-client harness runs it); re-exported here.
export { INK_MERGE_PREFIX, reconcileInkLayer, type InkReconcile } from '@field-survey/core';

export type InkLayerRow = { id: string; userId: string; blob: string | null; updatedAt: string | null };

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Every live layer on a sheet, newest first. Should one user have two rows for a sheet (two iPads
 * of the same person creating it offline at once), the newest is theirs to draw in; the others are
 * still drawn and editable, so nothing drawn is lost.
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
 * Point a layer at a newly written blob: create the user's own layer the first time (`layerId`
 * null), else set `drawing_blob` and `updated_at` as one group — on anyone's layer (D129). The blob
 * must already be registered with the queue.
 */
export async function saveInkLayer(
  editor: Editor,
  input: { sheetId: string; layerId: string | null; sha256: string; at: string; reason?: string },
): Promise<{ layerId: string; ops: Op[] }> {
  const ctx = { ...INK_CONTEXT, reason: input.reason ?? INK_CONTEXT.reason };
  if (!input.layerId) {
    const r = await editor.create('ink_layer', { sheet_id: input.sheetId, user_id: editor.userId, drawing_blob: input.sha256, updated_at: input.at }, ctx);
    return { layerId: r.id, ops: [r.op] };
  }
  const ops = await editor.setFields('ink_layer', input.layerId, { drawing_blob: input.sha256, updated_at: input.at }, ctx);
  return { layerId: input.layerId, ops };
}

/**
 * What a save writes for one layer (D129): the local edit, merged with the newest copy of the
 * layer when someone else's write was pulled since the edit started (`baseBlob` is the copy it
 * started from). `'wait'` when that newer copy is not on this iPad yet: the edit stays unsaved and
 * the next try merges it.
 */
export async function listToSave(
  store: Store,
  layer: { layerId: string | null; base: StrokeList | null; baseBlob: string | null; list: StrokeList },
  read: (sha256: string) => Promise<StrokeList | null>,
): Promise<StrokeList | 'wait'> {
  if (!layer.layerId) return layer.list;
  const row = await store.get<Row>('ink_layer', layer.layerId);
  const head = str(row?.drawing_blob);
  if (!head || head === layer.baseBlob) return layer.list;
  const theirs = await read(head);
  if (!theirs) return 'wait';
  return mergeStrokeLists(layer.base, layer.list, theirs);
}
