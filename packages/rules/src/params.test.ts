/**
 * Rule parameters (T102, D176, D211): the catalogue's defaults are D175's readings, templates
 * fill and parse, stored values resolve and compact, and over a store a changed parameter
 * rewords the open drafts and re-offers a rejected one while an accepted item keeps its text;
 * a project reads its own rows only (app-level defaults are copied at creation, never read live).
 */

import { Editor, LIBRARY_STREAM, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from './engine';
import { DEFAULT_PARAMS, PARAMS, RuleParams, fillTemplate, resolveValue, ruleParamId, templatePattern, type RuleParamRow } from './params';
import { compactValue, decideRuleParam, loadRuleParamRows, loadRuleParams, setRuleParam } from './params-store';
import { codeValue, paramGroups, withCode } from './params-view';
import { inputsHash } from './rule';
import { RULES } from './rules';
import { runQuickAction } from './rules/quick';
import type { ProposalRow } from './snapshot';

type Row = Record<string, unknown>;

describe('the catalogue', () => {
  it('has one entry per (rule, key), each default valid for its kind', () => {
    const keys = PARAMS.map((p) => `${p.rule}.${p.key}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PARAMS) expect(resolveValue(p, null), `${p.rule}.${p.key}`).toEqual(p.default);
  });

  it('defaults are the D175 / D177 / D210 readings', () => {
    const d = DEFAULT_PARAMS;
    expect(d.code('R3a', 'run.owner', 'X')).toBe('EC');
    expect(['X', 'N', 'NG', 'U', 'F', '0-10V', '120V', 'P'].map((c) => d.code('R3a', 'terminate.owner', c))).toEqual(['EC/ETC', 'ETC', 'ETC', 'ETC', 'EC/ETC', 'EC', 'EC', 'EC']);
    expect(d.code('R3a', 'run.item', '0-10V')).toBe('Run and land 0-10V control wiring');
    expect(d.code('R3a', 'run.item', 'U')).toBe('Run <signal> to <far end>');
    expect(d.get('R3a', 'run.end')).toBe('A');
    expect(d.code('R3', 'signal', 'X')).toBe('DMX');
    expect(d.code('R3', 'signal', 'ZZ')).toBe('ZZ'); // an unknown code stands for itself
    expect([d.get('R3b', 'item'), d.get('R3b', 'owner'), d.get('R3b', 'notes')]).toEqual(['Terminate DMX to <far end>', 'EC/ETC', 'Waiting on DMX Termination Kits']);
    expect([d.get('R3c', 'item'), d.get('R3c', 'owner'), d.get('R3c', 'device_text')]).toEqual(['Missing all Device Neuron IDs', 'EC', 'All devices']);
    expect([d.get('R2f', 'status'), d.get('R5', 'enabled'), d.get('R2c', 'panic.status')]).toEqual(['Not started', true, 'Installed, untested']);
  });

  it('row ids hash (scope, rule, key) as the server does (app/rule_params.py)', () => {
    expect(ruleParamId('0190a5f0-0000-7000-8000-00000000bb01', 'R3a', 'run.owner')).toBe('289c65cf-65d0-8258-9abf-13498da2d220');
    expect(ruleParamId(null, 'R3b', 'owner')).toBe('08f01162-46c8-8102-855c-96f79160e687');
  });
});

describe('templates', () => {
  it('fill placeholders and drop an empty one with its joining word', () => {
    expect(fillTemplate('Run <signal> to <far end>', { signal: 'DMX', 'far end': 'Level B1 CTB1LCPB' })).toBe('Run DMX to Level B1 CTB1LCPB');
    expect(fillTemplate('Run <signal> to <far end>', { signal: 'DMX', 'far end': null })).toBe('Run DMX');
    expect(fillTemplate('Spot check: <found>', { found: '' })).toBe('Spot check');
    expect(fillTemplate('Land 0-10V control wiring', { signal: '0-10V', 'far end': 'Fixtures' })).toBe('Land 0-10V control wiring');
  });

  it('parse back what they made', () => {
    expect(templatePattern('Terminate DMX to <far end>', 'far end').exec('Terminate DMX to Level B1 CTB1LCPB')?.[1]).toBe('Level B1 CTB1LCPB');
    expect(templatePattern('<far end>: DMX kit (<signal>)', 'far end').exec('06M-03: DMX kit (DMX)')?.[1]).toBe('06M-03');
    expect(templatePattern('Terminate DMX to <far end>', 'far end').test('Run DMX to x')).toBe(false);
  });
});

describe('resolving and compacting values', () => {
  it('merges a per-code map over the default and drops bad entries; a bad plain value is the default', () => {
    const spec = PARAMS.find((p) => p.rule === 'R3a' && p.key === 'terminate.owner')!;
    expect(resolveValue(spec, { N: 'EC', X: 'GC', '': 'ETC' })).toEqual({ ...(spec.default as object), N: 'EC' });
    const owner = PARAMS.find((p) => p.rule === 'R3b' && p.key === 'owner')!;
    expect(resolveValue(owner, 'ETC/EC')).toBe('EC/ETC');
  });

  it('stores only what differs from the default, and refuses what the parameter cannot take', () => {
    expect(compactValue('R3a', 'terminate.owner', { '*': 'EC', N: 'EC', X: 'EC/ETC' })).toEqual({ N: 'EC' });
    expect(compactValue('R3a', 'terminate.owner', { N: 'ETC' })).toBeNull();
    expect(compactValue('R3b', 'owner', 'EC/ETC')).toBeNull();
    expect(compactValue('R3b', 'owner', 'ETC')).toBe('ETC');
    expect(compactValue('R5', 'enabled', false)).toBe(false);
    expect(compactValue('R2d', 'status', '')).toBeNull();
    expect(compactValue('R2c', 'panic.status', '')).toBe('');
    expect(() => compactValue('R3b', 'owner', 'ETC/EC')).toThrow(/not allowed/);
    expect(() => compactValue('R3c', 'item', '  ')).toThrow(/not allowed/);
    expect(() => compactValue('R9', 'x', 'y')).toThrow(/Unknown rule parameter/);
  });

  it('reads accepted, live rows only', () => {
    const row = (p: Partial<RuleParamRow>): RuleParamRow => ({ id: uuidv7(), project_id: 'p', rule_id: 'R3b', key: 'owner', value: 'ETC', state: 'accepted', deleted_at: null, ...p });
    expect(new RuleParams([row({})]).get('R3b', 'owner')).toBe('ETC');
    expect(new RuleParams([row({ state: 'draft' })]).get('R3b', 'owner')).toBe('EC/ETC');
    expect(new RuleParams([row({ deleted_at: '2026-10-16T00:00:00Z' })]).get('R3b', 'owner')).toBe('EC/ETC');
    expect(new RuleParams([row({ value: null })]).get('R3b', 'owner')).toBe('EC/ETC');
  });

  it('the Rules tab lists every group with its rule text and per-code rows', () => {
    const groups = paramGroups([]);
    expect(groups.map((g) => g.rule)).toEqual(['R3', 'R3a', 'R3b', 'R3c', 'R4a', 'R4b', 'R2c', 'R2d', 'R2e', 'R2f', 'R5', 'E5', 'E6', 'E7', 'E9', 'not_found']);
    expect(groups.find((g) => g.rule === 'R3a')!.text).toMatch(/Run <signal> to <far end>/);
    const owner = groups.find((g) => g.rule === 'R3a')!.items.find((i) => i.spec.key === 'terminate.owner')!;
    expect(owner.codes[0]).toBe('*');
    expect(codeValue(owner, 'N')).toEqual({ value: 'ETC', inherited: false });
    expect(codeValue(owner, 'P')).toEqual({ value: 'EC', inherited: true });
    expect(withCode(owner, 'N', null)).toEqual(owner.spec.default); // N back to its default
    expect(withCode(owner, 'P', 'ETC')).toMatchObject({ P: 'ETC' });
  });
});

// ---------------------------------------------------------------- over a store

const PROJECT = uuidv7();
const ME = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
let clock = 1_760_600_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

async function project() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now: tsNext });
  const ids = { l06: uuidv7(), l07: uuidv7(), group: uuidv7(), g07: uuidv7(), panel: uuidv7(), far: uuidv7(), station: uuidv7() };
  const cables: Record<string, string> = {};
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l06, project_id: PROJECT, level: '06', floor_order: 7, numbering_group_id: ids.group, in_scope: true, surveyed: '2026-10-13' });
    await g.create('level', { id: ids.l07, project_id: PROJECT, level: '07', floor_order: 8, numbering_group_id: ids.g07, in_scope: true });
    await g.create('device', { id: ids.panel, level_id: ids.l06, display_id: '06-01', category: 'Station', device: 'PI1002', neuron_id: 'A1' });
    await g.create('device', { id: ids.far, level_id: ids.l06, display_id: '06-02', category: 'Station', device: 'PI1002', neuron_id: 'A2' });
    await g.create('device', { id: ids.station, level_id: ids.l07, display_id: '07-S1', category: 'Station', device: 'PI1002', neuron_id: 'A3' });
    // three wires not pulled on the panel (X, N, U) and one on 07, whose floor is not surveyed (R5)
    for (const [code, level, device] of [['X', ids.l06, ids.panel], ['N', ids.l06, ids.panel], ['U', ids.l06, ids.panel], ['F', ids.l07, ids.station]] as const) {
      const cable = uuidv7();
      const a = uuidv7();
      const b = uuidv7();
      cables[code] = a;
      await g.create('cable', { id: cable, project_id: PROJECT, cable: code, end_a_id: a, end_b_id: b });
      await g.create('cable_end', { id: a, cable_id: cable, side: 'A', endpoint_kind: 'device', device_id: device, level_id: level, to_text: `${code} to 06-02`, status: 'Not installed', note: 'Not run' });
      await g.create('cable_end', { id: b, cable_id: cable, side: 'B', endpoint_kind: 'device', device_id: ids.far, level_id: ids.l06 });
    }
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now: tsNext });
  return { store, editor, engine, ids, cables };
}

const runDrafts = async (store: Store) =>
  new Map(
    (await store.list<ProposalRow>('proposal', { where: `project_id = ? AND rule_id = 'R3a'`, params: [PROJECT] })).map((p) => [String(p.payload?.cable_end_id), p] as const),
  );

describe('rule parameters over a store', () => {
  it('a project on the defaults hashes its drafts as T34 did', async () => {
    const { store, engine, cables } = await project();
    await engine.run();
    const x = (await runDrafts(store)).get(cables.X!)!;
    expect(x.payload).toMatchObject({ item: 'Run DMX to 06-02', owner: 'EC' });
    expect(x.inputs_hash).toBe(inputsHash({ status: 'Not installed', item: 'Run DMX to 06-02' }));
  });

  it('a changed owner rewords the open draft and re-offers the rejected one; the accepted item keeps its owner', async () => {
    const { store, editor, engine, cables } = await project();
    await engine.run();
    let drafts = await runDrafts(store);
    const accepted = await engine.decide(drafts.get(cables.X!)!.id, { kind: 'accept' });
    const itemId = accepted.recordIds[0]!;
    await engine.decide(drafts.get(cables.N!)!.id, { kind: 'reject' });
    expect((await engine.run()).ops).toBe(0);

    expect(await setRuleParam(editor, 'R3a', 'run.owner', { '*': 'ETC' })).toBe(1);
    const op = (await store.opsFor(ruleParamId(PROJECT, 'R3a', 'run.owner')))[0]!;
    expect(op).toMatchObject({ kind: 'create', change_type: 'Master edit', reason: 'Rule parameter R3a.run.owner' });
    await engine.run();
    drafts = await runDrafts(store);
    expect(drafts.get(cables.U!)).toMatchObject({ state: 'proposed', payload: expect.objectContaining({ owner: 'ETC', item: 'Run Unison to 06-02' }) });
    expect(drafts.get(cables.N!)).toMatchObject({ state: 'proposed', payload: expect.objectContaining({ owner: 'ETC' }) });
    expect(drafts.get(cables.X!)).toMatchObject({ state: 'accepted' });
    expect(await store.get<Row>('punch_item', itemId)).toMatchObject({ item: 'Run DMX to 06-02', owner: 'EC' });
    expect((await engine.run()).ops).toBe(0);

    // a wording follows the same way; back to the default restores the T34 hash
    await setRuleParam(editor, 'R3a', 'run.item', { '*': 'Pull <signal> to <far end>' });
    await engine.run();
    expect((await runDrafts(store)).get(cables.U!)!.payload).toMatchObject({ item: 'Pull Unison to 06-02' });
    await setRuleParam(editor, 'R3a', 'run.item', null);
    await setRuleParam(editor, 'R3a', 'run.owner', null);
    await engine.run();
    const u = (await runDrafts(store)).get(cables.U!)!;
    expect(u.payload).toMatchObject({ item: 'Run Unison to 06-02', owner: 'EC' });
    expect(u.inputs_hash).toBe(inputsHash({ status: 'Not installed', item: 'Run Unison to 06-02' }));
    expect(await store.get<Row>('rule_param', ruleParamId(PROJECT, 'R3a', 'run.owner'))).toMatchObject({ value: null, state: 'accepted' });
    expect(await setRuleParam(editor, 'R3a', 'run.owner', null)).toBe(0); // unchanged: nothing written
  });

  it('R5 off raises the item on a floor nobody has surveyed; R3c and the quick actions read their parameters', async () => {
    const { store, editor, engine, cables, ids } = await project();
    await engine.run();
    expect((await runDrafts(store)).has(cables.F!)).toBe(false);
    await setRuleParam(editor, 'R5', 'enabled', false);
    await engine.run();
    expect((await runDrafts(store)).get(cables.F!)).toMatchObject({ state: 'proposed', payload: expect.objectContaining({ item: 'Run fiber to 06-02' }) });

    await setRuleParam(editor, 'R3', 'signal', { F: 'fibre' });
    await setRuleParam(editor, 'E6', 'owner', 'EC');
    await setRuleParam(editor, 'E6', 'notes', 'Fixed on the spot');
    await engine.run();
    expect((await runDrafts(store)).get(cables.F!)!.payload).toMatchObject({ item: 'Run fibre to 06-02' });
    const e6 = await runQuickAction(editor, ids.station, { kind: 'E6', found: 'loose wire' });
    expect(await store.get<Row>('punch_item', e6.punchItemId!)).toMatchObject({ item: 'Spot check: loose wire', owner: 'EC', notes: 'Fixed on the spot' });
    await editor.setField('device', ids.station, 'neuron_id', null, CTX);
    await setRuleParam(editor, 'R3c', 'owner', 'ETC');
    await engine.run();
    const r3c = await store.list<ProposalRow>('proposal', { where: `rule_id = 'R3c'` });
    expect(r3c[0]!.payload).toMatchObject({ item: 'Missing all Device Neuron IDs', owner: 'ETC', notes: '07-S1' });
  });

  it('app-level defaults are drafts until accepted and never move a project (copied at creation instead)', async () => {
    const { store, engine, cables } = await project();
    const library = new Editor(store, { projectId: LIBRARY_STREAM, userId: ME, now: tsNext });
    await setRuleParam(library, 'R3a', 'run.owner', { '*': 'ETC' });
    const id = ruleParamId(null, 'R3a', 'run.owner');
    expect(await store.get<Row>('rule_param', id)).toMatchObject({ project_id: null, state: 'draft', value: { '*': 'ETC' } });
    expect(paramGroups(await loadRuleParamRows(store, null), { app: true }).find((g) => g.rule === 'R3a')!.items.find((i) => i.spec.key === 'run.owner')).toMatchObject({ set: true, state: 'draft' });
    await decideRuleParam(library, 'R3a', 'run.owner', 'accepted');
    expect(await store.get<Row>('rule_param', id)).toMatchObject({ state: 'accepted' });
    // a new value is a draft again
    await setRuleParam(library, 'R3a', 'run.owner', { '*': 'EC/ETC' });
    expect(await store.get<Row>('rule_param', id)).toMatchObject({ state: 'draft' });
    // the project still reads its own (none): defaults
    expect((await loadRuleParams(store, PROJECT)).code('R3a', 'run.owner', 'X')).toBe('EC');
    await engine.run();
    expect((await runDrafts(store)).get(cables.U!)!.payload).toMatchObject({ owner: 'EC' });
    const projectEditor = new Editor(store, { projectId: PROJECT, userId: ME, now: tsNext });
    await expect(decideRuleParam(projectEditor, 'R3a', 'run.owner', 'accepted')).rejects.toThrow(/applies at once/);
  });
});
