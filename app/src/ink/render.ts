/**
 * Skia rendering of stroke lists (T21 photo markup, T24 plan ink). Strokes are recorded into an
 * `SkPicture` in the list's own units (sheet points or image pixels) on the JS thread whenever the
 * list changes; the screen then draws that picture under its display transform, so a pan or zoom
 * never re-tessellates a stroke (the plan overlay draws it on the UI thread, D95).
 */

import { PaintStyle, Skia, StrokeCap, StrokeJoin, matchFont, type SkCanvas, type SkFont, type SkPicture } from '@shopify/react-native-skia';
import { unpackPoints, type Stroke, type StrokeList } from '@field-survey/core';

import { arrowHead, ellipseRect, penSegments } from './geometry';

const fonts = new Map<number, SkFont>();
function fontOf(size: number): SkFont {
  const key = Math.max(1, Math.round(size));
  let f = fonts.get(key);
  if (!f) {
    f = matchFont({ fontFamily: 'Helvetica', fontSize: key, fontWeight: 'bold' });
    fonts.set(key, f);
  }
  return f;
}

function linePaint(color: string, width: number) {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setStyle(PaintStyle.Stroke);
  p.setStrokeCap(StrokeCap.Round);
  p.setStrokeJoin(StrokeJoin.Round);
  p.setStrokeWidth(width);
  p.setColor(Skia.Color(color));
  return p;
}

/** Draw one stroke in the list's units; `alpha` fades it (another user's layer, when asked). */
export function drawStroke(canvas: SkCanvas, s: Stroke, opts: { alpha?: number } = {}): void {
  const alpha = opts.alpha ?? 1;
  switch (s.tool) {
    case 'pen': {
      const paint = linePaint(s.color, s.width);
      paint.setAlphaf(alpha);
      for (const g of penSegments(s)) {
        paint.setStrokeWidth(g.width);
        canvas.drawLine(g.x1, g.y1, g.x2, g.y2, paint);
      }
      return;
    }
    case 'highlighter': {
      const pts = unpackPoints(s.points);
      const path = Skia.Path.Make();
      pts.forEach((q, i) => (i === 0 ? path.moveTo(q.x, q.y) : path.lineTo(q.x, q.y)));
      if (pts.length === 1) path.lineTo(pts[0]!.x + 0.01, pts[0]!.y);
      const paint = linePaint(s.color, s.width);
      paint.setAlphaf(0.35 * alpha);
      canvas.drawPath(path, paint);
      return;
    }
    case 'arrow': {
      const [a] = unpackPoints(s.points);
      const h = arrowHead(s);
      const paint = linePaint(s.color, s.width);
      paint.setAlphaf(alpha);
      canvas.drawLine(a!.x, a!.y, h.tip.x, h.tip.y, paint);
      canvas.drawLine(h.tip.x, h.tip.y, h.left.x, h.left.y, paint);
      canvas.drawLine(h.tip.x, h.tip.y, h.right.x, h.right.y, paint);
      return;
    }
    case 'ellipse': {
      const r = ellipseRect(s);
      const paint = linePaint(s.color, s.width);
      paint.setAlphaf(alpha);
      canvas.drawOval(Skia.XYWHRect(r.x, r.y, r.width, r.height), paint);
      return;
    }
    case 'text': {
      const [a] = unpackPoints(s.points);
      const font = fontOf(s.width);
      const halo = Skia.Paint();
      halo.setAntiAlias(true);
      halo.setStyle(PaintStyle.Stroke);
      halo.setStrokeWidth(Math.max(1, s.width / 6));
      halo.setColor(Skia.Color(s.color === '#ffffff' ? '#111111' : '#ffffff'));
      halo.setAlphaf(alpha);
      canvas.drawText(s.text ?? '', a!.x, a!.y, halo, font);
      const fill = Skia.Paint();
      fill.setAntiAlias(true);
      fill.setColor(Skia.Color(s.color));
      fill.setAlphaf(alpha);
      canvas.drawText(s.text ?? '', a!.x, a!.y, fill, font);
      return;
    }
    case 'marker': {
      // a camera mark centred on the point, `width` across
      const [a] = unpackPoints(s.points);
      const w = s.width;
      const body = Skia.Paint();
      body.setAntiAlias(true);
      body.setColor(Skia.Color(s.color));
      body.setAlphaf(alpha);
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(a!.x - w / 2, a!.y - w * 0.35, w, w * 0.7), w * 0.12, w * 0.12), body);
      canvas.drawRect(Skia.XYWHRect(a!.x - w * 0.18, a!.y - w * 0.48, w * 0.36, w * 0.16), body);
      const lens = Skia.Paint();
      lens.setAntiAlias(true);
      lens.setColor(Skia.Color('#ffffff'));
      lens.setAlphaf(alpha);
      canvas.drawCircle(a!.x, a!.y, w * 0.22, lens);
      return;
    }
  }
}

/** All strokes of the given lists as one picture in their (shared) units; later lists draw on top. */
export function recordStrokes(lists: readonly (StrokeList | { list: StrokeList; alpha: number })[], bounds: { width: number; height: number }): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, Math.max(bounds.width, 1), Math.max(bounds.height, 1)));
  for (const item of lists) {
    const list = 'list' in item ? item.list : item;
    const alpha = 'list' in item ? item.alpha : 1;
    for (const s of list.strokes) {
      try {
        drawStroke(canvas, s, { alpha });
      } catch (e) {
        console.warn(`[plan] stroke ${s.id} not drawn: ${String(e)}`);
      }
    }
  }
  return recorder.finishRecordingAsPicture();
}

/** One stroke (the one being drawn) as a picture. */
export function recordStroke(s: Stroke | null, bounds: { width: number; height: number }): SkPicture {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, Math.max(bounds.width, 1), Math.max(bounds.height, 1)));
  if (s) drawStroke(canvas, s);
  return recorder.finishRecordingAsPicture();
}
