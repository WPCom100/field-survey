/**
 * Rulings (T37, PLAN §6.4, Phase 3 §8): filter and action, preview with untick, apply as
 * `Ruling` ops with `ruling_id`, standing re-evaluation as proposals, rename → `vocab.canonical_of`,
 * and the hand-offs (lint seed, multi-select).
 */

import { Editor, Store, uuidv7, type EditContext, type StoredOp } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PARAMS } from './params';
import { RuleEngine } from './engine';
import { rulingSeeds } from './lints';
import { RULES } from './rules';
import {
  checkRuling,
  describeRuling,
  draftFromSeed,
  draftFromSelection,
  matches,
  parseRuling,
  previewRuling,
  renamePhrase,
  RulingRule,
  type RulingDraft,
} from './rulings';
import type { FindingRow, ProposalRow } from './snapshot';
import { Build } from './testing/build';
import { indexSnapshot } from './snapshot';

const PROJECT = uuidv7();
const ME = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
let clock = 1_760_600_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();

type Row = Record<string, unknown>;

/** Two levels, a panel with a 0-10V row whose To reads three ways, a sensor, a vocabulary. */
async function project() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now: tsNext });
  const ids = {
    l01: uuidv7(), l03: uuidv7(), g01: uuidv7(), g03: uuidv7(), p01: uuidv7(), p03: uuidv7(), sensor: uuidv7(), fixtures: uuidv7(),
    c1: uuidv7(), c2: uuidv7(), c3: uuidv7(), e1: uuidv7(), e2: uuidv7(), e3: uuidv7(), n1: uuidv7(), ne: uuidv7(),
  };
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l01, project_id: PROJECT, level: '01', floor_order: 3, numbering_group_id: ids.g01, in_scope: true });
    await g.create('level', { id: ids.l03, project_id: PROJECT, level: '03', floor_order: 5, numbering_group_id: ids.g03, in_scope: true });
    await g.create('device', { id: ids.p01, level_id: ids.l01, display_id: '01-01', category: 'Relay panel', device: 'CT01LCPA', notes: 'Empty box on wall' });
    await g.create('device', { id: ids.p03, level_id: ids.l03, display_id: '03-01', category: 'Relay panel', device: 'CT03LCPA', notes: 'Ceiling open; Empty box on wall' });
    await g.create('device', { id: ids.sensor, level_id: ids.l03, display_id: '03-D1', category: 'Sensor', device: 'P-DOC-C-LR' });
    await g.create('placeholder', { id: ids.fixtures, project_id: PROJECT, label: 'Fixtures', kind: 'fixtures' });
    const cable = async (c: string, e: string, dev: string, level: string, to: string, code = '0-10V') => {
      await g.create('cable', { id: c, project_id: PROJECT, cable: code, single_row: true, end_a_id: e });
      await g.create('cable_end', { id: e, cable_id: c, side: 'A', endpoint_kind: 'device', device_id: dev, level_id: level, to_text: to });
    };
    await cable(ids.c1, ids.e1, ids.p01, ids.l01, 'Control wiring');
    await cable(ids.c2, ids.e2, ids.p03, ids.l03, 'Fixtures (east wing)');
    await cable(ids.c3, ids.e3, ids.p03, ids.l03, 'Fixtures');
    // a device_note vocabulary with the right spelling, so a rename can record the old one
    await g.create('vocab', { id: ids.n1, project_id: PROJECT, list: 'device_note', value: 'Empty box on wall.' });
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now: tsNext });
  return { store, editor, engine, ids };
}

const fixtures = (): RulingDraft => ({
  text: '0-10V rows read Fixtures',
  scope_levels: null,
  filter: { entity: 'cable_end', where: [{ field: 'cable', op: 'eq', value: '0-10V' }, { field: 'to_text', op: 'ne', value: 'Fixtures' }] },
  action: { kind: 'set', field: 'to_text', value: 'Fixtures' },
  standing: true,
});

/** Every op of a ruling on the given records (and the ruling row itself). */
const rulingOps = async (store: Store, rulingId: string, entityIds: readonly string[] = []): Promise<StoredOp[]> => {
  const out: StoredOp[] = [];
  for (const id of [rulingId, ...entityIds]) out.push(...(await store.opsFor(id)).filter((o) => o.ruling_id === rulingId));
  return out;
};

