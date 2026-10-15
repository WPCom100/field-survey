import { Editor, OpError, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, ensureDemoCardExtras, ensureDemoLevel } from '../plan/demo';
import {
  FIELD_SURVEY,
  appendPhrase,
  checkNeuronId,
  correction,
  deleteDevice,
  movePin,
  neuronDuplicates,
  normalizeNeuronId,
  restoreDevice,
  saveNeuronId,
  setFound,
  setNotes,
  setStatus,
} from './actions';
import { STANDARD_PHRASES, formatValue, loadDeviceCard } from './model';
import { NOT_WIRED } from './proposals';

const ME = uuidv7();
let ts = 1_760_000_000_000;
let seq = 10_000;

/** A pulled op (as the server would send it), for setting up records the card reads. */
function pulled(entity_kind: Op['entity_kind'], entity_id: string, project_id: string, payload: Record<string, unknown>): Op {
  const t = new Date((ts += 1000)).toISOString();
  return {
    op_id: uuidv7(), project_id, user_id: ME, install_id: 'server', client_ts: t, server_seq: ++seq, server_ts: t,
    change_type: 'Master edit', entity_kind, entity_id, kind: 'create', payload, state: 'applied',
  };
}

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  const pid = plan.level.projectId;
  let clock = 1_760_100_000_000;
  const editor = new Editor(store, { projectId: pid, userId: ME, now: () => new Date((clock += 1000)).toISOString() });
  const byLabel = (l: string) => plan.devices.find((d) => d.label === l)!;
  return { store, plan, pid, editor, byLabel };
}

