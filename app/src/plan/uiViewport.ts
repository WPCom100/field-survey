import { useCallback, useEffect, useRef } from 'react';
import { findNodeHandle } from 'react-native';
import type { PdfRef } from 'react-native-pdf';
import { runOnUI, useEvent, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { parseViewportMessage, sheetToView, type Affine } from './viewport';

/** What `useEvent` really returns (it is typed as a plain function for Animated components). */
type WorkletEventHandle = {
  workletEventHandler: {
    registerForEvents(viewTag: number): void;
    unregisterFromEvents(viewTag: number): void;
  };
};

/**
 * The overlay matrix written in the same run-loop turn as PDFKit's own pan/zoom (T64, D106).
 *
 * The patch emits `viewport|…` from the scroll view's KVO on the main thread. A Reanimated worklet
 * handler registered for that native view's `onChange` runs synchronously inside that emit, before
 * the event goes on to JS, and Reanimated runs the mappers right after it, so the pin picture
 * (`PinOverlay`) is recorded and handed to Skia before PDFKit's frame is committed. The JS-thread
 * copy of the same event arrives frames later; it only seeds the matrix until the UI handler has
 * seen an event, so a stale JS value never overwrites a fresh one.
 */
export function useUiViewport(matrix: SharedValue<Affine | null>) {
  const uiDriven = useSharedValue(false);
  const handle = useEvent<{ message?: string }>(
    (e) => {
      'worklet';
      if (typeof e.message !== 'string') return;
      const vp = parseViewportMessage(e.message);
      if (!vp) return;
      uiDriven.value = true;
      matrix.value = sheetToView(vp);
    },
    ['onChange'],
  ) as unknown as WorkletEventHandle;

  const tagRef = useRef<number | null>(null);

  /** Register on the native Pdf view's tag (idempotent; call with every JS viewport event). */
  const attach = useCallback(
    (tag: number | null) => {
      if (tag === tagRef.current) return;
      const h = handle.workletEventHandler;
      if (tagRef.current !== null) h.unregisterFromEvents(tagRef.current);
      tagRef.current = tag;
      if (tag !== null) {
        uiDriven.value = false;
        h.registerForEvents(tag);
        console.log(`[plan] viewport handled on the UI thread (view ${tag})`);
      }
    },
    [handle, uiDriven],
  );

  useEffect(() => () => attach(null), [attach]);

  /** The JS-thread viewport, applied only while the UI handler is not yet live. */
  const setFromJs = useCallback(
    (m: Affine) => {
      runOnUI((next: Affine) => {
        'worklet';
        if (!uiDriven.value) matrix.value = next;
      })(m);
    },
    [matrix, uiDriven],
  );

  return { attach, setFromJs };
}

/** The tag of the native `RNPDFPdfView` inside the patched `Pdf` (kept in `_root`), or null. */
export function pdfNativeTag(pdf: PdfRef | null): number | null {
  const root = (pdf as unknown as { _root?: unknown } | null)?._root;
  if (!root) return null;
  return findNodeHandle(root as Parameters<typeof findNodeHandle>[0]) ?? null;
}
