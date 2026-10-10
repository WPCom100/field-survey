/**
 * Twin-client harness (T14): two core stores on `BetterSqliteDriver`, each driving the real
 * `SyncEngine` + `HttpTransport`, against the FastAPI server in Docker. Opt-in through
 * FIELD_SURVEY_E2E_URL / FIELD_SURVEY_E2E_TOKEN (packages/core/docs/e2e.md); without them every
 * e2e test is skipped with a reason, never passed silently.
 *
 * Server-side setup goes through the compose files (`exec -T api python -m app.seed`,
 * `restart api`): FIELD_SURVEY_E2E_COMPOSE overrides the compose command, FIELD_SURVEY_E2E_SEED
 * the seed command, FIELD_SURVEY_E2E_RESTART the restart command (`skip` skips restart tests).
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'vitest';

import { BetterSqliteDriver } from '../better-sqlite-driver';
import { Editor, type EditContext } from '../editor';
import { HttpClient } from '../http';
import { HttpTransport } from '../http-transport';
import { uuidv7 } from '../ids';
import type { Op, StoredOp } from '../op';
import type { EntityKind } from '../schema/entities';
import { Store } from '../store';
import { SyncEngine, type SyncEngineOptions } from '../sync';

const execFileAsync = promisify(execFile);

export const URL_ = process.env.FIELD_SURVEY_E2E_URL ?? '';
export const TOKEN = process.env.FIELD_SURVEY_E2E_TOKEN ?? '';
export const ENABLED = URL_.length > 0 && TOKEN.length > 0;
export const SKIP_REASON = 'set FIELD_SURVEY_E2E_URL and FIELD_SURVEY_E2E_TOKEN to run against the Docker server';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COMPOSE = (
  process.env.FIELD_SURVEY_E2E_COMPOSE ??
  'docker compose -f server/docker-compose.yml -f server/docker-compose.e2e.yml'
).split(/\s+/);
const SEED = process.env.FIELD_SURVEY_E2E_SEED?.split(/\s+/) ?? [...COMPOSE, 'exec', '-T', 'api', 'python', '-m', 'app.seed'];
const RESTART = process.env.FIELD_SURVEY_E2E_RESTART?.split(/\s+/) ?? [...COMPOSE, 'restart', 'api'];
export const RESTART_ENABLED = process.env.FIELD_SURVEY_E2E_RESTART !== 'skip';

export const CTX: EditContext = { change_type: 'Field survey', reason: 'twin harness' };

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(cmd: string[]): Promise<string> {
  const [bin, ...args] = cmd;
  const { stdout } = await execFileAsync(bin!, args, { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 1 << 20 });
  return stdout;
}

// ------------------------------------------------------------------ server

export interface Seeded {
  project_id: string;
  groups: Record<string, string>;
}

/** `python -m app.seed project <name> <groups…>` inside the api container (D89). */
export async function seedProject(name: string, groups: string[]): Promise<Seeded> {
  const out = await run([...SEED, 'project', name, ...groups]);
  return JSON.parse(out.trim().split('\n').pop()!) as Seeded;
}

/** `docker compose restart api`: the server goes away for a few seconds. */
export async function restartApi(): Promise<void> {
  await run(RESTART);
}

export function http(userName: string, fetchImpl?: typeof fetch): HttpClient {
  return new HttpClient({ serverUrl: URL_, token: TOKEN, userName, fetch: fetchImpl });
}

/** `POST /team` → the interim user's id (T60); the same name always maps to the same id. */
export async function teamMember(name: string): Promise<string> {
  const r = await http(name).json<{ id: string; name: string }>('POST', '/team', { name });
  return r.id;
}

export async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await http('harness').json<{ status: string }>('GET', '/health');
      return;
    } catch (e) {
      if (Date.now() > end) throw new Error(`server at ${URL_} not healthy after ${timeoutMs} ms: ${String(e)}`);
      await sleep(250);
    }
  }
}

/** Every op of a project from the server, oldest first, through the real pull endpoint. */
export async function serverOps(projectId: string): Promise<Op[]> {
  const t = new HttpTransport({ serverUrl: URL_, token: TOKEN, userName: 'harness' });
  const out: Op[] = [];
  let since = 0;
  for (;;) {
    const page = await t.pull(projectId, since, 500);
    out.push(...page.ops);
    if (!page.has_more) return out;
    since = page.ops[page.ops.length - 1]!.server_seq!;
  }
}

