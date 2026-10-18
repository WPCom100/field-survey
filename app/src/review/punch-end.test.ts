/**
 * T122 (D220): an imported cable item left on its device waits on Needs review with its device's
 * ends of the code it names (live), Put on sets its end with one op and closes the item, Keep
 * closes it with the item unchanged.
 */

import { Editor, PUNCH_END_LINT, Store, setPunchEnd, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadReviewDetail, loadReviewList } from './model';

const PROJECT = uuidv7();
const ANN = uuidv7();
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

describe('a cable item without its end (T122)', () => {
  let store: Store;
  let editor: Editor;
  let level: string;
  let panel: string;
  let punchId: string;
  let itemId: string;
  const ends: Record<string, string> = {};

  const end = async (label: string | null, code: string, to: string) => {
    const cable = uuidv7();
    const id = uuidv7();
    await remote(store, 'cable', cable, { project_id: PROJECT, cable: code });
    await remote(store, 'cable_end', id, { cable_id: cable, side: 'A', level_id: level, device_id: panel, display_id: label, to_text: to });
    return id;
  };

  beforeEach(async () => {
    store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
    await remote(store, 'project', PROJECT, { name: 'Tower' });
    const group = uuidv7();
    await remote(store, 'numbering_group', group, { project_id: PROJECT, label: '06M' });
    level = uuidv7();
    await remote(store, 'level', level, { project_id: PROJECT, level: '06M', floor_order: 8, numbering_group_id: group });
    panel = uuidv7();
    await remote(store, 'device', panel, { level_id: level, display_id: '06M-02', category: 'Power Distribution', device: 'CT06LCPB', panel_name: 'CT06LCPB' });
    ends['C-12'] = await end('C-12', 'X', 'DMX to equipment rack');
    ends['C-07'] = await end('C-07', 'X', 'DMX to Level 09');
    ends['C-08'] = await end('C-08', 'P', 'EBDK panic wire');
    punchId = uuidv7();
    await remote(store, 'punch_item', punchId, { level_id: level, number: 2, device_id: panel, item: 'Run 2x DMX cables to Lvl 9 & 6M Equipment Rack', type: 'Cable not run', owner: 'EC', tracking_status: 'Open' });
    itemId = uuidv7();
    await remote(store, 'review_item', itemId, {
      project_id: PROJECT,
      level_id: level,
      kind: 'lint',
      subject: { entity_kind: 'punch_item', entity_id: punchId, field: 'cable_end_id', level_id: level, lint_id: PUNCH_END_LINT, codes: ['X'] },
      candidates: [{ side: 'import', value: 'Run 2x DMX cables to Lvl 9 & 6M Equipment Rack' }],
      ruling: false,
      state: 'open',
    });
    editor = new Editor(store, { projectId: PROJECT, userId: ANN, now: tsNext });
  });

  it("Needs review lists it and offers the device's ends with its code, live", async () => {
    const list = await loadReviewList(store, PROJECT);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ kind: 'lint', levelCode: '06M', field: 'X item → which connection?' });
    const d = (await loadReviewDetail(store, itemId, new Map()))!;
    expect(d.punchDevice).toBeNull();
    expect(d.punchEnd).toMatchObject({ punchId, punch: 'Punch #2 Run 2x DMX cables to Lvl 9 & 6M Equipment Rack', levelCode: '06M', device: '06M-02 · CT06LCPB', codes: ['X'], linkedTo: null });
    expect(d.punchEnd!.ends.map((e) => [e.label, e.to])).toEqual([
      ['C-07', 'DMX to Level 09'],
      ['C-12', 'DMX to equipment rack'],
    ]); // the panic end is not offered
    await end(null, 'X', 'DMX to Level 07'); // added on the iPad since the import
    expect((await loadReviewDetail(store, itemId, new Map()))!.punchEnd!.ends.map((e) => e.label)).toEqual(['C-07', 'C-12', 'NEW']);
  });

  it('Put on closes the item and shows the end it went on; Keep leaves the item device-only', async () => {
    await setPunchEnd(editor, itemId, ends['C-07']!, { endLabel: 'C-07' });
    expect((await loadReviewList(store, PROJECT)).rows).toEqual([]);
    const d = (await loadReviewDetail(store, itemId, new Map()))!;
    expect(d.item.state).toBe('resolved');
    expect(d.punchEnd!.linkedTo).toBe(ends['C-07']);
    expect((await store.get<Record<string, unknown>>('punch_item', punchId))!.cable_end_id).toBe(ends['C-07']);
  });
});
