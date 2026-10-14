/**
 * Merging concurrent writes of one plan ink layer after a pull (T72 D133, T87). Moved here from
 * `app/src/ink/model.ts` so the twin-client harness can run it against the real server.
 *
 * The server keeps one `drawing_blob` per layer: another user's write is last-write-wins (PLAN
 * §3.3), and a write from the same user's other iPad that arrives later with an older `client_ts`
 * is stored `superseded` (D37, D84) — in both cases the losing write's strokes are not in the head.
 * `reconcileInkLayer` finds those writes in the op log and merges them into the head by stroke id
 * (`mergeStrokeLists`, docs/strokes.md); the caller writes the result with the reason
 * `Plan ink: merged <op_id>,…`, which marks them as taken in so they are never merged again.
 */

import type { StoredOp } from './op';
import type { Store } from './store';
import { mergeStrokeLists, serializeStrokeList, type StrokeList } from './strokes';

/** Reason of a merge write: `Plan ink: merged <op_id>,<op_id>` (the writes it took in). */
export const INK_MERGE_PREFIX = 'Plan ink: merged ';

/** A write of a layer's `drawing_blob` (its create or a set), as the op log has it. */
type InkWrite = { op: StoredOp; blob: string | null };

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

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
 * Writes of the layer that are not on the head's line (two iPads editing it offline, whoever's
 * they are): returns the head merged with each of them, three-way against the nearest copy both
 * lines share (none: a union), or null when there is nothing to merge, the merge changes nothing,
 * or a needed blob is not on this iPad yet (`read` returns null; the next reload tries again).
 * Server-decided writes count: `applied`, and `superseded` (one person's two iPads, D37 — T87:
 * the M3 round lost iPad A's strokes this way). The head is the newest `applied` write.
 */
export async function reconcileInkLayer(
  store: Store,
  layerId: string,
  read: (sha256: string) => Promise<StrokeList | null>,
): Promise<InkReconcile | null> {
  const writes: InkWrite[] = (await store.opsFor(layerId))
    .filter((op) => (op.state === 'applied' || op.state === 'superseded') && (op.kind === 'create' || (op.kind === 'set' && op.field === 'drawing_blob')))
    .map((op) => ({ op, blob: blobOf(op) }));
  if (writes.length < 2) return null;
  const byId = new Map(writes.map((w) => [w.op.op_id, w]));
  const official = writes.filter((w) => w.op.state === 'applied');
  if (!official.length) return null;
  const head = official.reduce((a, b) => ((b.op.server_seq ?? -1) > (a.op.server_seq ?? -1) ? b : a));
  const ancestors = (w: InkWrite): InkWrite[] => {
    const out: InkWrite[] = [];
    const seen = new Set([w.op.op_id]);
    for (let p = w.op.base_op_id ? byId.get(w.op.base_op_id) : undefined; p && !seen.has(p.op.op_id); p = p.op.base_op_id ? byId.get(p.op.base_op_id) : undefined) {
      seen.add(p.op.op_id);
      out.push(p);
    }
    return out;
  };

  // the head's line: it and every write it was based on, and what merges along it took in
  const line = new Map<string, InkWrite>([[head.op.op_id, head], ...ancestors(head).map((w) => [w.op.op_id, w] as const)]);
  const absorbed = new Set<string>();
  for (const w of line.values()) for (const id of mergedIds(w.op)) absorbed.add(id);
  // a write is taken in once a merge names it, and so is everything it was based on
  for (const id of [...absorbed]) {
    const w = byId.get(id);
    if (w) for (const p of ancestors(w)) absorbed.add(p.op.op_id);
  }
  const candidates = writes.filter((w) => !line.has(w.op.op_id) && !absorbed.has(w.op.op_id) && w.blob);
  // only the tip of each concurrent line: an earlier save of it is already in the later one, and
  // merging both would bring back a stroke the later save erased
  const inner = new Set(candidates.flatMap((w) => ancestors(w).map((p) => p.op.op_id)));
  const concurrent = candidates
    .filter((w) => !inner.has(w.op.op_id) && w.blob !== head.blob)
    .sort((a, b) => (a.op.server_seq ?? 0) - (b.op.server_seq ?? 0));
  if (!concurrent.length || !head.blob) return null;

  const headList = await read(head.blob);
  if (!headList) return null;
  let acc = headList;
  const taken: string[] = [];
  for (const c of concurrent) {
    // the copy both started from: the nearest write on c's line that is also on the head's line
    const common = ancestors(c).find((p) => line.has(p.op.op_id));
    const theirs = await read(c.blob!);
    const base = common?.blob ? await read(common.blob) : null;
    if (!theirs || (common?.blob && !base)) return null;
    acc = mergeStrokeLists(base, theirs, acc);
    taken.push(c.op.op_id);
  }
  if (serializeStrokeList(acc) === serializeStrokeList(headList)) return null;
  return { merged: acc, mergedOpIds: taken };
}
