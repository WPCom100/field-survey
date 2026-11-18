/**
 * The app library's own op stream against the real server (T61, D65, D184; one library since
 * T196, D287 (1)): two iPads push and pull `/library/ops` through `HttpTransport`; a draft type
 * made for a model the library lacks (D292 (2)) and the device naming it go up in one sync cycle,
 * library first, and reach the other iPad; a type pushed in a project's stream is refused and
 * quarantined, never stored; a project created afterwards holds no copy of any type; a same-field
 * clash on an app-library type becomes a review item on both iPads and resolves like any other.
 * The e2e database outlives a run, so model names are unique and only this run's rows are asserted.
 * Opt-in: see ./harness.ts and packages/core/docs/e2e.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Editor, type EditContext } from '../editor';
import { uuidv7 } from '../ids';
import { LIBRARY_STREAM } from '../library-stream';
import { openReviewItems } from '../review';
import { CTX, ENABLED, SKIP_REASON, URL_, http, namesOf, openClient, seedProject, sync, waitForHealth, type Client } from './harness';

const LIB: EditContext = { change_type: 'Master edit', reason: 'Device-type library' };
const libEditor = (c: Client) => new Editor(c.store, { projectId: LIBRARY_STREAM, userId: c.userId });
const E2E_MODEL = /^(PI1002|PI1004) [0-9a-f]{8}(-P)?$/;

/** This file's types are rejected before and after it runs, so the e2e server's library stays tidy. */
async function retireE2eTypes(): Promise<void> {
  const c = await openClient('Ann', LIBRARY_STREAM, { engine: { library: true, projects: async () => [LIBRARY_STREAM] } });
  await sync(c);
  const rows = await c.store.list<{ id: string; model: string }>('library_type', { where: `project_id IS NULL AND state <> 'rejected'` });
  for (const r of rows.filter((r) => E2E_MODEL.test(r.model))) await libEditor(c).setField('library_type', r.id, 'state', 'rejected', LIB);
  await sync(c);
}

describe.skipIf(!ENABLED)(`the app library stream against ${URL_ || 'the Docker server'} (${SKIP_REASON})`, () => {
  beforeAll(async () => {
    await waitForHealth();
    await retireE2eTypes();
  });
  afterAll(retireE2eTypes);

  it('one library: a field-made draft type and its device go up in one cycle and reach the other iPad; a project type is refused; a new project copies none', async () => {
    const a = await seedProject(`Library A ${uuidv7()}`, [{ level: '06M' }]);
    const ann = await openClient('Ann', a.project_id, { engine: { library: true } });
    const bob = await openClient('Bob', a.project_id, { engine: { library: true } });
    await sync(ann, bob);
    const model = `PI1002 ${uuidv7().slice(-8)}`;
    // a model the library lacks (D292 (2)): its draft type on the library stream, then the
    // device naming it in the project, both offline; one sync cycle pushes the library first
    const type = await libEditor(ann).create('library_type', { project_id: null, model, category: 'Station', state: 'draft' }, LIB);
    const device = await ann.editor.create('device', { level_id: a.levels['06M']!, category: 'Station', device: model, library_type_id: type.id }, CTX);
    await sync(ann, bob);
    expect(await ann.store.outboxCount()).toBe(0);
    expect(await bob.store.get('library_type', type.id)).toMatchObject({ project_id: null, model, state: 'draft' });
    expect((await bob.store.opsFor(type.id)).map((o) => [o.project_id, o.state])).toEqual([[LIBRARY_STREAM, 'applied']]);
    // the server numbered the station by its type's role (D93, D118)
    expect(await bob.store.get('device', device.id)).toMatchObject({ library_type_id: type.id, display_id: '06M-S1' });

    // a type in a project's stream is refused (422) and quarantined; nothing reaches the server
    const stray = await ann.editor.create('library_type', { project_id: a.project_id, model: `${model}-P`, state: 'draft' }, LIB);
    await sync(ann);
    const parked = await ann.store.quarantined(a.project_id);
    expect(parked.map((q) => q.op.entity_id)).toEqual([stray.id]);
    expect(parked[0]!.error).toMatch(/library\/ops/);

    // a project created afterwards holds no copy of any type
    const b = await seedProject(`Library B ${uuidv7()}`, [{ level: '01' }]);
    const pulled = await http('harness').json<{ ops: { entity_kind: string }[] }>('GET', `/ops?project_id=${b.project_id}&since=0&limit=500`);
    expect(pulled.ops.filter((o) => o.entity_kind === 'library_type' || o.entity_kind === 'suggestion')).toEqual([]);
  });

  it('a clash on an app-library type is reviewed on both iPads and resolved', async () => {
    const p = await seedProject(`Library clash ${uuidv7()}`, [{ level: '06M' }]);
    const ann = await openClient('Ann', p.project_id, { engine: { library: true } });
    const bob = await openClient('Bob', p.project_id, { engine: { library: true } });
    const t = await libEditor(ann).create('library_type', { project_id: null, model: `PI1004 ${uuidv7().slice(-8)}`, state: 'draft' }, LIB);
    await sync(ann, bob);
    await libEditor(bob).setField('library_type', t.id, 'aliases', ['Bob'], LIB);
    await libEditor(ann).setField('library_type', t.id, 'aliases', ['Ann'], LIB);
    await sync(bob, ann, bob);
    for (const c of [ann, bob]) {
      const items = (await openReviewItems(c.store, LIBRARY_STREAM)).filter((i) => i.subject.entity_id === t.id);
      expect(items.map((i) => [i.project_id, i.subject.field])).toEqual([[LIBRARY_STREAM, 'aliases']]);
      expect((await c.store.get('library_type', t.id))!.aliases).toEqual(['Bob']); // first arrived
    }
    const item = (await openReviewItems(ann.store, LIBRARY_STREAM)).find((i) => i.subject.entity_id === t.id)!;
    await libEditor(ann).resolve(item.id, { choice: 'B' }, { userName: namesOf(ann, bob) });
    await sync(ann, bob);
    for (const c of [ann, bob]) {
      expect((await c.store.get('library_type', t.id))!.aliases).toEqual(['Ann']);
      expect((await openReviewItems(c.store, LIBRARY_STREAM)).filter((i) => i.subject.entity_id === t.id)).toEqual([]);
    }
  });
});
