/**
 * Grid calibration and Drawing Position (T45, PLAN §7.4, D47) — the client side of the plan
 * text pass. Pure functions over `sheet.grid_sets` and `sheet.features` as the server's plans
 * job writes them (`server/app/jobs/plan_analysis.py`, `server/docs/plans.md`); no React, no
 * DB, so this runs in Node tests and on the iPad alike.
 *
 * A **grid set** is a frame fitted to a sheet's grid bubbles: `affine` maps sheet coordinates
 * (CropBox top-left origin, y down, PDF points) to `(s, t)` — `s` across the column lines, east
 * positive; `t` across the row lines, south positive — and `col_labels` / `row_labels` hold each
 * bubble label's position on that axis in sheet order (west → east, north → south). Several sets
 * per sheet (the 06M composite has three: Centennial, Walter Tower, a wing rotated 22°).
 *
 * `drawingPosition(sets, point)` gives the master's wording: `Grid B-C / 9-8`, `Grid E / 7.5`,
 * `Grid East of H / 9-8`, `WT Grid C.-D. / 6.-5.` (prefix per set). `manualGridSet(taps)` is the
 * iPad's three-tap fallback: two bubbles of one axis and one of the other, uniform spacing
 * assumed, mode `manual`. `drawing_position` in the Python module is the twin of the first;
 * both are tested against the same 06M sets (`testing/grid-06m.json`).
 */

export type GridLabel = { label: string; pos: number };
export type GridAffine = { a: number; b: number; c: number; d: number; tx: number; ty: number };
export type GridBubble = { label: string; axis: 'col' | 'row'; x: number; y: number };
export type GridMode = 'auto' | 'manual' | 'none';

export type GridSet = {
  name: string;
  /** Leads the Drawing Position text ("WT" → "WT Grid …"), D47. */
  prefix: string;
  mode: GridMode;
  /** RMS distance (pt) of the bubbles from their grid lines; `auto` below 2 pt. */
  residual: number;
  max_residual?: number;
  /** Rotation of the column axis on the sheet, degrees (0 = columns run north–south). */
  angle?: number;
  affine: GridAffine;
  col_labels: GridLabel[];
  row_labels: GridLabel[];
  /** The bubbles the fit used (drawn on the plan while calibrating). */
  bubbles?: GridBubble[];
};

export type SheetRoom = { code: string; name: string | null; x: number; y: number };
export type SheetTag = { text: string; x: number; y: number; size?: number };
export type SheetBubble = { text: string; x: number; y: number };
export type SheetBoundary = { points: [number, number][] };
export type SheetLabel = { text: string; x: number; y: number };

/** `sheet.features` (D147): the rest of the text pass. */
export type SheetFeatures = {
  rooms: SheetRoom[];
  tags: SheetTag[];
  /** Ringed labels no set claimed — what the manual calibration snaps a tap to. */
  bubbles: SheetBubble[];
  /** Source-sheet boundaries from the composite's optional-content group (D100). */
  boundaries: SheetBoundary[];
  boundary_labels: SheetLabel[];
};

export const EMPTY_FEATURES: SheetFeatures = { rooms: [], tags: [], bubbles: [], boundaries: [], boundary_labels: [] };

export type Point = { x: number; y: number };

export const AUTO_RESIDUAL_PT = 2;
/** A pin within this fraction of the local spacing of a grid line is "on" it ("Grid E / 7.5"). */
export const ON_LINE_FRACTION = 0.08;
/** How far beyond its last bubble a set still claims a pin ("East of H"), in spacings. */
export const MARGIN_SPACINGS = 1.5;
/** A tap this close (sheet pt) to a known bubble takes its label. */
export const SNAP_PT = 30;

