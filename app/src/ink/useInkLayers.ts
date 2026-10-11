import { parseStrokeList, serializeStrokeList, type BlobQueue, type Editor, type Store, type StrokeList } from '@field-survey/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { prepareText, readCachedText, register } from '../blobs/store-bytes';
import { loadInkLayers, ownLayer, saveInkLayer } from './model';

/** Quiet time after the last stroke before the layer is written (a blob + one op group). */
export const INK_SAVE_DEBOUNCE_MS = 1500;

export type InkSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type InkLayers = {
  /** Other users' layers on this sheet (read-only). */
  others: { userId: string; list: StrokeList }[];
  /** This user's layer, or null before their first stroke. */
  mine: StrokeList | null;
  /** Layers whose blob is not on this iPad yet (offline, or not uploaded by their author). */
  missing: number;
  save: InkSaveState;
  error: string | null;
  /** Replace the user's layer (a stroke added, erased, undone); saved after a quiet second. */
  setMine: (list: StrokeList) => void;
  /** Write now (leaving draw mode). */
  flush: () => Promise<void>;
};

/**
 * Plan ink of one sheet (T24, D53): every user's layer loaded from the blob cache (fetched on demand
 * when missing), the current user's own layer editable. A change is written debounced as a **new**
 * blob (new SHA-256) + `ink_layer` op; an unsaved local change is never overwritten by a reload.
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
  const [others, setOthers] = useState<InkLayers['others']>([]);
  const [mine, setMineState] = useState<StrokeList | null>(null);
  const [missing, setMissing] = useState(0);
  const [save, setSave] = useState<InkSaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const layerId = useRef<string | null>(null);
  const dirty = useRef<StrokeList | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  // --- load every layer of the sheet
  useEffect(() => {
    if (!sheetId || !queue) return;
    let active = true;
    (async () => {
      const layers = await loadInkLayers(store, sheetId);
      const own = userId ? ownLayer(layers, userId) : null;
      const read: InkLayers['others'] = [];
      let gone = 0;
      let ownList: StrokeList | null = null;
      for (const l of layers) {
        if (!l.blob) continue;
        const text = await readCachedText(queue, l.blob, 'ink').catch(() => null);
        if (!text) {
          gone++;
          continue;
        }
        try {
          const list = parseStrokeList(text);
          if (own && l.id === own.id) ownList = list;
          else read.push({ userId: l.userId, list });
        } catch (e) {
          console.warn(`[plan] ink layer ${l.id} unreadable: ${String(e)}`);
        }
      }
      if (!active) return;
      setOthers(read);
      setMissing(gone);
      if (!dirty.current) {
        layerId.current = own?.id ?? null;
        setMineState(ownList);
      }
    })().catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [store, sheetId, userId, queue, reloadKey]);

  const write = useCallback(async () => {
    const list = dirty.current;
    if (!list || !editor || !sheetId || !queue) return;
    setSave('saving');
    try {
      const blob = await prepareText(serializeStrokeList(list), 'ink');
      await register(queue, blob);
      const r = await saveInkLayer(editor, { sheetId, layerId: layerId.current, sha256: blob.sha256, at: new Date().toISOString() });
      layerId.current = r.layerId;
      if (dirty.current === list) dirty.current = null;
      setSave(dirty.current ? 'pending' : 'saved');
      setError(null);
    } catch (e) {
      console.warn('[plan] ink not saved', e);
      setSave('error');
      setError(`Ink not saved: ${String((e as Error)?.message ?? e)}`);
    }
  }, [editor, sheetId, queue]);

  /** Saves run one after another, so two never race for the layer's first create. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.then(write);
    return chain.current;
  }, [write]);

  const setMine = useCallback(
    (list: StrokeList) => {
      setMineState(list);
      dirty.current = list;
      setSave('pending');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), INK_SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // leaving the plan writes what is pending
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => void flushRef.current(), []);

  return { others, mine, missing, save, error, setMine, flush };
}
