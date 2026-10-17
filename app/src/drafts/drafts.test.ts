/**
 * Draft review (T44, Phase 3 §3.3, D193): the read model over BOM / riser / hand-entered drafts
 * (levels incl. the pool and floors the project lacks, sources and crop boxes, the choices Accept
 * needs, the mismatch list, filters, bulk) and the edits (Accept / Edit / Reject / Reopen, Accept
 * all ≥ 0.9, Promote, hand drafts, cable endpoints, Confirm endpoint, the waiting cable made once
 * its endpoint device is placed, the link to a cable the baseline already has).
 */

import { Editor, Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { CABLE_CODES, setRuleParam } from '@field-survey/rules';
import { describe, expect, it } from 'vitest';

import {
  acceptAll,
  acceptCable,
  acceptDevice,
  addCableDraft,
  addDeviceDraft,
  cableBlockers,
  cablePayload,
  commitWaitingCables,
  deviceBlockers,
  editDevice,
  excludedKey,
  libraryRow,
  promoteExcluded,
  realEnd,
  rejectDraft,
  reopenDraft,
  setCableCode,
  setEndpoint,
  DraftError,
} from './actions';
import { loadCables } from '../cables/model';
import { typeForDraft, type DeviceType } from '../library/neuron';
import { loadDeviceCard } from '../card/model';
import { engineFor } from '../rules/engine';
import { batchFor, cropUrl, excludedLines, extractionLine, promotedKeys, riserBlobFor, type Batch } from './api';
import {
  POOL,
  bulkCables,
  bulkDevices,
  cableEnds,
  cablesOn,
  cropBox,
  deviceForDraft,
  devicesOn,
  draftRole,
  endpointOptions,
  flaggedDraftCounts,
  levelCounts,
  loadDraftReview,
  mismatchList,
  sourcesOf,
  srcBadge,
  withChosen,
} from './model';

const PROJECT = uuidv7();
const ME = uuidv7();
let clock = 1_760_800_000_000;
const now = () => new Date((clock += 1000)).toISOString();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: ME, now });
  const ids = {
    l01: uuidv7(), l02: uuidv7(), l06: uuidv7(), l06m: uuidv7(),
    panel: uuidv7(), rack: uuidv7(), canyon: uuidv7(), lvl9: uuidv7(),
    bom: uuidv7(), riser: uuidv7(),
    dA: uuidv7(), dB: uuidv7(), dC: uuidv7(), dD: uuidv7(), dE: uuidv7(), dF: uuidv7(), dG: uuidv7(), dH: uuidv7(), dRack: uuidv7(),
    c1: uuidv7(), c2: uuidv7(), c3: uuidv7(), c4: uuidv7(), fiber: uuidv7(), review: uuidv7(),
  };
  const ops: Op[] = [];
  let seq = 0;
  const create = (entity_kind: Op['entity_kind'], payload: Record<string, unknown>) => {
    const { id, ...rest } = payload;
    const ts = now();
    ops.push({ op_id: uuidv7(), project_id: PROJECT, user_id: ME, install_id: 'server', client_ts: ts, server_seq: ++seq, server_ts: ts, entity_kind, entity_id: String(id), kind: 'create', payload: rest, change_type: 'Master edit', reason: 'seed', state: 'applied' } as Op);
  };
  const g06 = uuidv7();
  create('project', { id: PROJECT, name: 'Tower' });
  create('level', { id: ids.l01, project_id: PROJECT, level: '01', floor_order: 1, numbering_group_id: uuidv7(), in_scope: true });
  create('level', { id: ids.l02, project_id: PROJECT, level: '02', floor_order: 2, numbering_group_id: uuidv7(), in_scope: true });
  create('level', { id: ids.l06, project_id: PROJECT, level: '06', floor_order: 3, numbering_group_id: g06, in_scope: true });
  create('level', { id: ids.l06m, project_id: PROJECT, level: '06M', floor_order: 4, numbering_group_id: g06, in_scope: true, split_of_id: ids.l06 });
  // the master's devices on 06M (D30)
  create('device', { id: ids.panel, level_id: ids.l06m, display_id: '06M-04', category: 'Relay panel', device: 'ERP48', panel_name: 'CT06LCPA' });
  create('device', { id: ids.rack, level_id: ids.l06m, display_id: '06M-01', category: 'Equipment rack', device: 'Equipment Rack 18U' });
  create('placeholder', { id: ids.canyon, project_id: PROJECT, label: 'B3A Canyon', kind: 'fixture_run' });
  create('placeholder', { id: ids.lvl9, project_id: PROJECT, label: 'Level 09', kind: 'level_not_in_scope' });
  // and a fibre cable the baseline already has, rack ↔ panel
  const fe = [uuidv7(), uuidv7()];
  create('cable', { id: ids.fiber, project_id: PROJECT, cable: 'F', qty: 1, origin: 'import', end_a_id: fe[0], end_b_id: fe[1] });
  create('cable_end', { id: fe[0], cable_id: ids.fiber, side: 'A', endpoint_kind: 'device', device_id: ids.rack, level_id: ids.l06m });
  create('cable_end', { id: fe[1], cable_id: ids.fiber, side: 'B', endpoint_kind: 'device', device_id: ids.panel, level_id: ids.l06m });

  const bomRef = (page: number, line: number, extra: Record<string, unknown> = {}) => ({ kind: 'bom_line', file: 'BOM.pdf', job: '15076538', page, line, bbox: [10, 20, 300, 32], venue: 'Level 1', ...extra });
  const riserRef = (bbox: number[], extra: Record<string, unknown> = {}) => ({ kind: 'riser_symbol', file: 'riser.pdf', page: 1, sheet: '001', band: 'p1c0b3', bbox, ...extra });
  const dd = (id: string, f: Record<string, unknown>) => create('draft_device', { id, project_id: PROJECT, state: 'proposed', ...f });
  dd(ids.dA, { import_batch_id: ids.bom, level_id: ids.l01, model: 'PI1002', category: 'Station', qty: 12, confidence: 0.95, level_basis: 'venue', extraction: 'text', source_ref: bomRef(1, 12, { level_code: '01' }) });
  dd(ids.dB, { import_batch_id: ids.bom, level_id: ids.l01, model: 'P-DOC-C-SR', candidates: ['P-DOC-C-SR', 'P-DOC-C-LR'], category: 'Sensor', qty: 13, confidence: 0.95, conflicts: ['model:SR/LR'], level_basis: 'venue', source_ref: bomRef(1, 14) });
  dd(ids.dC, { import_batch_id: ids.bom, level_id: ids.l01, model: 'PI1004', category: 'Station', qty: 1, confidence: 0.95, conflicts: ['qty:bom≠riser'], level_basis: 'venue', source_ref: bomRef(1, 15, { riser: riserRef([100, 200, 30, 20], { qty: 2, level_code: '01' }) }) });
  dd(ids.dD, { import_batch_id: ids.riser, level_id: ids.l06m, model: 'ERP48-FT-481P', name: 'CT06LCPA', category: 'Relay panel', qty: 1, confidence: 0.9, level_basis: 'riser_band', extraction: 'text', source_ref: riserRef([50, 60, 40, 30], { level_code: '06M' }) });
  dd(ids.dRack, { import_batch_id: ids.riser, level_id: ids.l06m, model: 'ERN4-RM-120', name: 'Equipment Rack 18U', category: 'Equipment rack', qty: 1, confidence: 0.9, level_basis: 'riser_band', source_ref: riserRef([150, 60, 40, 30]) });
  dd(ids.dE, { import_batch_id: ids.riser, level_id: ids.l02, model: 'UFMP4', category: 'Foundry panel', qty: 1, confidence: 0.9, level_basis: 'riser_band', source_ref: riserRef([50, 300, 30, 20]) });
  dd(ids.dF, { import_batch_id: ids.bom, level_id: null, model: 'EBDK', category: 'EBDK', qty: 15, confidence: 0.475, level_basis: 'pooled_venue', source_ref: bomRef(2, 3, { venue: 'Level B2 - 12' }) });
  dd(ids.dG, { import_batch_id: ids.riser, level_id: null, model: 'PI1002', category: 'Station', qty: 8, confidence: 0.85, level_basis: 'level_not_in_project', source_ref: riserRef([50, 900, 30, 20], { level_code: '09' }) });
  dd(ids.dH, { import_batch_id: ids.bom, level_id: ids.l06, model: 'ERP24-FT-241P', category: 'Relay panel', qty: 1, confidence: 0.95, conflicts: ['level:06/06M'], level_basis: 'venue', source_ref: bomRef(3, 4, { venue: 'FLOOR 6' }) });
  create('review_item', { id: ids.review, project_id: PROJECT, level_id: ids.l01, kind: 'source_conflict', subject: { entity_kind: 'draft_device', entity_id: ids.dC, field: 'qty' }, candidates: [{ side: 'riser', value: 2 }, { side: 'bom', value: 1 }, { side: 'master', value: 1 }], state: 'open' });

  const bubble = (bbox: number[]) => ({ kind: 'riser_bubble', file: 'riser.pdf', page: 1, sheet: '001', band: 'p1c0b3', bbox, bubble: 'X', level_code: '06M' });
  const dc = (id: string, f: Record<string, unknown>) => create('draft_cable', { id, project_id: PROJECT, import_batch_id: ids.riser, qty: 1, origin: 'riser', state: 'proposed', level_basis: 'riser_band', ...f });
  // 06M panel → 02 UFMP4 (both draft devices; the UFMP4 is not placed yet)
  dc(ids.c1, { level_id: ids.l06m, to_level_id: ids.l02, code: 'X', from_label: 'CT06LCPA', to_label: 'UFMP4 Level 02', confidence: 0.85, source_ref: bubble([80, 90, 12, 12]),
    candidates: [{ side: 'from', kind: 'draft_device', id: ids.dD, label: 'CT06LCPA', confidence: 0.9 }, { side: 'to', kind: 'draft_device', id: ids.dE, label: 'UFMP4', confidence: 0.85 }] });
  // rack output to a fixture run (labelled beside the bubble: 0.9)
  dc(ids.c2, { level_id: ids.l06m, code: 'X', from_label: 'Equipment Rack 18U', to_label: 'DMX TO B3A CANYON', confidence: 0.9, source_ref: bubble([170, 95, 12, 12]),
    candidates: [{ side: 'from', kind: 'draft_device', id: ids.dRack, label: 'Equipment Rack 18U', confidence: 0.9 }, { side: 'to', kind: 'placeholder', id: ids.canyon, label: 'B3A Canyon', confidence: 0.9 }] });
  // network from the panel, far end unresolved
  dc(ids.c3, { level_id: ids.l06m, code: 'N', from_label: 'CT06LCPA', to_label: null, confidence: 0.4, conflicts: ['endpoint:unresolved'], source_ref: bubble([80, 120, 12, 12]),
    candidates: [{ side: 'from', kind: 'draft_device', id: ids.dD, label: 'CT06LCPA', confidence: 0.9 }] });
  // the fibre run the baseline already has
  dc(ids.c4, { level_id: ids.l06m, code: 'F', from_label: 'Equipment Rack 18U', to_label: 'CT06LCPA', confidence: 0.8, source_ref: bubble([160, 120, 12, 12]),
    candidates: [{ side: 'from', kind: 'draft_device', id: ids.dRack, label: 'Equipment Rack 18U', confidence: 0.9 }, { side: 'to', kind: 'draft_device', id: ids.dD, label: 'CT06LCPA', confidence: 0.8 }] });
  for (const r of await store.applyRemoteMany(ops)) if (r.outcome !== 'applied') throw new Error(`seed op ${r.outcome}`);
  return { store, editor, ids };
}

