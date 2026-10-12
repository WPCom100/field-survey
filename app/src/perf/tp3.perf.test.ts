/**
 * TP-3 on the PC (T32): a fresh "iPad" (core store on better-sqlite3, the real `SyncEngine`,
 * `HttpTransport`, `BlobQueue`) pulls the synthetic project from a running server, then the
 * plan view's and side lists' read models load its densest level, then the thumbnail prefetch
 * runs to the end. Timings are printed for `docs/perf/tp3.md`; the iPad's own numbers (Hermes,
 * expo-sqlite, Wi-Fi) come from the on-device checklist.
 *
 * Opt-in, skipped with this reason otherwise:
 *   FIELD_SURVEY_TP3_URL=http://127.0.0.1:8011 FIELD_SURVEY_TP3_TOKEN=<token>
 *   FIELD_SURVEY_TP3_PROJECT=<id from python -m app.jobs.synthetic> pnpm --filter app exec vitest run src/perf
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BlobQueue, HttpBlobTransport, HttpTransport, Store, SyncEngine, rememberProjects } from '@field-survey/core';
import { BetterSqliteDriver, NodeBlobFiles } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { loadLevelPlan } from '../plan/data';
import { loadLevelLists, searchIds } from '../plan/lists';

const URL_ = process.env.FIELD_SURVEY_TP3_URL ?? '';
const TOKEN = process.env.FIELD_SURVEY_TP3_TOKEN ?? '';
const PROJECT = process.env.FIELD_SURVEY_TP3_PROJECT ?? '';
const USER = process.env.FIELD_SURVEY_TP3_USER ?? 'Landry';
const ENABLED = !!(URL_ && TOKEN && PROJECT);

const ms = (t0: number) => Math.round(performance.now() - t0);

describe.skipIf(!ENABLED)('TP-3 synthetic project on the PC (set FIELD_SURVEY_TP3_URL/_TOKEN/_PROJECT)', () => {
  it('pulls, opens the densest level and prefetches every thumbnail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp3-'));
    const out: Record<string, unknown> = {};
    let driver: BetterSqliteDriver | null = null;
    try {
      // 1. first pull of the whole project into a file-backed store (as an iPad's first sync)
      driver = new BetterSqliteDriver(join(dir, 'tp3.db'));
      const store = await Store.open(driver, { installId: 'tp3', search: 'auto' });
      await rememberProjects(store, [PROJECT]);
      const engine = new SyncEngine(store, new HttpTransport({ serverUrl: URL_, token: TOKEN, userName: USER }), { log: () => undefined });
      let t0 = performance.now();
      const r = await engine.requestSync();
      expect(r.outcome).toBe('ran');
      out.pull = { ops: r.pulled, ms: ms(t0) };

      // 2. the densest level: plan read model, then the four side lists, then a search
      const levels = await store.db.query<{ id: string; level: string; n: number }>(
        `SELECT l.id, l.level, count(d.id) AS n FROM level l JOIN device d ON d.level_id = l.id
          WHERE l.project_id = ? AND d.deleted_at IS NULL GROUP BY l.id ORDER BY n DESC`,
        [PROJECT],
      );
      const dense = levels[0]!;
      t0 = performance.now();
      const plan = (await loadLevelPlan(store, dense.id))!;
      out.loadLevelPlan = { level: dense.level, devices: plan.devices.length, ms: ms(t0) };
      t0 = performance.now();
      const lists = await loadLevelLists(store, PROJECT, dense.id, dense.level, plan.devices);
      out.loadLevelLists = {
        connections: lists.connections.length,
        punch: lists.punch.length,
        parts: lists.parts.length,
        ms: ms(t0),
      };
      t0 = performance.now();
      const hits = await searchIds(store, dense.id, 'Run', lists.connections);
      out.search = { term: 'Run', hits: hits?.size ?? 0, ms: ms(t0) };

      // 3. prefetch: every in-scope level's sheet + thumbnails (no assignments, D97)
      const [me] = await store.db.query<{ id: string }>(`SELECT DISTINCT user_id AS id FROM op WHERE project_id = ? LIMIT 1`, [PROJECT]);
      const queue = new BlobQueue(store, new HttpBlobTransport({
          serverUrl: URL_,
          token: TOKEN,
          userName: USER,
          writeFile: async (p, b) => {
            mkdirSync(dirname(p), { recursive: true });
            await writeFile(p, b);
          },
        }), new NodeBlobFiles(join(dir, 'blobs')), {
        userId: () => me?.id ?? null,
        log: () => undefined,
      });
      t0 = performance.now();
      let downloaded = 0;
      for (let i = 0; i < 100; i++) {
        const rep = await queue.run();
        downloaded += rep.downloaded;
        if (rep.outcome !== 'ran') console.log(`[tp3] blob queue: ${JSON.stringify(rep)}`);
        if (rep.downloaded === 0) break;
      }
      const [thumbs] = await store.db.query<{ n: number }>(`SELECT count(*) AS n FROM photo WHERE thumb_blob IS NOT NULL AND deleted_at IS NULL`, []);
      const states = await store.db.query<{ state: string; n: number; err: string | null }>(
        `SELECT state, count(*) AS n, max(last_error) AS err FROM blob_queue WHERE direction = 'download' GROUP BY state`,
        [],
      );
      out.prefetch = { downloaded, thumbnails: thumbs?.n, ms: ms(t0), queue: states };
      console.log(`[tp3] ${JSON.stringify(out)}`);
      expect(downloaded).toBeGreaterThanOrEqual(Number(thumbs?.n ?? 0));
    } finally {
      driver?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_600_000);
});
