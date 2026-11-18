/**
 * First use of a type (T200, D292 (1), (2)): what is asked (a draft type's cable rows, the import's
 * exceptions preset to Required), when (a device entering, an accessory added, several listed
 * once), what Confirm writes (the two lists and `accepted`, one group on the library stream), that
 * it is never asked twice — on this iPad or on another that pulled the answer — and Later.
 */

import { Editor, LIBRARY_STREAM, Store, SyncEngine, uuidv7, type EditContext } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { addFieldDevice } from '../additions/model';
import { loadReviewList } from '../review/model';
import { cablesFor, loadDeviceTypes } from './neuron';
import { acceptType, createType, rejectType, updateType, blankCable } from './model';
import {
  answerLine,
  answerTypeSetup,
  askTypeSetup,
  mergeQuestions,
  onTypeSetup,
  questionsForAccessory,
  questionsForDevices,
  questionsForDrafts,
  questionsForProject,
  type TypeSetupQuestion,
} from './typeSetup';

const CTX: EditContext = { change_type: 'Master edit', reason: 't' };
const ref = (exceptions: { code: string; decision: string; reason: string }[] = []) => ({ kind: 'davinci', display_name: 'x', ...(exceptions.length ? { exceptions } : {}) });
const row = (code: string, extra: Record<string, unknown> = {}) => ({ code, from: null, to: null, far: null, single_row: false, qty: 1, status: null, ...extra });
const SUPPLY = { code: '120V', decision: 'D198', reason: 'a power supply needs a 120 V feed; DaVinci gives it no Power port' };

async function ipad(server: FakeServer | null, install: string, userId = uuidv7()) {
  const store = await Store.open(new BetterSqliteDriver(), { installId: install, search: 'like' });
  let clock = 1_760_300_000_000;
  const now = () => new Date((clock += 1000)).toISOString();
  const lib = new Editor(store, { projectId: LIBRARY_STREAM, userId, now });
  const engine = server ? new SyncEngine(store, server, { library: true, log: () => {} }) : null;
  return { store, lib, userId, now, engine };
}

async function project(store: Store, userId: string, now: () => string, id = uuidv7()) {
  const e = new Editor(store, { projectId: id, userId, now });
  await e.create('project', { id, name: 'Tower' }, CTX);
  const group = await e.create('numbering_group', { project_id: id, label: '06M' }, CTX);
  const level = await e.create('level', { project_id: id, level: '06M', floor_order: 1, numbering_group_id: group.id, in_scope: true, surveyed: '2026-10-13' }, CTX);
  return { id, editor: e, levelId: level.id };
}

/** A type as the DaVinci import writes it (T199, D292 (1)): every row undecided in `optional_cables`, the exceptions named. */
async function imported(lib: Editor, model: string, f: Record<string, unknown>) {
  return (await lib.create('library_type', { project_id: null, model, state: 'draft', source_ref: ref(), ...f }, CTX)).id;
}

