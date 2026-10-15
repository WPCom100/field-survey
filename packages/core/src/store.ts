/**
 * The local store: the only write path is `Store.apply(op)` (CLAUDE.md §5). UI code builds an op
 * (T08), the store validates it, appends it to the `op` log and the outbox, and materialises it
 * into the entity table, `field_head`, `version` and `head_seq` (PLAN §2.1, §3.1).
 *
 * Pulled ops go through `applyRemote`: our own ops coming back are acknowledged (server_seq,
 * state, outbox cleared); other installs' applied ops are materialised; ops the server put in
 * review or rejected are recorded but never materialised (first-arrived value stays official).
 */

import { uuidv7 } from './ids';
import type { Op, StoredOp } from './op';
import {
  ENTITIES,
  PROTECTED_COLUMNS,
  decodeRow,
  encodeValue,
  entity,
  isOpTarget,
  type EntityKind,
  type EntitySpec,
  type SqlValue,
} from './schema/entities';
import { migrate } from './schema/migrations';
import {
  ensureSearchIndex,
  runSearch,
  type SearchHit,
  type SearchMode,
  type SearchOptions,
} from './schema/search';
import type { SqlDriver, SqlRow } from './sql-driver';
import { CHANGE_TYPE, OP_KIND, OP_STATE } from './vocab';


