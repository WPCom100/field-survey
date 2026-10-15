/**
 * The device-type library editor (T48): drafts from "+ New type" and from field additions (T23),
 * edits as one group, accept / reject / reopen, "Copy from…", and accepting a type with default
 * cables raising R2g drafts for the devices that already exist (through the real engine).
 */

import { Editor, Store, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { addFieldDevice } from '../additions/model';
import { loadDeviceCard } from '../card/model';
import { engineFor, ruleDecider } from '../rules/engine';
import {
  NSPS_POWER_SUPPLY,
  acceptType,
  blankCable,
  copySources,
  copyTypes,
  createType,
  describeCable,
  loadLibrary,
  parseAliases,
  rejectType,
  reopenType,
  rulesForType,
  updateType,
} from './model';

const CTX: EditContext = { change_type: 'Master edit', reason: 't' };

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  let clock = 1_760_300_000_000;
  const userId = uuidv7();
  const now = () => new Date((clock += 1000)).toISOString();
  const project = async (name: string) => {
    const id = uuidv7();
    const e = new Editor(store, { projectId: id, userId, now });
    await e.create('project', { id, name }, CTX);
    const group = await e.create('numbering_group', { project_id: id, label: '06M' }, CTX);
    const level = await e.create('level', { project_id: id, level: '06M', floor_order: 1, numbering_group_id: group.id, in_scope: true, surveyed: '2026-10-13' }, CTX);
    return { id, editor: e, levelId: level.id };
  };
  return { store, userId, project };
}

