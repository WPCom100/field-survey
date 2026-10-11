/**
 * The ink layer of the plan overlay (T24, D53): every user's strokes, recorded once into an
 * `SkPicture` in sheet coordinates on the JS thread (`ink/render.ts`), drawn here on the UI thread
 * under the sheet → view matrix of the current viewport — so ink follows a pinch exactly like the
 * pins (D95, T64) and a pan never re-tessellates a stroke. A worklet: no default parameters (the
 * build-5 crash, `worklets.test.ts`).
 */

import { Skia, type SkCanvas, type SkPicture } from '@shopify/react-native-skia';

import type { Affine } from './viewport';

/** Row-major 3×3 of the sheet → view map, as `Skia.Matrix` takes it. */
export function inkMatrix(m: Affine): number[] {
  'worklet';
  return [m.a, m.c, m.tx, m.b, m.d, m.ty, 0, 0, 1];
}

export function drawInkLayer(canvas: SkCanvas, ink: SkPicture, m: Affine): void {
  'worklet';
  canvas.save();
  canvas.concat(Skia.Matrix(inkMatrix(m)));
  canvas.drawPicture(ink);
  canvas.restore();
}