const openRuling = (store: Store) => store.list<ProposalRow>('proposal', { where: `project_id = ? AND rule_id = 'ruling' AND state = 'proposed'`, params: [PROJECT], orderBy: 'id' });

describe('filter, action and words (pure)', () => {
  it('reads the seed import\'s D50 ruling (filter {field, values}, action {set}) and scopes by level code', () => {
    const d = parseRuling({
      id: 'r1', text: 'Unison bus placeholder is spelled \'Stations & Sensors\' (D50)', scope_levels: ['01', '03'], standing: true,
      filter: { entity: 'cable_end', field: 'from_text', values: ['Stations and sensors', 'Stations/Sensors'] },
      action: { set: { from_text: 'Stations & Sensors' } },
    })!;
    expect(d.filter.where).toEqual([{ field: 'from_text', op: 'in', value: ['Stations and sensors', 'Stations/Sensors'] }]);
    expect(d.action).toEqual({ kind: 'set', field: 'from_text', value: 'Stations & Sensors' });
    expect(describeRuling(d)).toBe('Connection end · From is one of "Stations and sensors", "Stations/Sensors" · levels 01, 03 → set From = "Stations & Sensors"');

    const b = new Build();
    const l01 = b.level('01');
    const l04 = b.level('04');
    const nsps = b.device(l01, 'NSPS', { display_id: '01-02' });
    const far = b.device(l04, 'NSPS', { display_id: '04-02' });
    b.cable('U', { device: nsps, from_text: 'Stations/Sensors' }, null);
    b.cable('U', { device: far, from_text: 'Stations/Sensors' }, null);
    const p = previewRuling(b.snap, indexSnapshot(b.snap), d);
    expect(p.rows.map((r) => [r.levelCode, r.label, r.was, r.now])).toEqual([['01', 'From', 'Stations/Sensors', 'Stations & Sensors']]); // 04 is out of scope
  });

  it('matches exactly (vocabulary strings), contains ignoring case, phrases split on "; "', () => {
    expect(matches('Fixtures', { field: 'x', op: 'eq', value: 'Fixtures' })).toBe(true);
    expect(matches('fixtures', { field: 'x', op: 'eq', value: 'Fixtures' })).toBe(false);
    expect(matches('Fixtures (east wing)', { field: 'x', op: 'contains', value: 'EAST' })).toBe(true);
    expect(matches('Ceiling open; Empty box on wall', { field: 'x', op: 'has_phrase', value: 'Empty box on wall' })).toBe(true);
    expect(matches('Empty box on wall here', { field: 'x', op: 'has_phrase', value: 'Empty box on wall' })).toBe(false);
    expect(matches(null, { field: 'x', op: 'empty' })).toBe(true);
    expect(matches('B', { field: 'x', op: 'in', value: 'A, B' })).toBe(true);
    expect(renamePhrase('Ceiling open; Empty box on wall', 'Empty box on wall', 'Empty box on wall.')).toBe('Ceiling open; Empty box on wall.');
    expect(renamePhrase('Empty box on wall; Empty box on wall here', 'Empty box on wall', 'X')).toBe('X; Empty box on wall here');
  });

  it('says what is missing before anything can be previewed', () => {
    const d: RulingDraft = { text: ' ', scope_levels: null, filter: { entity: 'punch_item', where: [] }, action: { kind: 'set', field: 'owner', value: 'ETC/EC' }, standing: false };
    expect(checkRuling(d)).toEqual([
      'Give the ruling a reason: it is the Change Log\'s Reason on every change.',
      'Add a condition (or pick records): a ruling never applies to everything unasked.',
      'Owner must be one of: EC · ETC · EC/ETC.',
    ]);
    expect(checkRuling({ ...fixtures(), filter: { entity: 'punch_item', where: [{ field: 'item', op: 'eq', value: 'x' }] }, action: { kind: 'item', item: 'Land 0-10V control wiring', type: 'Wiring', owner: 'EC' } })).toEqual(['Items are generated on devices or connection ends.']);
    expect(checkRuling(fixtures())).toEqual([]);
  });
});

