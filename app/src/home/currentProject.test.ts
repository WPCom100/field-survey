import { describe, expect, it } from 'vitest';

import { pickProject, rememberProject } from './currentProject';

describe('pickProject (T83)', () => {
  it('falls back to the first project before the home has shown one', () => {
    expect(pickProject(['a', 'b'])).toBe('a');
    expect(pickProject([])).toBeNull();
  });

  it('uses the remembered project, and a known route param over it', () => {
    rememberProject('b');
    expect(pickProject(['a', 'b'])).toBe('b');
    expect(pickProject(['a', 'b'], 'a')).toBe('a');
    expect(pickProject(['a', 'b'], 'gone')).toBe('b');
    rememberProject(null);
    expect(pickProject(['a', 'b'])).toBe('b');
    expect(pickProject(['a', 'c'])).toBe('a');
  });
});
