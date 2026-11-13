import { LIBRARY_STREAM } from '@field-survey/core';
import { describe, expect, it } from 'vitest';

import { projectDataKey, syncDataKey } from './dataKey';

describe('syncDataKey', () => {
  it('changes only when a project cursor moves, whatever the key order', () => {
    const a = syncDataKey({ lastServerSeq: { p2: 4, p1: 10 } });
    expect(a).toBe(syncDataKey({ lastServerSeq: { p1: 10, p2: 4 } }));
    expect(syncDataKey({ lastServerSeq: { p1: 11, p2: 4 } })).not.toBe(a);
    expect(syncDataKey({ lastServerSeq: { p1: 10, p2: 4, p3: 0 } })).not.toBe(a);
    expect(syncDataKey({ lastServerSeq: {} })).toBe('');
  });
});

describe('projectDataKey (T185)', () => {
  const base = { p1: 10, p2: 4, [LIBRARY_STREAM]: 7 };
  const key = projectDataKey({ lastServerSeq: base }, 'p1');

  it("ignores another project's pulls", () => {
    expect(projectDataKey({ lastServerSeq: { ...base, p2: 1849 } }, 'p1')).toBe(key);
    expect(projectDataKey({ lastServerSeq: { ...base, p3: 300 } }, 'p1')).toBe(key);
  });

  it("moves with the project's own cursor and the library's", () => {
    expect(projectDataKey({ lastServerSeq: { ...base, p1: 11 } }, 'p1')).not.toBe(key);
    expect(projectDataKey({ lastServerSeq: { ...base, [LIBRARY_STREAM]: 8 } }, 'p1')).not.toBe(key);
  });

  it('falls back to every cursor while the project is not known', () => {
    expect(projectDataKey({ lastServerSeq: base }, null)).toBe(syncDataKey({ lastServerSeq: base }));
  });
});
