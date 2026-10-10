/**
 * Opt-in: the blob queue + `HttpBlobTransport` against the real server (FastAPI + S3), including
 * a kill between chunks (TP-2) and a second iPad downloading the result. Runs only when
 * FIELD_SURVEY_E2E_URL and FIELD_SURVEY_E2E_TOKEN are set — the same switch as the twin-client
 * harness (T14, packages/core/docs/e2e.md), which brings the server up in Docker:
 *
 *   cd server && docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build postgres s3 api
 *   FIELD_SURVEY_E2E_URL=http://127.0.0.1:8010 FIELD_SURVEY_E2E_TOKEN=e2e pnpm --filter @field-survey/core test:e2e
 *
 * Runs in the CI `e2e` job.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { BlobQueue } from './blobs';
import { HttpBlobTransport } from './http-blob-transport';
import { BetterSqliteDriver } from './node';
import { Store } from './store';
import { NodeBlobFiles, readRange, sha256 } from './testing/fake-blob-server';

const URL_ = process.env.FIELD_SURVEY_E2E_URL;
const TOKEN = process.env.FIELD_SURVEY_E2E_TOKEN;
const dir = mkdtempSync(join(tmpdir(), 'blobs-e2e-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function transport(): HttpBlobTransport {
  return new HttpBlobTransport({
    serverUrl: URL_!,
    token: TOKEN!,
    userName: 'e2e',
    readRange,
    writeFile: async (p, b) => {
      mkdirSync(dirname(p), { recursive: true });
      await writeFile(p, b);
    },
  });
}

describe.skipIf(!URL_ || !TOKEN)('blobs against the real server', () => {
  it('uploads with a kill between chunks, resumes, and another iPad downloads the same bytes', async () => {
    const data = new Uint8Array(5 * 1024 * 1024 + 4321);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + Date.now()) % 256;
    const sha = sha256(data);
    const files = new NodeBlobFiles(join(dir, 'a'));
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(files.pathFor(sha, 'image'), data);
    const dbPath = join(dir, 'a.db');

    // iPad A, first launch: killed after chunk 1 was sent.
    const d1 = new BetterSqliteDriver(dbPath);
    const s1 = await Store.open(d1, { installId: 'a', search: 'like' });
    const t1 = transport();
    let fired!: () => void;
    const killed = new Promise<void>((r) => (fired = r));
    const realPut = t1.putChunk.bind(t1);
    t1.putChunk = async (s, n, src) => {
      await realPut(s, n, src);
      if (n === 1) {
        fired();
        return new Promise<void>(() => {});
      }
    };
    const q1 = new BlobQueue(s1, t1, files, { log: () => {} });
    await q1.addLocal({ sha256: sha, kind: 'image', path: files.pathFor(sha, 'image'), size: data.length, mime: 'image/jpeg' });
    void q1.run();
    await killed;
    d1.close();
    const mid = await transport().status(sha);
    expect(mid).toMatchObject({ upload_state: 'partial', chunks_received: [0, 1], chunks_total: 3 });

    // iPad A, relaunch.
    const d2 = new BetterSqliteDriver(dbPath);
    const q2 = new BlobQueue(await Store.open(d2, { installId: 'a', search: 'like' }), transport(), files, { log: () => {} });
    expect(await q2.run()).toMatchObject({ outcome: 'ran', uploaded: 1 });
    expect(await transport().status(sha)).toMatchObject({ upload_state: 'complete' });
    d2.close();

    // iPad B: full-size on demand.
    const filesB = new NodeBlobFiles(join(dir, 'b'));
    const qB = new BlobQueue(await Store.open(new BetterSqliteDriver(), { installId: 'b', search: 'like' }), transport(), filesB, { log: () => {} });
    const path = await qB.ensureLocal(sha, 'image');
    expect(path).not.toBeNull();
    expect(sha256(new Uint8Array(await readFile(path!)))).toBe(sha);
  }, 60_000);
});
