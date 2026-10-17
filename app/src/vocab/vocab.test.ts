import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { acceptValue, addPlaceholder, addValue, cleanValue, editPlaceholder, loadPlaceholders, loadStandard, loadVocab, removePlaceholder, removeValue, renameValue } from './model';
import { setEndPlaceholder } from '../ends/actions';
import { SEED_PLACEHOLDERS, SEED_VOCAB } from './seed';

async function setup() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
  const projectId = uuidv7();
  let clock = 1_760_300_000_000;
  const editor = new Editor(store, { projectId, userId: uuidv7(), now: () => new Date((clock += 1000)).toISOString() });
  return { store, editor, projectId };
}

describe('vocabulary editor (T40)', () => {
  it('seeds the standard lists once and only fills what is missing', async () => {
    const { store, editor, projectId } = await setup();
    await addValue(editor, store, 'category', 'sensor'); // a draft with a seed spelling
    const first = await loadStandard(editor, store);
    expect(first.placeholders).toBe(SEED_PLACEHOLDERS.length);
    const v = await loadVocab(store, projectId);
    expect(v.category.map((e) => e.value).sort()).toEqual([...SEED_VOCAB.category.filter((c) => c !== 'Sensor'), 'sensor'].sort());
    expect(v.device_note.map((e) => e.value)).toContain('Empty box on wall.');
    expect(v.device_note.every((e) => !e.draft)).toBe(true);
    expect(v.cable_code.map((e) => e.value)).toEqual(['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V', 'D']); // T111 / D199: the codes, as a list
    expect(await loadStandard(editor, store)).toEqual({ values: 0, placeholders: 0 });
    // T112 (D201): the master's renamed categories are recorded as old spellings of the D196 value
    const rows = await store.list<{ id: string; value: string; canonical_of_id: string | null }>('vocab', { where: 'project_id = ? AND list = ?', params: [projectId, 'category'] });
    const byValue = new Map(rows.map((r) => [r.value, r]));
    const canonical = (v: string) => rows.find((r) => r.id === byValue.get(v)?.canonical_of_id)?.value ?? null;
    expect(canonical('Relay panel')).toBe('Power Distribution');
    expect(canonical('Foundry panel')).toBe('Power Distribution');
    expect(canonical('EBDK')).toBe('Emergency Equipment');
    expect(canonical('NSPS')).toBe('Equipment');
    expect(canonical('Equipment rack')).toBe('Equipment Panels');
    expect(byValue.get('Equipment Rack')?.canonical_of_id).toBeNull(); // the D196 DIN-rail category stands on its own
    expect(v.category.map((e) => e.value)).not.toContain('Relay panel'); // variants are not listed
    const ph = await loadPlaceholders(store, projectId);
    expect(ph.find((p) => p.label === 'Stations & Sensors')!.kind).toBe('station_bus');
    expect(ph.filter((p) => p.kind === 'level_not_in_scope').map((p) => p.label).sort()).toEqual(['Level 09', 'Level 10', 'Level 11', 'Level 12']);
  });

  it('adds a draft, accepts it, renames it and removes it, refusing duplicates and blanks', async () => {
    const { store, editor, projectId } = await setup();
    const id = await addValue(editor, store, 'device_note', '  Stuck   button ');
    expect((await loadVocab(store, projectId)).device_note).toEqual([{ id, value: 'Stuck button', draft: true }]);
    await expect(addValue(editor, store, 'device_note', 'stuck button')).rejects.toThrow(/already/);
    await expect(addValue(editor, store, 'device_note', '   ')).rejects.toThrow(/Type a value/);
    await acceptValue(editor, id);
    await renameValue(editor, store, id, 'Stuck buttons');
    expect((await loadVocab(store, projectId)).device_note).toEqual([{ id, value: 'Stuck buttons', draft: false }]);
    await removeValue(editor, id);
    expect((await loadVocab(store, projectId)).device_note).toEqual([]);
    expect(cleanValue(' a  b ')).toBe('a b');
  });

  it('adds, edits and removes placeholders; removal is refused while an end uses one', async () => {
    const { store, editor, projectId } = await setup();
    const id = await addPlaceholder(editor, store, 'Roof unit');
    expect(await addPlaceholder(editor, store, 'roof UNIT')).toBe(id);
    await editPlaceholder(editor, store, id, { label: 'Roof unit 2', kind: 'external' });
    expect(await loadPlaceholders(store, projectId)).toEqual([{ id, label: 'Roof unit 2', kind: 'external', levelId: null }]);
    await editor.create('cable_end', { cable_id: uuidv7(), side: 'A', endpoint_kind: 'placeholder', placeholder_id: id }, { change_type: 'Master edit', reason: 't' });
    await expect(removePlaceholder(editor, store, id)).rejects.toThrow(/1 connection end/);
  });

  it('the endpoint picker points a non-device end at a placeholder, never a device end', async () => {
    const { store, editor } = await setup();
    const ctx = { change_type: 'Master edit' as const, reason: 't' };
    const ph = await addPlaceholder(editor, store, 'Fixtures');
    const free = await editor.create('cable_end', { cable_id: uuidv7(), side: 'B', endpoint_kind: 'placeholder' }, ctx);
    const onDevice = await editor.create('cable_end', { cable_id: uuidv7(), side: 'A', endpoint_kind: 'device', device_id: uuidv7() }, ctx);
    await setEndPlaceholder(editor, free.id, ph);
    expect(await store.get('cable_end', free.id)).toMatchObject({ endpoint_kind: 'placeholder', placeholder_id: ph });
    expect(await setEndPlaceholder(editor, free.id, ph)).toEqual([]); // same again writes nothing
    await expect(setEndPlaceholder(editor, onDevice.id, ph)).rejects.toThrow(/is a device/);
    await expect(setEndPlaceholder(editor, free.id, uuidv7())).rejects.toThrow(/not in this project/);
  });
});

