/**
 * Client op generation (T08): the UI-facing mutation API. Screens never build an `Op` by hand
 * and never write tables; they call an `Editor`, which reads the current row and field heads,
 * builds the op (PLAN §3.1) and hands it to `Store.apply` / `Store.applyMany`.
 *
 * - `base_op_id` = the field head the client had (`field_head`, seeded by `create` — D81).
 * - `was` = the value the client saw; `now` = the new value.
 * - `change_type` and a non-empty `reason` are required on every op (R6, CLAUDE.md §3).
 * - Grouped edits (`group()`) share one `group_id` and are applied in one transaction (D45);
 *   a single edit has `group_id = null`.
 */

import { uuidv7 } from './ids';
import type { Op } from './op';
import {
  PROTECTED_COLUMNS,
  entity,
  isOpTarget,
  type ColumnSpec,
  type EntityKind,
  type EntitySpec,
} from './schema/entities';
import { defaultIdScheme } from './device-id';
import { resolveReview, type ResolveChoice, type ResolveOptions, type ResolveResult } from './review';
import type { Store } from './store';
import { CHANGE_TYPE, type ChangeType } from './vocab';

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

/** Why an edit is being made; every op carries it (PLAN §3.1). */
export interface EditContext {
  change_type: ChangeType;
  /** Free text, required. Rulings pass the ruling text, reconcile passes "Review: chose …". */
  reason: string;
  ruling_id?: string | null;
  proposal_id?: string | null;
}

export interface EditorOptions {
  projectId: string;
  /** The user stamped on every op (the interim team-name picker until T04). */
  userId: string;
  /** Clock for `client_ts` (ISO 8601); tests inject one. */
  now?: () => string;
}

type Row = Record<string, unknown>;

function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function checkContext(ctx: EditContext): void {
  if (!ctx || !(CHANGE_TYPE as readonly string[]).includes(ctx.change_type)) {
    throw new OpError(`change_type is required and must be one of: ${CHANGE_TYPE.join(', ')}`);
  }
  if (isBlank(ctx.reason)) throw new OpError('reason is required');
}

/** The column a `set` or `create` may write, or an `OpError` saying why not. */
function writableColumn(spec: EntitySpec, name: string): ColumnSpec {
  const col = spec.columns[name];
  if (!col) throw new OpError(`Unknown column ${spec.table}.${name}`);
  if (PROTECTED_COLUMNS.has(name) || spec.pk.includes(name)) {
    throw new OpError(`Column ${spec.table}.${name} is not editable`);
  }
  if (col.serverAssigned) throw new OpError(`${spec.table}.${name} is assigned by the server`);
  return col;
}

