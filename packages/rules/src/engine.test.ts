/**
 * The engine over a store (T33): idempotent runs, decisions as ops with `rule_id` /
 * `proposal_id`, explain, the debounced trigger after a commit and after a pull, and two iPads
 * evaluating the same data converging on one proposal row without a review item.
 */

import { DebouncedTrigger, Editor, Store, SyncEngine, rememberProjects, uuidv7, type EditContext, type Op, type StoredOp } from '@field-survey/core';
import { BetterSqliteDriver, FakeServer } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from './engine';
import { proposalId, proposalKey } from './rule';
import type { ProposalRow } from './snapshot';
import { CABLE, END_A, END_B, FAR, GROUP, ISSUE_RULE, LEVEL, PANEL, PROJECT, RUN_RULE } from './testing/sample';

const ANN = uuidv7();
const BOB = uuidv7();
const CTX: EditContext = { change_type: 'Field survey', reason: 'test' };
let clock = 1_760_000_000_000;
const tsNext = () => new Date((clock += 1000)).toISOString();
let seq = 0;

type Row = Record<string, unknown>;

function seedOp(entity_kind: Op['entity_kind'], entity_id: string, payload: Row): Op {
  return {
    op_id: uuidv7(), project_id: PROJECT, user_id: ANN, install_id: 'seed', client_ts: tsNext(),
    entity_kind, entity_id, kind: 'create', payload, change_type: 'Master edit', server_seq: ++seq, server_ts: tsNext(), state: 'applied',
  };
}

/** The sample project as pulled ops (so it syncs like real data). */
function seedOps(): Op[] {
  return [
    seedOp('project', PROJECT, { name: 'Tower' }),
    seedOp('level', LEVEL, { project_id: PROJECT, level: '06M', numbering_group_id: GROUP, in_scope: true }),
    seedOp('numbering_group', GROUP, { project_id: PROJECT, label: '06/06M' }),
    seedOp('device', PANEL, { level_id: LEVEL, display_id: '06M-01', category: 'Relay panel' }),
    seedOp('device', FAR, { level_id: LEVEL, display_id: '06M-03', category: 'Relay panel' }),
    seedOp('cable', CABLE, { project_id: PROJECT, cable: 'X', end_a_id: END_A, end_b_id: END_B }),
    seedOp('cable_end', END_A, { cable_id: CABLE, side: 'A', endpoint_kind: 'device', device_id: PANEL, level_id: LEVEL, to_text: 'DMX to 06M-03', status: 'Not installed', note: 'Not run' }),
    seedOp('cable_end', END_B, { cable_id: CABLE, side: 'B', endpoint_kind: 'device', device_id: FAR, level_id: LEVEL, from_text: 'DMX from 06M-01' }),
  ];
}

/**
 * `remote`: the sample project arrives as pulled ops (no server in the test). `local`: the
 * same rows made on this iPad, to be pushed to the fake server. `none`: a fresh iPad that
 * learnt the project id from `GET /projects` (D127) and pulls everything.
 */
async function client(server: FakeServer | null, user: string, seed: 'remote' | 'local' | 'none' = 'remote') {
  const store = await Store.open(new BetterSqliteDriver(), { installId: uuidv7(), search: 'like' });
  const editor = new Editor(store, { projectId: PROJECT, userId: user, now: tsNext });
  if (seed === 'remote') await store.applyRemoteMany(seedOps());
  else if (seed === 'local') {
    await editor.group({ change_type: 'Master edit', reason: 'seed' }, async (g) => {
      for (const o of seedOps()) await g.create(o.entity_kind, { id: o.entity_id, ...o.payload });
    });
  } else await rememberProjects(store, [PROJECT]);
  const engine = new RuleEngine(store, { projectId: PROJECT, userId: user, rules: [RUN_RULE, ISSUE_RULE], now: tsNext });
  const sync = new SyncEngine(store, server, { log: () => {} });
  return { store, editor, engine, sync };
}

const KEY = proposalKey('T.run', { entity_kind: 'cable_end', entity_id: END_A });
const PID = proposalId(PROJECT, KEY);

