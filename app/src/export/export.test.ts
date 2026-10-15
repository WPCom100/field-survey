import { Store, TransportError, uuidv7, type Op, type SyncStatus } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import {
  attachJobs,
  busyLine,
  cachedHistory,
  elapsed,
  isActive,
  progressLine,
  runningFrom,
  diffDetail,
  diffLine,
  downloadedExports,
  exportTime,
  floorBody,
  floorHeader,
  jobLine,
  levelsTitle,
  loadPreflight,
  preflightLine,
  rememberDownload,
  rememberHistory,
  scopeLine,
  shareName,
  startGate,
  workbookBody,
  type ExportRow,
} from './model';

const ME = uuidv7();
let ts = 1_760_000_000_000;
function op(entity_kind: Op['entity_kind'], entity_id: string, kind: Op['kind'], project_id: string, payload: Record<string, unknown>): Op {
  return {
    op_id: uuidv7(), project_id, user_id: ME, install_id: 'other', client_ts: new Date((ts += 1000)).toISOString(),
    change_type: 'Master edit', entity_kind, entity_id, kind, payload,
  };
}

const SYNCED: SyncStatus = {
  state: 'idle', pendingOps: 0, quarantinedOps: 0, willReview: 0, lastSyncAt: '2026-10-12T10:00:00Z', lastServerSeq: { p: 12 },
  lastError: null, failures: 0, nextAttemptAt: null,
};

function row(over: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 'e1', project_id: 'p', kind: 'xlsx', params: null, job_state: 'done', blob: 'abc',
    filename: 'Lighting_Control_Survey_Master_B2-06_2.xlsx', stats: { bytes: 1_150_000, levels: ['B2', '01', '06M'] },
    diff_summary: null, created_by_id: null, created_at: '2026-10-12T14:05:00Z', ...over,
  };
}

describe('D94 gate', () => {
  it('enables Start only when synced with nothing pending and the server reached', () => {
    expect(startGate(SYNCED).ok).toBe(true);
    const no = (s: Partial<SyncStatus>) => startGate({ ...SYNCED, ...s });
    expect(no({ pendingOps: 3 })).toMatchObject({ ok: false, reason: expect.stringMatching(/3 edits .*Sync first/) });
    expect(no({ pendingOps: 1 }).reason).toMatch(/^1 edit on this iPad/);
    expect(no({ state: 'offline' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Offline/) });
    expect(no({ state: 'no_token' }).ok).toBe(false);
    expect(no({ state: 'error', lastError: '409' }).reason).toMatch(/409/);
    expect(no({ state: 'syncing' }).ok).toBe(false);
    expect(no({ lastSyncAt: null }).reason).toMatch(/Not synced yet/);
  });
});

describe('pre-flight', () => {
  it('lists in-scope levels in floor order and counts open lint findings and review items', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
    const p = uuidv7();
    const g = uuidv7();
    const lv = (code: string, order: number, inScope: boolean) =>
      op('level', uuidv7(), 'create', p, { project_id: p, level: code, floor_order: order, numbering_group_id: g, in_scope: inScope, state: 'setup' });
    const ops: Op[] = [
      op('project', p, 'create', p, { name: 'Tower' }),
      op('numbering_group', g, 'create', p, { project_id: p, label: 'all' }),
      lv('06M', 3, true), lv('B2', 1, true), lv('09', 4, false), lv('01', 2, true),
      op('finding', uuidv7(), 'create', p, { project_id: p, lint_id: 'L1', message: 'x', state: 'open' }),
      op('finding', uuidv7(), 'create', p, { project_id: p, lint_id: 'L2', message: 'y', state: 'dismissed' }),
      op('review_item', uuidv7(), 'create', p, { project_id: p, kind: 'sync_conflict', state: 'open', subject: { entity: 'x', field: 'notes' } }),
    ];
    let seq = 0;
    await store.applyRemoteMany(ops.map((o) => ({ ...o, server_seq: ++seq, server_ts: o.client_ts, state: 'applied' as const })));
    const pre = await loadPreflight(store, p);
    expect(pre.levels.map((l) => l.code)).toEqual(['B2', '01', '06M']);
    expect(pre).toMatchObject({ lint: 1, reviews: 1 });
    expect(preflightLine(pre, 14, 2)).toBe(
      '⚠ 1 lint finding · 1 review item open · 14 unsynced edits on this iPad · 2 photos still uploading (their pictures will be missing)',
    );
    expect(preflightLine({ levels: [], lint: 0, reviews: 0 }, 0)).toMatch(/^✓/);
    expect(levelsTitle(pre.levels, 'all')).toBe('Levels B2-06');
    expect(levelsTitle(pre.levels, ['01'])).toBe('Levels 01-01');
    expect(levelsTitle(pre.levels, [])).toBe('Levels');
  });
});

