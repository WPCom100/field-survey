/**
 * Library suggestion chips (T99, D174, D212; app-level only since T196 / T197, D292 (9)): the
 * union a field offers (type, category, code, then the project's vocabulary), the device card and
 * the end editor reading it, the Library as the only place a chip is edited, the standard seed,
 * and the refusals (R4).
 */

import { Editor, LIBRARY_STREAM, Store, uuidv7, type EditContext, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { RuleParams, decideRuleParam, setRuleParam, type RuleParamRow } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import { STANDARD_PHRASES, loadDeviceCard } from '../card/model';
import { CONNECTION_PHRASES, loadCableEnds } from '../ends/model';
import { acceptType, createType, loadLibrary } from '../library/model';
import {
  acceptSuggestion,
  NO_TERM_KIT,
  addSuggestion,
  chipsFor,
  editSuggestion,
  loadStandardSuggestions,
  loadSuggestions,
  rejectSuggestion,
  removeSuggestion,
  type Suggestion,
} from './model';
import { SUGGESTION_SEED } from './seed';

const CTX: EditContext = { change_type: 'Master edit', reason: 't' };
const ME = uuidv7();

/** A project's rule parameters with these accepted values (`rule|key` → value). */
function params(values: Record<string, unknown>): RuleParams {
  return new RuleParams(
    Object.entries(values).map(([ref, value]): RuleParamRow => {
      const [rule_id, key] = ref.split('|') as [string, string];
      return { id: ref, project_id: 'p', rule_id, key, value, state: 'accepted', deleted_at: null };
    }),
  );
}

function row(scope: Suggestion['scope'], ref: string, target: Suggestion['target'], text: string, state: Suggestion['state'] = 'accepted'): Suggestion {
  return { id: uuidv7(), scope, ref, target, text, state };
}

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  let clock = 1_760_400_000_000;
  const now = () => new Date((clock += 1000)).toISOString();
  const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId: ME, now });
  const project = async (name: string) => {
    const id = uuidv7();
    const e = new Editor(store, { projectId: id, userId: ME, now });
    await e.create('project', { id, name }, CTX);
    const group = await e.create('numbering_group', { project_id: id, label: '06M' }, CTX);
    const level = await e.create('level', { project_id: id, level: '06M', floor_order: 1, numbering_group_id: group.id, in_scope: true }, CTX);
    return { id, editor: e, levelId: level.id };
  };
  return { store, lib, project, now };
}

let seq = 0;
function pulled(entity_kind: Op['entity_kind'], entity_id: string, project_id: string, payload: Record<string, unknown>): Op {
  const t = new Date(1_760_500_000_000 + ++seq * 1000).toISOString();
  return { op_id: uuidv7(), project_id, user_id: ME, install_id: 'server', client_ts: t, server_seq: seq, server_ts: t, change_type: 'Master edit', entity_kind, entity_id, kind: 'create', payload, state: 'applied' };
}

