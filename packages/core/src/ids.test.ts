import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 ids', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]!);
  });

  it('sorts by creation order, also within one millisecond', () => {
    const t = 1_760_000_000_000;
    const ids = Array.from({ length: 50 }, () => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    const stamp = parseInt(ids[0]!.slice(0, 8) + ids[0]!.slice(9, 13), 16);
    expect(stamp).toBeGreaterThanOrEqual(t);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('never goes backwards when the clock does', () => {
    const a = uuidv7(2_000_000_000_000);
    const b = uuidv7(1_000_000_000_000);
    expect(b > a).toBe(true);
  });

  it('uses the injected random source', () => {
    const id = uuidv7(0, (n) => new Uint8Array(n));
    expect(id.endsWith('-8000-000000000000')).toBe(true);
  });
});
