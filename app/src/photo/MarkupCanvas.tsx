/**
 * Markup over a photo (T21, Phase 3 §4.4): the JPEG drawn letterboxed in Skia with the stroke list
 * on top, in image pixels (`space: 'image'`). One finger or the Pencil draws with the current tool;
 * the original image is never changed — the strokes are their own blob. Touches come through
 * gesture-handler so the Pencil's pressure is known (D116).
 */

import {
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
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';

import { containTransform } from '../ink/geometry';
import { recordStroke, recordStrokes } from '../ink/render';
import { useDrawGesture, type DrawPoint } from '../ink/useDrawGesture';

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

export function MarkupCanvas({ imageUri, list, onChange, tool, color, lineWidth, onTextAt, readOnly }: Props) {
  const image = useImage(imageUri ?? undefined);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState<Stroke | null>(null);
  const points = useRef<StrokePoint[]>([]);
  const latest = useRef(list);
  latest.current = list;
  const space = { width: list.width, height: list.height };
  const t = containTransform(space, view);

  const committed = useMemo(() => recordStrokes([list], { width: list.width, height: list.height }), [list]);
  const livePic = useMemo(() => recordStroke(live, { width: list.width, height: list.height }), [live, list.width, list.height]);

  const toSpace = (d: DrawPoint): StrokePoint => ({ x: (d.x - t.ox) / t.scale, y: (d.y - t.oy) / t.scale, p: d.p });
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
    const hit = strokeAt(latest.current, p.x, p.y, 12 / Math.max(t.scale, 1e-6));
    if (!hit) return;
    latest.current = withoutStroke(latest.current, hit.id);
    onChange(latest.current);
  };

  const gesture = useDrawGesture(
    {
      onStart: (d) => {
        const p = toSpace(d);
        points.current = [p];
        if (tool === 'erase') erase(p);
        else setLive(build([p]));
      },
      onMove: (d) => {
        const p = toSpace(d);
        if (tool === 'erase') return erase(p);
        if (tool === 'text') return;
        points.current.push(p);
        setLive(build(points.current));
      },
      onEnd: () => {
        const pts = points.current;
        points.current = [];
        setLive(null);
        if (tool === 'text') {
          if (pts[0] && inside(pts[0])) onTextAt(pts[0]);
          return;
        }
        const s = build(pts);
        if (s) onChange(withStroke(latest.current, s));
      },
    },
    !readOnly,
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.root}
          collapsable={false}
          onLayout={(e: LayoutChangeEvent) => setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
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
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0, backgroundColor: '#1d1f22' },
});