describe('device card read model', () => {
  it('loads the device with its punch items, parts, photos and history', async () => {
    const { store, byLabel } = await setup();
    const dev = byLabel('06M-01'); // i = 0: one open punch item, photos none
    const card = (await loadDeviceCard(store, dev.id))!;
    expect(card.device).toMatchObject({ label: '06M-01', levelCode: '06M', isNew: false, deleted: false });
    expect(card.punch.map((p) => p.item)).toEqual(['Run, not terminated']);
    expect(card.punch[0]).toMatchObject({ open: true, tracking: 'Open' });
    expect(card.history).toHaveLength(1);
    expect(card.history[0]).toMatchObject({ what: '(row added)', changeType: 'Master edit', pending: false });
    expect(card.phrases).toBe(STANDARD_PHRASES);
    expect(card.pending.size).toBe(0);

    const withPhotos = byLabel('06M-03'); // i = 2: one photo
    const c2 = (await loadDeviceCard(store, withPhotos.id))!;
    expect(c2.photos.length).toBe(withPhotos.photos);
    expect(c2.photosWaiting).toBe(0);

    const withPart = byLabel('06M-02'); // i = 1: a missing part
    expect((await loadDeviceCard(store, withPart.id))!.parts[0]).toMatchObject({ part: 'DMX termination kit', partStatus: 'Needed', qty: 1 });
  });

  it('shows NEW for a field addition the server has not numbered (D93)', async () => {
    const { store, plan } = await setup();
    const fresh = plan.devices.find((d) => d.isNew)!;
    const card = (await loadDeviceCard(store, fresh.id))!;
    expect(card.device).toMatchObject({ label: '06M-?', isNew: true, fieldAddition: true });
    expect(await loadDeviceCard(store, uuidv7())).toBeNull();
  });

  it('lists connections with the far end to jump to, on this level, another level, or a placeholder', async () => {
    const { store, pid, byLabel } = await setup();
    const a = byLabel('06M-01');
    const b = byLabel('06M-02');
    // Another level with one device.
    const lv03 = uuidv7();
    const far = uuidv7();
    const fixtures = uuidv7();
    const cDmx = uuidv7(), cDmxA = uuidv7(), cDmxB = uuidv7();
    const cUp = uuidv7(), cUpA = uuidv7(), cUpB = uuidv7();
    const c010 = uuidv7(), c010A = uuidv7(), c010B = uuidv7();
    await store.applyRemoteMany([
      pulled('level', lv03, pid, { project_id: pid, level: '03', floor_order: 3, numbering_group_id: uuidv7(), in_scope: true, state: 'baseline_locked' }),
      pulled('device', far, pid, { level_id: lv03, display_id: '03-05', category: 'Foundry panel', device: 'UFMP4' }),
      pulled('placeholder', fixtures, pid, { project_id: pid, label: 'Fixtures', kind: 'fixtures' }),
      pulled('cable', cDmx, pid, { project_id: pid, cable: 'X', qty: 1, end_a_id: cDmxA, end_b_id: cDmxB }),
      pulled('cable_end', cDmxA, pid, { cable_id: cDmx, side: 'A', endpoint_kind: 'device', device_id: a.id, level_id: DEMO_LEVEL_ID, display_id: 'C-03', status: 'Issue', note: 'Run, not terminated; no term kit' }),
      pulled('cable_end', cDmxB, pid, { cable_id: cDmx, side: 'B', endpoint_kind: 'device', device_id: b.id, level_id: DEMO_LEVEL_ID, display_id: 'C-04' }),
      pulled('cable', cUp, pid, { project_id: pid, cable: 'N', end_a_id: cUpA, end_b_id: cUpB }),
      pulled('cable_end', cUpA, pid, { cable_id: cUp, side: 'A', endpoint_kind: 'device', device_id: a.id, level_id: DEMO_LEVEL_ID, to_text: 'Network to Level 03 UFMP4s' }),
      pulled('cable_end', cUpB, pid, { cable_id: cUp, side: 'B', endpoint_kind: 'device', device_id: far, level_id: lv03, display_id: 'C-01' }),
      pulled('cable', c010, pid, { project_id: pid, cable: '0-10V', single_row: true, end_a_id: c010A, end_b_id: c010B }),
      pulled('cable_end', c010A, pid, { cable_id: c010, side: 'A', endpoint_kind: 'device', device_id: a.id, level_id: DEMO_LEVEL_ID, display_id: 'C-10', status: 'Installed, untested' }),
      pulled('cable_end', c010B, pid, { cable_id: c010, side: 'B', endpoint_kind: 'placeholder', placeholder_id: fixtures }),
    ]);

    const card = (await loadDeviceCard(store, a.id))!;
    expect(card.connections.map((c) => [c.label, c.cable, c.to, c.status])).toEqual([
      ['C-03', 'X', '06M-02', 'Issue'],
      ['C-10', '0-10V', 'Fixtures', 'Installed, untested'],
      ['NEW', 'N', 'Network to Level 03 UFMP4s', null],
    ]);
    const [dmx, ten, net] = card.connections;
    expect(dmx!.jump).toEqual({ deviceId: b.id, levelId: DEMO_LEVEL_ID, label: '06M-02', sameLevel: true });
    expect(dmx!.note).toBe('Run, not terminated; no term kit');
    expect(ten!).toMatchObject({ jump: null, singleRow: true });
    expect(net!.jump).toEqual({ deviceId: far, levelId: lv03, label: '03-05', sameLevel: false });
    // The far device sees the same cable from its side.
    const back = (await loadDeviceCard(store, far))!;
    expect(back.connections[0]).toMatchObject({ label: 'C-01', cable: 'N', to: '06M-01' });
  });

  it('shows rule drafts, open findings, part sources and the project vocabulary', async () => {
    const { store, pid, byLabel } = await setup();
    const dev = byLabel('06M-01');
    const card0 = (await loadDeviceCard(store, dev.id))!;
    const punchId = card0.punch[0]!.id;
    const part = uuidv7();
    await store.applyRemoteMany([
      pulled('missing_part', part, pid, { level_id: DEMO_LEVEL_ID, number: 77, device_id: dev.id, part: 'ERP-FT-LVD', qty: 1, owner: 'EC', part_status: 'Needed' }),
      pulled('proposal', uuidv7(), pid, {
        project_id: pid, rule_id: 'R3a', kind: 'punch', subject: { entity: 'device', entity_id: dev.id }, discriminator: 'x',
        payload: { item: 'Run DMX to Level 03 UFMP4s', type: 'Cable not run', owner: 'EC', why: 'End not installed' },
      }),
      pulled('proposal', uuidv7(), pid, {
        project_id: pid, rule_id: 'R3b', kind: 'punch', subject: { entity: 'device', entity_id: dev.id }, discriminator: 'y', state: 'rejected',
        payload: { item: 'Rejected stays out' },
      }),
      pulled('finding', uuidv7(), pid, { project_id: pid, lint_id: 'R1', subject: { entity: 'device', entity_id: dev.id }, message: '1 open item → Issue (suggested)' }),
      pulled('vocab', uuidv7(), pid, { project_id: pid, list: 'device_note', value: 'Missing ERP-FT-LVD card' }),
      pulled('vocab', uuidv7(), pid, { project_id: pid, list: 'punch_item', value: 'Not for notes' }),
    ]);
    await store.applyRemote({ ...pulled('missing_part', part, pid, {}), kind: 'link_add', entity_kind: 'part_source', payload: { target_kind: 'punch', target_id: punchId } });

    const card = (await loadDeviceCard(store, dev.id))!;
    expect(card.drafts).toEqual([
      expect.objectContaining({ ruleId: 'R3a', title: 'Run DMX to Level 03 UFMP4s', sub: 'Cable not run · EC', why: 'End not installed' }),
    ]);
    expect(card.findings).toEqual([expect.objectContaining({ lintId: 'R1', message: '1 open item → Issue (suggested)' })]);
    expect(card.parts.find((p) => p.part === 'ERP-FT-LVD')!.sources).toEqual([`#${card0.punch[0]!.label}`]);
    expect(card.phrases).toEqual(['Missing ERP-FT-LVD card']);
    expect(NOT_WIRED.wired).toBe(false);
    await expect(NOT_WIRED.decide('x', { kind: 'accept' })).rejects.toThrow(/T33/);
  });

  it('demo card samples fill every section on 06M-01, once', async () => {
    const { store, byLabel } = await setup();
    await ensureDemoCardExtras(store);
    const ops = await store.db.query<{ n: number }>('SELECT count(*) AS n FROM op');
    await ensureDemoCardExtras(store);
    expect((await store.db.query<{ n: number }>('SELECT count(*) AS n FROM op'))[0]!.n).toBe(ops[0]!.n);
    expect(await store.outboxCount()).toBe(0);

    const card = (await loadDeviceCard(store, byLabel('06M-01').id))!;
    expect(card.accessories.map((a) => [a.model, a.short])).toEqual([['ERP-FT-LVD', true], ['ERP-RTO', false]]);
    expect(card.connections.map((c) => [c.label, c.cable, c.jump?.label ?? null])).toEqual([
      ['C-03', 'X', '06M-03'],
      ['C-08', '0-10V', null],
      ['NEW', 'U', null],
    ]);
    // drafts and findings come from the rule engine (T34, `src/rules/rules.test.ts`), not the seed
    expect(card.drafts).toEqual([]);
    expect(card.findings).toEqual([]);
    // The far end sees the cable too.
    expect((await loadDeviceCard(store, byLabel('06M-03').id))!.connections[0]).toMatchObject({ label: 'C-04', to: '06M-01' });
  });

  it('counts photos whose image has not reached the server', async () => {
    const { store, pid, byLabel } = await setup();
    const dev = byLabel('06M-01');
    const sha = 'a'.repeat(64);
    await store.applyRemote(pulled('photo', uuidv7(), pid, { level_id: DEMO_LEVEL_ID, device_id: dev.id, image_blob: sha, thumb_blob: 'b'.repeat(64) }));
    await store.db.exec(`INSERT INTO blob (sha256, size, mime, upload_state, chunks_received) VALUES (?, 10, 'image/jpeg', 'local', '[]')`, [sha]);
    const card = (await loadDeviceCard(store, dev.id))!;
    expect(card.photos).toEqual([expect.objectContaining({ label: 'NEW', waiting: true, thumb: 'b'.repeat(64) })]);
    expect(card.photosWaiting).toBe(1);
  });
});

