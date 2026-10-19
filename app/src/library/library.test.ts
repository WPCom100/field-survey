/**
 * The device-type library editor (T48): drafts from "+ New type" and from field additions (T23),
 * edits as one group, accept / reject / reopen, "Copy from…", and accepting a type with default
 * cables raising R2g drafts for the devices that already exist (through the real engine).
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
  copySources,
  copyTypes,
  createType,
  describeCable,
  editorStamp,
  libraryGroups,
  loadLibrary,
  matchesQuery,
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

  it('the editor stamp changes only with what the form holds (T125: Save keeps the panel)', async () => {
    const { store, project } = await setup();
    const p = await project('Tower');
    const id = await createType(p.editor, store, p.id, { model: 'ERn2-W-120 Mk2', category: 'Equipment Rack' });
    const load = async () => (await loadLibrary(store, p.id)).types.find((t) => t.id === id)!;
    const before = await load();
    expect(editorStamp(await load())).toBe(editorStamp(before)); // a reload with nothing new keeps the form
    await updateType(p.editor, store, id, { optionalCables: [{ ...blankCable('N'), to: 'switch', far: 'Network switch' }] });
    const saved = await load();
    expect(editorStamp(saved)).not.toBe(editorStamp(before)); // the saved values reach the form
    await acceptType(p.editor, id);
    expect(editorStamp(await load())).not.toBe(editorStamp(saved)); // so does a state change
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
    expect(rulesForType('nsps', [])).toEqual(['R2d', 'R2e']);
    expect(rulesForType('relay_panel', [])).toEqual(['R2c']);
    expect(rulesForType('other', [])).toEqual([]);
    await expect(updateType(p.editor, store, id, { defaultCables: [{ ...blankCable('Z') }] })).rejects.toThrow(/not a cable code/);
    await expect(updateType(p.editor, store, id, { optionalAccessories: [{ model: ' ', expected_qty: 1 }] })).rejects.toThrow(/needs a model/);
    await expect(updateType(p.editor, store, id, { model: '' })).rejects.toThrow(/needs a model/);
  });

  it("a code the scope's Rules give a signal word is a cable code of its types, the picker and the card (T117)", async () => {
    const { store, userId, project } = await setup();
    const p = await project('Tower');
    const id = await createType(p.editor, store, p.id, { model: 'DALI-GW', category: 'Equipment' });
    const dx = { ...blankCable('DX'), to: 'DALI-2 bus', far: 'Fixtures' };
    expect((await loadLibrary(store, p.id)).codes).toEqual(['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V', 'D']);
    await expect(updateType(p.editor, store, id, { optionalCables: [dx] })).rejects.toThrow(/"DX" is not a cable code/);
    await setRuleParam(p.editor, 'R3', 'signal', { DX: 'DALI-2' });
    await updateType(p.editor, store, id, { optionalCables: [dx] });
    const view = await loadLibrary(store, p.id);
    expect(view.codes.slice(-2)).toEqual(['D', 'DX']);
    expect(view.types[0]!.optionalCables.map((c) => c.code)).toEqual(['DX']);
    // the card offers the run on a device of the type
    const device = await p.editor.create('device', { level_id: p.levelId, category: 'Equipment', device: 'DALI-GW', library_type_id: id }, CTX);
    expect((await loadDeviceCard(store, device.id))!.cableOffers.map((o) => o.cable.code)).toEqual(['DX']);
    // the app library reads its own accepted Rules: a draft word is not enough; another project knows nothing of DX
    const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId });
    const appType = await createType(lib, store, null, { model: 'DALI-GW', category: 'Equipment' });
    await setRuleParam(lib, 'R3', 'signal', { DX: 'DALI-2' });
    await expect(updateType(lib, store, appType, { optionalCables: [dx] })).rejects.toThrow(/not a cable code/);
    await decideRuleParam(lib, 'R3', 'signal', 'accepted');
    await updateType(lib, store, appType, { optionalCables: [dx] });
    expect((await loadLibrary(store, null)).types[0]!.optionalCables.map((c) => c.code)).toEqual(['DX']);
    expect((await loadLibrary(store, (await project('Other')).id)).codes).not.toContain('DX');
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

describe('library roles (T112, D201)', () => {
  it('a type carries a role: the rules, the Neuron ID default, the card and the ID scheme read it; Copy from carries it', async () => {
    const { store, project } = await setup();
    const p = await project('Tower');
    // an NSPS in the D196 `Equipment` category: the category names no role
    const nspsType = await createType(p.editor, store, p.id, { model: 'P-NSPS-D-KIT', category: 'Equipment' });
    let t = (await loadLibrary(store, p.id)).types.find((x) => x.id === nspsType)!;
    expect([t.role, t.effectiveRole, t.neuronId, t.rules]).toEqual([null, 'other', true, []]);
    await expect(updateType(p.editor, store, nspsType, { role: 'power supply' as never })).rejects.toThrow(/not a role/);
    await updateType(p.editor, store, nspsType, { role: 'nsps' });
    t = (await loadLibrary(store, p.id)).types.find((x) => x.id === nspsType)!;
    expect([t.role, t.effectiveRole, t.neuronId, t.rules]).toEqual(['nsps', 'nsps', false, ['R2d', 'R2e']]);
    // by link and by Device text (D183 (4)) the devices are NSPS: no Neuron ID
    const linked = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-05', category: 'Equipment', device: 'P-NSPS-D-KIT', library_type_id: nspsType }, CTX);
    const byText = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-06', category: 'Equipment', device: 'P-NSPS-D-KIT' }, CTX);
    const gateway = await p.editor.create('device', { level_id: p.levelId, display_id: '06M-07', category: 'Equipment', device: 'RSN-DMX8-R' }, CTX);
    expect((await loadDeviceCard(store, linked.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, byText.id))!.device.needsNeuronId).toBe(false);
    expect((await loadDeviceCard(store, gateway.id))!.device.needsNeuronId).toBe(true);
    // a station type of a category that names no role: the role gives the tag scheme
    const stationType = await createType(p.editor, store, p.id, { model: 'UH10002', category: 'Equipment' });
    await updateType(p.editor, store, stationType, { role: 'station' });
    const choice = (await libraryChoices(store, p.id)).find((c) => c.id === stationType)!;
    expect(choice.role).toBe('station');
    const added = await addFieldDevice(p.editor, store, { projectId: p.id, levelId: p.levelId, category: 'Equipment', libraryTypeId: stationType, tag: '7' });
    expect(added.displayId).toBe('06M-S7');
    // Copy from… carries the role
    await acceptType(p.editor, nspsType);
    const q = await project('Annex');
    await copyTypes(q.editor, store, q.id, [nspsType]);
    const copy = (await loadLibrary(store, q.id)).types.find((x) => x.model === 'P-NSPS-D-KIT')!;
    expect([copy.role, copy.effectiveRole]).toEqual(['nsps', 'nsps']);
    // the list sorts the D196 eleven in order, an old master spelling with its canonical value
    await createType(p.editor, store, p.id, { model: 'ERP24-FT', category: 'Power Distribution' });
    await createType(p.editor, store, p.id, { model: 'UFMP4', category: 'Foundry panel' });
    expect((await loadLibrary(store, p.id)).types.map((x) => x.category)).toEqual(['Power Distribution', 'Foundry panel', 'Equipment', 'Equipment']);
  });

  it('at catalogue size (T114): search by model, alias or display name; group chip; drafts only; accessories and rejected last', async () => {
    const { store, userId } = await setup();
    const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId });
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
    const { types } = await loadLibrary(store, null);
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
    const before = await loadLibrary(store, null);
    expect(await acceptAllDrafts(lib, store, null, 'Station')).toBe(2);
    const after = await loadLibrary(store, null);
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
    expect(await acceptAllDrafts(lib, store, null, 'Station')).toBe(0);
    expect(await acceptAllDrafts(lib, store, null, ACCESSORY_GROUP)).toBe(1);
    await expect(acceptAllDrafts(lib, store, null, REJECTED_GROUP)).rejects.toThrow(/one by one/);
    expect((await store.get('library_type', gone))!).toMatchObject({ state: 'rejected' });
  });

  it('the field-addition picker searches its choices the same way (T114)', async () => {
    const { store, userId, project } = await setup();
    const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId });
    await lib.create('library_type', { project_id: null, model: 'P-ACP-1', category: 'Station', state: 'accepted', source_ref: { kind: 'davinci', display_name: 'Paradigm Architectural Control Station' } }, CTX);
    await lib.create('library_type', { project_id: null, model: 'P-TS7-E', category: 'Touchscreen', aliases: ['TS7'], state: 'accepted' }, CTX);
    await lib.create('library_type', { project_id: null, model: 'UH-WM-KIT', category: 'Station', accessory_only: true, state: 'draft' }, CTX);
    const p = await project('Tower');
    const choices = await libraryChoices(store, p.id);
    expect(choices.map((c) => [c.model, c.displayName])).toEqual([
      ['P-ACP-1', 'Paradigm Architectural Control Station'],
      ['P-TS7-E', null],
    ]);
    expect(searchChoices(choices, 'control station').map((c) => c.model)).toEqual(['P-ACP-1']);
    expect(searchChoices(choices, 'ts7').map((c) => c.model)).toEqual(['P-TS7-E']);
    expect(searchChoices(choices, '').map((c) => c.model)).toEqual(['P-ACP-1', 'P-TS7-E']);
    expect(searchChoices(choices, 'wm kit')).toEqual([]);
  });
});
