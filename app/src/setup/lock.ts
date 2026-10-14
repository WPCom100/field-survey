/**
 * Lock / unlock a level's baseline (T47, Phase 3 §3.5, D57, D164). Locking sets `state`,
 * `baseline_locked_at` and `baseline_locked_by_id` in one op group and is allowed with warnings;
 * unlocking needs a typed reason and clears them. Both are ops through `Editor`, so they work
 * offline, sync like any edit and stay in the level's op log, which the device History reads
 * to show where change logging starts. No React or Expo imports: tested in Node.
 *
 * The "locked with unreviewed drafts" warning waits for T46 (drafts and flags come with T44/T46).
 */

import { Editor, type Store, type StoredOp } from '@field-survey/core';

import { SetupError } from './model';

export const LOCK_REASON = 'Lock baseline';

export type LockLevel = {
  id: string;
  code: string;
  inScope: boolean;
  locked: boolean;
  lockedAt: string | null;
  lockedById: string | null;
  devices: number;
  /** Devices with a pin on a sheet. */
  placed: number;
  /** Open review items on the level. */
  inReview: number;
};

type Row = Record<string, unknown>;

async function counts(store: Store, sql: string, params: unknown[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await store.db.query<{ level_id: string; n: number }>(sql, params as never)) out.set(r.level_id, r.n);
  return out;
}

/** The §3.5 table: every level of the project in floor order with what the lock dialog warns about. */
export async function loadLockTable(store: Store, projectId: string): Promise<LockLevel[]> {
  const levels = await store.list<Row>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  const devices = await counts(store, `SELECT level_id, count(*) AS n FROM device WHERE deleted_at IS NULL GROUP BY level_id`, []);
  const placed = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM device WHERE deleted_at IS NULL AND pin IS NOT NULL AND pin <> 'null' GROUP BY level_id`,
    [],
  );
  const reviews = await counts(
    store,
    `SELECT level_id, count(*) AS n FROM review_item WHERE deleted_at IS NULL AND state = 'open' AND level_id IS NOT NULL GROUP BY level_id`,
    [],
  );
  return levels.map((l) => {
    const id = String(l.id);
    return {
      id,
      code: String(l.level),
      inScope: l.in_scope !== 0 && l.in_scope !== false,
      locked: l.state === 'baseline_locked',
      lockedAt: typeof l.baseline_locked_at === 'string' ? l.baseline_locked_at : null,
      lockedById: typeof l.baseline_locked_by_id === 'string' ? l.baseline_locked_by_id : null,
      devices: devices.get(id) ?? 0,
      placed: placed.get(id) ?? 0,
      inReview: reviews.get(id) ?? 0,
    };
  });
}

export async function loadLockLevel(store: Store, projectId: string, levelId: string): Promise<LockLevel | null> {
  return (await loadLockTable(store, projectId)).find((l) => l.id === levelId) ?? null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What locking now would leave behind; empty means a clean lock. */
export function lockWarnings(l: LockLevel): string[] {
  const out: string[] = [];
  const unplaced = l.devices - l.placed;
  if (unplaced > 0) out.push(`${plural(unplaced, 'device', 'devices')} not placed`);
  if (l.inReview > 0) out.push(`${plural(l.inReview, 'item', 'items')} in review`);
  return out;
}

/** The dialog's question (§3.5): "Lock 03 with 2 devices not placed and 1 item in review?" */
export function lockQuestion(l: LockLevel): string {
  const w = lockWarnings(l);
  if (!w.length) return `Lock ${l.code}?`;
  const list = w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`;
  return `Lock ${l.code} with ${list}?`;
}

export class BaselineActions {
  private readonly editor: Editor;

  constructor(
    private readonly store: Store,
    projectId: string,
    private readonly userId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.editor = new Editor(store, { projectId, userId, now: () => this.now().toISOString() });
  }

  private async level(levelId: string): Promise<Row> {
    const l = await this.store.get<Row>('level', levelId);
    if (!l || l.deleted_at) throw new SetupError('Unknown level');
    return l;
  }

  /** Lock with or without warnings; change logging starts now (R6). Out-of-scope levels are far ends only and are not locked. */
  async lock(levelId: string): Promise<void> {
    const l = await this.level(levelId);
    if (l.state === 'baseline_locked') return;
    if (l.in_scope === 0 || l.in_scope === false) throw new SetupError(`${String(l.level)} is out of scope (far ends only); it has no baseline to lock`);
    await this.editor.setFields(
      'level',
      levelId,
      { state: 'baseline_locked', baseline_locked_at: this.now().toISOString(), baseline_locked_by_id: this.userId },
      { change_type: 'Master edit', reason: LOCK_REASON },
    );
  }

  /** Back to setup; the typed reason is the op's reason (D57). */
  async unlock(levelId: string, reason: string): Promise<void> {
    const why = reason.trim();
    if (!why) throw new SetupError('Say why the level is unlocked (kept in the history)');
    const l = await this.level(levelId);
    if (l.state !== 'baseline_locked') return;
    await this.editor.setFields(
      'level',
      levelId,
      { state: 'setup', baseline_locked_at: null, baseline_locked_by_id: null },
      { change_type: 'Master edit', reason: why },
    );
  }
}

export type BaselineEvent = { opId: string; at: string; userId: string; locked: boolean; reason: string | null; pending: boolean };

/** Lock and unlock events of a level, oldest first, from its `state` set ops. */
export async function baselineEvents(store: Store, levelId: string): Promise<BaselineEvent[]> {
  // Ops in review, superseded or rejected never changed the level, so they are not events.
  const isState = (o: StoredOp) =>
    (o.state === 'applied' || o.state === 'pending') && ((o.kind === 'set' && o.field === 'state') || o.kind === 'create');
  const out: BaselineEvent[] = [];
  let was: unknown = 'setup';
  for (const o of (await store.opsFor(levelId)).filter(isState)) {
    // A level created locked (the demo) starts there; only a person's lock or unlock is an event.
    const now = o.kind === 'create' ? (o.payload as Row | null)?.state : o.now;
    if (o.kind === 'set' && now !== was && (now === 'baseline_locked' || was === 'baseline_locked')) {
      out.push({ opId: o.op_id, at: o.client_ts, userId: o.user_id, locked: now === 'baseline_locked', reason: o.reason, pending: o.state === 'pending' });
    }
    was = now;
  }
  return out;
}
