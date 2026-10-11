/**
 * Markup over a photo (T21, Phase 3 §4.4): the JPEG drawn letterboxed in Skia with the stroke list
 * on top, in image pixels (`space: 'image'`). One finger or the Pencil draws with the current tool;
 * the original image is never changed — the strokes are their own blob.
 */

import {
  DEFAULT_PRESSURE,
  makeStroke,
  strokeAt,
  uuidv7,
  withStroke,
  withoutStroke,
  type Stroke,
  type StrokeList,
  type StrokePoint,
  type StrokeTool,
} from '@field-survey/core';
import { Canvas, Group, Image as SkiaImage, Picture, useImage } from '@shopify/react-native-skia';
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { containTransform } from '../ink/geometry';
import { recordStroke, recordStrokes } from '../ink/render';

export type MarkupTool = Extract<StrokeTool, 'pen' | 'arrow' | 'ellipse' | 'text'> | 'erase';

type Props = {
  imageUri: string | null;
  list: StrokeList;
  onChange: (list: StrokeList) => void;
  tool: MarkupTool;
  color: string;
  /** Base line width in image pixels. */
  lineWidth: number;
  /** Text tool: where the surveyor tapped (image pixels); the caller asks for the words. */
  onTextAt: (p: StrokePoint) => void;
  readOnly?: boolean;
};

/** Pencil force (0–1) or the default for a finger, from an RN touch. */
export function touchPressure(e: GestureResponderEvent): number {
  const f = (e.nativeEvent as { force?: number }).force;
  return typeof f === 'number' && f > 0 ? Math.min(1, f) : DEFAULT_PRESSURE;
}

export function MarkupCanvas({ imageUri, list, onChange, tool, color, lineWidth, onTextAt, readOnly }: Props) {
  const image = useImage(imageUri ?? undefined);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<Stroke | null>(null);
  const points = useRef<StrokePoint[]>([]);
  const space = { width: list.width, height: list.height };
  const t = containTransform(space, view);

  const committed = useMemo(() => recordStrokes([list], { width: list.width, height: list.height }), [list]);
  const livePic = useMemo(() => recordStroke(live, { width: list.width, height: list.height }), [live, list.width, list.height]);

  const toSpace = (e: GestureResponderEvent): StrokePoint => ({
    x: (e.nativeEvent.locationX - t.ox) / t.scale,
    y: (e.nativeEvent.locationY - t.oy) / t.scale,
    p: touchPressure(e),
  });
  const inside = (p: StrokePoint) => p.x >= 0 && p.y >= 0 && p.x <= space.width && p.y <= space.height;

  const build = (pts: StrokePoint[]): Stroke | null => {
    if (tool === 'erase' || tool === 'text' || pts.length === 0) return null;
    if ((tool === 'arrow' || tool === 'ellipse') && pts.length < 2) return null;
    try {
      return makeStroke({ id: uuidv7(), tool, color, width: lineWidth, points: pts, at: new Date().toISOString(), minStep: 1 / Math.max(t.scale, 1e-6) });
    } catch {
      return null;
    }
  };

  const erase = (p: StrokePoint) => {
    const hit = strokeAt(list, p.x, p.y, 12 / Math.max(t.scale, 1e-6));
    if (hit) onChange(withoutStroke(list, hit.id));
  };

  return (
    <View
      style={styles.root}
      onLayout={(e: LayoutChangeEvent) => setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      onStartShouldSetResponder={() => !readOnly}
      onMoveShouldSetResponder={() => !readOnly}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        const p = toSpace(e);
        points.current = [p];
        if (tool === 'erase') erase(p);
        else setLive(build([p]));
      }}
      onResponderMove={(e) => {
        const p = toSpace(e);
        if (tool === 'erase') return erase(p);
        if (tool === 'text') return;
        points.current.push(p);
        setLive(build(points.current));
      }}
      onResponderRelease={() => {
        const pts = points.current;
        points.current = [];
        setLive(null);
        if (tool === 'text') {
          if (pts[0] && inside(pts[0])) onTextAt(pts[0]);
          return;
        }
        const s = build(pts);
        if (s) onChange(withStroke(list, s));
      }}
      onResponderTerminate={() => {
        points.current = [];
        setLive(null);
      }}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        {image && view.width > 0 ? (
          <SkiaImage image={image} x={t.ox} y={t.oy} width={space.width * t.scale} height={space.height * t.scale} fit="fill" />
        ) : null}
        <Group transform={[{ translateX: t.ox }, { translateY: t.oy }, { scale: t.scale }]}>
          <Picture picture={committed} />
          <Picture picture={livePic} />
        </Group>
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1d1f22' },
});
