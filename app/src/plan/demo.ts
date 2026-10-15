/**
 * Demo level for the plan view (T17): the 06M composite with ~45 devices, punch items, parts
 * and photos, written into a **separate** local database that no sync engine ever sees. It
 * exists so the plan view can be tried on the iPad before setup (T41/T45) puts real levels and
 * sheets there, and it is the TP-6 bench that replaced the T16 spike. Seeded as pulled
 * (`applied`, with `server_seq`) ops, so nothing waits in an outbox and IDs look assigned.
 * No React or Expo imports: the Node tests seed the same data.
 */

import { uuidv7, type Op, type Store } from '@field-survey/core';

import demoGrid from './demo-grid.json';
import { DEVICE_CATEGORIES } from './pins';

export const DEMO_LEVEL_ID = '0190a5f0-0000-7000-8000-00000000d06e';
const PROJECT = '0190a5f0-0000-7000-8000-00000000d000';
export const DEMO_SHEET_ID = '0190a5f0-0000-7000-8000-00000000d5ee';
const SHEET = DEMO_SHEET_ID;
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
    // The server's text pass over the fixture (T45): three grid sets, rooms and tags, so the
    // Grid panel and Drawing Position can be tried on the demo level; no boundaries (the demo
    // shows the original PDF, whose magenta is still baked in).
    grid_sets: demoGrid.grid_sets,
    features: { rooms: demoGrid.rooms, tags: demoGrid.tags, bubbles: [], boundaries: [], boundary_labels: [] },
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
 * DMX cable to 06M-03 (Issue "no term kit"), a 0-10V run to Fixtures (Issue "Not landed") and a
 * Unison run the server has not numbered (Not installed) — so every card section has something
 * to show on the iPad. The drafts and findings come from the real rules (T34): R3a on the Unison
 * run and the 0-10V landing, R3b for the DMX kit, R2c for the missing panic run, the ERP-FT-LVD
 * accessory finding and R1 on the panel's `Installed, untested`.
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
    { endpoint_kind: 'device', device_id: panel, to_text: 'Stations & Sensors', status: 'Not installed', note: 'Not run', status_source: 'surveyed' },
    { endpoint_kind: 'placeholder', placeholder_id: bus },
  );
  log(`card samples: ${ops.length} ops`);
  await store.applyRemoteMany(ops);
  await store.setState(CARD_SEEDED_KEY, true);
}

/** The demo's second level (T22): 07, whose sheet is "not downloaded" on purpose. */
export const DEMO_LEVEL_07_ID = '0190a5f0-0000-7000-8000-00000000d070';
const SHEET_07 = '0190a5f0-0000-7000-8000-00000000d57e';
const JUMP_SEEDED_KEY = 'demo_jump_seeded';

/**
 * End-editor samples (T22), seeded once and only from the demo route: riser labels on 06M-01's DMX
 * run (matches its To) and Unison run (differs), and a second level `07` with three devices and a
 * display sheet whose bytes are never on the iPad, joined to 06M-01 by an `N` cable — so "Jump to"
 * opens another level and that level shows "plan not downloaded" with the list and card working.
 */
