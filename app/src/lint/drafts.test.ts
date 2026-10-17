/**
 * Drafts without a device (T100, D209): the Lint view lists the open rule drafts no device card
 * shows — R3c's Neuron ID item on a numbering group, R2e's Unison pair on a level — in floor
 * order, filtered by level, and they are decided through the card's `ProposalDecider`.
 */

import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { engineFor, ruleDecider } from '../rules/engine';
import { loadLintView } from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_700_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const g6 = uuidv7();
  const ids = { l03: uuidv7(), l06: uuidv7(), l06m: uuidv7(), nsps: uuidv7(), s1: uuidv7(), s2: uuidv7() };
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l03, project_id: PROJECT, level: '03', floor_order: 4, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('level', { id: ids.l06, project_id: PROJECT, level: '06', floor_order: 7, numbering_group_id: g6, in_scope: true });
    await g.create('level', { id: ids.l06m, project_id: PROJECT, level: '06M', floor_order: 8, numbering_group_id: g6, in_scope: true });
    // R2e: an NSPS and no Unison row on 03 (R2d's 120V draft is on the device: the card's, not listed)
    await g.create('device', { id: ids.nsps, level_id: ids.l03, display_id: '03-01', category: 'NSPS', device: 'P-NSPS-D' });
    // R3c: stations with no Neuron ID on 06 and 06M (one numbering group)
    await g.create('device', { id: ids.s1, level_id: ids.l06, display_id: '06-S1', category: 'Station', status: 'Installed, untested' });
    await g.create('device', { id: ids.s2, level_id: ids.l06m, display_id: '06M-S1', category: 'Station', status: 'Installed, untested' });
  });
  const engine = engineFor(store, PROJECT, ME);
  await engine.run();
  return { store, engine, ids };
}

describe('Lint view: drafts without a device', () => {
  it('lists R2e on its level and R3c on its numbering group in floor order, not the card\'s drafts', async () => {
    const { store, ids } = await setup();
    const v = await loadLintView(store, PROJECT);
    expect(v.drafts.map((d) => [d.ruleId, d.kind, d.subject, d.levelCode])).toEqual([
      ['R2e', 'cable', 'Level 03', '03'],
      ['R3c', 'punch', 'Levels 06/06M', '06'],
    ]);
    const r3c = v.drafts[1]!;
    expect(r3c).toMatchObject({ title: 'Missing all Device Neuron IDs', sub: 'Information · EC · Open', why: expect.stringMatching(/2 devices on Levels 06\/06M have no Neuron ID/) });
    expect(r3c.payload.notes).toBe('06-S1, 06M-S1');
    expect(r3c.editable).toContain('notes');
    // lint.neuron_item names the same group: the draft says a finding points at it
    const neuronFinding = v.groups.flatMap((g) => g.rows).find((r) => r.lintId === 'lint.neuron_item');
    expect(r3c.findingIds).toEqual([neuronFinding!.id]);
    expect(v.drafts[0]).toMatchObject({ title: 'U → Unison from stations & sensors', deviceId: ids.nsps, device: expect.stringMatching(/^03-01/) });
    expect(r3c).toMatchObject({ deviceId: null, device: null });
    // the NSPS's 120V draft (subject: the device) stays on its card
    const all = await store.list<Record<string, unknown>>('proposal', { where: `state = 'proposed'` });
    expect(all.some((p) => p.rule_id === 'R2d')).toBe(true);

    expect((await loadLintView(store, PROJECT, { levelId: ids.l06 })).drafts.map((d) => d.ruleId)).toEqual(['R3c']);
    expect((await loadLintView(store, PROJECT, { levelId: ids.l06m })).drafts).toEqual([]);
    expect((await loadLintView(store, PROJECT, { dismissed: true })).drafts).toEqual([]);
  });

  it('Accept / Edit / Reject through the card\'s decider take the draft off the list', async () => {
    const { store, engine } = await setup();
    const decider = ruleDecider(store, PROJECT, ME);
    const v = await loadLintView(store, PROJECT);
    const [r2e, r3c] = v.drafts;
    expect(await decider.explain(r3c!.id)).toMatch(/Missing all Device Neuron IDs/);

    await decider.decide(r3c!.id, { kind: 'edit', payload: { ...r3c!.payload, notes: '06-S1, 06M-S1 (checked)' } });
    const items = await store.list<Record<string, unknown>>('punch_item', { where: `item = 'Missing all Device Neuron IDs'` });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'Information', owner: 'EC', rule_id: 'R3c' });
    await decider.decide(r2e!.id, { kind: 'reject' });
    await engine.run();

    const after = await loadLintView(store, PROJECT);
    expect(after.drafts).toEqual([]);
    expect(after.groups.flatMap((g) => g.rows).map((r) => r.lintId)).not.toContain('lint.neuron_item');
  });
});
