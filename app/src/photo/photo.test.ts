import { BlobQueue, Editor, Store, emptyStrokeList, makeStroke, uuidv7, type BlobFiles, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { arrowHead, containTransform, ellipseRect, penSegments } from '../ink/geometry';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, ensureDemoCardExtras, ensureDemoLevel } from '../plan/demo';
import { loadCableEnds } from '../ends/model';
import { NEARBY_PT, linkOptions, photoStrip, toggleLink } from './links';
import { createPhoto, loadPhoto, newPhotoFields, thumbSize, toHex, updatePhoto } from './model';

const ME = uuidv7();
const sha = (n: number) => n.toString(16).padStart(64, '0');

/** Paths only: the queue's bookkeeping, no bytes (nothing uploads in these tests). */
const files: BlobFiles = {
  pathFor: (s, kind) => `blobs/${s}.${kind === 'markup' || kind === 'ink' ? 'json' : 'jpg'}`,
  exists: async () => true,
  remove: async () => {},
};

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  await ensureDemoCardExtras(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  let clock = 1_760_200_000_000;
  const editor = new Editor(store, { projectId: plan.level.projectId, userId: ME, now: () => new Date((clock += 1000)).toISOString() });
  const dev = plan.devices.find((d) => d.label === '06M-01')!;
  const queue = new BlobQueue(store, null, files, { userId: () => null, log: () => {} });
  return { store, plan, editor, dev, queue };
}

