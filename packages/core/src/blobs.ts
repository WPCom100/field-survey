/**
 * Blob transfers (T12, PLAN §3.4, D87): photo and sheet bytes follow their records.
 *
 * Uploads: `addLocal()` registers bytes already in the app sandbox (a captured JPEG, its 320-px
 * thumbnail, a markup stroke list, a setup sheet) and queues them. A run sends **thumbnails
 * first**, then markup/ink, then full-size images, then sheets; each blob is declared to the
 * server, sent in the server's chunk size (2 MB) and completed with a hash check. Progress lives
 * in SQLite and on the server, never only in memory: after the app is killed the next run asks
 * the server which chunks it holds (`POST /blobs/{sha}` answers with them) and sends only the
 * rest. Rows left `active` by a kill are put back in the queue at the start of every run.
 *
 * Downloads: thumbnails of photos and the display sheets of the levels assigned to the current
 * user are prefetched; full-size images (and anything else) are fetched on demand with
 * `ensureLocal()`. Downloaded bytes are a cache with an LRU budget; bytes that have not reached
 * the server yet are never evicted.
 *
 * Runtime-neutral like the sync engine: the transport (HTTP + native upload tasks on the iPad),
 * the sandbox file operations, timers and the clock are injected. Nothing here blocks an edit.
 */

import { errorCode } from './http';
import type { Store } from './store';
import { TransportError } from './sync';
import { BLOB_KIND } from './vocab';

// ------------------------------------------------------------------ contracts

export type BlobKind = (typeof BLOB_KIND)[number];

/** The server's view of a blob (`BlobOut`, server/docs/blobs.md). */
export interface RemoteBlob {
  sha256: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
  upload_state: 'partial' | 'complete' | 'local';
  chunk_size: number;
  chunks_total: number;
  chunks_received: number[];
}

export interface BlobMeta {
  size: number;
  mime: string;
  width?: number | null;
  height?: number | null;
}

/** A byte range of a local file: what one chunk upload sends. */
export interface ChunkSource {
  path: string;
  offset: number;
  length: number;
}

/** `/blobs` routes (PLAN §8). Throws `TransportError` like `SyncTransport`. */
export interface BlobTransport {
  /** `POST /blobs/{sha}`: start or resume; idempotent; answers with the chunks already held. */
  declare(sha256: string, meta: BlobMeta): Promise<RemoteBlob>;
  /** `GET /blobs/{sha}`; null when the server has never heard of it. */
  status(sha256: string): Promise<RemoteBlob | null>;
  /** `PUT /blobs/{sha}/chunks/{n}` with the bytes of `source`. */
  putChunk(sha256: string, n: number, source: ChunkSource): Promise<void>;
  /** `POST /blobs/{sha}/complete`: assemble + hash check. 409 missing_chunks, 422 hash_mismatch. */
  complete(sha256: string): Promise<RemoteBlob>;
  /**
   * `GET /blobs/{sha}/content` into `destPath` (overwriting). A `TransportError` with status 404
   * means "not uploaded yet". Must not leave a partial file at `destPath` on failure.
   */
  download(sha256: string, destPath: string): Promise<{ size: number; mime: string | null }>;
}

/**
 * The app sandbox, as far as the queue needs it. Paths are opaque to the queue and stored as
 * given: the iPad uses paths relative to its Documents folder, because iOS moves the app
 * container on every update and an absolute path in SQLite would dangle.
 */
export interface BlobFiles {
  /** Where the bytes of `sha256` live (or will be downloaded to). */
  pathFor(sha256: string, kind: BlobKind): string;
  exists(path: string): Promise<boolean>;
  /** Delete; a missing file is not an error. */
  remove(path: string): Promise<void>;
}

/** Thrown inside an upload when retrying cannot help (missing file, bytes ≠ hash). */
export class BlobUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobUploadError';
  }
}

// ---------------------------------------------------------------------- status

export type BlobQueueState = 'idle' | 'running' | 'offline' | 'error' | 'no_token';

export interface BlobQueueStatus {
  state: BlobQueueState;
  /** Photos (not deleted) whose image, thumbnail or markup has not reached the server. */
  photosWaiting: number;
  /** Blobs queued for upload (all kinds), and their bytes. */
  uploadsPending: number;
  uploadBytesPending: number;
  /** Uploads that cannot succeed as they are (file missing, bytes ≠ hash); see the queue rows. */
  uploadsFailed: number;
  downloadsPending: number;
  /** Bytes of local files the queue knows about (cache + not-yet-uploaded). */
  cacheBytes: number;
  lastRunAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
}

