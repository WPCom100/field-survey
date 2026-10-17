/**
 * Pin geometry and colours (D64, T112): shape = the device's **role** (its library type's, else
 * its category's — D201) through the app library's shape per role (T104), fill colour = Device Status, with a glyph as the non-colour backup
 * signal. Pure: no Skia here, so it runs in Node. Shapes are described in screen pixels centred
 * on the pin's sheet position; the viewer scales them back by 1/zoom so pins keep a constant
 * on-screen size. `pinShape` runs on the UI thread too (the overlay draws there, D95), hence its
 * `'worklet'` directive: it reads only plain data captured by value.
 */

import { DEVICE_CATEGORIES, ROLE, roleOfCategory, type Role } from '@field-survey/core';

import type { Point } from './viewport';

/** The D196 eleven (core); the picker's order. A project's `vocab(category)` may add more. */
export { DEVICE_CATEGORIES };
export type DeviceCategory = string;

/**
 * Role per category name, for a pin that only knows its category (a new-device preview, old
 * data): the master's eight and the D196 names that imply one role; a plain object so the
 * worklet can capture it by value.
 */
export const PIN_ROLE_OF_CATEGORY: Record<string, Role> = Object.fromEntries(
  [...DEVICE_CATEGORIES, 'Relay panel', 'Foundry panel', 'EBDK', 'Equipment rack', 'NSPS'].map((c) => [c, roleOfCategory(c)] as const).filter(([, r]) => r !== 'other'),
);
export const PIN_ROLES: readonly string[] = ROLE;

export const CONNECTION_STATUSES = [
  'Complete',
  'Installed, untested',
  'Issue',
  'Not installed',
  'No access',
  'Not started',
] as const;
export type PinStatus = (typeof CONNECTION_STATUSES)[number];

export type PinShape =
  | { kind: 'rect'; width: number; height: number; radius: number }
  | { kind: 'circle'; radius: number }
  | { kind: 'polygon'; points: Point[] };

/** Regular n-gon with one vertex pointing up, circumradius r. */
function regularPolygon(n: number, r: number): Point[] {
  'worklet';
  const pts: Point[] = [];
  for (let k = 0; k < n; k++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * k) / n;
    pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
  }
  return pts;
}

/** The shapes a pin can take (D64), in the default order of `ROLE`: name, glyph, label. */
export const PIN_SHAPE_NAMES = ['square', 'rounded_square', 'wide_rectangle', 'hexagon', 'pentagon', 'triangle', 'circle', 'diamond', 'octagon'] as const;
export type PinShapeName = (typeof PIN_SHAPE_NAMES)[number];
export const PIN_SHAPE_LABEL: Readonly<Record<PinShapeName, { glyph: string; label: string }>> = {
  square: { glyph: '■', label: 'Square' },
  rounded_square: { glyph: '▢', label: 'Rounded square' },
  wide_rectangle: { glyph: '▬', label: 'Wide rectangle' },
  hexagon: { glyph: '⬢', label: 'Hexagon' },
  pentagon: { glyph: '⬟', label: 'Pentagon' },
  triangle: { glyph: '▲', label: 'Triangle' },
  circle: { glyph: '●', label: 'Circle' },
  diamond: { glyph: '◆', label: 'Diamond' },
  octagon: { glyph: '⯃', label: 'Octagon' },
};

/** Role → shape (T104): a plain object so the worklet can capture it by value. */
export type PinShapeMap = Readonly<Record<string, PinShapeName>>;

/**
 * Default shape per role (D64): Relay panel ■ · Foundry panel ▢ · EBDK ▬ · Equipment rack ⬢ ·
 * NSPS ⬟ · Touchscreen ▲ · Station ● · Sensor ◆, and the octagon for `other` — a type or
 * category outside the eight never looks like one of them. The app library can move a role to
 * another shape (T104, D214; `vocab/pinShapes.ts`).
 */
export const DEFAULT_PIN_SHAPE: Readonly<Record<Role, PinShapeName>> = Object.fromEntries(ROLE.map((r, i) => [r, PIN_SHAPE_NAMES[i]!])) as Record<Role, PinShapeName>;

/**
 * Shape for a role at a given on-screen size (the square's side). The argument is a role, or a
 * category name whose role is looked up (`other` when it names none); `shapes` is the app
 * library's role → shape map (`loadPinShapes`), the defaults when absent.
 */
