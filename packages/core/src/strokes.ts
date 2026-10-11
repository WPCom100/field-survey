/**
 * Stroke lists (T21, T24; PLAN §2.2 `photo.markup_blob`, `ink_layer.drawing_blob`; D53): the one
 * JSON format for photo markup and plan ink. A list is a blob (content-addressed, never edited in
 * place): every save writes a new list with a new SHA-256 and points the record at it. Format
 * reference: `docs/strokes.md`. The server reads the same JSON to flatten markup onto Photo Log
 * thumbnails (T29) and all users' ink onto the floor PDF (T59).
 *
 * No React or Expo imports: tested in Node and bundled into the iPad app.
 */

export const STROKES_FORMAT = 'field-survey/strokes';
export const STROKES_VERSION = 1;

/** `sheet`: plan ink in sheet coordinates (PDF points, CropBox top-left, y down — D92). `image`: photo markup in JPEG pixels (top-left, y down). */
export const STROKE_SPACES = ['sheet', 'image'] as const;
export type StrokeSpace = (typeof STROKE_SPACES)[number];

/**
 * - `pen`: freehand; width varies with pressure.
 * - `highlighter`: freehand, constant width, drawn translucent.
 * - `arrow`: two points, start → end, head at the end.
 * - `ellipse`: two points, opposite corners of the box the ellipse fills.
 * - `text`: one point (left end of the baseline), `text`, `width` = font size.
 * - `marker`: one point, a camera mark for a photo taken there (`ref`), T23 "Photo here".
 */
export const STROKE_TOOLS = ['pen', 'highlighter', 'arrow', 'ellipse', 'text', 'marker'] as const;
export type StrokeTool = (typeof STROKE_TOOLS)[number];

export interface StrokePoint {
  x: number;
  y: number;
  /** Pencil pressure 0–1; a finger (no force) records `DEFAULT_PRESSURE`. */
  p: number;
}

export interface Stroke {
  /** UUID v7 of the stroke, unique within the list. */
  id: string;
  tool: StrokeTool;
  /** `#rrggbb` (or `#rrggbbaa`). */
  color: string;
  /** Base line width in the list's units; the font size for `text`. */
  width: number;
  /** Flat `x, y, p` triples. */
  points: number[];
  text?: string;
  ref?: { kind: 'photo'; id: string };
  /** When the stroke was drawn (ISO 8601). */
  at: string;
}

export interface StrokeList {
  format: typeof STROKES_FORMAT;
  version: typeof STROKES_VERSION;
  space: StrokeSpace;
  /** The drawing surface: the sheet's CropBox or the JPEG, in the list's units. */
  width: number;
  height: number;
  strokes: Stroke[];
}

export const DEFAULT_PRESSURE = 0.5;
/** Stroke width multiplier at pressure p: 1 at the default, thin when light, ~1.6× when hard. */
export function pressureScale(p: number): number {
  return 0.4 + 1.2 * clamp01(p);
}

export class StrokeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrokeFormatError';
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(clamp01(n) * 100) / 100;

const POINTS_FOR: Partial<Record<StrokeTool, number>> = { arrow: 2, ellipse: 2, text: 1, marker: 1 };

export function emptyStrokeList(space: StrokeSpace, width: number, height: number): StrokeList {
  return { format: STROKES_FORMAT, version: STROKES_VERSION, space, width: r1(width), height: r1(height), strokes: [] };
}

/** Flat triples from points, rounded (0.1 unit, pressure 0.01) to keep the blob small. */
export function packPoints(points: readonly StrokePoint[]): number[] {
  const out: number[] = [];
  for (const q of points) out.push(r1(q.x), r1(q.y), r2(q.p));
  return out;
}

export function unpackPoints(flat: readonly number[]): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push({ x: flat[i]!, y: flat[i + 1]!, p: flat[i + 2]! });
  return out;
}

/**
 * A stroke ready to add. Freehand strokes drop points closer than `minStep` to the previous one
 * (jitter from a resting Pencil); shapes keep exactly the points their tool needs.
 */
export function makeStroke(input: {
  id: string;
  tool: StrokeTool;
  color: string;
  width: number;
  points: readonly StrokePoint[];
  at: string;
  text?: string;
  ref?: { kind: 'photo'; id: string };
  minStep?: number;
}): Stroke {
  const need = POINTS_FOR[input.tool];
  let pts = input.points;
  if (need) {
    if (pts.length < need) throw new StrokeFormatError(`A ${input.tool} needs ${need} point(s)`);
    pts = need === 2 ? [pts[0]!, pts[pts.length - 1]!] : [pts[0]!];
  } else {
    const step = input.minStep ?? 0;
    const kept: StrokePoint[] = [];
    for (const q of pts) {
      const last = kept[kept.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) >= step) kept.push(q);
    }
    const end = pts[pts.length - 1];
    if (end && kept[kept.length - 1] !== end && kept.length > 1) kept[kept.length - 1] = end;
    pts = kept;
    if (pts.length === 0) throw new StrokeFormatError('A stroke needs at least one point');
  }
  if (input.tool === 'text' && !input.text?.trim()) throw new StrokeFormatError('A text stroke needs its text');
  if (input.tool === 'marker' && !input.ref) throw new StrokeFormatError('A marker needs the photo it marks');
  const s: Stroke = { id: input.id, tool: input.tool, color: input.color, width: r1(input.width), points: packPoints(pts), at: input.at };
  if (input.tool === 'text') s.text = input.text!.trim();
  if (input.ref) s.ref = { kind: input.ref.kind, id: input.ref.id };
  return s;
}

