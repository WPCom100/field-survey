/**
 * The app's rule wiring (T33): the card's decider over the demo store (Accept creates the
 * record the card then shows, Reject hides the draft, "why?" comes from the engine), and the
 * runner over a store whose projects change.
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
  return { store, pid: plan.level.projectId, panel };
}

describe('ruleDecider on the demo card', () => {
  it('Accept creates the punch item with rule_id/proposal_id and the draft leaves the card', async () => {
    const { store, pid, panel } = await demo();
    const decider = ruleDecider(store, pid, ME);
    expect(decider.wired).toBe(true);
    const before = (await loadDeviceCard(store, panel.id))!;
    const r3a = before.drafts.find((d) => d.ruleId === 'R3a')!;
    expect(r3a.editable).toEqual(['item', 'type', 'owner', 'tracking_status']);
    await decider.decide(r3a.id, { kind: 'accept' });
    const after = (await loadDeviceCard(store, panel.id))!;
    expect(after.drafts.map((d) => d.ruleId)).toEqual(['R4b']);
    const added = after.punch.find((p) => p.item === 'Run Unison to Stations & Sensors')!;
    expect(added).toMatchObject({ type: 'Cable not run', owner: 'EC', tracking: 'Open', open: true });
    expect(await store.get('punch_item', added.id)).toMatchObject({ rule_id: 'R3a', proposal_id: r3a.id, device_id: panel.id });
    // the item's create op carries the proposal
    expect((await store.opsFor(added.id))[0]).toMatchObject({ proposal_id: r3a.id, reason: 'Accept R3a: Run Unison to Stations & Sensors' });
  });

  it('Edit saves the edited text; Reject hides the draft; why? explains', async () => {
    const { store, pid, panel } = await demo();
    const decider = ruleDecider(store, pid, ME);
    const card = (await loadDeviceCard(store, panel.id))!;
    const [r3a, r4b] = card.drafts;
    await decider.decide(r3a!.id, { kind: 'edit', payload: { item: 'Run Unison bus to Stations & Sensors' } });
    expect((await loadDeviceCard(store, panel.id))!.punch.map((p) => p.item)).toContain('Run Unison bus to Stations & Sensors');
    expect(await store.get('proposal', r3a!.id)).toMatchObject({ state: 'edited', decided_by_id: ME });
    expect(await decider.explain(r4b!.id)).toBe('Rule R4b\nC-03 is Issue "no term kit" (R3b/R4b: one kit per run).');
    await decider.decide(r4b!.id, { kind: 'reject' });
    expect((await loadDeviceCard(store, panel.id))!.drafts).toEqual([]);
    expect(await store.get('proposal', r4b!.id)).toMatchObject({ state: 'rejected' });
    await expect(decider.decide(r4b!.id, { kind: 'reject' })).resolves.toBeUndefined();
    await expect(decider.decide(uuidv7(), { kind: 'accept' })).rejects.toThrow(/Unknown proposal/);
  });
});

describe('startRules', () => {
  it('runs the engine for every project at start and after a change; with no rules it writes nothing', async () => {
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
    expect(seen).toEqual([0]);
    const editor = new Editor(store, { projectId: pid, userId: ME });
    const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    await editor.setField('device', plan.devices[0]!.id, 'notes', 'changed', { change_type: 'Field survey', reason: 'test' });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([0, 0]);
    // the demo's seeded R3a / R4b drafts are not this build's rules: untouched
    expect((await store.list('proposal', { where: `state = 'proposed'` })).length).toBe(2);
    stop();
  });
});
