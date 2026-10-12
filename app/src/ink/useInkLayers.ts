import {
  emptyStrokeList,
  mergeStrokeLists,
  parseStrokeList,
  serializeStrokeList,
  strokeAt,
  withStrokeColor,
  withoutStroke,
  type BlobQueue,
  type Editor,
  type Store,
  type Stroke,
  type StrokeList,
} from '@field-survey/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { prepareText, readCachedText, register } from '../blobs/store-bytes';
import { UNDO_LIMIT } from './history';
import { INK_MERGE_PREFIX, listToSave, loadInkLayers, ownLayer, reconcileInkLayer, saveInkLayer } from './model';

/** Quiet time after the last stroke before the changed layers are written (a blob + one op group each). */
export const INK_SAVE_DEBOUNCE_MS = 1500;

export type InkSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type InkLayers = {
  /** Other users' layers on this sheet (drawn faded; editable since D129). */
  others: { userId: string; list: StrokeList }[];
  /** This user's layer, or null before their first stroke. */
  mine: StrokeList | null;
  /** Layers whose blob is not on this iPad yet (offline, or not uploaded by their author). */
  missing: number;
  save: InkSaveState;
  error: string | null;
  /** Replace the user's own layer (a stroke, note or camera mark added); undoable, saved after a quiet second. */
  setMine: (list: StrokeList) => void;
  /** Erase the topmost stroke of any layer near a sheet point (D129); false when nothing is there. */
  eraseAt: (x: number, y: number, tolerance: number) => boolean;
  /** Recolour the topmost stroke of any layer near a sheet point (D129); false when nothing is there. */
  recolorAt: (x: number, y: number, tolerance: number, color: string) => boolean;
  /** Step back one change of this drawing session, in whichever layer it was made. */
  undo: () => void;
  canUndo: boolean;
  /** Write now (leaving draw mode). */
  flush: () => Promise<void>;
};

/** One layer as this iPad holds it: shown (with local edits) and as last loaded or saved. */
type Layer = {
  layerId: string | null;
  userId: string;
  list: StrokeList | null;
  /** The copy the local edits started from (merge base, D129). */
  base: StrokeList | null;
  baseBlob: string | null;
  dirty: boolean;
};

const OWN_NEW = 'own:new';

/**
 * Plan ink of one sheet (T24, D53, D129): every user's layer loaded from the blob cache (fetched on
 * demand when missing). The user draws into their own layer; erase, recolour and undo work on any
 * layer and are written into that layer. A save merges the edit with the newest pulled copy of the
 * layer by stroke id, so an owner's new strokes and another person's erase both survive; after a
 * pull, writes two iPads made from the same copy are merged once more (`reconcileInkLayer`). An
 * unsaved local change is never overwritten by a reload.
 */