describe('RuleEngine.run', () => {
  it('writes the proposals and findings once; a second run over the same data writes nothing', async () => {
    const c = await client(null, ANN);
    const r1 = await c.engine.run();
    expect(r1).toMatchObject({ proposals: 1, findings: 0, created: 1, updated: 0, ops: 1, problems: 0 });
    const row = (await c.store.get<ProposalRow>('proposal', PID))!;
    expect(row).toMatchObject({ rule_id: 'T.run', state: 'proposed', kind: 'punch', discriminator: null, subject: { entity_kind: 'cable_end', entity_id: END_A, level_id: LEVEL } });
    expect(row.payload).toMatchObject({ item: 'Run X to 06M-03', why: 'DMX to 06M-03 is Not installed.' });
    const ops = await c.store.opsFor(PID);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'create', change_type: 'Field survey', reason: 'Rule engine', user_id: ANN });
    // idempotent
    const r2 = await c.engine.run();
    expect(r2).toMatchObject({ ops: 0, created: 0, updated: 0 });
    expect(await c.store.outboxCount()).toBe(1);
  });

  it('supersedes when the condition goes, re-proposes when it returns, raises and resolves findings', async () => {
    const c = await client(null, ANN);
    await c.engine.run();
    await c.editor.setField('cable_end', END_A, 'status', 'Issue', CTX);
    await c.editor.setField('device', PANEL, 'status', 'Issue', CTX);
    const r = await c.engine.run();
    expect(r).toMatchObject({ proposals: 0, findings: 1, created: 1, updated: 1 });
    expect((await c.store.get<ProposalRow>('proposal', PID))!.state).toBe('superseded');
    const findings = await c.engine.openFindings(LEVEL);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ lint_id: 'T.issue.none', state: 'open', level_id: LEVEL, message: '06M-01 is Issue with no open punch item' });
    expect((await c.engine.run()).ops).toBe(0);
    // an open punch item on the device resolves the finding; the end back to Not installed re-proposes
    await c.editor.create('punch_item', { level_id: LEVEL, device_id: PANEL, item: 'Fix it', tracking_status: 'Open' }, CTX);
    await c.editor.setField('cable_end', END_A, 'status', 'Not installed', CTX);
    const r2 = await c.engine.run();
    expect(r2).toMatchObject({ proposals: 1, findings: 0, updated: 2, created: 0 });
    expect((await c.store.get<ProposalRow>('proposal', PID))!.state).toBe('proposed');
    expect(await c.engine.openFindings(LEVEL)).toEqual([]);
    expect((await c.store.get<Row>('finding', findings[0]!.id))!.state).toBe('resolved');
  });

  it('serialises concurrent runs and runs once more when asked during a run', async () => {
    const c = await client(null, ANN);
    const [a, b] = await Promise.all([c.engine.run(), c.engine.run()]);
    expect(a).toBe(b);
    expect(a.ops).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.store.outboxCount()).toBe(1);
  });
});

