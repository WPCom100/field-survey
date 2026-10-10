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
 * No React or native imports: this file is unit-tested in Node. Functions the pin overlay calls
 * on the UI thread carry the `'worklet'` directive (a plain string in Node).
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
  'worklet';
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

/** `compose(outer, inner)` maps p ↦ outer(inner(p)). */
export function compose(outer: Affine, inner: Affine): Affine {
  'worklet';
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
  'worklet';
  return Math.hypot(m.a, m.b);
}

/** sheet → page: flip y inside the CropBox. */
export function sheetToPage(vp: PdfViewport): Affine {
  'worklet';
  const { x, y, height } = vp.cropBox;
  return { a: 1, b: 0, c: 0, d: -1, tx: x, ty: y + height };
}

export function pageToSheet(vp: PdfViewport, p: Point): Point {
  return { x: p.x - vp.cropBox.x, y: vp.cropBox.y + vp.cropBox.height - p.y };
}

/** sheet → view: the matrix the Skia overlay draws under. */
export function sheetToView(vp: PdfViewport): Affine {
  'worklet';
  return compose(vp, sheetToPage(vp));
}

/**
 * The patch's raw `onChange` message `viewport|a|b|c|d|tx|ty|cx|cy|cw|ch|page` (as `index.js` of
 * the patched package parses it), or null for any other message. Runs on the UI thread in the
 * viewport event handler (T64), before the event reaches JS.
 */
export function parseViewportMessage(message: string): PdfViewport | null {
  'worklet';
  const f = message.split('|');
  if (f.length !== 12 || f[0] !== 'viewport') return null;
  const n: number[] = [];
  for (let i = 1; i < 12; i++) {
    const v = Number(f[i]);
    if (!Number.isFinite(v)) return null;
    n.push(v);
  }
  return {
    a: n[0]!,
    b: n[1]!,
    c: n[2]!,
    d: n[3]!,
    tx: n[4]!,
    ty: n[5]!,
    cropBox: { x: n[6]!, y: n[7]!, width: n[8]!, height: n[9]! },
    page: n[10]!,
  };
}

export function viewToSheet(vp: PdfViewport): Affine {
  return invert(sheetToView(vp));
}

/** Row-major 3×3 for `Skia.Matrix()` / the `matrix` prop. */
export function toSkiaMatrix(m: Affine): number[] {
  return [m.a, m.c, m.tx, m.b, m.d, m.ty, 0, 0, 1];
}

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** Sheet rect → page rect (PDF user space, y up): what the native focus command takes. */
export function sheetRectToPage(vp: PdfViewport, r: Rect): Rect {
  return {
    x: vp.cropBox.x + r.x,
    y: vp.cropBox.y + vp.cropBox.height - (r.y + r.height),
    width: r.width,
    height: r.height,
  };
}

/** The whole sheet (the CropBox) in sheet coordinates: what "fit" shows. */
export function sheetRect(vp: PdfViewport): Rect {
  return { x: 0, y: 0, width: vp.cropBox.width, height: vp.cropBox.height };
}

/**
 * The sheet rect to show so that `points` are in view, centred, with `padPx` screen points
 * around them, and the zoom (view points per sheet point) at most `maxZoom` — a lone pin is
 * shown at `maxZoom`, not blown up to fill the screen. The rect keeps the view's aspect ratio,
 * so fitting it into the view shows exactly it.
 */
export function focusRect(points: readonly Point[], view: Size, maxZoom: number, padPx = 48): Rect {
  if (points.length === 0) throw new Error('focusRect: no points');
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const innerW = Math.max(1, view.width - 2 * padPx);
  const innerH = Math.max(1, view.height - 2 * padPx);
  const zoom = Math.min(maxZoom, innerW / Math.max(x1 - x0, 1e-6), innerH / Math.max(y1 - y0, 1e-6));
  const width = view.width / zoom;
  const height = view.height / zoom;
  return { x: (x0 + x1) / 2 - width / 2, y: (y0 + y1) / 2 - height / 2, width, height };
}

/** Is the sheet point inside the view, `marginPx` in from its edges? */
export function inView(vp: PdfViewport, view: Size, p: Point, marginPx = 0): boolean {
  const v = apply(sheetToView(vp), p);
  return v.x >= marginPx && v.y >= marginPx && v.x <= view.width - marginPx && v.y <= view.height - marginPx;
}
