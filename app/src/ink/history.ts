/**
 * Undo for drawing (T24 / T21 fix, iPad run): ↶ Undo steps back through every change the surveyor
 * made — a stroke, a note, a highlight, an erase — not only "remove the last stroke", which could
 * never bring back an erased note or highlight. The stack holds whole stroke lists (they are small
 * and immutable). No React: tested in Node.
 */

import type { StrokeList } from '@field-survey/core';

export const UNDO_LIMIT = 100;

/** The stack after a change from `before` (null = the layer had no strokes yet). */
export function pushUndo(stack: readonly (StrokeList | null)[], before: StrokeList | null, limit = UNDO_LIMIT): (StrokeList | null)[] {
  const next = [...stack, before];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Step back: the list to show and the remaining stack, or null when there is nothing to undo.
 * Going back to "no strokes yet" keeps the surface size of `current`.
 */
export function popUndo(
  stack: readonly (StrokeList | null)[],
  current: StrokeList | null,
): { list: StrokeList | null; stack: (StrokeList | null)[] } | null {
  if (!stack.length) return null;
  const before = stack[stack.length - 1]!;
  const list = before ?? (current ? { ...current, strokes: [] } : null);
  return { list, stack: stack.slice(0, -1) };
}
