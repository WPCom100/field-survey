import { describe, expect, it } from 'vitest';

import { EMPTY_FILTER, activeFilterGroups } from './filters';
import { levelCaption } from './toolbar';

describe('the plan toolbar (T177)', () => {
  it('the line under the code names the level and counts its devices', () => {
    expect(levelCaption('06M', 23)).toBe('Level 6 mezzanine · 23 devices');
    expect(levelCaption('B2', 1)).toBe('Basement 2 · 1 device');
    expect(levelCaption('01', 0)).toBe('Level 1 · 0 devices');
    expect(levelCaption('Roof', 4)).toBe('4 devices');
  });

  it('the Filter count is the number of groups in use, not of values picked', () => {
    expect(activeFilterGroups(EMPTY_FILTER)).toBe(0);
    expect(activeFilterGroups({ ...EMPTY_FILTER, categories: ['Station', 'Sensor'] })).toBe(1);
    expect(activeFilterGroups({ ...EMPTY_FILTER, statuses: ['Issue'], owners: ['EC'] })).toBe(2);
    expect(activeFilterGroups({ categories: ['Station'], statuses: ['none'], owners: ['ETC'], openPunch: true })).toBe(4);
  });
});