function checkValue(spec: EntitySpec, name: string, col: ColumnSpec, value: unknown): void {
  if (value === null || value === undefined) return;
  if (col.check && !(col.check as readonly unknown[]).includes(value)) {
    throw new OpError(
      `${spec.table}.${name} must be one of: ${col.check.join(' · ')} (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Builds the ops of one edit or one group. Reads go through an overlay so that ops built
 * earlier in the same group are seen by later ones (a `create` then a `set` on the new record,
 * or two `set`s on one field, chain their heads correctly).
 */
export class EditBatch {
  readonly ops: Op[] = [];
  private readonly rows = new Map<string, Row | null>();
  private readonly heads = new Map<string, Record<string, string>>();

  constructor(
    private readonly store: Store,
    private readonly opts: Required<EditorOptions>,
    private readonly ctx: EditContext,
    readonly groupId: string | null,
  ) {
    checkContext(ctx);
    if (isBlank(opts.projectId)) throw new OpError('projectId is required');
    if (isBlank(opts.userId)) throw new OpError('userId is required');
  }

  /** `create`: the payload is the full record; returns the new id (`payload.id` or a UUID v7). */
  async create(kind: EntityKind, payload: Row): Promise<{ id: string; op: Op }> {
    const spec = this.specFor(kind, 'create');
    if (spec.role === 'link') throw new OpError(`Use link() for ${kind}`);
    const id = typeof payload.id === 'string' && payload.id ? payload.id : uuidv7();
    const full: Row = { id };
    for (const [name, value] of Object.entries(payload)) {
      if (name === 'id' || value === undefined) continue;
      const col = writableColumn(spec, name);
      checkValue(spec, name, col, value);
      full[name] = value;
    }
    if (await this.row(kind, id)) throw new OpError(`${kind} ${id} already exists`);
    if (kind === 'device') await this.checkDeviceId(full);
    const op = this.op({ entity_kind: kind, entity_id: id, kind: 'create', payload: full });
    const row: Row = { ...full };
    if (spec.role === 'record') Object.assign(row, { deleted_at: null, deleted_by_id: null, delete_reason: null });
    this.rows.set(id, row);
    const heads: Record<string, string> = {};
    for (const name of Object.keys(full)) if (name !== 'id') heads[name] = op.op_id;
    this.heads.set(id, heads);
    return { id, op };
  }

  /**
   * `set` one field. `was` is the current value, `base_op_id` the field head (null if the field
   * was never set). Returns null and writes nothing when the value is unchanged.
   */
  async setField(kind: EntityKind, id: string, field: string, now: unknown): Promise<Op | null> {
    const spec = this.specFor(kind, 'set');
    if (spec.role === 'link') throw new OpError(`${kind} has no editable fields; use link()/unlink()`);
    const col = writableColumn(spec, field);
    checkValue(spec, field, col, now);
    const row = await this.mustRow(kind, id);
    const was = row[field] ?? null;
    if (sameValue(was, now)) return null;
    const heads = await this.headsFor(id);
    const op = this.op({
      entity_kind: kind,
      entity_id: id,
      kind: 'set',
      field,
      was,
      now: now ?? null,
      base_op_id: heads[field] ?? null,
    });
    row[field] = now ?? null;
    heads[field] = op.op_id;
    return op;
  }

  /** Several fields of one record, one `set` op each (skipping unchanged values). */
  async setFields(kind: EntityKind, id: string, values: Row): Promise<Op[]> {
    const out: Op[] = [];
    for (const [field, now] of Object.entries(values)) {
      if (now === undefined) continue;
      const op = await this.setField(kind, id, field, now);
      if (op) out.push(op);
    }
    return out;
  }

  /** Soft delete; `reason` becomes `delete_reason`. */
  async delete(kind: EntityKind, id: string): Promise<Op> {
    return this.deleteOrRestore(kind, id, true);
  }

  async restore(kind: EntityKind, id: string): Promise<Op> {
    return this.deleteOrRestore(kind, id, false);
  }

  private async deleteOrRestore(kind: EntityKind, id: string, deleted: boolean): Promise<Op> {
    const opKind = deleted ? 'delete' : 'restore';
    const spec = this.specFor(kind, opKind);
    if (spec.role !== 'record') throw new OpError(`${opKind} is not allowed on ${kind}`);
    const row = await this.mustRow(kind, id, true);
    const isDeleted = row.deleted_at != null;
    if (deleted && isDeleted) throw new OpError(`${kind} ${id} is already deleted`);
    if (!deleted && !isDeleted) throw new OpError(`${kind} ${id} is not deleted`);
    const heads = await this.headsFor(id);
    const op = this.op({
      entity_kind: kind,
      entity_id: id,
      kind: opKind,
      base_op_id: heads.deleted_at ?? null,
    });
    row.deleted_at = deleted ? op.client_ts : null;
    row.deleted_by_id = deleted ? this.opts.userId : null;
    row.delete_reason = deleted ? this.ctx.reason : null;
    heads.deleted_at = op.op_id;
    return op;
  }

  /**
   * Review resolution only (T15, D91): a `set` written even when the local value already equals
   * `now` and even on a deleted record, based on `baseOpId` (the official head, which on the
   * iPad whose op went to review is not its local `field_head`). The op is what brings every
   * other iPad, including the losing one, to the chosen value.
   */
  async reconcileSet(
    kind: EntityKind,
    id: string,
    field: string,
    now: unknown,
    baseOpId: string | null,
  ): Promise<Op> {
    const spec = this.specFor(kind, 'set');
    if (spec.role === 'link') throw new OpError(`${kind} has no editable fields`);
    const col = writableColumn(spec, field);
    checkValue(spec, field, col, now);
    const row = await this.mustRow(kind, id, true);
    const heads = await this.headsFor(id);
    const chained = this.ops.some((o) => o.entity_id === id && o.field === field);
    const op = this.op({
      entity_kind: kind,
      entity_id: id,
      kind: 'set',
      field,
      was: row[field] ?? null,
      now: now ?? null,
      base_op_id: chained ? (heads[field] ?? null) : baseOpId,
    });
    row[field] = now ?? null;
    heads[field] = op.op_id;
    return op;
  }

  /** Review resolution only (T15): `delete`/`restore` whatever the local row shows (see `reconcileSet`). */
  async reconcileDeleted(kind: EntityKind, id: string, deleted: boolean, baseOpId: string | null): Promise<Op> {
    const opKind = deleted ? 'delete' : 'restore';
    const spec = this.specFor(kind, opKind);
    if (spec.role !== 'record') throw new OpError(`${opKind} is not allowed on ${kind}`);
    const row = await this.mustRow(kind, id, true);
    const heads = await this.headsFor(id);
    const chained = this.ops.some((o) => o.entity_id === id && (o.kind === 'delete' || o.kind === 'restore'));
    const op = this.op({
      entity_kind: kind,
      entity_id: id,
      kind: opKind,
      base_op_id: chained ? (heads.deleted_at ?? null) : baseOpId,
    });
    row.deleted_at = deleted ? op.client_ts : null;
    row.deleted_by_id = deleted ? this.opts.userId : null;
    row.delete_reason = deleted ? this.ctx.reason : null;
    heads.deleted_at = op.op_id;
    return op;
  }

  /** `link_add`: `ownerId` is the owning record, `key` the rest of the link row. */
  async link(kind: EntityKind, ownerId: string, key: Row): Promise<Op> {
    return this.linkOp(kind, ownerId, key, true);
  }

  /** `link_remove`. */
  async unlink(kind: EntityKind, ownerId: string, key: Row): Promise<Op> {
    return this.linkOp(kind, ownerId, key, false);
  }

  private linkOp(kind: EntityKind, ownerId: string, key: Row, add: boolean): Op {
    const opKind = add ? 'link_add' : 'link_remove';
    const spec = this.specFor(kind, opKind);
    if (spec.role !== 'link' || !spec.owner) throw new OpError(`${opKind} is not allowed on ${kind}`);
    if (isBlank(ownerId)) throw new OpError(`${kind} needs the owning ${spec.owner}`);
    const payload: Row = {};
    for (const [name, value] of Object.entries(key)) {
      if (value === undefined) continue;
      const col = spec.columns[name];
      if (!col) throw new OpError(`Unknown column ${spec.table}.${name}`);
      if (name === spec.owner || name === 'deleted_at' || name === 'deleted_by_id') {
        throw new OpError(`Column ${spec.table}.${name} is not part of the key`);
      }
      checkValue(spec, name, col, value);
      payload[name] = value;
    }
    for (const k of spec.pk) {
      if (k === spec.owner) continue;
      if (payload[k] === undefined || payload[k] === null) {
        throw new OpError(`${kind} needs ${k}`);
      }
    }
    return this.op({ entity_kind: kind, entity_id: ownerId, kind: opKind, payload });
  }

  // ------------------------------------------------------------------ internals

  /**
   * A `level_tag` device (stations, sensors, or a library type saying so) must carry its tag as
   * `display_id`: the server refuses the create otherwise (422, T63), which would hold every later
   * op of this iPad in the outbox. Refused here, at the tap. `level_number` devices may leave it out
   * (the server assigns it, D93). The scheme is read as `deviceIdFor` reads it.
   */
  private async checkDeviceId(payload: Row): Promise<void> {
    if (typeof payload.display_id === 'string' && payload.display_id.trim()) return;
    let scheme = defaultIdScheme(typeof payload.category === 'string' ? payload.category : null);
    if (typeof payload.library_type_id === 'string' && payload.library_type_id) {
      const type = await this.row('library_type', payload.library_type_id);
      if (typeof type?.id_scheme === 'string') scheme = type.id_scheme as typeof scheme;
    }
    if (scheme === 'level_tag') {
      throw new OpError(`A ${typeof payload.category === 'string' ? payload.category : 'device'} needs its drawing tag (e.g. S15) as its ID`);
    }
  }

  private specFor(kind: string, what: string): EntitySpec {
    if (!isOpTarget(kind)) throw new OpError(`${what}: bad entity kind ${kind}`);
    return entity(kind);
  }

  private op(part: Pick<Op, 'entity_kind' | 'entity_id' | 'kind'> & Partial<Op>): Op {
    const op: Op = {
      op_id: uuidv7(),
      project_id: this.opts.projectId,
      user_id: this.opts.userId,
      install_id: this.store.installId,
      client_ts: this.opts.now(),
      field: null,
      was: null,
      now: null,
      payload: null,
      base_op_id: null,
      ...part,
      group_id: this.groupId,
      change_type: this.ctx.change_type,
      reason: this.ctx.reason,
      ruling_id: this.ctx.ruling_id ?? null,
      proposal_id: this.ctx.proposal_id ?? null,
      state: 'pending',
    };
    this.ops.push(op);
    return op;
  }

  private async row(kind: EntityKind, id: string): Promise<Row | null> {
    if (!this.rows.has(id)) this.rows.set(id, await this.store.get<Row>(kind, id));
    return this.rows.get(id) ?? null;
  }

  private async mustRow(kind: EntityKind, id: string, allowDeleted = false): Promise<Row> {
    const row = await this.row(kind, id);
    if (!row) throw new OpError(`Unknown ${kind} ${id}`);
    if (!allowDeleted && row.deleted_at != null) {
      throw new OpError(`${kind} ${id} is deleted; restore it first`);
    }
    return row;
  }

  private async headsFor(id: string): Promise<Record<string, string>> {
    let heads = this.heads.get(id);
    if (!heads) {
      heads = await this.store.fieldHeads(id);
      this.heads.set(id, heads);
    }
    return heads;
  }
}

/**
 * The mutation API a screen holds: one per (store, project, user). Each method builds and
 * applies one op; `group()` builds several that share a `group_id` and applies them together.
 */
export class Editor {
  private readonly opts: Required<EditorOptions>;

  constructor(
    readonly store: Store,
    opts: EditorOptions,
  ) {
    this.opts = { now: () => new Date().toISOString(), ...opts };
  }

  get projectId(): string {
    return this.opts.projectId;
  }

  get userId(): string {
    return this.opts.userId;
  }

  async create(kind: EntityKind, payload: Row, ctx: EditContext): Promise<{ id: string; op: Op }> {
    const b = this.batch(ctx);
    const r = await b.create(kind, payload);
    await this.store.apply(r.op);
    return r;
  }

  /** Returns null (nothing written) when the value is unchanged. */
  async setField(
    kind: EntityKind,
    id: string,
    field: string,
    now: unknown,
    ctx: EditContext,
  ): Promise<Op | null> {
    const op = await this.batch(ctx).setField(kind, id, field, now);
    if (op) await this.store.apply(op);
    return op;
  }

  /** Several fields of one record as one group (`group_id` shared), applied atomically. */
  setFields(kind: EntityKind, id: string, values: Row, ctx: EditContext): Promise<Op[]> {
    return this.group(ctx, (g) => g.setFields(kind, id, values));
  }

  async delete(kind: EntityKind, id: string, ctx: EditContext): Promise<Op> {
    const op = await this.batch(ctx).delete(kind, id);
    await this.store.apply(op);
    return op;
  }

  async restore(kind: EntityKind, id: string, ctx: EditContext): Promise<Op> {
    const op = await this.batch(ctx).restore(kind, id);
    await this.store.apply(op);
    return op;
  }

  async link(kind: EntityKind, ownerId: string, key: Row, ctx: EditContext): Promise<Op> {
    const op = await this.batch(ctx).link(kind, ownerId, key);
    await this.store.apply(op);
    return op;
  }

  async unlink(kind: EntityKind, ownerId: string, key: Row, ctx: EditContext): Promise<Op> {
    const op = await this.batch(ctx).unlink(kind, ownerId, key);
    await this.store.apply(op);
    return op;
  }

  /**
   * Resolve a review item (T15, PLAN §3.3): the Reconcile op(s) on the subject plus the item's
   * resolution fields, as one group. See `review.ts`.
   */
  resolve(itemId: string, choice: ResolveChoice, opts?: ResolveOptions): Promise<ResolveResult> {
    return resolveReview(this, itemId, choice, opts);
  }

  /**
   * Grouped edit: every op built inside `fn` shares one `group_id` and they are applied in one
   * transaction (all or nothing). Returns the ops applied, in build order.
   */
  async group(ctx: EditContext, fn: (g: EditBatch) => Promise<unknown>): Promise<Op[]> {
    const g = new EditBatch(this.store, this.opts, ctx, uuidv7());
    await fn(g);
    if (g.ops.length === 0) return [];
    await this.store.applyMany(g.ops);
    return g.ops;
  }

  private batch(ctx: EditContext): EditBatch {
    return new EditBatch(this.store, this.opts, ctx, null);
  }
}
