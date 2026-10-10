import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeviceIdError,
  defaultIdScheme,
  deviceIdFor,
  parseDeviceId,
  tagDeviceId,
} from './device-id';
import { Editor, type EditContext } from './editor';
import { uuidv7 } from './ids';
import { BetterSqliteDriver } from './node';
import { Store } from './store';

const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };

describe('pure rules', () => {
  it('parses the master ID shapes', () => {
    expect(parseDeviceId('06M-04')).toEqual({ level: '06M', prefix: '', n: 4 });
    expect(parseDeviceId('01-S15')).toEqual({ level: '01', prefix: 'S', n: 15 });
    expect(parseDeviceId('B2-D1')).toEqual({ level: 'B2', prefix: 'D', n: 1 });
    expect(parseDeviceId('CT06LCPA')).toBeNull();
    expect(parseDeviceId(null)).toBeNull();
  });

  it('defaults the scheme by category', () => {
    expect(defaultIdScheme('Station')).toBe('level_tag');
    expect(defaultIdScheme('Sensor')).toBe('level_tag');
    for (const c of ['Relay panel', 'Foundry panel', 'EBDK', 'Equipment rack', 'NSPS', 'Touchscreen', null]) {
      expect(defaultIdScheme(c)).toBe('level_number');
    }
  });

  it('builds tag IDs from what the surveyor types', () => {
    expect(tagDeviceId('01', 'Station', 'S15')).toBe('01-S15');
    expect(tagDeviceId('01', 'Station', ' s 15 ')).toBe('01-S15');
    expect(tagDeviceId('01', 'Station', '15')).toBe('01-S15');
    expect(tagDeviceId('01', 'Station', 'S09')).toBe('01-S9');
    expect(tagDeviceId('B2', 'Sensor', 'd1')).toBe('B2-D1');
    expect(tagDeviceId('B2', 'Sensor', 'B2-D1')).toBe('B2-D1');
    expect(tagDeviceId('03', 'Touchscreen', 'T2')).toBe('03-T2'); // library says level_tag
  });

  it('refuses tags that contradict the category or level', () => {
    expect(() => tagDeviceId('01', 'Station', 'D15')).toThrow(/starts with S/);
    expect(() => tagDeviceId('01', 'Station', '02-S15')).toThrow(/level 02/);
    expect(() => tagDeviceId('01', 'Station', 'S')).toThrow(DeviceIdError);
    expect(() => tagDeviceId('01', 'Station', 'S0')).toThrow(DeviceIdError);
    expect(() => tagDeviceId('03', 'Touchscreen', '2')).toThrow(/needs its letter/);
  });
});

describe('deviceIdFor', () => {
  const PROJECT = uuidv7();
  const OTHER = uuidv7();
  let store: Store;
  let editor: Editor;
  let L06M: string;
  let L06: string;

  const device = async (level_id: string, display_id: string, category = 'Relay panel') =>
    (await editor.create('device', { level_id, display_id, category, status: 'Not installed' }, CTX)).id;

  beforeEach(async () => {
    store = await Store.open(new BetterSqliteDriver(), { installId: 'ipad', search: 'like' });
    editor = new Editor(store, { projectId: PROJECT, userId: uuidv7() });
    const level = async (project_id: string, code: string) =>
      (await editor.create('level', { project_id, level: code, numbering_group_id: uuidv7() }, CTX)).id;
    L06M = await level(PROJECT, '06M');
    L06 = await level(PROJECT, '06');
    const otherL06M = await level(OTHER, '06M');
    await device(L06M, '06M-01');
    await device(L06M, '06M-02', 'EBDK');
    await device(L06M, '06M-S1', 'Station');
    await device(L06, '06-01');
    await device(otherL06M, '06M-09'); // another project never counts
  });

  it('leaves level_number IDs to the server (D93)', async () => {
    for (const category of ['Foundry panel', 'NSPS', 'EBDK', null]) {
      expect(await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category })).toEqual({
        scheme: 'level_number',
        pending: true,
      });
    }
    // A tag is ignored for a numbered device: the server owns the number.
    expect(await deviceIdFor(store, { projectId: PROJECT, levelId: L06, category: 'Relay panel', tag: '4' })).toEqual({
      scheme: 'level_number',
      pending: true,
    });
  });

  it('a device being retagged does not collide with itself', async () => {
    const own = (await store.list<{ id: string; display_id: string }>('device')).find((d) => d.display_id === '06M-S1')!;
    const res = await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Station', tag: 'S1', deviceId: own.id });
    expect(res).toEqual({ scheme: 'level_tag', pending: false, display_id: '06M-S1', taken_by: [] });
  });

  it('a deleted device’s tag still counts as taken', async () => {
    const d = await device(L06M, '06M-D7', 'Sensor');
    await editor.delete('device', d, CTX);
    const res = await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Sensor', tag: '7' });
    expect(res).toMatchObject({ display_id: '06M-D7', taken_by: [d] });
  });

  it('uses the confirmed tag for stations and sensors', async () => {
    expect(await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Sensor', tag: 'D4' })).toEqual({
      scheme: 'level_tag',
      pending: false,
      display_id: '06M-D4',
      taken_by: [],
    });
    const dup = await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Station', tag: '1' });
    expect(dup).toMatchObject({ display_id: '06M-S1', taken_by: [expect.any(String)] });
    await expect(deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Station' })).rejects.toThrow(
      /drawing tag/,
    );
  });

  it('the library type’s scheme wins over the category default', async () => {
    const type = async (category: string, id_scheme: string) =>
      (await editor.create('library_type', { project_id: PROJECT, model: `m-${id_scheme}`, category, id_scheme }, CTX)).id;
    const sensorAsNumber = await type('Sensor', 'level_number');
    expect(
      await deviceIdFor(store, { projectId: PROJECT, levelId: L06M, category: 'Sensor', libraryTypeId: sensorAsNumber }),
    ).toEqual({ scheme: 'level_number', pending: true });
    const touchscreenAsTag = await type('Touchscreen', 'level_tag');
    expect(
      await deviceIdFor(store, {
        projectId: PROJECT,
        levelId: L06,
        category: 'Touchscreen',
        libraryTypeId: touchscreenAsTag,
        tag: 'T2',
      }),
    ).toMatchObject({ scheme: 'level_tag', display_id: '06-T2' });
  });

  it('refuses an unknown level', async () => {
    await expect(deviceIdFor(store, { projectId: PROJECT, levelId: uuidv7() })).rejects.toThrow(/Unknown level/);
  });
});