export function pinShape(roleOrCategory: Role | string | null, size: number, shapes?: PinShapeMap | null): PinShape {
  'worklet';
  const r = size / 2;
  const role: string = roleOrCategory == null ? 'other' : PIN_ROLES.includes(roleOrCategory) ? roleOrCategory : (PIN_ROLE_OF_CATEGORY[roleOrCategory] ?? 'other');
  const shape: PinShapeName = shapes?.[role] ?? DEFAULT_PIN_SHAPE[role as Role] ?? 'octagon';
  switch (shape) {
    case 'square':
      return { kind: 'rect', width: size, height: size, radius: 0 };
    case 'rounded_square':
      return { kind: 'rect', width: size, height: size, radius: size * 0.25 };
    case 'wide_rectangle':
      return { kind: 'rect', width: size * 1.5, height: size * 0.7, radius: 0 };
    case 'hexagon':
      return { kind: 'polygon', points: regularPolygon(6, r * 1.1) };
    case 'pentagon':
      return { kind: 'polygon', points: regularPolygon(5, r * 1.1) };
    case 'triangle':
      return { kind: 'polygon', points: regularPolygon(3, r * 1.2) };
    case 'circle':
      return { kind: 'circle', radius: r };
    case 'diamond':
      return { kind: 'polygon', points: regularPolygon(4, r * 1.2) };
    default:
      return { kind: 'polygon', points: regularPolygon(8, r * 1.05) };
  }
}

export type PinStyle = { fill: string; hollow: boolean; glyph: string };

const STYLES: Record<PinStatus, PinStyle> = {
  Complete: { fill: '#2e7d32', hollow: false, glyph: 'C' },
  'Installed, untested': { fill: '#6a1b9a', hollow: false, glyph: 'U' },
  Issue: { fill: '#c62828', hollow: false, glyph: '!' },
  'Not installed': { fill: '#c62828', hollow: true, glyph: 'NI' },
  'No access': { fill: '#f9a825', hollow: false, glyph: 'A' },
  'Not started': { fill: '#757575', hollow: false, glyph: '·' },
};

/** A device nobody has given a status yet: grey like `Not started`, with a dash. */
const NO_STATUS_STYLE: PinStyle = { fill: '#757575', hollow: false, glyph: '–' };

export function pinStyle(status: PinStatus): PinStyle {
  return STYLES[status];
}

/** Style for a stored device status, which may be null or (from old data) unknown. */
export function pinStyleFor(status: string | null): PinStyle {
  return status && status in STYLES ? STYLES[status as PinStatus] : NO_STATUS_STYLE;
}

const RANK: Record<string, number> = {
  Issue: 6,
  'Not installed': 5,
  'No access': 4,
  'Installed, untested': 2,
  Complete: 1,
  'Not started': 0,
};

/**
 * How much a status needs attention, for the colour of a cluster (its most urgent member).
 * No status ranks between `No access` and `Installed, untested`: not yet surveyed.
 */
export function statusRank(status: string | null): number {
  return status && status in RANK ? RANK[status]! : 3;
}

export type DummyPin = { id: string; category: DeviceCategory; role: Role; status: PinStatus; x: number; y: number };

/** Deterministic PRNG so every run of the spike places the same 40 pins. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` pins spread over a sheet of `width`×`height` points, cycling categories and statuses. */
export function dummyPins(count: number, width: number, height: number, seed = 6): DummyPin[] {
  const rand = mulberry32(seed);
  const pins: DummyPin[] = [];
  let stations = 0;
  let sensors = 0;
  let panels = 0;
  for (let i = 0; i < count; i++) {
    const category = DEVICE_CATEGORIES[i % DEVICE_CATEGORIES.length]!;
    const role = ROLE[i % (ROLE.length - 1)]!; // every shape in turn; `other` is left out
    const status = CONNECTION_STATUSES[i % CONNECTION_STATUSES.length]!;
    let id: string;
    if (role === 'station') id = `06M-S${++stations}`;
    else if (role === 'sensor') id = `06M-D${++sensors}`;
    else id = `06M-${String(++panels).padStart(2, '0')}`;
    pins.push({
      id,
      category,
      role,
      status,
      x: Math.round(width * (0.05 + 0.9 * rand())),
      y: Math.round(height * (0.05 + 0.9 * rand())),
    });
  }
  return pins;
}

/** Nearest pin within `radius` sheet units of `p`, or null. */
export function nearestPin<T extends Point>(pins: readonly T[], p: Point, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius;
  for (const pin of pins) {
    const d = Math.hypot(pin.x - p.x, pin.y - p.y);
    if (d <= bestD) {
      best = pin;
      bestD = d;
    }
  }
  return best;
}