/** PLAN §3.2 / TP-7: `server_seq` is 1..n with no gaps and every `op_id` appears once. */
export function expectGapFree(ops: Op[]): void {
  const seqs = ops.map((o) => o.server_seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  expect(new Set(ops.map((o) => o.op_id)).size).toBe(ops.length);
}

// ----------------------------------------------------------- fetch wrappers

/**
 * Network flap injection around the real `fetch`: while `down()` says so every request fails
 * before it is sent; every `loseResponseEvery`-th POST reaches the server but its response is
 * thrown away (the client never hears back and must resend — the duplicate path).
 */
export class Flapper {
  calls = 0;
  dropped = 0;
  lostResponses = 0;
  active = true;
  private posts = 0;
  private readonly real: typeof fetch = globalThis.fetch;

  constructor(
    private readonly opts: { down?: () => boolean; loseResponseEvery?: number; onPost?: (n: number) => void } = {},
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    this.calls++;
    if (this.active && this.opts.down?.()) {
      this.dropped++;
      throw new TypeError('fetch failed: network flap');
    }
    const isPost = (init?.method ?? 'GET') === 'POST';
    if (isPost) {
      this.posts++;
      this.opts.onPost?.(this.posts);
    }
    const res = await this.real(input, init);
    if (this.active && isPost && this.opts.loseResponseEvery && this.posts % this.opts.loseResponseEvery === 0) {
      this.lostResponses++;
      await res.arrayBuffer().catch(() => undefined);
      throw new TypeError('socket hang up: response lost');
    }
    return res;
  };
}

/** Down 40 % of the time in 300 ms cycles (the "flap every 10 s" of TP-7 scaled to a test). */
export function squareWave(periodMs = 300, dutyDown = 0.4): () => boolean {
  const t0 = Date.now();
  return () => ((Date.now() - t0) % periodMs) / periodMs < dutyDown;
}

// ------------------------------------------------------------------ clients

export interface Client {
  name: string;
  userId: string;
  installId: string;
  store: Store;
  editor: Editor;
  engine: SyncEngine;
  transport: HttpTransport;
  flapper: Flapper | null;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  flapper?: Flapper;
  engine?: SyncEngineOptions;
  dbPath?: string;
}

/** A fresh iPad: its own SQLite file (or memory), the project row seeded locally, real transport. */
export async function openClient(name: string, projectId: string, opts: ClientOptions = {}): Promise<Client> {
  const userId = await teamMember(name);
  const installId = uuidv7();
  const store = await Store.open(new BetterSqliteDriver(opts.dbPath), { installId, search: 'like' });
  await seedProjectRow(store, projectId, userId);
  const transport = new HttpTransport({
    serverUrl: URL_,
    token: TOKEN,
    userName: name,
    fetch: opts.flapper?.fetch ?? opts.fetch,
  });
  const engine = new SyncEngine(store, transport, {
    backoffMs: 50,
    maxBackoffMs: 200,
    log: () => undefined,
    ...opts.engine,
  });
  const editor = new Editor(store, { projectId, userId });
  return { name, userId, installId, store, editor, engine, transport, flapper: opts.flapper ?? null };
}

/** The project row exists locally (T41 will deliver it at sign-in; here it is seeded, D89). */
export async function seedProjectRow(store: Store, projectId: string, userId: string): Promise<void> {
  await store.applyRemote({
    op_id: uuidv7(),
    project_id: projectId,
    user_id: userId,
    install_id: uuidv7(),
    client_ts: new Date().toISOString(),
    entity_kind: 'project',
    entity_id: projectId,
    kind: 'create',
    payload: { name: 'Twin harness' },
    change_type: 'Master edit',
    server_seq: 0,
    server_ts: new Date().toISOString(),
    state: 'applied',
  } as Op);
}

/** `ResolveOptions.userName` for the clients' users (the iPad has no `app_user` rows yet). */
export function namesOf(...clients: Client[]): (userId: string) => string | undefined {
  return (id) => clients.find((c) => c.userId === id)?.name;
}

/** One sync that must succeed. */
export async function sync(...clients: Client[]): Promise<void> {
  for (const c of clients) {
    const r = await c.engine.requestSync();
    if (r.outcome !== 'ran') throw new Error(`${c.name}: sync ${r.outcome}: ${r.error ?? ''}`);
  }
}

/** Keep syncing through failures until the outbox is empty and a cycle succeeded. */
export async function drain(c: Client, timeoutMs = 60_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  const seen = new Map<string, number>();
  let attempts = 0;
  for (;;) {
    attempts++;
    const r = await c.engine.requestSync();
    const key = `${r.outcome}${r.error ? ': ' + r.error : ''} (pushed ${r.pushed}, pulled ${r.pulled})`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (r.outcome === 'ran' && (await c.store.outboxCount()) === 0) return attempts;
    if (Date.now() > end) {
      const detail = [...seen].map(([k, n]) => `${n}× ${k}`).join('; ');
      throw new Error(
        `${c.name}: outbox not drained after ${timeoutMs} ms (${attempts} attempts, ${await c.store.outboxCount()} left; ${detail})`,
      );
    }
    await sleep(100);
  }
}

/** The outbox as the engine would send it (no local-only columns). */
export async function outboxBody(c: Client, projectId: string): Promise<{ project_id: string; since: number; ops: Op[] }> {
  const ops = await c.store.outbox(projectId, 500);
  return {
    project_id: projectId,
    since: (await c.store.getState<number>(`last_server_seq:${projectId}`)) ?? 0,
    ops: ops.map((o: StoredOp) => {
      const out: Op = { ...o };
      delete out.server_seq;
      delete out.server_ts;
      delete out.state;
      return out;
    }),
  };
}

// --------------------------------------------------------------------- world

export interface World {
  projectId: string;
  groups: Record<string, string>;
  levels: { L06: string; L06M: string; L07: string };
}

/**
 * A fresh project on the server with levels 06 and 06M on one numbering group (D33) and 07 on
 * its own, created by Ann (client A) through ordinary ops and pulled by Bob (client B).
 */
export async function makeWorld(
  optsA: ClientOptions = {},
  optsB: ClientOptions = {},
): Promise<{ a: Client; b: Client; w: World }> {
  const seeded = await seedProject('Twin harness', ['06/06M', '07']);
  const a = await openClient('Ann', seeded.project_id, optsA);
  const b = await openClient('Bob', seeded.project_id, optsB);
  const level = async (code: string, group: string) =>
    (await a.editor.create('level', { project_id: seeded.project_id, level: code, numbering_group_id: group }, CTX)).id;
  const L06 = await level('06', seeded.groups['06/06M']!);
  const L06M = await level('06M', seeded.groups['06/06M']!);
  const L07 = await level('07', seeded.groups['07']!);
  await sync(a, b);
  return { a, b, w: { projectId: seeded.project_id, groups: seeded.groups, levels: { L06, L06M, L07 } } };
}

/** A device with a display ID on a level (status Installed, untested by default). */
export async function newDevice(c: Client, levelId: string, displayId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { id } = await c.editor.create(
    'device',
    { level_id: levelId, display_id: displayId, category: 'Relay panel', status: 'Installed, untested', ...extra },
    CTX,
  );
  return id;
}

// --------------------------------------------------------------- convergence

type Row = Record<string, unknown>;

const CONVERGENCE_KINDS: EntityKind[] = ['level', 'device', 'punch_item', 'missing_part', 'photo', 'cable', 'cable_end', 'review_item'];

function canon(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'version') continue; // local applies and remote applies count differently on a reviewed field
    out[k] = v; // `deleted_at` included: the deleting iPad re-stamps it from the echo (T15)
  }
  return out;
}

