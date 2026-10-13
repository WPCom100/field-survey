/**
 * T81 (D148, D150, D151): a punch item's Device text is derived from its device (a rename shows with
 * no punch op), an unlinked item keeps the master's text, and Needs review links an imported punch
 * item to a device as one Reconcile group that closes the review item.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { Editor } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import type { Op } from './op';
import { PUNCH_DEVICE_LINT, defaultDeviceText, isPunchDeviceItem, linkPunchDevice, punchDeviceText } from './punch';
import { ReviewError, type ReviewItem } from './review';
import { Store } from './store';

const PROJECT = uuidv7();
const L01 = uuidv7();
const L02 = uuidv7();
const ANN = uuidv7();
let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();
let seq = 0;

type Row = Record<string, unknown>;

/** A record as the server delivers it (a server `create` op). */
async function remote(store: Store, kind: Op['entity_kind'], id: string, payload: Row): Promise<void> {
  await store.applyRemote({
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'server', client_ts: tsNext(),
    entity_kind: kind, entity_id: id, kind: 'create', payload,
    change_type: 'Master edit', server_seq: ++seq, server_ts: tsNext(), state: 'applied',
  } as Op);
}

describe('Device text (D148, D151)', () => {
  it('derives the master format from the device', () => {
    expect(defaultDeviceText({ display_id: 'B1-S3', category: 'Station', device: 'PI1002', room_location: 'Corridor XXB1-C005 north' })).toBe(
      'PI1002 S3 - Corridor XXB1-C005 north',
    );
    expect(defaultDeviceText({ display_id: 'B1-D4', category: 'Sensor', device: 'P-DOC-C-LR', room_location: 'Elevator Lobby B' })).toBe(
      'P-DOC-C-LR D4 - Elevator Lobby B',
    );
    expect(defaultDeviceText({ display_id: 'B1-01', category: 'Relay panel', device: 'CTB1LCPB', panel_name: 'CTB1LCPB', room_location: 'Elec' })).toBe('CTB1LCPB');
    expect(defaultDeviceText({ display_id: '06M-02', category: 'Foundry panel', device: 'CT06LCPA', panel_name: 'CT06LCPA', room_location: 'Elec' })).toBe('CT06LCPA');
    expect(defaultDeviceText({ display_id: 'B1-02', category: 'EBDK', device: 'EBDK', panel_name: 'CTB1LCPB', room_location: 'Elec' })).toBe('EBDK (CTB1LCPB)');
    expect(defaultDeviceText({ display_id: '01-05', category: 'Equipment rack', device: 'Equipment Rack 18U', room_location: 'Elec' })).toBe('Equipment Rack 18U');
    expect(defaultDeviceText({ display_id: '01-04', category: 'NSPS', device: 'P-NSPS-D-KIT', room_location: 'Elec' })).toBe('P-NSPS-D-KIT');
    expect(defaultDeviceText({ display_id: '01-08', category: 'Foundry panel', device: 'UFMP4', room_location: 'BH OBS RM 47' })).toBe('UFMP4 - BH OBS RM 47');
    // a field addition the server has not numbered yet: no tag, never a guessed one
    expect(defaultDeviceText({ display_id: null, category: 'Station', device: 'PI1002', room_location: 'Corridor' })).toBe('PI1002 - Corridor');
    expect(defaultDeviceText({ category: 'Station' })).toBe('Station');
    expect(defaultDeviceText(null)).toBeNull();
  });

  it('a linked item shows its device; an unlinked one the master text (D150)', () => {
    const punch = { device_text: 'PI1002 S3 - Corridor XXB1-C005 north' };
    const dev = { display_id: 'B1-S3', category: 'Station', device: 'PI1004', room_location: 'Corridor XXB1-C005 north end' };
    expect(punchDeviceText(punch, dev)).toBe('PI1004 S3 - Corridor XXB1-C005 north end');
    expect(punchDeviceText({ device_text: 'Walter Tower east wing' }, null)).toBe('Walter Tower east wing');
    expect(punchDeviceText({ device_text: null }, null)).toBeNull();
  });
});

