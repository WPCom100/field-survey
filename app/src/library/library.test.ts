/**
 * The device-type library editor (T48): drafts from "+ New type" and from field additions (T23),
 * edits as one group, accept / reject / reopen, "Copy from…", and accepting a type with default
 * cables raising R2g drafts for the devices that already exist (through the real engine).
 */

import { Editor, LIBRARY_STREAM, Store, SyncEngine, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { addFieldDevice, libraryChoices } from '../additions/model';
import { loadReviewList } from '../review/model';
import { loadDeviceCard } from '../card/model';
import { asFound, drillRows, loadDashboard } from '../dashboard/model';
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
  promoteType,
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

  it('Neuron ID per type (T68, D185): category default, the flag in the editor, the card, the dashboard and Copy from', async () => {
    const { store, project } = await setup();
    const p = await project('Tower');
    const nspsType = await createType(p.editor, store, p.id, { model: 'P-NSPS-D-KIT', category: 'NSPS' });
    const stationType = await createType(p.editor, store, p.id, { model: 'PI1002', category: 'Station' });
    let lib = await loadLibrary(store, p.id);
    expect(lib.types.map((t) => [t.model, t.needsNeuronId, t.neuronId])).toEqual([
      ['P-NSPS-D-KIT', null, false],
      ['PI1002', null, true],
    ]);
    const nsps = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'NSPS', device: 'P-NSPS-D-KIT' }, CTX);
    const rack = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-06', category: 'Equipment rack', device: 'Rack' }, CTX);
    const station = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-S1', category: 'Station', library_type_id: stationType }, CTX);
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, rack.id))!.device.needsNeuronId).toBe(false); // no type: the category decides
    expect((await loadDeviceCard(store, station.id))!.device.needsNeuronId).toBe(true);
    let dash = await loadDashboard(store, p.id);
    expect(asFound(dash)).toMatchObject({ neuronCaptured: 0, neuronDevices: 1, devices: 3 });
    expect(drillRows(dash, { table: 'asFound', key: 'neuronMissing', status: null }).map((r) => r.label)).toEqual(['06M-S1']);
    // the editor's flag: one op; the station type stops needing one, the NSPS type starts
    await updateType(p.editor, store, nspsType, { needsNeuronId: true });
    await updateType(p.editor, store, stationType, { needsNeuronId: false });
    expect((await store.opsFor(nspsType)).at(-1)).toMatchObject({ field: 'needs_neuron_id', now: true });
    lib = await loadLibrary(store, p.id);
    expect(lib.types.map((t) => [t.model, t.needsNeuronId, t.neuronId])).toEqual([
      ['P-NSPS-D-KIT', true, true],
      ['PI1002', false, false],
    ]);
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(true);
    expect((await loadDeviceCard(store, station.id))!.device.needsNeuronId).toBe(false);
    dash = await loadDashboard(store, p.id);
    expect(drillRows(dash, { table: 'asFound', key: 'neuronMissing', status: null }).map((r) => r.label)).toEqual(['06M-05']);
    // back to the category default
    await updateType(p.editor, store, nspsType, { needsNeuronId: null });
    expect((await loadDeviceCard(store, nsps.id))!.device.needsNeuronId).toBe(false);
    // Copy from carries the flag
    await acceptType(p.editor, stationType);
    const q = await project('Other');
    await copyTypes(q.editor, store, q.id, [stationType]);
    expect((await loadLibrary(store, q.id)).types[0]).toMatchObject({ model: 'PI1002', needsNeuronId: false, neuronId: false });
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
    expect(await draftsOf()).toEqual(['R2d 120V → P-NSPS-D Power Supply']);
    await acceptType(p.editor, id);
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