describe('suggestion chips: the union (T99, D174 (2))', () => {
  it('type, then category (an old spelling reads as its D196 name), then each code, then the vocabulary; once each; rejected and other targets never', () => {
    const rows = [
      row('code', 'X', 'device_note', 'DMX chip'),
      row('category', 'Station', 'device_note', 'Empty box on wall.'),
      row('type', 'T1', 'device_note', 'Stuck buttons'),
      row('type', 'T2', 'device_note', 'Other type'),
      row('category', 'Station', 'device_note', 'Rejected one', 'rejected'),
      row('category', 'Station', 'device_note', 'Draft one', 'draft'),
      row('category', 'Station', 'connection_note', 'Not a device note'),
      row('code', 'n', 'device_note', 'net chip'),
      row('category', 'Power Distribution', 'device_note', 'Panel chip'),
    ];
    expect(chipsFor(rows, { typeId: 'T1', category: 'Station', codes: ['N', null, 'X'] }, 'device_note', ['stuck BUTTONS', 'Not run'])).toEqual([
      'Stuck buttons',
      'Empty box on wall.',
      'Draft one',
      'net chip',
      'DMX chip',
      'Not run',
    ]);
    // the master's `Relay panel` is a Power Distribution device (T112, D201)
    expect(chipsFor(rows, { category: 'Relay panel' }, 'device_note')).toEqual(['Panel chip']);
    expect(chipsFor([], {}, 'part', ['a', 'A ', ' a'])).toEqual(['a']);
  });

  it("kit chips follow R4b.kit per code and the cable's own setting (T118, D213)", () => {
    const rows = [
      row('code', 'N', 'part', 'Network patch cord'),
      row('code', 'U', 'part', 'Unison terminal block'),
      row('code', 'X', 'connection_note', 'Waiting on DMX Termination Kits'),
    ];
    const list = ['Not run', NO_TERM_KIT];
    // the defaults: X, F, N and NG take kits; the project's list keeps its own order
    expect(chipsFor(rows, { codes: ['X'] }, 'connection_note', ['Not run'])).toEqual(['Waiting on DMX Termination Kits', NO_TERM_KIT, 'Not run']);
    expect(chipsFor(rows, { codes: ['X'] }, 'connection_note', list)).toEqual(['Waiting on DMX Termination Kits', 'Not run', NO_TERM_KIT]);
    for (const code of ['F', 'N', 'NG']) expect(chipsFor(rows, { codes: [code] }, 'connection_note', ['Not run'])).toEqual([NO_TERM_KIT, 'Not run']);
    expect(chipsFor(rows, { codes: ['U'] }, 'connection_note', list)).toEqual(['Not run']);
    expect(chipsFor(rows, { codes: ['X'] }, 'part')).toEqual(['DMX termination kit']);
    expect(chipsFor(rows, { codes: ['F'] }, 'part')).toEqual(['Fiber termination kit']);
    expect(chipsFor(rows, { codes: ['N'] }, 'part')).toEqual(['Network patch cord', 'Network termination kit']);
    expect(chipsFor(rows, { codes: ['NG'] }, 'part')).toEqual(['Network termination kit']);
    expect(chipsFor(rows, { codes: ['U'] }, 'part')).toEqual(['Unison terminal block']);
    // no code (a device's own draft): nothing computed, the list stands
    expect(chipsFor(rows, { codes: [null] }, 'connection_note', list)).toEqual(list);

    // a project that turns network kits off and Unison and DALI on, with its own part wording
    const p = params({ 'R4b|kit': { N: false, NG: false, U: true, D: true }, 'R4b|part': { U: 'Unison term kit for <far end>' } });
    expect(chipsFor(rows, { codes: ['N'], params: p }, 'part')).toEqual([]);
    expect(chipsFor(rows, { codes: ['NG'], params: p }, 'part')).toEqual([]);
    expect(chipsFor(rows, { codes: ['N'], params: p }, 'connection_note', list)).toEqual(['Not run']);
    expect(chipsFor(rows, { codes: ['U'], params: p }, 'part')).toEqual(['Unison terminal block', 'Unison term kit for']);
    expect(chipsFor(rows, { codes: ['U'], params: p }, 'connection_note', ['Not run'])).toEqual([NO_TERM_KIT, 'Not run']);
    expect(chipsFor(rows, { codes: ['D'], params: p }, 'part')).toEqual(['DALI termination kit']);
    expect(chipsFor(rows, { codes: ['X'], params: params({ 'R4b|kit': { X: false } }) }, 'part')).toEqual([]);

    // one cable's own Termination kits over its code's
    expect(chipsFor(rows, { codes: ['X'], termKit: false }, 'connection_note', list)).toEqual(['Waiting on DMX Termination Kits', 'Not run']);
    expect(chipsFor(rows, { codes: ['N'], termKit: false }, 'part')).toEqual([]);
    expect(chipsFor(rows, { codes: ['N'], params: p, termKit: true }, 'part')).toEqual(['Network patch cord', 'Network termination kit']);
    expect(chipsFor(rows, { codes: ['U'], termKit: true }, 'part')).toEqual(['Unison terminal block', 'Unison termination kit']);
  });

  it('the device card and the end editor offer the app library\'s accepted type, category and code chips before the project lists (T196)', async () => {
    const { store, lib, project } = await setup();
    const p = await project('Tower');
    const type = await createType(lib, store, { model: 'PI1002', category: 'Station' });
    await acceptType(lib, type);
    const station = await p.editor.create('device', { level_id: p.levelId, category: 'Station', device: 'PI1002' }, CTX);
    const panel = await p.editor.create('device', { level_id: p.levelId, category: 'Relay panel', device: 'ERP' }, CTX);
    const cable = await p.editor.create('cable', { project_id: p.id, cable: 'X' }, CTX);
    const endA = await p.editor.create('cable_end', { cable_id: cable.id, side: 'A', endpoint_kind: 'device', device_id: panel.id, level_id: p.levelId }, CTX);
    await p.editor.create('cable_end', { cable_id: cable.id, side: 'B', endpoint_kind: 'device', device_id: station.id, level_id: p.levelId }, CTX);

    // nothing in the library yet: the lists stand as they were
    expect((await loadDeviceCard(store, station.id))!.phrases).toEqual(STANDARD_PHRASES);
    expect((await loadCableEnds(store, endA.id))!.phrases).toEqual(CONNECTION_PHRASES);

    // every chip is the app library's (D292 (9)): added there as drafts, offered once accepted
    const add = (s: Parameters<typeof addSuggestion>[2]) => addSuggestion(lib, store, s);
    const chips = [
      await add({ scope: 'category', ref: 'Station', target: 'device_note', text: 'Empty box on wall.' }),
      await add({ scope: 'type', ref: type, target: 'device_note', text: 'Stuck buttons' }),
      await add({ scope: 'code', ref: 'X', target: 'connection_note', text: 'Missing DMX termination kit' }),
      await add({ scope: 'code', ref: 'X', target: 'punch_item', text: 'Missing DMX termination kit' }),
      await add({ scope: 'category', ref: 'Power Distribution', target: 'part', text: 'ERP-FT-LVD card' }),
    ];
    const pending = await add({ scope: 'category', ref: 'Station', target: 'device_note', text: 'Still a draft' });
    expect((await loadDeviceCard(store, station.id))!.phrases).toEqual(STANDARD_PHRASES); // drafts wait for review
    for (const id of chips) await acceptSuggestion(lib, id);
    const nope = await add({ scope: 'category', ref: 'Station', target: 'device_note', text: 'Never shown' });
    await rejectSuggestion(lib, nope);
    expect(pending).toBeTruthy();
    await p.editor.create('vocab', { project_id: p.id, list: 'device_note', value: 'Not surveyed' }, CTX);
    await p.editor.create('vocab', { project_id: p.id, list: 'punch_item', value: 'Missing all Device Neuron IDs' }, CTX);

    expect((await loadDeviceCard(store, station.id))!.phrases).toEqual(['Stuck buttons', 'Empty box on wall.', 'Not surveyed']);
    // the panel is no Station and has no type: the vocabulary only
    expect((await loadDeviceCard(store, panel.id))!.phrases).toEqual(['Not surveyed']);
    // an end shows its cable code's chips, then the project's list
    expect((await loadCableEnds(store, endA.id))!.phrases).toEqual(['Missing DMX termination kit', ...CONNECTION_PHRASES]);

    // a punch draft on the panel's DMX end offers the code's punch phrases; a part draft the category's parts
    await store.applyRemoteMany([
      pulled('proposal', uuidv7(), p.id, { project_id: p.id, rule_id: 'R3b', kind: 'punch', subject: { entity: 'cable_end', entity_id: endA.id }, discriminator: 'a', payload: { item: 'Terminate DMX', type: 'Missing part', owner: 'EC/ETC' } }),
      pulled('proposal', uuidv7(), p.id, { project_id: p.id, rule_id: 'R4b', kind: 'part', subject: { entity: 'device', entity_id: panel.id }, discriminator: 'b', payload: { part: 'DMX termination kit', owner: 'EC' } }),
    ]);
    const card = (await loadDeviceCard(store, panel.id))!;
    expect(card.drafts.find((d) => d.kind === 'punch')!.chips).toEqual({ item: ['Missing DMX termination kit', 'Missing all Device Neuron IDs'] });
    expect(card.drafts.find((d) => d.kind === 'part')!.chips).toEqual({ part: ['ERP-FT-LVD card'] });
  });

  it("the card and the end editor read the project's R4b.kit and the cable's own setting (T118)", async () => {
    const { store, project } = await setup();
    const p = await project('Tower');
    const panel = await p.editor.create('device', { level_id: p.levelId, category: 'Relay panel', device: 'ERP' }, CTX);
    const rack = await p.editor.create('device', { level_id: p.levelId, category: 'Equipment Rack', device: 'Rack' }, CTX);
    const net = await p.editor.create('cable', { project_id: p.id, cable: 'N' }, CTX);
    const netA = await p.editor.create('cable_end', { cable_id: net.id, side: 'A', endpoint_kind: 'device', device_id: panel.id, level_id: p.levelId }, CTX);
    await p.editor.create('cable_end', { cable_id: net.id, side: 'B', endpoint_kind: 'device', device_id: rack.id, level_id: p.levelId }, CTX);
    await store.applyRemoteMany([
      pulled('proposal', uuidv7(), p.id, { project_id: p.id, rule_id: 'R4b', kind: 'part', subject: { entity: 'cable_end', entity_id: netA.id }, discriminator: 'k', payload: { part: 'Network termination kit - Rack run', owner: 'EC' } }),
    ]);
    const partChips = async () => (await loadDeviceCard(store, panel.id))!.drafts.find((d) => d.kind === 'part')!.chips;
    const phrases = async () => (await loadCableEnds(store, netA.id))!.phrases;
    expect(await partChips()).toEqual({ part: ['Network termination kit'] });
    expect(await phrases()).toEqual(CONNECTION_PHRASES);
    await setRuleParam(p.editor, 'R4b', 'kit', { N: false });
    expect(await partChips()).toBeUndefined();
    expect(await phrases()).toEqual(CONNECTION_PHRASES.filter((t) => t !== NO_TERM_KIT));
    // the cable's own Yes wins over its code
    await p.editor.setField('cable', net.id, 'term_kit', true, CTX);
    expect(await partChips()).toEqual({ part: ['Network termination kit'] });
    expect(await phrases()).toEqual(CONNECTION_PHRASES);
  });
});

