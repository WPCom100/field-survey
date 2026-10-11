import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadDeviceCard } from '../card/model';
import { loadLevelPlan } from '../plan/data';
import { DEMO_LEVEL_ID, DEMO_SHEET_ID, ensureDemoLevel, ensureDemoLibrary } from '../plan/demo';
import { addFieldDevice, libraryChoices, matchModel, schemeFor } from './model';

const ME = uuidv7();

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  await ensureDemoLevel(store);
  await ensureDemoLibrary(store);
  const plan = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
  let clock = 1_760_400_000_000;
  const editor = new Editor(store, { projectId: plan.level.projectId, userId: ME, now: () => new Date((clock += 1000)).toISOString() });
  const base = { projectId: plan.level.projectId, levelId: DEMO_LEVEL_ID, sheetId: DEMO_SHEET_ID, at: { x: 1234.56, y: 987.04 } };
  return { store, editor, plan, base };
}

describe('field additions (T23)', () => {
  it('lists project and app-library types, project first, and matches typed models by model or alias', async () => {
    const { store, plan } = await setup();
    const all = await libraryChoices(store, plan.level.projectId);
    expect(all.map((c) => [c.model, c.projectId ? 'project' : 'app'])).toEqual([
      ['PI1002', 'project'],
      ['UHCI-WM', 'project'],
      ['P-NSPS-D', 'app'],
    ]);
    expect((await libraryChoices(store, plan.level.projectId, 'Sensor')).map((c) => c.model)).toEqual(['UHCI-WM']);
    expect(matchModel(all, ' uhci-wm ')?.model).toBe('UHCI-WM');
    expect(matchModel(all, 'p nsps d')).toBeNull(); // spaces ignored, hyphens are not
    expect(matchModel(all, 'PNSPS')).toBeNull();
    expect(schemeFor(null, 'Station')).toBe('level_tag');
    expect(schemeFor(all[2]!, 'NSPS')).toBe('level_number');
  });

  it('a numbered type is created without an ID: 06M-? + NEW, + mark, field addition, pin rounded', async () => {
    const { store, editor, base, plan } = await setup();
    const nsps = (await libraryChoices(store, plan.level.projectId, 'NSPS'))[0]!;
    const r = await addFieldDevice(editor, store, { ...base, category: 'NSPS', libraryTypeId: nsps.id, room: ' XX06M-1E05 ' });
    expect(r).toMatchObject({ displayId: null, draftTypeId: null, takenBy: [] });
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]!.payload).toMatchObject({
      level_id: DEMO_LEVEL_ID,
      category: 'NSPS',
      device: 'P-NSPS-D',
      library_type_id: nsps.id,
      origin: 'field_addition',
      found_on_site: true,
      room_location: 'XX06M-1E05',
      pin: { sheet: DEMO_SHEET_ID, x: 1234.6, y: 987 },
    });
    expect(r.ops[0]!.payload).not.toHaveProperty('display_id');
    const card = (await loadDeviceCard(store, r.deviceId))!;
    expect(card.device).toMatchObject({ label: '06M-?', isNew: true, fieldAddition: true, status: null });
    const after = (await loadLevelPlan(store, DEMO_LEVEL_ID))!;
    expect(after.devices.find((d) => d.id === r.deviceId)).toMatchObject({ label: '06M-?', fieldAddition: true, pin: { x: 1234.6, y: 987 } });
  });

  it('a station needs its drawing tag; a taken tag is a warning, not a refusal', async () => {
    const { store, editor, base, plan } = await setup();
    const station = (await libraryChoices(store, plan.level.projectId, 'Station'))[0]!;
    await expect(addFieldDevice(editor, store, { ...base, category: 'Station', libraryTypeId: station.id })).rejects.toThrow(/drawing tag/);
    await expect(addFieldDevice(editor, store, { ...base, category: 'Station', libraryTypeId: station.id, tag: 'D4' })).rejects.toThrow(/starts with S/);
    const r = await addFieldDevice(editor, store, { ...base, category: 'Station', libraryTypeId: station.id, tag: 's 41' });
    expect(r).toMatchObject({ displayId: '06M-S41', takenBy: [] });
    const again = await addFieldDevice(editor, store, { ...base, category: 'Station', libraryTypeId: station.id, tag: '41' });
    expect(again.displayId).toBe('06M-S41');
    expect(again.takenBy).toEqual([r.deviceId]);
    expect((await loadDeviceCard(store, again.deviceId))!.device).toMatchObject({ label: '06M-S41', isNew: false });
  });

  it('a free-typed model becomes a project draft type in the same group (D55); a typed known model reuses the type', async () => {
    const { store, editor, base, plan } = await setup();
    const r = await addFieldDevice(editor, store, { ...base, category: 'Relay panel', typedModel: 'ERP-XYZ 12' });
    expect(r.draftTypeId).toBeTruthy();
    expect(r.ops.map((o) => o.entity_kind)).toEqual(['library_type', 'device']);
    expect(new Set(r.ops.map((o) => o.group_id)).size).toBe(1);
    expect(r.ops[0]!.payload).toMatchObject({ project_id: plan.level.projectId, model: 'ERP-XYZ 12', category: 'Relay panel', state: 'draft', created_by_id: ME });
    expect(r.ops[1]!.payload).toMatchObject({ device: 'ERP-XYZ 12', library_type_id: r.draftTypeId });
    const drafts = await libraryChoices(store, plan.level.projectId, 'Relay panel');
    expect(drafts).toMatchObject([{ model: 'ERP-XYZ 12', state: 'draft' }]);
    // the same model typed again uses that draft, no second draft
    const again = await addFieldDevice(editor, store, { ...base, category: 'Relay panel', typedModel: 'erp-xyz 12' });
    expect(again.draftTypeId).toBeNull();
    expect(again.ops[0]!.payload).toMatchObject({ library_type_id: r.draftTypeId });
    // a typed sensor model that matches the library takes the type's tag scheme
    await expect(addFieldDevice(editor, store, { ...base, category: 'Sensor', typedModel: 'uhci-wm' })).rejects.toThrow(/drawing tag/);
    // nothing typed or picked
    await expect(addFieldDevice(editor, store, { ...base, category: 'EBDK' })).rejects.toThrow(/Pick a device type/);
  });

  it('a free-typed sensor (draft, no scheme yet) goes by its category: tag required', async () => {
    const { store, editor, base } = await setup();
    await expect(addFieldDevice(editor, store, { ...base, category: 'Sensor', typedModel: 'NEW-SENSOR' })).rejects.toThrow(/drawing tag/);
    const r = await addFieldDevice(editor, store, { ...base, category: 'Sensor', typedModel: 'NEW-SENSOR', tag: '7' });
    expect(r).toMatchObject({ displayId: '06M-D7' });
    expect(r.draftTypeId).toBeTruthy();
  });
});
