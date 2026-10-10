/**
 * Client sync engine (T11, PLAN §3.2 "Pull" / "Push", D86).
 *
 * One cycle per project: push the outbox in `client_ts` order in batches of at most 500 ops
 * (a `group_id` is never split across batches), sending `since` = the pull cursor as of the
 * push (D84); acknowledge every result; apply the server ops the push caused; then pull every
 * page since the cursor, materialising other installs' ops, recording reviewed ones and
 * marking local pending ops the server will review ("will be reviewed").
 *
 * Nothing here ever blocks an edit: `Store.apply` is independent of the engine, and with no
 * transport (no server/token yet) a cycle simply reports `no_token`. Failures back off
 * exponentially (5 s … 5 min); a foreground `requestSync()` resets the backoff and tries at
 * once. The engine is runtime-neutral: timers and the transport are injected.
 */

import type { Op, StoredOp } from './op';
import type { PushAck, RemoteResult, Store } from './store';

// ------------------------------------------------------------------ transport

export interface PushBody {
  project_id: string;
  since: number | null;
  ops: Op[];
}

export interface PushResponse {
  results: PushAck[];
  server_ops: Op[];
  server_seq: number;
}

export interface PullResponse {
  ops: Op[];
  server_seq: number;
  has_more: boolean;
}

/** `POST /ops` and `GET /ops` (server/docs/sync.md). Throws `TransportError`. */
export interface SyncTransport {
  push(body: PushBody): Promise<PushResponse>;
  pull(projectId: string, since: number, limit: number): Promise<PullResponse>;
}

export type TransportFailure =
  /** No connection: offline, DNS, timeout. Retried silently. */
  | 'network'
  /** 401: wrong or missing token. */
  | 'auth'
  /** 409/422/4xx: the server refused the batch; retrying the same data will not help. */
  | 'rejected'
  /** 5xx or anything else. */
  | 'server';

