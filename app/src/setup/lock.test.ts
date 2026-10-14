import { Editor, Store, SyncEngine, rememberProjects, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { BaselineActions, LOCK_REASON, baselineEvents, loadLockTable, lockQuestion, lockWarnings } from './lock';
import { SetupError } from './model';

const ME = uuidv7();
const CTX = { change_type: 'Master edit' as const, reason: 'Project created' };
let ts = 1_760_000_000_000;
const clock = () => new Date((ts += 1000));

/** Tower with 06M (two devices, one placed) and 09 (out of scope), as local ops. */
async function tower() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'ipad', search: 'like' });
  const pid = uuidv7();
  const editor = new Editor(store, { projectId: pid, userId: ME, now: () => clock().toISOString() });
  await editor.create('project', { id: pid, name: 'Tower', settings: {} }, CTX);
  const g = (await editor.create('numbering_group', { project_id: pid, label: '06M' }, CTX)).id;
  const g9 = (await editor.create('numbering_group', { project_id: pid, label: '09' }, CTX)).id;
  const L06M = (await editor.create('level', { project_id: pid, level: '06M', floor_order: 1, numbering_group_id: g, in_scope: true, state: 'setup' }, CTX)).id;
  const L09 = (await editor.create('level', { project_id: pid, level: '09', floor_order: 2, numbering_group_id: g9, in_scope: false, state: 'setup' }, CTX)).id;
  const placed = (await editor.create('device', { level_id: L06M, category: 'Relay panel', device: 'ERP', pin: { sheet_id: uuidv7(), x: 10, y: 20 } }, CTX)).id;
  const unplaced = (await editor.create('device', { level_id: L06M, category: 'Sensor', device: 'PS' }, CTX)).id;
  return { store, pid, editor, L06M, L09, placed, unplaced, actions: new BaselineActions(store, pid, ME, clock) };
}

describe('the lock table (Phase 3 §3.5)', () => {
  it('counts placed devices and open review items per level and words the warnings', async () => {
    const { store, pid, L06M, L09 } = await tower();
    await store.applyRemote({
      op_id: uuidv7(), project_id: pid, user_id: ME, install_id: 'server', client_ts: clock().toISOString(),
      change_type: 'Reconcile', entity_kind: 'review_item', entity_id: uuidv7(), kind: 'create',
      payload: { project_id: pid, level_id: L06M, kind: 'sync_conflict', subject: {}, state: 'open' },
      server_seq: 50, server_ts: new Date(ts).toISOString(), state: 'applied',
    } as Op);
    const [m, far] = await loadLockTable(store, pid);
    expect(m).toMatchObject({ id: L06M, code: '06M', inScope: true, locked: false, devices: 2, placed: 1, inReview: 1 });
    expect(far).toMatchObject({ id: L09, inScope: false, devices: 0 });
    expect(lockWarnings(m!)).toEqual(['1 device not placed', '1 item in review']);
    expect(lockQuestion(m!)).toBe('Lock 06M with 1 device not placed and 1 item in review?');
    expect(lockQuestion({ ...m!, placed: 2, inReview: 0 })).toBe('Lock 06M?');
    expect(lockWarnings({ ...m!, devices: 5, inReview: 0 })).toEqual(['4 devices not placed']);
  });
});