async function rows(c: Client, kind: EntityKind): Promise<Row[]> {
  const list = await c.store.list<Row>(kind, { includeDeleted: true });
  return list.map(canon).sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

async function opLog(c: Client, projectId: string): Promise<[string, number | null, string][]> {
  const ops = await c.store.db.query<{ op_id: string; server_seq: number | null; state: string }>(
    `SELECT op_id, server_seq, state FROM op WHERE project_id = ? AND server_seq > 0 ORDER BY server_seq`,
    [projectId],
  );
  return ops.map((o) => [o.op_id, o.server_seq, o.state]);
}

/**
 * Both stores hold the same rows (every kind listed), the same field heads for `entityIds`
 * (default: every row of those kinds) and the same op log (op_id, server_seq, state) as the
 * server, whose log is gap-free. `except` names entities whose rows/heads are expected to differ
 * (a field still in review on one iPad keeps that iPad's own value, PLAN §3.2).
 */
export async function expectConverged(
  a: Client,
  b: Client,
  projectId: string,
  opts: { except?: string[]; kinds?: EntityKind[] } = {},
): Promise<Op[]> {
  const except = new Set(opts.except ?? []);
  for (const kind of opts.kinds ?? CONVERGENCE_KINDS) {
    const ra = (await rows(a, kind)).filter((r) => !except.has(String(r.id)));
    const rb = (await rows(b, kind)).filter((r) => !except.has(String(r.id)));
    expect(rb, `${kind} rows differ between ${a.name} and ${b.name}`).toEqual(ra);
    for (const r of ra) {
      expect(await b.store.fieldHeads(String(r.id)), `${kind} ${r.id} heads`).toEqual(await a.store.fieldHeads(String(r.id)));
    }
  }
  const server = await serverOps(projectId);
  expectGapFree(server);
  const expected = server.map((o) => [o.op_id, o.server_seq, o.state]);
  expect(await opLog(a, projectId), `${a.name} op log vs server`).toEqual(expected);
  expect(await opLog(b, projectId), `${b.name} op log vs server`).toEqual(expected);
  expect(await a.store.outboxCount()).toBe(0);
  expect(await b.store.outboxCount()).toBe(0);
  return server;
}
