/**
 * In-process stand-in for `POST /ops` / `GET /ops` (server/docs/sync.md) for `SyncEngine`
 * tests. It keeps the parts of the apply loop the engine depends on — contiguous `server_seq`,
 * idempotent `op_id`, heads per field, review on a different user's conflicting `set`, the
 * review-item `create` op, `assign` numbers per numbering group for numbered creates and device
 * IDs per level code (D93) — and offers failure
 * injection (network drops, HTTP refusals, lost responses). Test-only: never imported by the
 * app or the public entry.
 */

import { uuidv7 } from '../ids';
import type { Op } from '../op';
import type { PushAck } from '../store';
import { TransportError, type PullResponse, type PushBody, type PushResponse, type SyncTransport, type TransportFailure } from '../sync';

const SERVER_INSTALL = '00000000-0000-5000-8000-00000000f1e1';
const NUMBERED: Record<string, string> = {
  punch_item: 'number',
  missing_part: 'number',
  photo: 'number',
  cable_end: 'display_id',
};

export interface Fault {
  /** Which call fails. */
  on: 'push' | 'pull' | 'any';
  failure: TransportFailure;
  status?: number;
  /** For pushes: apply the batch, then fail the response (the client never hears back). */
  afterApply?: boolean;
}

export class FakeServer implements SyncTransport {
  readonly log: Op[] = [];
  readonly pushes: PushBody[] = [];
  readonly pulls: { project: string; since: number; limit: number }[] = [];
  private readonly heads = new Map<string, Op>();
  private readonly byId = new Map<string, Op>();
  private readonly serverOpsFor = new Map<string, Op[]>();
  private counters = new Map<string, number>();
  private faults: Fault[] = [];
  /** Ops the server refuses for good (T75): a push containing one fails whole, as the real server rolls back. */
  private readonly poison = new Map<string, { status: number; named: boolean }>();
  private clock = 1_760_000_000_000;

  /** Queue failures; each is consumed by the next matching call. */
  fail(...faults: Fault[]): void {
    this.faults.push(...faults);
  }

  /**
   * Refuse every push containing `opId` with `status`; `named` = the body names the op as the
   * real 422 does (`{detail: {index, op_id, error}}`), else a 409-style `{detail: {error}}`.
   */
  poisonOp(opId: string, status = 422, named = status === 422): void {
    this.poison.set(opId, { status, named });
  }

  curePoison(opId: string): void {
    this.poison.delete(opId);
  }

  get serverSeq(): number {
    return this.log.length;
  }

  ops(projectId?: string): Op[] {
    return projectId ? this.log.filter((o) => o.project_id === projectId) : [...this.log];
  }

  head(entityId: string, field: string): Op | undefined {
    return this.heads.get(`${entityId}|${field}`);
  }

  private takeFault(call: 'push' | 'pull'): Fault | null {
    const i = this.faults.findIndex((f) => f.on === call || f.on === 'any');
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!;
  }

  private throwFault(f: Fault, call: string): never {
    throw new TransportError(f.failure, `${call} failed (${f.failure}${f.status ? ' ' + f.status : ''})`, f.status);
  }

  // ----------------------------------------------------------------- push

  async push(body: PushBody): Promise<PushResponse> {
    const fault = this.takeFault('push');
    if (fault && !fault.afterApply) this.throwFault(fault, 'push');
    if (body.ops.length > 500) throw new TransportError('rejected', 'push → 422', 422);
    const bad = body.ops.findIndex((o) => this.poison.has(o.op_id));
    if (bad >= 0) {
      const { status, named } = this.poison.get(body.ops[bad]!.op_id)!;
      const detail = named
        ? { detail: { index: bad, op_id: body.ops[bad]!.op_id, error: 'bad op (test poison)' } }
        : { detail: { error: 'integrity', detail: 'test poison' } };
      throw new TransportError('rejected', `push → ${status}`, status, detail);
    }
    this.pushes.push(body);
    const results: PushAck[] = [];
    const serverOps: Op[] = [];
    for (const op of body.ops) {
      const existing = this.byId.get(op.op_id);
      if (existing) {
        results.push({ op_id: op.op_id, outcome: 'duplicate', server_seq: existing.server_seq ?? null });
        serverOps.push(...(this.serverOpsFor.get(op.op_id) ?? []));
        continue;
      }
      results.push(this.apply(op, serverOps));
    }
    if (fault?.afterApply) this.throwFault(fault, 'push');
    return { results, server_ops: serverOps, server_seq: this.serverSeq };
  }