describe('photo capture model (T21)', () => {
  it('sizes thumbnails to 320 px on the long side without upscaling', () => {
    expect(thumbSize(4032, 3024)).toEqual({ width: 320, height: 240 });
    expect(thumbSize(3024, 4032)).toEqual({ width: 240, height: 320 });
    expect(thumbSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('creates one photo op linked to the device, waiting until its bytes reach the server', async () => {
    const { store, plan, editor, dev, queue } = await setup();
    const target = { projectId: plan.level.projectId, levelId: DEMO_LEVEL_ID, deviceId: dev.id };
    const fields = await newPhotoFields(store, target);
    expect(fields.location).toBe(dev.room); // Location defaults to the device's Room / Location
    for (const [s, kind] of [[sha(1), 'image'], [sha(2), 'thumb'], [sha(3), 'markup']] as const) {
      await queue.addLocal({ sha256: s, kind, path: files.pathFor(s, kind), size: 10, mime: kind === 'markup' ? 'application/json' : 'image/jpeg' });
    }
    const { id, op } = await createPhoto(editor, {
      target,
      fields: { ...fields, subject: ' ERP interior ', whatItShows: 'Missing LVD card' },
      image: { sha256: sha(1), size: 10 },
      thumb: { sha256: sha(2), size: 10 },
      markupSha: sha(3),
      takenAt: '2026-10-10T12:00:00.000Z',
    });
    expect(op).toMatchObject({ kind: 'create', entity_kind: 'photo', change_type: 'Field survey', reason: 'Field survey' });
    expect(op.payload).toMatchObject({
      level_id: DEMO_LEVEL_ID,
      device_id: dev.id,
      subject: 'ERP interior',
      what_it_shows: 'Missing LVD card',
      image_blob: sha(1),
      thumb_blob: sha(2),
      markup_blob: sha(3),
      taken_by_id: ME,
    });
    expect(op.payload).not.toHaveProperty('punch_item_id'); // links go to photo_link (D128)
    expect(op.payload).not.toHaveProperty('number'); // numbered by the server (NEW until then)
    const card = (await loadDeviceCard(store, dev.id))!;
    const mine = card.photos.find((p) => p.id === id)!;
    expect(mine).toMatchObject({ label: 'NEW', waiting: true, markup: sha(3), thumb: sha(2) });
    expect(card.photosWaiting).toBeGreaterThanOrEqual(1);
    expect(await queue.photosWaiting()).toBeGreaterThanOrEqual(1);
    const ops: Op[] = await store.opsFor(id);
    expect(ops).toHaveLength(1);
  });

  it('offers its ends, nearby devices nearest first with their ends, then its punch items (D128)', async () => {
    const { store, plan, editor, dev } = await setup();
    const sheet = plan.sheet!.id;
    const others = plan.devices.filter((d) => d.id !== dev.id);
    // 06M-01 at (1000, 1000); one device 40 pt away, one 100 pt away, one far; the rest off the sheet
    const place = (id: string, x: number, y: number | null) =>
      editor.setField('device', id, 'pin', y === null ? null : { sheet, x, y }, { change_type: 'Correction', reason: 'test' });
    await place(dev.id, 1000, 1000);
    const [near, mid, far] = others;
    await place(near!.id, 1040, 1000);
    await place(mid!.id, 1000, 1100);
    await place(far!.id, 1000, 1000 + NEARBY_PT + 1);
    for (const o of others.slice(3)) await place(o.id, 0, null);

    const opts = await linkOptions(store, dev.id);
    const kinds = opts.map((o) => o.kind);
    expect(kinds[0]).toBe('cable_end'); // its own ends first
    const devices = opts.filter((o) => o.kind === 'device');
    expect(devices.map((d) => d.id)).toEqual([near!.id, mid!.id]); // nearest first, far one left out
    expect(devices.map((d) => Math.round(d.distance!))).toEqual([40, 100]);
    expect(kinds.lastIndexOf('punch')).toBe(kinds.length - 1); // punch items last
    expect(kinds.indexOf('punch')).toBeGreaterThan(kinds.lastIndexOf('device'));
    expect(await linkOptions(store, null)).toEqual([]);
    // a far device already linked stays listed so it can be unlinked
    const kept = await linkOptions(store, dev.id, [{ kind: 'device', id: far!.id }]);
    expect(kept[kept.length - 1]).toMatchObject({ kind: 'device', id: far!.id, distance: null });
  });

  it('links one photo to several devices and ends; every linked card and end shows it, links edited in one group', async () => {
    const { store, plan, editor, dev } = await setup();
    const card0 = (await loadDeviceCard(store, dev.id))!;
    const conn = card0.connections[0]!;
    const other = plan.devices.find((d) => d.id !== dev.id)!;
    const target = { projectId: plan.level.projectId, levelId: DEMO_LEVEL_ID, deviceId: dev.id, cableEndId: conn.id };
    const fields = await newPhotoFields(store, target);
    expect(fields.links).toEqual([{ kind: 'cable_end', id: conn.id }]); // 📷 from the end editor preselects the end (T21-5)
    const made = await createPhoto(editor, {
      target,
      fields: { ...fields, links: toggleLink(fields.links, { kind: 'device', id: other.id }) },
      image: { sha256: sha(11), size: 1 },
      thumb: { sha256: sha(12), size: 1 },
      markupSha: null,
      takenAt: '2026-10-10T12:00:00.000Z',
    });
    expect(made.links.map((o) => o.payload)).toEqual([
      { target_kind: 'cable_end', target_id: conn.id },
      { target_kind: 'device', target_id: other.id },
    ]);
    expect(new Set([made.op.group_id, ...made.links.map((o) => o.group_id)]).size).toBe(1);

    // the photo's device, the linked device and the linked end all show it; the strip does not
    // list the other links under the thumbnail (D134), the caption sheet's picker does
    const own = (await loadDeviceCard(store, dev.id))!.photos.find((p) => p.id === made.id)!;
    expect(own).toBeDefined();
    expect(own).not.toHaveProperty('links');
    const linked = (await loadDeviceCard(store, other.id))!.photos.find((p) => p.id === made.id)!;
    expect(linked).toMatchObject({ id: made.id, label: 'NEW' });
    const ends = (await loadCableEnds(store, conn.id))!;
    expect(ends.ends[0].photos.map((p) => p.id)).toContain(made.id);
    expect((await loadPhoto(store, made.id))!.fields.links).toEqual([
      { kind: 'cable_end', id: conn.id },
      { kind: 'device', id: other.id },
    ]);

    // unlink the device, keep the end, change the caption: one group of set + link_remove
    const before = (await loadPhoto(store, made.id))!;
    const ops = await updatePhoto(editor, store, made.id, { ...before.fields, whatItShows: 'Wire nuts', links: [{ kind: 'cable_end', id: conn.id }] }, sha(13));
    expect(ops.map((o) => o.kind + ':' + (o.field ?? (o.payload as { target_kind: string }).target_kind)).sort()).toEqual([
      'link_remove:device',
      'set:markup_blob',
      'set:what_it_shows',
    ]);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect((await photoStrip(store, { kind: 'device', id: other.id })).map((p) => p.id)).not.toContain(made.id);
    const after = (await loadPhoto(store, made.id))!;
    expect(after).toMatchObject({ markup: sha(13), fields: { whatItShows: 'Wire nuts', links: [{ kind: 'cable_end', id: conn.id }] } });
    // unchanged → nothing written
    expect(await updatePhoto(editor, store, made.id, after.fields, sha(13))).toEqual([]);
  });

  it('reads the legacy punch_item_id / cable_end_id as links and clears the column when unticked', async () => {
    const { store, plan, editor, dev } = await setup();
    const conn = (await loadDeviceCard(store, dev.id))!.connections[0]!;
    const { id } = await editor.create(
      'photo',
      { level_id: DEMO_LEVEL_ID, device_id: dev.id, cable_end_id: conn.id, thumb_blob: sha(21), seed_thumbnail_only: true },
      { change_type: 'Field survey', reason: 'Field survey' },
    );
    expect(plan.level.id).toBe(DEMO_LEVEL_ID);
    expect((await photoStrip(store, { kind: 'cable_end', id: conn.id })).map((p) => p.id)).toContain(id);
    const p = (await loadPhoto(store, id))!;
    expect(p.fields.links).toEqual([{ kind: 'cable_end', id: conn.id }]);
    const ops = await updatePhoto(editor, store, id, { ...p.fields, links: [] }, null);
    expect(ops.map((o) => [o.kind, o.field, o.now])).toEqual([['set', 'cable_end_id', null]]);
    expect((await photoStrip(store, { kind: 'cable_end', id: conn.id })).map((p) => p.id)).not.toContain(id);
  });
});

describe('stroke geometry', () => {
  const at = '2026-10-10T12:00:00.000Z';
  it('widens pen segments with pressure and draws arrow heads and ellipses from two points', () => {
    const pen = makeStroke({ id: 'p', tool: 'pen', color: '#111111', width: 10, points: [{ x: 0, y: 0, p: 0 }, { x: 10, y: 0, p: 1 }, { x: 20, y: 0, p: 1 }], at });
    expect(penSegments(pen).map((g) => Math.round(g.width))).toEqual([10, 16]);
    const arrow = makeStroke({ id: 'a', tool: 'arrow', color: '#111111', width: 2, points: [{ x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }], at });
    const h = arrowHead(arrow);
    expect(h.tip).toEqual({ x: 100, y: 0 });
    expect(h.left.x).toBeLessThan(100);
    expect(Math.sign(h.left.y)).toBe(-Math.sign(h.right.y));
    const oval = makeStroke({ id: 'e', tool: 'ellipse', color: '#111111', width: 2, points: [{ x: 50, y: 40, p: 0.5 }, { x: 10, y: 80, p: 0.5 }], at });
    expect(ellipseRect(oval)).toEqual({ x: 10, y: 40, width: 40, height: 40 });
  });

  it('letterboxes a surface into a view', () => {
    const list = emptyStrokeList('image', 4000, 3000);
    expect(containTransform(list, { width: 800, height: 800 })).toEqual({ scale: 0.2, ox: 0, oy: 100 });
  });
});
