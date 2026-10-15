/**
 * The PLAN §6.3 lint checks (T36): one test per check over hand-built snapshots, the check
 * catalogue the lint view groups by, the ruling hand-off, and Dismiss / Reopen over a store with
 * a dismissal reopening when its facts change (D178).
 */

import { Editor, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from '../engine';
import { evaluate } from '../evaluate';
import { LINT_CHECKS, checkOf, rulingSeeds } from '../lints';
import type { Rule } from '../rule';
import type { FindingRow } from '../snapshot';
import { Build } from '../testing/build';
import { RULES } from './index';
import {
  LintDeletedLink,
  LintEndStatus,
  LintFarEnd,
  LintIdDup,
  LintLockedDrafts,
  LintNeuronDup,
  LintNeuronItem,
  LintOwner,
  LintPin,
  LintPower,
  LintRelay,
  LintVocab,
  LINT_RULES,
} from './lint';

const NOW = '2026-10-15T12:00:00.000Z';
const found = (b: Build, rules: readonly Rule[]) => evaluate(b.snap, rules, undefined, { now: NOW }).findings.map((f) => [f.lint_id, f.subject.entity_id, f.message]);

describe('library cable lints', () => {
  it('flags an NSPS or rack without 120V and a Relay panel without P or 0-10V, and is quiet once the rows exist', () => {
    const b = new Build();
    const l = b.level('06M');
    const nsps = b.device(l, 'NSPS', { display_id: '06M-04' });
    const rack = b.device(l, 'Equipment rack', { display_id: '06M-05' });
    const panel = b.device(l, 'Relay panel', { display_id: '06M-01' });
    b.cable('0-10V', { device: panel }, null, { single_row: true });
    expect(found(b, [LintPower, LintRelay])).toEqual([
      ['lint.power_120v', nsps.id, '06M-04: NSPS without a 120V row'],
      ['lint.power_120v', rack.id, '06M-05: Equipment rack without a 120V row'],
      ['lint.relay_cables', panel.id, '06M-01: Relay panel without a P row'],
    ]);
    b.cable('120V', { device: nsps }, null, { single_row: true });
    b.cable('120V', { device: rack }, null, { single_row: true });
    b.cable('P', { device: panel }, null, { single_row: true });
    expect(found(b, [LintPower, LintRelay])).toEqual([]);
  });
});

describe('punch item lints', () => {
  it('flags an item without Owner', () => {
    const b = new Build();
    const l = b.level('03');
    const p = b.punch(l, { item: 'Replace wire nuts', owner: null });
    b.punch(l, { item: 'Owned', owner: 'EC' });
    expect(found(b, [LintOwner])).toEqual([['lint.item_owner', p.id, 'Punch #1 "Replace wire nuts": no Owner']]);
  });

  it('flags a numbering group missing its Neuron ID item, and an item not sorted last', () => {
    const b = new Build();
    const l06 = b.level('06', { numbering_group_id: 'g6' });
    const l06m = b.level('06M', { numbering_group_id: 'g6' });
    b.device(l06m, 'Station', { display_id: '06M-S1' });
    const l03 = b.level('03');
    b.device(l03, 'Station', { display_id: '03-S1', neuron_id: '00A1' }); // every ID captured: no item needed
    expect(found(b, [LintNeuronItem])).toEqual([['lint.neuron_item', 'g6', 'Levels 06/06M: no "Missing all Device Neuron IDs" item']]);
    const item = b.punch(l06, { item: 'Missing all Device Neuron IDs', type: 'Information', sort_last: false });
    expect(found(b, [LintNeuronItem])).toEqual([['lint.neuron_item', item.id, 'Levels 06/06M: "Missing all Device Neuron IDs" is not sorted last']]);
    item.sort_last = true;
    expect(found(b, [LintNeuronItem])).toEqual([]);
  });
});

describe('vocabulary lint', () => {
  it('flags an old spelling with its canonical value (as a fix), a category outside the list and a cable code outside the master\'s', () => {
    const b = new Build();
    const l = b.level('04');
    const station = b.device(l, 'Station', { display_id: '04-S3', notes: 'Run, not terminated; Empty box on wall' });
    const odd = b.device(l, 'Dimmer', { display_id: '04-07' });
    const ok = b.device(l, 'Station', { display_id: '04-S4', notes: 'Empty box on wall.' });
    const canonical = { id: 'v-1', project_id: b.snap.projectId, list: 'device_note', value: 'Empty box on wall.', canonical_of_id: null, deleted_at: null };
    const variant = { id: 'v-2', project_id: b.snap.projectId, list: 'device_note', value: 'Empty box on wall', canonical_of_id: 'v-1', deleted_at: null };
    b.snap.vocab.push(canonical, variant);
    const { cable } = b.cable('Z', { device: ok, display_id: 'C-04' }, null);
    const out = evaluate(b.snap, [LintVocab], undefined, { now: NOW });
    expect(out.findings.map((f) => [f.subject.entity_id, f.subject.discriminator, f.message])).toEqual([
      [station.id, 'notes=Empty box on wall', '04-S3: Notes "Empty box on wall" is an old spelling of "Empty box on wall."'],
      [odd.id, 'category=Dimmer', '04-07: Category "Dimmer" is not in the vocabulary'],
      [cable.id, 'cable=Z', 'C-04: Cable code "Z" is not in the vocabulary'],
    ]);
    expect(out.findings[0]!.subject.fix).toEqual({ field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' });
    expect(out.findings[1]!.subject.fix).toEqual({ field: 'category', from: 'Dimmer', to: null });
    // the project's own category list widens the fixed one
    b.vocab('category', 'Dimmer');
    expect(found(b, [LintVocab]).map((f) => f[1])).toEqual([station.id, cable.id]);
  });
});

describe('cable lints', () => {
  it('flags a cable with one end, or a far end naming neither device nor placeholder, on the end that has one', () => {
    const b = new Build();
    const l = b.level('03');
    const panel = b.device(l, 'Relay panel', { display_id: '03-01' });
    const fixtures = b.placeholder('Fixtures', 'fixtures');
    const lonely = b.cable('X', { device: panel, display_id: 'C-01' }, null);
    const loose = b.cable('N', { device: panel, display_id: 'C-02' }, { from_text: 'UFMP4 #1, #2' });
    b.cable('0-10V', { device: panel, display_id: 'C-03' }, { placeholder: fixtures }, { single_row: true });
    expect(found(b, [LintFarEnd])).toEqual([
      ['lint.far_end', lonely.a.id, 'C-01: DMX cable has no far end'],
      ['lint.far_end', loose.a.id, 'C-02: network cable, the far end "UFMP4 #1, #2" names no device or placeholder'],
    ]);
  });

  it('flags ends that disagree on whether the wire is run (code mismatch cannot happen: one cable, one code)', () => {
    const b = new Build();
    const l = b.level('03');
    const a = b.device(l, 'Relay panel', { display_id: '03-01' });
    const c = b.device(l, 'Station', { display_id: '03-S1' });
    const bad = b.cable('X', { device: a, display_id: 'C-01', status: 'Not installed' }, { device: c, display_id: 'C-02', status: 'Installed, untested' });
    b.cable('N', { device: a, display_id: 'C-03', status: 'Not installed' }, { device: c, display_id: 'C-04', status: 'Issue' });
    expect(found(b, [LintEndStatus])).toEqual([['lint.end_status', bad.a.id, 'C-01: Not installed here, Installed, untested at the other end (C-02)']]);
  });
});

describe('duplicates, links, pins, locks', () => {
  it('flags a Neuron ID or a device ID on two live devices, on each', () => {
    const b = new Build();
    const l = b.level('02');
    const x = b.device(l, 'Station', { display_id: '02-S1', neuron_id: '00a1b2' });
    const y = b.device(l, 'Station', { display_id: '02-S2', neuron_id: '00A1B2' });
    b.device(l, 'Station', { display_id: '02-S2', neuron_id: '00A1B2', deleted_at: '2026-10-01' }); // deleted: ignored
    const z = b.device(l, 'Station', { display_id: '02-S2' });
    expect(found(b, [LintNeuronDup, LintIdDup])).toEqual([
      ['lint.neuron_dup', x.id, '02-S1: Neuron ID 00a1b2 is also on 02-S2'],
      ['lint.neuron_dup', y.id, '02-S2: Neuron ID 00A1B2 is also on 02-S1'],
      ['lint.id_dup', y.id, '02-S2: ID also used by 1 other device'],
      ['lint.id_dup', z.id, '02-S2: ID also used by 1 other device'],
    ]);
  });

  it('flags a punch item, part, end or photo still linked to a deleted device', () => {
    const b = new Build();
    const l = b.level('01');
    const gone = b.device(l, 'Station', { display_id: '01-S9', deleted_at: '2026-10-02' });
    const live = b.device(l, 'Relay panel', { display_id: '01-01' });
    const p = b.punch(l, { device_id: gone.id, item: 'Gain access' });
    const m = b.part(l, { device_id: gone.id, part: 'Backbox' });
    const { b: end } = b.cable('U', { device: live, display_id: 'C-01' }, { device: gone, display_id: 'C-02' });
    b.snap.photos.push({ id: 'photo-1', level_id: l.id, number: 4, device_id: gone.id, deleted_at: null });
    expect(found(b, [LintDeletedLink])).toEqual([
      ['lint.deleted_link', p.id, 'Punch #1 "Gain access": linked to deleted device 01-S9'],
      ['lint.deleted_link', m.id, 'Part #1 "Backbox": linked to deleted device 01-S9'],
      ['lint.deleted_link', end!.id, 'C-02: endpoint is deleted device 01-S9'],
      ['lint.deleted_link', 'photo-1', 'Photo #4: linked to deleted device 01-S9'],
    ]);
  });

  it('flags a pin outside its sheet or on a deleted sheet', () => {
    const b = new Build();
    const l = b.level('06M');
    b.snap.sheets.push({ id: 'sheet-1', level_id: l.id, width_pt: 2592, height_pt: 1728, deleted_at: null });
    b.snap.sheets.push({ id: 'sheet-0', level_id: l.id, width_pt: 2592, height_pt: 1728, deleted_at: '2026-10-01' });
    b.device(l, 'Station', { display_id: '06M-S1', pin: { sheet: 'sheet-1', x: 100, y: 100 } });
    const out = b.device(l, 'Station', { display_id: '06M-S2', pin: { sheet: 'sheet-1', x: 2600, y: 100 } });
    const old = b.device(l, 'Station', { display_id: '06M-S3', pin: { sheet: 'sheet-0', x: 10, y: 10 } });
    expect(found(b, [LintPin])).toEqual([
      ['lint.pin_sheet', out.id, '06M-S2: pin outside the sheet'],
      ['lint.pin_sheet', old.id, '06M-S3: pin is on a deleted sheet'],
    ]);
  });

  it('flags a locked level that still has unreviewed drafts', () => {
    const b = new Build();
    const locked = b.level('B2', { state: 'baseline_locked', baseline_locked_at: '2026-10-10' });
    const open = b.level('B1');
    b.snap.drafts.push(
      { id: 'dd-1', kind: 'device', level_id: locked.id, state: 'proposed', deleted_at: null },
      { id: 'dc-1', kind: 'cable', level_id: locked.id, state: 'proposed', deleted_at: null },
      { id: 'dd-2', kind: 'device', level_id: locked.id, state: 'accepted', deleted_at: null },
      { id: 'dd-3', kind: 'device', level_id: open.id, state: 'proposed', deleted_at: null },
    );
    expect(found(b, [LintLockedDrafts])).toEqual([['lint.locked_drafts', locked.id, 'Level B2 is locked with 2 unreviewed drafts']]);
  });
});

describe('the lint view catalogue (Phase 3 §9)', () => {
  it('lists every lint the registry can raise under a PLAN §6.3 check, each once', () => {
    const raised = RULES.flatMap((r) => r.lints ?? [r.id]).filter((id) => !['R2c', 'R2d', 'R2e', 'R2f', 'R2g', 'R3a', 'R3b', 'R3c', 'R4b', 'E5', 'ruling'].includes(id));
    for (const id of raised) expect(checkOf(id).id, id).not.toMatch(/^other:/);
    const all = LINT_CHECKS.flatMap((c) => c.lints);
    expect(new Set(all).size).toBe(all.length);
    expect(LINT_RULES.every((r) => RULES.includes(r))).toBe(true);
    expect(checkOf('import.endpoint').title).toBe('Import');
  });

  it('groups vocabulary findings into one ruling seed per value: a rename when the canonical is known, else a set', () => {
    const seeds = rulingSeeds([
      { findingId: 'f1', lintId: 'lint.vocab', entityKind: 'device', entityId: 'd1', levelId: 'L3', fix: { field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' } },
      { findingId: 'f2', lintId: 'lint.vocab', entityKind: 'device', entityId: 'd2', levelId: 'L4', fix: { field: 'notes', from: 'Empty box on wall', to: 'Empty box on wall.' } },
      { findingId: 'f3', lintId: 'R3f', entityKind: 'punch_item', entityId: 'p1', levelId: 'L3', fix: null, value: 'Pull missing DMX cable' },
      { findingId: 'f4', lintId: 'R1.no_item', entityKind: 'device', entityId: 'd3', levelId: 'L3', fix: null },
    ]);
    expect(seeds).toEqual([
      { entity: 'device', field: 'notes', action: 'rename', from: 'Empty box on wall', to: 'Empty box on wall.', recordIds: ['d1', 'd2'], levelIds: ['L3', 'L4'], findingIds: ['f1', 'f2'], text: 'Rename "Empty box on wall" to "Empty box on wall."' },
      { entity: 'punch_item', field: 'item', action: 'set', from: 'Pull missing DMX cable', to: null, recordIds: ['p1'], levelIds: ['L3'], findingIds: ['f3'], text: 'Replace "Pull missing DMX cable"' },
    ]);
  });
});

describe('Dismiss with a reason, over a store (D178)', () => {
  const PROJECT = uuidv7();
  const ME = uuidv7();
  const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

  it('dismisses with a reason, stays dismissed while the facts hold, reopens when they change; Reopen undoes a dismissal', async () => {
    let clock = 1_760_500_000_000;
    const now = () => new Date((clock += 1000)).toISOString();
    const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
    const level = uuidv7();
    const a = uuidv7();
    const c = uuidv7();
    await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
      await g.create('project', { id: PROJECT, name: 'T' });
      await g.create('level', { id: level, project_id: PROJECT, level: '02', floor_order: 3, numbering_group_id: uuidv7(), in_scope: true });
      await g.create('device', { id: a, level_id: level, display_id: '02-S1', category: 'Station', neuron_id: '00A1' });
      await g.create('device', { id: c, level_id: level, display_id: '02-S2', category: 'Station', neuron_id: '00A1' });
    });
    const engine = new RuleEngine(store, { projectId: PROJECT, userId: ME, rules: [LintNeuronDup], now });
    await engine.run();
    const findingOf = async (device: string) =>
      (await store.list<FindingRow>('finding', { where: `project_id = ? AND json_extract(subject, '$.entity_id') = ?`, params: [PROJECT, device] }))[0]!;
    const f = await findingOf(a);
    expect(f).toMatchObject({ state: 'open', message: '02-S1: Neuron ID 00A1 is also on 02-S2' });

    await expect(engine.dismiss(f.id, '  ')).rejects.toThrow(/reason/);
    expect(await engine.dismiss(f.id, 'Same panel, two Neuron chips')).toBe(2);
    expect(await store.get<FindingRow>('finding', f.id)).toMatchObject({ state: 'dismissed', dismissed_reason: 'Same panel, two Neuron chips' });
    const ops = await store.opsFor(f.id);
    expect(ops.filter((o) => o.reason === 'Dismiss lint.neuron_dup: Same panel, two Neuron chips').map((o) => o.field).sort()).toEqual(['dismissed_reason', 'state']);
    await expect(engine.dismiss(f.id, 'again')).rejects.toThrow(/dismissed/);
    expect((await engine.run()).ops).toBe(0); // same facts: stays dismissed

    // a third device with the same ID changes the facts: the message names it, the finding reopens
    await editor.group(CTX, (g) => g.create('device', { id: uuidv7(), level_id: level, display_id: '02-S3', category: 'Station', neuron_id: '00A1' }).then(() => {}));
    await engine.run();
    expect(await store.get<FindingRow>('finding', f.id)).toMatchObject({ state: 'open', dismissed_reason: null, message: '02-S1: Neuron ID 00A1 is also on 02-S2, 02-S3' });

    // Reopen undoes a dismissal by hand
    await engine.dismiss(f.id, 'checked');
    expect(await engine.reopen(f.id)).toBe(2);
    expect(await store.get<FindingRow>('finding', f.id)).toMatchObject({ state: 'open', dismissed_reason: null });
    await expect(engine.reopen(f.id)).rejects.toThrow(/open/);
  });
});
