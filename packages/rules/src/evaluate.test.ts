import { expect, it } from 'vitest';
import { evaluate } from './index.js';

it('returns no proposals or findings for an empty snapshot', () => {
  expect(evaluate({})).toEqual({ proposals: [], findings: [] });
});