describe('decisions', () => {
  it('Accept creates the record with rule_id/proposal_id and marks the row accepted, all in one group carrying proposal_id', async () => {
    const c = await client(null, ANN);
    await c.engine.run();
    const res = await c.engine.decide(PID, { kind: 'accept' });
    expect(res).toMatchObject({ state: 'accepted', recordIds: [expect.any(String)] });
    const item = (await c.store.get<Row>('punch_item', res.recordIds[0]!))!;
    expect(item).toMatchObject({ level_id: LEVEL, device_id: PANEL, cable_end_id: END_A, item: 'Run X to 06M-03', type: 'Cable not run', owner: 'EC', tracking_status: 'Open', rule_id: 'T.run', proposal_id: PID });
    expect(item).not.toHaveProperty('why');
    const row = (await c.store.get<ProposalRow>('proposal', PID))!;
    expect(row).toMatchObject({ state: 'accepted', decided_by_id: ANN });
    expect(row.decided_at).not.toBeNull();
    const ops = [...(await c.store.opsFor(res.recordIds[0]!)), ...(await c.store.opsFor(PID))].filter((o) => o.kind !== 'create' || o.entity_kind === 'punch_item');
    const groups = new Set(ops.map((o) => o.group_id));
    expect(groups.size).toBe(1);
    for (const o of ops) expect(o).toMatchObject({ proposal_id: PID, change_type: 'Field survey', reason: 'Accept T.run: Run X to 06M-03' });
    // the next run leaves the accepted row alone (the record cites it) and a second Accept is refused
    expect((await c.engine.run()).ops).toBe(0);
    await expect(c.engine.decide(PID, { kind: 'accept' })).rejects.toThrow(/Already accepted/);
    // the record deleted → the rule fires again → proposed again
    await c.editor.delete('punch_item', res.recordIds[0]!, { change_type: 'Correction', reason: 'wrong' });
    await c.engine.run();
    expect((await c.store.get<ProposalRow>('proposal', PID))!.state).toBe('proposed');
  });

  it('Edit-then-accept writes the edited record and marks the row edited; Reject keeps it rejected until the inputs change', async () => {
    const c = await client(null, ANN);
    await c.engine.run();
    const res = await c.engine.decide(PID, { kind: 'edit', payload: { item: 'Run X to 06M-03 (via ERP)', notes: 'short run' } });
    expect(res.state).toBe('edited');
    expect(await c.store.get<Row>('punch_item', res.recordIds[0]!)).toMatchObject({ item: 'Run X to 06M-03 (via ERP)', notes: 'short run', proposal_id: PID });
    const row = (await c.store.get<ProposalRow>('proposal', PID))!;
    expect(row.state).toBe('edited');
    expect(row.payload).toMatchObject({ item: 'Run X to 06M-03' }); // the rule's payload stays; the record holds the edit
    expect((await c.engine.run()).ops).toBe(0);

    // reject on a fresh client
    const d = await client(null, BOB);
    await d.engine.run();
    const rej = await d.engine.decide(PID, { kind: 'reject' });
    expect(rej).toMatchObject({ state: 'rejected', recordIds: [], ops: 3 });
    const ops = await d.store.opsFor(PID);
    expect(ops.at(-1)).toMatchObject({ kind: 'set', field: 'decided_at', proposal_id: PID, reason: 'Reject T.run: Run X to 06M-03' });
    expect((await d.engine.run()).ops).toBe(0);
    expect(await d.engine.openProposals([END_A])).toEqual([]);
    // the far device gets a new ID → the target changes → the proposal comes back
    await d.editor.setField('device', FAR, 'display_id', '06M-04', CTX);
    await d.engine.run();
    expect((await d.store.get<ProposalRow>('proposal', PID))).toMatchObject({ state: 'proposed', decided_by_id: null });
    expect((await d.engine.openProposals([PANEL, END_A])).map((p) => p.payload?.item)).toEqual(['Run X to 06M-04']);
  });

  it('refuses an unknown proposal and a payload that cannot become a record; explain() names the rule and the facts', async () => {
    const c = await client(null, ANN);
    await c.engine.run();
    await expect(c.engine.decide(uuidv7(), { kind: 'accept' })).rejects.toThrow(/Unknown proposal/);
    await expect(c.engine.decide(PID, { kind: 'edit', payload: { item: '' } })).rejects.toThrow(/needs item text/);
    expect(await c.store.get<ProposalRow>('proposal', PID)).toMatchObject({ state: 'proposed' });
    expect(await c.engine.explain(PID)).toBe(
      'T.run — Cable not run: An end marked Not installed gets a "Run <code> to <other end>" punch item for the EC.\nDMX to 06M-03 is Not installed.',
    );
    expect(await c.engine.explain(uuidv7())).toBeNull();
    // a proposal of a rule this build does not know (seeded, older app) still explains and accepts
    await c.editor.create('proposal', {
      id: uuidv7(), project_id: PROJECT, rule_id: 'R9', kind: 'part', subject: { entity_kind: 'device', entity_id: PANEL, level_id: LEVEL },
      payload: { part: 'DMX termination kit - 06M-03 run', owner: 'EC', why: 'demo' }, state: 'proposed',
    }, CTX);
    const legacy = (await c.engine.openProposals([PANEL])).find((p) => p.rule_id === 'R9')!;
    expect(await c.engine.explain(legacy.id)).toBe('Rule R9\ndemo');
    const r = await c.engine.decide(legacy.id, { kind: 'accept' });
    expect(await c.store.get<Row>('missing_part', r.recordIds[0]!)).toMatchObject({ part: 'DMX termination kit - 06M-03 run', part_status: 'Needed', rule_id: 'R9', level_id: LEVEL, device_id: PANEL });
  });
});