describe('request body', () => {
  it('sends only what narrows the export, tabs in workbook order', () => {
    expect(workbookBody('p', { levels: 'all', tabs: ['Devices', 'Connections', 'Punch List', 'Missing Parts', 'Photo Log'] })).toEqual({
      project_id: 'p', kind: 'xlsx',
    });
    expect(workbookBody('p', { levels: ['06M'], tabs: ['Punch List', 'Devices'] })).toEqual({
      project_id: 'p', kind: 'xlsx', params: { levels: ['06M'], tabs: ['Devices', 'Punch List'] },
    });
  });
});

describe('floor PDF', () => {
  it('sends the level and only a narrowed section list; the header is the date only', () => {
    expect(floorBody('p', '06M', ['plan', 'findings', 'connections', 'punch', 'parts', 'photos'])).toEqual({
      project_id: 'p', kind: 'floor_pdf', params: { level: '06M' },
    });
    expect(floorBody('p', '06M', ['punch', 'plan'])).toEqual({ project_id: 'p', kind: 'floor_pdf', params: { level: '06M', sections: ['plan', 'punch'] } });
    expect(floorHeader({ id: 'x', code: '06M', surveyed: '2026-10-08' })).toBe('ETC Lighting Controls Survey — Level 06M · Surveyed 2026-10-08');
    expect(floorHeader({ id: 'x', code: '07', surveyed: null, lastSurvey: '2026-10-12' })).toBe('ETC Lighting Controls Survey — Level 07 · Surveyed 2026-10-12');
    expect(floorHeader({ id: 'x', code: '07', surveyed: null }, undefined, '2026-10-13')).toBe('ETC Lighting Controls Survey — Level 07 · Surveyed 2026-10-13');
    const pdf = row({ kind: 'floor_pdf', filename: 'ETC_Lighting_Controls_Survey_Level_06M_1.pdf', stats: { levels: ['06M'] }, params: { level: '06M', sections: ['plan', 'photos'] } });
    expect(scopeLine(pdf)).toBe('Level 06M · Plan snapshot with pins, Photo appendix');
    expect(diffLine(pdf)).toBeNull();
    expect(shareName(pdf)).toBe('ETC_Lighting_Controls_Survey_Level_06M_1.pdf');
  });
});

describe('history', () => {
  it('labels each export with its time, scope, state and the diff vs the previous one', () => {
    expect(exportTime('2026-10-12T14:05:00Z', 'en-GB')).toMatch(/^Exported 12 Oct 2026, \d\d:\d\d$/);
    expect(exportTime(null)).toBe('Export time unknown');
    expect(jobLine(row())).toBe('Ready · 1.1 MB');
    expect(jobLine(row({ job_state: 'queued' }))).toMatch(/^Queued/);
    expect(jobLine(row({ job_state: 'failed', stats: { error: 'unknown project' } }))).toBe('Failed: unknown project');
    expect(scopeLine(row())).toBe('Levels B2-06M · all tabs');
    expect(scopeLine(row({ stats: { levels: ['06M'] }, params: { levels: ['06M'], tabs: ['Devices'] } }))).toBe('Level 06M · Devices');
    expect(scopeLine(row({ stats: null, params: { scheduled: true } }))).toBe('all in-scope levels · all tabs · daily backup');

    expect(diffLine(row())).toBe('First export: nothing to compare with');
    const d = row({
      diff_summary: {
        previous: 'e0',
        tabs: {
          Devices: { rows: 210, added: 2, removed: 0, changed: 1, examples: ['B2 B2-06', 'B2 B2-07', 'B2 B2-01'] },
          Connections: { rows: 107, added: 0, removed: 1, changed: 0, examples: ['01 C-03'] },
          'Punch List': { rows: 215, added: 0, removed: 0, changed: 0, examples: [] },
        },
      },
    });
    expect(diffLine(d)).toBe('Diff vs previous export: +2 rows, −1 row, 1 changed');
    expect(diffDetail(d)).toEqual(['Devices: +2 −0 ~1 (e.g. B2 B2-06, B2 B2-07, B2 B2-01)', 'Connections: +0 −1 ~0 (e.g. 01 C-03)']);
    expect(diffLine(row({ diff_summary: { tabs: { Devices: { rows: 1, added: 0, removed: 0, changed: 0, examples: [] } } } }))).toBe(
      'Diff vs previous export: no changes',
    );
    expect(diffLine(row({ diff_summary: { note: 'previous export has no file' } }))).toMatch(/no file/);
    expect(shareName(row({ filename: 'a/b:c.xlsx' }))).toBe('a_b_c.xlsx');
    expect(shareName(row({ filename: null, kind: 'floor_pdf' }))).toBe('export-e1.pdf');
  });

  it('keeps the last history list and the downloaded files for offline use (D94)', async () => {
    const store = await Store.open(new BetterSqliteDriver(), { installId: 'i', search: 'like' });
    expect(await cachedHistory(store, 'p')).toEqual([]);
    await rememberHistory(store, 'p', [row(), row({ id: 'e0' })]);
    expect((await cachedHistory(store, 'p')).map((r) => r.id)).toEqual(['e1', 'e0']);
    expect(await cachedHistory(store, 'other')).toEqual([]);
    await rememberDownload(store, 'e1', 'exports/e1/x.xlsx');
    await rememberDownload(store, 'e0', 'exports/e0/y.xlsx');
    expect(await downloadedExports(store)).toEqual({ e1: 'exports/e1/x.xlsx', e0: 'exports/e0/y.xlsx' });
  });
});