export interface BlobReport {
  outcome: 'ran' | 'skipped' | 'failed' | 'no_token';
  uploaded: number;
  downloaded: number;
  evicted: number;
  error?: string;
}

export type BlobLog = (
  level: 'info' | 'warn' | 'error',
  event: string,
  data?: Record<string, unknown>,
) => void;

export interface BlobQueueOptions {
  /** The signed-in user, whose assigned levels are prefetched; null = prefetch nothing. */
  userId?: () => string | null;
  /** Cache budget for local files (bytes); default 3 GiB. Un-uploaded bytes do not count against eviction. */
  cacheBudgetBytes?: number;
  /** A blob used more recently than this is never evicted (it may be on screen). Default 10 min. */
  evictGraceMs?: number;
  /** Parallel downloads; default 4. */
  downloadConcurrency?: number;
  intervalMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Retry delay for a download the server does not have yet (its author has not uploaded it). */
  notFoundRetryMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: BlobLog;
}

/** Upload order: thumbnails first (PLAN §3.4), then small strokes, full images, sheets. */
export const UPLOAD_PRIORITY: Record<BlobKind, number> = {
  thumb: 0,
  markup: 1,
  ink: 1,
  image: 2,
  sheet: 3,
  export: 4,
};

/** Download order: a plan cannot open without its sheet, then thumbnails. */
export const DOWNLOAD_PRIORITY: Record<BlobKind, number> = {
  sheet: 0,
  thumb: 1,
  markup: 2,
  ink: 2,
  image: 3,
  export: 4,
};

/** Used when the server does not say (content-type missing). */
export const DEFAULT_MIME: Record<BlobKind, string> = {
  thumb: 'image/jpeg',
  image: 'image/jpeg',
  markup: 'application/json',
  ink: 'application/json',
  sheet: 'application/pdf',
  export: 'application/octet-stream',
};

/** Evicted first: full-size bytes that can be fetched again on demand. */
const EVICT_FIRST = new Set<string>(['image', 'export']);

const SHA_RE = /^[0-9a-f]{64}$/;
const GIB = 1024 * 1024 * 1024;

