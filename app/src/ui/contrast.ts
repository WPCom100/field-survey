/**
 * WCAG 2 contrast arithmetic over `#rrggbb` hexes (pure; `contrast.test.ts` holds the tokens to
 * it, `Swatch` picks a dark or light glyph with it).
 */

/** The sRGB channel values of a `#rgb` or `#rrggbb` hex, 0–255. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether text in `fg` on `bg` meets WCAG AA for normal text (4.5:1). */
export function readable(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 4.5;
}

/** Glyph colour for text drawn over `fill`: dark on a light fill (No access yellow), white otherwise. */
export function onFill(fill: string, dark: string, light: string): string {
  return contrastRatio(fill, light) >= contrastRatio(fill, dark) ? light : dark;
}
