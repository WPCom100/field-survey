import { Editor, Store, uuidv7 } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import sets06m from '../plan/demo-grid.json';
import { loadLevelSheets, sheetJobLine } from './sheets';

const ME = uuidv7();
const CTX = { change_type: 'Master edit' as const, reason: 'Plan sheet upload' };

async function project() {
  const store = await Store.open(new BetterSqliteDriver(), { installId: 'ipad', search: 'like' });
  const pid = uuidv7();
  const editor = new Editor(store, { projectId: pid, userId: ME });
  await editor.create('project', { id: pid, name: 'Tower' }, CTX);
  const g = (await editor.create('numbering_group', { project_id: pid, label: '06/06M' }, CTX)).id;
  const level = async (code: string, floor_order: number) =>
    (await editor.create('level', { project_id: pid, level: code, floor_order, numbering_group_id: g, in_scope: true, state: 'setup' }, CTX)).id;
  return { store, pid, editor, L06: await level('06', 1), L06M: await level('06M', 2) };
}

describe('loadLevelSheets', () => {
  it('lists every level with its display sheet, grid summary, cache state and source sheets', async () => {
    const { store, pid, editor, L06, L06M } = await project();
    const sha = 'a'.repeat(64);
    const display = await editor.create(
      'sheet',
      { level_id: L06M, kind: 'display', blob: sha, page: 1, title: 'Level_06M_Composite', width_pt: 4235.48, height_pt: 3604.72, grid_sets: sets06m.grid_sets, features: { rooms: sets06m.rooms, tags: [], bubbles: [], boundaries: [], boundary_labels: [] } },
      CTX,
    );
    await editor.setField('level', L06M, 'display_sheet_id', display.id, CTX);
    await editor.create('sheet', { level_id: L06M, kind: 'source', blob: 'b'.repeat(64), page: 2, title: 'Ef.106.5 p.2' }, CTX);
    await editor.create('sheet', { level_id: L06M, kind: 'source', blob: 'b'.repeat(64), page: 1, title: 'Ef.106.5 p.1' }, CTX);
    // a deleted source sheet drops out
    const gone = await editor.create('sheet', { level_id: L06M, kind: 'source', blob: 'c'.repeat(64), page: 1, title: 'old' }, CTX);
    await editor.delete('sheet', gone.id, CTX);

    let rows = await loadLevelSheets(store, pid);
    expect(rows.map((r) => r.code)).toEqual(['06', '06M']);
    expect(rows[0]!.display).toBeNull();
    expect(rows[0]!.sources).toEqual([]);
    const m = rows[1]!;
    expect(m.display).toEqual({ sheetId: display.id, title: 'Level_06M_Composite', cached: false, grid: 'auto ✓ 3 sets', sets: 3 });
    expect(m.sources.map((s) => s.title)).toEqual(['Ef.106.5 p.1', 'Ef.106.5 p.2']);

    // once the blob is on disk the display sheet is "cached"
    await store.db.exec(`INSERT INTO blob (sha256, size, mime, upload_state, kind, local_path) VALUES (?, 1, 'application/pdf', 'complete', 'sheet', 'blobs/x.pdf')`, [sha]);
    rows = await loadLevelSheets(store, pid);
    expect(rows[1]!.display?.cached).toBe(true);

    // a sheet without a grid
    const plain = await editor.create('sheet', { level_id: L06, kind: 'display', blob: 'd'.repeat(64), page: 1, title: 'L06', grid_sets: [] }, CTX);
    await editor.setField('level', L06, 'display_sheet_id', plain.id, CTX);
    rows = await loadLevelSheets(store, pid);
    expect(rows[0]!.display?.grid).toBe('no grid found');
    expect(await loadLevelSheets(store, uuidv7())).toEqual([]);
  });
});

describe('sheetJobLine', () => {
  it('words each job state', () => {
    const b = (job_state: 'queued' | 'running' | 'done' | 'skipped' | 'failed', stats: Record<string, unknown> | null = null) => ({ id: 'x', job_state, stats });
    expect(sheetJobLine(b('queued'))).toMatch(/Queued/);
    expect(sheetJobLine(b('running'))).toMatch(/Reading the sheet/);
    expect(sheetJobLine(b('skipped'))).toMatch(/Already uploaded/);
    expect(sheetJobLine(b('failed', { error: 'not a PDF' }))).toBe('Failed: not a PDF');
    expect(sheetJobLine(b('done', { grid_sets: 3, auto_sets: 3, sheets: [{}] }))).toBe('Done: 1 sheet, 3 grid sets (3 auto) — arrives with the next sync');
    expect(sheetJobLine(b('done', { grid_sets: 0, auto_sets: 0, sheets: [{}, {}, {}] }))).toBe('Done: 3 sheets, 0 grid sets — arrives with the next sync');
  });
});
