/**
 * The device-type library editor (T48; one library since T196 / T197, D287, D292): drafts from
 * "+ New type" and from field additions, edits as one group on the library stream (a project's
 * stream is refused), accept / reject / reopen / delete / restore, the warnings that name the
 * devices this iPad knows of, the device counts per open project, and accepting a type with
 * default cables raising R2g drafts for the devices that already exist (through the real engine).
 */

import { Editor, LIBRARY_STREAM, Store, SyncEngine, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { decideRuleParam, setRuleParam } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { addFieldDevice, libraryChoices, searchChoices } from '../additions/model';
import { loadReviewList } from '../review/model';
import { loadDeviceCard } from '../card/model';
import { asFound, drillRows, loadDashboard } from '../dashboard/model';
import { engineFor, ruleDecider } from '../rules/engine';
import {
  ACCESSORY_GROUP,
  NSPS_POWER_SUPPLY,
  REJECTED_GROUP,
  acceptAllDrafts,
  acceptType,
  blankCable,
  createType,
  deleteType,
  describeCable,
  editorStamp,
  groupOf,
  libraryGroups,
  loadLibrary,
  matchesQuery,
  parseAliases,
  rejectType,
  reopenType,
  restoreType,
  rulesForType,
  typeChangeWarning,
  updateType,
} from './model';

const CTX: EditContext = { change_type: 'Master edit', reason: 't' };

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  let clock = 1_760_300_000_000;
  const userId = uuidv7();
  const now = () => new Date((clock += 1000)).toISOString();
  /** The library's editor (`/library/ops`, D184), on the same clock as the projects'. */
  const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId, now });
  const project = async (name: string) => {
    const id = uuidv7();
    const e = new Editor(store, { projectId: id, userId, now });
    await e.create('project', { id, name }, CTX);
    const group = await e.create('numbering_group', { project_id: id, label: '06M' }, CTX);
    const level = await e.create('level', { project_id: id, level: '06M', floor_order: 1, numbering_group_id: group.id, in_scope: true, surveyed: '2026-10-13' }, CTX);
    return { id, editor: e, levelId: level.id };
  };
  return { store, userId, lib, project };
}