interface QueueRow {
  sha256: string;
  direction: 'upload' | 'download';
  kind: BlobKind;
  priority: number;
  state: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

interface BlobRow {
  sha256: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
  upload_state: string;
  chunks_received: string;
  local_path: string | null;
  last_used_at: string | null;
  kind: BlobKind | null;
}

function defaultLog(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) {
  const line = `[blobs] ${event}${data ? ' ' + JSON.stringify(data) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function isNetwork(e: unknown): boolean {
  return e instanceof TransportError && (e.failure === 'network' || e.failure === 'auth');
}

// ----------------------------------------------------------------------- queue

export class BlobQueue {
  private transport: BlobTransport | null;
  private readonly opts: Required<BlobQueueOptions>;
  private readonly listeners = new Set<(s: BlobQueueStatus) => void>();
  private current: BlobQueueStatus = {
    state: 'idle',
    photosWaiting: 0,
    uploadsPending: 0,
    uploadBytesPending: 0,
    uploadsFailed: 0,
    downloadsPending: 0,
    cacheBytes: 0,
    lastRunAt: null,
    lastError: null,
    failures: 0,
    nextAttemptAt: null,
  };
  private running: Promise<BlobReport> | null = null;
  private rerun = false;
  private timer: unknown = null;
  private started = false;
  private nextAttemptMs = 0;
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    readonly store: Store,
    transport: BlobTransport | null,
    readonly files: BlobFiles,
    opts: BlobQueueOptions = {},
  ) {
    this.transport = transport;
    this.opts = {
      userId: opts.userId ?? (() => null),
      cacheBudgetBytes: opts.cacheBudgetBytes ?? 3 * GIB,
      evictGraceMs: opts.evictGraceMs ?? 10 * 60_000,
      downloadConcurrency: Math.max(1, opts.downloadConcurrency ?? 4),
      intervalMs: opts.intervalMs ?? 60_000,
      backoffMs: opts.backoffMs ?? 5_000,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      notFoundRetryMs: Math.max(1000, opts.notFoundRetryMs ?? 120_000),
      now: opts.now ?? (() => Date.now()),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      log: opts.log ?? defaultLog,
    };
    if (!transport) this.current = { ...this.current, state: 'no_token' };
  }

  private get db() {
    return this.store.db;
  }

  private iso(ms = this.opts.now()): string {
    return new Date(ms).toISOString();
  }

  // -------------------------------------------------------------- capture side

  /**
   * Register bytes already written to `path` in the sandbox and queue their upload. Idempotent:
   * the same sha registered twice is one blob and one upload. Never touches the network.
   */
  async addLocal(input: {
    sha256: string;
    kind: BlobKind;
    path: string;
    size: number;
    mime: string;
    width?: number | null;
    height?: number | null;
  }): Promise<void> {
    if (!SHA_RE.test(input.sha256)) throw new Error(`Bad sha256 ${input.sha256}`);
    if (!(BLOB_KIND as readonly string[]).includes(input.kind)) throw new Error(`Bad blob kind ${input.kind}`);
    const now = this.iso();
    await this.db.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO blob (sha256, size, mime, width, height, upload_state, chunks_received, created_at, local_path, last_used_at, kind)
         VALUES (?, ?, ?, ?, ?, 'local', '[]', ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET local_path = excluded.local_path,
           last_used_at = excluded.last_used_at, kind = coalesce(blob.kind, excluded.kind)`,
        [
          input.sha256,
          input.size,
          input.mime,
          input.width ?? null,
          input.height ?? null,
          now,
          input.path,
          now,
          input.kind,
        ],
      );
      const rows = await tx.query<{ upload_state: string }>(
        `SELECT upload_state FROM blob WHERE sha256 = ?`,
        [input.sha256],
      );
      if (rows[0]?.upload_state === 'complete') return; // the server already has these bytes
      await tx.exec(
        `INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at)
         VALUES (?, 'upload', ?, ?, 'queued', 0, ?)
         ON CONFLICT(sha256, direction) DO UPDATE SET state = 'queued', next_attempt_at = NULL
           WHERE blob_queue.state IN ('done', 'failed')`,
        [input.sha256, input.kind, UPLOAD_PRIORITY[input.kind], now],
      );
    });
    await this.refresh();
    this.kick();
  }

  // ------------------------------------------------------------- reading side

  /** Path of the cached bytes, or null. `touch` marks it used for the LRU. */
  async localPath(sha256: string, opts: { touch?: boolean } = {}): Promise<string | null> {
    const b = await this.blob(sha256);
    if (!b?.local_path) return null;
    if (!(await this.files.exists(b.local_path))) {
      await this.forget(sha256);
      return null;
    }
    if (opts.touch !== false) await this.touch(sha256);
    return b.local_path;
  }

  /**
   * The bytes on demand (full-size photos, PLAN §3.4): the cached file, or a download now.
   * Null when offline, not uploaded yet, or there is no server; never throws for those.
   */
  ensureLocal(sha256: string, kind: BlobKind): Promise<string | null> {
    const pending = this.inflight.get(sha256);
    if (pending) return pending;
    const p = this.fetchNow(sha256, kind).finally(() => this.inflight.delete(sha256));
    this.inflight.set(sha256, p);
    return p;
  }

  private async fetchNow(sha256: string, kind: BlobKind): Promise<string | null> {
    const cached = await this.localPath(sha256);
    if (cached) return cached;
    const transport = this.transport;
    if (!transport) return null;
    try {
      const path = await this.downloadOne(transport, sha256, kind);
      await this.evict();
      await this.refresh();
      return path;
    } catch (e) {
      this.opts.log('warn', 'on_demand_failed', { sha256, kind, error: String((e as Error).message) });
      return null;
    }
  }

  /** "N photos waiting" (Phase 3 status bar): photos whose bytes have not all reached the server. */
  async photosWaiting(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM photo p WHERE p.deleted_at IS NULL AND EXISTS (
         SELECT 1 FROM blob b WHERE b.sha256 IN (p.image_blob, p.thumb_blob, p.markup_blob)
           AND b.upload_state <> 'complete')`,
    );
    return rows[0]?.n ?? 0;
  }

  // -------------------------------------------------------------------- status

  status(): BlobQueueStatus {
    return this.current;
  }

  subscribe(listener: (s: BlobQueueStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refresh(): Promise<BlobQueueStatus> {
    const up = await this.db.query<{ n: number; bytes: number | null }>(
      `SELECT count(*) AS n, sum(b.size) AS bytes FROM blob_queue q LEFT JOIN blob b ON b.sha256 = q.sha256
       WHERE q.direction = 'upload' AND q.state IN ('queued', 'active')`,
    );
    const counts = await this.db.query<{ failed: number; down: number; cache: number | null }>(
      `SELECT
         (SELECT count(*) FROM blob_queue WHERE direction = 'upload' AND state = 'failed') AS failed,
         (SELECT count(*) FROM blob_queue WHERE direction = 'download' AND state IN ('queued', 'active')) AS down,
         (SELECT sum(size) FROM blob WHERE local_path IS NOT NULL) AS cache`,
    );
    this.set({
      photosWaiting: await this.photosWaiting(),
      uploadsPending: up[0]?.n ?? 0,
      uploadBytesPending: up[0]?.bytes ?? 0,
      uploadsFailed: counts[0]?.failed ?? 0,
      downloadsPending: counts[0]?.down ?? 0,
      cacheBytes: counts[0]?.cache ?? 0,
    });
    return this.current;
  }

  setTransport(transport: BlobTransport | null): void {
    this.transport = transport;
    this.nextAttemptMs = 0;
    this.set({
      state: transport ? (this.current.state === 'no_token' ? 'idle' : this.current.state) : 'no_token',
      failures: 0,
      nextAttemptAt: null,
    });
  }

  // ---------------------------------------------------------------- scheduling

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

  /** Foreground / new bytes: forget the backoff and run now. */
  requestRun(): Promise<BlobReport> {
    this.nextAttemptMs = 0;
    return this.run();
  }

  /** Run soon if the queue is started (after `addLocal`); a no-op otherwise. */
  kick(): void {
    if (this.started && this.transport) void this.run();
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    await this.run();
    if (!this.started) return;
    const wait = Math.max(this.opts.intervalMs, this.nextAttemptMs - this.opts.now());
    this.timer = this.opts.setTimer(() => void this.tick(), wait);
  }

  /** One pass: uploads, prefetch, downloads, eviction. Concurrent calls share it (and rerun once). */
  run(): Promise<BlobReport> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let report: BlobReport;
      do {
        this.rerun = false;
        report = await this.cycle();
      } while (this.rerun && report.outcome === 'ran');
      return report;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<BlobReport> {
    const transport = this.transport;
    const empty = { uploaded: 0, downloaded: 0, evicted: 0 };
    if (!transport) {
      await this.refresh();
      this.set({ state: 'no_token' });
      return { outcome: 'no_token', ...empty };
    }
    if (this.opts.now() < this.nextAttemptMs) return { outcome: 'skipped', ...empty };
    this.set({ state: 'running' });
    await this.recover();
    let failure: Error | null = null;
    let uploaded = 0;
    let downloaded = 0;
    let evicted = 0;
    try {
      uploaded = await this.uploads(transport);
    } catch (e) {
      failure = e as Error;
    }
    if (!failure || !isNetwork(failure)) {
      try {
        await this.prefetch();
        downloaded = await this.downloads(transport);
      } catch (e) {
        failure = failure ?? (e as Error);
      }
    }
    try {
      evicted = await this.evict();
    } catch (e) {
      this.opts.log('error', 'evict_failed', { error: String((e as Error).message) });
    }
    await this.refresh();
    if (failure) {
      const failures = this.current.failures + 1;
      const delay = Math.min(this.opts.backoffMs * 2 ** (failures - 1), this.opts.maxBackoffMs);
      this.nextAttemptMs = this.opts.now() + delay;
      this.set({
        state: failure instanceof TransportError && failure.failure === 'network' ? 'offline' : 'error',
        failures,
        lastError: failure.message,
        nextAttemptAt: this.iso(this.nextAttemptMs),
      });
      this.opts.log('warn', 'run_failed', { error: failure.message, uploaded, downloaded });
      return { outcome: 'failed', uploaded, downloaded, evicted, error: failure.message };
    }
    this.nextAttemptMs = 0;
    this.set({ state: 'idle', failures: 0, lastError: null, nextAttemptAt: null, lastRunAt: this.iso() });
    if (uploaded || downloaded || evicted) this.opts.log('info', 'ran', { uploaded, downloaded, evicted });
    return { outcome: 'ran', uploaded, downloaded, evicted };
  }

  /** Rows a killed app left `active` go back in the queue (runs never overlap, so none is live). */
  private async recover(): Promise<void> {
    await this.db.exec(`UPDATE blob_queue SET state = 'queued' WHERE state = 'active'`);
  }

  // ------------------------------------------------------------------- uploads

  private async nextDue(direction: 'upload' | 'download', limit: number): Promise<QueueRow[]> {
    return this.db.query<QueueRow>(
      `SELECT * FROM blob_queue WHERE direction = ? AND state = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY priority, created_at, sha256 LIMIT ?`,
      [direction, this.iso(), limit],
    );
  }

  private async mark(row: QueueRow, state: string, patch: { error?: string | null; retryInMs?: number; attempt?: boolean } = {}): Promise<void> {
    const attempts = row.attempts + (patch.attempt ? 1 : 0);
    row.attempts = attempts;
    await this.db.exec(
      `UPDATE blob_queue SET state = ?, attempts = ?, last_error = ?, next_attempt_at = ?
       WHERE sha256 = ? AND direction = ?`,
      [
        state,
        attempts,
        patch.error === undefined ? row.last_error : patch.error,
        patch.retryInMs != null ? this.iso(this.opts.now() + patch.retryInMs) : null,
        row.sha256,
        row.direction,
      ],
    );
  }

  private retryDelay(attempts: number): number {
    // At least 1 s, so a failed row is never due again within the same pass.
    return Math.max(1000, Math.min(this.opts.backoffMs * 2 ** Math.max(0, attempts - 1), this.opts.maxBackoffMs));
  }

  /** Upload everything due, one blob at a time, best priority first. Network errors stop the pass. */
  private async uploads(transport: BlobTransport): Promise<number> {
    let done = 0;
    for (;;) {
      const [row] = await this.nextDue('upload', 1);
      if (!row) return done;
      await this.mark(row, 'active');
      try {
        await this.uploadOne(transport, row.sha256);
        await this.mark(row, 'done', { error: null });
        done++;
        this.opts.log('info', 'uploaded', { sha256: row.sha256, kind: row.kind });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof BlobUploadError) {
          await this.mark(row, 'failed', { error: msg, attempt: true });
          this.opts.log('error', 'upload_failed', { sha256: row.sha256, kind: row.kind, error: msg });
          continue;
        }
        await this.mark(row, 'queued', { error: msg, attempt: true, retryInMs: this.retryDelay(row.attempts + 1) });
        if (isNetwork(e)) throw e;
        this.opts.log('warn', 'upload_retry', { sha256: row.sha256, kind: row.kind, error: msg });
      }
    }
  }

  private async uploadOne(transport: BlobTransport, sha256: string): Promise<void> {
    const b = await this.blob(sha256);
    if (!b?.local_path) throw new BlobUploadError('no local file for this blob');
    if (!(await this.files.exists(b.local_path))) throw new BlobUploadError(`local file missing: ${b.local_path}`);
    const meta: BlobMeta = { size: b.size, mime: b.mime, width: b.width, height: b.height };
    let remote = await this.declare(transport, sha256, meta);
    for (let pass = 0; remote.upload_state !== 'complete'; pass++) {
      const have = new Set(remote.chunks_received);
      await this.saveProgress(sha256, 'partial', [...have]);
      for (let n = 0; n < remote.chunks_total; n++) {
        if (have.has(n)) continue;
        const offset = n * remote.chunk_size;
        const length = Math.min(remote.chunk_size, b.size - offset);
        await transport.putChunk(sha256, n, { path: b.local_path, offset, length });
        have.add(n);
        await this.saveProgress(sha256, 'partial', [...have]);
      }
      try {
        remote = await transport.complete(sha256);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'hash_mismatch') {
          throw new BlobUploadError('the local file does not match its SHA-256 (changed or corrupt)');
        }
        if (code === 'missing_chunks' && pass === 0) {
          // The server lost a chunk it had acknowledged: ask again and send what it lacks.
          remote = await this.declare(transport, sha256, meta);
          continue;
        }
        throw e;
      }
    }
    await this.saveProgress(sha256, 'complete', Array.from({ length: remote.chunks_total }, (_, i) => i));
  }

  private async declare(transport: BlobTransport, sha256: string, meta: BlobMeta): Promise<RemoteBlob> {
    try {
      return await transport.declare(sha256, meta);
    } catch (e) {
      if (errorCode(e) === 'size_mismatch') {
        throw new BlobUploadError('the server holds a different size for this SHA-256');
      }
      throw e;
    }
  }

  private async saveProgress(sha256: string, state: 'partial' | 'complete', chunks: number[]): Promise<void> {
    await this.db.exec(`UPDATE blob SET upload_state = ?, chunks_received = ? WHERE sha256 = ?`, [
      state,
      JSON.stringify([...chunks].sort((a, b) => a - b)),
      sha256,
    ]);
  }

  // ----------------------------------------------------------------- downloads

  /**
   * Queue the display sheets, plan ink layers, photo thumbnails and photo markup of the user's assigned
   * levels that are not cached.
   * A download finished earlier whose file was since evicted is queued again.
   */
  async prefetch(): Promise<void> {
    const user = this.opts.userId();
    if (!user) return;
    const now = this.iso();
    const upsert = `ON CONFLICT(sha256, direction) DO UPDATE SET state = 'queued', attempts = 0,
        next_attempt_at = NULL, last_error = NULL WHERE blob_queue.state = 'done'`;
    const notCached = (col: string) =>
      `NOT EXISTS (SELECT 1 FROM blob b WHERE b.sha256 = ${col} AND b.local_path IS NOT NULL)`;
    // The levels to cache: the user's assignments, or, with none at all (D97, T41), every
    // in-scope level of every project on this iPad.
    const scope = `WITH mine AS (SELECT level_id FROM assignment WHERE user_id = ? AND deleted_at IS NULL),
      scope AS (SELECT level_id FROM mine
                UNION ALL
                SELECT l.id AS level_id FROM level l
                WHERE l.deleted_at IS NULL AND l.in_scope = 1 AND NOT EXISTS (SELECT 1 FROM mine))`;
    await this.db.exec(
      `${scope}
       INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at)
       SELECT DISTINCT s.blob, 'download', 'sheet', ${DOWNLOAD_PRIORITY.sheet}, 'queued', 0, ?
       FROM sheet s JOIN scope a ON a.level_id = s.level_id
       WHERE s.deleted_at IS NULL AND s.kind = 'display' AND s.blob IS NOT NULL AND ${notCached('s.blob')}
       ${upsert}`,
      [user, now],
    );
    await this.db.exec(
      `${scope}
       INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at)
       SELECT DISTINCT p.thumb_blob, 'download', 'thumb', ${DOWNLOAD_PRIORITY.thumb}, 'queued', 0, ?
       FROM photo p JOIN scope a ON a.level_id = p.level_id
       WHERE p.deleted_at IS NULL AND p.thumb_blob IS NOT NULL AND ${notCached('p.thumb_blob')}
       ${upsert}`,
      [user, now],
    );
    // Plan ink layers (stroke lists, T24, D53): every user's layer on the cached levels' sheets.
    await this.db.exec(
      `${scope}
       INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at)
       SELECT DISTINCT i.drawing_blob, 'download', 'ink', ${DOWNLOAD_PRIORITY.ink}, 'queued', 0, ?
       FROM ink_layer i JOIN sheet s ON s.id = i.sheet_id AND s.deleted_at IS NULL
       JOIN scope a ON a.level_id = s.level_id
       WHERE i.deleted_at IS NULL AND i.drawing_blob IS NOT NULL AND ${notCached('i.drawing_blob')}
       ${upsert}`,
      [user, now],
    );
    // Photo markup (stroke lists, T21): small, and needed to see a photo as marked up offline.
    await this.db.exec(
      `${scope}
       INSERT INTO blob_queue (sha256, direction, kind, priority, state, attempts, created_at)
       SELECT DISTINCT p.markup_blob, 'download', 'markup', ${DOWNLOAD_PRIORITY.markup}, 'queued', 0, ?
       FROM photo p JOIN scope a ON a.level_id = p.level_id
       WHERE p.deleted_at IS NULL AND p.markup_blob IS NOT NULL AND ${notCached('p.markup_blob')}
       ${upsert}`,
      [user, now],
    );
  }

  /** Download everything due with a small worker pool. Network errors stop the pass. */
  private async downloads(transport: BlobTransport): Promise<number> {
    let done = 0;
    let stop: Error | null = null;
    for (;;) {
      const batch = await this.nextDue('download', 50);
      if (batch.length === 0 || stop) break;
      let i = 0;
      const worker = async () => {
        while (!stop && i < batch.length) {
          const row = batch[i++]!;
          await this.mark(row, 'active');
          try {
            await this.downloadOne(transport, row.sha256, row.kind);
            await this.mark(row, 'done', { error: null });
            done++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (e instanceof TransportError && e.status === 404) {
              // Its author has not uploaded it yet: look again later, quietly.
              await this.mark(row, 'queued', { error: 'not on the server yet', attempt: true, retryInMs: this.opts.notFoundRetryMs });
              continue;
            }
            await this.mark(row, 'queued', { error: msg, attempt: true, retryInMs: this.retryDelay(row.attempts + 1) });
            if (isNetwork(e)) stop = e as Error;
            else this.opts.log('warn', 'download_retry', { sha256: row.sha256, kind: row.kind, error: msg });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.opts.downloadConcurrency, batch.length) }, worker));
    }
    if (stop) throw stop;
    return done;
  }

  /** Download into the sandbox and record the cached file; returns its path. */
  private async downloadOne(transport: BlobTransport, sha256: string, kind: BlobKind): Promise<string> {
    const existing = await this.blob(sha256);
    if (existing?.local_path && (await this.files.exists(existing.local_path))) {
      await this.touch(sha256);
      return existing.local_path;
    }
    const dest = this.files.pathFor(sha256, kind);
    const got = await transport.download(sha256, dest);
    const now = this.iso();
    await this.db.exec(
      `INSERT INTO blob (sha256, size, mime, upload_state, chunks_received, created_at, local_path, last_used_at, kind)
       VALUES (?, ?, ?, 'complete', '[]', ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET local_path = excluded.local_path, last_used_at = excluded.last_used_at,
         upload_state = 'complete', kind = coalesce(blob.kind, excluded.kind)`,
      [sha256, got.size, got.mime ?? DEFAULT_MIME[kind], now, dest, now, kind],
    );
    return dest;
  }

  // ------------------------------------------------------------------- cache

  /**
   * Bring the cached files under the budget: least recently used first, full-size images and
   * exports before thumbnails, sheets and strokes. Bytes not yet on the server, and anything used
   * within the grace period, are never removed. Returns the number of files removed.
   */
  async evict(): Promise<number> {
    const rows = await this.db.query<BlobRow>(
      `SELECT sha256, size, local_path, kind, last_used_at, upload_state FROM blob WHERE local_path IS NOT NULL`,
    );
    let total = rows.reduce((s, r) => s + r.size, 0);
    if (total <= this.opts.cacheBudgetBytes) return 0;
    const graceEdge = this.iso(this.opts.now() - this.opts.evictGraceMs);
    const candidates = rows
      .filter((r) => r.upload_state === 'complete' && (r.last_used_at ?? '') < graceEdge)
      .sort((a, b) => {
        const ta = EVICT_FIRST.has(a.kind ?? 'image') ? 0 : 1;
        const tb = EVICT_FIRST.has(b.kind ?? 'image') ? 0 : 1;
        if (ta !== tb) return ta - tb;
        return (a.last_used_at ?? '').localeCompare(b.last_used_at ?? '');
      });
    let removed = 0;
    for (const r of candidates) {
      if (total <= this.opts.cacheBudgetBytes) break;
      await this.files.remove(r.local_path!);
      await this.db.exec(`UPDATE blob SET local_path = NULL WHERE sha256 = ?`, [r.sha256]);
      total -= r.size;
      removed++;
    }
    if (removed) this.opts.log('info', 'evicted', { files: removed, cacheBytes: total });
    return removed;
  }

  // ------------------------------------------------------------------ helpers

  private async blob(sha256: string): Promise<BlobRow | null> {
    const rows = await this.db.query<BlobRow>(`SELECT * FROM blob WHERE sha256 = ?`, [sha256]);
    return rows[0] ?? null;
  }

  private async touch(sha256: string): Promise<void> {
    await this.db.exec(`UPDATE blob SET last_used_at = ? WHERE sha256 = ?`, [this.iso(), sha256]);
  }

  /** The file vanished (iOS purge, manual clean-up): forget it so it is fetched again. */
  private async forget(sha256: string): Promise<void> {
    await this.db.exec(`UPDATE blob SET local_path = NULL WHERE sha256 = ? AND upload_state = 'complete'`, [sha256]);
  }

  private set(patch: Partial<BlobQueueStatus>): void {
    this.current = { ...this.current, ...patch };
    for (const l of this.listeners) l(this.current);
  }
}