describe('a running export (T93, D166)', () => {
  const T0 = Date.parse('2026-10-14T14:05:00Z');
  const running = (over: Partial<ExportRow> = {}) =>
    row({ id: 'r1', job_state: 'running', blob: null, filename: null, created_by: 'Landry', created_at: '2026-10-14T14:05:00Z', stats: { started_at: '2026-10-14T14:05:00Z', stage: 'Photo Log', done: 3200, total: 10000, unit: 'pictures' }, ...over });

  it('shows the stage, the counts and the time since it started', () => {
    expect(progressLine(running(), T0 + 252_000)).toBe('Photo Log 3,200 / 10,000 pictures · 4 min 12 s');
    expect(progressLine(running({ stats: { started_at: '2026-10-14T14:05:00Z', stage: 'Writing the workbook' } }), T0 + 45_000)).toBe('Writing the workbook · 45 s');
    expect(progressLine(running({ job_state: 'queued', stats: null }), T0 + 8_000)).toBe('Queued 8 s — waiting for the server');
    expect(progressLine(running({ cancel_requested_at: '2026-10-14T14:06:00Z', cancelled_by: 'Zach' }), T0)).toMatch(/^Cancelling \(Zach\)/);
    expect(progressLine(row(), T0)).toBeNull();
    expect(elapsed('2026-10-14T14:05:00Z', T0 + 3_780_000)).toBe('1 h 03 min');
    expect(jobLine(row({ job_state: 'cancelled', cancelled_by: 'Zach' }))).toBe('Cancelled by Zach');
  });

  it('names the running export on Generate', () => {
    const at = new Date('2026-10-14T14:05:00Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(busyLine(running(), 'en-GB')).toBe(`An export is already running (started by Landry ${at})`);
    expect(busyLine(running({ job_state: 'queued', params: { scheduled: true }, created_by: 'export' }))).toMatch(/^An export is already queued \(started by the daily backup /);
  });

  it('re-attaches to the queued or running export from the server list, whoever started it', () => {
    const pdf = running({ id: 'p1', kind: 'floor_pdf', created_by: 'Zach' });
    const old = row({ id: 'e0' });
    // a fresh screen (or another iPad) finds both running cards
    expect(attachJobs({}, [pdf, running(), old])).toEqual({ xlsx: running(), floor_pdf: pdf });
    // nothing running: no card, unless this screen showed one, which is refreshed from the list
    expect(attachJobs({}, [old])).toEqual({});
    const doneNow = row({ id: 'r1', job_state: 'done' });
    expect(attachJobs({ xlsx: running() }, [doneNow, old])).toEqual({ xlsx: doneNow });
    expect(isActive(running())).toBe(true);
    expect(isActive(doneNow)).toBe(false);
  });

  it('turns a refused Generate (409 export_running) into that export', () => {
    const err = new TransportError('rejected', 'POST /exports → 409', 409, { detail: { error: 'export_running', export: running() } });
    expect(runningFrom(err)?.id).toBe('r1');
    expect(runningFrom(new TransportError('rejected', 'x', 422, { detail: 'bad' }))).toBeNull();
    expect(runningFrom(new Error('offline'))).toBeNull();
  });
});