describe('device-type library editor (T48, one library: T197)', () => {
  it('lists drafts from + New type and from field additions, counts devices by link or by model, refuses duplicates and a project stream', async () => {
    const { store, userId, lib, project } = await setup();
    const p = await project('Tower');
    const ts = await createType(lib, store, { model: ' P-TS18-E ', category: 'Touchscreen' });
    await expect(createType(lib, store, { model: 'p-ts18-e', category: null })).rejects.toThrow(/already in the library/);
    await expect(createType(lib, store, { model: '  ', category: null })).rejects.toThrow(/model first/);
    // nothing in a project edits a type (D287 (2)): a project's editor is refused, before any op
    await expect(createType(p.editor, store, { model: 'P-TS7-E', category: 'Touchscreen' })).rejects.toThrow(/edited in the Library/);
    await expect(updateType(p.editor, store, ts, { aliases: ['TS18'] })).rejects.toThrow(/edited in the Library/);
    await expect(acceptType(p.editor, ts)).rejects.toThrow(/edited in the Library/);
    await expect(deleteType(p.editor, ts)).rejects.toThrow(/edited in the Library/);
    expect(await store.opsFor(ts)).toHaveLength(1);
    // a model typed on the plan (T23) arrives as a draft of the one library (T196, D292 (2))
    const added = await addFieldDevice(p.editor, store, { projectId: p.id, levelId: p.levelId, category: 'Relay panel', typedModel: 'ERP-XYZ' });
    expect((await loadLibrary(store)).types.find((t) => t.id === added.draftTypeId)).toMatchObject({ model: 'ERP-XYZ', state: 'draft', createdById: userId, idScheme: null, defaultCables: [], devices: 1 });
    // an imported device without a link, named like an accepted type's alias
    const rack = await createType(lib, store, { model: 'Equipment Rack 18U', category: 'Equipment rack' });
    await updateType(lib, store, rack, { aliases: parseAliases('18U rack, ERn4-RM ,18u RACK') });
    await acceptType(lib, rack);
    await p.editor.create('device', { level_id: p.levelId, display_id: '06M-01', category: 'Equipment rack', device: 'ERn4-RM' }, CTX);
    const view = await loadLibrary(store, p.id);
    expect(view.drafts).toBe(2);
    expect(view.types.map((t) => [t.category, t.model, t.state, t.devices])).toEqual([
      ['Relay panel', 'ERP-XYZ', 'draft', 1],
      ['Equipment rack', 'Equipment Rack 18U', 'accepted', 1],
      ['Touchscreen', 'P-TS18-E', 'draft', 0],
    ]);
    expect(view.types[2]!.createdAt).toMatch(/^2025-|^2026-/);
    expect(view.types[1]!.aliases).toEqual(['18U rack', 'ERn4-RM']);
    // an alias of another type is a duplicate too
    await expect(createType(lib, store, { model: 'ern4-rm', category: null })).rejects.toThrow(/Equipment Rack 18U/);
    // rejected types sink to the bottom and free their model; reopen brings one back as a draft
    await rejectType(lib, ts);
    expect((await loadLibrary(store, p.id)).types.at(-1)).toMatchObject({ id: ts, state: 'rejected' });
    await reopenType(lib, ts);
    expect((await loadLibrary(store, p.id)).types.find((t) => t.id === ts)!.state).toBe('draft');
  });

  it('the editor stamp changes only with what the form holds (T125: Save keeps the panel)', async () => {
    const { store, lib } = await setup();
    const id = await createType(lib, store, { model: 'ERn2-W-120 Mk2', category: 'Equipment Rack' });
    const load = async () => (await loadLibrary(store)).types.find((t) => t.id === id)!;
    const before = await load();
    expect(editorStamp(await load())).toBe(editorStamp(before)); // a reload with nothing new keeps the form
    await updateType(lib, store, id, { optionalCables: [{ ...blankCable('N'), to: 'switch', far: 'Network switch' }] });
    const saved = await load();
    expect(editorStamp(saved)).not.toBe(editorStamp(before)); // the saved values reach the form
    await acceptType(lib, id);
    expect(editorStamp(await load())).not.toBe(editorStamp(saved)); // so does a state change
  });

  it('saves an edit as one group on the library stream; an empty cable list is stored as null; bad values are refused', async () => {
    const { store, lib } = await setup();
    const id = await createType(lib, store, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    const power = { ...blankCable('120V'), from: ' 120v Power', to: 'P-NSPS-D Power Supply', far: '120v Power', single_row: true };
    await updateType(lib, store, id, {
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
    expect(ops.every((o) => o.project_id === LIBRARY_STREAM)).toBe(true);
    const t = (await loadLibrary(store)).types[0]!;
    expect(t.defaultCables[0]).toEqual({ code: '120V', from: '120v Power', to: 'P-NSPS-D Power Supply', far: '120v Power', single_row: true, qty: 1, status: null });
    expect(t.optionalAccessories).toEqual([{ model: 'P-NSPS-D Power Supply', expected_qty: 1 }]);
    expect(t.rules).toEqual(['R2e', 'R2g']);
    expect(describeCable(t.defaultCables[0]!)).toBe('120V · 120v Power → P-NSPS-D Power Supply · single row · qty 1');
    // the same values again write nothing; clearing the cables writes null
    await updateType(lib, store, id, { idScheme: 'level_number' });
    expect(await store.opsFor(id)).toHaveLength(ops.length);
    await updateType(lib, store, id, { defaultCables: [] });
    expect(await store.get('library_type', id)).toMatchObject({ default_cables: null });
    expect(rulesForType('nsps', [])).toEqual(['R2d', 'R2e']);
    expect(rulesForType('relay_panel', [])).toEqual(['R2c']);
    expect(rulesForType('other', [])).toEqual([]);
    await expect(updateType(lib, store, id, { defaultCables: [{ ...blankCable('Z') }] })).rejects.toThrow(/not a cable code/);
    await expect(updateType(lib, store, id, { optionalAccessories: [{ model: ' ', expected_qty: 1 }] })).rejects.toThrow(/needs a model/);
    await expect(updateType(lib, store, id, { model: '' })).rejects.toThrow(/needs a model/);
  });

  it("a code the app library's Rules give a signal word is a cable code of its types; the card offers the run in any project (T117, T196)", async () => {
    const { store, lib, project } = await setup();
    const p = await project('Tower');
    const id = await createType(lib, store, { model: 'DALI-GW', category: 'Equipment' });
    const dx = { ...blankCable('DX'), to: 'DALI-2 bus', far: 'Fixtures' };
    expect((await loadLibrary(store)).codes).toEqual(['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V', 'D']);
    await expect(updateType(lib, store, id, { optionalCables: [dx] })).rejects.toThrow(/"DX" is not a cable code/);
    // the app library reads its own accepted Rules: a draft word is not enough
    await setRuleParam(lib, 'R3', 'signal', { DX: 'DALI-2' });
    await expect(updateType(lib, store, id, { optionalCables: [dx] })).rejects.toThrow(/not a cable code/);
    await decideRuleParam(lib, 'R3', 'signal', 'accepted');
    await updateType(lib, store, id, { optionalCables: [dx] });
    const view = await loadLibrary(store);
    expect(view.codes.slice(-2)).toEqual(['D', 'DX']);
    expect(view.types[0]!.optionalCables.map((c) => c.code)).toEqual(['DX']);
    // the card offers the run on a device of the type, though the project's own Rules give DX no
    // signal word: a type's rows are never hidden by a project's code list (D287 (5))
    const device = await p.editor.create('device', { level_id: p.levelId, category: 'Equipment', device: 'DALI-GW', library_type_id: id }, CTX);
    expect((await loadDeviceCard(store, device.id))!.cableOffers.map((o) => o.cable.code)).toEqual(['DX']);
  });

  it('Neuron ID per type (T68, D185; by the wires since T146, D245): the flag in the editor, the card and the dashboard', async () => {
    const { store, lib, project } = await setup();
    const p = await project('Tower');
    const nspsType = await createType(lib, store, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    const stationType = await createType(lib, store, { model: 'PI1002', category: 'Station' });
    let view = await loadLibrary(store);
    expect(view.types.map((t) => [t.model, t.needsNeuronId, t.neuronId])).toEqual([
      ['P-NSPS-D-KIT', null, false],
      ['PI1002', null, true],
    ]);
    const nsps = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'NSPS', device: 'P-NSPS-D-KIT' }, CTX);
    const rack = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-06', category: 'Equipment rack', device: 'Rack' }, CTX);
    const station = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-S1', category: 'Station', library_type_id: stationType }, CTX);
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, rack.id))!.device.needsNeuronId).toBe(false); // no type: the category's role hosts the bus
    expect((await loadDeviceCard(store, station.id))!.device.needsNeuronId).toBe(true); // rides the bus (D50)
    let dash = await loadDashboard(store, p.id);
    expect(asFound(dash)).toMatchObject({ neuronCaptured: 0, neuronDevices: 1, devices: 3 });
    expect(drillRows(dash, { table: 'asFound', key: 'neuronMissing', status: null }).map((r) => r.label)).toEqual(['06M-S1']);
    // the editor's flag: one op; the station type stops needing one, the NSPS type starts
    await updateType(lib, store, nspsType, { needsNeuronId: true });
    await updateType(lib, store, stationType, { needsNeuronId: false });
    expect((await store.opsFor(nspsType)).at(-1)).toMatchObject({ field: 'needs_neuron_id', now: true });
    view = await loadLibrary(store);
    expect(view.types.map((t) => [t.model, t.needsNeuronId, t.neuronId])).toEqual([
      ['P-NSPS-D-KIT', true, true],
      ['PI1002', false, false],
    ]);
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(true);
    expect((await loadDeviceCard(store, station.id))!.device.needsNeuronId).toBe(false);
    dash = await loadDashboard(store, p.id);
    expect(drillRows(dash, { table: 'asFound', key: 'neuronMissing', status: null }).map((r) => r.label)).toEqual(['06M-05']);
    // back to "by the wires"
    await updateType(lib, store, nspsType, { needsNeuronId: null });
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(false);
    // T146: the IP / DMX flags the same way — the station type says its devices carry an IP address
    await updateType(lib, store, stationType, { needsIpAddress: true, needsDmxAddress: false });
    expect((await store.opsFor(stationType)).slice(-2).map((o) => [o.field, o.now])).toEqual([['needs_ip_address', true], ['needs_dmx_address', false]]);
    expect((await loadLibrary(store)).types.find((t) => t.id === stationType)).toMatchObject({ needsIpAddress: true, needsDmxAddress: false, ipAddress: true, dmxAddress: false });
    let card = (await loadDeviceCard(store, station.id))!;
    expect([card.device.needsNeuronId, card.device.needsIpAddress, card.device.needsDmxAddress]).toEqual([false, true, false]);
    // by the wires: a DMX run landing on the rack gives it a DMX address need; the NSPS with no wires needs nothing
    const x = await p.editor.create('cable', { project_id: p.id, cable: 'X', qty: 1 }, CTX);
    await p.editor.create('cable_end', { cable_id: x.id, side: 'A', level_id: p.levelId, device_id: rack.id }, CTX);
    card = (await loadDeviceCard(store, rack.id))!;
    expect([card.device.needsNeuronId, card.device.needsIpAddress, card.device.needsDmxAddress]).toEqual([false, false, true]);
    card = (await loadDeviceCard(store, nsps.id))!;
    expect([card.device.needsNeuronId, card.device.needsIpAddress, card.device.needsDmxAddress]).toEqual([false, false, false]);
  });

  it('accepting a type with default cables raises R2g drafts for the devices already there (and R2d stands aside)', async () => {
    const { store, userId, lib, project } = await setup();
    const p = await project('Tower');
    await p.editor.create('placeholder', { project_id: p.id, label: '120v Power', kind: 'power' }, CTX);
    const nsps = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'NSPS', device: 'P-NSPS-D-KIT' }, CTX);
    const id = await createType(lib, store, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    await updateType(lib, store, id, {
      defaultCables: [{ ...blankCable('120V'), from: '120v Power', to: 'NSPS PS', far: '120v Power', single_row: true }, { ...blankCable('N'), to: 'Network switch', far: 'Switch' }],
    });
    const engine = engineFor(store, p.id, userId);
    await engine.run();
    const draftsOf = async () => (await loadDeviceCard(store, nsps.id))!.drafts.map((d) => `${d.ruleId} ${d.title}`).sort();
    // a draft type governs nothing: the category table's R2d draft is offered
    expect(await draftsOf()).toEqual(['R2d 120V → P-NSPS-D Power Supply']);
    await acceptType(lib, id);
    await engine.run();
    expect(await draftsOf()).toEqual(['R2g 120V → NSPS PS', 'R2g N → Network switch']);
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
    expect(await draftsOf()).toEqual(['R2g N → Network switch']);
  });
});

