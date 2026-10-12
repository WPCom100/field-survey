/**
 * Two more layers of the plan overlay (T45): the source-sheet **boundaries** the composite's
 * optional-content group drew (D100 — the display PDF has it off, Skia draws them instead) and
 * the **grid bubbles** of the sheet's calibration while the Grid panel is open. Both are drawn on
 * the UI thread every pan/zoom frame from plain data under the sheet → view map (D95), in view
 * points so line widths and text stay a constant size on screen. Worklets: no default parameters
 * (`worklets.test.ts`).
 */

import { PaintStyle, Skia, type SkCanvas, type SkFont } from '@shopify/react-native-skia';

import { apply, type Affine } from './viewport';

export type BoundaryLine = { points: [number, number][] };
export type BoundaryLabel = { text: string; x: number; y: number };
export type GridMark = { label: string; axis: 'col' | 'row'; x: number; y: number; set: number };

export const BOUNDARY_COLOR = '#d81b60'; // the composite's magenta
const BOUNDARY_PX = 1.5;
const DASH_PX = [10, 6];
/** One colour per grid set, cycled. */
export const GRID_SET_COLORS = ['#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f'];
const MARK_R = 11;

export function drawBoundaries(canvas: SkCanvas, lines: readonly BoundaryLine[], labels: readonly BoundaryLabel[], m: Affine, font: SkFont): void {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(BOUNDARY_PX);
  paint.setColor(Skia.Color(BOUNDARY_COLOR));
  paint.setPathEffect(Skia.PathEffect.MakeDash(DASH_PX, 0));
  for (let i = 0; i < lines.length; i++) {
    const pts = lines[i]!.points;
    if (pts.length < 2) continue;
    const path = Skia.Path.Make();
    for (let j = 0; j < pts.length; j++) {
      const p = apply(m, { x: pts[j]![0], y: pts[j]![1] });
      if (j === 0) path.moveTo(p.x, p.y);
      else path.lineTo(p.x, p.y);
    }
    canvas.drawPath(path, paint);
  }
  const text = Skia.Paint();
  text.setAntiAlias(true);
  text.setColor(Skia.Color(BOUNDARY_COLOR));
  const halo = Skia.Paint();
  halo.setAntiAlias(true);
  halo.setStyle(PaintStyle.Stroke);
  halo.setStrokeWidth(3);
  halo.setColor(Skia.Color('#ffffff'));
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    const p = apply(m, { x: l.x, y: l.y });
    canvas.drawText(l.text, p.x + 4, p.y - 4, halo, font);
    canvas.drawText(l.text, p.x + 4, p.y - 4, text, font);
  }
}

export function drawGridMarks(canvas: SkCanvas, marks: readonly GridMark[], m: Affine, font: SkFont): void {
  'worklet';
  const ring = Skia.Paint();
  ring.setAntiAlias(true);
  ring.setStyle(PaintStyle.Stroke);
  ring.setStrokeWidth(2);
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  fill.setColor(Skia.Color('#ffffffdd'));
  const text = Skia.Paint();
  text.setAntiAlias(true);
  for (let i = 0; i < marks.length; i++) {
    const k = marks[i]!;
    const p = apply(m, { x: k.x, y: k.y });
    const color = GRID_SET_COLORS[k.set % GRID_SET_COLORS.length]!;
    ring.setColor(Skia.Color(color));
    text.setColor(Skia.Color(color));
    canvas.drawCircle(p.x, p.y, MARK_R, fill);
    canvas.drawCircle(p.x, p.y, MARK_R, ring);
    const w = font.measureText(k.label).width;
    canvas.drawText(k.label, p.x - w / 2, p.y + 4, text, font);
  }
}
