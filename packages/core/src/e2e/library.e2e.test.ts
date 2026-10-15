/**
 * The app library's own op stream against the real server (T61, D65, D184): two iPads push and
 * pull `/library/ops` through `HttpTransport`; a project type promoted from project A reaches
 * the other iPad and is copied into a project B created afterwards; a same-field clash on an
 * app-library type becomes a review item on both iPads and resolves like any other. The e2e
 * database outlives a run, so model names are unique and only this run's rows are asserted.
 * Opt-in: see ./harness.ts and packages/core/docs/e2e.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Editor, type EditContext } from '../editor';
import { uuidv7 } from '../ids';
import { LIBRARY_STREAM } from '../library-stream';
import { openReviewItems } from '../review';
import { ENABLED, SKIP_REASON, URL_, http, namesOf, openClient, seedProject, sync, waitForHealth, type Client } from './harness';

const LIB: EditContext = { change_type: 'Master edit', reason: 'Device-type library' };
const libEditor = (c: Client) => new Editor(c.store, { projectId: LIBRARY_STREAM, userId: c.userId });
const E2E_MODEL = /^(P-TS18-E|PI1002) [0-9a-f]{8}$/;

/**
 * Every project created later copies the app library's accepted types (D65), which would add ops
 * to other e2e tests' exact counts: this file's types are rejected before and after it runs.
 */
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

  it('a type promoted from project A reaches the other iPad and a new project B', async () => {
    const a = await seedProject(`Library A ${uuidv7()}`, [{ level: '06M' }]);
    const ann = await openClient('Ann', a.project_id, { engine: { library: true } });
    const bob = await openClient('Bob', a.project_id, { engine: { library: true } });
    await sync(ann, bob);
    const model = `P-TS18-E ${uuidv7().slice(-8)}`;
    const own = await ann.editor.create('library_type', { project_id: a.project_id, model, category: 'Touchscreen', state: 'draft' }, LIB);
    await ann.editor.setField('library_type', own.id, 'state', 'accepted', LIB);
    // Promote: an app-library row (no project) on the library stream, pointing at A's type
    const promoted = await libEditor(ann).create(
      'library_type',
      { project_id: null, model, category: 'Touchscreen', state: 'accepted', promoted_from_id: own.id },
      LIB,
    );
    await sync(ann, bob);
    expect(await bob.store.get('library_type', promoted.id)).toMatchObject({ project_id: null, model, promoted_from_id: own.id, state: 'accepted' });
    expect((await bob.store.opsFor(promoted.id)).map((o) => [o.project_id, o.state])).toEqual([[LIBRARY_STREAM, 'applied']]);

    const b = await seedProject(`Library B ${uuidv7()}`, [{ level: '01' }]);
    const pulled = await http('harness').json<{ ops: { entity_kind: string; payload: Record<string, unknown> | null }[] }>(
      'GET',
      `/ops?project_id=${b.project_id}&since=0&limit=500`,
    );
    const copies = pulled.ops.filter((o) => o.entity_kind === 'library_type' && o.payload?.model === model);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.payload).toMatchObject({ project_id: b.project_id, state: 'accepted', category: 'Touchscreen' });
  });

  it('a clash on an app-library type is reviewed on both iPads and resolved', async () => {
    const p = await seedProject(`Library clash ${uuidv7()}`, [{ level: '06M' }]);
    const ann = await openClient('Ann', p.project_id, { engine: { library: true } });
    const bob = await openClient('Bob', p.project_id, { engine: { library: true } });
    const t = await libEditor(ann).create('library_type', { project_id: null, model: `PI1002 ${uuidv7().slice(-8)}`, state: 'draft' }, LIB);
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
