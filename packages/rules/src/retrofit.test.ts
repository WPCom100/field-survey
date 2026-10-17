/**
 * Retrofitting accepted items after a parameter change (T116, T120): the selection holds the live
 * rule-made items the change words differently — not a rejected draft, not a field changed by
 * hand, not an item the changed parameter does not word — grouped by field, and the group's
 * `reword` draft, applied as one ruling, writes each record's own wording and leaves nothing.
 */

import { Editor, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from './engine';
import { loadRuleParamRows, setRuleParam } from './params-store';
import { describeRetrofit, retrofitDraft, retrofitReason } from './retrofit';
import { draftFromSelection } from './rulings';
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
    return { groups: await engine.retrofit(before), before };
  };
  return { store, editor, engine, ids, ends, items, parts, change };
}

describe('retrofit after a parameter change', () => {
  it('a changed owner selects the accepted items it words differently, one group per field', async () => {
    const { items, change } = await project();
    const { groups } = await change('R3a', 'run.owner', { '*': 'ETC' });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ entity: 'punch_item', field: 'owner', label: 'Owner', values: ['ETC'], was: ['EC'], levelCodes: ['06'] });
    expect(new Set(groups[0]!.ids)).toEqual(new Set([items.X, items.U])); // the rejected N draft made no item
    expect(describeRetrofit(groups[0]!)).toBe('2 punch items: Owner → "ETC"');
  });

  it('only the codes the change rewords; a parameter that words none of them selects nothing', async () => {
    const { items, change } = await project();
    expect((await change('R3a', 'run.owner', { X: 'EC/ETC' })).groups).toMatchObject([{ field: 'owner', values: ['EC/ETC'], ids: [items.X] }]);
    expect((await change('R3b', 'owner', 'ETC')).groups).toEqual([]); // terminate items: none accepted
    expect((await change('R3c', 'device_text', 'Every device')).groups).toEqual([]); // the Neuron item is not accepted here
  });

  it('a field changed by hand is left alone; an item still on its accepted wording after an earlier change is not', async () => {
    const { editor, items, change } = await project();
    await editor.group(CTX, (g) => g.setField('punch_item', items.U, 'owner', 'EC/ETC'));
    expect((await change('R3a', 'run.owner', { '*': 'ETC' })).groups).toMatchObject([{ values: ['ETC'], ids: [items.X] }]);
    // not retrofitted, then changed again: X still reads its accepted EC and joins
    expect((await change('R3a', 'run.owner', { '*': 'EC/ETC', U: 'ETC' })).groups).toMatchObject([{ values: ['EC/ETC'], ids: [items.X] }]);
  });

  it('a changed template is one reword ruling: a preview row per record with its own wording; apply leaves nothing', async () => {
    const { store, engine, items, change } = await project();
    const { groups, before } = await change('R3a', 'run.item', { '*': 'Pull <signal> to <far end>' });
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect([g.field, new Set(g.ids), new Set(g.values), new Set(g.was)]).toEqual(['item', new Set([items.X, items.U]), new Set(['Pull DMX to 06-02', 'Pull Unison to 06-02']), new Set(['Run DMX to 06-02', 'Run Unison to 06-02'])]);
    expect(describeRetrofit(g)).toBe('2 punch items: Item reworded (2 wordings)');
    const reason = retrofitReason('R3a', 'Run item', { '*': 'Pull <signal> to <far end>' });
    const draft = retrofitDraft(g, reason, before);
    expect(draft).toMatchObject({ text: reason, scope_levels: ['06'], filter: { entity: 'punch_item', where: [], ids: g.ids }, action: { kind: 'reword', field: 'item' }, standing: false });
    const preview = await engine.previewRuling(draft);
    expect(new Set(preview.rows.map((r) => `${r.id}|${r.was}|${r.now}`))).toEqual(new Set([`${items.X}|Run DMX to 06-02|Pull DMX to 06-02`, `${items.U}|Run Unison to 06-02|Pull Unison to 06-02`]));
    expect(preview).toMatchObject({ unworded: [], byHand: 0, problems: [] });
    const applied = await engine.applyRuling(draft);
    expect(applied.records).toBe(2);
    expect(await store.get<Row>('punch_item', items.X)).toMatchObject({ item: 'Pull DMX to 06-02', owner: 'EC' });
    expect(await store.get<Row>('punch_item', items.U)).toMatchObject({ item: 'Pull Unison to 06-02' });
    expect(await engine.retrofit(await loadRuleParamRows(store, PROJECT))).toEqual([]); // no change since: nothing
    expect(await engine.retrofit([])).toEqual([]); // against the defaults: both done
    expect((await engine.previewRuling(draft)).rows).toEqual([]); // applied: already right
  });

  it('a reword leaves a field changed by hand alone and names a record its rule no longer words', async () => {
    const { store, editor, engine, ends, items, change } = await project();
    const { groups, before } = await change('R3a', 'run.item', { '*': 'Pull <signal> to <far end>' });
    await editor.group(CTX, async (g) => {
      await g.setField('punch_item', items.U, 'item', 'Run the Unison wire to 06-02'); // by hand
      await g.setField('cable_end', ends.X!, 'status', 'Installed, untested'); // pulled: R3a words no run on it
    });
    const draft = retrofitDraft(groups[0]!, 'reword', before);
    const preview = await engine.previewRuling(draft);
    expect(preview.rows).toEqual([]);
    expect(preview.byHand).toBe(1);
    expect(preview.unworded?.map((u) => [u.id, u.levelCode])).toEqual([[items.X, '06']]);
    expect((await engine.applyRuling(draft)).records).toBe(0);
    expect(await store.get<Row>('punch_item', items.U)).toMatchObject({ item: 'Run the Unison wire to 06-02' });
    // A reword is one-off: standing is refused; a hand-made reword (no `before`) compares with the accepted wording.
    await expect(engine.applyRuling({ ...draft, standing: true })).rejects.toThrow(/cannot be standing/);
    const plain = { ...draftFromSelection('punch_item', [items.U], ['06']), text: 'reword', action: { kind: 'reword' as const, field: 'owner' } };
    expect((await engine.previewRuling(plain)).rows).toEqual([]); // owner unchanged: EC either way
  });

  it('missing parts: a changed kit wording or parts owner selects the accepted kits', async () => {
    const { parts, change } = await project();
    expect(parts).toHaveLength(2);
    const { groups: worded } = await change('R4b', 'part', { X: 'DMX kit for the <far end> run' });
    expect(worded.map((g) => [g.entity, g.field, new Set(g.values), new Set(g.ids)])).toEqual([['missing_part', 'part', new Set(['DMX kit for the 06-01 run', 'DMX kit for the 06-02 run']), new Set(parts)]]);
    expect(describeRetrofit(worded[0]!)).toBe('2 missing parts: Part reworded (2 wordings)');
    const { groups: owned } = await change('R4a', 'owner', 'ETC');
    expect(owned).toMatchObject([{ entity: 'missing_part', field: 'owner', values: ['ETC'], was: ['EC'] }]);
    expect(new Set(owned[0]!.ids)).toEqual(new Set(parts));
  });
});
