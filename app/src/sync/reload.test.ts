import { describe, expect, it } from 'vitest';

import { Reloader } from './reload';

/** A load that resolves when the test says so. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Reloader (T185)', () => {
  it('applies a load that finishes after newer data arrived, then loads once more', async () => {
    const shown: string[] = [];
    const r = new Reloader<string>((v) => shown.push(v), () => {});
    const loads = [deferred<string>(), deferred<string>()];
    let started = 0;
    const load = () => loads[started++]!.promise;

    r.request(load); // the screen opens
    r.request(load); // a pull lands while the first load waits in the store's queue
    r.request(load); // and another: the two coalesce into one follow-up
    expect(started).toBe(1);

    loads[0]!.resolve('before the pulls');
    await flush();
    expect(shown).toEqual(['before the pulls']); // not discarded: newer than nothing on screen
    expect(started).toBe(2);

    loads[1]!.resolve('after the pulls');
    await flush();
    expect(shown).toEqual(['before the pulls', 'after the pulls']);
    expect(started).toBe(2);
  });

  it('keeps showing progress when data arrives faster than a load takes', async () => {
    const shown: number[] = [];
    const r = new Reloader<number>((v) => shown.push(v), () => {});
    const pending: Array<ReturnType<typeof deferred<number>>> = [];
    const load = () => {
      const d = deferred<number>();
      pending.push(d);
      return d.promise;
    };
    r.request(load);
    for (let i = 0; i < 5; i++) {
      r.request(load); // the key changes again before the load in progress ends
      pending[pending.length - 1]!.resolve(i);
      await flush();
    }
    expect(shown).toEqual([0, 1, 2, 3, 4]); // every load applied; the old pattern showed none
  });

  it('drops a load of the old subject, and the new subject loads at once', async () => {
    const shown: string[] = [];
    const r = new Reloader<string>((v) => shown.push(v), () => {});
    const a = deferred<string>();
    const b = deferred<string>();
    r.request(() => a.promise); // device A's card
    r.reset(); // the user opened device B
    r.request(() => b.promise);
    b.resolve('B');
    await flush();
    a.resolve('A');
    await flush();
    expect(shown).toEqual(['B']);
  });

  it('applies nothing after close, and reports a failure of the current subject only', async () => {
    const shown: string[] = [];
    const errors: unknown[] = [];
    const r = new Reloader<string>((v) => shown.push(v), (e) => errors.push(e));
    const a = deferred<string>();
    r.request(() => a.promise);
    r.reset(); // unmounted
    a.reject(new Error('old'));
    await flush();
    expect(errors).toEqual([]);

    const b = deferred<string>();
    r.request(() => b.promise);
    b.reject(new Error('now'));
    await flush();
    expect(errors.map((e) => (e as Error).message)).toEqual(['now']);

    const c = deferred<string>();
    r.request(() => c.promise); // a failure does not stop later reloads
    c.resolve('ok');
    await flush();
    expect(shown).toEqual(['ok']);
  });

  it('times each applied load', async () => {
    const times: number[] = [];
    const r = new Reloader<string>(() => {}, () => {}, (ms) => times.push(ms));
    r.request(async () => 'x');
    await flush();
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(0);
  });
});