describe('app-level library manager (T61, D65, D184)', () => {
  it('edits the app library without a project, on its own stream', async () => {
    const { store, userId, project } = await setup();
    const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId });
    const id = await createType(lib, store, null, { model: 'P-TS7-E', category: 'Touchscreen' });
    await updateType(lib, store, id, { aliases: ['TS7'], defaultCables: [{ ...blankCable('N'), to: 'Network switch' }] });
    await acceptType(lib, id);
    expect(await store.get('library_type', id)).toMatchObject({ project_id: null, state: 'accepted' });
    expect((await store.opsFor(id)).every((o) => o.project_id === LIBRARY_STREAM)).toBe(true);
    const app = await loadLibrary(store, null);
    expect(app.types.map((t) => [t.model, t.projectId, t.state])).toEqual([['P-TS7-E', null, 'accepted']]);
    // a project's library is separate; its pickers see the app type until it has its own copy
    const p = await project('Tower');
    expect((await loadLibrary(store, p.id)).types).toEqual([]);
    expect((await libraryChoices(store, p.id)).map((c) => [c.model, c.projectId])).toEqual([['P-TS7-E', null]]);
    // "Copy from…" in the app library offers the projects; copying is a promotion
    const own = await createType(p.editor, store, p.id, { model: 'P-LS', category: 'Sensor' });
    await acceptType(p.editor, own);
    expect((await copySources(store, null)).map((s) => [s.id, s.types.map((t) => t.model)])).toEqual([[p.id, ['P-LS']]]);
    await copyTypes(lib, store, null, [own]);
    expect((await loadLibrary(store, null)).types.find((t) => t.model === 'P-LS')).toMatchObject({ promotedFromId: own, state: 'accepted' });
  });

  it('promotes an accepted project type once; the app type reaches another iPad and new projects', async () => {
    const server = new FakeServer();
    const { store, userId, project } = await setup();
    const a = await project('A');
    const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId });
    const draft = await createType(a.editor, store, a.id, { model: 'P-TS18-E', category: 'Touchscreen' });
    await expect(promoteType(lib, store, draft)).rejects.toThrow(/Accept the type/);
    await updateType(a.editor, store, draft, { idScheme: 'level_number', optionalAccessories: [{ model: 'Back box', expected_qty: 1 }] });
    await acceptType(a.editor, draft);
    await expect(promoteType(a.editor, store, draft)).rejects.toThrow(/writes to the app library/);
    const appId = await promoteType(lib, store, draft);
    expect(await store.get('library_type', appId)).toMatchObject({
      project_id: null, model: 'P-TS18-E', promoted_from_id: draft, state: 'accepted', id_scheme: 'level_number',
      optional_accessories: [{ model: 'Back box', expected_qty: 1 }],
    });
    expect((await loadLibrary(store, a.id)).types[0]!.promotedAs).toBe(appId);
    await expect(promoteType(lib, store, draft)).rejects.toThrow(/already has P-TS18-E/);
    // the promotion syncs on the library stream: a second iPad with no project gets it
    const engine = new SyncEngine(store, server, { library: true, log: () => {} });
    await engine.sync();
    expect(server.ops(LIBRARY_STREAM).map((o) => [o.entity_kind, o.kind])).toEqual([['library_type', 'create']]);
    const other = await Store.open(new BetterSqliteDriver(), { installId: 'j', search: 'like' });
    await new SyncEngine(other, server, { library: true, log: () => {} }).sync();
    expect((await loadLibrary(other, null)).types.map((t) => [t.model, t.promotedFromId])).toEqual([['P-TS18-E', draft]]);
    // a project B made later offers it (the server copies it at creation: server test_library.py)
    const b = await project('B');
    expect((await libraryChoices(store, b.id)).map((c) => c.model)).toEqual(['P-TS18-E']);
  });

  it('a clash on an app-library type is listed on Needs review under the library and resolved there', async () => {
    const server = new FakeServer();
    const mk = async (install: string) => {
      const store = await Store.open(new BetterSqliteDriver(), { installId: install, search: 'like' });
      const userId = uuidv7();
      return { store, lib: new Editor(store, { projectId: LIBRARY_STREAM, userId }), engine: new SyncEngine(store, server, { library: true, log: () => {} }) };
    };
    const a = await mk('a');
    const b = await mk('b');
    const id = await createType(a.lib, a.store, null, { model: 'PI1002', category: 'Station' });
    await a.engine.sync();
    await b.engine.sync();
    await updateType(a.lib, a.store, id, { aliases: ['PI-1002'] });
    await updateType(b.lib, b.store, id, { aliases: ['PI1002-W'] });
    await a.engine.sync();
    await b.engine.sync();
    const list = await loadReviewList(b.store, LIBRARY_STREAM);
    expect(list.rows.map((r) => [r.kind, r.subject, r.field])).toEqual([['sync_conflict', 'Device type PI1002', 'Aliases']]);
    expect((await loadLibrary(b.store, null)).inReview).toBe(1);
    await b.lib.resolve(list.rows[0]!.id, { choice: 'B' }, {});
    await b.engine.sync();
    await a.engine.sync();
    for (const c of [a, b]) {
      expect((await c.store.get('library_type', id))!.aliases).toEqual(['PI1002-W']);
      expect((await loadReviewList(c.store, LIBRARY_STREAM)).rows).toEqual([]);
    }
  });
});