describe('preview and apply (Phase 3 §8)', () => {
  it('previews Level · Ref · Field · Was → Now for the records it would change, skipping those already right', async () => {
    const { engine } = await project();
    const p = await engine.previewRuling(fixtures());
    expect(p.matched).toBe(2); // the third already reads Fixtures (filtered by To ≠ Fixtures)
    expect(p.rows.map((r) => [r.levelCode, r.ref, r.label, r.was, r.now])).toEqual([
      ['01', '01-01 end', 'To', 'Control wiring', 'Fixtures'],
      ['03', '03-01 end', 'To', 'Fixtures (east wing)', 'Fixtures'],
    ]);
    expect(p.levels).toBe(2);
  });

  it('applies the ticked rows as Ruling ops (reason = the text, ruling_id) in one group with the ruling row; an unticked row is kept out for good', async () => {
    const { store, engine, ids } = await project();
    const res = await engine.applyRuling(fixtures(), { skip: [ids.e2] });
    expect(res).toMatchObject({ records: 1, skipped: 1, recordIds: [ids.e1] });
    expect(await store.get<Row>('cable_end', ids.e1)).toMatchObject({ to_text: 'Fixtures' });
    expect(await store.get<Row>('cable_end', ids.e2)).toMatchObject({ to_text: 'Fixtures (east wing)' }); // keeps its qualifier
    const ruling = (await store.get<Row>('ruling', res.rulingId))!;
    expect(ruling).toMatchObject({ project_id: PROJECT, text: '0-10V rows read Fixtures', standing: true, op_count: 1, created_by_id: ME, scope_levels: null });
    expect(ruling.applied_at).toBeTruthy();
    expect((ruling.filter as Row).except).toEqual([ids.e2]);
    const ops = await rulingOps(store, res.rulingId, [ids.e1, ids.e2]);
    expect(ops.map((o) => `${o.entity_kind}:${o.kind}:${o.field ?? ''}`).sort()).toEqual(['cable_end:set:to_text', 'ruling:create:']);
    expect(ops.every((o) => o.change_type === 'Ruling' && o.reason === '0-10V rows read Fixtures' && o.ruling_id === res.rulingId)).toBe(true);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(ops.find((o) => o.entity_kind === 'cable_end')).toMatchObject({ was: 'Control wiring', now: 'Fixtures', user_id: ME });
    // the skipped row is neither previewed again nor proposed by the standing ruling
    const stored = parseRuling((await store.get('ruling', res.rulingId)) as never)!;
    const again = await engine.previewRuling(stored);
    expect(again).toMatchObject({ rows: [], matched: 1, excepted: 1 });
    await engine.run();
    expect(await openRuling(store)).toEqual([]);
  });

  it('a stored ruling applied again counts on, and an apply with nothing ticked still records a standing ruling', async () => {
    const { store, editor, engine, ids } = await project();
    const res = await engine.applyRuling(fixtures(), { skip: [ids.e1, ids.e2] });
    expect(res).toMatchObject({ records: 0, skipped: 2 });
    expect(await store.get<Row>('ruling', res.rulingId)).toMatchObject({ op_count: 0 });
    await editor.setField('cable_end', ids.e3, 'to_text', 'Fixture run', CTX);
    const second = await engine.applyRuling({ ...fixtures(), id: res.rulingId });
    expect(second).toMatchObject({ rulingId: res.rulingId, records: 1 });
    expect(await store.get<Row>('ruling', res.rulingId)).toMatchObject({ op_count: 1 });
    expect(await store.get<Row>('cable_end', ids.e3)).toMatchObject({ to_text: 'Fixtures' });
  });

  it('append note adds the phrase once; generate item makes one Open item per record and none twice', async () => {
    const { store, editor, engine, ids } = await project();
    const append: RulingDraft = {
      text: 'Panels on 03 wait for the ceiling', scope_levels: ['03'], standing: false,
      filter: { entity: 'device', where: [{ field: 'category', op: 'eq', value: 'Relay panel' }] },
      action: { kind: 'append', field: 'notes', text: 'Ceiling open' },
    };
    const p = await engine.previewRuling(append);
    expect(p.matched).toBe(1);
    expect(p.rows).toEqual([]); // 03-01 already has the phrase
    const p2 = await engine.previewRuling({ ...append, scope_levels: null });
    expect(p2.rows.map((r) => [r.ref, r.was, r.now])).toEqual([['01-01', 'Empty box on wall', 'Empty box on wall; Ceiling open']]);

    const item: RulingDraft = {
      text: 'Every 0-10V row gets its landing item', scope_levels: null, standing: false,
      filter: { entity: 'cable_end', where: [{ field: 'cable', op: 'eq', value: '0-10V' }] },
      action: { kind: 'item', item: 'Land 0-10V control wiring', type: 'Wiring', owner: 'EC', notes: '' },
    };
    const r = await engine.applyRuling(item);
    expect(r.records).toBe(3);
    const items = await store.list<Row>('punch_item', { where: `item = 'Land 0-10V control wiring'`, params: [], orderBy: 'id' });
    expect(items).toHaveLength(3);
    expect(items.find((x) => x.cable_end_id === ids.e1)).toMatchObject({ level_id: ids.l01, device_id: ids.p01, type: 'Wiring', owner: 'EC', tracking_status: 'Open', notes: null, rule_id: 'ruling' });
    expect((await engine.previewRuling(item)).rows).toEqual([]);
    // closing one does not bring it back: the ruling made its point on that record
    await editor.setFields('punch_item', items[0]!.id as string, { tracking_status: 'Closed', date_closed: '2026-10-15' }, CTX);
    expect((await engine.previewRuling(item)).rows).toEqual([]);
  });

  it('rename replaces the phrase and records the old spelling in vocab.canonical_of; the vocabulary lint then flags a new use', async () => {
    const { store, editor, engine, ids } = await project();
    const rename: RulingDraft = {
      text: 'Empty box on wall ends with a full stop', scope_levels: null, standing: false,
      filter: { entity: 'device', where: [{ field: 'notes', op: 'has_phrase', value: 'Empty box on wall' }] },
      action: { kind: 'rename', field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' },
    };
    const p = await engine.previewRuling(rename);
    expect(p.vocab).toEqual({ list: 'device_note', from: 'Empty box on wall', to: 'Empty box on wall.' });
    expect(p.rows.map((r) => r.now)).toEqual(['Empty box on wall.', 'Ceiling open; Empty box on wall.']);
    const res = await engine.applyRuling(rename);
    expect(res.records).toBe(2);
    const vocab = await store.list<Row>('vocab', { where: `project_id = ? AND list = 'device_note'`, params: [PROJECT], orderBy: 'value' });
    expect(vocab.map((v) => [v.value, v.canonical_of_id])).toEqual([
      ['Empty box on wall', ids.n1],
      ['Empty box on wall.', null],
    ]);
    const ops = await rulingOps(store, res.rulingId, vocab.map((v) => v.id as string));
    expect(ops.filter((o) => o.entity_kind === 'vocab')).toHaveLength(1); // the new spelling was in the list already
    expect(ops.filter((o) => o.entity_kind === 'vocab').every((o) => o.change_type === 'Ruling' && o.ruling_id === res.rulingId)).toBe(true);
    // the old spelling typed again → lint.vocab with the canonical value as its fix
    await editor.setField('device', ids.sensor, 'notes', 'Empty box on wall', CTX);
    await engine.run();
    const found = await store.list<FindingRow>('finding', { where: `project_id = ? AND lint_id = 'lint.vocab' AND state = 'open'`, params: [PROJECT] });
    expect(found.map((f) => f.subject?.fix)).toEqual([{ field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' }]);
  });

  it('rename on a list the project has no rows of (or a field without a list) changes the records only', async () => {
    const { engine } = await project();
    const items = await engine.previewRuling({
      text: 'Spelling', scope_levels: null, standing: false,
      filter: { entity: 'punch_item', where: [{ field: 'item', op: 'eq', value: 'x' }] },
      action: { kind: 'rename', field: 'item', from: 'x', to: 'y' },
    });
    expect(items.vocab).toBeNull();
    expect(items.note).toBe('The project has no punch_item vocabulary yet: the rename changes the records only.');
    const to = await engine.previewRuling({ ...fixtures(), action: { kind: 'rename', field: 'to_text', from: 'Control wiring', to: 'Fixtures' } });
    expect(to.note).toBe('To has no vocabulary list: the rename changes the records only.');
  });
});

describe('standing rulings re-evaluate on new matches (PLAN §6.4)', () => {
  it('proposes on a record that matches later; Accept writes the Ruling change; Reject holds; standing off or delete supersedes', async () => {
    const { store, editor, engine, ids } = await project();
    const res = await engine.applyRuling(fixtures(), { skip: [ids.e2] });
    await engine.run();
    expect(await openRuling(store)).toEqual([]);
    // a new 0-10V row on 01 reading "To fixtures"
    const c4 = uuidv7();
    const e4 = uuidv7();
    await editor.group(CTX, async (g) => {
      await g.create('cable', { id: c4, project_id: PROJECT, cable: '0-10V', single_row: true, end_a_id: e4 });
      await g.create('cable_end', { id: e4, cable_id: c4, side: 'A', endpoint_kind: 'device', device_id: ids.p01, level_id: ids.l01, to_text: 'To fixtures' });
    });
    await engine.run();
    const [p] = await openRuling(store);
    expect(p).toMatchObject({ kind: 'note', discriminator: res.rulingId, subject: { entity_kind: 'cable_end', entity_id: e4, level_id: ids.l01 }, payload: { field: 'to_text', now: 'Fixtures', ruling_id: res.rulingId } });
    expect(await engine.explain(p!.id)).toContain('Standing ruling "0-10V rows read Fixtures": To "To fixtures" → "Fixtures"');
    await engine.decide(p!.id, { kind: 'accept' });
    expect(await store.get<Row>('cable_end', e4)).toMatchObject({ to_text: 'Fixtures' });
    const op = (await store.opsFor(e4)).at(-1)!;
    expect(op).toMatchObject({ kind: 'set', field: 'to_text', change_type: 'Ruling', reason: '0-10V rows read Fixtures', ruling_id: res.rulingId, proposal_id: p!.id });
    expect((await engine.run()).ops).toBe(0);
    expect(await store.get<ProposalRow>('proposal', p!.id)).toMatchObject({ state: 'accepted' });

    // drifts back → proposed again; Reject holds while the value holds
    await editor.setField('cable_end', e4, 'to_text', 'Fixtures (north)', CTX);
    await engine.run();
    expect((await openRuling(store)).map((x) => x.id)).toEqual([p!.id]);
    await engine.decide(p!.id, { kind: 'reject' });
    await engine.run();
    expect(await openRuling(store)).toEqual([]);
    await editor.setField('cable_end', e4, 'to_text', 'fixtures', CTX);
    await engine.run();
    expect((await openRuling(store)).map((x) => x.id)).toEqual([p!.id]);

    // standing off → superseded; on again → proposed; deleted → superseded
    await engine.setRulingStanding(res.rulingId, false);
    await engine.run();
    expect(await store.get<ProposalRow>('proposal', p!.id)).toMatchObject({ state: 'superseded' });
    await engine.setRulingStanding(res.rulingId, true);
    await engine.run();
    expect(await store.get<ProposalRow>('proposal', p!.id)).toMatchObject({ state: 'proposed' });
    await expect(engine.deleteRuling(res.rulingId, ' ')).rejects.toThrow(/reason/);
    await engine.deleteRuling(res.rulingId, 'Superseded by the riser');
    await engine.run();
    expect(await store.get<ProposalRow>('proposal', p!.id)).toMatchObject({ state: 'superseded' });
    expect((await store.get<Row>('ruling', res.rulingId))!.deleted_at).toBeTruthy();
  });

  it('a standing item ruling proposes the item on a new device; Accept creates it as a Ruling change, once', async () => {
    const { store, editor, engine, ids } = await project();
    await engine.applyRuling({
      text: 'Every sensor on 03 gets a Neuron ID check', scope_levels: ['03'], standing: true,
      filter: { entity: 'device', where: [{ field: 'category', op: 'eq', value: 'Sensor' }] },
      action: { kind: 'item', item: 'Confirm sensor Neuron ID', type: 'Information', owner: 'ETC' },
    });
    const d = (await editor.create('device', { level_id: ids.l03, category: 'Sensor', device: 'P-DOC-C-SR' }, CTX)).id;
    await editor.create('device', { level_id: ids.l01, category: 'Sensor', device: 'P-DOC-C-SR' }, CTX); // out of scope
    await engine.run();
    const rows = await openRuling(store);
    expect(rows.map((r) => [r.kind, r.subject?.entity_id])).toEqual([['punch', d]]);
    const out = await engine.decide(rows[0]!.id, { kind: 'accept' });
    const item = (await store.get<Row>('punch_item', out.recordIds[0]!))!;
    expect(item).toMatchObject({ device_id: d, level_id: ids.l03, item: 'Confirm sensor Neuron ID', owner: 'ETC', rule_id: 'ruling', proposal_id: rows[0]!.id });
    expect((await store.opsFor(item.id as string))[0]).toMatchObject({ change_type: 'Ruling', reason: 'Every sensor on 03 gets a Neuron ID check' });
    expect((await engine.run()).ops).toBe(0);
    expect(await openRuling(store)).toEqual([]);
  });

  it('the rule is registered and quiet on a project without rulings', () => {
    expect(RULES).toContain(RulingRule);
    const b = new Build();
    b.device(b.level('01'), 'Station');
    const out = { n: 0 };
    RulingRule.run({ snap: b.snap, index: indexSnapshot(b.snap), now: '', today: () => '', params: DEFAULT_PARAMS, param: (r, k) => DEFAULT_PARAMS.get(r, k), propose: () => out.n++, find: () => out.n++, maintain: () => out.n++ });
    expect(out.n).toBe(0);
  });
});

describe('hand-offs: "Fix all via ruling" (T36) and multi-select', () => {
  it('a lint seed opens as a rename over its records and levels; applying it resolves the findings', async () => {
    const { store, editor, engine, ids } = await project();
    // the vocabulary knows the old spelling already: lint.vocab raises a finding per device
    await editor.create('vocab', { project_id: PROJECT, list: 'device_note', value: 'Empty box on wall', canonical_of_id: ids.n1 }, CTX);
    await engine.run();
    const found = await store.list<FindingRow>('finding', { where: `project_id = ? AND lint_id = 'lint.vocab' AND state = 'open'`, params: [PROJECT], orderBy: 'id' });
    expect(found).toHaveLength(2);
    const [seed] = rulingSeeds(found.map((f) => ({ findingId: f.id, lintId: f.lint_id, entityKind: f.subject!.entity_kind, entityId: f.subject!.entity_id, levelId: f.level_id, fix: f.subject!.fix ?? null })));
    const draft = draftFromSeed(seed!, ['01', '03'])!;
    expect(draft).toMatchObject({
      text: 'Rename "Empty box on wall" to "Empty box on wall."',
      scope_levels: ['01', '03'],
      filter: { entity: 'device', where: [{ field: 'notes', op: 'has_phrase', value: 'Empty box on wall' }] },
      action: { kind: 'rename', field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' },
      standing: false,
    });
    expect([...draft.filter.ids!].sort()).toEqual([ids.p01, ids.p03].sort());
    const res = await engine.applyRuling(draft);
    expect(res.records).toBe(2);
    await engine.run();
    for (const f of found) expect(await store.get<FindingRow>('finding', f.id)).toMatchObject({ state: 'resolved' });
  });

  it('a seed without a known value opens as a set the person completes; a selection opens over the chosen records', () => {
    const d = draftFromSeed({ entity: 'device', field: 'category', action: 'set', from: 'Relay Panel', to: null, recordIds: ['a', 'b', 'a'], text: 'Replace "Relay Panel"' }, [])!;
    expect(d).toMatchObject({ scope_levels: null, filter: { where: [{ field: 'category', op: 'eq', value: 'Relay Panel' }], ids: ['a', 'b'] }, action: { kind: 'set', field: 'category', value: '' } });
    expect(checkRuling(d)).toEqual(['Set Category to what?']);
    expect(draftFromSeed({ entity: 'level', field: 'x', action: 'set', from: 'a', to: null, recordIds: [], text: '' }, [])).toBeNull();
    const s = draftFromSelection('punch_item', ['p1', 'p2'], ['06M', '06M']);
    expect(s).toMatchObject({ text: '', scope_levels: ['06M'], filter: { entity: 'punch_item', where: [], ids: ['p1', 'p2'] }, action: { kind: 'set', field: 'item', value: '' } });
    expect(checkRuling({ ...s, text: 'Owner per D175', action: { kind: 'set', field: 'owner', value: 'EC/ETC' } })).toEqual([]);
  });
});