describe('one library for every project (T197, D287, D292 (6))', () => {
  it("the sidebar's Library and Projects' Library show the same types; the count is the open project's, or every project's on this iPad", async () => {
    const { store, lib, project } = await setup();
    const a = await project('Tower');
    const b = await project('Clinic');
    const st = await createType(lib, store, { model: 'PI1002', category: 'Station' });
    await updateType(lib, store, st, { aliases: ['PI-1002'] });
    await acceptType(lib, st);
    await a.editor.create('device', { level_id: a.levelId, category: 'Station', device: 'PI1002', library_type_id: st }, CTX);
    await a.editor.create('device', { level_id: a.levelId, category: 'Station', device: 'pi-1002' }, CTX); // by alias, no link
    await b.editor.create('device', { level_id: b.levelId, category: 'Station', library_type_id: st }, CTX);
    const gone = await b.editor.create('device', { level_id: b.levelId, category: 'Station', library_type_id: st }, CTX);
    await b.editor.delete('device', gone.id, CTX); // a deleted device counts nowhere
    const count = async (projectId: string | null) => {
      const t = (await loadLibrary(store, projectId)).types[0]!;
      return [t.devices, t.devicesOnIpad];
    };
    expect(await count(a.id)).toEqual([2, 3]);
    expect(await count(b.id)).toEqual([1, 3]);
    expect(await count(null)).toEqual([3, 3]);
    // the same rows from either door, and the pickers of both projects offer the type
    expect((await loadLibrary(store, a.id)).types.map((t) => t.id)).toEqual((await loadLibrary(store)).types.map((t) => t.id));
    expect((await libraryChoices(store)).map((c) => c.model)).toEqual(['PI1002']);
  });

  it('delete, reject and rename ask with the devices this iPad knows of; a deleted type sits with the rejected ones until Restore', async () => {
    const { store, userId, lib, project } = await setup();
    const p = await project('Tower');
    const ts = await createType(lib, store, { model: 'P-TS7-E', category: 'Touchscreen' });
    await acceptType(lib, ts);
    const unused = await createType(lib, store, { model: 'P-TS18-E', category: 'Touchscreen' });
    const dev = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-T1', category: 'Touchscreen', device: 'P-TS7-E', library_type_id: ts }, CTX);
    let view = await loadLibrary(store, p.id);
    const used = view.types.find((t) => t.id === ts)!;
    const free = view.types.find((t) => t.id === unused)!;

    // the questions (D292 (6)): a delete always asks; a reject or a rename only when devices use it
    expect(typeChangeWarning(used, 'delete')).toEqual({ title: 'Delete P-TS7-E?', message: '1 device on this iPad uses it. It keeps the type and Lint flags it, in every project.', confirm: 'Delete' });
    expect(typeChangeWarning(used, 'reject')).toEqual({ title: 'Reject P-TS7-E?', message: '1 device on this iPad uses it. It keeps the type and Lint flags it, in every project.', confirm: 'Reject' });
    expect(typeChangeWarning(used, 'rename', 'P-TS7-E2')).toEqual({ title: 'Rename P-TS7-E to P-TS7-E2?', message: '1 device on this iPad uses it. Every project reads the new model.', confirm: 'Rename' });
    expect(typeChangeWarning({ model: 'X', devicesOnIpad: 3 }, 'reject')!.message).toBe('3 devices on this iPad use it. They keep the type and Lint flags them, in every project.');
    expect(typeChangeWarning(free, 'delete')).toEqual({ title: 'Delete P-TS18-E?', message: 'No device on this iPad uses it. Every project loses the type.', confirm: 'Delete' });
    expect(typeChangeWarning(free, 'reject')).toBeNull();
    expect(typeChangeWarning(free, 'rename', 'P-TS18-E2')).toBeNull();

    // delete: soft, listed with the rejected ones, gone from the pickers; the device keeps its link
    await deleteType(lib, ts);
    expect(await store.get('device', dev.id)).toMatchObject({ library_type_id: ts });
    view = await loadLibrary(store, p.id);
    const deleted = view.types.find((t) => t.id === ts)!;
    expect(deleted).toMatchObject({ deleted: true, state: 'accepted', devices: 1 });
    expect(view.types.at(-1)!.id).toBe(ts);
    expect(groupOf(deleted)).toBe(REJECTED_GROUP);
    expect(view.drafts).toBe(1);
    expect((await libraryChoices(store)).map((c) => c.model)).toEqual(['P-TS18-E']);
    // its model is free while it is deleted; Restore is refused once another type took it
    const twin = await createType(lib, store, { model: 'P-TS7-E', category: 'Touchscreen' });
    await expect(restoreType(lib, store, ts)).rejects.toThrow(/already in the library/);
    await deleteType(lib, twin);

    // the rules flag the device (lint.type_gone) and never change it
    const engine = engineFor(store, p.id, userId);
    const findings = async () =>
      (await store.list<{ lint_id: string; message: string }>('finding', { where: `project_id = ? AND lint_id = 'lint.type_gone' AND state = 'open'`, params: [p.id] })).map((f) => f.message);
    await engine.run();
    expect(await findings()).toEqual(['06M-T1: type P-TS7-E was deleted from the library']);
    await restoreType(lib, store, ts);
    expect((await loadLibrary(store)).types.find((t) => t.id === ts)).toMatchObject({ deleted: false, state: 'accepted' });
    await engine.run();
    expect(await findings()).toEqual([]);
    // a reject is flagged the same way; Back to draft clears it
    await rejectType(lib, ts);
    await engine.run();
    expect(await findings()).toEqual(['06M-T1: type P-TS7-E was rejected in the library']);
    await reopenType(lib, ts);
    await engine.run();
    expect(await findings()).toEqual([]);
    expect(await store.get('device', dev.id)).toMatchObject({ library_type_id: ts });
  });

  it('a type made on one iPad reaches another on the library stream, and every project there offers it', async () => {
    const server = new FakeServer();
    const { store, lib, project } = await setup();
    const id = await createType(lib, store, { model: 'P-TS18-E', category: 'Touchscreen' });
    await updateType(lib, store, id, { idScheme: 'level_number', optionalAccessories: [{ model: 'Back box', expected_qty: 1 }] });
    await acceptType(lib, id);
    await new SyncEngine(store, server, { library: true, log: () => {} }).sync();
    expect(server.ops(LIBRARY_STREAM).map((o) => [o.entity_kind, o.kind])).toEqual([['library_type', 'create'], ['library_type', 'set'], ['library_type', 'set'], ['library_type', 'set']]);
    const other = await Store.open(new BetterSqliteDriver(), { installId: 'j', search: 'like' });
    await new SyncEngine(other, server, { library: true, log: () => {} }).sync();
    expect((await loadLibrary(other)).types.map((t) => [t.model, t.state, t.idScheme])).toEqual([['P-TS18-E', 'accepted', 'level_number']]);
    expect((await libraryChoices(other)).map((c) => c.model)).toEqual(['P-TS18-E']);
    // on the first iPad, a project made afterwards offers it with no copy of its own
    await project('Annex');
    expect((await libraryChoices(store)).map((c) => c.model)).toEqual(['P-TS18-E']);
    expect(await store.list('library_type', { where: 'project_id IS NOT NULL' })).toEqual([]);
  });

  it('a clash on a library type is listed on Needs review under the library and resolved there', async () => {
    const server = new FakeServer();
    const mk = async (install: string) => {
      const store = await Store.open(new BetterSqliteDriver(), { installId: install, search: 'like' });
      const userId = uuidv7();
      return { store, lib: new Editor(store, { projectId: LIBRARY_STREAM, userId }), engine: new SyncEngine(store, server, { library: true, log: () => {} }) };
    };
    const a = await mk('a');
    const b = await mk('b');
    const id = await createType(a.lib, a.store, { model: 'PI1002', category: 'Station' });
    await a.engine.sync();
    await b.engine.sync();
    await updateType(a.lib, a.store, id, { aliases: ['PI-1002'] });
    await updateType(b.lib, b.store, id, { aliases: ['PI1002-W'] });
    await a.engine.sync();
    await b.engine.sync();
    const list = await loadReviewList(b.store, LIBRARY_STREAM);
    expect(list.rows.map((r) => [r.kind, r.subject, r.field])).toEqual([['sync_conflict', 'Device type PI1002', 'Aliases']]);
    expect((await loadLibrary(b.store)).inReview).toBe(1);
    await b.lib.resolve(list.rows[0]!.id, { choice: 'B' }, {});
    await b.engine.sync();
    await a.engine.sync();
    for (const c of [a, b]) {
      expect((await c.store.get('library_type', id))!.aliases).toEqual(['PI1002-W']);
      expect((await loadReviewList(c.store, LIBRARY_STREAM)).rows).toEqual([]);
    }
  });
});

