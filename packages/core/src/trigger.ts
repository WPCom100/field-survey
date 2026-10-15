/**
 * Debounced "the data changed" trigger (T33): the rule engine runs after a committed local edit
 * and after a pull, once things have gone quiet for `delayMs`, never on every keystroke or on
 * every op of a 500-op pull page. The store announces each applied transaction
 * (`Store.onChange`); this collects the project ids and fires once per burst.
 *
 * Changes that touch only `proposal` / `finding` rows are the engine's own output and do not
 * re-trigger it (a run that writes nothing new ends the cycle anyway; this just saves a pass).
 */

import type { EntityKind } from './schema/entities';
import type { Store, StoreChange } from './store';

export interface TriggerOptions {
  /** Quiet time before firing; default 500 ms. */
  delayMs?: number;
  /** Entity kinds whose changes never fire the trigger; default `proposal`, `finding`. */
  ignoreKinds?: readonly EntityKind[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type TriggerHandler = (projectIds: string[], sources: Set<StoreChange['source']>) => Promise<void> | void;

export class DebouncedTrigger {
  private readonly delayMs: number;
  private readonly ignore: Set<string>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private handler: TriggerHandler | null = null;
  private off: (() => void) | null = null;
  private timer: unknown = null;
  private pending = new Set<string>();
  private sources = new Set<StoreChange['source']>();
  private running: Promise<void> | null = null;
  private rerun = false;
  /** How many times the handler has fired (tests, the Sync screen). */
  fired = 0;

  constructor(
    readonly store: Store,
    opts: TriggerOptions = {},
  ) {
    this.delayMs = opts.delayMs ?? 500;
    this.ignore = new Set(opts.ignoreKinds ?? ['proposal', 'finding']);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Start watching; returns the stop function. Only one handler at a time. */
  start(handler: TriggerHandler): () => void {
    this.stop();
    this.handler = handler;
    this.off = this.store.onChange((c) => this.note(c));
    return () => this.stop();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.handler = null;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Ask for a run of these projects as if they had changed (start-up, a manual "Run rules"). */
  request(projectIds: readonly string[], source: StoreChange['source'] = 'local'): void {
    for (const p of projectIds) this.pending.add(p);
    this.sources.add(source);
    this.arm();
  }

  /** Fire now if anything is pending, and wait for the handler (tests). */
  async flush(): Promise<void> {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pending.size) await this.fire();
    else if (this.running) await this.running;
  }

  private note(c: StoreChange): void {
    if (c.kinds.every((k) => this.ignore.has(k))) return;
    for (const p of c.projectIds) this.pending.add(p);
    this.sources.add(c.source);
    this.arm();
  }

  private arm(): void {
    if (!this.handler) return;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.fire();
    }, this.delayMs);
  }

  private async fire(): Promise<void> {
    if (this.running) {
      // A change landed during a run: run once more when it ends (its snapshot may be stale).
      this.rerun = true;
      await this.running;
      return;
    }
    const handler = this.handler;
    if (!handler) return;
    const projects = [...this.pending];
    const sources = new Set(this.sources);
    this.pending.clear();
    this.sources.clear();
    this.fired++;
    this.running = (async () => {
      try {
        await handler(projects, sources);
      } catch {
        // the handler logs its own failures; a trigger must never throw into the store
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
    if (this.rerun || this.pending.size) {
      this.rerun = false;
      await this.fire();
    }
  }
}
