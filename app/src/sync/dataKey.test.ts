import { describe, expect, it } from 'vitest';

import { syncDataKey } from './dataKey';

describe('syncDataKey', () => {
  it('changes only when a project cursor moves, whatever the key order', () => {
    const a = syncDataKey({ lastServerSeq: { p2: 4, p1: 10 } });
    expect(a).toBe(syncDataKey({ lastServerSeq: { p1: 10, p2: 4 } }));
    expect(syncDataKey({ lastServerSeq: { p1: 11, p2: 4 } })).not.toBe(a);
    expect(syncDataKey({ lastServerSeq: { p1: 10, p2: 4, p3: 0 } })).not.toBe(a);
    expect(syncDataKey({ lastServerSeq: {} })).toBe('');
  });
});
