/**
 * Lint view read model (T36): findings grouped by PLAN §6.3 check in catalogue order or by
 * level, dismissed ones on request with their reason, the vocabulary check's ruling seeds, and
 * this iPad's unnumbered records as a local section. Findings come from the real engine.
 */

import { Editor, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { RULES, RuleEngine } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { loadLintView, seedSummary } from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_600_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const ids = { l03: uuidv7(), l04: uuidv7(), a: uuidv7(), b: uuidv7(), c: uuidv7(), canon: uuidv7(), variant: uuidv7() };
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l03, project_id: PROJECT, level: '03', floor_order: 4, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('level', { id: ids.l04, project_id: PROJECT, level: '04', floor_order: 5, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('device', { id: ids.a, level_id: ids.l03, display_id: '03-S1', category: 'Station', neuron_id: '00A1', notes: 'Empty box on wall' });
    await g.create('device', { id: ids.b, level_id: ids.l04, display_id: '04-S1', category: 'Station', neuron_id: '00A1', notes: 'Empty box on wall' });
    await g.create('device', { id: ids.c, level_id: ids.l04, display_id: '04-S2', category: 'Station', neuron_id: '00B2', status: 'Issue' });
    await g.create('vocab', { id: ids.canon, project_id: PROJECT, list: 'device_note', value: 'Empty box on wall.' });
    await g.create('vocab', { id: ids.variant, project_id: PROJECT, list: 'device_note', value: 'Empty box on wall', canonical_of_id: ids.canon });
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now });
  await engine.run();
  return { store, editor, engine, ids };
}

describe('Lint view', () => {
  it('groups open findings by check in PLAN §6.3 order, with the vocabulary check\'s ruling seed', async () => {
    const { store } = await setup();
    const v = await loadLintView(store, PROJECT);
    expect(v.open).toBe(5);
    expect(v.dismissed).toBe(0);
    expect(v.groups.map((g) => [g.title, g.rows.map((r) => r.subject)])).toEqual([
      ['Issue device without open punch item', ['04-S2 Station']],
      ['Value outside vocabulary', ['03-S1 Station', '04-S1 Station']],
      ['Duplicate Neuron ID', ['03-S1 Station', '04-S1 Station']],
    ]);
    const vocab = v.groups[1]!;
    expect(vocab.rows[0]).toMatchObject({ lintId: 'lint.vocab', levelCode: '03', deviceId: expect.any(String), message: '03-S1: Notes "Empty box on wall" is an old spelling of "Empty box on wall."' });
    expect(vocab.seeds).toHaveLength(1);
    expect(vocab.seeds[0]).toMatchObject({ action: 'rename', entity: 'device', field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.', recordIds: expect.arrayContaining([expect.any(String)]) });
    const codes = new Map(v.levels.map((l) => [l.id, l.code] as const));
    expect(seedSummary(vocab.seeds[0]!, codes)).toBe('Rename "Empty box on wall" to "Empty box on wall." in notes on 2 records (levels 03, 04)');
    expect(v.groups[2]!.hint).toMatch(/scan it again/);
    expect(v.local).toEqual([]);
  });

  it('filters by level, groups by level, and lists dismissed findings with their reason', async () => {
    const { store, engine, ids } = await setup();
    const on04 = await loadLintView(store, PROJECT, { levelId: ids.l04 });
    expect(on04.groups.flatMap((g) => g.rows.map((r) => r.levelCode))).toEqual(['04', '04', '04']);
    const byLevel = await loadLintView(store, PROJECT, { groupBy: 'level' });
    expect(byLevel.groups.map((g) => [g.title, g.rows.length])).toEqual([
      ['Level 03', 2],
      ['Level 04', 3],
    ]);
    const dup = (await loadLintView(store, PROJECT)).groups[2]!.rows[0]!;
    await engine.dismiss(dup.id, 'Same chip read twice; fixed on site');
    const after = await loadLintView(store, PROJECT);
    expect([after.open, after.dismissed]).toEqual([4, 1]);
    expect(after.groups[2]!.rows.map((r) => r.id)).not.toContain(dup.id);
    const dismissed = await loadLintView(store, PROJECT, { dismissed: true });
    expect(dismissed.groups.map((g) => g.rows.map((r) => [r.state, r.dismissedReason]))).toEqual([[['dismissed', 'Same chip read twice; fixed on site']]]);
    expect(dismissed.groups[0]!.seeds).toEqual([]);
  });

  it('lists this iPad\'s records the server accepted but did not number, as a local section', async () => {
    const { store, ids } = await setup();
    await store.applyRemote({
      op_id: uuidv7(), project_id: PROJECT, user_id: ME, install_id: 'other', client_ts: now(),
      entity_kind: 'punch_item', entity_id: uuidv7(), kind: 'create', payload: { level_id: ids.l03, item: 'Gain access', owner: 'EC' },
      change_type: 'Field survey', server_seq: 99, server_ts: now(), state: 'applied',
    } as Op);
    const v = await loadLintView(store, PROJECT);
    expect(v.local).toEqual([{ id: expect.any(String), kind: 'punch item', levelCode: '03', reason: 'unnumbered', text: expect.stringMatching(/no number/) }]);
  });
});