describe('category vocabulary on an existing project (T112, D201)', () => {
  it("re-points the master's eight to the D196 eleven without touching the new `Equipment Rack`; idempotent", async () => {
    const { store, editor, projectId } = await setup();
    // an older seed: the master's spellings as plain accepted rows
    for (const value of ['Relay panel', 'Foundry panel', 'EBDK', 'Equipment rack', 'NSPS', 'Touchscreen', 'Station', 'Sensor']) {
      await editor.create('vocab', { project_id: projectId, list: 'category', value, state: 'accepted' }, { change_type: 'Master edit', reason: 't' });
    }
    const before = await store.list<{ id: string; value: string }>('vocab', { where: 'project_id = ? AND list = ?', params: [projectId, 'category'] });
    const first = await loadStandard(editor, store);
    const rows = await store.list<{ id: string; value: string; canonical_of_id: string | null }>('vocab', { where: 'project_id = ? AND list = ?', params: [projectId, 'category'], orderBy: 'id' });
    const byValue = new Map(rows.map((r) => [r.value, r]));
    const canonical = (v: string) => rows.find((r) => r.id === byValue.get(v)?.canonical_of_id)?.value ?? null;
    // the eight rows are the same rows (no duplicates), five of them now old spellings
    for (const b of before) expect(byValue.get(b.value)?.id).toBe(b.id);
    expect(['Relay panel', 'Foundry panel', 'EBDK', 'NSPS', 'Equipment rack'].map(canonical)).toEqual(['Power Distribution', 'Power Distribution', 'Emergency Equipment', 'Equipment', 'Equipment Panels']);
    expect(['Touchscreen', 'Station', 'Sensor', 'Equipment Rack', 'Power Distribution'].map((v) => byValue.get(v)?.canonical_of_id)).toEqual([null, null, null, null, null]);
    expect(rows).toHaveLength(8 + 8); // the eight, plus the eleven minus the three the master already spelled the same
    expect(first.values).toBeGreaterThanOrEqual(8 + 5);
    const view = await loadVocab(store, projectId);
    expect(view.category.map((e) => e.value).sort()).toEqual([...SEED_VOCAB.category].sort());
    expect(await loadStandard(editor, store)).toMatchObject({ values: 0 });
  });
});
