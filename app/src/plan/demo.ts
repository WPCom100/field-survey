/**
 * Demo level for the plan view (T17): the 06M composite with ~45 devices, punch items, parts
 * and photos, written into a **separate** local database that no sync engine ever sees. It
 * exists so the plan view can be tried on the iPad before setup (T41/T45) puts real levels and
 * sheets there, and it is the TP-6 bench that replaced the T16 spike. Seeded as pulled
 * (`applied`, with `server_seq`) ops, so nothing waits in an outbox and IDs look assigned.
 * No React or Expo imports: the Node tests seed the same data.
 */

import { uuidv7, type Op, type Store } from '@field-survey/core';

import { DEVICE_CATEGORIES } from './pins';

export const DEMO_LEVEL_ID = '0190a5f0-0000-7000-8000-00000000d06e';
const PROJECT = '0190a5f0-0000-7000-8000-00000000d000';
const SHEET = '0190a5f0-0000-7000-8000-00000000d5ee';
/** Numbering groups are server rows (no create op); the level only needs to point at one. */
const GROUP = '0190a5f0-0000-7000-8000-00000000d6a0';
const USER = '0190a5f0-0000-7000-8000-00000000d0e5';
const INSTALL = '0190a5f0-0000-7000-8000-00000000d1d1';

/** The 06M composite's CropBox (fixtures/Level_06M_-_Lighting_Composite_vector.pdf). */
export const DEMO_SHEET_SIZE = { width: 4235.48, height: 3604.72 };

const SEEDED_KEY = 'demo_seeded';
const STATUSES = ['Installed, untested', 'Issue', 'Not installed', 'No access', 'Complete', null] as const;
const OWNERS = ['EC', 'ETC', 'EC/ETC'] as const;

/** Deterministic PRNG so every iPad seeds the same plan. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoOps(): Op[] {
  const ops: Op[] = [];
  let seq = 0;
  const ts = '2026-10-10T12:00:00.000Z';
  const create = (entity_kind: Op['entity_kind'], entity_id: string, payload: Record<string, unknown>) =>
    ops.push({
      op_id: uuidv7(),
      project_id: PROJECT,
      user_id: USER,
      install_id: INSTALL,
      client_ts: ts,
      server_seq: ++seq,
      server_ts: ts,
      entity_kind,
      entity_id,
      kind: 'create',
      payload,
      change_type: 'Master edit',
      reason: 'Demo level (T17)',
      state: 'applied',
    });

  create('project', PROJECT, { name: 'Demo (plan view)' });
  create('level', DEMO_LEVEL_ID, {
    project_id: PROJECT,
    level: '06M',
    floor_order: 7,
    numbering_group_id: GROUP,
    in_scope: true,
    state: 'baseline_locked',
    display_sheet_id: SHEET,
  });
  create('sheet', SHEET, {
    level_id: DEMO_LEVEL_ID,
    kind: 'display',
    page: 1,
    title: 'Level 06M – Lighting Composite',
    width_pt: DEMO_SHEET_SIZE.width,
    height_pt: DEMO_SHEET_SIZE.height,
  });

  const rand = mulberry32(17);
  const { width: W, height: H } = DEMO_SHEET_SIZE;
  const counters = { panel: 0, station: 0, sensor: 0 };
  let n = 0;
  const device = (category: string, x: number | null, y: number | null, extra: Record<string, unknown> = {}) => {
    const i = n++;
    let displayId: string | null;
    if (category === 'Station') displayId = `06M-S${++counters.station}`;
    else if (category === 'Sensor') displayId = `06M-D${++counters.sensor}`;
    else displayId = `06M-${String(++counters.panel).padStart(2, '0')}`;
    const id = uuidv7();
    create('device', id, {
      level_id: DEMO_LEVEL_ID,
      display_id: displayId,
      category,
      device: category === 'Station' ? 'PI1002' : category === 'Sensor' ? 'UHCI-WM' : category,
      room_location: `XX06M-1E${String(10 + (i % 40)).padStart(2, '0')}`,
      status: STATUSES[i % STATUSES.length],
      pin: x === null || y === null ? null : { sheet: SHEET, x: Math.round(x), y: Math.round(y) },
      origin: i % 11 === 5 ? 'field_addition' : 'baseline',
      ...extra,
    });
    if (i % 3 === 0) {
      create('punch_item', uuidv7(), {
        level_id: DEMO_LEVEL_ID, number: i + 1, device_id: id, item: 'Run, not terminated',
        type: 'Termination', owner: OWNERS[(i / 3) % 3], tracking_status: 'Open',
      });
    }
    if (i % 8 === 4) {
      create('punch_item', uuidv7(), {
        level_id: DEMO_LEVEL_ID, number: 100 + i, device_id: id, item: 'Not run',
        type: 'Cable not run', owner: 'EC', tracking_status: 'Closed', date_closed: '2026-10-09',
      });
    }
    if (i % 4 === 1) {
      create('missing_part', uuidv7(), {
        level_id: DEMO_LEVEL_ID, number: i + 1, device_id: id, part: 'DMX termination kit',
        qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered',
      });
    }
    for (let k = 0; k < (i % 6 === 2 ? 1 + (i % 3) : 0); k++) {
      create('photo', uuidv7(), { level_id: DEMO_LEVEL_ID, number: 200 + i * 3 + k, device_id: id, subject: 'Panel interior' });
    }
    return id;
  };

  // Spread over the sheet, cycling the eight categories.
  for (let i = 0; i < 36; i++) {
    device(DEVICE_CATEGORIES[i % DEVICE_CATEGORIES.length]!, W * (0.06 + 0.88 * rand()), H * (0.06 + 0.88 * rand()));
  }
  // An electrical room: six devices within a few feet, to show clustering.
  const room = { x: W * 0.42, y: H * 0.38 };
  ['Relay panel', 'Relay panel', 'EBDK', 'Equipment rack', 'NSPS', 'Foundry panel'].forEach((c, k) =>
    device(c, room.x + (k % 3) * 22, room.y + Math.floor(k / 3) * 26),
  );
  // A corridor of stations close enough to cluster at fit.
  for (let k = 0; k < 4; k++) device('Station', W * 0.7 + k * 30, H * 0.8);
  // One field addition the server has not numbered yet, and one device not placed.
  const fresh = uuidv7();
  create('device', fresh, {
    level_id: DEMO_LEVEL_ID, category: 'Relay panel', device: 'Relay panel', status: 'Issue',
    pin: { sheet: SHEET, x: Math.round(W * 0.3), y: Math.round(H * 0.62) }, origin: 'field_addition',
  });
  device('Touchscreen', null, null);
  return ops;
}

/** Seed the demo level once per demo database; returns its level id. */
export async function ensureDemoLevel(store: Store): Promise<string> {
  if (!(await store.getState<boolean>(SEEDED_KEY))) {
    await store.applyRemoteMany(demoOps());
    await store.setState(SEEDED_KEY, true);
  }
  return DEMO_LEVEL_ID;
}
