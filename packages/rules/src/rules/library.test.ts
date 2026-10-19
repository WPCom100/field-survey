/** `findDeviceType` over an indexed map (T131): the same answers as the scan it replaced. */

import { describe, expect, it } from 'vitest';

import { findDeviceType, type TypeLike } from './library';

type T = TypeLike & { n: number };

const type = (id: string, model: string, p: Partial<T> = {}): T => ({ id, project_id: null, model, aliases: null, state: 'accepted', n: 0, ...p });

describe('findDeviceType (T131: indexed by model key)', () => {
  it('matches by id, by model or alias ignoring case and spaces, the project\'s type before the app library\'s, never a rejected one', () => {
    const app = type('t-app', 'ERP-FT-241P', { aliases: ['CT06LCPA', 'Echo Relay Panel'] });
    const own = type('t-own', 'erp-ft-241p', { project_id: 'p1' });
    const rejected = type('t-rej', 'UFMP4', { state: 'rejected' });
    const draft = type('t-draft', 'UFMP 4', { state: 'draft' });
    const types = new Map([app, own, rejected, draft].map((t) => [t.id, t] as const));
    expect(findDeviceType(types, { library_type_id: 't-app', device: 'anything' })).toBe(app);
    expect(findDeviceType(types, { library_type_id: 'gone', device: 'ERP-FT-241P' })).toBeNull();
    expect(findDeviceType(types, { library_type_id: null, device: 'ERP-FT-241P' })).toBe(own);
    expect(findDeviceType(types, { library_type_id: null, device: 'ct06lcpa' })).toBe(app);
    expect(findDeviceType(types, { library_type_id: null, device: 'echo relay panel' })).toBe(app);
    expect(findDeviceType(types, { library_type_id: null, device: 'UFMP4' })).toBe(draft);
    expect(findDeviceType(types, { library_type_id: null, device: 'Nothing' })).toBeNull();
    expect(findDeviceType(types, { library_type_id: null, device: null })).toBeNull();
  });

  it('indexes a map once and re-indexes one that grew', () => {
    const types = new Map<string, T>();
    types.set('a', type('a', 'PI1002'));
    expect(findDeviceType(types, { library_type_id: null, device: 'PI1002' })?.id).toBe('a');
    types.set('b', type('b', 'PI1004', { aliases: ['Inspire 4'] }));
    expect(findDeviceType(types, { library_type_id: null, device: 'inspire4' })?.id).toBe('b');
    expect(findDeviceType(types, { library_type_id: null, device: 'PI1002' })?.id).toBe('a');
  });

  it('a lookup over a catalogue-size map costs the same as over a small one', () => {
    const big = new Map<string, T>();
    for (let i = 0; i < 1200; i++) big.set(`t${i}`, type(`t${i}`, `MODEL-${i}`, { aliases: [`Alias ${i}`, `7180A${i}-5`, `7180A${i}-4`] }));
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) expect(findDeviceType(big, { library_type_id: null, device: `alias ${i % 1200}` })?.id).toBe(`t${i % 1200}`);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
