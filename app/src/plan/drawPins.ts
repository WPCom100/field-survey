/**
 * Draws the pin layer for one viewport into a Skia canvas (T17). Called on the UI thread from
 * the overlay's derived picture on every pan/zoom frame (D95), so it is a worklet and gets
 * only plain data plus Skia objects. Pins keep a constant on-screen size: everything is drawn
 * in view points at the pin's projected position.
 *
 * Per pin (D64, Phase 3 §2.2): shape = role (T112), fill = status (hollow red for `Not installed`),
 * a glyph inside as the non-colour signal, the ID label below (labels layer), a "+" corner mark
 * for field additions, a camera mark with the photo count (photos layer), a cyan ring when
 * selected, an amber ring while in review (Phase 3 §13). Side B of a pin conflict (T26) is a
 * dashed outline in the status colour with a "B" glyph. A cluster is a circle in its most urgent member's colour with the member count.
 */

import { PaintStyle, Skia, type SkCanvas, type SkFont, type SkPath } from '@shopify/react-native-skia';

import type { PinLayout, RenderPin } from './layout';
import { pinShape, type PinShapeMap } from './pins';

export const PIN_PX = 26;
const SELECT = '#00bcd4';
const HALO = '#ffffff';
const INK = '#111111';
const REVIEW = '#ff8f00';

export type PinFonts = { glyph: SkFont; label: SkFont; badge: SkFont };
/** `shapes`: the app library's role → shape (T104); the defaults when absent. */
export type PinDrawOptions = { labels: boolean; photos: boolean; selectedId: string | null; shapes?: PinShapeMap | null };

function shapeAt(role: string | null, cx: number, cy: number, size: number, shapes?: PinShapeMap | null): SkPath {
  'worklet';
  const shape = pinShape(role, size, shapes);
  const path = Skia.Path.Make();
  if (shape.kind === 'circle') {
    path.addCircle(cx, cy, shape.radius);
  } else if (shape.kind === 'rect') {
    const r = Skia.XYWHRect(cx - shape.width / 2, cy - shape.height / 2, shape.width, shape.height);
    if (shape.radius > 0) path.addRRect(Skia.RRectXY(r, shape.radius, shape.radius));
    else path.addRect(r);
  } else {
    for (let i = 0; i < shape.points.length; i++) {
      const p = shape.points[i]!;
      if (i === 0) path.moveTo(cx + p.x, cy + p.y);
      else path.lineTo(cx + p.x, cy + p.y);
    }
    path.close();
  }
  return path;
}

function centredText(canvas: SkCanvas, text: string, cx: number, baseline: number, font: SkFont, color: string, halo: boolean) {
  'worklet';
  const w = font.measureText(text).width;
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  if (halo) {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(3);
    paint.setColor(Skia.Color(HALO));
    canvas.drawText(text, cx - w / 2, baseline, paint, font);
    paint.setStyle(PaintStyle.Fill);
  }
  paint.setColor(Skia.Color(color));
  canvas.drawText(text, cx - w / 2, baseline, paint, font);
}

function drawPin(canvas: SkCanvas, pin: RenderPin, x: number, y: number, fonts: PinFonts, opts: PinDrawOptions) {
  'worklet';
  const shape = shapeAt(pin.role ?? pin.category, x, y, PIN_PX, opts.shapes);
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  if (pin.id === opts.selectedId) {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(7);
    paint.setColor(Skia.Color(SELECT));
    canvas.drawPath(shape, paint);
  }
  if (pin.review) {
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(3);
    paint.setColor(Skia.Color(REVIEW));
    canvas.drawCircle(x, y, PIN_PX * 0.85, paint);
  }
  if (pin.ghost) {
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(HALO));
    paint.setAlphaf(0.7);
    canvas.drawPath(shape, paint);
    paint.setAlphaf(1);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(2.5);
    paint.setColor(Skia.Color(pin.fill));
    paint.setPathEffect(Skia.PathEffect.MakeDash([5, 4], 0));
    canvas.drawPath(shape, paint);
    paint.setPathEffect(null);
  } else if (pin.hollow) {
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(HALO));
    canvas.drawPath(shape, paint);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(2.5);
    paint.setColor(Skia.Color(pin.fill));
    canvas.drawPath(shape, paint);
  } else {
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(pin.fill));
    canvas.drawPath(shape, paint);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(1.5);
    paint.setColor(Skia.Color(HALO));
    canvas.drawPath(shape, paint);
  }
  centredText(canvas, pin.glyph, x, y + 4, fonts.glyph, pin.hollow || pin.ghost ? pin.fill : HALO, false);

  if (pin.plus) {
    // field addition: "+" in a small dark disc at the top-left corner
    const fx = x - PIN_PX / 2 - 1;
    const fy = y - PIN_PX / 2 - 1;
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(INK));
    canvas.drawCircle(fx, fy, 6.5, paint);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(2);
    paint.setColor(Skia.Color(HALO));
    canvas.drawLine(fx - 3.5, fy, fx + 3.5, fy, paint);
    canvas.drawLine(fx, fy - 3.5, fx, fy + 3.5, paint);
  }

  if (opts.photos && pin.photos > 0) {
    // camera mark with the count at the top-right corner (D100)
    const bx = x + PIN_PX / 2 - 2;
    const by = y - PIN_PX / 2 - 6;
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color('#37474f'));
    canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(bx, by - 6, 26, 13), 3, 3), paint);
    paint.setColor(Skia.Color(HALO));
    canvas.drawRect(Skia.XYWHRect(bx + 2.5, by - 3, 9, 7), paint);
    paint.setColor(Skia.Color('#37474f'));
    canvas.drawCircle(bx + 7, by + 0.5, 2.2, paint);
    paint.setColor(Skia.Color(HALO));
    canvas.drawText(String(pin.photos), bx + 14, by + 4, paint, fonts.badge);
  }

  if (opts.labels) centredText(canvas, pin.label, x, y + PIN_PX / 2 + 13, fonts.label, INK, true);
}

/** The whole pin layer: clusters first, then pins, the selected pin last (on top). */
export function drawPins(canvas: SkCanvas, pins: readonly RenderPin[], layout: PinLayout, fonts: PinFonts, opts: PinDrawOptions) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  for (const c of layout.clusters) {
    const r = c.members.length < 10 ? 16 : c.members.length < 100 ? 19 : 22;
    let selected = false;
    for (const i of c.members) if (pins[i]!.id === opts.selectedId) selected = true;
    if (selected) {
      paint.setStyle(PaintStyle.Stroke);
      paint.setStrokeWidth(7);
      paint.setColor(Skia.Color(SELECT));
      canvas.drawCircle(c.vx, c.vy, r + 2, paint);
    }
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(c.fill));
    canvas.drawCircle(c.vx, c.vy, r, paint);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(3);
    paint.setColor(Skia.Color(HALO));
    canvas.drawCircle(c.vx, c.vy, r - 3, paint);
    centredText(canvas, String(c.members.length), c.vx, c.vy + 5, fonts.glyph, HALO, false);
  }
  let selected: { pin: RenderPin; x: number; y: number } | null = null;
  for (const p of layout.pins) {
    const pin = pins[p.index]!;
    if (pin.id === opts.selectedId) selected = { pin, x: p.vx, y: p.vy };
    else drawPin(canvas, pin, p.vx, p.vy, fonts, opts);
  }
  if (selected) drawPin(canvas, selected.pin, selected.x, selected.y, fonts, opts);
}