/** Ink layers and photo blobs never conflict (PLAN §3.3, D53): the server applies the last write. */
const LAST_WRITE_WINS_ENTITIES = new Set(['ink_layer']);
const LAST_WRITE_WINS_FIELDS = new Set(['photo.image_blob', 'photo.thumb_blob', 'photo.markup_blob']);
export class StoreError extends Error {
  constructor(
    message: string,
    readonly op?: Op,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export type LocalOutcome = 'applied' | 'duplicate';

export type RemoteOutcome =
  /** New op from another install, materialised. */
  | 'applied'
  /** Our own op came back with its server_seq and state. */
  | 'acknowledged'
  /** Already known with the same server_seq. */
  | 'duplicate'
  /** Recorded but not materialised (state review/rejected/superseded). */
  | 'recorded'
  /** Applied op whose record does not exist locally (logged, not fatal). */
  | 'orphan';

export interface RemoteResult {
  outcome: RemoteOutcome;
  /** Local pending ops on the same field (or record, for deletes) that the server will review. */
  collided_pending: string[];
}

/** One `results[]` entry of `POST /ops` (server/docs/sync.md). */
/** An outbox op the server refused (T75, D145). */
export interface QuarantinedOp {
  op: StoredOp;
  error: string | null;
  attempts: number;
}

export interface PushAck {
  op_id: string;
  outcome: 'applied' | 'duplicate' | 'review' | 'superseded';
  server_seq: number | null;
  review_item_id?: string | null;
}

export interface OpenOptions {
  /** Fixed install id (tests); otherwise generated once and kept in `sync_state`. */
  installId?: string;
  /** `'like'` forces the LIKE fallback (tests); default probes FTS5. */
  search?: 'auto' | 'like';
}

export interface ListOptions {
  where?: string;
  params?: SqlValue[];
  orderBy?: string;
  limit?: number;
  includeDeleted?: boolean;
}

/** One committed transaction that changed data (T33): what the rule trigger listens for. */
export interface StoreChange {
  /** `local` = an edit on this iPad (commit); `remote` = a pull materialised others' ops. */
  source: 'local' | 'remote';
  projectIds: string[];
  kinds: EntityKind[];
}

const OP_COLUMNS = Object.keys(ENTITIES.op.columns);
const LINK_KINDS = new Set(['link_add', 'link_remove']);
/** Review-item states that settle the ops the item held (T15, D91). */
const SETTLED = new Set(['resolved', 'dismissed']);

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  private readonly changeListeners = new Set<(c: StoreChange) => void>();

  private constructor(
    readonly db: SqlDriver,
    readonly installId: string,
    readonly searchMode: SearchMode,
  ) {}

  /**
   * Be told after each transaction that applied ops (local commits and pulls alike). Listeners
   * run after the commit, in order, and may not throw into the store (errors are swallowed).
   * Returns the unsubscribe function.
   */
  onChange(listener: (c: StoreChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private announce(source: StoreChange['source'], ops: readonly Op[], applied: readonly boolean[]): void {
    if (this.changeListeners.size === 0) return;
    const projects = new Set<string>();
    const kinds = new Set<EntityKind>();
    ops.forEach((op, i) => {
      if (!applied[i]) return;
      projects.add(op.project_id);
      kinds.add(op.entity_kind);
    });
    if (projects.size === 0) return;
    const change: StoreChange = { source, projectIds: [...projects], kinds: [...kinds] };
    for (const l of this.changeListeners) {
      try {
        l(change);
      } catch {
        // never let a listener break an edit or a pull
      }
    }
  }

  /** Migrate, set up search and the install id, and return a ready store. */
  static async open(db: SqlDriver, opts: OpenOptions = {}): Promise<Store> {
    await migrate(db);
    const searchMode = await ensureSearchIndex(db, opts.search ?? 'auto');
    const installId = await Store.installId(db, opts.installId);
    return new Store(db, installId, searchMode);
  }

  private static async installId(db: SqlDriver, wanted?: string): Promise<string> {
    const rows = await db.query<{ value: string }>(
      `SELECT value FROM sync_state WHERE key = 'install_id'`,
    );
    const existing = rows[0] ? (JSON.parse(rows[0].value) as string) : null;
    if (existing && !wanted) return existing;
    const id = wanted ?? uuidv7();
    await db.exec(
      `INSERT INTO sync_state (key, value) VALUES ('install_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(id)],
    );
    return id;
  }

  // ---------------------------------------------------------------- local ops

  /** Apply one local op atomically: op log + outbox + materialised state. */
  async apply(op: Op): Promise<LocalOutcome> {
    validateLocal(op);
    const out = await this.db.transaction((tx) => this.applyLocalIn(tx, op));
    this.announce('local', [op], [out === 'applied']);
    return out;
  }

  /** Apply several local ops in one transaction (grouped edits sharing `group_id`). */
  async applyMany(ops: readonly Op[]): Promise<LocalOutcome[]> {
    for (const op of ops) validateLocal(op);
    const out = await this.db.transaction(async (tx) => {
      const out: LocalOutcome[] = [];
      for (const op of ops) out.push(await this.applyLocalIn(tx, op));
      return out;
    });
    this.announce(
      'local',
      ops,
      out.map((o) => o === 'applied'),
    );
    return out;
  }

  private async applyLocalIn(tx: SqlDriver, op: Op): Promise<LocalOutcome> {
    if (await this.hasOp(tx, op.op_id)) return 'duplicate';
    const stored: StoredOp = normalise(op, 'pending');
    stored.server_seq = null;
    stored.server_ts = null;
    await this.insertOp(tx, stored);
    await tx.exec(
      `INSERT INTO outbox (op_id, project_id, client_ts, attempts, last_error, created_at) VALUES (?, ?, ?, 0, NULL, ?)`,
      [stored.op_id, stored.project_id, stored.client_ts, nowIso()],
    );
    const ok = await this.materialise(tx, stored);
    if (!ok) throw new StoreError(`${op.kind} on unknown ${op.entity_kind} ${op.entity_id}`, op);
    return 'applied';
  }

  // --------------------------------------------------------------- remote ops

  /** Apply one pulled op (already ordered by `server_seq`). */
  async applyRemote(op: Op): Promise<RemoteResult> {
    validateRemote(op);
    const out = await this.db.transaction((tx) => this.applyRemoteIn(tx, op));
    this.announce('remote', [op], [out.outcome === 'applied']);
    return out;
  }

  /** Apply a page of pulled ops in one transaction. */
  async applyRemoteMany(ops: readonly Op[]): Promise<RemoteResult[]> {
    for (const op of ops) validateRemote(op);
    const out = await this.db.transaction(async (tx) => {
      const out: RemoteResult[] = [];
      for (const op of ops) out.push(await this.applyRemoteIn(tx, op));
      return out;
    });
    this.announce(
      'remote',
      ops,
      out.map((o) => o.outcome === 'applied'),
    );
    return out;
  }

  private async applyRemoteIn(tx: SqlDriver, op: Op): Promise<RemoteResult> {
    const state = op.state ?? 'applied';
    const existing = await this.getOpIn(tx, op.op_id);
    if (existing) {
      // An op acknowledged from a push result has its seq but no server_ts yet; the echo
      // completes it. Once complete, the same seq again is a duplicate.
      if (
        existing.server_seq != null &&
        existing.server_seq === op.server_seq &&
        existing.server_ts != null &&
        existing.state !== 'pending'
      ) {
        return { outcome: 'duplicate', collided_pending: [] };
      }
      await tx.exec(`UPDATE op SET server_seq = ?, server_ts = ?, state = ? WHERE op_id = ?`, [
        op.server_seq ?? null,
        op.server_ts ?? null,
        state,
        op.op_id,
      ]);
      await tx.exec(`DELETE FROM outbox WHERE op_id = ?`, [op.op_id]);
      if (state === 'applied' && op.server_seq != null) {
        await this.bumpHeadSeq(tx, entity(op.entity_kind), op.entity_id, op.server_seq);
        if (op.kind === 'delete' && op.server_ts) await this.restampDelete(tx, op);
      }
      return { outcome: 'acknowledged', collided_pending: [] };
    }
    const stored = normalise(op, state);
    await this.insertOp(tx, stored);
    if (state !== 'applied') return { outcome: 'recorded', collided_pending: [] };
    const collided = await this.pendingCollisions(tx, stored);
    const ok = await this.materialise(tx, stored);
    return { outcome: ok ? 'applied' : 'orphan', collided_pending: collided };
  }

  /**
   * Record what the server said about our pushed ops (T11): `server_seq` and state are stored,
   * the outbox rows go, `head_seq` moves for applied ops. The materialised value is never
   * touched (the official value of a reviewed field arrives as the other user's op on pull).
   * A `duplicate` result carries no state; the op keeps `pending` until its echo arrives.
   */
  async acknowledgeMany(acks: readonly PushAck[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const ack of acks) {
        const existing = await this.getOpIn(tx, ack.op_id);
        if (!existing) continue;
        const state: StoredOp['state'] =
          ack.outcome === 'duplicate' ? existing.state : ack.outcome;
        await tx.exec(`UPDATE op SET server_seq = ?, state = ? WHERE op_id = ?`, [
          ack.server_seq ?? null,
          state,
          ack.op_id,
        ]);
        await tx.exec(`DELETE FROM outbox WHERE op_id = ?`, [ack.op_id]);
        if (state === 'applied' && ack.server_seq != null) {
          await this.bumpHeadSeq(tx, entity(existing.entity_kind), existing.entity_id, ack.server_seq);
        }
      }
    });
  }

  /** A failed push attempt: count it and keep the error for the Sync screen (T25). */
  async noteOutboxFailure(opIds: readonly string[], error: string): Promise<void> {
    if (opIds.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const id of opIds) {
        await tx.exec(`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE op_id = ?`, [
          error.slice(0, 500),
          id,
        ]);
      }
    });
  }

  /** Local pending ops the incoming op will collide with on the server (PLAN §3.2 pull). */
  private async pendingCollisions(tx: SqlDriver, op: StoredOp): Promise<string[]> {
    // Last write wins there (PLAN §3.3, the server's LAST_WRITE_WINS_*): never "will be reviewed".
    if (LAST_WRITE_WINS_ENTITIES.has(op.entity_kind)) return [];
    if (op.kind === 'set' && LAST_WRITE_WINS_FIELDS.has(`${op.entity_kind}.${op.field}`)) return [];
    let sql = `SELECT op_id FROM op WHERE entity_id = ? AND state = 'pending' AND server_seq IS NULL`;
    const params: SqlValue[] = [op.entity_id];
    if (op.kind === 'set' || op.kind === 'assign') {
      sql += ` AND (field = ? OR kind IN ('delete', 'restore'))`;
      params.push(op.field);
    }
    const rows = await tx.query<{ op_id: string }>(sql + ` ORDER BY client_ts`, params);
    return rows.map((r) => r.op_id);
  }

  // ----------------------------------------------------------- materialising

  /** Returns false when a non-create op targets a record that does not exist locally. */
  private async materialise(tx: SqlDriver, op: StoredOp): Promise<boolean> {
    const spec = entity(op.entity_kind);
    switch (op.kind) {
      case 'create':
        return this.materialiseCreate(tx, spec, op);
      case 'set':
      case 'assign':
        return this.materialiseSet(tx, spec, op);
      case 'delete':
        return this.materialiseDelete(tx, spec, op, true);
      case 'restore':
        return this.materialiseDelete(tx, spec, op, false);
      case 'link_add':
        return this.materialiseLink(tx, spec, op, true);
      case 'link_remove':
        return this.materialiseLink(tx, spec, op, false);
    }
  }

  private async materialiseCreate(tx: SqlDriver, spec: EntitySpec, op: StoredOp): Promise<boolean> {
    const payload = op.payload ?? {};
    const names: string[] = [];
    const values: SqlValue[] = [];
    for (const [name, value] of Object.entries(payload)) {
      const col = spec.columns[name];
      if (!col) throw new StoreError(`Unknown column ${spec.table}.${name}`, op);
      if (name !== 'id' && PROTECTED_COLUMNS.has(name)) {
        throw new StoreError(`Column ${spec.table}.${name} is not settable`, op);
      }
      if (name === 'id' && value !== op.entity_id) {
        throw new StoreError(`payload.id does not match entity_id`, op);
      }
      names.push(name);
      values.push(encodeValue(col, value));
    }
    if (!names.includes('id')) {
      names.push('id');
      values.push(op.entity_id);
    }
    if (spec.role === 'record') {
      names.push('version', 'head_seq');
      values.push(1, op.server_seq);
    }
    const placeholders = names.map(() => '?').join(', ');
    // A replayed create never overwrites later sets, and a second create of a row that exists
    // (a deterministic id made on two iPads, D169) leaves the first create's heads alone: the
    // server keeps the first-arrived create as the head too, so later `set`s agree.
    const existed = await this.exists(tx, spec, op.entity_id);
    await tx.exec(
      `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
    if (existed) return true;
    for (const name of names) {
      if (PROTECTED_COLUMNS.has(name)) continue;
      await this.setHead(tx, op.entity_id, name, op.op_id);
    }
    return true;
  }

  private async materialiseSet(tx: SqlDriver, spec: EntitySpec, op: StoredOp): Promise<boolean> {
    const field = op.field;
    if (!field) throw new StoreError(`${op.kind} needs a field`, op);
    const col = spec.columns[field];
    if (!col) throw new StoreError(`Unknown column ${spec.table}.${field}`, op);
    if (PROTECTED_COLUMNS.has(field) || spec.pk.includes(field)) {
      throw new StoreError(`Column ${spec.table}.${field} is not settable`, op);
    }
    if (!(await this.exists(tx, spec, op.entity_id))) return false;
    const versioned = spec.role === 'record';
    await tx.exec(
      `UPDATE ${spec.table} SET ${field} = ?${versioned ? `, version = version + 1, head_seq = ${HEAD_SEQ_EXPR}` : ''} WHERE ${spec.pk[0]} = ?`,
      versioned
        ? [encodeValue(col, op.now), op.server_seq, op.server_seq, op.server_seq, op.entity_id]
        : [encodeValue(col, op.now), op.entity_id],
    );
    await this.setHead(tx, op.entity_id, field, op.op_id);
    if (spec.table === 'review_item' && field === 'state' && SETTLED.has(op.now as string)) {
      await this.settleReview(tx, op.entity_id);
    }
    return true;
  }

  /**
   * A review item leaving `open` settles the ops it held, exactly as the server does
   * (`server/app/materialise.py`, D91): the ids in `resolution.rejected_op_ids` become
   * `rejected`, those in `resolution.superseded_op_ids` `superseded`; only ops still in
   * `review` move, so every install's log ends with the same states.
   */
  private async settleReview(tx: SqlDriver, itemId: string): Promise<void> {
    const rows = await tx.query<{ resolution: string | null }>(
      `SELECT resolution FROM review_item WHERE id = ?`,
      [itemId],
    );
    const raw = rows[0]?.resolution;
    if (!raw) return;
    const resolution = JSON.parse(raw) as Record<string, unknown> | null;
    if (!resolution || typeof resolution !== 'object') return;
    for (const [state, key] of [
      ['rejected', 'rejected_op_ids'],
      ['superseded', 'superseded_op_ids'],
    ] as const) {
      const ids = Array.isArray(resolution[key]) ? (resolution[key] as string[]) : [];
      for (const id of ids) {
        await tx.exec(`UPDATE op SET state = ? WHERE op_id = ? AND state = 'review'`, [state, id]);
      }
    }
  }

  private async materialiseDelete(
    tx: SqlDriver,
    spec: EntitySpec,
    op: StoredOp,
    deleted: boolean,
  ): Promise<boolean> {
    if (spec.role !== 'record') {
      throw new StoreError(`${op.kind} is not allowed on ${spec.table}`, op);
    }
    if (!(await this.exists(tx, spec, op.entity_id))) return false;
    await tx.exec(
      `UPDATE ${spec.table} SET deleted_at = ?, deleted_by_id = ?, delete_reason = ?, version = version + 1, head_seq = ${HEAD_SEQ_EXPR} WHERE id = ?`,
      [
        deleted ? (op.server_ts ?? op.client_ts) : null,
        deleted ? op.user_id : null,
        deleted ? op.reason : null,
        op.server_seq,
        op.server_seq,
        op.server_seq,
        op.entity_id,
      ],
    );
    await this.setHead(tx, op.entity_id, 'deleted_at', op.op_id);
    return true;
  }

  private async materialiseLink(
    tx: SqlDriver,
    spec: EntitySpec,
    op: StoredOp,
    add: boolean,
  ): Promise<boolean> {
    if (spec.role !== 'link' || !spec.owner) {
      throw new StoreError(`${op.kind} is not allowed on ${spec.table}`, op);
    }
    const payload: Record<string, unknown> = { ...(op.payload ?? {}), [spec.owner]: op.entity_id };
    for (const k of spec.pk) {
      if (payload[k] === undefined || payload[k] === null) {
        throw new StoreError(`${op.kind} on ${spec.table} needs payload.${k}`, op);
      }
    }
    const names: string[] = [];
    const values: SqlValue[] = [];
    for (const [name, value] of Object.entries(payload)) {
      const col = spec.columns[name];
      if (!col) throw new StoreError(`Unknown column ${spec.table}.${name}`, op);
      if (name === 'deleted_at' || name === 'deleted_by_id') continue;
      names.push(name);
      values.push(encodeValue(col, value));
    }
    const keyWhere = spec.pk.map((k) => `${k} = ?`).join(' AND ');
    const keyValues = spec.pk.map((k) => encodeValue(spec.columns[k]!, payload[k]));
    if (add) {
      const updates = names
        .filter((n) => !spec.pk.includes(n))
        .map((n) => `${n} = excluded.${n}`);
      updates.push('deleted_at = NULL', 'deleted_by_id = NULL');
      await tx.exec(
        `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(${spec.pk.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
        values,
      );
    } else {
      await tx.exec(`UPDATE ${spec.table} SET deleted_at = ?, deleted_by_id = ? WHERE ${keyWhere}`, [
        op.server_ts ?? op.client_ts,
        op.user_id,
        ...keyValues,
      ]);
    }
    return true;
  }

  /**
   * Our own applied delete came back: `deleted_at` takes the server's timestamp, as on the server
   * and every other iPad (it was the local `client_ts` until now). Only while this delete is
   * still the record's `deleted_at` head.
   */
  private async restampDelete(tx: SqlDriver, op: Op): Promise<void> {
    const spec = entity(op.entity_kind);
    if (spec.role !== 'record') return;
    await tx.exec(
      `UPDATE ${spec.table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM field_head WHERE entity_id = ? AND field = 'deleted_at' AND op_id = ?)`,
      [op.server_ts!, op.entity_id, op.entity_id, op.op_id],
    );
  }

  private async exists(tx: SqlDriver, spec: EntitySpec, id: string): Promise<boolean> {
    const rows = await tx.query<{ n: number }>(
      `SELECT count(*) AS n FROM ${spec.table} WHERE ${spec.pk[0]} = ?`,
      [id],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  private async bumpHeadSeq(
    tx: SqlDriver,
    spec: EntitySpec,
    id: string,
    seq: number,
  ): Promise<void> {
    if (spec.role !== 'record') return;
    await tx.exec(`UPDATE ${spec.table} SET head_seq = ${HEAD_SEQ_EXPR} WHERE id = ?`, [
      seq,
      seq,
      seq,
      id,
    ]);
  }

  private async setHead(tx: SqlDriver, entityId: string, field: string, opId: string): Promise<void> {
    await tx.exec(
      `INSERT INTO field_head (entity_id, field, op_id) VALUES (?, ?, ?) ON CONFLICT(entity_id, field) DO UPDATE SET op_id = excluded.op_id`,
      [entityId, field, opId],
    );
  }

  // ------------------------------------------------------------------ op log

  private async hasOp(tx: SqlDriver, opId: string): Promise<boolean> {
    const rows = await tx.query<{ n: number }>(`SELECT count(*) AS n FROM op WHERE op_id = ?`, [
      opId,
    ]);
    return (rows[0]?.n ?? 0) > 0;
  }

  private async insertOp(tx: SqlDriver, op: StoredOp): Promise<void> {
    const values = OP_COLUMNS.map((c) =>
      encodeValue(ENTITIES.op.columns[c]!, (op as unknown as Record<string, unknown>)[c]),
    );
    await tx.exec(
      `INSERT INTO op (${OP_COLUMNS.join(', ')}) VALUES (${OP_COLUMNS.map(() => '?').join(', ')})`,
      values,
    );
  }

  private async getOpIn(tx: SqlDriver, opId: string): Promise<StoredOp | null> {
    const rows = await tx.query(`SELECT * FROM op WHERE op_id = ?`, [opId]);
    return rows[0] ? decodeRow<StoredOp>(ENTITIES.op, rows[0]) : null;
  }

  getOp(opId: string): Promise<StoredOp | null> {
    return this.getOpIn(this.db, opId);
  }

  /** History of one record, oldest first. */
  async opsFor(entityId: string): Promise<StoredOp[]> {
    const rows = await this.db.query(
      `SELECT * FROM op WHERE entity_id = ? ORDER BY coalesce(server_seq, 9223372036854775807), client_ts`,
      [entityId],
    );
    return rows.map((r) => decodeRow<StoredOp>(ENTITIES.op, r));
  }

  /** Pending outbox ops in `client_ts` order (PLAN §3.2), joined to the ops; quarantined rows wait. */
  async outbox(projectId?: string, limit = 500): Promise<StoredOp[]> {
    const rows = await this.db.query(
      `SELECT o.* FROM op o JOIN outbox x ON x.op_id = o.op_id WHERE x.state = 'pending'` +
        (projectId ? ` AND x.project_id = ?` : '') +
        ` ORDER BY x.client_ts, o.op_id LIMIT ?`,
      projectId ? [projectId, limit] : [limit],
    );
    return rows.map((r) => decodeRow<StoredOp>(ENTITIES.op, r));
  }

  /** Projects with something pending to be pushed. */
  async outboxProjects(): Promise<string[]> {
    const rows = await this.db.query<{ project_id: string }>(
      `SELECT DISTINCT project_id FROM outbox WHERE state = 'pending' ORDER BY project_id`,
    );
    return rows.map((r) => r.project_id);
  }

  /** Every op still in the outbox, quarantined ones included: nothing is synced until they go. */
  async outboxCount(projectId?: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM outbox` + (projectId ? ` WHERE project_id = ?` : ''),
      projectId ? [projectId] : [],
    );
    return rows[0]?.n ?? 0;
  }

  /** Quarantined outbox ops (T75, D145), oldest first, with the server's error. */
  async quarantined(projectId?: string): Promise<QuarantinedOp[]> {
    const rows = await this.db.query<{ last_error: string | null; attempts: number }>(
      `SELECT o.*, x.last_error AS last_error, x.attempts AS attempts FROM op o JOIN outbox x ON x.op_id = o.op_id` +
        ` WHERE x.state = 'quarantined'` +
        (projectId ? ` AND x.project_id = ?` : '') +
        ` ORDER BY x.client_ts, o.op_id`,
      projectId ? [projectId] : [],
    );
    return rows.map((r) => ({
      op: decodeRow<StoredOp>(ENTITIES.op, r),
      error: r.last_error,
      attempts: r.attempts,
    }));
  }

  async quarantinedCount(projectId?: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM outbox WHERE state = 'quarantined'` + (projectId ? ` AND project_id = ?` : ''),
      projectId ? [projectId] : [],
    );
    return rows[0]?.n ?? 0;
  }

  /** The server refused these ops (409/422): park them with the error so the rest can go (T75). */
  async quarantine(opIds: readonly string[], error: string): Promise<void> {
    if (opIds.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const id of opIds) {
        await tx.exec(
          `UPDATE outbox SET state = 'quarantined', attempts = attempts + 1, last_error = ? WHERE op_id = ?`,
          [error.slice(0, 500), id],
        );
      }
    });
  }

  /** Retry: quarantined ops (all, or one project's) go back to `pending`; returns how many. */
  async requeueQuarantined(projectId?: string): Promise<number> {
    const n = await this.quarantinedCount(projectId);
    await this.db.exec(
      `UPDATE outbox SET state = 'pending', last_error = NULL WHERE state = 'quarantined'` +
        (projectId ? ` AND project_id = ?` : ''),
      projectId ? [projectId] : [],
    );
    return n;
  }

  async fieldHead(entityId: string, field: string): Promise<string | null> {
    const rows = await this.db.query<{ op_id: string }>(
      `SELECT op_id FROM field_head WHERE entity_id = ? AND field = ?`,
      [entityId, field],
    );
    return rows[0]?.op_id ?? null;
  }

  async fieldHeads(entityId: string): Promise<Record<string, string>> {
    const rows = await this.db.query<{ field: string; op_id: string }>(
      `SELECT field, op_id FROM field_head WHERE entity_id = ?`,
      [entityId],
    );
    return Object.fromEntries(rows.map((r) => [r.field, r.op_id]));
  }

  // ------------------------------------------------------------------- reads

  async get<T extends object = SqlRow>(kind: EntityKind, id: string): Promise<T | null> {
    const spec = entity(kind);
    const rows = await this.db.query(`SELECT * FROM ${spec.table} WHERE ${spec.pk[0]} = ?`, [id]);
    return rows[0] ? decodeRow<T>(spec, rows[0]) : null;
  }

  async list<T extends object = SqlRow>(kind: EntityKind, opts: ListOptions = {}): Promise<T[]> {
    const spec = entity(kind);
    const where: string[] = [];
    if (!opts.includeDeleted && 'deleted_at' in spec.columns) where.push('deleted_at IS NULL');
    if (opts.where) where.push(`(${opts.where})`);
    const sql =
      `SELECT * FROM ${spec.table}` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      (opts.orderBy ? ` ORDER BY ${opts.orderBy}` : '') +
      (opts.limit ? ` LIMIT ${opts.limit}` : '');
    const rows = await this.db.query(sql, opts.params ?? []);
    return rows.map((r) => decodeRow<T>(spec, r));
  }

  search(input: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return runSearch(this.db, this.searchMode, input, opts);
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.db.query<{ value: string | null }>(
      `SELECT value FROM sync_state WHERE key = ?`,
      [key],
    );
    return rows[0]?.value != null ? (JSON.parse(rows[0].value) as T) : null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.exec(
      `INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  }
}

/** `head_seq = max(head_seq, server_seq)` with nulls handled; binds `server_seq` three times. */
const HEAD_SEQ_EXPR = `CASE WHEN ? IS NULL THEN head_seq WHEN head_seq IS NULL OR head_seq < ? THEN ? ELSE head_seq END`;

function normalise(op: Op, state: StoredOp['state']): StoredOp {
  return {
    op_id: op.op_id,
    project_id: op.project_id,
    user_id: op.user_id,
    install_id: op.install_id,
    client_ts: op.client_ts,
    server_seq: op.server_seq ?? null,
    server_ts: op.server_ts ?? null,
    entity_kind: op.entity_kind,
    entity_id: op.entity_id,
    kind: op.kind,
    field: op.field ?? null,
    was: op.was ?? null,
    now: op.now ?? null,
    payload: op.payload ?? null,
    base_op_id: op.base_op_id ?? null,
    group_id: op.group_id ?? null,
    change_type: op.change_type,
    reason: op.reason ?? null,
    ruling_id: op.ruling_id ?? null,
    proposal_id: op.proposal_id ?? null,
    state: op.state ?? state,
  };
}

function validateCommon(op: Op): void {
  for (const k of ['op_id', 'project_id', 'user_id', 'install_id', 'client_ts', 'entity_id'] as const) {
    if (typeof op[k] !== 'string' || op[k].length === 0) {
      throw new StoreError(`op.${k} is required`, op);
    }
  }
  if (!isOpTarget(op.entity_kind)) throw new StoreError(`Bad entity_kind ${op.entity_kind}`, op);
  if (!(OP_KIND as readonly string[]).includes(op.kind)) {
    throw new StoreError(`Bad op kind ${op.kind}`, op);
  }
  if (!(CHANGE_TYPE as readonly string[]).includes(op.change_type)) {
    throw new StoreError(`Bad change_type ${op.change_type}`, op);
  }
  if (op.state !== undefined && !(OP_STATE as readonly string[]).includes(op.state)) {
    throw new StoreError(`Bad op state ${op.state}`, op);
  }
  const spec = entity(op.entity_kind);
  if (LINK_KINDS.has(op.kind) !== (spec.role === 'link')) {
    throw new StoreError(`${op.kind} is not allowed on ${op.entity_kind}`, op);
  }
  if ((op.kind === 'set' || op.kind === 'assign') && !op.field) {
    throw new StoreError(`${op.kind} needs a field`, op);
  }
  if (op.kind === 'create' && (!op.payload || typeof op.payload !== 'object')) {
    throw new StoreError(`create needs a payload`, op);
  }
}

function validateLocal(op: Op): void {
  validateCommon(op);
  if (op.kind === 'assign') throw new StoreError(`assign is server-only`, op);
  if (op.state !== undefined && op.state !== 'pending') {
    throw new StoreError(`A local op starts as pending`, op);
  }
  const spec = entity(op.entity_kind);
  if (op.kind === 'set' && spec.columns[op.field!]?.serverAssigned) {
    throw new StoreError(`${op.entity_kind}.${op.field} is assigned by the server`, op);
  }
  if (op.kind === 'create' && op.payload) {
    for (const [name, value] of Object.entries(op.payload)) {
      if (spec.columns[name]?.serverAssigned && value != null) {
        throw new StoreError(`${op.entity_kind}.${name} is assigned by the server`, op);
      }
    }
  }
}

function validateRemote(op: Op): void {
  validateCommon(op);
  if (op.server_seq == null) throw new StoreError(`A pulled op carries server_seq`, op);
}
