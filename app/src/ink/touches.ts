/**
 * Draw-mode touches from the patched PDF view (T69, D129). In draw mode the native view follows
 * one finger or the Pencil itself and sends `ink|…` messages, so two fingers still pan and zoom
 * PDFKit (`patches/react-native-pdf.md`):
 *
 * - `ink|start|x|y|p` — the touch came down
 * - `ink|move|x|y|p[|x|y|p…]` — moved, with the Pencil's coalesced samples
 * - `ink|end` — lifted
 * - `ink|cancel` — a second finger came down: the stroke is dropped, the plan pans
 *
 * x, y are points in the Pdf view (the space of `viewport|…`); p is Pencil force 0–1, or -1 for a
 * finger, which draws at the default pressure. No React imports: runs in Node.
 */

import { DEFAULT_PRESSURE } from '@field-survey/core';

import type { DrawPoint } from './useDrawGesture';

export type InkPhase = 'start' | 'move' | 'end' | 'cancel';
export type InkTouch = { phase: InkPhase; points: DrawPoint[] };

const PHASES = new Set<string>(['start', 'move', 'end', 'cancel']);

export function parseInkMessage(message: string): InkTouch | null {
  const parts = message.split('|');
  if (parts[0] !== 'ink' || !PHASES.has(parts[1] ?? '')) return null;
  const phase = parts[1] as InkPhase;
  const points: DrawPoint[] = [];
  for (let i = 2; i + 2 < parts.length; i += 3) {
    const x = Number(parts[i]);
    const y = Number(parts[i + 1]);
    const f = Number(parts[i + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y, p: Number.isFinite(f) && f > 0 ? Math.min(1, f) : DEFAULT_PRESSURE });
  }
  if ((phase === 'start' || phase === 'move') && !points.length) return null;
  return { phase, points };
}

export type InkListener = (t: InkTouch) => void;

/** Plan screen → draw layer: the Pdf's `onInkMessage` emits, `InkCapture` listens. */
export type InkBus = { emit: (message: string) => void; listen: (fn: InkListener) => () => void };

export function createInkBus(): InkBus {
  const listeners = new Set<InkListener>();
  return {
    emit(message) {
      const t = parseInkMessage(message);
      if (!t) return;
      for (const fn of listeners) fn(t);
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
