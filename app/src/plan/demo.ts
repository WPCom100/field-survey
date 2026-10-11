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

export function demoOps(dense = 0): Op[] {
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

  if (dense > 0) {
    // A busy floor: 60 % of the pins in 14 tight rooms, 20 % along corridors, the rest scattered.
    const rooms = Array.from({ length: 14 }, () => ({ x: W * (0.06 + 0.88 * rand()), y: H * (0.06 + 0.88 * rand()) }));
    for (let i = 0; i < dense; i++) {
      const k = i % 5;
      const category = k === 3 ? 'Station' : k === 4 && i % 10 === 4 ? 'Sensor' : DEVICE_CATEGORIES[i % 6]!;
      if (k < 3) {
        const r = rooms[i % rooms.length]!;
        device(category, r.x + (rand() - 0.5) * 150, r.y + (rand() - 0.5) * 150);
      } else if (k === 3) {
        device(category, W * (0.05 + 0.9 * (i / dense)), H * (0.2 + 0.6 * ((i * 7) % 5) / 5) + (rand() - 0.5) * 24);
      } else {
        device(category, W * (0.04 + 0.92 * rand()), H * (0.04 + 0.92 * rand()));
      }
    }
    device('Touchscreen', null, null);
    return ops;
  }

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
export async function ensureDemoLevel(
  store: Store,
  log: (msg: string) => void = () => {},
  dense = 0,
): Promise<string> {
  if (!(await store.getState<boolean>(SEEDED_KEY))) {
    const ops = demoOps(dense);
    log(`seeding ${ops.length} ops`);
    await store.applyRemoteMany(ops);
    await store.setState(SEEDED_KEY, true);
    log('seeded');
  }
  return DEMO_LEVEL_ID;
}

const CARD_SEEDED_KEY = 'demo_card_seeded';

/**
 * Device-card samples on the demo level (T20), seeded once and only from the demo route (the
 * side-list tests count the base seed's connections): on 06M-01 two accessories (one short), a
 * DMX cable to 06M-03, a 0-10V run to Fixtures, a Unison run the server has not numbered, two
 * rule drafts and a finding — so every card section has something to show on the iPad.
 */
export async function ensureDemoCardExtras(store: Store, log: (msg: string) => void = () => {}): Promise<void> {
  if (await store.getState<boolean>(CARD_SEEDED_KEY)) return;
  const idOf = async (displayId: string) =>
    (await store.list<{ id: string }>('device', { where: 'level_id = ? AND display_id = ?', params: [DEMO_LEVEL_ID, displayId] }))[0]?.id;
  const panel = await idOf('06M-01');
  const far = await idOf('06M-03');
  if (!panel || !far) return; // the dense variant has other devices; nothing to add there
  const last = await store.db.query<{ n: number | null }>('SELECT max(server_seq) AS n FROM op');
  let seq = last[0]?.n ?? 0;
  const ts = '2026-10-10T12:30:00.000Z';
  const ops: Op[] = [];
  const create = (entity_kind: Op['entity_kind'], payload: Record<string, unknown>, entity_id = uuidv7()) => {
    ops.push({
      op_id: uuidv7(), project_id: PROJECT, user_id: USER, install_id: INSTALL, client_ts: ts, server_seq: ++seq, server_ts: ts,
      entity_kind, entity_id, kind: 'create', payload, change_type: 'Master edit', reason: 'Demo level (T20)', state: 'applied',
    });
    return entity_id;
  };
  const cable = (code: string, a: Record<string, unknown>, b: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const id = uuidv7();
    const endA = uuidv7();
    const endB = uuidv7();
    create('cable', { project_id: PROJECT, cable: code, qty: 1, origin: 'riser', end_a_id: endA, end_b_id: endB, ...extra }, id);
    create('cable_end', { cable_id: id, side: 'A', level_id: DEMO_LEVEL_ID, ...a }, endA);
    create('cable_end', { cable_id: id, side: 'B', ...b }, endB);
  };

  create('accessory', { device_id: panel, model: 'ERP-FT-LVD', expected_qty: 2, found_qty: 1 });
  create('accessory', { device_id: panel, model: 'ERP-RTO', expected_qty: 1, found_qty: 1 });
  const fixtures = create('placeholder', { project_id: PROJECT, label: 'Fixtures', kind: 'fixtures' });
  const bus = create('placeholder', { project_id: PROJECT, label: 'Stations & Sensors', kind: 'station_bus' });
  cable(
    'X',
    { endpoint_kind: 'device', device_id: panel, display_id: 'C-03', to_text: 'DMX to 06M-03', status: 'Issue', note: 'Run, not terminated; no term kit', status_source: 'surveyed' },
    { endpoint_kind: 'device', device_id: far, level_id: DEMO_LEVEL_ID, display_id: 'C-04', from_text: 'DMX from 06M-01' },
  );
  cable(
    '0-10V',
    { endpoint_kind: 'device', device_id: panel, display_id: 'C-08', to_text: 'Fixtures', status: 'Issue', note: 'Not landed', status_source: 'surveyed' },
    { endpoint_kind: 'placeholder', placeholder_id: fixtures },
    { single_row: true },
  );
  cable(
    'U',
    { endpoint_kind: 'device', device_id: panel, to_text: 'Stations & Sensors', status: 'Not installed', note: 'Not run' },
    { endpoint_kind: 'placeholder', placeholder_id: bus },
  );
  const subject = { entity: 'device', entity_id: panel };
  create('proposal', {
    project_id: PROJECT, rule_id: 'R3a', kind: 'punch', subject, discriminator: 'U run', inputs_hash: 'demo',
    payload: { item: 'Run Unison to Stations & Sensors', type: 'Cable not run', owner: 'EC', tracking_status: 'Open', why: 'The U end is Not installed (R3a: one "Run …" item per unpulled wire).' },
  });
  create('proposal', {
    project_id: PROJECT, rule_id: 'R4b', kind: 'part', subject, discriminator: 'X kit', inputs_hash: 'demo',
    payload: { part: 'DMX termination kit - 06M-03 run', owner: 'EC', part_status: 'Needed', why: 'C-03 is Issue "no term kit" (R3b/R4b: one kit per run).' },
  });
  create('finding', {
    project_id: PROJECT, level_id: DEMO_LEVEL_ID, lint_id: 'R1', subject,
    message: 'Installed, untested with outstanding wiring → Issue (suggested)',
  });
  log(`card samples: ${ops.length} ops`);
  await store.applyRemoteMany(ops);
  await store.setState(CARD_SEEDED_KEY, true);
}