describe('linkPunchDevice (Needs review → Link to device)', () => {
  let store: Store;
  let editor: Editor;
  let punchId: string;
  let itemId: string;
  let station: string;
  let elsewhere: string;

  beforeEach(async () => {
    store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    await remote(store, 'project', PROJECT, { name: 'Tower' });
    const group = uuidv7();
    await remote(store, 'numbering_group', group, { project_id: PROJECT, label: '01' });
    await remote(store, 'level', L01, { project_id: PROJECT, level: '01', floor_order: 3, numbering_group_id: group });
    await remote(store, 'level', L02, { project_id: PROJECT, level: '02', floor_order: 4, numbering_group_id: group });
    station = uuidv7();
    await remote(store, 'device', station, { level_id: L01, display_id: '01-S10', category: 'Station', device: 'PI1002', room_location: 'Walter Tower' });
    elsewhere = uuidv7();
    await remote(store, 'device', elsewhere, { level_id: L02, display_id: '02-S1', category: 'Station', device: 'PI1002' });
    punchId = uuidv7();
    await remote(store, 'punch_item', punchId, { level_id: L01, number: 27, item: 'Gain access; survey', device_text: 'Walter Tower east wing' });
    itemId = uuidv7();
    await remote(store, 'review_item', itemId, {
      project_id: PROJECT,
      level_id: L01,
      kind: 'lint',
      subject: { entity_kind: 'punch_item', entity_id: punchId, field: 'device_id', level_id: L01, lint_id: PUNCH_DEVICE_LINT },
      candidates: [{ side: 'import', value: 'Walter Tower east wing' }],
      ruling: false,
      state: 'open',
    });
    editor = new Editor(store, { projectId: PROJECT, userId: ANN, now: tsNext });
  });

  it('sets device_id and closes the item in one Reconcile group', async () => {
    const item = (await store.get<ReviewItem>('review_item', itemId))!;
    expect(isPunchDeviceItem(item)).toBe(true);
    const r = await linkPunchDevice(editor, itemId, station, { deviceLabel: '01-S10', now: () => '2026-10-12T15:00:00.000Z' });
    expect(r.reason).toBe('Review: linked punch item to 01-S10 (master: "Walter Tower east wing")');
    expect(r.ops.map((o) => [o.entity_kind, o.field])).toEqual([
      ['punch_item', 'device_id'],
      ['review_item', 'resolution'],
      ['review_item', 'resolved_by_id'],
      ['review_item', 'resolved_at'],
      ['review_item', 'state'],
    ]);
    expect(new Set(r.ops.map((o) => o.group_id)).size).toBe(1);
    expect(r.ops.every((o) => o.change_type === 'Reconcile' && o.reason === r.reason)).toBe(true);
    const punch = (await store.get<Row>('punch_item', punchId))!;
    expect(punch.device_id).toBe(station);
    expect(punch.device_text).toBe('Walter Tower east wing'); // the master's text stays for reference
    const done = (await store.get<ReviewItem>('review_item', itemId))!;
    expect(done).toMatchObject({ state: 'resolved', resolved_by_id: ANN, resolved_at: '2026-10-12T15:00:00.000Z' });
    expect(done.resolution).toMatchObject({ choice: 'link', value: station, reconcile_op_ids: [r.ops[0]!.op_id] });
    // the text now follows the device
    expect(punchDeviceText(punch, await store.get<Row>('device', station))).toBe('PI1002 S10 - Walter Tower');
    await expect(linkPunchDevice(editor, itemId, station, { deviceLabel: '01-S10' })).rejects.toThrow(/already resolved/);
  });

  it('a device created on the iPad (no ID yet) can be linked at once', async () => {
    const { id } = await editor.create('device', { level_id: L01, category: 'Station', device: 'PI1002', origin: 'field_addition' }, { change_type: 'Field survey', reason: 'found for punch #27' });
    const r = await linkPunchDevice(editor, itemId, id, { deviceLabel: '01-? (new)' });
    expect((await store.get<Row>('punch_item', punchId))!.device_id).toBe(id);
    expect(r.reason).toContain('01-? (new)');
  });

  it('refuses a device on another level, an unknown device and other review items', async () => {
    await expect(linkPunchDevice(editor, itemId, elsewhere, { deviceLabel: '02-S1' })).rejects.toThrow(/another level/);
    await expect(linkPunchDevice(editor, itemId, uuidv7(), { deviceLabel: '?' })).rejects.toThrow(ReviewError);
    const other = uuidv7();
    await remote(store, 'review_item', other, {
      project_id: PROJECT, level_id: L01, kind: 'lint',
      subject: { entity_kind: 'punch_item', entity_id: punchId, field: 'type', lint_id: 'import.out_of_list' },
      candidates: [], ruling: false, state: 'open',
    });
    await expect(linkPunchDevice(editor, other, station, { deviceLabel: '01-S10' })).rejects.toThrow(/Not a punch item/);
    expect((await store.get<Row>('punch_item', punchId))!.device_id).toBeNull();
  });
});