export class TransportError extends Error {
  constructor(
    readonly failure: TransportFailure,
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

// --------------------------------------------------------------------- status

export type SyncState =
  /** Nothing in flight; last cycle succeeded (or nothing has run yet). */
  | 'idle'
  | 'syncing'
  /** The last cycle could not reach the server; retrying with backoff. */
  | 'offline'
  /** The server answered with an error (see `lastError`); retrying with backoff. */
  | 'error'
  /** No server or token configured: edits are kept locally until there is one. */
  | 'no_token';

export interface SyncStatus {
  state: SyncState;
  /** Ops waiting in the outbox, all projects. */
  pendingOps: number;
  /** Local pending ops the server will put in review once pushed. */
  willReview: number;
  /** End of the last fully successful cycle (ISO 8601). */
  lastSyncAt: string | null;
  /** Pull cursor per project (`last_server_seq:<project_id>`). */
  lastServerSeq: Record<string, number>;
  lastError: string | null;
  /** Consecutive failed cycles. */
  failures: number;
  /** Earliest time the next automatic attempt will run (ISO 8601), null when none is due. */
  nextAttemptAt: string | null;
}

/** A local pending op the server will review (PLAN §3.2 pull: "will be reviewed"). */
export interface ReviewMark {
  op_id: string;
  entity_kind: string;
  entity_id: string;
  field: string | null;
  /** Why: a pulled op on the same field, or the push result said so. */
  source: 'pull' | 'push';
}

export interface SyncReport {
  /** `ran`: a cycle completed; `skipped`: backoff not elapsed or already running. */
  outcome: 'ran' | 'skipped' | 'failed' | 'no_token';
  pushed: number;
  pulled: number;
  /** Projects synced. */
  projects: string[];
  error?: string;
}

// -------------------------------------------------------------------- options

export type SyncLog = (
  level: 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
) => void;

export interface SyncEngineOptions {
  /** Projects to pull; default: local `project` rows plus anything in the outbox. */
  projects?: () => Promise<string[]>;
  /** Ops per push, ≤ 500 (PLAN §3.2). */
  batchSize?: number;
  /** Ops per pull page, ≤ 500. */
  pullLimit?: number;
  /** Periodic sync interval while started. */
  intervalMs?: number;
  /** First retry delay after a failure; doubles each time up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: SyncLog;
}

const MAX_BATCH = 500;

function defaultLog(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const line = `[sync] ${event}${data ? ' ' + JSON.stringify(data) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function marksKey(projectId: string): string {
  return `will_review:${projectId}`;
}

function cursorKey(projectId: string): string {
  return `last_server_seq:${projectId}`;
}

// --------------------------------------------------------------------- engine

export class SyncEngine {
  private transport: SyncTransport | null;
  private readonly opts: Required<Omit<SyncEngineOptions, 'projects'>> & {
    projects: () => Promise<string[]>;
  };
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private current: SyncStatus = {
    state: 'idle',
    pendingOps: 0,
    willReview: 0,
    lastSyncAt: null,
    lastServerSeq: {},
    lastError: null,
    failures: 0,
    nextAttemptAt: null,
  };
  private running: Promise<SyncReport> | null = null;
  private timer: unknown = null;
  private started = false;
  private nextAttemptMs = 0;

  constructor(
    readonly store: Store,
    transport: SyncTransport | null,
    opts: SyncEngineOptions = {},
  ) {
    this.transport = transport;
    this.opts = {
      projects: opts.projects ?? (() => this.defaultProjects()),
      batchSize: Math.max(1, Math.min(opts.batchSize ?? MAX_BATCH, MAX_BATCH)),
      pullLimit: Math.max(1, Math.min(opts.pullLimit ?? MAX_BATCH, MAX_BATCH)),
      intervalMs: opts.intervalMs ?? 60_000,
      backoffMs: opts.backoffMs ?? 5_000,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      now: opts.now ?? (() => Date.now()),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      log: opts.log ?? defaultLog,
    };
    if (!transport) this.current = { ...this.current, state: 'no_token' };
  }

  // ------------------------------------------------------------------ status

  status(): SyncStatus {
    return this.current;
  }

  /** Subscribe to status changes; returns the unsubscribe function. Called at once with the current status. */
  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Refresh the counts (outbox, marks, cursors) from the store without syncing. */
  async refresh(): Promise<SyncStatus> {
    const pendingOps = await this.store.outboxCount();
    const projects = await this.opts.projects();
    const lastServerSeq: Record<string, number> = {};
    let willReview = 0;
    for (const p of projects) {
      lastServerSeq[p] = await this.cursor(p);
      willReview += Object.keys(await this.marks(p)).length;
    }
    this.set({ pendingOps, willReview, lastServerSeq });
    return this.current;
  }

  /** Local pending ops the server will review, for the "will be reviewed" badge. */
  async willBeReviewed(projectId: string): Promise<ReviewMark[]> {
    return Object.values(await this.marks(projectId));
  }

  /** Swap the server connection (sign-in, token change). Null = no server yet. */
  setTransport(transport: SyncTransport | null): void {
    this.transport = transport;
    this.nextAttemptMs = 0;
    this.set({
      state: transport ? (this.current.state === 'no_token' ? 'idle' : this.current.state) : 'no_token',
      failures: 0,
      nextAttemptAt: null,
    });
  }

  // --------------------------------------------------------------- scheduling

  /** Run on an interval (`intervalMs`) until `stop()`. The first cycle runs at once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer != null) {
      this.opts.clearTimer(this.timer);
      this.timer = null;
    }
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Foreground / user tap: forget the backoff and sync now. */
  requestSync(): Promise<SyncReport> {
    this.nextAttemptMs = 0;
    return this.sync();
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    await this.sync();
    if (!this.started) return;
    // Next run: the interval, or the backoff if that comes later.
    const wait = Math.max(this.opts.intervalMs, this.nextAttemptMs - this.opts.now());
    this.timer = this.opts.setTimer(() => void this.tick(), wait);
  }

  // -------------------------------------------------------------------- cycle

  /** One cycle for every project. Concurrent calls share the running cycle. */
  sync(): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<SyncReport> {
    const transport = this.transport;
    if (!transport) {
      await this.refresh();
      this.set({ state: 'no_token' });
      return { outcome: 'no_token', pushed: 0, pulled: 0, projects: [] };
    }
    if (this.opts.now() < this.nextAttemptMs) {
      return { outcome: 'skipped', pushed: 0, pulled: 0, projects: [] };
    }
    this.set({ state: 'syncing' });
    const projects = await this.opts.projects();
    let pushed = 0;
    let pulled = 0;
    let failure: TransportError | Error | null = null;
    for (const project of projects) {
      try {
        pushed += await this.push(transport, project);
      } catch (e) {
        failure = e as Error;
        this.opts.log('warn', 'push_failed', { project, error: String(failure.message) });
        // No connection: the pull would fail the same way. Any other refusal (409, 422, 5xx)
        // still lets the pull go ahead so the iPad keeps receiving others' edits.
        if (e instanceof TransportError && e.failure === 'network') break;
      }
      try {
        pulled += await this.pull(transport, project);
      } catch (e) {
        failure = e as Error;
        this.opts.log('warn', 'pull_failed', { project, error: String(failure.message) });
        if (e instanceof TransportError && e.failure === 'network') break;
      }
    }
    await this.refresh();
    if (failure) {
      const failures = this.current.failures + 1;
      const delay = Math.min(this.opts.backoffMs * 2 ** (failures - 1), this.opts.maxBackoffMs);
      this.nextAttemptMs = this.opts.now() + delay;
      const offline = failure instanceof TransportError && failure.failure === 'network';
      this.set({
        state: offline ? 'offline' : 'error',
        failures,
        lastError: failure.message,
        nextAttemptAt: new Date(this.nextAttemptMs).toISOString(),
      });
      return { outcome: 'failed', pushed, pulled, projects, error: failure.message };
    }
    this.nextAttemptMs = 0;
    this.set({
      state: 'idle',
      failures: 0,
      lastError: null,
      nextAttemptAt: null,
      lastSyncAt: new Date(this.opts.now()).toISOString(),
    });
    this.opts.log('info', 'synced', { projects: projects.length, pushed, pulled });
    return { outcome: 'ran', pushed, pulled, projects };
  }

  // --------------------------------------------------------------------- push

  /** Drain the project's outbox; returns the number of ops the server answered for. */
  private async push(transport: SyncTransport, project: string): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.nextBatch(project);
      if (batch.length === 0) return total;
      const since = await this.cursor(project);
      let res: PushResponse;
      try {
        res = await transport.push({ project_id: project, since, ops: batch.map(wire) });
      } catch (e) {
        await this.store.noteOutboxFailure(
          batch.map((o) => o.op_id),
          e instanceof Error ? e.message : String(e),
        );
        throw e;
      }
      await this.store.acknowledgeMany(res.results);
      await this.markFromPush(project, batch, res.results);
      total += res.results.length;
      if (res.server_ops.length) await this.applyIncoming(project, res.server_ops);
      // Every op was answered and left the outbox, so the loop always advances; a server that
      // answers for nothing (should not happen) must not spin.
      if (res.results.length === 0) {
        throw new TransportError('server', 'push answered with no results');
      }
    }
  }

