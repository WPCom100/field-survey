/**
 * Where each pin goes on screen for one viewport, and which pins merge into a cluster (T17).
 *
 * Runs on the UI thread inside the overlay's Skia picture (every pan/zoom frame, D95) and in
 * JS for tap hit-tests, so every function is a worklet and uses plain data only. Pure: tested
 * in Node.
 *
 * Clustering is greedy in a fixed pin order over view-space distances, so it depends on zoom
 * only, never on panning: a pin joins the first cluster whose seed is within `clusterPx`
 * screen points. At or above `offZoom` (view points per sheet point) pins never cluster.
 *
 * Worklet rule: no default parameters (see `layoutPins`); `worklets.test.ts` checks it.
 */

import { apply, scaleOf, type Affine } from './viewport';

/** One pin as the overlay draws it; built in JS when data or filters change, not per frame. */
export type RenderPin = {
  id: string;
  /** Sheet coordinates (CropBox top-left, y down, PDF points). */
  x: number;
  y: number;
  category: string | null;
  fill: string;
  hollow: boolean;
  glyph: string;
  label: string;
  /** Field addition: "+" corner mark (Phase 3 §2.2). */
  plus: boolean;
  /** `NEW`: no server-assigned ID yet (D93). */
  isNew: boolean;
  photos: number;
  /** `statusRank`: the most urgent member colours a cluster. */
  rank: number;
  /** Open review item on the device (Phase 3 §13): amber ring. */
  review?: boolean;
  /** Side B of a pin conflict (Phase 3 §6): dashed outline, no fill. */
  ghost?: boolean;
  /** Never merged into a cluster (both pins of a conflict stay visible). */
  solo?: boolean;
};

export type PlacedPin = { index: number; vx: number; vy: number };
export type PlacedCluster = { members: number[]; vx: number; vy: number; fill: string; rank: number };
export type PinLayout = { zoom: number; pins: PlacedPin[]; clusters: PlacedCluster[] };

export type LayoutOptions = {
  /** Screen distance under which pins merge. */
  clusterPx: number;
  /** Zoom (view pt per sheet pt) from which pins never cluster. */
  offZoom: number;
  /** Items this far outside the view are still placed (labels and rings poke in). */
  marginPx: number;
};

/** offZoom 2 (T17 on-device): at ×1 devices a couple of feet apart still overlapped unclustered. */
export const LAYOUT_DEFAULTS: LayoutOptions = { clusterPx: 30, offZoom: 2, marginPx: 60 };

export function layoutPins(
  pins: readonly RenderPin[],
  m: Affine,
  width: number,
  height: number,
  options?: LayoutOptions,
): PinLayout {
  'worklet';
  // No default parameter: the worklet transform reads captured values inside the body, so a
  // default like `= LAYOUT_DEFAULTS` is a ReferenceError on the UI thread (crashed build 5).
  const opts = options ?? LAYOUT_DEFAULTS;
  const zoom = scaleOf(m);
  const r = zoom < opts.offZoom ? opts.clusterPx : 0;
  const n = pins.length;
  const vx: number[] = new Array(n);
  const vy: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = apply(m, pins[i]!);
    vx[i] = v.x;
    vy[i] = v.y;
  }

  // Greedy clustering: seeds in a grid of cell size r, so the 3×3 neighbourhood holds every
  // seed within r.
  const groups: number[][] = [];
  if (r > 0) {
    const seeds = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (pins[i]!.solo) {
        groups.push([i]);
        continue;
      }
      const cx = Math.floor(vx[i]! / r);
      const cy = Math.floor(vy[i]! / r);
      let joined = -1;
      let best = r * r;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = seeds.get(`${cx + dx},${cy + dy}`);
          if (!cell) continue;
          for (const g of cell) {
            const s = groups[g]![0]!;
            const d = (vx[s]! - vx[i]!) ** 2 + (vy[s]! - vy[i]!) ** 2;
            if (d <= best) {
              best = d;
              joined = g;
            }
          }
        }
      }
      if (joined >= 0) {
        groups[joined]!.push(i);
      } else {
        const key = `${cx},${cy}`;
        const cell = seeds.get(key);
        if (cell) cell.push(groups.length);
        else seeds.set(key, [groups.length]);
        groups.push([i]);
      }
    }
  } else {
    for (let i = 0; i < n; i++) groups.push([i]);
  }

  const x0 = -opts.marginPx;
  const y0 = -opts.marginPx;
  const x1 = width + opts.marginPx;
  const y1 = height + opts.marginPx;
  const placed: PlacedPin[] = [];
  const clusters: PlacedCluster[] = [];
  for (const g of groups) {
    if (g.length === 1) {
      const i = g[0]!;
      if (vx[i]! >= x0 && vx[i]! <= x1 && vy[i]! >= y0 && vy[i]! <= y1) placed.push({ index: i, vx: vx[i]!, vy: vy[i]! });
      continue;
    }
    let sx = 0;
    let sy = 0;
    let top = g[0]!;
    for (const i of g) {
      sx += vx[i]!;
      sy += vy[i]!;
      if (pins[i]!.rank > pins[top]!.rank) top = i;
    }
    const cx = sx / g.length;
    const cy = sy / g.length;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
      clusters.push({ members: g, vx: cx, vy: cy, fill: pins[top]!.fill, rank: pins[top]!.rank });
    }
  }
  return { zoom, pins: placed, clusters };
}

export type Hit = { kind: 'pin'; index: number } | { kind: 'cluster'; members: number[] } | null;

/** The pin or cluster nearest to a tap (view points), within `radiusPx`. */
export function hitTest(layout: PinLayout, x: number, y: number, radiusPx: number): Hit {
  'worklet';
  let hit: Hit = null;
  let best = radiusPx * radiusPx;
  for (const p of layout.pins) {
    const d = (p.vx - x) ** 2 + (p.vy - y) ** 2;
    if (d <= best) {
      best = d;
      hit = { kind: 'pin', index: p.index };
    }
  }
  for (const c of layout.clusters) {
    const d = (c.vx - x) ** 2 + (c.vy - y) ** 2;
    if (d <= best) {
      best = d;
      hit = { kind: 'cluster', members: c.members };
    }
  }
  return hit;
}
