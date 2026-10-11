/**
 * Draw mode over the plan (T24): takes the touches PDFKit would otherwise get, turns them into
 * strokes in **sheet coordinates** (D92) with Pencil pressure, and shows the stroke being drawn.
 * Committed strokes are drawn by the overlay's ink picture (`PinOverlay`), so this layer only ever
 * draws one stroke. "Pan" lets the touches through to PDFKit again without leaving draw mode.
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
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { touchPressure } from '../photo/MarkupCanvas';
import { apply, scaleOf, sheetToView, toSkiaMatrix, viewToSheet, type PdfViewport } from '../plan/viewport';
import { recordStroke } from './render';

export type InkTool = 'pen' | 'highlighter' | 'text' | 'erase' | 'pan';

type Props = {
  /** The viewport when the touch starts (PDFKit does not move while draw mode has the touches). */
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

export function InkCapture({ viewport, tool, color, widthPx, mine, onChange, onTextAt }: Props) {
  const [live, setLive] = useState<{ stroke: Stroke; vp: PdfViewport } | null>(null);
  const pts = useRef<StrokePoint[]>([]);
  const start = useRef<{ vp: PdfViewport; zoom: number } | null>(null);

  const toSheet = (e: GestureResponderEvent, vp: PdfViewport): StrokePoint => {
    const p = apply(viewToSheet(vp), { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
    return { x: p.x, y: p.y, p: touchPressure(e) };
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
    if (!mine) return;
    const hit = strokeAt(mine, p.x, p.y, 14 / zoom);
    if (hit) onChange(withoutStroke(mine, hit.id));
  };

  const picture = useMemo(() => (live ? recordStroke(live.stroke, surfaceOf(live.vp)) : null), [live]);
  const matrix = useMemo(() => (live ? Skia.Matrix(toSkiaMatrix(sheetToView(live.vp))) : null), [live]);

  if (tool === 'pan') return null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const vp = viewport();
        if (!vp) return;
        const zoom = scaleOf(sheetToView(vp));
        start.current = { vp, zoom };
        const p = toSheet(e, vp);
        pts.current = [p];
        if (tool === 'erase') erase(p, zoom);
        else {
          const s = build(zoom);
          if (s) setLive({ stroke: s, vp });
        }
      }}
      onResponderMove={(e) => {
        const st = start.current;
        if (!st) return;
        const p = toSheet(e, st.vp);
        if (tool === 'erase') return erase(p, st.zoom);
        if (tool === 'text') return;
        pts.current.push(p);
        const s = build(st.zoom);
        if (s) setLive({ stroke: s, vp: st.vp });
      }}
      onResponderRelease={() => {
        const st = start.current;
        start.current = null;
        setLive(null);
        if (!st) return;
        if (tool === 'text') {
          if (pts.current[0]) onTextAt(pts.current[0], 14 / st.zoom);
        } else if (tool === 'pen' || tool === 'highlighter') {
          const s = build(st.zoom);
          if (s) onChange(withStroke(mine ?? emptyStrokeList('sheet', st.vp.cropBox.width, st.vp.cropBox.height), s));
        }
        pts.current = [];
      }}
      onResponderTerminate={() => {
        start.current = null;
        pts.current = [];
        setLive(null);
      }}>
      {picture && matrix ? (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Group matrix={matrix}>
            <Picture picture={picture} />
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
}
