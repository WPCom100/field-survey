/**
 * Plan ink layers (T24, D53, PLAN §2.2 `ink_layer`): one stroke-list blob per (sheet, user), so a
 * stroke always belongs to the layer of the person who drew it. Since D129 (T72) anyone may erase,
 * undo or recolour anyone's strokes; the change is written into **that** user's layer. Saving a
 * layer writes a **new** blob (new SHA-256) and points the record at it — `drawing_blob` +
 * `updated_at` in one group. The server applies `ink_layer` last-write-wins (PLAN §3.3), so the
 * client merges by stroke id instead of overwriting (`mergeStrokeLists`, `docs/strokes.md`):
 *
 * - a save merges the edit with the newest pulled copy of the layer (`useInkLayers`);
 * - after a pull, two writes made from the same copy (two iPads offline) are merged and written
 *   once more (`reconcileInkLayer`); the merge's reason names the writes it took in, so they are
 *   never merged twice and a later deliberate change is never undone.
 *
 * No React or Expo imports: runs in Node.
 */

import { mergeStrokeLists, serializeStrokeList, type Editor, type Op, type StoredOp, type Store, type StrokeList } from '@field-survey/core';

/** Ink edits are survey data like a status tap (D96), named for the history. */
export const INK_CONTEXT = { change_type: 'Field survey', reason: 'Plan ink' } as const;
/** Reason of a merge write: `Plan ink: merged <op_id>,<op_id>` (the writes it took in). */
export const INK_MERGE_PREFIX = 'Plan ink: merged ';

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

/** A write of a layer's `drawing_blob` (its create or a set), as the op log has it. */
type InkWrite = { op: StoredOp; blob: string | null };

function blobOf(op: StoredOp): string | null {
  if (op.kind === 'create') return str((op.payload as Row | null)?.drawing_blob);
  return op.kind === 'set' && op.field === 'drawing_blob' ? str(op.now) : null;
}

/** The ids a merge write names as taken in. */
function mergedIds(op: StoredOp): string[] {
  return op.reason?.startsWith(INK_MERGE_PREFIX) ? op.reason.slice(INK_MERGE_PREFIX.length).split(',').filter(Boolean) : [];
}

export type InkReconcile = {
  /** The list to write: the current head with every concurrent write merged in. */
  merged: StrokeList;
  /** The writes taken in (for the merge's reason). */
  mergedOpIds: string[];
};

/**
 * Writes of the layer made from the same copy as the head's line (two iPads editing it offline):
 * the server kept the last one, so the head misses the other's erases and adds. Returns the head
 * merged with each of them (three-way, against the copy both started from), or null when there is
 * nothing to merge, the merge changes nothing, or a needed blob is not on this iPad yet (`read`
 * returns null; the next reload tries again). Only server-applied writes count.
 */
export async function reconcileInkLayer(
  store: Store,
  layerId: string,
  read: (sha256: string) => Promise<StrokeList | null>,
): Promise<InkReconcile | null> {
  const writes: InkWrite[] = (await store.opsFor(layerId))
    .filter((op) => op.state === 'applied' && (op.kind === 'create' || (op.kind === 'set' && op.field === 'drawing_blob')))
    .map((op) => ({ op, blob: blobOf(op) }));
  if (writes.length < 2) return null;
  const byId = new Map(writes.map((w) => [w.op.op_id, w]));
  const head = writes.reduce((a, b) => ((b.op.server_seq ?? -1) > (a.op.server_seq ?? -1) ? b : a));

  // the head's line: it and every write it was based on, and what merges along it took in
  const line = new Map<string, InkWrite>();
  const absorbed = new Set<string>();
  for (let w: InkWrite | undefined = head; w && !line.has(w.op.op_id); w = w.op.base_op_id ? byId.get(w.op.base_op_id) : undefined) {
    line.set(w.op.op_id, w);
    for (const id of mergedIds(w.op)) absorbed.add(id);
  }
  // a write is taken in once a merge names it, and so is everything it was based on
  for (const id of [...absorbed]) {
    for (let w = byId.get(id); w; w = w.op.base_op_id ? byId.get(w.op.base_op_id) : undefined) absorbed.add(w.op.op_id);
  }
  const concurrent = writes
    .filter((w) => !line.has(w.op.op_id) && !absorbed.has(w.op.op_id) && w.blob && w.blob !== head.blob)
    .sort((a, b) => (a.op.server_seq ?? 0) - (b.op.server_seq ?? 0));
  if (!concurrent.length || !head.blob) return null;

  const headList = await read(head.blob);
  if (!headList) return null;
  let acc = headList;
  const taken: string[] = [];
  for (const c of concurrent) {
    // the copy both started from: the nearest write on c's line that is also on the head's line
    let common: InkWrite | undefined = c.op.base_op_id ? byId.get(c.op.base_op_id) : undefined;
    while (common && !line.has(common.op.op_id)) common = common.op.base_op_id ? byId.get(common.op.base_op_id) : undefined;
    const theirs = await read(c.blob!);
    const base = common?.blob ? await read(common.blob) : null;
    if (!theirs || (common?.blob && !base)) return null;
    acc = mergeStrokeLists(base, theirs, acc);
    taken.push(c.op.op_id);
  }
  if (serializeStrokeList(acc) === serializeStrokeList(headList)) return null;
  return { merged: acc, mergedOpIds: taken };
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