describe('library roles (T112, D201)', () => {
  it('a type carries a role: the rules, the Neuron ID default, the card and the ID scheme read it', async () => {
    const { store, lib, project } = await setup();
    const p = await project('Tower');
    // an NSPS in the D196 `Equipment` category: the category names no role
    const nspsType = await createType(lib, store, { model: 'P-NSPS-D-KIT', category: 'Equipment' });
    let t = (await loadLibrary(store)).types.find((x) => x.id === nspsType)!;
    expect([t.role, t.effectiveRole, t.neuronId, t.rules]).toEqual([null, 'other', false, []]); // no role, no default cables: nothing known of its wires (T146)
    await expect(updateType(lib, store, nspsType, { role: 'power supply' as never })).rejects.toThrow(/not a role/);
    await updateType(lib, store, nspsType, { role: 'nsps' });
    t = (await loadLibrary(store)).types.find((x) => x.id === nspsType)!;
    expect([t.role, t.effectiveRole, t.neuronId, t.rules]).toEqual(['nsps', 'nsps', false, ['R2d', 'R2e']]);
    // by link and by Device text (D183 (4)) the devices are NSPS: no Neuron ID
    const linked = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'Equipment', device: 'P-NSPS-D-KIT', library_type_id: nspsType }, CTX);
    const byText = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-06', category: 'Equipment', device: 'P-NSPS-D-KIT' }, CTX);
    const gateway = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-07', category: 'Equipment', device: 'RSN-DMX8-R' }, CTX);
    expect((await loadDeviceCard(store, linked.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, byText.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, gateway.id))!.device.needsNeuronId).toBe(false); // no type, no wires (T146)
    // a station type of a category that names no role: the role gives the tag scheme
    const stationType = await createType(lib, store, { model: 'UH10002', category: 'Equipment' });
    await updateType(lib, store, stationType, { role: 'station' });
    const choice = (await libraryChoices(store)).find((c) => c.id === stationType)!;
    expect(choice.role).toBe('station');
    const added = await addFieldDevice(p.editor, store, { projectId: p.id, levelId: p.levelId, category: 'Equipment', libraryTypeId: stationType, tag: '7' });
    expect(added.displayId).toBe('06M-S7');
    // the list sorts the D196 eleven in order, an old master spelling with its canonical value
    await createType(lib, store, { model: 'ERP24-FT', category: 'Power Distribution' });
    await createType(lib, store, { model: 'UFMP4', category: 'Foundry panel' });
    expect((await loadLibrary(store)).types.map((x) => x.category)).toEqual(['Power Distribution', 'Foundry panel', 'Equipment', 'Equipment']);
  });

  it('at catalogue size (T114): search by model, alias or display name; group chip; drafts only; accessories and rejected last', async () => {
    const { store, userId, lib } = await setup();
    const make = (model: string, category: string | null, extra: Record<string, unknown> = {}) =>
      lib.create('library_type', { project_id: null, model, category, state: 'draft', created_by_id: userId, ...extra }, CTX).then((r) => r.id);
    const davinci = (displayName: string) => ({ source_ref: { kind: 'davinci', display_name: displayName, family: 'Paradigm', category: 'Stations' } });
    const st = await make('P-ACP-1', 'Station', davinci('Paradigm Architectural Control Station'));
    await make('P-ACP-2', 'Station', davinci('Paradigm Architectural Control Station 2'));
    const ts = await make('P-TS7-E', 'Touchscreen', { aliases: ['TS 7'] });
    await acceptType(lib, ts);
    await make('UH-WM-KIT', 'Station', { accessory_only: true });
    const gone = await make('OLD-1', 'Station');
    await rejectType(lib, gone);
    const { types } = await loadLibrary(store);
    const keys = (gs: ReturnType<typeof libraryGroups>) => gs.map((g) => [g.key, g.types.map((t) => t.model), g.drafts]);
    expect(keys(libraryGroups(types))).toEqual([
      ['Touchscreen', ['P-TS7-E'], 0],
      ['Station', ['P-ACP-1', 'P-ACP-2'], 2],
      [ACCESSORY_GROUP, ['UH-WM-KIT'], 1],
      [REJECTED_GROUP, ['OLD-1'], 0],
    ]);
    // every word must appear somewhere; case and spaces ignored; an alias counts
    expect(keys(libraryGroups(types, { query: 'architectural 2' }))).toEqual([['Station', ['P-ACP-2'], 1]]);
    expect(keys(libraryGroups(types, { query: 'ts7' }))).toEqual([['Touchscreen', ['P-TS7-E'], 0]]);
    expect(keys(libraryGroups(types, { query: 'p-acp' })).map((g) => g[0])).toEqual(['Station']);
    expect(keys(libraryGroups(types, { group: 'Touchscreen' }))).toEqual([['Touchscreen', ['P-TS7-E'], 0]]);
    expect(keys(libraryGroups(types, { draftsOnly: true })).map((g) => g[0])).toEqual(['Station', ACCESSORY_GROUP]);
    expect(libraryGroups(types, { query: 'nothing like it' })).toEqual([]);
    expect(matchesQuery(['P-NSPS-D', null], '')).toBe(true);
    expect(matchesQuery(['Paradigm Touchscreen Station'], 'station paradigm')).toBe(true);
    expect(matchesQuery(['Paradigm Touchscreen Station'], 'station rack')).toBe(false);

    // Accept all drafts in Station: one group, one reviewed `state` op per draft under this user
    const before = await loadLibrary(store);
    expect(await acceptAllDrafts(lib, store, 'Station')).toBe(2);
    const after = await loadLibrary(store);
    expect(after.types.filter((t) => t.state === 'draft').map((t) => t.model)).toEqual(['UH-WM-KIT']);
    expect(after.drafts).toBe(before.drafts - 2);
    expect(after.inReview).toBe(before.inReview);
    const accepts = (await Promise.all(after.types.filter((t) => t.category === 'Station' && !t.accessoryOnly && t.state === 'accepted').map((t) => store.opsFor(t.id)))).map((ops) => ops.at(-1)!);
    expect(accepts).toHaveLength(2);
    expect(accepts.every((o) => o.field === 'state' && o.now === 'accepted' && o.was === 'draft' && o.user_id === userId && o.project_id === LIBRARY_STREAM)).toBe(true);
    expect(new Set(accepts.map((o) => o.group_id)).size).toBe(1);
    expect(accepts[0]!.group_id).toBeTruthy();
    expect(accepts[0]!.reason).toBe('Device-type library: Accept all drafts in Station');
    expect((await store.get('library_type', st))!).toMatchObject({ state: 'accepted' });
    // nothing left to accept; the accessories have their own; rejected ones are not bulk-accepted
    expect(await acceptAllDrafts(lib, store, 'Station')).toBe(0);
    expect(await acceptAllDrafts(lib, store, ACCESSORY_GROUP)).toBe(1);
    await expect(acceptAllDrafts(lib, store, REJECTED_GROUP)).rejects.toThrow(/one by one/);
    expect((await store.get('library_type', gone))!).toMatchObject({ state: 'rejected' });
  });

  it('the field-addition picker searches its choices the same way (T114) and offers drafts, flagged, never rejected or deleted ones', async () => {
    const { store, lib } = await setup();
    await lib.create('library_type', { project_id: null, model: 'P-ACP-1', category: 'Station', state: 'accepted', source_ref: { kind: 'davinci', display_name: 'Paradigm Architectural Control Station' } }, CTX);
    await lib.create('library_type', { project_id: null, model: 'P-TS7-E', category: 'Touchscreen', aliases: ['TS7'], state: 'accepted' }, CTX);
    await lib.create('library_type', { project_id: null, model: 'UH-WM-KIT', category: 'Station', accessory_only: true, state: 'draft' }, CTX);
    const draft = await createType(lib, store, { model: 'P-ACP-9', category: 'Station' });
    const nope = await createType(lib, store, { model: 'P-ACP-0', category: 'Station' });
    await rejectType(lib, nope);
    const gone = await createType(lib, store, { model: 'P-ACP-8', category: 'Station' });
    await deleteType(lib, gone);
    const choices = await libraryChoices(store);
    expect(choices.map((c) => [c.model, c.displayName, c.state])).toEqual([
      ['P-ACP-1', 'Paradigm Architectural Control Station', 'accepted'],
      ['P-ACP-9', null, 'draft'],
      ['P-TS7-E', null, 'accepted'],
    ]);
    expect(choices.find((c) => c.id === draft)!.state).toBe('draft');
    expect(searchChoices(choices, 'control station').map((c) => c.model)).toEqual(['P-ACP-1']);
    expect(searchChoices(choices, 'ts7').map((c) => c.model)).toEqual(['P-TS7-E']);
    expect(searchChoices(choices, '').map((c) => c.model)).toEqual(['P-ACP-1', 'P-ACP-9', 'P-TS7-E']);
    expect(searchChoices(choices, 'wm kit')).toEqual([]);
    expect((await libraryChoices(store, 'Touchscreen')).map((c) => c.model)).toEqual(['P-TS7-E']);
  });
});