  private apply(op: Op, serverOps: Op[]): PushAck {
    const stored = this.store(op, 'applied');
    const caused: Op[] = [];
    switch (op.kind) {
      case 'create': {
        for (const f of Object.keys(op.payload ?? {})) if (f !== 'id') this.setHead(op.entity_id, f, stored);
        const field = NUMBERED[op.entity_kind];
        // Like the server, a create without a level stays unnumbered (`assign_skipped`, D84).
        if (field && (op.payload ?? {}).level_id) {
          const key = `${this.groupOf(op)}|${op.entity_kind}`;
          const n = (this.counters.get(key) ?? 0) + 1;
          this.counters.set(key, n);
          const assign = this.serverOp(stored, {
            entity_kind: op.entity_kind,
            entity_id: op.entity_id,
            kind: 'assign',
            field,
            now: op.entity_kind === 'cable_end' ? `C-${String(n).padStart(2, '0')}` : n,
            reason: 'Numbered',
          });
          this.setHead(op.entity_id, field, assign);
          caused.push(assign);
        }
        if (op.entity_kind === 'device') {
          const assign = this.assignDevice(stored);
          if (assign) caused.push(assign);
        }
        break;
      }
      case 'set': {
        const field = op.field!;
        const head = this.head(op.entity_id, field);
        // Ink layers and photo blobs are last-write-wins (server LAST_WRITE_WINS_*, PLAN §3.3).
        const lastWriteWins = op.entity_kind === 'ink_layer' || (op.entity_kind === 'photo' && field.endsWith('_blob'));
        const conflict =
          !lastWriteWins &&
          head &&
          head.op_id !== op.base_op_id &&
          head.user_id !== op.user_id &&
          JSON.stringify(valueOf(head, field)) !== JSON.stringify(op.now);
        if (conflict) {
          stored.state = 'review';
          const item = this.serverOp(stored, {
            entity_kind: 'review_item',
            entity_id: uuidv7(),
            kind: 'create',
            payload: {},
            reason: `Sync conflict on ${op.entity_kind}.${field}`,
          });
          item.payload = {
            id: item.entity_id,
            project_id: op.project_id,
            kind: 'sync_conflict',
            subject: { entity_kind: op.entity_kind, entity_id: op.entity_id, field },
            op_a_id: head!.op_id,
            op_b_id: op.op_id,
            candidates: [candidate('A', head!, field), candidate('B', op, field)],
            ruling: false,
            state: 'open',
          };
          caused.push(item);
          this.serverOpsFor.set(op.op_id, caused);
          serverOps.push(...caused);
          return { op_id: op.op_id, outcome: 'review', server_seq: stored.server_seq ?? null, review_item_id: item.entity_id };
        }
        this.setHead(op.entity_id, field, stored);
        break;
      }
      case 'delete':
      case 'restore':
        this.setHead(op.entity_id, 'deleted_at', stored);
        break;
      default:
        break; // links always apply
    }
    this.serverOpsFor.set(op.op_id, caused);
    serverOps.push(...caused);
    return { op_id: op.op_id, outcome: 'applied', server_seq: stored.server_seq ?? null };
  }

  /**
   * The numbering group a create counts in (D33): its level's `numbering_group_id` from a
   * level create in the log, else the level itself (tests that never create levels get one
   * group per level, so their numbers still start at 1).
   */
  private groupOf(op: Op): string {
    const levelId = (op.payload ?? {}).level_id as string | undefined;
    const level = this.log.find((o) => o.entity_kind === 'level' && o.entity_id === levelId && o.kind === 'create');
    const group = (level?.payload ?? {}).numbering_group_id as string | undefined;
    return `${op.project_id}|${group ?? `level:${levelId ?? '-'}`}`;
  }

