/**
 * Rulings screen read model and editor steps (T37): the list with standing proposals, the
 * hand-off from Lint / multi-select, and the pure steps the editor takes on a draft.
 */

import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { RULES, RuleEngine, checkRuling, draftFromSelection, type RulingDraft } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { handRuling, takeRuling } from './handoff';
import {
  LIST_ENTITY,
  addCondition,
  copyOf,
  emptyDraft,
  loadRulingProposals,
  loadRulings,
  previewFooter,
  previewTitle,
  removeCondition,
  toggleLevel,
  withActionKind,
  withCondition,
  withEntity,
} from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_700_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const ids = { l01: uuidv7(), l03: uuidv7(), a: uuidv7(), b: uuidv7() };
  await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
    await g.create('app_user', { id: ME, name: 'Landry' });
    await g.create('project', { id: PROJECT, name: 'Tower' });
    await g.create('level', { id: ids.l01, project_id: PROJECT, level: '01', floor_order: 3, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('level', { id: ids.l03, project_id: PROJECT, level: '03', floor_order: 5, numbering_group_id: uuidv7(), in_scope: true });
    await g.create('device', { id: ids.a, level_id: ids.l01, display_id: '01-S1', category: 'Station', room_location: 'Corridor' });
  });
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: RULES, now });
  return { store, editor, engine, ids };
}

const corridor = (): RulingDraft => ({
  text: 'Corridor is Corridor C-01',
  scope_levels: null,
  filter: { entity: 'device', where: [{ field: 'room_location', op: 'eq', value: 'Corridor' }] },
  action: { kind: 'set', field: 'room_location', value: 'Corridor C-01' },
  standing: true,
});

describe('Rulings read model', () => {
  it('lists rulings with what they do, their counts and the standing proposals waiting', async () => {
    const { store, editor, engine, ids } = await setup();
    const res = await engine.applyRuling(corridor());
    await editor.create('device', { id: ids.b, level_id: ids.l03, category: 'Station', room_location: 'Corridor' }, { change_type: 'Field survey', reason: 'test' });
    await engine.run();
    const v = await loadRulings(store, PROJECT);
    expect(v).toMatchObject({ standing: 1, applied: 1, levels: [{ id: ids.l01, code: '01' }, { id: ids.l03, code: '03' }] });
    expect(v.rows[0]).toMatchObject({
      id: res.rulingId,
      text: 'Corridor is Corridor C-01',
      filter: 'Device · Room / Location = "Corridor"',
      action: 'set Room / Location = "Corridor C-01"',
      scope: 'All levels',
      standing: true,
      opCount: 1,
      createdBy: 'Landry',
      open: 1,
    });
    const props = await loadRulingProposals(store, PROJECT, res.rulingId);
    expect(props).toEqual([
      expect.objectContaining({ levelCode: '03', subject: expect.stringContaining('03-?'), why: 'Standing ruling "Corridor is Corridor C-01": Room / Location "Corridor" → "Corridor C-01"', deviceId: ids.b, levelId: ids.l03 }),
    ]);
  });
});

describe('editor steps', () => {
  it('switching entity or action starts their fields over; conditions add, change and go', () => {
    let d = emptyDraft();
    expect(d).toMatchObject({ filter: { entity: 'cable_end', where: [{ field: 'cable', op: 'eq', value: '' }] }, action: { kind: 'set', field: 'from_text' }, standing: true });
    d = withActionKind(d, 'item');
    expect(d.action).toEqual({ kind: 'item', item: '', type: 'Information', owner: 'EC', notes: '' });
    d = withEntity(d, 'punch_item');
    expect(d.action).toMatchObject({ kind: 'set', field: 'item' }); // no items on items
    d = withCondition(addCondition(d), 1, { field: 'owner', op: 'empty' });
    expect(d.filter.where.map((c) => `${c.field} ${c.op}`)).toEqual(['number eq', 'owner empty']);
    d = removeCondition(d, 0);
    d = toggleLevel(toggleLevel(d, '03'), '01');
    expect(d.scope_levels).toEqual(['03', '01']);
    expect(toggleLevel(toggleLevel(d, '03'), '01').scope_levels).toBeNull();
    d = { ...d, text: 'Items without an owner are the EC\'s', action: { kind: 'set', field: 'owner', value: 'EC' } };
    expect(checkRuling(d)).toEqual([]);
  });

  it('Copy keeps what the ruling does but not its id or unticked records', () => {
    const c = copyOf({ ...corridor(), id: 'r1', filter: { ...corridor().filter, except: ['x'] } });
    expect(c).toMatchObject({ id: null, text: 'Corridor is Corridor C-01 (copy)', standing: true });
    expect(c.filter).toEqual({ entity: 'device', where: corridor().filter.where });
  });

  it('the preview title and footer say how many, where, and what Apply records', () => {
    const p = { rows: [{}, {}, {}] as never[], matched: 5, excepted: 1, levels: 2, vocab: null, note: 'The project has no punch_item vocabulary yet: the rename changes the records only.', problems: [] };
    expect(previewTitle(p, 3)).toBe('3 changes on 2 levels');
    expect(previewTitle(p, 2)).toBe('3 changes on 2 levels · 1 unticked');
    expect(previewFooter(p, corridor())).toEqual([
      'Each ticked row becomes one Change Log line: Change = Ruling, Reason = the ruling text.',
      '1 record unticked in an earlier preview stays as it is.',
      '1 matching record is already right.',
      'The project has no punch_item vocabulary yet: the rename changes the records only.',
      'Standing: records that match later get this change as a proposal (Accept / Reject on the card or here).',
      'Unticked rows are remembered: this ruling never changes or proposes them.',
    ]);
  });
});

describe('hand-off', () => {
  it('a multi-selection or lint seed is taken once, by its project only', () => {
    const d = draftFromSelection(LIST_ENTITY.connections, ['e1', 'e2'], ['06M']);
    expect(d.filter).toEqual({ entity: 'cable_end', where: [], ids: ['e1', 'e2'] });
    handRuling(PROJECT, d, 'Conns on 06M');
    expect(takeRuling(uuidv7())).toBeNull();
    expect(takeRuling(PROJECT)).toEqual({ projectId: PROJECT, draft: d, source: 'Conns on 06M' });
    expect(takeRuling(PROJECT)).toBeNull();
  });
});
