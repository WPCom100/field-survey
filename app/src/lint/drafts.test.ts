/**
 * Drafts without a device (T100, D209): the Lint view lists the open rule drafts no device card
 * shows — R3c's Neuron ID item on its floor (T169), R2e's Unison pair on a level — in floor
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
    // R3c: on 06 a station with no Neuron ID ("all"); on 06M one without and one with ("some") — one numbering group, an item per floor (T169)
    await g.create('device', { id: ids.s1, level_id: ids.l06, display_id: '06-S1', category: 'Station', status: 'Installed, untested' });
    await g.create('device', { id: ids.s2, level_id: ids.l06m, display_id: '06M-S1', category: 'Station', status: 'Installed, untested' });
    await g.create('device', { level_id: ids.l06m, display_id: '06M-S2', category: 'Station', status: 'Installed, untested', neuron_id: '00A1B2C3D4E5' });
  });
  const engine = engineFor(store, PROJECT, ME);
  await engine.run();
  return { store, engine, ids };
}

describe('Lint view: drafts without a device', () => {
  it('lists R2e on its level and R3c on each floor in floor order, not the card\'s drafts', async () => {
    const { store, ids } = await setup();
    const v = await loadLintView(store, PROJECT);
    expect(v.drafts.map((d) => [d.ruleId, d.kind, d.subject, d.levelCode])).toEqual([
      ['R2e', 'cable', 'Level 03', '03'],
      ['R3c', 'punch', 'Level 06', '06'],
      ['R3c', 'punch', 'Level 06M', '06M'],
    ]);
    const [, r3c06, r3c06m] = v.drafts;
    expect(r3c06).toMatchObject({ title: 'Missing all Device Neuron IDs', sub: 'Information · EC · Open', why: 'The one device on Level 06 that needs a Neuron ID has none.' });
    expect(r3c06!.payload).toMatchObject({ notes: 'All devices on this floor', device_text: 'All devices' });
    expect(r3c06m).toMatchObject({ title: 'Missing some Device Neuron IDs', why: '1 of the 2 devices on Level 06M that need a Neuron ID has none.' });
    expect(r3c06m!.payload).toMatchObject({ notes: '06M-S1', device_text: 'See notes' });
    expect(r3c06!.editable).toContain('notes');
    // lint.neuron_item names the same floors: each draft says a finding points at it
    const neuronFindings = v.groups.flatMap((g) => g.rows).filter((r) => r.lintId === 'lint.neuron_item');
    expect(neuronFindings).toHaveLength(2);
    expect([...r3c06!.findingIds, ...r3c06m!.findingIds].sort()).toEqual(neuronFindings.map((f) => f.id).sort());
    expect(r3c06!.findingIds).toHaveLength(1);
    expect(v.drafts[0]).toMatchObject({ title: 'U → Unison from stations & sensors', deviceId: ids.nsps, device: expect.stringMatching(/^03-01/) });
    expect(r3c06).toMatchObject({ deviceId: null, device: null });
    // the NSPS's 120V draft (subject: the device) stays on its card
    const all = await store.list<Record<string, unknown>>('proposal', { where: `state = 'proposed'` });
    expect(all.some((p) => p.rule_id === 'R2d')).toBe(true);

    expect((await loadLintView(store, PROJECT, { levelId: ids.l06 })).drafts.map((d) => d.subject)).toEqual(['Level 06']);
    expect((await loadLintView(store, PROJECT, { levelId: ids.l06m })).drafts.map((d) => d.subject)).toEqual(['Level 06M']);
    expect((await loadLintView(store, PROJECT, { dismissed: true })).drafts).toEqual([]);
  });

  it('Accept / Edit / Reject through the card\'s decider take the draft off the list', async () => {
    const { store, engine } = await setup();
    const decider = ruleDecider(store, PROJECT, ME);
    const v = await loadLintView(store, PROJECT);
    const [r2e, r3c06, r3c06m] = v.drafts;
    expect(await decider.explain(r3c06!.id)).toMatch(/Missing all Device Neuron IDs/);

    await decider.decide(r3c06!.id, { kind: 'edit', payload: { ...r3c06!.payload, notes: 'All devices on this floor (checked)' } });
    await decider.decide(r3c06m!.id, { kind: 'accept' });
    const items = await store.list<Record<string, unknown>>('punch_item', { where: `rule_id = 'R3c'`, orderBy: 'item' });
    expect(items.map((p) => p.item)).toEqual(['Missing all Device Neuron IDs', 'Missing some Device Neuron IDs']);
    expect(items[0]).toMatchObject({ type: 'Information', owner: 'EC', rule_id: 'R3c' });
    await decider.decide(r2e!.id, { kind: 'reject' });
    await engine.run();

    const after = await loadLintView(store, PROJECT);
    expect(after.drafts).toEqual([]);
    expect(after.groups.flatMap((g) => g.rows).map((r) => r.lintId)).not.toContain('lint.neuron_item');
  });
});
