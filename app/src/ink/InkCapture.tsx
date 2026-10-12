/**
 * Draw mode over the plan (T24, T69): turns the one-finger / Pencil touches the patched PDF view
 * sends in draw mode (`touches.ts`, D129) into strokes in **sheet coordinates** (D92) with Apple
 * Pencil pressure, and shows the stroke being drawn. It takes no touches itself, so two fingers
 * still reach PDFKit and pan and zoom the plan; a second finger cancels the stroke under way.
 * Committed strokes are drawn by the overlay's ink picture (`PinOverlay`), so this layer only ever
 * draws one stroke.
 */

import {
  emptyStrokeList,
  makeStroke,
  strokeAt,
  uuidv7,
  withStroke,
  withoutStroke,
  type Stroke,
  type StrokeList,
  type StrokePoint,
} from '@field-survey/core';
import { Canvas, Group, Picture, Skia } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { apply, scaleOf, sheetToView, toSkiaMatrix, viewToSheet, type PdfViewport } from '../plan/viewport';
import { recordStroke } from './render';
import type { InkBus } from './touches';
import type { DrawPoint } from './useDrawGesture';

export type InkTool = 'pen' | 'highlighter' | 'text' | 'erase';

type Props = {
  /** Draw-mode touches from the Pdf view. */
  touches: InkBus;
  /** The viewport when the touch starts (a stroke is one finger, so PDFKit does not move under it). */
  viewport: () => PdfViewport | null;
  tool: InkTool;
  color: string;
  /** Line width on screen, view points; stored in sheet points at the zoom the stroke starts at. */
  widthPx: number;
  mine: StrokeList | null;
  onChange: (list: StrokeList) => void;
  /** Text tool: where the note goes (sheet points), and its size in sheet points. */
  onTextAt: (at: StrokePoint, size: number) => void;
};

export function surfaceOf(vp: PdfViewport): { width: number; height: number } {
  return { width: vp.cropBox.width, height: vp.cropBox.height };
}

export function InkCapture({ touches, viewport, tool, color, widthPx, mine, onChange, onTextAt }: Props) {
  const [live, setLive] = useState<{ stroke: Stroke; vp: PdfViewport } | null>(null);
  const pts = useRef<StrokePoint[]>([]);
  const start = useRef<{ vp: PdfViewport; zoom: number } | null>(null);
  /** The list as this layer last changed it, so a fast eraser sees its own previous erase. */
  const latest = useRef<StrokeList | null>(mine);
  latest.current = mine;

  const toSheet = (d: DrawPoint, vp: PdfViewport): StrokePoint => {
    const p = apply(viewToSheet(vp), { x: d.x, y: d.y });
    return { x: p.x, y: p.y, p: d.p };
  };
  const build = (zoom: number): Stroke | null => {
    if (tool !== 'pen' && tool !== 'highlighter') return null;
    if (!pts.current.length) return null;
    return makeStroke({
      id: uuidv7(),
      tool,
      color,
      width: (tool === 'highlighter' ? widthPx * 4 : widthPx) / zoom,
      points: pts.current,
      at: new Date().toISOString(),
      minStep: 1 / zoom,
    });
  };
  const erase = (p: StrokePoint, zoom: number) => {
    const list = latest.current;
    if (!list) return;
    const hit = strokeAt(list, p.x, p.y, 14 / zoom);
    if (!hit) return;
    const next = withoutStroke(list, hit.id);
    latest.current = next;
    console.log(`[plan] ink: erased a ${hit.tool} stroke (${next.strokes.length} left)`);
    onChange(next);
  };

  const handlers = {
    onStart: (d: DrawPoint) => {
      const vp = viewport();
      if (!vp) return;
      const zoom = scaleOf(sheetToView(vp));
      start.current = { vp, zoom };
      const p = toSheet(d, vp);
      pts.current = [p];
      if (tool === 'erase') erase(p, zoom);
      else {
        const s = build(zoom);
        if (s) setLive({ stroke: s, vp });
      }
    },
    onMove: (d: DrawPoint) => {
      const st = start.current;
      if (!st) return;
      const p = toSheet(d, st.vp);
      if (tool === 'erase') return erase(p, st.zoom);
      if (tool === 'text') return;
      pts.current.push(p);
      const s = build(st.zoom);
      if (s) setLive({ stroke: s, vp: st.vp });
    },
    onEnd: () => {
      const st = start.current;
      start.current = null;
      setLive(null);
      if (!st) return;
      if (tool === 'text') {
        if (pts.current[0]) onTextAt(pts.current[0], 14 / st.zoom);
      } else if (tool === 'pen' || tool === 'highlighter') {
        const s = build(st.zoom);
        if (s) {
          const list = latest.current ?? emptyStrokeList('sheet', st.vp.cropBox.width, st.vp.cropBox.height);
          const ps = pts.current.map((q) => q.p);
          console.log(`[plan] ink: ${tool} stroke, ${ps.length} points, pressure ${Math.min(...ps).toFixed(2)}–${Math.max(...ps).toFixed(2)}`);
          onChange(withStroke(list, s));
        }
      }
      pts.current = [];
    },
    /** A second finger came down: drop the stroke, PDFKit pans and zooms. */
    onCancel: () => {
      start.current = null;
      pts.current = [];
      setLive(null);
    },
  };
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(
    () =>
      touches.listen((t) => {
        const h = ref.current;
        if (t.phase === 'start') {
          h.onStart(t.points[0]!);
          for (const p of t.points.slice(1)) h.onMove(p);
        } else if (t.phase === 'move') {
          for (const p of t.points) h.onMove(p);
        } else if (t.phase === 'end') h.onEnd();
        else h.onCancel();
      }),
    [touches],
  );

  const picture = useMemo(() => (live ? recordStroke(live.stroke, surfaceOf(live.vp)) : null), [live]);
  const matrix = useMemo(() => (live ? Skia.Matrix(toSkiaMatrix(sheetToView(live.vp))) : null), [live]);

  if (!picture || !matrix) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Group matrix={matrix}>
        <Picture picture={picture} />
      </Group>
    </Canvas>
  );
}