  /**
   * D93 like the server (`assign_device`): a device create without `display_id` gets
   * `<level>-<nn>` = highest ever used on that level code + 1 when its scheme is
   * `level_number`; a `level_tag` one is refused with 422 (thrown after storing: the fake does
   * not roll back, so tests that hit it start a fresh server).
   */
  private assignDevice(create: Op): Op | null {
    const payload = create.payload ?? {};
    if (payload.display_id != null) return null;
    const typeOp = this.log.find(
      (o) => o.entity_kind === 'library_type' && o.kind === 'create' && o.entity_id === payload.library_type_id,
    );
    const scheme =
      ((typeOp?.payload ?? {}).id_scheme as string | undefined) ??
      (payload.category === 'Station' || payload.category === 'Sensor' ? 'level_tag' : 'level_number');
    if (scheme === 'level_tag') throw new TransportError('rejected', 'push → 422 (level_tag device needs its tag)', 422);
    const level = this.log.find((o) => o.entity_kind === 'level' && o.kind === 'create' && o.entity_id === payload.level_id);
    const code = (level?.payload ?? {}).level as string | undefined;
    if (!code) return null;
    const re = new RegExp(`^${code}-(\\d+)$`);
    let max = 0;
    for (const o of this.log) {
      if (o.project_id !== create.project_id || o.entity_kind !== 'device') continue;
      const v = o.kind === 'create' ? (o.payload ?? {}).display_id : o.field === 'display_id' ? o.now : null;
      const m = typeof v === 'string' ? re.exec(v) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
    const assign = this.serverOp(create, {
      entity_kind: 'device',
      entity_id: create.entity_id,
      kind: 'assign',
      field: 'display_id',
      now: `${code}-${String(max + 1).padStart(2, '0')}`,
      reason: 'Device ID assigned by the server (D93)',
    });
    this.setHead(create.entity_id, 'display_id', assign);
    return assign;
  }

  private store(op: Op, state: Op['state']): Op {
    this.clock += 1000;
    const stored: Op = {
      ...op,
      server_seq: this.log.length + 1,
      server_ts: new Date(this.clock).toISOString(),
      state,
    };
    this.log.push(stored);
    this.byId.set(stored.op_id, stored);
    return stored;
  }

  private serverOp(cause: Op, part: Partial<Op> & Pick<Op, 'entity_kind' | 'entity_id' | 'kind'>): Op {
    return this.store(
      {
        op_id: uuidv7(),
        project_id: cause.project_id,
        user_id: cause.user_id,
        install_id: SERVER_INSTALL,
        client_ts: new Date(this.clock).toISOString(),
        change_type: cause.change_type,
        base_op_id: cause.op_id,
        field: null,
        was: null,
        now: null,
        payload: null,
        group_id: null,
        reason: null,
        ruling_id: null,
        proposal_id: null,
        ...part,
      },
      'applied',
    );
  }

  private setHead(entityId: string, field: string, op: Op): void {
    this.heads.set(`${entityId}|${field}`, op);
  }

  // ----------------------------------------------------------------- pull

  async pull(projectId: string, since: number, limit: number): Promise<PullResponse> {
    const fault = this.takeFault('pull');
    if (fault) this.throwFault(fault, 'pull');
    this.pulls.push({ project: projectId, since, limit });
    const all = this.log.filter((o) => o.project_id === projectId && (o.server_seq ?? 0) > since);
    const page = all.slice(0, limit);
    const top = this.log.filter((o) => o.project_id === projectId).length
      ? Math.max(...this.log.filter((o) => o.project_id === projectId).map((o) => o.server_seq ?? 0))
      : 0;
    return { ops: page, server_seq: top, has_more: all.length > limit };
  }
}

/** Same shape as the server's `Push.candidate` (server/app/sync.py). */
function candidate(side: 'A' | 'B', op: Op, field: string): Record<string, unknown> {
  return {
    side,
    op_id: op.op_id,
    user_id: op.user_id,
    install_id: op.install_id,
    client_ts: op.client_ts,
    entity_kind: op.entity_kind,
    entity_id: op.entity_id,
    field,
    kind: op.kind,
    value: valueOf(op, field) ?? null,
  };
}

function valueOf(head: Op, field: string): unknown {
  if (head.kind === 'create') return (head.payload ?? {})[field];
  if (head.kind === 'set' || head.kind === 'assign') return head.now;
  return null;
}