  /** The next ≤ batchSize outbox ops in client_ts order, never splitting a group. */
  private async nextBatch(project: string): Promise<StoredOp[]> {
    const size = this.opts.batchSize;
    const ops = await this.store.outbox(project, size + 1);
    if (ops.length <= size) return ops;
    const last = ops[size - 1]!;
    const next = ops[size]!;
    let cut = size;
    if (last.group_id != null && next.group_id === last.group_id) {
      while (cut > 0 && ops[cut - 1]!.group_id === last.group_id) cut--;
      if (cut === 0) {
        // A group longer than a batch: send it split; the server reviews the halves apart.
        this.opts.log('warn', 'group_exceeds_batch', { project, group_id: last.group_id });
        cut = size;
      }
    }
    return ops.slice(0, cut);
  }

  // --------------------------------------------------------------------- pull

  /** Page through everything after the cursor; returns the number of ops received. */
  private async pull(transport: SyncTransport, project: string): Promise<number> {
    let total = 0;
    for (;;) {
      const since = await this.cursor(project);
      const page = await transport.pull(project, since, this.opts.pullLimit);
      if (page.ops.length) {
        await this.applyIncoming(project, page.ops);
        total += page.ops.length;
        const last = page.ops[page.ops.length - 1]!.server_seq ?? since;
        await this.store.setState(cursorKey(project), Math.max(since, last));
      } else if (page.server_seq > since && !page.has_more) {
        // Nothing between the cursor and the top (cannot happen with a gap-free log, but a
        // stale cursor must not pin us): catch up.
        await this.store.setState(cursorKey(project), page.server_seq);
      }
      if (!page.has_more) return total;
    }
  }