const row = <T extends { id: string }>(rows: T[], id: string): T => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe('draft review read model (T44)', () => {
  it('lists drafts per level, the pool and floors the project lacks, with counts', async () => {
    const { store, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    expect(data.levels.map((l) => [l.code, l.devices, l.cables])).toEqual([
      ['01', 3, 0],
      ['02', 1, 0],
      ['06', 1, 0],
      ['06M', 2, 4],
      ['Pool', 1, 0],
      ['09', 1, 0],
    ]);
    expect(data.levels.find((l) => l.key === POOL)!.title).toBe('Pool (no level)');
    expect(data.levels.find((l) => l.key === 'code:09')!.title).toBe('09 (not in the project)');
    expect(levelCounts(data, ids.l01)).toEqual({ devices: 3, cables: 0, review: 2, bulk: 1 });
    expect(levelCounts(data, ids.l06m)).toMatchObject({ devices: 2, cables: 4, review: 1 });
  });

  it('reads sources, crop boxes and the Src badge', async () => {
    const { store, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    const c = row(data.devices, ids.dC);
    expect(c.src).toBe('R+B');
    expect(c.sources.map((s) => [s.kind, s.label, s.page, s.bbox, s.batchId])).toEqual([
      ['bom', 'BOM p.1 line 15 (job 15076538)', 1, [10, 20, 290, 12], ids.bom],
      ['riser', 'Riser 001 · level 01', 1, [100, 200, 30, 20], null],
    ]);
    expect(row(data.devices, ids.dA).src).toBe('B');
    expect(row(data.devices, ids.dD).src).toBe('R');
    expect(cropBox({ kind: 'bom_line', bbox: [10, 20, 5, 32] })).toBeNull();
    expect(cropBox({ kind: 'riser_bubble', bbox: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
    expect(srcBadge(null, 'manual')).toBe('hand');
    expect(srcBadge({ kind: 'bom_line', promoted: true }, 'manual')).toBe('BOM↑');
    // a riser draft drawing down a pooled BOM line shows that line's crop too
    const pooled = sourcesOf({ kind: 'riser_symbol', file: 'riser.pdf', page: 1, bbox: [1, 1, 2, 2], bom: { draft_id: ids.dF, page: 2, line: 3, venue: 'Level B2 - 12', qty: 15 } }, ids.riser, new Map([[ids.dF, { kind: 'bom_line', file: 'BOM.pdf', page: 2, line: 3, bbox: [5, 5, 50, 15] }]]));
    expect(pooled.map((s) => s.label)).toEqual(['Riser p.1', 'BOM p.2 line 3 · Level B2 - 12 (pooled)']);
  });

  it('works out the choices Accept needs (D28) and the mismatch list', async () => {
    const { store, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    expect(row(data.devices, ids.dB).needs).toEqual({ model: { options: ['P-DOC-C-SR', 'P-DOC-C-LR'] } });
    expect(row(data.devices, ids.dC).needs).toEqual({ qty: { bom: 1, riser: 2 } });
    expect(row(data.devices, ids.dC).reviewItemId).toBe(ids.review);
    expect(row(data.devices, ids.dH).needs).toEqual({ level: { options: [{ id: ids.l06, code: '06' }, { id: ids.l06m, code: '06M' }] } });
    expect(row(data.devices, ids.dA).needs).toEqual({});
    expect(row(data.devices, ids.dF).flagged).toBe(true);
    expect(row(data.devices, ids.dD).onLevel).toBe(0); // the master's panel is "ERP48", the draft's model its full name
    expect(mismatchList(data, ids.l01).map((m) => m.text)).toEqual(['SR or LR? P-DOC-C-SR / P-DOC-C-LR — pick one', 'BOM qty 1 ≠ riser 2 (PI1004)']);
    expect(mismatchList(data, ids.l06).map((m) => m.text)).toEqual(['ERP24-FT-241P: on 06 or 06M? — pick the level']);
    expect(mismatchList(data, ids.l06m).map((m) => m.text)).toEqual(['N from CT06LCPA: far end not found — pick it']);
  });

  it('filters and sorts rows, and picks what Accept all takes', async () => {
    const { store, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    // equal confidence → by model
    expect(devicesOn(data, ids.l01, 'open').map((d) => d.model)).toEqual(['P-DOC-C-SR', 'PI1002', 'PI1004']);
    expect(devicesOn(data, ids.l01, 'review').map((d) => d.model).sort()).toEqual(['P-DOC-C-SR', 'PI1004']);
    expect(devicesOn(data, ids.l01, 'conflict')).toHaveLength(2);
    expect(devicesOn(data, POOL, 'all').map((d) => d.model)).toEqual(['EBDK']);
    expect(devicesOn(data, 'code:09', 'all').map((d) => d.levelCode)).toEqual(['09']);
    expect(bulkDevices(data, ids.l01).map((d) => d.id)).toEqual([ids.dA]);
    expect(bulkCables(data, ids.l06m).map((c) => c.id)).toEqual([ids.c2]);
    // cables: lowest confidence first
    expect(cablesOn(data, ids.l06m, 'all').map((c) => c.code)).toEqual(['N', 'F', 'X', 'X']);
  });

  it('resolves endpoints: candidates, the device a draft has become, options best first', async () => {
    const { store, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    const c1 = row(data.cables, ids.c1);
    expect(c1.ends.from).toMatchObject({ kind: 'draft_device', id: ids.dD });
    expect(c1.chosen).toEqual({ from: false, to: false });
    expect(deviceForDraft(data, row(data.devices, ids.dD))?.id).toBe(ids.panel); // same panel tag
    expect(deviceForDraft(data, row(data.devices, ids.dRack))?.id).toBe(ids.rack); // the only rack, qty 1
    expect(deviceForDraft(data, row(data.devices, ids.dE))).toBeNull(); // nothing on 02 yet
    const opts = endpointOptions(data, c1, 'from');
    expect(opts[0]).toMatchObject({ kind: 'device', id: ids.panel, label: '06M-04 CT06LCPA (in the baseline)' });
    expect(opts[1]).toMatchObject({ kind: 'draft_device', id: ids.dD });
    expect(opts.some((o) => o.kind === 'placeholder' && o.label === 'B3A Canyon')).toBe(true);
    expect(endpointOptions(data, c1, 'to', 'canyon').map((o) => o.label)).toEqual(['B3A Canyon']);
    const c3 = row(data.cables, ids.c3);
    expect(c3.ends.to).toBeNull();
    expect(cableBlockers(c3)).toEqual(['Pick the To end.']);
    // choosing keeps the other candidates, adds a hand pick, and clears it again
    const picked = withChosen([{ side: 'to', kind: 'placeholder', id: 'p1', label: 'A' }, { side: 'to', kind: 'placeholder', id: 'p2', label: 'B' }], 'to', { kind: 'device', id: 'd9', label: 'X', levelId: null });
    expect(cableEnds(picked)).toMatchObject({ ends: { to: { id: 'd9' } }, chosen: { to: true }, handPicked: { to: true } });
    expect(cableEnds(picked).candidates.to.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(cableEnds(withChosen(picked, 'to', null)).ends.to).toBeNull();
  });
});

describe('draft review edits (T44)', () => {
  it('Accept waits for the choices, then records them and resolves the source conflict', async () => {
    const { store, editor, ids } = await setup();
    let data = await loadDraftReview(store, PROJECT);
    expect(deviceBlockers(row(data.devices, ids.dB))).toEqual(['Pick the model: P-DOC-C-SR or P-DOC-C-LR.']);
    await expect(acceptDevice(editor, row(data.devices, ids.dB))).rejects.toThrow(DraftError);
    await acceptDevice(editor, row(data.devices, ids.dB), { model: 'P-DOC-C-LR' });
    await acceptDevice(editor, row(data.devices, ids.dC), { qty: 2 });
    await acceptDevice(editor, row(data.devices, ids.dH), { levelId: ids.l06m });
    data = await loadDraftReview(store, PROJECT);
    expect(row(data.devices, ids.dB)).toMatchObject({ model: 'P-DOC-C-LR', state: 'edited' });
    expect(row(data.devices, ids.dC)).toMatchObject({ qty: 2, state: 'edited', reviewItemId: null });
    expect(row(data.devices, ids.dH)).toMatchObject({ levelId: ids.l06m, state: 'edited' });
    const item = await store.get<Record<string, unknown>>('review_item', ids.review);
    expect(item).toMatchObject({ state: 'resolved', resolved_by_id: ME });
    expect(item!.resolution).toMatchObject({ choice: 'drafts', value: 2 });
    // an accept with nothing to choose is plain `accepted`
    await acceptDevice(editor, row(data.devices, ids.dD));
    expect(row((await loadDraftReview(store, PROJECT)).devices, ids.dD).state).toBe('accepted');
    // every op is a reviewed setup edit
    const ops = await store.opsFor(ids.dB);
    expect(ops.at(-1)).toMatchObject({ change_type: 'Master edit', reason: 'Draft review: accepted P-DOC-C-LR ×13' });
  });

  it('Accept all ≥ 0.9 takes only the clean drafts, each with its own state op', async () => {
    const { store, editor, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    expect(await acceptAll(editor, store, data, ids.l01, 'devices')).toBe(1);
    const after = await loadDraftReview(store, PROJECT);
    expect(row(after.devices, ids.dA).state).toBe('accepted');
    expect(row(after.devices, ids.dB).state).toBe('proposed');
    const op = (await store.opsFor(ids.dA)).at(-1)!;
    expect(op).toMatchObject({ kind: 'set', field: 'state', now: 'accepted', reason: 'Draft review: Accept all ≥ 0.9', user_id: ME });
    expect(await acceptAll(editor, store, after, ids.l01, 'devices')).toBe(0);
  });

  it('Edit saves and accepts, Reject needs a reason, Reopen undoes either', async () => {
    const { store, editor, ids } = await setup();
    let data = await loadDraftReview(store, PROJECT);
    await expect(editDevice(editor, row(data.devices, ids.dF), { category: 'Lamp' })).rejects.toThrow(/Category must be one of/);
    await expect(editDevice(editor, row(data.devices, ids.dF), { qty: 0 })).rejects.toThrow(/whole number/);
    await editDevice(editor, row(data.devices, ids.dF), { levelId: ids.l02, qty: 3 });
    await expect(rejectDraft(editor, 'device', row(data.devices, ids.dG), ' ')).rejects.toThrow(/why/);
    await rejectDraft(editor, 'device', row(data.devices, ids.dG), 'Out of scope floor');
    data = await loadDraftReview(store, PROJECT);
    expect(row(data.devices, ids.dF)).toMatchObject({ levelId: ids.l02, qty: 3, state: 'edited' });
    expect(row(data.devices, ids.dG).state).toBe('rejected');
    expect((await store.opsFor(ids.dG)).at(-1)!.reason).toBe('Draft review: rejected — Out of scope floor');
    await reopenDraft(editor, 'device', row(data.devices, ids.dG));
    expect(row((await loadDraftReview(store, PROJECT)).devices, ids.dG).state).toBe('proposed');
  });

  it('hand-entered drafts (K12) and a promoted excluded line review like extracted ones', async () => {
    const { store, editor, ids } = await setup();
    const hand = await addDeviceDraft(editor, PROJECT, { levelId: ids.l02, model: 'P-TS7-E', category: 'Touchscreen', qty: 1 });
    await expect(addDeviceDraft(editor, PROJECT, { levelId: ids.l02, model: ' ', category: 'Station', qty: 1 })).rejects.toThrow(/Model/);
    const line = { reason: 'not a lighting-control device', model: 'ETC-BRKT', part_number: '7100A1234', description: 'Bracket', qty: 4, source_ref: { kind: 'bom_line', job: '15076538', page: 5, line: 210, bbox: [10, 400, 300, 412], venue: 'Level 2' }, extraction: 'text' };
    const promoted = await promoteExcluded(editor, PROJECT, { id: ids.bom, file: 'BOM.pdf' }, line, ids.l02);
    const cable = await addCableDraft(editor, PROJECT, { levelId: ids.l02, code: 'NG', fromLabel: 'Equipment rack', toLabel: 'P-TS7-E' });
    await expect(addCableDraft(editor, PROJECT, { levelId: ids.l02, code: 'Q', fromLabel: 'a', toLabel: 'b' })).rejects.toThrow(/Cable code/);
    const data = await loadDraftReview(store, PROJECT);
    expect(row(data.devices, hand)).toMatchObject({ src: 'hand', confidence: null, flagged: false, needs: {}, levelCode: '02' });
    const p = row(data.devices, promoted);
    expect(p).toMatchObject({ src: 'BOM↑', model: 'ETC-BRKT', qty: 4, category: null, needs: { category: true } });
    expect(p.sources[0]).toMatchObject({ kind: 'bom', page: 5, bbox: [10, 400, 290, 12], batchId: ids.bom, file: 'BOM.pdf' });
    expect(excludedKey(ids.bom, p.sourceRef!)).toBe(excludedKey(ids.bom, line.source_ref));
    expect(deviceBlockers(p)).toEqual(['Pick a category.']);
    await acceptDevice(editor, p, { category: 'Touchscreen' });
    expect(row((await loadDraftReview(store, PROJECT)).devices, promoted)).toMatchObject({ category: 'Touchscreen', state: 'edited' });
    const c = row(data.cables, cable);
    expect(c).toMatchObject({ src: 'hand', code: 'NG', ends: { from: null, to: null } });
    expect(cableBlockers(c)).toEqual(['Pick the From end.', 'Pick the To end.']);
  });
});

describe('cable drafts (T44, D6, D191)', () => {
  it('Confirm endpoint makes the cable with both ends, the master texts and the riser crop', async () => {
    const { store, editor, ids } = await setup();
    let data = await loadDraftReview(store, PROJECT);
    await setEndpoint(editor, store, ids.c3, 'to', { kind: 'device', id: ids.rack, label: '06M-01 Equipment Rack 18U', levelId: ids.l06m });
    data = await loadDraftReview(store, PROJECT);
    const c3 = row(data.cables, ids.c3);
    expect(c3.handPicked.to).toBe(true);
    const res = await acceptCable(editor, store, data, c3, { confirm: true, riserBlob: 'ab'.repeat(32) });
    expect(res).toMatchObject({ waiting: false, linked: false });
    const cable = await store.get<Record<string, unknown>>('cable', res.cableId!);
    expect(cable).toMatchObject({ cable: 'N', qty: 1, origin: 'riser', endpoint_confirmed: true, vertical: 'CT06LCPA N', single_row: false });
    expect(cable!.riser_ref).toEqual({ blob: 'ab'.repeat(32), file: 'riser.pdf', page: 1, bbox: [80, 120, 12, 12], draft: ids.c3 });
    // the cable view's riser crop reads it (T106)
    const inView = (await loadCables(store, PROJECT)).rows.find((r) => r.id === res.cableId)!;
    expect(inView.riserRef).toEqual({ kind: 'blob', blob: 'ab'.repeat(32), file: 'riser.pdf', page: 1, bbox: { x: 80, y: 120, width: 12, height: 12 }, draftId: ids.c3 });
    const ends = await store.list<Record<string, unknown>>('cable_end', { where: 'cable_id = ?', params: [res.cableId], orderBy: 'side' });
    expect(ends.map((e) => [e.side, e.device_id, e.from_text, e.to_text])).toEqual([
      ['A', ids.panel, 'CT06LCPA', 'Network to Equipment rack'],
      ['B', ids.rack, 'Equipment rack', 'Network to CT06LCPA'],
    ]);
    expect([cable!.end_a_id, cable!.end_b_id]).toEqual(ends.map((e) => e.id));
    data = await loadDraftReview(store, PROJECT);
    expect(row(data.cables, ids.c3)).toMatchObject({ state: 'edited', committed: true, waiting: false, confirmed: true });
    await expect(reopenDraft(editor, 'cable', row(data.cables, ids.c3))).rejects.toThrow(/cable exists/);
  });

  it('a draft-device endpoint not placed yet waits; placing it makes the cable across levels', async () => {
    const { store, editor, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    const res = await acceptCable(editor, store, data, row(data.cables, ids.c1), { confirm: true });
    expect(res).toMatchObject({ waiting: true, cableId: null });
    expect(await commitWaitingCables(editor, store, PROJECT)).toBe(0);
    let after = await loadDraftReview(store, PROJECT);
    expect(row(after.cables, ids.c1)).toMatchObject({ state: 'accepted', waiting: true, committed: false, confirmed: true });
    // T46 places the UFMP4 from its draft
    const { id: ufmp } = await editor.create('device', { level_id: ids.l02, category: 'Foundry panel', device: 'UFMP4', baseline_ref_id: ids.dE, origin: 'baseline' }, { change_type: 'Master edit', reason: 'Place' });
    expect(await commitWaitingCables(editor, store, PROJECT)).toBe(1);
    after = await loadDraftReview(store, PROJECT);
    expect(row(after.cables, ids.c1)).toMatchObject({ waiting: false, committed: true });
    expect(row(after.devices, ids.dE).placed).toBe(1);
    const ends = await store.db.query<Record<string, unknown>>(`SELECT e.* FROM cable_end e JOIN cable c ON c.id = e.cable_id WHERE c.cable = 'X' AND e.device_id IN (?, ?) ORDER BY e.side`, [ids.panel, ufmp]);
    expect(ends.map((e) => [e.side, e.from_text, e.to_text, e.level_id])).toEqual([
      ['A', 'CT06LCPA', 'DMX to Level 02 UFMP4', ids.l06m],
      ['B', 'UFMP4', 'DMX to Level 06M CT06LCPA', ids.l02],
    ]);
    const cable = await store.get<Record<string, unknown>>('cable', String(ends[0]!.cable_id));
    expect(cable!.endpoint_confirmed).toBe(true);
    expect(await commitWaitingCables(editor, store, PROJECT)).toBe(0);
  });

  it('a run the baseline already has is linked, not duplicated; Accept all makes unconfirmed cables', async () => {
    const { store, editor, ids } = await setup();
    let data = await loadDraftReview(store, PROJECT);
    const linked = await acceptCable(editor, store, data, row(data.cables, ids.c4), { confirm: false, riserBlob: 'cd'.repeat(32) });
    expect(linked).toMatchObject({ linked: true, cableId: ids.fiber });
    const fiber = await store.get<Record<string, unknown>>('cable', ids.fiber);
    expect(fiber).toMatchObject({ vertical: 'Equipment rack F', endpoint_confirmed: false });
    expect((fiber!.riser_ref as Record<string, unknown>).blob).toBe('cd'.repeat(32));
    expect((await store.list('cable', { where: "cable = 'F'" })).length).toBe(1);

    data = await loadDraftReview(store, PROJECT);
    expect(await acceptAll(editor, store, data, ids.l06m, 'cables', { riserBlob: 'ef'.repeat(32) })).toBe(1);
    const x = await store.db.query<Record<string, unknown>>(`SELECT c.* FROM cable c JOIN cable_end e ON e.cable_id = c.id WHERE e.placeholder_id = ?`, [ids.canyon]);
    expect(x).toHaveLength(1);
    expect(x[0]).toMatchObject({ cable: 'X', endpoint_confirmed: 0, vertical: 'Equipment rack X' });
    const ends = await store.list<Record<string, unknown>>('cable_end', { where: 'cable_id = ?', params: [String(x[0]!.id)], orderBy: 'side' });
    expect(ends.map((e) => [e.side, e.endpoint_kind, e.from_text, e.to_text])).toEqual([
      ['A', 'device', 'Equipment rack', 'DMX to B3A Canyon'],
      ['B', 'placeholder', 'B3A Canyon', null],
    ]);
    expect(row((await loadDraftReview(store, PROJECT)).cables, ids.c2)).toMatchObject({ state: 'accepted', committed: true, confirmed: false });
  });

  it("the project's own cable codes (T121): offered and accepted once its Rules give them a signal word", async () => {
    const { store, editor, ids } = await setup();
    await expect(setCableCode(editor, ids.c3, 'DX', (await loadDraftReview(store, PROJECT)).codes)).rejects.toThrow(/Cable code must be one of: X · N .* · D\.$/);
    await setRuleParam(editor, 'R3', 'signal', { DX: 'DALI-2' });
    const { codes } = await loadDraftReview(store, PROJECT);
    expect(codes).toEqual([...CABLE_CODES, 'DX']);
    await setCableCode(editor, ids.c3, 'DX', codes);
    const hand = await addCableDraft(editor, PROJECT, { levelId: ids.l02, code: 'DX', fromLabel: 'CT02LCPA', toLabel: 'DALI-2 bus' }, codes);
    await expect(addCableDraft(editor, PROJECT, { levelId: ids.l02, code: 'DX', fromLabel: 'a', toLabel: 'b' })).rejects.toThrow(/Cable code/); // the master's ten by default
    const data = await loadDraftReview(store, PROJECT);
    expect([row(data.cables, ids.c3).code, row(data.cables, hand).code]).toEqual(['DX', 'DX']);
  });

  it('a code is chosen for a line without one; panic and single-row texts', async () => {
    const { store, editor, ids } = await setup();
    await expect(setCableCode(editor, ids.c3, 'Z')).rejects.toThrow(/Cable code/);
    await setCableCode(editor, ids.c3, 'NG');
    const data = await loadDraftReview(store, PROJECT);
    expect(row(data.cables, ids.c3).code).toBe('NG');
    expect(data.codes).toEqual(CABLE_CODES);
    const a = realEnd(data, { kind: 'device', id: ids.panel, label: '', levelId: ids.l06m })!;
    const b = realEnd(data, { kind: 'placeholder', id: ids.lvl9, label: '', levelId: null })!;
    const p = cablePayload({ id: 'x', code: 'P', qty: null, origin: 'manual', levelId: ids.l06m, toLevelId: null, sourceRef: null }, a, b, { confirm: false });
    expect(p.cable).toMatchObject({ cable: 'P', single_row: true, origin: 'manual', riser_ref: null, vertical: null, qty: 1 });
    expect(p.ends[0]).toMatchObject({ from_text: 'CT06LCPA', to_text: 'EBDK panic wire' });
    const q = cablePayload({ id: 'x', code: 'X', qty: 1, origin: 'riser', levelId: ids.l06m, toLevelId: null, sourceRef: null }, a, b, { confirm: false });
    expect(q.ends.map((e) => e.to_text)).toEqual(['DMX to Level 09', null]);
  });
});

describe('riser lines with no bubble (T108, D192, D194)', () => {
  const MASTER = { change_type: 'Master edit', reason: 'test' } as const;

  async function withLines() {
    const s = await setup();
    const { editor, ids } = s;
    const fixtures = (await editor.create('placeholder', { project_id: PROJECT, label: 'Fixtures', kind: 'fixtures' }, MASTER)).id;
    const power = (await editor.create('placeholder', { project_id: PROJECT, label: '120v Power', kind: 'power' }, MASTER)).id;
    const lineRef = (line: string, label: string) => ({ kind: 'riser_line', file: 'riser.pdf', page: 1, sheet: '001', band: 'p1c0b3', bbox: [40, 70, 30, 9], line, label, level_code: '06M' });
    const line = async (f: Record<string, unknown>) =>
      (await editor.create('draft_cable', { project_id: PROJECT, import_batch_id: ids.riser, level_id: ids.l06m, code: null, qty: 1, origin: 'riser', state: 'proposed', level_basis: 'riser_band', extraction: 'text', ...f }, MASTER)).id;
    // the panel's 0-10V leader: guessed from its text, the library's far end offered
    const ctl = await line({
      from_label: 'CT06LCPA', to_label: '(2)#16 AWG STRANDED WIRES PER CHANNEL TO 0-10V CONTROL (BY OTHERS)', confidence: 0.5,
      conflicts: ['code:unknown', 'endpoint:low_confidence'], source_ref: lineRef('l36', '(2)#16 AWG … TO 0-10V CONTROL (BY OTHERS)'),
      candidates: [{ side: 'from', kind: 'draft_device', id: ids.dD, label: 'CT06LCPA', confidence: 0.9 }, { side: 'code', value: '0-10V', confidence: 0.5, source: 'label' }, { side: 'to', kind: 'placeholder', id: fixtures, label: 'Fixtures', confidence: 0.5 }],
    });
    // the rack's 120V feed
    const feed = await line({
      from_label: 'Equipment Rack 18U', to_label: '1Ø, 2 WIRE + GND 120V / 60 Hz.', confidence: 0.5, conflicts: ['code:unknown', 'endpoint:low_confidence'], source_ref: lineRef('l41', '1Ø, 2 WIRE + GND 120V'),
      candidates: [{ side: 'from', kind: 'draft_device', id: ids.dRack, label: 'Equipment Rack 18U', confidence: 0.9 }, { side: 'code', value: '120V', confidence: 0.85, source: 'model' }, { side: 'to', kind: 'placeholder', id: power, label: '120v Power', confidence: 0.85 }],
    });
    // a load arrow: no guess, no far end
    const load = await line({ from_label: 'CT06LCPA', to_label: 'TO LOAD CKTS', confidence: 0.5, conflicts: ['code:unknown'], source_ref: lineRef('l35', 'TO LOAD CKTS'), candidates: [{ side: 'from', kind: 'draft_device', id: ids.dD, label: 'CT06LCPA', confidence: 0.9 }] });
    return { ...s, fixtures, power, ctl, feed, load };
  }

  it('reads the guess, asks first and never takes the guess as the code', async () => {
    const { store, ids, ctl, feed, load } = await withLines();
    const data = await loadDraftReview(store, PROJECT);
    const c = row(data.cables, ctl);
    expect(c).toMatchObject({ code: null, unknownCode: true, flagged: true, codeGuess: { value: '0-10V', confidence: 0.5, source: 'label' } });
    expect(c.ends.to).toMatchObject({ kind: 'placeholder', label: 'Fixtures' });
    expect(c.sources[0]).toMatchObject({ kind: 'riser', label: 'Riser 001 · level 06M · line l36', bbox: [40, 70, 30, 9] });
    expect(row(data.cables, feed).codeGuess).toEqual({ value: '120V', confidence: 0.85, source: 'model' });
    expect(row(data.cables, load)).toMatchObject({ codeGuess: null, ends: { to: null } });
    expect(cableBlockers(c)).toEqual(['Pick the cable code.']);
    // the open questions lead the level's cable list
    expect(cablesOn(data, ids.l06m, 'open').slice(0, 3).map((x) => x.id).sort()).toEqual([ctl, feed, load].sort());
    expect(mismatchList(data, ids.l06m).map((m) => m.text)).toContain('A riser line with no wire code from CT06LCPA → "TO LOAD CKTS" — what is it?');
    expect(bulkCables(data, ids.l06m).map((x) => x.id)).not.toContain(ctl);
  });

  it('Accept writes the picked code, clears the question and makes the library row (0-10V → Fixtures)', async () => {
    const { store, editor, ids, ctl, fixtures } = await withLines();
    const engine = engineFor(store, PROJECT, ME);
    await engine.run();
    const r2c = async () => (await loadDeviceCard(store, ids.panel))!.drafts.filter((d) => d.ruleId === 'R2c').map((d) => (d.payload.cable as { cable: string }).cable).sort();
    expect(await r2c()).toEqual(['0-10V', 'P']);
    await setCableCode(editor, ctl, '0-10V');
    let data = await loadDraftReview(store, PROJECT);
    const res = await acceptCable(editor, store, data, row(data.cables, ctl), { confirm: true, riserBlob: 'ab'.repeat(32) });
    expect(res).toMatchObject({ linked: false, waiting: false });
    const cable = await store.get<Record<string, unknown>>('cable', res.cableId!);
    expect(cable).toMatchObject({ cable: '0-10V', single_row: true, origin: 'riser', vertical: 'CT06LCPA 0-10V', endpoint_confirmed: true });
    expect((cable!.riser_ref as Record<string, unknown>).bbox).toEqual([40, 70, 30, 9]);
    const ends = await store.list<Record<string, unknown>>('cable_end', { where: 'cable_id = ?', params: [res.cableId], orderBy: 'side' });
    expect(ends.map((e) => [e.side, e.device_id ?? e.placeholder_id, e.from_text, e.to_text])).toEqual([
      ['A', ids.panel, 'CT06LCPA', 'Fixtures'],
      ['B', fixtures, 'Fixtures', null],
    ]);
    data = await loadDraftReview(store, PROJECT);
    expect(row(data.cables, ctl)).toMatchObject({ code: '0-10V', state: 'edited', unknownCode: false, committed: true });
    expect(row(data.cables, ctl).conflicts).toEqual(['endpoint:low_confidence']);
    // the library's R2c draft for that row is gone: one cable, not two
    await engine.run();
    expect(await r2c()).toEqual(['P']);
  });

  it('meets the library row the device already has: linked, one cable not two (120V and 0-10V)', async () => {
    const { store, editor, ids, ctl, feed, fixtures, power } = await withLines();
    // R2c's accepted draft already made the panel's 0-10V row (another far end than the line's pick)
    const ends = [uuidv7(), uuidv7()];
    const { id: lib } = await editor.create('cable', { project_id: PROJECT, cable: '0-10V', qty: 1, single_row: true, origin: 'library', endpoint_confirmed: true, end_a_id: ends[0], end_b_id: ends[1] }, MASTER);
    await editor.create('cable_end', { id: ends[0], cable_id: lib, side: 'A', endpoint_kind: 'device', device_id: ids.panel, level_id: ids.l06m, from_text: 'CT06LCPA', to_text: 'Fixtures' }, MASTER);
    await editor.create('cable_end', { id: ends[1], cable_id: lib, side: 'B', endpoint_kind: 'placeholder', placeholder_id: ids.canyon, from_text: 'B3A Canyon' }, MASTER);
    await setCableCode(editor, ctl, '0-10V');
    let data = await loadDraftReview(store, PROJECT);
    const res = await acceptCable(editor, store, data, row(data.cables, ctl), { confirm: false, riserBlob: 'cd'.repeat(32) });
    expect(res).toMatchObject({ linked: true, cableId: lib });
    expect(await store.list('cable', { where: "cable = '0-10V'" })).toHaveLength(1);
    expect(((await store.get<Record<string, unknown>>('cable', lib))!.riser_ref as Record<string, unknown>).draft).toBe(ctl);
    expect(fixtures).toBeTruthy();
    // the rack's 120V feed, accepted first: it is the library's row (R2d's texts, D52)
    await setCableCode(editor, feed, '120V');
    data = await loadDraftReview(store, PROJECT);
    const r = await acceptCable(editor, store, data, row(data.cables, feed), { confirm: true });
    const e = await store.list<Record<string, unknown>>('cable_end', { where: 'cable_id = ?', params: [r.cableId], orderBy: 'side' });
    expect(e.map((x) => [x.device_id ?? x.placeholder_id, x.from_text, x.to_text])).toEqual([
      [ids.rack, '120v Power', 'Equipment rack'],
      [power, '120v Power', null],
    ]);
    expect(libraryRow('120V', realEnd(data, { kind: 'placeholder', id: power, label: '', levelId: null })!, realEnd(data, { kind: 'device', id: ids.rack, label: '', levelId: ids.l06m })!)).toMatchObject({ to: 'Equipment rack' });
    expect(libraryRow('120V', realEnd(data, { kind: 'device', id: ids.panel, label: '', levelId: ids.l06m })!, realEnd(data, { kind: 'placeholder', id: power, label: '', levelId: null })!)).toBeNull(); // no 120V row on a relay panel
  });

  it('a line that is not a cable to survey is rejected with a reason', async () => {
    const { store, editor, load } = await withLines();
    let data = await loadDraftReview(store, PROJECT);
    await rejectDraft(editor, 'cable', row(data.cables, load), 'Load circuits, by others');
    data = await loadDraftReview(store, PROJECT);
    expect(row(data.cables, load)).toMatchObject({ state: 'rejected', code: null });
    expect(await store.list('cable', { where: 'cable IS NULL' })).toHaveLength(0);
  });
});

describe('draft review server helpers (T44)', () => {
  const bom: Batch = { id: 'b1', kind: 'bom', job_state: 'done', created_at: '2026-10-15T10:00:00Z', files: [{ name: 'BOM.pdf' }], stats: { file: 'BOM.pdf', drafts: 108, excluded: 1, flagged: 9, excluded_lines: [{ reason: 'service line', model: null, part_number: 'ENERGIZATION', description: 'Energization', qty: 1, source_ref: { kind: 'bom_line', page: 2, line: 7, bbox: [1, 2, 3, 4], level_code: '01' }, extraction: 'text' }] } };
  const riserOld: Batch = { id: 'r0', kind: 'riser', job_state: 'done', created_at: '2026-10-14T10:00:00Z', files: [{ name: 'riser.pdf' }], stats: { file: 'riser.pdf', blob: 'old' } };
  const riser: Batch = { id: 'r1', kind: 'riser', job_state: 'done', created_at: '2026-10-15T11:00:00Z', files: [{ name: 'riser.pdf' }], stats: { file: 'riser.pdf', blob: 'new', device_drafts: 93, merged_into_bom: 40, cable_drafts: 71, endpoints_unresolved: 0, claude: { cost_usd: 1.93 } } };
  const batches = [bom, riserOld, riser];

  it('finds the batch of a source, builds the crop URL, reads the riser blob', () => {
    expect(batchFor(batches, { kind: 'riser', file: 'riser.pdf', batchId: null })?.id).toBe('r1');
    expect(batchFor(batches, { kind: 'riser', file: 'riser.pdf', batchId: 'r0' })?.id).toBe('r0');
    expect(batchFor(batches, { kind: 'bom', file: 'other.pdf', batchId: null })).toBeNull();
    const url = cropUrl('https://survey.example/', bom, { kind: 'bom', label: '', file: 'BOM.pdf', batchId: 'b1', page: 3, bbox: [10.04, 20, 290, 12] }, { px: 800 });
    expect(url).toBe('https://survey.example/imports/b1/crop?page=3&bbox=10%2C20%2C290%2C12&pad=24&px=800');
    expect(cropUrl('https://s', null, { kind: 'bom', label: '', file: null, batchId: null, page: 1, bbox: [1, 1, 1, 1] })).toBeNull();
    expect(riserBlobFor(batches, 'riser.pdf')).toBe('new');
    expect(extractionLine('riser', riser)).toBe("Done: 93 device drafts (40 merged into the BOM's), 71 cable drafts, 0 far ends to pick · Claude $1.93");
    expect(extractionLine('bom', bom)).toBe('Done: 108 device drafts, 1 excluded lines, 9 flagged');
    const davinci: Batch = { id: 'd1', kind: 'davinci', job_state: 'done', files: [{ name: 'library.json' }, { name: 'DaVinci_categories.xlsx' }], stats: { created: 1130, updated: 2, unchanged: 0, placeable: 501, accessory_only: 631, vocab_drafts: 33, kept_accepted: 1, kept_rejected: 0, retired: ['P-NSPS-D-KIT', 'PI1002'], clashes: [{ type_id: 'x', model: 'P-NSPS-D', held_by: null }] } };
    expect(extractionLine('davinci', davinci)).toBe('Done: 1130 new drafts, 2 updated, 0 unchanged (501 device types, 631 accessories), 33 protocol drafts, 1 accepted or rejected left alone, 2 hand-made types retired, 1 model clash');
    expect(extractionLine('davinci', { ...davinci, job_state: 'skipped' })).toBe('Already imported — this library and mapping were imported before');
  });

  it('lists excluded lines and knows which were promoted', async () => {
    const { store, editor } = await setup();
    const lines = excludedLines(batches);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ levelCode: '01', batch: { id: 'b1', file: 'BOM.pdf' } });
    await promoteExcluded(editor, PROJECT, lines[0]!.batch, lines[0]!, null);
    const data = await loadDraftReview(store, PROJECT);
    expect(promotedKeys(data.devices).has(lines[0]!.key)).toBe(true);
    expect(data.devices.find((d) => d.sourceRef?.promoted)).toMatchObject({ model: 'ENERGIZATION', levelId: null, levelCode: '01' });
  });

  it('counts the flagged open drafts for Needs review (D11)', async () => {
    const { store, editor, ids } = await setup();
    expect(await flaggedDraftCounts(store, PROJECT)).toEqual({ devices: 4, cables: 1 });
    const data = await loadDraftReview(store, PROJECT);
    await rejectDraft(editor, 'device', row(data.devices, ids.dF), 'Pooled; placed by the riser');
    expect(await flaggedDraftCounts(store, PROJECT)).toEqual({ devices: 3, cables: 1 });
  });
});

describe('draft roles (T115, D201)', () => {
  const MASTER = { change_type: 'Master edit' as const, reason: 'seed' };

  it("reads the extraction's role and finds the master's old-spelled device by it", async () => {
    const { store, editor, ids } = await setup();
    // a riser rack written the T115 way: role + D196 category, beside the master's `Equipment rack`
    const { id } = await editor.create('draft_device', { project_id: PROJECT, level_id: ids.l06m, model: 'ERN4-RM-120', category: 'Equipment Panels', role: 'equipment_rack', qty: 1, state: 'proposed', level_basis: 'riser_band' }, MASTER);
    const data = await loadDraftReview(store, PROJECT);
    const d = row(data.devices, id);
    expect(d.role).toBe('equipment_rack');
    expect(deviceForDraft(data, d)?.id).toBe(ids.rack);
    // a draft from before T115 has no role: its category's
    expect(row(data.devices, ids.dD).role).toBeNull();
    expect(draftRole(row(data.devices, ids.dD))).toBe('relay_panel');
    // `Power Distribution` names no role: compared by canonical category — the master's `Relay panel` is one
    expect(deviceForDraft(data, { ...d, id: uuidv7(), role: null, category: 'Power Distribution', name: null })?.id).toBe(ids.panel);
  });

  it('a category picked or edited by hand sets the role it names; a hand draft too', async () => {
    const { store, editor, ids } = await setup();
    const data = await loadDraftReview(store, PROJECT);
    await editDevice(editor, row(data.devices, ids.dA), { category: 'Sensor' });
    await editDevice(editor, row(data.devices, ids.dE), { category: 'Power Distribution' });
    const hand = await addDeviceDraft(editor, PROJECT, { levelId: ids.l02, model: 'EBDK', category: 'EBDK', qty: 1 });
    const after = await loadDraftReview(store, PROJECT);
    expect(row(after.devices, ids.dA)).toMatchObject({ category: 'Sensor', role: 'sensor' });
    expect(row(after.devices, ids.dE)).toMatchObject({ category: 'Power Distribution', role: null }); // the type decides
    expect(row(after.devices, hand)).toMatchObject({ category: 'Emergency Equipment', role: 'ebdk' });
  });

  it("placement's type match (T46): the catalogue type by model, its role before the draft's", () => {
    const t = (id: string, model: string, category: string, role: string | null): DeviceType => ({ id, project_id: null, model, aliases: [], state: 'accepted', category, needs_neuron_id: null, role });
    const types = new Map<string, DeviceType>([
      ['a', t('a', 'ERP24-FT-241P', 'Power Distribution', null)],
      ['b', t('b', 'UFMP8', 'Power Distribution', 'foundry_panel')],
      ['c', t('c', 'P-GWY', 'Equipment', null)],
    ]);
    expect(typeForDraft(types, { model: 'UFMP8', role: 'relay_panel', category: 'Power Distribution' })).toMatchObject({ type: { id: 'b' }, role: 'foundry_panel' });
    expect(typeForDraft(types, { model: 'erp24-ft-241p', role: 'relay_panel', category: 'Power Distribution' })).toMatchObject({ type: { id: 'a' }, role: 'relay_panel' });
    expect(typeForDraft(types, { model: 'P-GWY', role: 'other', category: 'Equipment' })).toMatchObject({ type: { id: 'c' }, role: 'other' });
    expect(typeForDraft(types, { model: 'PI1002', role: null, category: 'Station' })).toEqual({ type: null, role: 'station' });
  });
});
