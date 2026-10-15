/**
 * The app's rule wiring (T33, T34): the real rules over the demo store raise the card's drafts,
 * the card's decider accepts / edits / rejects them (Accept creates the record the card then
 * shows, "why?" comes from the engine), and the runner re-evaluates a store whose projects change.
 */

import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, ensureDemoCardExtras, ensureDemoLevel } from '../plan/demo';
import { engineFor, ruleDecider, startRules } from './engine';

const ME = uuidv7();

async function demo() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  await ensureDemoCardExtras(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  const panel = plan.devices.find((d) => d.label === '06M-01')!;
  const run = await engineFor(store, plan.level.projectId, ME).run();
  return { store, pid: plan.level.projectId, panel, run };
}

describe('the rules over the demo card', () => {
  it('raise the drafts and findings the seed used to fake, with the rule texts', async () => {
    const { store, pid, panel, run } = await demo();
    expect(run.problems).toBe(0);
    const card = (await loadDeviceCard(store, panel.id))!;
    expect(card.drafts.map((d) => `${d.ruleId} ${d.title}`).sort()).toEqual(
      ['R2c P → EBDK panic wire', 'R3a Land 0-10V control wiring', 'R3a Run Unison to Stations & Sensors', 'R3b Terminate DMX to 06M-03'].sort(),
    );
    // T36: the panel has no P row, so the lint names what the R2c draft would add
    expect(card.findings.map((f) => f.lintId).sort()).toEqual(['Acc', 'R1.untested', 'lint.relay_cables']);
    const decider = ruleDecider(store, pid, ME);
    expect(decider.wired).toBe(true);
    const r3b = card.drafts.find((d) => d.ruleId === 'R3b')!;
    expect(await decider.explain(r3b.id)).toMatch(/^R3b — DMX termination kit item: A DMX \(X\) end that is Issue "no term kit".*\nC-03 is Issue "Run, not terminated; no term kit": the DMX run waits for a termination kit\.$/s);
  });

  it('Accept creates the punch item with rule_id/proposal_id and the draft leaves the card', async () => {
    const { store, pid, panel } = await demo();
    const decider = ruleDecider(store, pid, ME);
    const before = (await loadDeviceCard(store, panel.id))!;
    const r3a = before.drafts.find((d) => d.title === 'Run Unison to Stations & Sensors')!;
    expect(r3a.editable).toEqual(['item', 'type', 'owner']);
    await decider.decide(r3a.id, { kind: 'accept' });
    const after = (await loadDeviceCard(store, panel.id))!;
    expect(after.drafts.map((d) => d.ruleId)).toEqual(['R2c', 'R3a', 'R3b']);
    const added = after.punch.find((p) => p.item === 'Run Unison to Stations & Sensors')!;
    expect(added).toMatchObject({ type: 'Cable not run', owner: 'EC', tracking: 'Open', open: true });
    expect(await store.get('punch_item', added.id)).toMatchObject({ rule_id: 'R3a', proposal_id: r3a.id, device_id: panel.id, device_text: null });
    // the item's create op carries the proposal
    expect((await store.opsFor(added.id))[0]).toMatchObject({ proposal_id: r3a.id, reason: 'Accept R3a: Run Unison to Stations & Sensors' });
    // the next run leaves the accepted draft alone
    expect((await engineFor(store, pid, ME).run()).ops).toBe(0);
  });

  it('Edit saves the edited text; Reject hides the draft until its inputs change', async () => {
    const { store, pid, panel } = await demo();
    const decider = ruleDecider(store, pid, ME);
    const card = (await loadDeviceCard(store, panel.id))!;
    const r3a = card.drafts.find((d) => d.title === 'Run Unison to Stations & Sensors')!;
    const r3b = card.drafts.find((d) => d.ruleId === 'R3b')!;
    await decider.decide(r3a.id, { kind: 'edit', payload: { item: 'Run Unison bus to Stations & Sensors' } });
    expect((await loadDeviceCard(store, panel.id))!.punch.map((p) => p.item)).toContain('Run Unison bus to Stations & Sensors');
    expect(await store.get('proposal', r3a.id)).toMatchObject({ state: 'edited', decided_by_id: ME });
    await decider.decide(r3b.id, { kind: 'reject' });
    expect((await loadDeviceCard(store, panel.id))!.drafts.map((d) => d.ruleId)).toEqual(['R2c', 'R3a']);
    expect(await store.get('proposal', r3b.id)).toMatchObject({ state: 'rejected' });
    expect((await engineFor(store, pid, ME).run()).ops).toBe(0);
    await expect(decider.decide(uuidv7(), { kind: 'accept' })).rejects.toThrow(/Unknown proposal/);
  });
});

describe('startRules', () => {
  it('runs the engine for every project at start and after a change; a run over unchanged data writes nothing', async () => {
    const { store, pid } = await demo();
    const engine = engineFor(store, pid, ME);
    const seen: number[] = [];
    const run = engine.run.bind(engine);
    engine.run = async () => {
      const r = await run();
      seen.push(r.ops);
      return r;
    };
    const stop = startRules(store, ME, async () => [pid], 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([0]); // `demo()` already ran the rules once
    const editor = new Editor(store, { projectId: pid, userId: ME });
    const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    await editor.setField('device', plan.devices[0]!.id, 'notes', 'changed', { change_type: 'Field survey', reason: 'test' });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([0, 0]);
    stop();
  });
});
