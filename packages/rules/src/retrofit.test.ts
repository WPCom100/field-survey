/**
 * Retrofitting accepted items after a parameter change (T116): the selection holds the live
 * rule-made items the change words differently — not a rejected draft, not a field changed by
 * hand, not an item the changed parameter does not word — grouped by (field, new value), and the
 * group's draft, applied as a ruling, leaves nothing to retrofit.
 */

import { Editor, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from './engine';
import { loadRuleParamRows, setRuleParam } from './params-store';
import { describeRetrofit, retrofitDraft, retrofitReason } from './retrofit';
import { RULES } from './rules';
import type { ProposalRow } from './snapshot';

type Row = Record<string, unknown>;

const PROJECT = uuidv7();
const ME = uuidv7();
const CTX: EditContext = { change_type: 'Correction', reason: 'test' };
let clock = 1_760_700_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

/** A panel on 06 with three wires not pulled (X, N, U) to a far device on the same floor. */
async function project() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now: tsNext });
  const ids = { l06: uuidv7(), group: uuidv7(), panel: uuidv7(), far: uuidv7() };
  const ends: Record<string, string> = {};
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l06, project_id: PROJECT, level: '06', floor_order: 7, numbering_group_id: ids.group, in_scope: true, surveyed: '2026-10-13' });
    await g.create('device', { id: ids.panel, level_id: ids.l06, display_id: '06-01', category: 'Station', device: 'PI1002', neuron_id: 'A1' });
    await g.create('device', { id: ids.far, level_id: ids.l06, display_id: '06-02', category: 'Station', device: 'PI1002', neuron_id: 'A2' });
    for (const code of ['X', 'N', 'U']) {
      const cable = uuidv7();
      const a = uuidv7();
      const b = uuidv7();
      ends[code] = a;
      await g.create('cable', { id: cable, project_id: PROJECT, cable: code, end_a_id: a, end_b_id: b });
      await g.create('cable_end', { id: a, cable_id: cable, side: 'A', endpoint_kind: 'device', device_id: ids.panel, level_id: ids.l06, status: 'Not installed', note: 'Not run' });
      await g.create('cable_end', { id: b, cable_id: cable, side: 'B', endpoint_kind: 'device', device_id: ids.far, level_id: ids.l06 });
    }
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now: tsNext });
  await engine.run();
  const open = async (rule: string) =>
    (await store.list<ProposalRow>('proposal', { where: `project_id = ? AND rule_id = ? AND state = 'proposed'`, params: [PROJECT, rule] })).sort((a, b) =>
      String(a.payload?.item ?? a.payload?.part).localeCompare(String(b.payload?.item ?? b.payload?.part)),
    );
  const runs = new Map((await open('R3a')).map((p) => [String(p.payload?.cable_end_id), p.id] as const));
  // accept the DMX and Unison runs, reject the network one
  const item = async (code: string) => (await engine.decide(runs.get(ends[code]!)!, { kind: 'accept' })).recordIds[0]!;
  const items = { X: await item('X'), U: await item('U') };
  await engine.decide(runs.get(ends.N!)!, { kind: 'reject' });
  await engine.run();
  // R4b: the DMX run's kit at each device end, accepted
  const parts: string[] = [];
  for (const k of await open('R4b')) parts.push((await engine.decide(k.id, { kind: 'accept' })).recordIds[0]!);
  await engine.run();
  /** Change one parameter and return the retrofit selection it leaves. */
  const change = async (rule: string, key: string, value: Parameters<typeof setRuleParam>[3]) => {
    const before = await loadRuleParamRows(store, PROJECT);
    await setRuleParam(editor, rule, key, value);
    await engine.run();
    return engine.retrofit(before);
  };
  return { store, editor, engine, ids, items, parts, change };
}

