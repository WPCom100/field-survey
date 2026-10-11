/**
 * Geometry of drawn strokes (T21 markup, T24 plan ink): what the Skia renderer draws for each
 * stroke of a `StrokeList` (format: `packages/core/docs/strokes.md`). Plain numbers only, no Skia:
 * unit-tested in Node, and the server's flattening (T29/T59) follows the same rules.
 */

import { pressureScale, unpackPoints, type Stroke, type StrokeList } from '@field-survey/core';

export type Segment = { x1: number; y1: number; x2: number; y2: number; width: number };

/** A pen stroke as round-capped segments, each as wide as the mean pressure of its ends. */
export function penSegments(s: Stroke): Segment[] {
  const pts = unpackPoints(s.points);
  if (pts.length === 1) {
    const q = pts[0]!;
    return [{ x1: q.x, y1: q.y, x2: q.x, y2: q.y, width: s.width * pressureScale(q.p) }];
  }
  const out: Segment[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: s.width * pressureScale((a.p + b.p) / 2) });
  }
  return out;
}

/** The two barbs of an arrow's head at its end point: each a line from the tip. */
export function arrowHead(s: Stroke): { tip: { x: number; y: number }; left: { x: number; y: number }; right: { x: number; y: number } } {
  const pts = unpackPoints(s.points);
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const len = Math.max(s.width * 4, 1);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  return {
    tip: { x: b.x, y: b.y },
    left: { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) },
    right: { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) },
  };
}

/** The box an ellipse fills, from its two corner points in any order. */
export function ellipseRect(s: Stroke): { x: number; y: number; width: number; height: number } {
  const pts = unpackPoints(s.points);
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Palette of the markup and ink tools: red, yellow, blue, green, black, white. */
export const INK_COLORS = ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#111111', '#ffffff'] as const;

/**
 * Display transform for a drawing surface of `space` units shown in a view of `view` points,
 * letterboxed (contain): view = space · scale + offset.
 */
export function containTransform(space: { width: number; height: number }, view: { width: number; height: number }) {
  const scale = Math.min(view.width / Math.max(space.width, 1), view.height / Math.max(space.height, 1));
  return { scale, ox: (view.width - space.width * scale) / 2, oy: (view.height - space.height * scale) / 2 };
}

/**
 * The photo of the camera mark ("Photo here", T23) under a sheet point, in any user's layer: the
 * topmost `marker` within its own half-width plus `tolerance`, or null. A tap on it opens the photo.
 */
export function photoMarkAt(lists: readonly StrokeList[], x: number, y: number, tolerance: number): string | null {
  for (let l = lists.length - 1; l >= 0; l--) {
    const strokes = lists[l]!.strokes;
    for (let k = strokes.length - 1; k >= 0; k--) {
      const s = strokes[k]!;
      if (s.tool !== 'marker' || !s.ref) continue;
      if (Math.hypot(x - s.points[0]!, y - s.points[1]!) <= s.width / 2 + tolerance) return s.ref.id;
    }
  }
  return null;
}
