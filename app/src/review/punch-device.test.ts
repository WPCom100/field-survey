/**
 * T81 (D148, D150): an imported punch row linked to no device on Needs review (the master's text,
 * the level's devices to link to, Link closes the item), and the Device text the side list and
 * the device card show, which follows a rename of the device with no punch op.
 */

import { Editor, PUNCH_DEVICE_LINT, Store, linkPunchDevice, uuidv7, type EditContext, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { loadLevelPlan } from '../plan/data';
import { loadLevelLists } from '../plan/lists';
import { loadReviewDetail, loadReviewList } from './model';

const PROJECT = uuidv7();
const ANN = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 60_000)).toISOString();
let seq = 0;

/** A record as the server (the seed import) delivers it. */
async function remote(store: Store, kind: Op['entity_kind'], id: string, payload: Record<string, unknown>): Promise<void> {
  await store.applyRemote({
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'server', client_ts: tsNext(),
    entity_kind: kind, entity_id: id, kind: 'create', payload,
    change_type: 'Master edit', server_seq: ++seq, server_ts: tsNext(), state: 'applied',
  } as Op);
}

describe('punch Device text and the unlinked-punch review item', () => {
  let store: Store;
  let editor: Editor;
  let level: string;
  let station: string;
  let linkedPunch: string;
  let roomPunch: string;
  let itemId: string;

  beforeEach(async () => {
    store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    await remote(store, 'project', PROJECT, { name: 'Tower' });
    const group = uuidv7();
    await remote(store, 'numbering_group', group, { project_id: PROJECT, label: 'B1' });
    level = uuidv7();
    await remote(store, 'level', level, { project_id: PROJECT, level: 'B1', floor_order: 2, numbering_group_id: group });
    station = uuidv7();
    await remote(store, 'device', station, { level_id: level, display_id: 'B1-S3', category: 'Station', device: 'PI1002', room_location: 'Corridor XXB1-C005 north' });
    await remote(store, 'device', uuidv7(), { level_id: level, display_id: 'B1-01', category: 'Relay panel', device: 'CTB1LCPB', panel_name: 'CTB1LCPB' });
    linkedPunch = uuidv7();
    await remote(store, 'punch_item', linkedPunch, { level_id: level, number: 8, item: 'Install cover', device_id: station, device_text: 'PI1002 S3 - Corridor XXB1-C005 north' });
    roomPunch = uuidv7();
    await remote(store, 'punch_item', roomPunch, { level_id: level, number: 27, item: 'Gain access; survey 5x PI1002', device_text: 'Walter Tower east wing' });
    itemId = uuidv7();
    await remote(store, 'review_item', itemId, {
      project_id: PROJECT,
      level_id: level,
      kind: 'lint',
      subject: { entity_kind: 'punch_item', entity_id: roomPunch, field: 'device_id', level_id: level, lint_id: PUNCH_DEVICE_LINT },
      candidates: [{ side: 'import', value: 'Walter Tower east wing' }],
      ruling: false,
      state: 'open',
    });
    editor = new Editor(store, { projectId: PROJECT, userId: ANN, now: tsNext });
  });

  const lists = async () => {
    const plan = (await loadLevelPlan(store, level))!;
    return loadLevelLists(store, PROJECT, level, 'B1', plan.devices);
  };

  it('Needs review lists it with the master text and offers the level devices', async () => {
    const list = await loadReviewList(store, PROJECT);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ kind: 'lint', subject: 'Punch #27 Gain access; survey 5x PI1002', field: 'Device "Walter Tower east wing" → link' });
    const d = (await loadReviewDetail(store, itemId, new Map()))!;
    expect(d.resolvable).toBe(false); // no A/B: Link / Create instead
    expect(d.punchDevice).toMatchObject({ punchId: roomPunch, master: 'Walter Tower east wing', levelCode: 'B1', linkedTo: null });
    expect(d.punchDevice!.devices.map((x) => [x.label, x.text])).toEqual([
      ['B1-01', 'CTB1LCPB'],
      ['B1-S3', 'PI1002 S3 - Corridor XXB1-C005 north'],
    ]);
  });

  it('Link closes the item; the list row and the export text then follow the device', async () => {
    const before = await lists();
    expect(before.punch.find((r) => r.id === roomPunch)!.sub).toContain('Walter Tower east wing'); // unlinked: master text (D150)
    await linkPunchDevice(editor, itemId, station, { deviceLabel: 'B1-S3' });
    expect((await loadReviewList(store, PROJECT)).rows).toEqual([]);
    const d = (await loadReviewDetail(store, itemId, new Map()))!;
    expect(d.item.state).toBe('resolved');
    expect(d.punchDevice!.linkedTo).toBe(station);
    const after = await lists();
    expect(after.punch.find((r) => r.id === roomPunch)!.sub).toBe('B1-S3 · PI1002 S3 - Corridor XXB1-C005 north · Open');
  });

  it('a rename of the device shows on its punch items with no punch op (D148)', async () => {
    expect((await lists()).punch.find((r) => r.id === linkedPunch)!.sub).toContain('PI1002 S3 - Corridor XXB1-C005 north');
    await editor.setField('device', station, 'room_location', 'Corridor XXB1-C005 north end', CTX);
    await editor.setField('device', station, 'device', 'PI1004', CTX);
    const row = (await lists()).punch.find((r) => r.id === linkedPunch)!;
    expect(row.sub).toContain('PI1004 S3 - Corridor XXB1-C005 north end');
    expect(row.text).toContain('north end'); // searchable by the new room
    const card = (await loadDeviceCard(store, station))!;
    expect(card.punch.map((p) => p.deviceText)).toEqual(['PI1004 S3 - Corridor XXB1-C005 north end']);
    const punchOps = await store.db.query<{ n: number }>(`SELECT count(*) AS n FROM op WHERE entity_id = ? AND kind <> 'create'`, [linkedPunch]);
    expect(punchOps[0]!.n).toBe(0);
  });
});
