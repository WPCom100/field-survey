/**
 * One screen's reloads of one subject (T185, D277). A screen reloads when a pull brings data
 * (`syncDataKey`), the rules ran (`useRulesVersion`) or it edited something. The old pattern
 * (an effect that drops the load in progress whenever its key changes) never showed anything
 * while the store was busy: a seed copy's first minutes change the key every few seconds, a
 * load that waits in the store's one queue behind the rules and the pulls takes longer than
 * that, and every run was thrown away — Lint stuck on "Loading…", a dismiss or a status tap not
 * shown (T185).
 *
 * Here a reload asked for while one runs does not discard it: the running load applies its
 * result (newer than what is on screen), then exactly one more load runs for everything asked
 * meanwhile. Only a change of subject (another device, project or filter) or closing drops a
 * result, because it no longer describes what the screen shows. No React here (tested in Node);
 * `useReload` wraps it for screens.
 */
export class Reloader<T> {
  /** Bumped on a subject change or close: a load started before it is dropped. */
  private gen = 0;
  private running = false;
  private queued: (() => Promise<T>) | null = null;

  constructor(
    private readonly apply: (value: T) => void,
    private readonly fail: (e: unknown) => void,
    /** Told after each load that applied, with its wall time (the slow-load log line). */
    private readonly settled?: (ms: number) => void,
  ) {}

  /** Load now, or once the load in progress has applied (requests meanwhile coalesce into one). */
  request(load: () => Promise<T>): void {
    this.queued = load;
    if (!this.running) void this.drain();
  }

  /** A new subject, or the screen closed: drop what is loading and anything queued. */
  reset(): void {
    this.gen++;
    this.running = false;
    this.queued = null;
  }

  private async drain(): Promise<void> {
    const gen = this.gen;
    this.running = true;
    while (this.queued && gen === this.gen) {
      const load = this.queued;
      this.queued = null;
      const t0 = Date.now();
      try {
        const value = await load();
        if (gen !== this.gen) return;
        this.apply(value);
        this.settled?.(Date.now() - t0);
      } catch (e) {
        if (gen !== this.gen) return;
        this.fail(e);
      }
    }
    if (gen === this.gen) this.running = false;
  }
}