export function useInkLayers(opts: {
  store: Store;
  editor: Editor | null;
  sheetId: string | null;
  userId: string | null;
  queue: Pick<BlobQueue, 'addLocal' | 'ensureLocal'> | null;
  reloadKey: unknown;
}): InkLayers {
  const { store, editor, sheetId, userId, queue, reloadKey } = opts;
  const layers = useRef(new Map<string, Layer>());
  const [view, setView] = useState<{ others: InkLayers['others']; mine: StrokeList | null }>({ others: [], mine: null });
  const [missing, setMissing] = useState(0);
  const [save, setSave] = useState<InkSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** Each change's layer and its list before the change (↶ Undo across layers). */
  const history = useRef<{ key: string; before: StrokeList | null }[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);

  const ownKey = useCallback(() => {
    for (const [k, l] of layers.current) if (l.userId === userId) return k;
    return null;
  }, [userId]);

  const publish = useCallback(() => {
    const own = ownKey();
    const others: InkLayers['others'] = [];
    for (const [k, l] of layers.current) if (k !== own && l.list) others.push({ userId: l.userId, list: l.list });
    setView({ others, mine: own ? (layers.current.get(own)?.list ?? null) : null });
  }, [ownKey]);

  const readList = useCallback(
    async (sha: string): Promise<StrokeList | null> => {
      if (!queue) return null;
      const text = await readCachedText(queue, sha, 'ink').catch(() => null);
      if (!text) return null;
      try {
        return parseStrokeList(text);
      } catch (e) {
        console.warn(`[plan] ink blob ${sha.slice(0, 8)} unreadable: ${String(e)}`);
        return null;
      }
    },
    [queue],
  );

  /** Serialise → new blob → the layer op group. */
  const writeBlob = useCallback(
    async (layerId: string | null, list: StrokeList, reason?: string) => {
      if (!editor || !sheetId || !queue) throw new Error('not editable');
      const blob = await prepareText(serializeStrokeList(list), 'ink');
      await register(queue, blob);
      const r = await saveInkLayer(editor, { sheetId, layerId, sha256: blob.sha256, at: new Date().toISOString(), reason });
      return { layerId: r.layerId, sha256: blob.sha256 };
    },
    [editor, sheetId, queue],
  );

  // --- load every layer of the sheet; merge concurrent writes pulled since (D129)
  useEffect(() => {
    if (!sheetId || !queue) return;
    let active = true;
    (async () => {
      const rows = await loadInkLayers(store, sheetId);
      const own = userId ? ownLayer(rows, userId) : null;
      let gone = 0;
      for (const row of rows) {
        // two iPads wrote this layer from the same copy: merge them before showing it
        if (editor && row.blob) {
          const r = await reconcileInkLayer(store, row.id, readList).catch((e: unknown) => (console.warn('[plan] ink merge', e), null));
          if (r && active) {
            const sha = (await prepareText(serializeStrokeList(r.merged), 'ink')).sha256;
            if (sha !== row.blob) {
              const w = await writeBlob(row.id, r.merged, `${INK_MERGE_PREFIX}${r.mergedOpIds.join(',')}`);
              console.log(`[plan] ink: merged ${r.mergedOpIds.length} concurrent write(s) into layer ${row.id.slice(-4)}`);
              row.blob = w.sha256;
            }
          }
        }
        const list = row.blob ? await readList(row.blob) : null;
        if (row.blob && !list) gone++;
        const key = row.id;
        const held = layers.current.get(key) ?? (own && row.id === own.id ? layers.current.get(OWN_NEW) : undefined);
        if (held?.dirty) {
          // keep the local edit; the save merges it with this newer copy
          continue;
        }
        if (own && row.id === own.id) layers.current.delete(OWN_NEW);
        layers.current.set(key, { layerId: row.id, userId: row.userId, list, base: list, baseBlob: row.blob, dirty: false });
      }
      if (!active) return;
      setMissing(gone);
      publish();
    })().catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [store, editor, sheetId, userId, queue, reloadKey, readList, writeBlob, publish]);

  /** Write every changed layer, each merged with its newest copy first. */
  const write = useCallback(async () => {
    if (!editor || !sheetId || !queue) return;
    const dirty = [...layers.current.entries()].filter(([, l]) => l.dirty && l.list);
    if (!dirty.length) return;
    setSave('saving');
    try {
      for (const [key, l] of dirty) {
        const mine = l.list!;
        const next = await listToSave(store, { ...l, list: mine }, readList);
        if (next === 'wait') {
          setSave('pending');
          setError('Waiting for the newest copy of a layer to download before saving it.');
          return;
        }
        if (next !== mine) console.log(`[plan] ink: layer ${l.layerId?.slice(-4)} changed elsewhere; merged before saving`);
        const w = await writeBlob(l.layerId, next);
        const cur = layers.current.get(key);
        if (!cur) continue;
        const after: Layer = { ...cur, layerId: w.layerId, base: next, baseBlob: w.sha256 };
        // edits made while saving stay dirty and are merged onto the saved copy next time
        if (cur.list === mine) Object.assign(after, { list: next, dirty: false });
        else after.list = mergeStrokeLists(mine, cur.list!, next);
        if (key !== w.layerId) layers.current.delete(key);
        layers.current.set(w.layerId, after);
        if (key !== w.layerId) history.current = history.current.map((h) => (h.key === key ? { ...h, key: w.layerId } : h));
      }
      publish();
      const still = [...layers.current.values()].some((l) => l.dirty);
      setSave(still ? 'pending' : 'saved');
      setError(null);
    } catch (e) {
      console.warn('[plan] ink not saved', e);
      setSave('error');
      setError(`Ink not saved: ${String((e as Error)?.message ?? e)}`);
    }
  }, [editor, sheetId, queue, store, readList, writeBlob, publish]);

  /** Saves run one after another, so two never race for the own layer's first create. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.then(write);
    return chain.current;
  }, [write]);

  /** Show a new version of one layer and schedule the save. */
  const change = useCallback(
    (key: string, list: StrokeList, record = true) => {
      const l = layers.current.get(key);
      if (!l || l.list === list) return;
      if (record) {
        history.current = [...history.current, { key, before: l.list }].slice(-UNDO_LIMIT);
        setUndoDepth(history.current.length);
      }
      layers.current.set(key, { ...l, list, dirty: true });
      publish();
      setSave('pending');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), INK_SAVE_DEBOUNCE_MS);
    },
    [publish, flush],
  );

  const setMine = useCallback(
    (list: StrokeList) => {
      if (!userId) return;
      let key = ownKey();
      if (!key) {
        key = OWN_NEW;
        layers.current.set(key, { layerId: null, userId, list: null, base: null, baseBlob: null, dirty: false });
      }
      change(key, list);
    },
    [userId, ownKey, change],
  );

  /** The topmost stroke under a point: the user's own layer is drawn last (on top), then the newest others. */
  const hitAt = useCallback(
    (x: number, y: number, tolerance: number): { key: string; stroke: Stroke } | null => {
      const own = ownKey();
      const order = [...(own ? [own] : []), ...[...layers.current.keys()].filter((k) => k !== own).reverse()];
      for (const key of order) {
        const list = layers.current.get(key)?.list;
        const s = list ? strokeAt(list, x, y, tolerance) : null;
        if (s) return { key, stroke: s };
      }
      return null;
    },
    [ownKey],
  );

  const eraseAt = useCallback(
    (x: number, y: number, tolerance: number) => {
      const hit = hitAt(x, y, tolerance);
      if (!hit) return false;
      const l = layers.current.get(hit.key)!;
      const next = withoutStroke(l.list!, hit.stroke.id);
      console.log(`[plan] ink: erased a ${hit.stroke.tool} stroke from ${l.userId === userId ? 'my' : "another user's"} layer (${next.strokes.length} left)`);
      change(hit.key, next);
      return true;
    },
    [hitAt, change, userId],
  );

  const recolorAt = useCallback(
    (x: number, y: number, tolerance: number, color: string) => {
      const hit = hitAt(x, y, tolerance);
      if (!hit) return false;
      const l = layers.current.get(hit.key)!;
      const next = withStrokeColor(l.list!, hit.stroke.id, color);
      if (next === l.list) return true;
      change(hit.key, next);
      return true;
    },
    [hitAt, change],
  );

  const undo = useCallback(() => {
    const step = history.current[history.current.length - 1];
    if (!step) return;
    history.current = history.current.slice(0, -1);
    setUndoDepth(history.current.length);
    const l = layers.current.get(step.key);
    if (!l) return;
    const back = step.before ?? (l.list ? emptyStrokeList(l.list.space, l.list.width, l.list.height) : null);
    if (back) change(step.key, back, false);
  }, [change]);

  // leaving the plan writes what is pending
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  return {
    others: view.others,
    mine: view.mine,
    missing,
    save,
    error,
    setMine,
    eraseAt,
    recolorAt,
    undo,
    canUndo: undoDepth > 0,
    flush,
  };
}