  private async applyIncoming(project: string, ops: Op[]): Promise<void> {
    const results = await this.store.applyRemoteMany(ops);
    await this.markFromPull(project, ops, results);
    for (let i = 0; i < ops.length; i++) {
      if (results[i]!.outcome === 'orphan') {
        const op = ops[i]!;
        this.opts.log('warn', 'orphan', {
          op_id: op.op_id,
          kind: op.kind,
          entity_kind: op.entity_kind,
          entity_id: op.entity_id,
        });
      }
    }
  }

  // -------------------------------------------------------------------- marks

  private async marks(project: string): Promise<Record<string, ReviewMark>> {
    return (await this.store.getState<Record<string, ReviewMark>>(marksKey(project))) ?? {};
  }

  /** Pulled ops that collide with local pending ops mark those as "will be reviewed". */
  private async markFromPull(project: string, ops: Op[], results: RemoteResult[]): Promise<void> {
    const marks = await this.marks(project);
    let changed = false;
    for (let i = 0; i < ops.length; i++) {
      for (const pending of results[i]!.collided_pending) {
        if (marks[pending]) continue;
        const local = await this.store.getOp(pending);
        if (!local || local.state !== 'pending') continue;
        marks[pending] = {
          op_id: pending,
          entity_kind: local.entity_kind,
          entity_id: local.entity_id,
          field: local.field,
          source: 'pull',
        };
        changed = true;
      }
    }
    if (changed) await this.store.setState(marksKey(project), marks);
  }

  /** Push results clear the marks of acknowledged ops; a `review` outcome is final (T26). */
  private async markFromPush(project: string, batch: StoredOp[], acks: PushAck[]): Promise<void> {
    const marks = await this.marks(project);
    let changed = false;
    const byId = new Map(batch.map((o) => [o.op_id, o]));
    for (const ack of acks) {
      if (marks[ack.op_id]) {
        delete marks[ack.op_id];
        changed = true;
      }
      if (ack.outcome === 'review') {
        const op = byId.get(ack.op_id);
        this.opts.log('info', 'in_review', {
          op_id: ack.op_id,
          entity_kind: op?.entity_kind,
          entity_id: op?.entity_id,
          field: op?.field,
          review_item_id: ack.review_item_id,
        });
      }
    }
    if (changed) await this.store.setState(marksKey(project), marks);
  }

  // ------------------------------------------------------------------ helpers

  private async cursor(project: string): Promise<number> {
    return (await this.store.getState<number>(cursorKey(project))) ?? 0;
  }

  private async defaultProjects(): Promise<string[]> {
    const rows = await this.store.list<{ id: string }>('project', { includeDeleted: true });
    const ids = new Set(rows.map((r) => r.id));
    for (const p of await this.store.outboxProjects()) ids.add(p);
    return [...ids].sort();
  }

  private set(patch: Partial<SyncStatus>): void {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l(this.current);
  }
}

/** The op as the server wants it: no local-only state. */
function wire(op: StoredOp): Op {
  const out: Op = { ...op };
  delete out.server_seq;
  delete out.server_ts;
  delete out.state;
  return out;
}