// ------------------------------------------------------------------ parsing

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseLabels(v: unknown): GridLabel[] {
  if (!Array.isArray(v)) return [];
  const out: GridLabel[] = [];
  for (const l of v) {
    const r = (l ?? {}) as Record<string, unknown>;
    const label = str(r.label);
    const pos = num(r.pos);
    if (label !== null && pos !== null) out.push({ label, pos });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** Read a stored `grid_sets` value defensively: malformed sets are dropped, never thrown. */
export function parseGridSets(raw: unknown): GridSet[] {
  const list = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(list)) return [];
  const out: GridSet[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const a = (r.affine ?? {}) as Record<string, unknown>;
    const affine = { a: num(a.a), b: num(a.b), c: num(a.c), d: num(a.d), tx: num(a.tx) ?? 0, ty: num(a.ty) ?? 0 };
    if (affine.a === null || affine.b === null || affine.c === null || affine.d === null) continue;
    const mode = r.mode === 'auto' || r.mode === 'manual' ? r.mode : 'none';
    const bubbles = Array.isArray(r.bubbles)
      ? (r.bubbles as unknown[]).flatMap((b) => {
          const q = (b ?? {}) as Record<string, unknown>;
          const label = str(q.label);
          const x = num(q.x);
          const y = num(q.y);
          return label !== null && x !== null && y !== null ? [{ label, axis: q.axis === 'row' ? ('row' as const) : ('col' as const), x, y }] : [];
        })
      : [];
    out.push({
      name: str(r.name) ?? 'Grid',
      prefix: str(r.prefix) ?? '',
      mode,
      residual: num(r.residual) ?? 0,
      ...(num(r.max_residual) !== null ? { max_residual: num(r.max_residual)! } : {}),
      ...(num(r.angle) !== null ? { angle: num(r.angle)! } : {}),
      affine: affine as GridAffine,
      col_labels: parseLabels(r.col_labels),
      row_labels: parseLabels(r.row_labels),
      bubbles,
    });
  }
  return out;
}

export function parseSheetFeatures(raw: unknown): SheetFeatures {
  const r = ((typeof raw === 'string' ? safeJson(raw) : raw) ?? {}) as Record<string, unknown>;
  const pts = (v: unknown): SheetBoundary[] =>
    Array.isArray(v)
      ? v.flatMap((b) => {
          const q = (b ?? {}) as Record<string, unknown>;
          const points = Array.isArray(q.points)
            ? (q.points as unknown[]).flatMap((p) => (Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null ? [[p[0], p[1]] as [number, number]] : []))
            : [];
          return points.length >= 2 ? [{ points }] : [];
        })
      : [];
  const named = <T extends { x: number; y: number }>(v: unknown, make: (q: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((i) => make((i ?? {}) as Record<string, unknown>) ?? []) : [];
  return {
    rooms: named(r.rooms, (q) => (str(q.code) !== null && num(q.x) !== null && num(q.y) !== null ? { code: str(q.code)!, name: str(q.name), x: num(q.x)!, y: num(q.y)! } : null)),
    tags: named(r.tags, (q) => (str(q.text) !== null && num(q.x) !== null && num(q.y) !== null ? { text: str(q.text)!, x: num(q.x)!, y: num(q.y)!, ...(num(q.size) !== null ? { size: num(q.size)! } : {}) } : null)),
    bubbles: named(r.bubbles, (q) => (str(q.text) !== null && num(q.x) !== null && num(q.y) !== null ? { text: str(q.text)!, x: num(q.x)!, y: num(q.y)! } : null)),
    boundaries: pts(r.boundaries),
    boundary_labels: named(r.boundary_labels, (q) => (str(q.text) !== null && num(q.x) !== null && num(q.y) !== null ? { text: str(q.text)!, x: num(q.x)!, y: num(q.y)! } : null)),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- Drawing Position

/** Sheet point → the set's frame (s across the columns, t across the rows). */
export function frameOf(gs: GridSet, p: Point): { s: number; t: number } {
  const a = gs.affine;
  return { s: a.a * p.x + a.c * p.y + a.tx, t: a.b * p.x + a.d * p.y + a.ty };
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function spacingOf(labels: GridLabel[]): number {
  const gaps = labels.slice(1).map((l, i) => l.pos - labels[i]!.pos);
  return gaps.length ? median(gaps) : 100;
}

function axisText(labels: GridLabel[], v: number, before: string, beyond: string): string | null {
  if (!labels.length) return null;
  const pos = labels.map((l) => l.pos);
  const gaps = pos.slice(1).map((p, i) => p - pos[i]!);
  const spacing = gaps.length ? median(gaps) : 0;
  const tol = (gap: number) => Math.max(2, ON_LINE_FRACTION * gap);
  if (v < pos[0]! - tol(spacing)) return `${before} ${labels[0]!.label}`;
  if (v > pos[pos.length - 1]! + tol(spacing)) return `${beyond} ${labels[labels.length - 1]!.label}`;
  for (let i = 0; i < pos.length; i++) {
    const around = [i > 0 ? gaps[i - 1]! : null, i < gaps.length ? gaps[i]! : null].filter((g): g is number => g !== null);
    const local = around.length ? Math.min(...around) : spacing;
    if (Math.abs(v - pos[i]!) <= tol(local)) return labels[i]!.label;
  }
  for (let i = 0; i < pos.length - 1; i++) {
    if (pos[i]! < v && v < pos[i + 1]!) return `${labels[i]!.label}-${labels[i + 1]!.label}`;
  }
  return null;
}

/**
 * The set whose grid (plus a margin of `MARGIN_SPACINGS`) holds the point; where two grids
 * overlap (the towers' sheets do) the one the point sits deeper in; else the nearest set within a
 * further two spacings; else null.
 */
export function chooseGridSet(sets: readonly GridSet[], p: Point): number | null {
  let best: { d: number; depth: number; i: number } | null = null;
  sets.forEach((gs, i) => {
    if (gs.mode === 'none' || !gs.col_labels.length || !gs.row_labels.length) return;
    const { s, t } = frameOf(gs, p);
    const sp = spacingOf(gs.col_labels);
    const tp = spacingOf(gs.row_labels);
    const s0 = gs.col_labels[0]!.pos;
    const s1 = gs.col_labels[gs.col_labels.length - 1]!.pos;
    const t0 = gs.row_labels[0]!.pos;
    const t1 = gs.row_labels[gs.row_labels.length - 1]!.pos;
    const ds = Math.max(s0 - MARGIN_SPACINGS * sp - s, s - (s1 + MARGIN_SPACINGS * sp), 0) / sp;
    const dt = Math.max(t0 - MARGIN_SPACINGS * tp - t, t - (t1 + MARGIN_SPACINGS * tp), 0) / tp;
    const d = Math.max(ds, dt);
    if (d > 2) return;
    const depth = Math.min(s - s0, s1 - s, t - t0, t1 - t) / Math.max(sp, tp);
    if (!best || d < best.d || (d === best.d && depth > best.depth)) best = { d, depth, i };
  });
  return best ? (best as { i: number }).i : null;
}

/** The master's Drawing Position wording for a sheet point, or null when no set claims it. */
export function drawingPosition(sets: readonly GridSet[], p: Point): string | null {
  const i = chooseGridSet(sets, p);
  if (i === null) return null;
  const gs = sets[i]!;
  const { s, t } = frameOf(gs, p);
  const cols = axisText(gs.col_labels, s, 'West of', 'East of');
  const rows = axisText(gs.row_labels, t, 'North of', 'South of');
  if (cols === null || rows === null) return null;
  const prefix = gs.prefix.trim();
  return `${prefix ? `${prefix} ` : ''}Grid ${cols} / ${rows}`;
}

/** One line for the Sources table: "auto ✓ 3 sets", "manual ✓ 1 set", "needs calibration", "no grid". */
export function gridSummary(sets: readonly GridSet[]): string {
  if (!sets.length) return 'no grid found';
  const usable = sets.filter((s) => s.mode !== 'none');
  if (!usable.length) return `needs calibration (residual ${Math.max(...sets.map((s) => s.residual)).toFixed(1)} pt)`;
  const mode = usable.every((s) => s.mode === 'auto') ? 'auto' : usable.every((s) => s.mode === 'manual') ? 'manual' : 'auto + manual';
  const n = usable.length;
  return `${mode} ✓ ${n} set${n === 1 ? '' : 's'}${usable.length < sets.length ? `, ${sets.length - usable.length} to calibrate` : ''}`;
}

// ------------------------------------------------------------------- rooms

/** The room code printed nearest the point, within `maxDist` sheet points. */
export function nearestRoom(features: SheetFeatures, p: Point, maxDist = 250): SheetRoom | null {
  let best: { d: number; room: SheetRoom } | null = null;
  for (const room of features.rooms) {
    const d = Math.hypot(room.x - p.x, room.y - p.y);
    if (d <= maxDist && (!best || d < best.d)) best = { d, room };
  }
  return best?.room ?? null;
}

/** "Stair A Vestibule XX06M-2SV01" — the master's Room / Location style. */
export function roomText(room: SheetRoom): string {
  return room.name ? `${room.name} ${room.code}` : room.code;
}

// ---------------------------------------------------------- manual fallback

const LABEL_RE = /^([A-Z](?:\.\d)?|([A-Z])\2|\d{1,2}(?:\.\d)?)(\.)?$/;

/** `alpha` for lettered labels (columns, usually), `num` for numbered ones, null for neither. */
export function labelKind(text: string): 'alpha' | 'num' | null {
  const m = LABEL_RE.exec(text.trim().toUpperCase());
  if (!m) return null;
  return /^[A-Z]/.test(m[1]!) ? 'alpha' : 'num';
}

/** `A`=1 … `Z`=26, `AA`=27, `G.9`=7.9, `13.5`=13.5 — the natural order of a label. */
export function labelKey(text: string): number | null {
  const m = LABEL_RE.exec(text.trim().toUpperCase());
  if (!m) return null;
  const core = m[1]!;
  if (/^[A-Z]/.test(core)) {
    const [letters, frac] = core.split('.');
    let n = 0;
    for (const ch of letters!) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n + (frac ? Number(frac) / 10 : 0);
  }
  return Number(core);
}

function letterLabel(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The labels between two printed labels, inclusive, consecutive letters or whole numbers; the
 * dotted style (`C.`) is kept. Returns null when the two are not of one kind. */
export function labelSequence(from: string, to: string): string[] | null {
  const kf = labelKind(from);
  const kt = labelKind(to);
  if (!kf || kf !== kt) return null;
  const dot = /\.$/.test(from.trim()) && /\.$/.test(to.trim()) ? '.' : '';
  const a = labelKey(from)!;
  const b = labelKey(to)!;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return [from.trim(), to.trim()];
  const step = a <= b ? 1 : -1;
  const out: string[] = [];
  for (let k = a; step > 0 ? k <= b : k >= b; k += step) out.push((kf === 'alpha' ? letterLabel(k) : String(k)) + dot);
  return out;
}

export type GridTap = { x: number; y: number; label: string };

/**
 * A grid set from three (or four) tapped bubbles with their labels (PLAN §7.4 "tap 3 bubbles"):
 * two of one axis fix its direction, spacing and labels; one of the other fixes its origin, the
 * spacing is taken from the first axis (a second tap on that axis fixes it); the grid is taken
 * as orthogonal and evenly spaced, hence `manual`. Throws on taps that cannot make a grid.
 */
export function manualGridSet(taps: readonly GridTap[], opts: { name?: string; prefix?: string } = {}): GridSet {
  const kinds = taps.map((t) => labelKind(t.label));
  if (taps.length < 3 || taps.length > 4) throw new Error('Tap three bubbles: two of one axis and one of the other.');
  if (kinds.some((k) => k === null)) throw new Error(`"${taps[kinds.indexOf(null)]!.label}" is not a grid label.`);
  const alpha = taps.filter((_, i) => kinds[i] === 'alpha');
  const nums = taps.filter((_, i) => kinds[i] === 'num');
  if (!alpha.length || !nums.length) throw new Error('Tap bubbles of both axes: letters and numbers.');
  const [cols, rows] = [alpha, nums];
  const two = cols.length >= 2 ? cols : rows;
  const one = two === cols ? rows : cols;
  if (two.length < 2) throw new Error('Tap two bubbles of one axis.');
  const [p, q] = [two[0]!, two[1]!];
  const kp = labelKey(p.label)!;
  const kq = labelKey(q.label)!;
  if (kp === kq) throw new Error('Tap two different bubbles of the same axis.');
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) throw new Error('Those two taps are at the same spot.');
  // the axis the two taps belong to: positions measured along the line through them
  let nTwo = { x: dx / len, y: dy / len };
  const colAxis = two === cols;
  const flip = colAxis ? (Math.abs(nTwo.x) >= 0.1 ? nTwo.x < 0 : nTwo.y < 0) : Math.abs(nTwo.y) >= 0.1 ? nTwo.y < 0 : nTwo.x < 0;
  if (flip) nTwo = { x: -nTwo.x, y: -nTwo.y };
  let nOne = { x: -nTwo.y, y: nTwo.x }; // perpendicular, then oriented like the other axis
  const flipOne = colAxis ? (Math.abs(nOne.y) >= 0.1 ? nOne.y < 0 : nOne.x < 0) : Math.abs(nOne.x) >= 0.1 ? nOne.x < 0 : nOne.y < 0;
  if (flipOne) nOne = { x: -nOne.x, y: -nOne.y };
  const along = (n: Point, t: Point) => n.x * t.x + n.y * t.y;

  const seq = labelSequence(p.label, q.label);
  if (!seq) throw new Error('Those two labels are not of one kind.');
  const posP = along(nTwo, p);
  const posQ = along(nTwo, q);
  const perLabel = (posQ - posP) / (seq.length - 1 || 1);
  const twoLabels: GridLabel[] = seq.map((label, i) => ({ label, pos: posP + i * perLabel })).sort((a, b) => a.pos - b.pos);
  const spacingTwo = Math.abs(perLabel);

  const o = one[0]!;
  const oneLabels: GridLabel[] = [];
  if (one.length >= 2) {
    const o2 = one[1]!;
    const s2 = labelSequence(o.label, o2.label);
    if (!s2 || labelKey(o.label) === labelKey(o2.label)) throw new Error('Tap two different bubbles of the same axis.');
    const a = along(nOne, o);
    const b = along(nOne, o2);
    const per = (b - a) / (s2.length - 1 || 1);
    s2.forEach((label, i) => oneLabels.push({ label, pos: a + i * per }));
  } else {
    // one bubble: its line, and neighbours at the other axis's spacing in the natural order
    // that runs with the axis (east / south positive)
    const k = labelKey(o.label)!;
    const kind = labelKind(o.label)!;
    const dot = /\.$/.test(o.label.trim()) ? '.' : '';
    const ascending = (() => {
      // numbers usually grow northward on a plan (rows "9-8" read north → south), letters eastward
      if (kind === 'alpha') return true;
      return false;
    })();
    const a = along(nOne, o);
    for (let i = -3; i <= 3; i++) {
      const kk = ascending ? k + i : k - i;
      if (kk < 1 || !Number.isInteger(kk)) continue;
      oneLabels.push({ label: (kind === 'alpha' ? letterLabel(kk) : String(kk)) + dot, pos: a + i * spacingTwo });
    }
  }
  oneLabels.sort((a, b) => a.pos - b.pos);

  const nCol = colAxis ? nTwo : nOne;
  const nRow = colAxis ? nOne : nTwo;
  const colLabels = colAxis ? twoLabels : oneLabels;
  const rowLabels = colAxis ? oneLabels : twoLabels;
  const angle = (Math.atan2(nCol.y, nCol.x) * 180) / Math.PI;
  return {
    name: opts.name ?? `${colLabels[0]!.label}–${colLabels[colLabels.length - 1]!.label} / ${rowLabels[0]!.label}–${rowLabels[rowLabels.length - 1]!.label}`,
    prefix: opts.prefix ?? '',
    mode: 'manual',
    residual: 0,
    angle: Math.round(angle * 100) / 100,
    affine: { a: nCol.x, c: nCol.y, tx: 0, b: nRow.x, d: nRow.y, ty: 0 },
    col_labels: colLabels,
    row_labels: rowLabels,
    bubbles: taps.map((t) => ({ label: t.label, axis: labelKind(t.label) === 'alpha' ? 'col' : 'row', x: t.x, y: t.y })),
  };
}

/** The printed label nearest a tap, from the sets' bubbles and the loose ones, within `SNAP_PT`. */
export function snapLabel(sets: readonly GridSet[], features: SheetFeatures, p: Point): string | null {
  let best: { d: number; label: string } | null = null;
  const consider = (x: number, y: number, label: string) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d <= SNAP_PT && (!best || d < best.d)) best = { d, label };
  };
  for (const gs of sets) for (const b of gs.bubbles ?? []) consider(b.x, b.y, b.label);
  for (const b of features.bubbles) consider(b.x, b.y, b.text);
  return best ? (best as { label: string }).label : null;
}

export type GridPreviewMark = {
  label: string;
  axis: 'col' | 'row';
  x: number;
  y: number;
  /** A printed bubble of that label sits on the predicted line; false = no printed bubble found,
   * the ring is drawn where the taps say it should be. */
  printed: boolean;
};

/** A printed bubble is on a predicted grid line within this fraction of the spacing. */
export const PREVIEW_FRACTION = 0.2;

const norm = (label: string) => label.trim().toUpperCase();

/**
 * What a manual calibration in progress would claim (T96): as soon as two taps of one axis fix it,
 * every label that axis gets between and beyond the tapped ones (B … G between A and H; the
 * neighbours of a lone tap once the set can be built), placed on the printed bubble of that label
 * whose position along the axis matches, else at the spot the taps predict. The tapped labels are
 * left out (the taps are drawn already). Never throws: taps that cannot make an axis preview
 * nothing.
 */
export function manualGridPreview(taps: readonly GridTap[], features: SheetFeatures): GridPreviewMark[] {
  const of = (kind: 'alpha' | 'num') => taps.filter((t) => labelKind(t.label) === kind);
  type Axis = { axis: 'col' | 'row'; labels: GridLabel[]; n: Point; anchor: GridTap; tapped: GridTap[] };
  const axes: Axis[] = [];
  let gs: GridSet | null = null;
  try {
    gs = taps.length >= 3 ? manualGridSet(taps) : null;
  } catch {
    gs = null;
  }
  if (gs) {
    const nCol = { x: gs.affine.a, y: gs.affine.c };
    const nRow = { x: gs.affine.b, y: gs.affine.d };
    axes.push({ axis: 'col', labels: gs.col_labels, n: nCol, anchor: of('alpha')[0]!, tapped: of('alpha') });
    axes.push({ axis: 'row', labels: gs.row_labels, n: nRow, anchor: of('num')[0]!, tapped: of('num') });
  } else {
    // one axis fixed by two taps, the other not yet: that axis alone
    for (const [kind, axis] of [['alpha', 'col'], ['num', 'row']] as const) {
      const mine = of(kind);
      if (mine.length < 2) continue;
      const [p, q] = [mine[0]!, mine[1]!];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const seq = labelSequence(p.label, q.label);
      if (len < 1 || !seq || labelKey(p.label) === labelKey(q.label)) continue;
      const n = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
      const start = n.x * p.x + n.y * p.y;
      const per = len / (seq.length - 1 || 1);
      axes.push({ axis, labels: seq.map((label, i) => ({ label, pos: start + i * per })), n, anchor: p, tapped: mine });
    }
  }

  const out: GridPreviewMark[] = [];
  for (const { axis, labels, n, anchor, tapped } of axes) {
    const along = (p: Point) => n.x * p.x + n.y * p.y;
    const tol = PREVIEW_FRACTION * spacingOf(labels);
    const done = new Set(tapped.map((t) => norm(t.label)));
    const a0 = along(anchor);
    for (const l of labels) {
      if (done.has(norm(l.label))) continue;
      const printed = features.bubbles.filter((b) => norm(b.text) === norm(l.label) && Math.abs(along(b) - l.pos) <= tol);
      if (printed.length) for (const b of printed) out.push({ label: l.label, axis, x: b.x, y: b.y, printed: true });
      else out.push({ label: l.label, axis, x: anchor.x + (l.pos - a0) * n.x, y: anchor.y + (l.pos - a0) * n.y, printed: false });
    }
  }
  return out;
}