describe('first use of a type (T200)', () => {
  it('asks a draft type its rows once, the exceptions preset Required; Confirm writes both lists and accepted on the library stream; never asked again', async () => {
    const server = new FakeServer();
    const a = await ipad(server, 'a');
    const p = await project(a.store, a.userId, a.now);
    const panel = await imported(a.lib, 'ERn2', { category: 'Power Distribution', role: 'relay_panel', optional_cables: [row('N'), row('P', { single_row: true }), row('120V', { single_row: true, extra_key: 'kept' })], source_ref: ref([SUPPLY]) });

    const added = await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Power Distribution', libraryTypeId: panel });
    const [q, ...rest] = await questionsForDevices(a.store, [added.deviceId]);
    expect(rest).toEqual([]);
    expect(q).toMatchObject({ typeId: panel, model: 'ERn2', category: 'Power Distribution', via: null });
    expect(q!.rows.map((r) => [r.key, r.cable.code, r.required, r.why])).toEqual([
      ['o0', 'N', false, null],
      ['o1', 'P', false, null],
      ['o2', '120V', true, SUPPLY.reason],
    ]);
    expect(answerLine(q!, {})).toBe('1 required · 2 optional');
    // a draft requires nothing yet: every row is only offered (D288 (2))
    expect(cablesFor(await loadDeviceTypes(a.store), { library_type_id: panel }).required).toEqual([]);

    // Confirm: P made Required, the rest as preset
    const ops = await answerTypeSetup(p.editor, a.store, q!, { o1: true });
    expect(ops!.map((o) => [o.project_id, o.entity_kind, o.field, o.change_type])).toEqual([
      [LIBRARY_STREAM, 'library_type', 'default_cables', 'Master edit'],
      [LIBRARY_STREAM, 'library_type', 'optional_cables', 'Master edit'],
      [LIBRARY_STREAM, 'library_type', 'state', 'Master edit'],
    ]);
    expect(new Set(ops!.map((o) => o.group_id)).size).toBe(1);
    expect(ops![0]!.reason).toBe('Device-type library: first use of ERn2');
    const t = (await a.store.get<Record<string, unknown>>('library_type', panel))!;
    expect(t.state).toBe('accepted');
    expect(t.default_cables).toEqual([row('P', { single_row: true }), row('120V', { single_row: true, extra_key: 'kept' })]);
    expect(t.optional_cables).toEqual([row('N')]);
    const plan = cablesFor(await loadDeviceTypes(a.store), { library_type_id: panel });
    expect([plan.required.map((c) => c.cable.code), plan.optional.map((c) => c.cable.code)]).toEqual([['P', '120V'], ['N']]);

    // not asked twice: the next device of the type, and a second Confirm of the old question, do nothing
    const next = await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Power Distribution', libraryTypeId: panel });
    expect(await questionsForDevices(a.store, [next.deviceId])).toEqual([]);
    expect(await answerTypeSetup(p.editor, a.store, q!, {})).toBeNull();

    // another iPad that pulled the answer stays quiet for its own device of the type
    await a.engine!.sync();
    const b = await ipad(server, 'b');
    await b.engine!.sync();
    const pb = await project(b.store, b.userId, b.now);
    const there = await addFieldDevice(pb.editor, b.store, { projectId: pb.id, levelId: pb.levelId, category: 'Power Distribution', libraryTypeId: panel });
    expect(await questionsForDevices(b.store, [there.deviceId])).toEqual([]);
    expect(server.ops(LIBRARY_STREAM).filter((o) => o.field === 'state').map((o) => o.now)).toEqual(['accepted']);
  });

  it('Later writes nothing: the type stays a draft, requires nothing, and is asked again at its next use', async () => {
    const a = await ipad(null, 'a');
    const p = await project(a.store, a.userId, a.now);
    const ts = await imported(a.lib, 'P-TS7-E', { category: 'Touchscreen', optional_cables: [row('U')] });
    const before = (await a.store.opsFor(ts)).length;
    const first = await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Touchscreen', libraryTypeId: ts });
    expect((await questionsForDevices(a.store, [first.deviceId])).map((q) => q.model)).toEqual(['P-TS7-E']);
    // (Later = the sheet closes; nothing is called)
    expect((await a.store.opsFor(ts)).length).toBe(before);
    expect((await a.store.get<Record<string, unknown>>('library_type', ts))!.state).toBe('draft');
    const second = await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Touchscreen', libraryTypeId: ts });
    expect((await questionsForDevices(a.store, [second.deviceId])).map((q) => q.model)).toEqual(['P-TS7-E']);
  });

  it('asks nothing of an accepted, rejected or row-less type (a model typed in the field stays a draft for the Library)', async () => {
    const a = await ipad(null, 'a');
    const p = await project(a.store, a.userId, a.now);
    const ok = await createType(a.lib, a.store, { model: 'PI1002', category: 'Station' });
    await updateType(a.lib, a.store, ok, { optionalCables: [blankCable('U')] });
    await acceptType(a.lib, ok);
    const no = await imported(a.lib, 'OLD-1', { category: 'Station', optional_cables: [row('U')] });
    await rejectType(a.lib, no);
    const devices = [
      (await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Station', libraryTypeId: ok })).deviceId,
      (await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Station', typedModel: 'NEW-STATION-9' })).deviceId,
    ];
    const rejected = await p.editor.create('device', { level_id: p.levelId, category: 'Station', device: 'OLD-1', library_type_id: no }, CTX);
    expect(await questionsForDevices(a.store, [...devices, rejected.id])).toEqual([]);
  });

  it("a hand-made draft's default rows start Required; an accessory is asked as carried — a forced slot with the device, a row when it is added", async () => {
    const a = await ipad(null, 'a');
    const p = await project(a.store, a.userId, a.now);
    const supply = await imported(a.lib, 'P-NSPS-D Power Supply', { accessory_only: true, optional_cables: [row('120V', { single_row: true })], source_ref: ref([SUPPLY]) });
    const card = await imported(a.lib, 'ERP-FT-LVD', { accessory_only: true, optional_cables: [row('0-10V', { single_row: true, qty: 24 })] });
    const kit = await createType(a.lib, a.store, { model: 'P-NSPS-D-KIT', category: 'Equipment' });
    await updateType(a.lib, a.store, kit, {
      role: 'nsps',
      defaultCables: [blankCable('U')],
      optionalAccessories: [{ model: 'P-NSPS-D Power Supply', expected_qty: 1 }, { model: 'ERP-FT-LVD', expected_qty: null }],
    });
    const d = await addFieldDevice(p.editor, a.store, { projectId: p.id, levelId: p.levelId, category: 'Equipment', libraryTypeId: kit });
    const qs = await questionsForDevices(a.store, [d.deviceId]);
    // the device's own type, then its forced supply (carried with no row, D297 (1)); the card is not carried
    expect(qs.map((q) => [q.model, q.via, q.rows.map((r) => [r.cable.code, r.required, r.why])])).toEqual([
      ['P-NSPS-D-KIT', null, [['U', true, 'required on the type']]],
      ['P-NSPS-D Power Supply', 'P-NSPS-D-KIT', [['120V', true, SUPPLY.reason]]],
    ]);
    // the card is asked when it is added to the device (the card's "+ add")
    expect((await questionsForAccessory(a.store, 'erp-ft-lvd', 'P-NSPS-D-KIT')).map((q) => [q.typeId, q.via, q.rows[0]!.required])).toEqual([[card, 'P-NSPS-D-KIT', false]]);
    // …and with the device when its row exists (a placed draft brings its accessory rows)
    await p.editor.create('accessory', { device_id: d.deviceId, model: 'ERP-FT-LVD', expected_qty: 2 }, CTX);
    expect((await questionsForDevices(a.store, [d.deviceId])).map((q) => q.model)).toEqual(['P-NSPS-D-KIT', 'P-NSPS-D Power Supply', 'ERP-FT-LVD']);
    // answering the card Optional: allowed, never required (D292 (1): "sold for future expansions")
    const [cardQ] = await questionsForAccessory(a.store, 'ERP-FT-LVD', 'P-NSPS-D-KIT');
    await answerTypeSetup(p.editor, a.store, cardQ!, {});
    expect(await a.store.get<Record<string, unknown>>('library_type', card)).toMatchObject({ state: 'accepted', default_cables: null, optional_cables: [row('0-10V', { single_row: true, qty: 24 })] });
    expect(await a.store.get<Record<string, unknown>>('library_type', supply)).toMatchObject({ state: 'draft' });
  });

  it('several drafts accepted at once list each type once; Setup lists every type the project still waits on', async () => {
    const a = await ipad(null, 'a');
    const p = await project(a.store, a.userId, a.now);
    await imported(a.lib, 'PI1002', { category: 'Station', optional_cables: [row('U')] });
    await imported(a.lib, 'IFP-1', { accessory_only: true, optional_cables: [row('U')] });
    const ts = await imported(a.lib, 'P-TS7-E', { category: 'Touchscreen', optional_cables: [row('U'), row('N')] });
    const drafts = [
      { model: 'PI1002', category: 'Station', accessories: [{ model: 'IFP-1', qty: 120 }] },
      { model: 'pi 1002', category: 'Station', accessories: [] },
      { model: 'P-TS7-E', category: 'Touchscreen', accessories: [] },
      { model: 'UNKNOWN', category: 'Station', accessories: [] },
    ];
    expect((await questionsForDrafts(a.store, drafts)).map((q) => [q.model, q.via])).toEqual([
      ['PI1002', null],
      ['IFP-1', 'PI1002'],
      ['P-TS7-E', null],
    ]);
    // Setup's step: the project's devices (a seed import's arrive by pull) and accepted drafts not placed yet, by model
    await p.editor.create('device', { level_id: p.levelId, category: 'Touchscreen', device: 'P-TS7-E' }, CTX);
    await p.editor.create('draft_device', { project_id: p.id, level_id: p.levelId, model: 'PI1002', category: 'Station', qty: 120, state: 'accepted', accessories: [{ model: 'IFP-1', qty: 120, role: 'accessory' }] }, CTX);
    await p.editor.create('draft_device', { project_id: p.id, level_id: p.levelId, model: 'PI1002', category: 'Station', qty: 1, state: 'proposed' }, CTX);
    expect((await questionsForProject(a.store, p.id)).map((q) => q.model)).toEqual(['IFP-1', 'P-TS7-E', 'PI1002']);
    const [tsQ] = (await questionsForProject(a.store, p.id)).filter((q) => q.typeId === ts);
    await answerTypeSetup(p.editor, a.store, tsQ!, { o0: true });
    expect((await questionsForProject(a.store, p.id)).map((q) => q.model)).toEqual(['IFP-1', 'PI1002']);
  });

  it('the sheet takes questions through one listener and merges a second ask, each type once', () => {
    const q = (typeId: string): TypeSetupQuestion => ({ typeId, model: typeId, category: null, via: null, rows: [] });
    const seen: string[][] = [];
    expect(askTypeSetup([q('a')])).toBe(0); // no sheet mounted: nothing to show
    const off = onTypeSetup((qs) => seen.push(qs.map((x) => x.typeId)));
    expect(askTypeSetup([])).toBe(0);
    expect(askTypeSetup([q('a'), q('b')])).toBe(2);
    off();
    expect(askTypeSetup([q('c')])).toBe(0);
    expect(seen).toEqual([['a', 'b']]);
    expect(mergeQuestions([q('a'), q('b')], [q('b'), q('c')]).map((x) => x.typeId)).toEqual(['a', 'b', 'c']);
  });

  it('two iPads answering the same type offline meet in the library conflict review', async () => {
    const server = new FakeServer();
    const a = await ipad(server, 'a');
    const b = await ipad(server, 'b');
    const ts = await imported(a.lib, 'P-TS7-E', { category: 'Touchscreen', optional_cables: [row('U'), row('N')] });
    await a.engine!.sync();
    await b.engine!.sync();
    const [qa] = await questionsForDrafts(a.store, [{ model: 'P-TS7-E', category: 'Touchscreen', accessories: [] }]);
    const [qb] = await questionsForDrafts(b.store, [{ model: 'P-TS7-E', category: 'Touchscreen', accessories: [] }]);
    await answerTypeSetup(a.lib, a.store, qa!, { o0: true });
    await answerTypeSetup(b.lib, b.store, qb!, { o1: true });
    await a.engine!.sync();
    await b.engine!.sync();
    const fields = (await loadReviewList(b.store, LIBRARY_STREAM)).rows.map((r) => [r.kind, r.subject, r.field]);
    expect(fields).toContainEqual(['sync_conflict', 'Device type P-TS7-E', expect.stringMatching(/default cables/i)]);
    expect((await b.store.get<Record<string, unknown>>('library_type', ts))!.state).toBe('accepted');
  });
});
