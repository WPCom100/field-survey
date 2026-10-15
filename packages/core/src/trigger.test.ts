/**
 * The debounced trigger (T33): fires once per burst of commits, once after a pull, never on
 * the engine's own proposal/finding ops, and runs the handler one at a time.
 */

import { describe, expect, it } from 'vitest';

import { Editor, type EditContext } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import { Store } from './store';
import { DebouncedTrigger } from './trigger';

const PROJECT = uuidv7();
const LEVEL = uuidv7();
const ME = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

/** Manual timers: the test decides when the quiet period ends. */
function timers() {
  const queue: { fn: () => void; id: number }[] = [];
  let n = 0;
  return {
    setTimer: (fn: () => void) => {
      const id = ++n;
      queue.push({ fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    pending: () => queue.length,
    elapse: async () => {
      const due = queue.splice(0);
      for (const q of due) q.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME });
  const t = timers();
  const trigger = new DebouncedTrigger(store, { delayMs: 500, setTimer: t.setTimer, clearTimer: t.clearTimer });
  return { store, editor, t, trigger };
}

describe('DebouncedTrigger', () => {
  it('fires once after a burst of local commits, with the project ids', async () => {
    const { editor, t, trigger } = await setup();
    const fired: string[][] = [];
    trigger.start(async (projects) => {
      fired.push(projects);
    });
    const { id } = await editor.create('device', { level_id: LEVEL, display_id: '06M-01' }, CTX);
    await editor.setField('device', id, 'status', 'Issue', CTX);
    await editor.setField('device', id, 'notes', 'a', CTX);
    expect(fired).toEqual([]);
    expect(t.pending()).toBe(1); // re-armed, one timer
    await t.elapse();
    expect(fired).toEqual([[PROJECT]]);
    expect(trigger.fired).toBe(1);
    await t.elapse(); // nothing pending: no second firing
    expect(fired).toHaveLength(1);
  });

  it('fires after a pull and ignores changes that touch only proposals and findings', async () => {
    const { store, editor, t, trigger } = await setup();
    const sources: string[] = [];
    trigger.start(async (_p, s) => {
      sources.push([...s].join('+'));
    });
    await editor.create('proposal', { project_id: PROJECT, rule_id: 'R1', kind: 'punch', state: 'proposed' }, CTX);
    await editor.create('finding', { project_id: PROJECT, lint_id: 'R1', state: 'open' }, CTX);
    expect(t.pending()).toBe(0);
    await store.applyRemote({
      op_id: uuidv7(), project_id: PROJECT, user_id: uuidv7(), install_id: 'other', client_ts: new Date().toISOString(),
      entity_kind: 'device', entity_id: uuidv7(), kind: 'create', payload: { level_id: LEVEL }, change_type: 'Field survey',
      server_seq: 1, server_ts: new Date().toISOString(), state: 'applied',
    } as Op);
    expect(t.pending()).toBe(1);
    await t.elapse();
    expect(sources).toEqual(['remote']);
  });

  it('runs the handler one at a time and once more when a change lands mid-run; stop() ends it', async () => {
    const { editor, t, trigger } = await setup();
    let release: () => void = () => {};
    const runs: number[] = [];
    trigger.start(async () => {
      runs.push(runs.length + 1);
      if (runs.length === 1) await new Promise<void>((r) => (release = r));
    });
    const { id } = await editor.create('device', { level_id: LEVEL }, CTX);
    await t.elapse(); // run 1 starts and blocks
    expect(runs).toEqual([1]);
    await editor.setField('device', id, 'notes', 'while running', CTX);
    await t.elapse(); // the timer fires during run 1: queued, not started
    expect(runs).toEqual([1]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await trigger.flush();
    expect(runs).toEqual([1, 2]);
    trigger.stop();
    await editor.setField('device', id, 'notes', 'after stop', CTX);
    expect(t.pending()).toBe(0);
    // request() arms it by hand (start-up pass)
    trigger.start(async () => {
      runs.push(runs.length + 1);
    });
    trigger.request([PROJECT]);
    await t.elapse();
    expect(runs).toEqual([1, 2, 3]);
  });
});