export function withStroke(list: StrokeList, stroke: Stroke): StrokeList {
  return { ...list, strokes: [...list.strokes, stroke] };
}

/** Undo: the list without its last stroke (unchanged when empty). */
export function withoutLast(list: StrokeList): StrokeList {
  return list.strokes.length ? { ...list, strokes: list.strokes.slice(0, -1) } : list;
}

export function withoutStroke(list: StrokeList, id: string): StrokeList {
  const strokes = list.strokes.filter((s) => s.id !== id);
  return strokes.length === list.strokes.length ? list : { ...list, strokes };
}

/** Axis-aligned bounds of a stroke's points (text and markers: their anchor point). */
export function strokeBounds(s: Stroke): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 2 < s.points.length; i += 3) {
    const x = s.points[i]!;
    const y = s.points[i + 1]!;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The topmost stroke within `tolerance` of a point (the eraser), or null. Freehand and arrows are
 * hit along their segments, ellipses on their outline box, text and markers near their anchor.
 */
export function strokeAt(list: StrokeList, x: number, y: number, tolerance: number): Stroke | null {
  for (let k = list.strokes.length - 1; k >= 0; k--) {
    const s = list.strokes[k]!;
    const pts = unpackPoints(s.points);
    const tol = tolerance + s.width / 2;
    if (s.tool === 'ellipse') {
      const b = strokeBounds(s);
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      const rx = Math.max((b.x1 - b.x0) / 2, 1e-6);
      const ry = Math.max((b.y1 - b.y0) / 2, 1e-6);
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry); // 1 on the outline
      if (Math.abs(d - 1) * Math.min(rx, ry) <= tol) return s;
    } else if (s.tool === 'text') {
      const a = pts[0]!;
      const w = (s.text?.length ?? 1) * s.width * 0.6;
      if (x >= a.x - tol && x <= a.x + w + tol && y >= a.y - s.width - tol && y <= a.y + tol) return s;
    } else if (pts.length === 1) {
      if (Math.hypot(x - pts[0]!.x, y - pts[0]!.y) <= tol + (s.tool === 'marker' ? s.width : 0)) return s;
    } else {
      for (let i = 1; i < pts.length; i++) {
        if (segDist(x, y, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y) <= tol) return s;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ serialisation

/**
 * Canonical JSON (fixed key order, no whitespace): the same list always gives the same bytes, so
 * an unchanged list hashes to the blob it came from and is not uploaded twice.
 */
export function serializeStrokeList(list: StrokeList): string {
  const strokes = list.strokes.map((s) => {
    const o: Record<string, unknown> = { id: s.id, tool: s.tool, color: s.color, width: s.width, points: s.points };
    if (s.text !== undefined) o.text = s.text;
    if (s.ref !== undefined) o.ref = { kind: s.ref.kind, id: s.ref.id };
    o.at = s.at;
    return o;
  });
  return JSON.stringify({
    format: STROKES_FORMAT,
    version: STROKES_VERSION,
    space: list.space,
    width: list.width,
    height: list.height,
    strokes,
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/**
 * Reads a stroke list blob. Throws `StrokeFormatError` for a different format, a newer version or
 * a broken envelope; a single malformed stroke is dropped (with the count in `skipped`) so one bad
 * stroke never hides a whole layer.
 */
export function parseStrokeList(text: string): StrokeList & { skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StrokeFormatError('Not JSON');
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.format !== STROKES_FORMAT) throw new StrokeFormatError('Not a stroke list');
  if (o.version !== STROKES_VERSION) throw new StrokeFormatError(`Stroke list version ${String(o.version)} is not supported`);
  if (!(STROKE_SPACES as readonly unknown[]).includes(o.space)) throw new StrokeFormatError(`Unknown space ${String(o.space)}`);
  if (!isNum(o.width) || !isNum(o.height) || !Array.isArray(o.strokes)) throw new StrokeFormatError('Bad stroke list envelope');
  const strokes: Stroke[] = [];
  let skipped = 0;
  for (const s of o.strokes as Record<string, unknown>[]) {
    const ok =
      s &&
      typeof s.id === 'string' &&
      (STROKE_TOOLS as readonly unknown[]).includes(s.tool) &&
      typeof s.color === 'string' &&
      COLOR_RE.test(s.color) &&
      isNum(s.width) &&
      Array.isArray(s.points) &&
      s.points.length >= 3 &&
      s.points.length % 3 === 0 &&
      (s.points as unknown[]).every(isNum) &&
      typeof s.at === 'string' &&
      (s.tool !== 'text' || typeof s.text === 'string') &&
      (s.tool !== 'marker' || (typeof s.ref === 'object' && s.ref !== null));
    if (!ok) {
      skipped++;
      continue;
    }
    const st: Stroke = {
      id: s.id as string,
      tool: s.tool as StrokeTool,
      color: s.color as string,
      width: s.width as number,
      points: s.points as number[],
      at: s.at as string,
    };
    if (typeof s.text === 'string') st.text = s.text;
    if (s.ref && typeof s.ref === 'object') {
      const ref = s.ref as Record<string, unknown>;
      if (ref.kind === 'photo' && typeof ref.id === 'string') st.ref = { kind: 'photo', id: ref.id };
    }
    strokes.push(st);
  }
  return {
    format: STROKES_FORMAT,
    version: STROKES_VERSION,
    space: o.space as StrokeSpace,
    width: o.width,
    height: o.height,
    strokes,
    skipped,
  };
}
