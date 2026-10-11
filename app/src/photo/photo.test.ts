import { BlobQueue, Editor, Store, emptyStrokeList, makeStroke, uuidv7, type BlobFiles, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { arrowHead, containTransform, ellipseRect, penSegments } from '../ink/geometry';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, ensureDemoCardExtras, ensureDemoLevel } from '../plan/demo';
import { createPhoto, loadPhoto, newPhotoFields, photoLinks, thumbSize, toHex, updatePhoto } from './model';

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
      punch_item_id: null,
      cable_end_id: null,
    });
    expect(op.payload).not.toHaveProperty('number'); // numbered by the server (NEW until then)
    const card = (await loadDeviceCard(store, dev.id))!;
    const mine = card.photos.find((p) => p.id === id)!;
    expect(mine).toMatchObject({ label: 'NEW', waiting: true, markup: sha(3), thumb: sha(2) });
    expect(card.photosWaiting).toBeGreaterThanOrEqual(1);
    expect(await queue.photosWaiting()).toBeGreaterThanOrEqual(1);
    const ops: Op[] = await store.opsFor(id);
    expect(ops).toHaveLength(1);
  });

  it('offers the device punch items and connection ends as links and edits caption, link and markup in one group', async () => {
    const { store, plan, editor, dev } = await setup();
    const links = await photoLinks(store, dev.id);
    expect(links.some((l) => l.kind === 'punch')).toBe(true);
    expect(links.some((l) => l.kind === 'end' && l.label.startsWith('C-'))).toBe(true);
    expect(await photoLinks(store, null)).toEqual([]);

    const target = { projectId: plan.level.projectId, levelId: DEMO_LEVEL_ID, deviceId: dev.id };
    const { id } = await createPhoto(editor, {
      target,
      fields: await newPhotoFields(store, target),
      image: { sha256: sha(11), size: 1 },
      thumb: { sha256: sha(12), size: 1 },
      markupSha: null,
      takenAt: '2026-10-10T12:00:00.000Z',
    });
    const end = links.find((l) => l.kind === 'end')!;
    const before = (await loadPhoto(store, id))!;
    expect(before).toMatchObject({ label: 'NEW', isNew: true, markup: null, deviceId: dev.id });
    const ops = await updatePhoto(editor, id, { ...before.fields, whatItShows: 'Wire nuts', cableEndId: end.id }, sha(13));
    expect(ops.map((o) => o.field).sort()).toEqual(['cable_end_id', 'markup_blob', 'what_it_shows']);
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    const after = (await loadPhoto(store, id))!;
    expect(after).toMatchObject({ markup: sha(13), fields: { whatItShows: 'Wire nuts', cableEndId: end.id } });
    // unchanged → nothing written
    expect(await updatePhoto(editor, id, after.fields, sha(13))).toEqual([]);
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
