/**
 * Coordinate spaces of the plan viewer (T16 spike, kept for T17).
 *
 * - **page**: PDF user space of the sheet's page in points, origin bottom-left, y up.
 *   This is what PDFKit's convertPoint:toPage: speaks.
 * - **sheet**: the CropBox's top-left corner as origin, y down, PDF points. Pins
 *   (`device.pin{x,y}`), ink strokes and grid calibration are stored in sheet space.
 * - **view**: points inside the Pdf view (y down), i.e. touch locations and what Skia draws in.
 *
 * Affine maps follow the PDF/Skia column convention: x' = a·x + c·y + tx, y' = b·x + d·y + ty.
 * No React or native imports: this file is unit-tested in Node.
 */

export type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

export type Point = { x: number; y: number };

/** What the patched `react-native-pdf` reports on every pan/zoom (page → view). */
export type PdfViewport = Affine & {
  cropBox: { x: number; y: number; width: number; height: number };
  page: number;
};

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

/** `compose(outer, inner)` maps p ↦ outer(inner(p)). */
export function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error('viewport: singular transform');
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

/** Uniform scale of the map (view points per unit); rotation-safe. */
export function scaleOf(m: Affine): number {
  return Math.hypot(m.a, m.b);
}

/** sheet → page: flip y inside the CropBox. */
export function sheetToPage(vp: PdfViewport): Affine {
  const { x, y, height } = vp.cropBox;
  return { a: 1, b: 0, c: 0, d: -1, tx: x, ty: y + height };
}

export function pageToSheet(vp: PdfViewport, p: Point): Point {
  return { x: p.x - vp.cropBox.x, y: vp.cropBox.y + vp.cropBox.height - p.y };
}

/** sheet → view: the matrix the Skia overlay draws under. */
export function sheetToView(vp: PdfViewport): Affine {
  return compose(vp, sheetToPage(vp));
}

export function viewToSheet(vp: PdfViewport): Affine {
  return invert(sheetToView(vp));
}

/** Row-major 3×3 for `Skia.Matrix()` / the `matrix` prop. */
export function toSkiaMatrix(m: Affine): number[] {
  return [m.a, m.c, m.tx, m.b, m.d, m.ty, 0, 0, 1];
}