export async function ensureDemoJumpExtras(store: Store, log: (msg: string) => void = () => {}): Promise<void> {
  if (await store.getState<boolean>(JUMP_SEEDED_KEY)) return;
  const panel = (await store.list<{ id: string }>('device', { where: 'level_id = ? AND display_id = ?', params: [DEMO_LEVEL_ID, '06M-01'] }))[0]?.id;
  if (!panel) return;
  const last = await store.db.query<{ n: number | null }>('SELECT max(server_seq) AS n FROM op');
  let seq = last[0]?.n ?? 0;
  const ts = '2026-10-10T13:00:00.000Z';
  const ops: Op[] = [];
  const base = () => ({ op_id: uuidv7(), project_id: PROJECT, user_id: USER, install_id: INSTALL, client_ts: ts, server_seq: ++seq, server_ts: ts, change_type: 'Master edit' as const, reason: 'Demo level (T22)', state: 'applied' as const });
  const create = (entity_kind: Op['entity_kind'], payload: Record<string, unknown>, entity_id = uuidv7()) => {
    ops.push({ ...base(), entity_kind, entity_id, kind: 'create', payload });
    return entity_id;
  };
  // riser labels on the T20 cables of 06M-01
  const cables = await store.db.query<{ id: string; cable: string }>(
    `SELECT c.id, c.cable FROM cable c JOIN cable_end e ON e.cable_id = c.id WHERE e.device_id = ? AND e.side = 'A'`,
    [panel],
  );
  const riser: Record<string, string> = { X: 'DMX TO 06M-03', U: 'UNISON TO 06M STATIONS' };
  for (const c of cables) {
    if (riser[c.cable]) ops.push({ ...base(), entity_kind: 'cable', entity_id: c.id, kind: 'set', field: 'riser_to_label', now: riser[c.cable] });
  }
  // level 07
  create('level', { project_id: PROJECT, level: '07', floor_order: 8, numbering_group_id: GROUP, in_scope: true, state: 'baseline_locked', display_sheet_id: SHEET_07 }, DEMO_LEVEL_07_ID);
  create('sheet', { level_id: DEMO_LEVEL_07_ID, kind: 'display', page: 1, title: 'Level 07 – Lighting Composite', blob: 'f'.repeat(64), width_pt: DEMO_SHEET_SIZE.width, height_pt: DEMO_SHEET_SIZE.height }, SHEET_07);
  const rack = create('device', { level_id: DEMO_LEVEL_07_ID, display_id: '07-01', category: 'Equipment rack', device: 'Equipment rack', room_location: 'XX07-1E05 Elec Rm', status: 'Installed, untested', pin: { sheet: SHEET_07, x: 1200, y: 900 } });
  create('device', { level_id: DEMO_LEVEL_07_ID, display_id: '07-02', category: 'Relay panel', device: 'CT07LCPA', room_location: 'XX07-1E05 Elec Rm', status: 'Issue', pin: { sheet: SHEET_07, x: 1300, y: 900 } });
  create('device', { level_id: DEMO_LEVEL_07_ID, display_id: '07-S1', category: 'Station', device: 'PI1002', room_location: 'XX07-210', pin: { sheet: SHEET_07, x: 2000, y: 1500 } });
  const cable = uuidv7();
  const endA = uuidv7();
  const endB = uuidv7();
  create('cable', { project_id: PROJECT, cable: 'N', qty: 1, origin: 'riser', end_a_id: endA, end_b_id: endB, riser_to_label: 'NETWORK TO LEVEL 07 RACK', vertical: 'V1' }, cable);
  create('cable_end', { cable_id: cable, side: 'A', endpoint_kind: 'device', device_id: panel, level_id: DEMO_LEVEL_ID, display_id: 'C-11', to_text: 'Network to Level 07 rack', status: 'Installed, untested', status_source: 'surveyed' }, endA);
  create('cable_end', { cable_id: cable, side: 'B', endpoint_kind: 'device', device_id: rack, level_id: DEMO_LEVEL_07_ID, display_id: 'C-01', from_text: 'Network from Level 06M 06M-01' }, endB);
  log(`jump samples: ${ops.length} ops`);
  await store.applyRemoteMany(ops);
  await store.setState(JUMP_SEEDED_KEY, true);
}

const LIBRARY_SEEDED_KEY = 'demo_library_seeded';

/**
 * A small device-type library on the demo (T23) so "+ Device" has types to pick: two project
 * types (a station and a sensor, both `level_tag`) and one app-library type (`project_id` null, D65).
 * Models are the master's own (CLAUDE.md §3 phrases).
 */
export async function ensureDemoLibrary(store: Store, log: (msg: string) => void = () => {}): Promise<void> {
  if (await store.getState<boolean>(LIBRARY_SEEDED_KEY)) return;
  const last = await store.db.query<{ n: number | null }>('SELECT max(server_seq) AS n FROM op');
  let seq = last[0]?.n ?? 0;
  const ts = '2026-10-10T13:30:00.000Z';
  const ops: Op[] = [
    { model: 'PI1002', category: 'Station', id_scheme: 'level_tag', project_id: PROJECT },
    { model: 'UHCI-WM', category: 'Sensor', id_scheme: 'level_tag', project_id: PROJECT },
    { model: 'P-NSPS-D', category: 'NSPS', id_scheme: 'level_number', project_id: null },
  ].map((payload) => ({
    op_id: uuidv7(), project_id: PROJECT, user_id: USER, install_id: INSTALL, client_ts: ts, server_seq: ++seq, server_ts: ts,
    entity_kind: 'library_type', entity_id: uuidv7(), kind: 'create', payload: { ...payload, state: 'accepted' },
    change_type: 'Master edit', reason: 'Demo level (T23)', state: 'applied',
  }));
  log(`library samples: ${ops.length} ops`);
  await store.applyRemoteMany(ops);
  await store.setState(LIBRARY_SEEDED_KEY, true);
}