describe('suggestion chips: the library (T99, D174 (3); the only place to edit them, T197, D292 (9))', () => {
  it("a chip is added, accepted and removed in the Library only; a type's chips hang off the library type; the standard seed as drafts, once", async () => {
    const { store, lib, project } = await setup();
    const a = await project('Tower');
    const type = await createType(lib, store, { model: 'PI1002', category: 'Station' });
    await acceptType(lib, type);
    // a project offers no chip editor: its editor is refused before anything is written
    await expect(addSuggestion(a.editor, store, { scope: 'type', ref: type, target: 'device_note', text: 'Stuck buttons' })).rejects.toThrow(/edited in the Library/);
    const kept = await addSuggestion(lib, store, { scope: 'type', ref: type, target: 'device_note', text: 'Stuck buttons' });
    for (const write of [() => acceptSuggestion(a.editor, kept), () => rejectSuggestion(a.editor, kept), () => removeSuggestion(a.editor, kept), () => editSuggestion(a.editor, store, kept, 'Stuck keys')]) {
      await expect(write()).rejects.toThrow(/edited in the Library/);
    }
    await acceptSuggestion(lib, kept);
    await editSuggestion(lib, store, kept, ' Stuck  keys ');
    expect((await loadSuggestions(store)).map((x) => [x.scope, x.ref, x.text, x.state])).toEqual([['type', type, 'Stuck keys', 'accepted']]);
    expect((await store.opsFor(kept)).every((o) => o.project_id === LIBRARY_STREAM)).toBe(true);
    expect(await store.list('suggestion', { where: 'project_id IS NOT NULL' })).toEqual([]);

    // the standard seed: drafts in the app library, once; a rejected one is not offered again
    expect(await loadStandardSuggestions(lib, store)).toBe(SUGGESTION_SEED.length);
    expect(await loadStandardSuggestions(lib, store)).toBe(0);
    const seeded = (await loadSuggestions(store)).filter((x) => x.scope !== 'type');
    expect(seeded.every((x) => x.state === 'draft')).toBe(true);
    const stuck = seeded.find((x) => x.ref === 'Station' && x.text === 'Stuck buttons')!;
    await acceptSuggestion(lib, stuck.id);
    await rejectSuggestion(lib, seeded.find((x) => x.ref === 'Touchscreen')!.id);
    expect(await loadStandardSuggestions(lib, store)).toBe(0);
    await expect(loadStandardSuggestions(a.editor, store)).rejects.toThrow(/app library/);
  });

  it("refuses an empty phrase, a chip already there, and a Part chip on a network code whose kits are off in the app library's Rules (R4, D213); the seed offers none", async () => {
    const { store, lib } = await setup();
    await expect(addSuggestion(lib, store, { scope: 'code', ref: 'X', target: 'connection_note', text: '  ' })).rejects.toThrow(/phrase first/);
    const id = await addSuggestion(lib, store, { scope: 'code', ref: 'X', target: 'connection_note', text: 'Missing DMX termination kit' });
    await expect(addSuggestion(lib, store, { scope: 'code', ref: 'x', target: 'connection_note', text: ' missing dmx termination KIT' })).rejects.toThrow(/already offered/);
    // the same words for another place, or after removal, are fine
    await addSuggestion(lib, store, { scope: 'code', ref: 'X', target: 'punch_item', text: 'Missing DMX termination kit' });
    await removeSuggestion(lib, id);
    await addSuggestion(lib, store, { scope: 'code', ref: 'X', target: 'connection_note', text: 'Missing DMX termination kit' });
    // network kits are parts by default (D213); the app library's accepted Rules turning them off refuse the Part chip
    await addSuggestion(lib, store, { scope: 'code', ref: 'N', target: 'part', text: 'Network termination kit' });
    expect((await loadLibrary(store)).noPartCodes).toEqual([]);
    await setRuleParam(lib, 'R4b', 'kit', { N: false, NG: false, U: false });
    expect((await loadLibrary(store)).noPartCodes).toEqual([]); // a draft setting is not enough
    await decideRuleParam(lib, 'R4b', 'kit', 'accepted');
    for (const code of ['N', 'ng']) {
      await expect(addSuggestion(lib, store, { scope: 'code', ref: code, target: 'part', text: 'Network patch cord' })).rejects.toThrow(/offers no Part chips/);
    }
    expect((await loadLibrary(store)).noPartCodes).toEqual(['N', 'NG']);
    // a non-network code with kits off still offers Part chips
    await addSuggestion(lib, store, { scope: 'code', ref: 'U', target: 'part', text: 'Unison terminal block' });
    expect(SUGGESTION_SEED.filter((x) => x.target === 'part')).toEqual([]);
    expect(SUGGESTION_SEED.filter((x) => /network termination/i.test(x.text)).map((x) => x.target)).toEqual(['connection_note', 'punch_item', 'connection_note', 'punch_item']);
    // a category chip is stored under its D196 name
    await addSuggestion(lib, store, { scope: 'category', ref: 'Relay panel', target: 'device_note', text: 'Panel chip' });
    expect((await loadSuggestions(store)).find((x) => x.scope === 'category')!.ref).toBe('Power Distribution');
  });
});
