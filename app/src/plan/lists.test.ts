import { Store, uuidv7, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLevelPlan } from './data';
import { DEMO_LEVEL_ID, ensureDemoLevel } from './demo';
import { EMPTY_FILTER, matchesFilter } from './filters';
import { loadLevelLists, rowMatches, searchIds, type ListRow } from './lists';

const ME = uuidv7();
let ts = 1_760_000_000_000;

function op(entity_kind: Op['entity_kind'], entity_id: string, kind: Op['kind'], project_id: string, payload: Record<string, unknown>, extra: Partial<Op> = {}): Op {
  return {
    op_id: uuidv7(), project_id, user_id: ME, install_id: 'i', client_ts: new Date((ts += 1000)).toISOString(),
    change_type: 'Field survey', entity_kind, entity_id, kind, payload, ...extra,
  };
}

async function demo(search: 'like' | 'auto' = 'like') {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search });
  await ensureDemoLevel(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  return { store, plan, pid: plan.level.projectId };
}

async function load(store: Store, pid: string, includeDeleted = false) {
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID, { includeDeleted }))!;
  return { plan, lists: await loadLevelLists(store, pid, DEMO_LEVEL_ID, plan.level.code, plan.devices, { includeDeleted }) };
}

const keep = (rows: ListRow[], f: Parameters<typeof rowMatches>[1]) => rows.filter((r) => rowMatches(r, f));