describe('trigger wiring (core DebouncedTrigger)', () => {
  it('runs after a commit and after a pull, not after its own proposal ops', async () => {
    const server = new FakeServer();
    const a = await client(server, ANN, 'local');
    const b = await client(server, BOB, 'none');
    await a.sync.sync();
    await b.sync.sync();
    const runs: string[] = [];
    const trigger = new DebouncedTrigger(b.store, { delayMs: 1 });
    trigger.start(async (projects, sources) => {
      runs.push([...sources].join('+'));
      for (const p of projects) if (p === PROJECT) await b.engine.run();
    });
    // Ann marks the far end Not installed too → a pull on Bob's iPad fires the trigger
    await a.editor.setField('cable_end', END_B, 'status', 'Not installed', CTX);
    await a.sync.sync();
    await b.sync.sync();
    await trigger.flush();
    expect(runs).toEqual(['remote']);
    expect((await b.engine.openProposals([END_A, END_B])).map((p) => p.payload?.item).sort()).toEqual(['Run X to 06M-01', 'Run X to 06M-03']);
    expect(trigger.fired).toBe(1); // the engine's own proposal creates did not re-fire it
    // a local commit fires it too
    await b.editor.setField('cable_end', END_B, 'status', 'Issue', CTX);
    await trigger.flush();
    expect(runs).toEqual(['remote', 'local']);
    expect((await b.engine.openProposals([END_A, END_B])).map((p) => p.payload?.item)).toEqual(['Run X to 06M-03']);
    trigger.stop();
  });
});

describe('two iPads (D169)', () => {
  it('make one proposal row with the same id; a decision on either applies without a review item', async () => {
    const server = new FakeServer();
    const a = await client(server, ANN, 'local');
    const b = await client(server, BOB, 'none');
    await a.sync.sync();
    await b.sync.sync();
    // both evaluate before either pushes: the same deterministic id on both
    await a.engine.run();
    await b.engine.run();
    expect(await a.store.get('proposal', PID)).not.toBeNull();
    expect(await b.store.get('proposal', PID)).not.toBeNull();
    await a.sync.sync();
    await b.sync.sync();
    await a.sync.sync();
    expect(server.log.filter((o) => o.entity_kind === 'proposal' && o.kind === 'create')).toHaveLength(2);
    expect((await a.store.list('proposal', { where: 'project_id = ?', params: [PROJECT] })).length).toBe(1);
    expect((await b.store.list('proposal', { where: 'project_id = ?', params: [PROJECT] })).length).toBe(1);
    // Bob (whose create arrived second) rejects: no conflict, Ann sees the rejection
    await b.engine.decide(PID, { kind: 'reject' });
    await b.sync.sync();
    await a.sync.sync();
    expect(server.log.filter((o) => o.entity_kind === 'review_item')).toEqual([]);
    expect((await a.store.get<ProposalRow>('proposal', PID))).toMatchObject({ state: 'rejected', decided_by_id: BOB });
    expect((await a.engine.run()).ops).toBe(0);
    expect((await b.engine.run()).ops).toBe(0);
    const states = (await a.store.opsFor(PID)).map((o: StoredOp) => o.state);
    expect(new Set(states)).toEqual(new Set(['applied']));
  });

  it('an Accept on one iPad shows as accepted on the other through the record alone', async () => {
    const server = new FakeServer();
    const a = await client(server, ANN, 'local');
    const b = await client(server, BOB, 'none');
    await a.sync.sync();
    await b.sync.sync();
    await a.engine.run();
    await b.engine.run();
    const res = await a.engine.decide(PID, { kind: 'accept' });
    // Only Ann's record syncs first (her proposal ops are in the same push; take the record's view
    // by running Bob's engine over a store that has the record but not the decision):
    await b.store.applyRemoteMany(
      (await a.store.opsFor(res.recordIds[0]!)).map((o, i) => ({ ...o, server_seq: 9000 + i, server_ts: tsNext(), state: 'applied' as const })),
    );
    await b.engine.run();
    expect(await b.store.get<ProposalRow>('proposal', PID)).toMatchObject({ state: 'accepted', decided_by_id: ANN });
    expect((await b.engine.run()).ops).toBe(0);
  });
});
