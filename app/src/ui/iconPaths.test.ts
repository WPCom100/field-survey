import { describe, expect, it } from 'vitest';

import { ICON_NAMES, ICON_PATHS } from './iconPaths';

describe('icon path data (T176)', () => {
  it('every sub-path after the first starts with an absolute M', () => {
    // A relative `m` mid-string moves from where the last sub-path ended: the board's separate
    // `<path d="m3 13 …">` lands off the 24-unit grid once joined into one string.
    for (const name of ICON_NAMES) expect(ICON_PATHS[name].slice(1), name).not.toMatch(/m/);
  });

  it('every coordinate stays on the 24-unit grid (absolute commands)', () => {
    for (const name of ICON_NAMES) {
      for (const m of ICON_PATHS[name].matchAll(/M\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
        const x = Number(m[1]);
        const y = Number(m[2]);
        expect(x >= 0 && x <= 24 && y >= 0 && y <= 24, `${name}: M${x} ${y}`).toBe(true);
      }
    }
  });

  it('the sidebar has an icon per entry', () => {
    for (const n of ['levels', 'review', 'cable', 'dashboard', 'rulings', 'lint', 'export', 'setup', 'vocabulary', 'library', 'sync'] as const) {
      expect(ICON_PATHS[n]).toBeTruthy();
    }
  });
});
