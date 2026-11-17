import { describe, expect, it } from 'vitest';
import { revealOffset } from './reveal';

describe('revealOffset (T187)', () => {
  it('puts the field near the top when the content below it is long enough', () => {
    expect(revealOffset({ y: 640, margin: 12, content: 2400, view: 1100, covered: 420 })).toBe(628);
  });

  it('stops where the content ends at the keyboard top, never past it', () => {
    // 1,300 of content, 680 visible above the keyboard: the furthest useful offset is 620
    expect(revealOffset({ y: 900, margin: 12, content: 1300, view: 1100, covered: 420 })).toBe(620);
  });

  it('with no keyboard, stops at the content end', () => {
    expect(revealOffset({ y: 900, margin: 12, content: 1300, view: 1100, covered: 0 })).toBe(200);
  });

  it('never scrolls above the top or for content shorter than the view', () => {
    expect(revealOffset({ y: 4, margin: 12, content: 2400, view: 1100, covered: 420 })).toBe(0);
    expect(revealOffset({ y: 300, margin: 12, content: 500, view: 1100, covered: 0 })).toBe(0);
  });

  it('treats a keyboard taller than the view as covering all of it', () => {
    expect(revealOffset({ y: 640, margin: 12, content: 2400, view: 300, covered: 500 })).toBe(628);
  });
});
