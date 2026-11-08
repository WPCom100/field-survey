/**
 * The design tokens (D266, `docs/ui-plan.md` §3, the "Tokens and components" board). One file:
 * nothing else in `app/src` spells a hex once the makeover is through (T181 checks). Pure data, no
 * React or Expo import, so `ui/contrast.test.ts` runs it in Node.
 *
 * The status fills are the D64 hexes the pins and the floor PDF share: imported from
 * `plan/pins.ts`, never copied.
 */

import { NO_STATUS_STYLE, STATUS_STYLE } from '../plan/pins';

/** Colour. `muted` is for glyphs, dashes and dashed outlines only — never text (2.6:1). */
export const color = {
  /** Screen background. */
  bg: '#F5F6F8',
  /** Cards, the plan, the side panel. */
  surface: '#FFFFFF',
  /** Sidebar, table header rows, grey badges. */
  surface2: '#EEF0F3',
  /** Control borders. */
  border: '#D9DDE3',
  /** Row and card separators. */
  hairline: '#E6E8EC',
  /** Body text. */
  text: '#14171C',
  /** Labels, secondary text (8.0:1 on surface). */
  text2: '#4A515C',
  /** Captions, hints (4.8:1 on bg, 5.6:1 on surface). */
  text3: '#5F6875',
  /** Chevrons, "–" dashes, dashed outlines. Never text. */
  muted: '#9AA1AB',
  /** The accent: active nav, primary buttons, links, the selected ring. */
  primary: '#1F5FD6',
  primaryPressed: '#1A4EB0',
  /** Active nav background, selected chips, info banners. */
  primaryTint: '#E4ECFA',
  /** Destructive, errors, the Issue count. */
  danger: '#C62828',
  dangerTint: '#FDECEC',
  /** Offline, in review, needs attention. */
  warning: '#8A5200',
  warningTint: '#FFF4D6',
  /** Synced, saved, exported. */
  success: '#2E7D32',
  successTint: '#EEF7EE',
  /** Text on a filled primary, danger or success control. */
  onPrimary: '#FFFFFF',
} as const;

export type ColorToken = keyof typeof color;

/** The colours that carry text; `contrast.test.ts` holds each one to 4.5:1 on the three backgrounds. */
export const TEXT_COLORS = ['text', 'text2', 'text3'] as const satisfies readonly ColorToken[];
/** Semantic colours that carry text on `bg` and `surface` (links, banner titles, the Issue count). */
export const SEMANTIC_TEXT_COLORS = ['primary', 'danger', 'warning', 'success'] as const satisfies readonly ColorToken[];
/** Fills that carry white text. */
export const FILLED_COLORS = ['primary', 'primaryPressed', 'danger', 'success'] as const satisfies readonly ColorToken[];
export const BACKGROUNDS = ['bg', 'surface', 'surface2'] as const satisfies readonly ColorToken[];

/**
 * Status fills (D64): Complete · Installed, untested · Issue · Not installed (hollow) · No access ·
 * Not started, and the device with no status yet (`Unsurveyed`, D110). Read through `Swatch`.
 */
export const status = {
  style: STATUS_STYLE,
  none: NO_STATUS_STYLE,
} as const;

/** Pin rings: in review (Phase 3 §13), selected (the accent; was cyan — T177 moves `drawPins.ts` onto it). */
export const ring = {
  review: '#FF8F00',
  selected: color.primary,
} as const;

/**
 * Type: the system font at the iOS sizes. Spread into a `Text` style; weights are the three the
 * board uses (400, 600, 700 for badges).
 */
export const font = {
  /** Screen title. */
  display: { fontSize: 28, lineHeight: 34, fontWeight: '600' },
  /** Section title on a page. */
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  /** Card title, row title, level code. */
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  /** Notes, field values. */
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  /** Nav, table cells, hints. */
  callout: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  /** Buttons, chips when selected. */
  calloutBold: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  /** Labels, sub-lines, table headers. */
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  /** Field labels, column headers. */
  captionBold: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  /** Record badges. */
  badge: { fontSize: 12, lineHeight: 18, fontWeight: '700', letterSpacing: 0.24 },
  /** Pin labels and the legend only. */
  micro: { fontSize: 11, lineHeight: 13, fontWeight: '600' },
} as const;

/** Numbers are tabular: counts, times, `↑n`. */
export const tabular: { fontVariant: 'tabular-nums'[] } = { fontVariant: ['tabular-nums'] };

/** Spacing 4 · 8 · 12 · 16 · 24 · 32. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Radius 8 controls · 12 cards · pill. */
export const radius = { control: 8, card: 12, pill: 999, badge: 6, swatch: 4 } as const;

/** Hit target 44 pt; a 36- or 40-pt control gets `hitSlop` up to 44 (`hitSlopTo`). */
export const hit = { target: 44, control: 40, small: 36, chip: 40 } as const;

/** The `hitSlop` that brings a control of `height` points up to the 44-pt target (0 when it is there). */
export function hitSlopTo(height: number): number {
  return Math.max(0, Math.ceil((hit.target - height) / 2));
}

/** The card and popover shadow (iOS). */
export const shadow = {
  card: { shadowColor: color.text, shadowOpacity: 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
  toast: { shadowColor: color.text, shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
} as const;

export const tokens = { color, status, ring, font, tabular, space, radius, hit, shadow } as const;
export default tokens;
