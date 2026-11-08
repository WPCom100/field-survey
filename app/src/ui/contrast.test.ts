import { describe, expect, it } from 'vitest';

import { pinStyleFor } from '../plan/pins';
import { contrastRatio, luminance, onFill, readable, rgb } from './contrast';
import { BACKGROUNDS, FILLED_COLORS, SEMANTIC_TEXT_COLORS, TEXT_COLORS, color, hitSlopTo, status } from './tokens';

describe('contrast arithmetic', () => {
  it('reads hexes and the two reference ratios', () => {
    expect(rgb('#1F5FD6')).toEqual([31, 95, 214]);
    expect(rgb('#fff')).toEqual([255, 255, 255]);
    expect(() => rgb('#12')).toThrow();
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 6);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 6);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('tokens (D266 (2), docs/ui-plan.md §3)', () => {
  it.each(TEXT_COLORS)('%s reads at 4.5:1 or better on bg, surface and surface2', (t) => {
    for (const b of BACKGROUNDS) {
      const ratio = contrastRatio(color[t], color[b]);
      expect(ratio, `${t} on ${b}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the board’s two quoted ratios hold: text2 8.0:1 on surface, text3 4.8:1 on bg', () => {
    expect(contrastRatio(color.text2, color.surface)).toBeCloseTo(8.0, 0);
    expect(contrastRatio(color.text3, color.bg)).toBeCloseTo(4.8, 0);
  });

  it.each(SEMANTIC_TEXT_COLORS)('%s carries text on bg and surface (links, banner titles)', (t) => {
    expect(readable(color[t], color.bg), `${t} on bg`).toBe(true);
    expect(readable(color[t], color.surface), `${t} on surface`).toBe(true);
  });

  it.each(FILLED_COLORS)('white reads on a %s fill', (t) => {
    expect(readable(color.onPrimary, color[t])).toBe(true);
  });

  it('every tone reads on its own tint, and text on every tint', () => {
    for (const [tone, tint] of [
      [color.primary, color.primaryTint],
      [color.danger, color.dangerTint],
      [color.warning, color.warningTint],
      [color.success, color.successTint],
    ] as const) {
      expect(readable(tone, tint), `${tone} on ${tint}`).toBe(true);
      expect(readable(color.text, tint), `text on ${tint}`).toBe(true);
    }
  });

  it('muted is glyph-only: it does not reach 4.5:1 as text on any background', () => {
    for (const b of BACKGROUNDS) expect(readable(color.muted, color[b])).toBe(false);
  });

  it('status fills are the pins’ (D64), imported not copied', () => {
    expect(status.style.Complete).toBe(pinStyleFor('Complete'));
    expect(status.style['Not installed'].hollow).toBe(true);
    expect(status.none).toBe(pinStyleFor(null));
    expect(status.none.glyph).toBe('–');
  });

  it('a swatch glyph is dark on the No access yellow and white on the other fills', () => {
    const glyphOn = (fill: string) => onFill(fill, color.text, color.onPrimary);
    expect(glyphOn(status.style['No access'].fill)).toBe(color.text);
    for (const s of ['Complete', 'Installed, untested', 'Issue', 'Not started'] as const) {
      expect(glyphOn(status.style[s].fill), s).toBe(color.onPrimary);
    }
    expect(glyphOn(status.none.fill)).toBe(color.onPrimary);
  });

  it('hitSlopTo brings 36- and 40-pt controls to 44 and leaves 44 alone', () => {
    expect(hitSlopTo(36)).toBe(4);
    expect(hitSlopTo(40)).toBe(2);
    expect(hitSlopTo(44)).toBe(0);
    expect(hitSlopTo(52)).toBe(0);
  });
});