describe('device card edits', () => {
  it('a status tap is one Field survey op; the same status again writes nothing', async () => {
    const { store, editor, byLabel } = await setup();
    const dev = byLabel('06M-01');
    const op = (await setStatus(editor, dev.id, 'Issue'))!;
    expect(op).toMatchObject({ kind: 'set', field: 'status', was: dev.status, now: 'Issue', change_type: 'Field survey', reason: 'Field survey', group_id: null });
    expect(await setStatus(editor, dev.id, 'Issue')).toBeNull();
    expect(await store.outboxCount()).toBe(1);

    const card = (await loadDeviceCard(store, dev.id))!;
    expect(card.device.status).toBe('Issue');
    expect(card.pending.has('status')).toBe(true);
    expect(card.history[0]).toMatchObject({ what: 'Status', was: dev.status ?? '(blank)', now: 'Issue', pending: true, reason: 'Field survey' });
    // The plan (pin colour) reads the same row.
    expect((await loadLevelPlan(store, DEMO_LEVEL_ID))!.devices.find((d) => d.id === dev.id)!.status).toBe('Issue');
  });

  it('notes: chips append with "; ", commits are trimmed, empty clears', async () => {
    expect(appendPhrase(null, 'Not run')).toBe('Not run');
    expect(appendPhrase('  ', 'Not run')).toBe('Not run');
    expect(appendPhrase('LVD card missing', 'Not run')).toBe('LVD card missing; Not run');
    expect(appendPhrase('LVD card missing;', 'Not run')).toBe('LVD card missing; Not run');
    expect(appendPhrase('LVD card missing; Not run', 'Not run')).toBe('LVD card missing; Not run');
    expect(appendPhrase('Not run', 'Not run')).toBe('Not run');

    const { store, editor, byLabel } = await setup();
    const dev = byLabel('06M-01');
    expect(await setNotes(editor, dev.id, '  Missing ERP-FT-LVD card ')).toMatchObject({ now: 'Missing ERP-FT-LVD card', change_type: 'Field survey' });
    expect(await setNotes(editor, dev.id, 'Missing ERP-FT-LVD card')).toBeNull();
    expect(await setNotes(editor, dev.id, '   ')).toMatchObject({ was: 'Missing ERP-FT-LVD card', now: null });
    expect((await loadDeviceCard(store, dev.id))!.device.notes).toBeNull();
  });

  it('accessory found quantity is one op; found < expected is flagged', async () => {
    const { store, pid, editor, byLabel } = await setup();
    const dev = byLabel('06M-01');
    const acc = uuidv7();
    await store.applyRemote(pulled('accessory', acc, pid, { device_id: dev.id, model: 'ERP-FT-LVD', expected_qty: 2 }));
    expect((await loadDeviceCard(store, dev.id))!.accessories[0]).toMatchObject({ model: 'ERP-FT-LVD', expected: 2, found: null, short: false });
    expect(await setFound(editor, acc, 1)).toMatchObject({ entity_kind: 'accessory', field: 'found_qty', now: 1, reason: 'Field survey' });
    expect((await loadDeviceCard(store, dev.id))!.accessories[0]).toMatchObject({ found: 1, short: true });
    await setFound(editor, acc, 2);
    expect((await loadDeviceCard(store, dev.id))!.accessories[0]!.short).toBe(false);
    expect(() => setFound(editor, acc, -1)).toThrow(OpError);
  });

  it('Neuron ID: normalised, 12 hex digits, duplicates reported, saved as one group', async () => {
    expect(normalizeNeuronId(' 00:a1-b2.c3 d4e5 ')).toBe('00A1B2C3D4E5');
    expect(checkNeuronId('00a1b2c3d4e5')).toEqual({ value: '00A1B2C3D4E5', error: null });
    expect(checkNeuronId('00A1B2C3D4E').error).toMatch(/12 hex digits; this has 11/);
    expect(checkNeuronId('O0A1B2C3D4E5').error).toMatch(/Not hex: O \(0\?\)/);

    const { store, pid, editor, byLabel } = await setup();
    const a = byLabel('06M-01');
    const b = byLabel('06M-02');
    expect(() => saveNeuronId(editor, a.id, '12345')).toThrow(OpError);
    expect(await store.outboxCount()).toBe(0);

    const ops = await saveNeuronId(editor, a.id, '00a1b2c3d4e5');
    expect(ops.map((o) => [o.field, o.now])).toEqual([['neuron_id', '00A1B2C3D4E5'], ['neuron_method', 'typed']]);
    expect(ops[0]!.group_id).toBeTruthy();
    expect(ops[1]!.group_id).toBe(ops[0]!.group_id);

    expect(await neuronDuplicates(store, pid, '00A1B2C3D4E5', b.id)).toEqual([{ id: a.id, label: '06M-01' }]);
    expect(await neuronDuplicates(store, pid, '00A1B2C3D4E5', a.id)).toEqual([]);
    // A duplicate is a warning (D76): saving it still works.
    await saveNeuronId(editor, b.id, '00A1B2C3D4E5');
    expect((await loadDeviceCard(store, b.id))!.device).toMatchObject({ neuronId: '00A1B2C3D4E5', neuronMethod: 'typed' });
  });

  it('[⋯] delete, restore and move pin are Corrections with the typed reason', async () => {
    const { store, editor, plan, byLabel } = await setup();
    const dev = byLabel('06M-01');
    expect(() => correction('  ')).toThrow(OpError);
    expect(() => deleteDevice(editor, dev.id, '')).toThrow(OpError);

    const del = await deleteDevice(editor, dev.id, 'Duplicate of 06M-02');
    expect(del).toMatchObject({ kind: 'delete', change_type: 'Correction', reason: 'Duplicate of 06M-02' });
    let card = (await loadDeviceCard(store, dev.id))!;
    expect(card.device).toMatchObject({ deleted: true, deleteReason: 'Duplicate of 06M-02' });
    expect(card.history[0]).toMatchObject({ what: 'Deleted', reason: 'Duplicate of 06M-02', changeType: 'Correction' });

    await restoreDevice(editor, dev.id, 'Not a duplicate');
    card = (await loadDeviceCard(store, dev.id))!;
    expect(card.device.deleted).toBe(false);

    const sheet = plan.sheet!.id;
    const mv = (await movePin(editor, dev.id, { sheet, x: 100.04, y: 200.06 }, 'Wrong room'))!;
    expect(mv).toMatchObject({ field: 'pin', now: { sheet, x: 100, y: 200.1 }, change_type: 'Correction', reason: 'Wrong room' });
    card = (await loadDeviceCard(store, dev.id))!;
    expect(card.device.pin).toEqual({ sheet, x: 100, y: 200.1 });
    expect(card.history[0]).toMatchObject({ what: 'Pin', now: '(100, 200)' });
    expect(card.history.map((h) => h.what)).toEqual(['Pin', 'Restored', 'Deleted', '(row added)']);
  });

  it('formats history values', () => {
    expect(formatValue('notes', null)).toBe('(blank)');
    expect(formatValue('notes', '')).toBe('(blank)');
    expect(formatValue('found_on_site', true)).toBe('yes');
    expect(formatValue('pin', { sheet: 's', x: 1.4, y: 2.6 })).toBe('(1, 3)');
    expect(FIELD_SURVEY).toEqual({ change_type: 'Field survey', reason: 'Field survey' });
  });
});
