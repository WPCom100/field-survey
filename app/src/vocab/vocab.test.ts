import { Editor, LIBRARY_STREAM, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PIN_SHAPE, pinShape } from '../plan/pins';
import { acceptValue, addPair, addPlaceholder, addValue, cleanValue, copyAppVocab, editPlaceholder, loadPairs, loadPlaceholders, loadStandard, loadVocab, promoteValue, removePlaceholder, removeValue, renameValue } from './model';
import { loadPinShapes, pinShapeRowId, resolvePinShapes, setPinShape, sharedShapes } from './pinShapes';
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

describe('vocabulary follow-ups (T104, D187, D214)', () => {
  async function scopes() {
    const base = await setup();
    let clock = 1_760_400_000_000;
    const library = new Editor(base.store, { projectId: LIBRARY_STREAM, userId: uuidv7(), now: () => new Date((clock += 1000)).toISOString() });
    return { ...base, library };
  }

  it('model map and level aliases: pairs on a canonical row, drafts, refusals, removal with the variants', async () => {
    const { store, editor, projectId } = await setup();
    const a = await addPair(editor, store, 'model_map', ' P-DOC-W-WD ', 'P-DOC-W');
    const b = await addPair(editor, store, 'model_map', 'P-DOC-W-4Z', 'p-doc-w'); // the same canonical, any case
    await addPair(editor, store, 'level_alias', 'Level 5', '06M');
    const pairs = await loadPairs(store, projectId);
    expect(pairs.model_map).toEqual([{ id: expect.any(String), value: 'P-DOC-W', draft: true, variants: [{ id: a, value: 'P-DOC-W-WD', draft: true }, { id: b, value: 'P-DOC-W-4Z', draft: true }] }]);
    expect(pairs.level_alias.map((p) => [p.value, p.variants.map((v) => v.value)])).toEqual([['06M', ['Level 5']]]);
    // the rows are D187's shape: a variant's canonical_of_id is the canonical row
    expect(await store.get('vocab', a)).toMatchObject({ project_id: projectId, list: 'model_map', canonical_of_id: pairs.model_map[0]!.id, state: 'draft' });
    await expect(addPair(editor, store, 'model_map', 'p-doc-w-wd', 'X')).rejects.toThrow(/already/);
    await expect(addPair(editor, store, 'model_map', 'P-DOC-W', 'P-DOC-W')).rejects.toThrow(/the same/);
    await expect(addPair(editor, store, 'model_map', '', 'X')).rejects.toThrow(/both/);
    await expect(renameValue(editor, store, b, 'P-DOC-W-WD')).rejects.toThrow(/already/);
    expect((await loadVocab(store, projectId)).category).toEqual([]); // pairs are not on the plain lists
    await removeValue(editor, pairs.model_map[0]!.id, store);
    expect((await loadPairs(store, projectId)).model_map).toEqual([]);
    expect((await store.get<{ deleted_at: string | null }>('vocab', a))!.deleted_at).not.toBeNull(); // soft-deleted with its canonical
  });

  it('device types are a plain list (chips on the card)', async () => {
    const { store, editor, projectId } = await setup();
    await addValue(editor, store, 'type', 'Echo relay panel');
    expect((await loadVocab(store, projectId)).type.map((e) => e.value)).toEqual(['Echo relay panel']);
  });

  it('app library: drafts on the library stream, standard values as drafts, no placeholders; projects never see them', async () => {
    const { store, library, projectId } = await scopes();
    const id = await addValue(library, store, 'type', 'Echo relay panel');
    expect(await store.get('vocab', id)).toMatchObject({ project_id: null, state: 'draft' });
    const [op] = await store.opsFor(id);
    expect(op).toMatchObject({ project_id: LIBRARY_STREAM, entity_kind: 'vocab', kind: 'create' });
    const n = await loadStandard(library, store);
    expect(n.placeholders).toBe(0);
    expect(n.values).toBeGreaterThan(20);
    const app = await loadVocab(store, null);
    expect(app.category.length).toBe(SEED_VOCAB.category.length);
    expect(app.category.every((e) => e.draft)).toBe(true);
    expect(await loadStandard(library, store)).toEqual({ values: 0, placeholders: 0 });
    expect((await loadVocab(store, projectId)).type).toEqual([]);
    expect(await loadPlaceholders(store, projectId)).toEqual([]);
  });

  it('promote a project value (with its pair) to the app library as drafts; copy accepted app values into a project', async () => {
    const { store, editor, library, projectId } = await scopes();
    const variant = await addPair(editor, store, 'model_map', 'P-DOC-W-WD', 'P-DOC-W');
    const canonical = (await loadPairs(store, projectId)).model_map[0]!.id;
    await expect(promoteValue(library, store, variant)).rejects.toThrow(/Accept/);
    await acceptValue(editor, variant);
    await acceptValue(editor, canonical);
    await expect(promoteValue(editor, store, variant)).rejects.toThrow(/app library/);
    expect(await promoteValue(library, store, variant)).toBe(2);
    const app = (await loadPairs(store, null)).model_map;
    expect(app.map((p) => [p.value, p.draft, p.variants.map((v) => [v.value, v.draft])])).toEqual([['P-DOC-W', true, [['P-DOC-W-WD', true]]]]);
    await expect(promoteValue(library, store, canonical)).rejects.toThrow(/already has/);

    // copy: only accepted app values, canonicals first, onto what the project has
    const other = uuidv7();
    let clock = 1_760_500_000_000;
    const otherEditor = new Editor(store, { projectId: other, userId: uuidv7(), now: () => new Date((clock += 1000)).toISOString() });
    expect(await copyAppVocab(otherEditor, store, other)).toBe(0); // all drafts so far
    await acceptValue(library, app[0]!.id);
    await acceptValue(library, app[0]!.variants[0]!.id);
    await addValue(library, store, 'type', 'Still a draft');
    await otherEditor.create('vocab', { project_id: other, list: 'model_map', value: 'p-doc-w', state: 'accepted' }, { change_type: 'Master edit', reason: 't' });
    expect(await copyAppVocab(otherEditor, store, other)).toBe(1); // the variant, onto the project's own canonical
    const got = (await loadPairs(store, other)).model_map;
    expect(got.map((p) => [p.value, p.variants.map((v) => [v.value, v.draft])])).toEqual([['p-doc-w', [['P-DOC-W-WD', false]]]]);
    expect(await copyAppVocab(otherEditor, store, other)).toBe(0);
  });

  it('pin shapes: one app-library row, only the moved roles stored, applied at once and read by the plan', async () => {
    const { store, editor, library } = await scopes();
    expect(await loadPinShapes(store)).toEqual(DEFAULT_PIN_SHAPE);
    await expect(setPinShape(editor, store, 'station', 'square')).rejects.toThrow(/app library/);
    expect(await setPinShape(library, store, 'station', 'square')).toBe(1);
    expect(await setPinShape(library, store, 'station', 'square')).toBe(0);
    const row = await store.get<{ project_id: string | null; rule_id: string; key: string; value: unknown; state: string }>('rule_param', pinShapeRowId());
    expect(row).toMatchObject({ project_id: null, rule_id: 'pin', key: 'shape', value: { station: 'square' }, state: 'accepted' });
    const shapes = await loadPinShapes(store);
    expect(shapes.station).toBe('square');
    expect(sharedShapes(shapes)).toEqual(['relay_panel', 'station']);
    expect(pinShape('station', 20, shapes)).toEqual({ kind: 'rect', width: 20, height: 20, radius: 0 });
    expect(pinShape('Station', 20)).toEqual({ kind: 'circle', radius: 10 }); // no map = the defaults
    await setPinShape(library, store, 'station', 'circle'); // back to the default: nothing stored
    expect((await store.get<{ value: unknown }>('rule_param', pinShapeRowId()))!.value).toBeNull();
    expect(await loadPinShapes(store)).toEqual(DEFAULT_PIN_SHAPE);
    expect(resolvePinShapes({ station: 'blob', nobody: 'square', sensor: 'circle' })).toEqual({ ...DEFAULT_PIN_SHAPE, sensor: 'circle' });
    await expect(setPinShape(library, store, 'station', 'blob' as never)).rejects.toThrow(/Unknown/);
  });
});