describe('lock and unlock (D57, D164)', () => {
  it('locks with warnings as one Master edit group that sets state, time and who', async () => {
    const { store, pid, L06M, actions } = await tower();
    const before = await store.outboxCount();
    await actions.lock(L06M);
    const ops = (await store.opsFor(L06M)).filter((o) => o.kind === 'set');
    expect(ops.map((o) => [o.field, o.now])).toEqual([
      ['state', 'baseline_locked'],
      ['baseline_locked_at', expect.stringMatching(/^\d{4}-\d\d-\d\dT/)],
      ['baseline_locked_by_id', ME],
    ]);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(ops.every((o) => o.change_type === 'Master edit' && o.reason === LOCK_REASON)).toBe(true);
    expect(await store.outboxCount()).toBe(before + 3);
    const [m] = await loadLockTable(store, pid);
    expect(m).toMatchObject({ locked: true, lockedById: ME });
    expect(m!.lockedAt).toBe(ops[1]!.now);
    // Locking a locked level writes nothing.
    await actions.lock(L06M);
    expect(await store.outboxCount()).toBe(before + 3);
  });

  it('refuses to lock an out-of-scope level and to unlock without a reason', async () => {
    const { store, L06M, L09, actions } = await tower();
    await expect(actions.lock(L09)).rejects.toThrow(SetupError);
    await actions.lock(L06M);
    await expect(actions.unlock(L06M, '   ')).rejects.toThrow(/Say why/);
    expect((await store.get<Record<string, unknown>>('level', L06M))!.state).toBe('baseline_locked');
  });

  it('unlocks with the typed reason, clears the lock fields, and keeps both events in order', async () => {
    const { store, pid, L06M, actions } = await tower();
    await actions.lock(L06M);
    await actions.unlock(L06M, '  Re-import revised riser  ');
    const row = (await store.get<Record<string, unknown>>('level', L06M))!;
    expect(row).toMatchObject({ state: 'setup', baseline_locked_at: null, baseline_locked_by_id: null });
    const unlockOps = (await store.opsFor(L06M)).filter((o) => o.reason === 'Re-import revised riser');
    expect(unlockOps.map((o) => o.field)).toEqual(['state', 'baseline_locked_at', 'baseline_locked_by_id']);
    await actions.lock(L06M);
    expect((await baselineEvents(store, L06M)).map((e) => [e.locked, e.reason])).toEqual([
      [true, LOCK_REASON],
      [false, 'Re-import revised riser'],
      [true, LOCK_REASON],
    ]);
    expect((await loadLockTable(store, pid))[0]!.locked).toBe(true);
  });

  it('a level created locked has no lock event; its unlock is one', async () => {
    const { store, pid, editor, actions } = await tower();
    const g = (await editor.create('numbering_group', { project_id: pid, label: '07' }, CTX)).id;
    const L07 = (await editor.create('level', { project_id: pid, level: '07', floor_order: 3, numbering_group_id: g, in_scope: true, state: 'baseline_locked' }, CTX)).id;
    expect(await baselineEvents(store, L07)).toEqual([]);
    await actions.unlock(L07, 'Wrong floor');
    expect((await baselineEvents(store, L07)).map((e) => [e.locked, e.reason])).toEqual([[false, 'Wrong floor']]);
  });

  it('syncs: a second iPad pulls the locked level', async () => {
    const { store, pid, L06M, actions } = await tower();
    const server = new FakeServer();
    await actions.lock(L06M);
    await new SyncEngine(store, server, { log: () => {} }).sync();
    const other = await Store.open(new BetterSqliteDriver(), { installId: 'ipad-b', search: 'like' });
    await rememberProjects(other, [pid]);
    await new SyncEngine(other, server, { log: () => {} }).sync();
    expect(await other.get<Record<string, unknown>>('level', L06M)).toMatchObject({ state: 'baseline_locked', baseline_locked_by_id: ME });
    expect(await baselineEvents(other, L06M)).toHaveLength(1);
  });
});

describe('History shows where change logging starts (R6)', () => {
  it('puts the lock line between the setup edits and the later field edits, newest first', async () => {
    const { store, editor, L06M, unplaced, actions } = await tower();
    await editor.setField('device', unplaced, 'notes', 'before lock', { change_type: 'Master edit', reason: 'Seed' });
    await actions.lock(L06M);
    await editor.setField('device', unplaced, 'status', 'Issue', { change_type: 'Field survey', reason: 'Field survey' });
    const card = (await loadDeviceCard(store, unplaced))!;
    expect(card.history.map((h) => h.what)).toEqual(['Status', 'Baseline locked (06M)', 'Notes', '(row added)']);
    expect(card.history[1]).toMatchObject({ userId: ME, reason: LOCK_REASON, changeType: 'Master edit', pending: true });
  });
});