describe('device-type library editor (T48)', () => {
  it('lists drafts from + New type and from field additions, counts devices by link or by model, refuses duplicates', async () => {
    const { store, userId, project } = await setup();
    const p = await project('Tower');
    const ts = await createType(p.editor, store, p.id, { model: ' P-TS18-E ', category: 'Touchscreen' });
    await expect(createType(p.editor, store, p.id, { model: 'p-ts18-e', category: null })).rejects.toThrow(/already in the library/);
    await expect(createType(p.editor, store, p.id, { model: '  ', category: null })).rejects.toThrow(/model first/);
    // a model typed on the plan (T23) arrives as a draft of the project
    const added = await addFieldDevice(p.editor, store, { projectId: p.id, levelId: p.levelId, category: 'Relay panel', typedModel: 'ERP-XYZ' });
    // an imported device without a link, named like an accepted type's alias
    const rack = await createType(p.editor, store, p.id, { model: 'Equipment Rack 18U', category: 'Equipment rack' });
    await updateType(p.editor, store, rack, { aliases: parseAliases('18U rack, ERn4-RM ,18u RACK') });
    await acceptType(p.editor, rack);
    await p.editor.create('device', { level_id: p.levelId, display_id: '06M-01', category: 'Equipment rack', device: 'ERn4-RM' }, CTX);
    const lib = await loadLibrary(store, p.id);
    expect(lib.drafts).toBe(2);
    expect(lib.types.map((t) => [t.category, t.model, t.state, t.devices])).toEqual([
      ['Relay panel', 'ERP-XYZ', 'draft', 1],
      ['Equipment rack', 'Equipment Rack 18U', 'accepted', 1],
      ['Touchscreen', 'P-TS18-E', 'draft', 0],
    ]);
    const draft = lib.types[0]!;
    expect(draft).toMatchObject({ id: added.draftTypeId, createdById: userId, projectId: p.id, idScheme: null, defaultCables: [] });
    expect(draft.createdAt).toMatch(/^2025-|^2026-/);
    expect(lib.types[1]!.aliases).toEqual(['18U rack', 'ERn4-RM']);
    // an alias of another type is a duplicate too
    await expect(createType(p.editor, store, p.id, { model: 'ern4-rm', category: null })).rejects.toThrow(/Equipment Rack 18U/);
    // rejected types sink to the bottom and free their model; reopen brings one back as a draft
    await rejectType(p.editor, ts);
    expect((await loadLibrary(store, p.id)).types.at(-1)).toMatchObject({ id: ts, state: 'rejected' });
    await reopenType(p.editor, ts);
    expect((await loadLibrary(store, p.id)).types.find((t) => t.id === ts)!.state).toBe('draft');
  });

  it('saves an edit as one group; an empty cable list is stored as null; bad values are refused', async () => {
    const { store, project } = await setup();
    const p = await project('Tower');
    const id = await createType(p.editor, store, p.id, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    const power = { ...blankCable('120V'), from: ' 120v Power', to: 'P-NSPS-D Power Supply', far: '120v Power', single_row: true };
    await updateType(p.editor, store, id, {
      aliases: ['P-NSPS-D'],
      idScheme: 'level_number',
      defaultCables: [power, { ...blankCable('U'), to: 'Unison from stations & sensors', far: 'Stations & Sensors', qty: null }],
      optionalCables: [{ ...blankCable('N'), to: 'switch' }],
      optionalAccessories: [NSPS_POWER_SUPPLY],
    });
    const ops = await store.opsFor(id);
    const edit = ops.slice(1);
    expect(edit.map((o) => o.field).sort()).toEqual(['aliases', 'default_cables', 'id_scheme', 'optional_accessories', 'optional_cables']);
    expect(new Set(edit.map((o) => o.group_id)).size).toBe(1);
    const t = (await loadLibrary(store, p.id)).types[0]!;
    expect(t.defaultCables[0]).toEqual({ code: '120V', from: '120v Power', to: 'P-NSPS-D Power Supply', far: '120v Power', single_row: true, qty: 1, status: null });
    expect(t.optionalAccessories).toEqual([{ model: 'P-NSPS-D Power Supply', expected_qty: 1 }]);
    expect(t.rules).toEqual(['R2e', 'R2g']);
    expect(describeCable(t.defaultCables[0]!)).toBe('120V · 120v Power → P-NSPS-D Power Supply · single row · qty 1');
    // the same values again write nothing; clearing the cables writes null
    await updateType(p.editor, store, id, { idScheme: 'level_number' });
    expect(await store.opsFor(id)).toHaveLength(ops.length);
    await updateType(p.editor, store, id, { defaultCables: [] });
    expect(await store.get('library_type', id)).toMatchObject({ default_cables: null });
    expect(rulesForType('NSPS', [])).toEqual(['R2d', 'R2e']);
    expect(rulesForType('Relay panel', [])).toEqual(['R2c']);
    await expect(updateType(p.editor, store, id, { defaultCables: [{ ...blankCable('Z') }] })).rejects.toThrow(/not a cable code/);
    await expect(updateType(p.editor, store, id, { optionalAccessories: [{ model: ' ', expected_qty: 1 }] })).rejects.toThrow(/needs a model/);
    await expect(updateType(p.editor, store, id, { model: '' })).rejects.toThrow(/needs a model/);
  });

  it('accepting a type with default cables raises R2g drafts for the devices already there (and R2d stands aside)', async () => {
    const { store, userId, project } = await setup();
    const p = await project('Tower');
    await p.editor.create('placeholder', { project_id: p.id, label: '120v Power', kind: 'power' }, CTX);
    const nsps = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'NSPS', device: 'P-NSPS-D-KIT' }, CTX);
    const id = await createType(p.editor, store, p.id, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    await updateType(p.editor, store, id, {
      defaultCables: [{ ...blankCable('120V'), from: '120v Power', to: 'NSPS PS', far: '120v Power', single_row: true }, { ...blankCable('N'), to: 'Network switch', far: 'Switch' }],
    });
    const engine = engineFor(store, p.id, userId);
    await engine.run();
    const draftsOf = async () => (await loadDeviceCard(store, nsps.id))!.drafts.map((d) => `${d.ruleId} ${d.title}`).sort();
    // a draft type governs nothing: the category table's R2d draft is offered
    expect(await draftsOf()).toEqual(['R2d cable']);
    await acceptType(p.editor, id);
    await engine.run();
    expect(await draftsOf()).toEqual(['R2g cable', 'R2g cable']);
    // accepting the 120V draft creates the run with the type's texts
    const card = (await loadDeviceCard(store, nsps.id))!;
    const decider = ruleDecider(store, p.id, userId);
    const power = card.drafts.find((d) => (d.payload.cable as { cable: string }).cable === '120V')!;
    expect(power.why).toBe('06M-05 is a P-NSPS-D-KIT (library: 120V → NSPS PS).');
    await decider.decide(power.id, { kind: 'accept' });
    const ends = await store.list<Record<string, unknown>>('cable_end', { where: 'cable_id IN (SELECT id FROM cable)', orderBy: 'side' });
    expect(ends.map((e) => [e.side, e.device_id, e.from_text, e.to_text])).toEqual([
      ['A', nsps.id, '120v Power', 'NSPS PS'],
      ['B', null, '120v Power', null],
    ]);
    const cable = await store.get<Record<string, unknown>>('cable', String(ends[0]!.cable_id));
    expect(cable).toMatchObject({ cable: '120V', origin: 'library', single_row: true, qty: 1 });
    await engine.run();
    expect(await draftsOf()).toEqual(['R2g cable']);
  });

  it('copies accepted types from another project or the app library, skipping models already there', async () => {
    const { store, project } = await setup();
    const a = await project('A');
    const b = await project('B');
    const one = await createType(a.editor, store, a.id, { model: 'PI1002', category: 'Station' });
    await updateType(a.editor, store, one, { idScheme: 'level_tag', aliases: ['PI-1002'] });
    await acceptType(a.editor, one);
    await createType(a.editor, store, a.id, { model: 'Draft only', category: 'Sensor' }); // drafts are not offered
    const two = await createType(a.editor, store, a.id, { model: 'P-LS', category: 'Sensor' });
    await acceptType(a.editor, two);
    await createType(b.editor, store, b.id, { model: 'p-ls', category: 'Sensor' });
    const sources = await copySources(store, b.id);
    expect(sources.map((s) => [s.id, s.name, s.types.map((t) => t.model)])).toEqual([[a.id, 'A', ['PI1002', 'P-LS']]]);
    const out = await copyTypes(b.editor, store, b.id, [one, two]);
    expect(out).toEqual({ copied: 1, skipped: ['P-LS'] });
    const copied = (await loadLibrary(store, b.id)).types.find((t) => t.model === 'PI1002')!;
    expect(copied).toMatchObject({ projectId: b.id, state: 'accepted', idScheme: 'level_tag', aliases: ['PI-1002'] });
    expect(copied.id).not.toBe(one);
  });
});