describe('side lists', () => {
  it('lists punch items and parts of the level with their device and open state', async () => {
    const { store, pid } = await demo();
    const { plan, lists } = await load(store, pid);
    expect(lists.punch.length).toBeGreaterThanOrEqual(16);
    expect(lists.parts.length).toBeGreaterThan(0);
    const p = lists.punch[0]!;
    expect(p).toMatchObject({ tab: 'punch', title: expect.any(String) });
    expect(plan.devices.some((d) => d.id === p.deviceId)).toBe(true);
    expect(lists.punch.some((r) => !r.open)).toBe(true); // a Closed one
    // The open ones are exactly what the devices' ⚑ counts add up to.
    expect(lists.punch.filter((r) => r.open).length).toBe(plan.devices.reduce((n, d) => n + d.openPunch, 0));
  });

  it('shows NEW for unnumbered records and sorts them last', async () => {
    const { store, pid } = await demo();
    const dev = (await loadLevelPlan(store, DEMO_LEVEL_ID))!.devices[0]!;
    await store.apply(op('punch_item', uuidv7(), 'create', pid, { level_id: DEMO_LEVEL_ID, device_id: dev.id, item: 'Fresh item' }));
    const { lists } = await load(store, pid);
    const last = lists.punch.at(-1)!;
    expect(last).toMatchObject({ label: 'NEW', title: 'Fresh item' });
    expect(last.badges).toMatchObject({ isNew: true, pending: 1 });
    expect(lists.punch[0]!.badges.isNew).toBe(false);
  });

  it('carries ↑n, IN REVIEW, DRAFT and DELETED badges', async () => {
    const { store, plan, pid } = await demo();
    const [a, b, c, d] = plan.devices;
    // ↑2: two local pending ops on device a.
    await store.apply(op('device', a!.id, 'set', pid, {}, { field: 'status', was: a!.status, now: 'Complete' }));
    await store.apply(op('device', a!.id, 'set', pid, {}, { field: 'notes', was: null, now: 'x' }));
    // IN REVIEW: an open review item on device b.
    await store.apply(op('review_item', uuidv7(), 'create', pid, {
      project_id: pid, level_id: DEMO_LEVEL_ID, kind: 'sync_conflict', state: 'open',
      subject: { entity_kind: 'device', entity_id: b!.id, field: 'status' },
    }));
    // DRAFT: a proposed rule output about device c.
    await store.apply(op('proposal', uuidv7(), 'create', pid, {
      project_id: pid, rule_id: 'R3a', discriminator: 'x', kind: 'punch', state: 'proposed',
      subject: { entity_kind: 'device', entity_id: c!.id },
    }));
    // DELETED: device d.
    await store.apply(op('device', d!.id, 'delete', pid, {}, { reason: 'test' }));

    const live = await load(store, pid);
    expect(live.plan.devices.find((x) => x.id === d!.id)).toBeUndefined();
    const { plan: all, lists } = await load(store, pid, true);
    const badge = (id: string) => lists.deviceBadges.get(id)!;
    expect(badge(a!.id).pending).toBeGreaterThanOrEqual(2);
    expect(badge(b!.id).inReview).toBe(true);
    expect(badge(c!.id).draft).toBe(true);
    expect(badge(d!.id).deleted).toBe(true);
    expect(all.devices.find((x) => x.id === d!.id)).toMatchObject({ deleted: true, pin: null });
    expect(badge(plan.devices[5]!.id)).toMatchObject({ pending: 0, inReview: false, draft: false, deleted: false });
  });

  it('lists the cable ends on the level and applies the same filters', async () => {
    const { store, plan, pid } = await demo();
    const issue = plan.devices.find((d) => d.status === 'Issue')!;
    const done = plan.devices.find((d) => d.status === 'Complete')!;
    const cable = uuidv7();
    await store.apply(op('cable', cable, 'create', pid, { project_id: pid, cable: 'N' }));
    for (const [dev, status, to] of [[issue, 'Issue', '06M-04'], [done, 'Complete', 'Stations & Sensors']] as const) {
      await store.apply(op('cable_end', uuidv7(), 'create', pid, {
        cable_id: cable, side: dev === issue ? 'A' : 'B', level_id: DEMO_LEVEL_ID, device_id: dev.id, status, to_text: to,
      }));
    }
    const { lists } = await load(store, pid);
    expect(lists.connections).toHaveLength(2);
    expect(lists.connections.map((c) => c.title).sort()).toEqual(['N → 06M-04', 'N → Stations & Sensors']);
    expect(lists.connections[0]!.label).toBe('NEW');

    const issueOnly = keep(lists.connections, { ...EMPTY_FILTER, statuses: ['Issue'] });
    expect(issueOnly.map((c) => c.deviceId)).toEqual([issue.id]);
    const byCategory = keep(lists.connections, { ...EMPTY_FILTER, categories: [issue.category!] });
    expect(byCategory.every((c) => c.category === issue.category)).toBe(true);
  });

  it('filters punch and parts by their own owner and open state, like the devices', async () => {
    const { store, pid } = await demo();
    const { plan, lists } = await load(store, pid);
    const f = { ...EMPTY_FILTER, owners: ['ETC' as const], openPunch: true };
    const punch = keep(lists.punch, f);
    expect(punch.length).toBeGreaterThan(0);
    expect(punch.every((r) => r.open && (r.owner === 'ETC' || r.owner === 'EC/ETC'))).toBe(true);
    // Every device the punch tab points at passes the device filter too (same D99 rules).
    const devs = new Set(plan.devices.filter((d) => matchesFilter(d, f)).map((d) => d.id));
    expect(punch.every((r) => r.deviceId && devs.has(r.deviceId))).toBe(true);
    // Parts: Owner is EC in the demo, so ETC-only finds none, and EC finds the open ones.
    expect(keep(lists.parts, { ...EMPTY_FILTER, owners: ['ETC'] })).toHaveLength(0);
    expect(keep(lists.parts, { ...EMPTY_FILTER, owners: ['EC'] }).length).toBe(lists.parts.length);
  });

  for (const mode of ['like', 'auto'] as const) {
    it(`searches punch, parts, devices and connections (${mode})`, async () => {
      const { store, pid } = await demo(mode);
      const dev = (await loadLevelPlan(store, DEMO_LEVEL_ID))!.devices[0]!;
      await store.apply(op('punch_item', uuidv7(), 'create', pid, { level_id: DEMO_LEVEL_ID, device_id: dev.id, item: 'Zebrawood cover missing' }));
      const cable = uuidv7();
      await store.apply(op('cable', cable, 'create', pid, { project_id: pid, cable: 'NG' }));
      await store.apply(op('cable_end', uuidv7(), 'create', pid, { cable_id: cable, side: 'A', level_id: DEMO_LEVEL_ID, device_id: dev.id, to_text: 'Zebrawood rack' }));
      const { lists } = await load(store, pid);

      const ids = (await searchIds(store, DEMO_LEVEL_ID, 'zebrawood', lists.connections))!;
      expect(ids.size).toBe(2);
      expect(lists.punch.filter((p) => ids.has(p.id))).toHaveLength(1);
      expect(lists.connections.filter((c) => ids.has(c.id))).toHaveLength(1);
      expect(await searchIds(store, DEMO_LEVEL_ID, '   ', lists.connections)).toBeNull();
      const parts = (await searchIds(store, DEMO_LEVEL_ID, 'termination kit', lists.connections))!;
      expect(lists.parts.some((p) => parts.has(p.id))).toBe(true);
      expect((await searchIds(store, DEMO_LEVEL_ID, 'nothing-like-this', lists.connections))!.size).toBe(0);
    });
  }

  it('searches connections by cable type, matching the code exactly', async () => {
    const { store, plan, pid } = await demo();
    for (const code of ['N', 'NG', '0-10V']) {
      const cable = uuidv7();
      await store.apply(op('cable', cable, 'create', pid, { project_id: pid, cable: code }));
      await store.apply(op('cable_end', uuidv7(), 'create', pid, { cable_id: cable, side: 'A', level_id: DEMO_LEVEL_ID, device_id: plan.devices[0]!.id, to_text: 'Rack' }));
    }
    const { lists } = await load(store, pid);
    const conns = async (q: string) => {
      const ids = (await searchIds(store, DEMO_LEVEL_ID, q, lists.connections))!;
      return lists.connections.filter((c) => ids.has(c.id)).map((c) => c.cable).sort();
    };
    expect(await conns('n')).toEqual(['N']);
    expect(await conns('NG')).toEqual(['NG']);
    expect(await conns('0-10v')).toEqual(['0-10V']);
    expect(await conns('ng rack')).toEqual(['NG']);
  });

  it('searches connections by their C-nn number, exactly (D163)', async () => {
    const { store, plan, pid } = await demo();
    const mk = async (n: number | null, to: string) => {
      const cable = uuidv7();
      const id = uuidv7();
      await store.apply(op('cable', cable, 'create', pid, { project_id: pid, cable: 'N' }));
      await store.apply(op('cable_end', id, 'create', pid, { cable_id: cable, side: 'A', level_id: DEMO_LEVEL_ID, device_id: plan.devices[0]!.id, to_text: to }));
      if (n !== null) await store.db.exec('UPDATE cable_end SET display_id = ? WHERE id = ?', ['C-' + String(n).padStart(2, '0'), id]);
      return id;
    };
    const a = await mk(14, 'Rack 1');
    const b = await mk(140, 'Rack 2');
    const c = await mk(1, 'Room 14');
    const fresh = await mk(null, 'Rack 4');
    const { lists } = await load(store, pid);
    const found = async (q: string) => {
      const ids = (await searchIds(store, DEMO_LEVEL_ID, q, lists.connections))!;
      return lists.connections.filter((x) => ids.has(x.id)).map((x) => x.id).sort();
    };
    expect(lists.connections.find((x) => x.id === a)!.label).toBe('C-14');
    for (const q of ['C-14', 'c-14', 'c14', '14', 'C-014']) expect(await found(q)).toEqual([a]);
    expect(await found('c-140')).toEqual([b]);
    expect(await found('n c-14')).toEqual([a]);
    expect(await found('c-14 rack')).toEqual([a]);
    expect(await found('rack')).toEqual([a, b, fresh].sort());
    expect(c).toBeDefined();
  });

  it('names both ends of a connection, and a C-nn search returns the devices at both ends (D167)', async () => {
    const { store, plan, pid } = await demo();
    const [near, far, other] = plan.devices;
    // A device on another level (07), reached by a riser cable.
    const l07 = uuidv7();
    const remote = uuidv7();
    const group = (await store.db.query<{ g: string }>('SELECT numbering_group_id AS g FROM level WHERE id = ?', [DEMO_LEVEL_ID]))[0]!.g;
    await store.db.exec('INSERT INTO level (id, project_id, level, numbering_group_id) VALUES (?, ?, ?, ?)', [l07, pid, '07', group]);
    await store.apply(op('device', remote, 'create', pid, { level_id: l07, category: 'Equipment' }));
    await store.db.exec('UPDATE device SET display_id = ? WHERE id = ?', ['07-02', remote]);
    const ph = uuidv7();
    await store.apply(op('placeholder', ph, 'create', pid, { project_id: pid, label: 'Stations & Sensors', kind: 'station_bus' }));

    type End = { level: string; device?: string; placeholder?: string; num?: number };
    const mk = async (code: string, a: End, b: End | null) => {
      const cable = uuidv7();
      await store.apply(op('cable', cable, 'create', pid, { project_id: pid, cable: code }));
      const ids: string[] = [];
      for (const [side, e] of [['A', a], ['B', b]] as const) {
        if (!e) continue;
        const id = uuidv7();
        ids.push(id);
        await store.apply(op('cable_end', id, 'create', pid, {
          cable_id: cable, side, level_id: e.level,
          endpoint_kind: e.device ? 'device' : 'placeholder', device_id: e.device ?? null, placeholder_id: e.placeholder ?? null,
        }));
        if (e.num) await store.db.exec('UPDATE cable_end SET display_id = ? WHERE id = ?', [`C-${e.num}`, id]);
      }
      return ids;
    };
    const [local] = await mk('N', { level: DEMO_LEVEL_ID, device: near!.id, num: 14 }, { level: DEMO_LEVEL_ID, device: far!.id, num: 15 });
    const [riser] = await mk('X', { level: DEMO_LEVEL_ID, device: other!.id, num: 16 }, { level: l07, device: remote, num: 3 });
    const [bus] = await mk('U', { level: DEMO_LEVEL_ID, device: near!.id, num: 17 }, { level: DEMO_LEVEL_ID, placeholder: ph });
    const [lone] = await mk('P', { level: DEMO_LEVEL_ID, device: far!.id, num: 18 }, null);

    const { lists } = await load(store, pid);
    const row = (id: string | undefined) => lists.connections.find((c) => c.id === id)!;
    expect(row(local).sub).toBe(`${near!.label} ↔ ${far!.label} · Not started`);
    expect(row(local).farDeviceId).toBe(far!.id);
    expect(lists.connections.find((c) => c.label === 'C-15')!.sub).toBe(`${far!.label} ↔ ${near!.label} · Not started`);
    expect(row(riser).sub).toBe(`${other!.label} ↔ 07-02 · Not started`);
    expect(row(bus)).toMatchObject({ sub: `${near!.label} ↔ Stations & Sensors · Not started`, farDeviceId: null });
    expect(row(lone)).toMatchObject({ sub: `${far!.label} ↔ ? · Not started`, farDeviceId: null });

    const search = async (q: string) => (await searchIds(store, DEMO_LEVEL_ID, q, lists.connections))!;
    // C-14 → the row plus both end devices (they list on the Devices tab and show their pins).
    for (const q of ['C-14', 'c14', '14']) {
      const ids = await search(q);
      expect(ids.has(local!)).toBe(true);
      expect(ids.has(near!.id) && ids.has(far!.id)).toBe(true);
      expect(ids.has(other!.id)).toBe(false);
    }
    // The far end on another level is returned too; this level's lists simply do not hold it.
    const r = await search('c-16');
    expect([r.has(riser!), r.has(other!.id), r.has(remote)]).toEqual([true, true, true]);
    expect(plan.devices.filter((d) => r.has(d.id)).map((d) => d.id)).toEqual([other!.id]);
    // A placeholder end adds only the device end.
    const b = await search('C-17');
    expect(plan.devices.filter((d) => b.has(d.id)).map((d) => d.id)).toEqual([near!.id]);
    // A text search finds a connection by an end's name but does not pull in the end devices.
    const t = await search('07-02');
    expect(t.has(riser!)).toBe(true);
    expect(t.has(other!.id)).toBe(false);
    expect((await search('stations')).has(bus!)).toBe(true);
  });

  it('handles 2,000 rows per tab and search/filter over them quickly', async () => {
    const { store, plan, pid } = await demo();
    const devs = plan.devices;
    const owners = ['EC', 'ETC', 'EC/ETC'] as const;
    await store.db.transaction(async (tx) => {
      for (let i = 0; i < 2000; i++) {
        const dev = devs[i % devs.length]!;
        await tx.exec(
          `INSERT INTO punch_item (id, level_id, number, device_id, item, type, owner, tracking_status, sort_last, version) VALUES (?, ?, ?, ?, ?, 'Information', ?, ?, 0, 1)`,
          [uuidv7(), DEMO_LEVEL_ID, 1000 + i, dev.id, `Bulk item ${i}`, owners[i % 3], i % 5 === 0 ? 'Closed' : 'Open'],
        );
      }
    });
    const t0 = performance.now();
    const { lists } = await load(store, pid);
    const hits = (await searchIds(store, DEMO_LEVEL_ID, 'bulk 19', lists.connections))!;
    const rows = keep(lists.punch, { ...EMPTY_FILTER, owners: ['EC'], openPunch: true });
    const ms = performance.now() - t0;
    expect(lists.punch.length).toBeGreaterThanOrEqual(2000);
    expect(hits.size).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(500);
    expect(ms).toBeLessThan(3000);
  });
});