describe('retrofit after a parameter change', () => {
  it('a changed owner selects the accepted items it words differently, one group per new value', async () => {
    const { items, change } = await project();
    const groups = await change('R3a', 'run.owner', { '*': 'ETC' });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ entity: 'punch_item', field: 'owner', label: 'Owner', value: 'ETC', was: ['EC'], levelCodes: ['06'] });
    expect(new Set(groups[0]!.ids)).toEqual(new Set([items.X, items.U])); // the rejected N draft made no item
    expect(describeRetrofit(groups[0]!)).toBe('2 punch items: Owner → "ETC"');
  });

  it('only the codes the change rewords; a parameter that words none of them selects nothing', async () => {
    const { items, change } = await project();
    expect(await change('R3a', 'run.owner', { X: 'EC/ETC' })).toMatchObject([{ field: 'owner', value: 'EC/ETC', ids: [items.X] }]);
    expect(await change('R3b', 'owner', 'ETC')).toEqual([]); // terminate items: none accepted
    expect(await change('R3c', 'device_text', 'Every device')).toEqual([]); // the Neuron item is not accepted here
  });

  it('a field changed by hand is left alone; an item still on its accepted wording after an earlier change is not', async () => {
    const { editor, items, change } = await project();
    await editor.group(CTX, (g) => g.setField('punch_item', items.U, 'owner', 'EC/ETC'));
    expect(await change('R3a', 'run.owner', { '*': 'ETC' })).toMatchObject([{ value: 'ETC', ids: [items.X] }]);
    // not retrofitted, then changed again: X still reads its accepted EC and joins
    expect(await change('R3a', 'run.owner', { '*': 'EC/ETC', U: 'ETC' })).toMatchObject([{ value: 'EC/ETC', ids: [items.X] }]);
  });

  it('a changed wording groups by the new text; applying the draft as a ruling leaves nothing to retrofit', async () => {
    const { store, engine, items, change } = await project();
    const groups = await change('R3a', 'run.item', { '*': 'Pull <signal> to <far end>' });
    expect(groups.map((g) => [g.field, g.value, g.ids, g.was])).toEqual([
      ['item', 'Pull DMX to 06-02', [items.X], ['Run DMX to 06-02']],
      ['item', 'Pull Unison to 06-02', [items.U], ['Run Unison to 06-02']],
    ]);
    const reason = retrofitReason('R3a', 'Run item', { '*': 'Pull <signal> to <far end>' });
    const draft = retrofitDraft(groups[0]!, reason);
    expect(draft).toMatchObject({ text: reason, scope_levels: ['06'], filter: { entity: 'punch_item', where: [], ids: [items.X] }, action: { kind: 'set', field: 'item', value: 'Pull DMX to 06-02' }, standing: false });
    const preview = await engine.previewRuling(draft);
    expect(preview.rows.map((r) => [r.id, r.was, r.now])).toEqual([[items.X, 'Run DMX to 06-02', 'Pull DMX to 06-02']]);
    await engine.applyRuling(draft);
    expect(await store.get<Row>('punch_item', items.X)).toMatchObject({ item: 'Pull DMX to 06-02', owner: 'EC' });
    expect((await engine.retrofit(await loadRuleParamRows(store, PROJECT))).length).toBe(0); // no change since: nothing
    const left = await engine.retrofit([]); // against the defaults: only U still to do
    expect(left.map((g) => g.ids)).toEqual([[items.U]]);
  });

  it('missing parts: a changed kit wording or parts owner selects the accepted kits', async () => {
    const { parts, change } = await project();
    expect(parts).toHaveLength(2);
    const worded = await change('R4b', 'part', { X: 'DMX kit for the <far end> run' });
    expect(worded.map((g) => [g.entity, g.field, g.value])).toEqual([
      ['missing_part', 'part', 'DMX kit for the 06-01 run'],
      ['missing_part', 'part', 'DMX kit for the 06-02 run'],
    ]);
    expect(describeRetrofit(worded[0]!)).toBe('1 missing part: Part → "DMX kit for the 06-01 run"');
    const owned = await change('R4a', 'owner', 'ETC');
    expect(owned).toMatchObject([{ entity: 'missing_part', field: 'owner', value: 'ETC', was: ['EC'] }]);
    expect(new Set(owned[0]!.ids)).toEqual(new Set(parts));
  });
});
