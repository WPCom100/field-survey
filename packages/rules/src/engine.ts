/**
 * The engine over a core `Store` (T33): load the snapshot, evaluate the rules, write the
 * differences as ops, and take the surveyor's decisions. Everything written goes through the
 * `Editor` (CLAUDE.md §5: no table writes from outside `Store.apply`):
 *
 * - a run writes one `Field survey` group (`reason: "Rule engine"`) with the proposal /
 *   finding creates and sets `reconcile.ts` computed; a run that finds nothing new writes
 *   nothing (idempotent);
 * - Accept / Edit write the record(s) of `decide.ts` and the proposal row's decision in one
 *   group whose ops carry `proposal_id`; the record carries `rule_id` and `proposal_id`;
 * - Reject writes the proposal row only.
 *
 * Runs are serialised per engine; a run requested during a run follows it.
 */

import { Editor, type EditContext, type Store } from '@field-survey/core';
import { acceptPlan, recordDiffers, DecideError } from './decide';
import { evaluate, type EvalOutput } from './evaluate';
import { applyChanges, reconcileFindings, reconcileProposals, type Change, type Citation } from './reconcile';
import type { Rule } from './rule';
import {
  emptySnapshot,
  indexSnapshot,
  type FindingRow,
  type MissingPartRow,
  type ProposalRow,
  type PunchItemRow,
  type Snapshot,
  type Subject,
} from './snapshot';

export type RuleLog = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void;

export interface RuleEngineOptions {
  projectId: string;
  /** The user stamped on the engine's ops and on decisions. */
  userId: string;
  rules: readonly Rule[];
  log?: RuleLog;
  now?: () => string;
}

export interface RunReport {
  proposals: number;
  findings: number;
  /** Ops written this run (0 = nothing changed). */
  ops: number;
  created: number;
  updated: number;
  /** Records a rule maintains without an Accept (D170) that changed this run. */
  upkeep: number;
  problems: number;
  ms: number;
}

export type Decision = { kind: 'accept' } | { kind: 'edit'; payload: Record<string, unknown> } | { kind: 'reject' };

export interface DecideResult {
  state: 'accepted' | 'edited' | 'rejected';
  /** Ids of the records created (punch item, part, cable…), in plan order. */
  recordIds: string[];
  ops: number;
}

const RUN_CTX: EditContext = { change_type: 'Field survey', reason: 'Rule engine' };

type Row = Record<string, unknown>;

export class RuleEngine {
  readonly editor: Editor;
  private readonly log: RuleLog;
  private readonly now: () => string;
  private running: Promise<RunReport> | null = null;
  private queued = false;
  readonly rules: readonly Rule[];

  constructor(
    readonly store: Store,
    readonly opts: RuleEngineOptions,
  ) {
    this.rules = opts.rules;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date().toISOString());
    this.editor = new Editor(store, { projectId: opts.projectId, userId: opts.userId, now: this.now });
  }

  get projectId(): string {
    return this.opts.projectId;
  }

  // -------------------------------------------------------------- snapshot

  /** Everything the rules read for this project, deleted rows included. */
  async loadSnapshot(): Promise<Snapshot> {
    const p = this.opts.projectId;
    const s = emptySnapshot(p);
    const levels = `level_id IN (SELECT id FROM level WHERE project_id = ?)`;
    const list = <T extends object>(kind: Parameters<Store['list']>[0], where: string, orderBy = 'id') =>
      this.store.list<T>(kind, { where, params: [p], includeDeleted: true, orderBy });
    s.project = (await this.store.get<Snapshot['project'] & object>('project', p)) ?? null;
    [
      s.levels,
      s.numberingGroups,
      s.devices,
      s.accessories,
      s.cables,
      s.cableEnds,
      s.placeholders,
      s.punchItems,
      s.missingParts,
      s.partSources,
      s.libraryTypes,
      s.vocab,
      s.proposals,
      s.findings,
    ] = await Promise.all([
      list<Snapshot['levels'][number]>('level', 'project_id = ?'),
      list<Snapshot['numberingGroups'][number]>('numbering_group', 'project_id = ?'),
      list<Snapshot['devices'][number]>('device', levels),
      list<Snapshot['accessories'][number]>('accessory', `device_id IN (SELECT d.id FROM device d JOIN level l ON l.id = d.level_id WHERE l.project_id = ?)`),
      list<Snapshot['cables'][number]>('cable', 'project_id = ?'),
      list<Snapshot['cableEnds'][number]>('cable_end', `cable_id IN (SELECT id FROM cable WHERE project_id = ?)`),
      list<Snapshot['placeholders'][number]>('placeholder', 'project_id = ?'),
      list<Snapshot['punchItems'][number]>('punch_item', levels),
      list<Snapshot['missingParts'][number]>('missing_part', levels),
      list<Snapshot['partSources'][number]>('part_source', `missing_part_id IN (SELECT id FROM missing_part WHERE ${levels})`, 'missing_part_id, target_kind, target_id'),
      list<Snapshot['libraryTypes'][number]>('library_type', 'project_id = ? OR project_id IS NULL'),
      list<Snapshot['vocab'][number]>('vocab', 'project_id = ?'),
      list<Snapshot['proposals'][number]>('proposal', 'project_id = ?'),
      list<Snapshot['findings'][number]>('finding', 'project_id = ?'),
    ]);
    // T36 lints: sheets (pin outside the sheet), unreviewed drafts (locked level), and only the
    // live photos whose device is deleted (deleted link) — not the project's thousands of photos.
    const [sheets, draftDevices, draftCables, photos] = await Promise.all([
      list<Row>('sheet', levels),
      this.store.list<Row>('draft_device', { where: `project_id = ? AND state = 'proposed'`, params: [p] }),
      this.store.list<Row>('draft_cable', { where: `project_id = ? AND state = 'proposed'`, params: [p] }),
      this.store.list<Row>('photo', {
        where: `${levels} AND device_id IN (SELECT id FROM device WHERE deleted_at IS NOT NULL)`,
        params: [p],
        orderBy: 'id',
      }),
    ]);
    s.sheets = sheets.map((r) => ({
      id: String(r.id),
      level_id: String(r.level_id),
      width_pt: typeof r.width_pt === 'number' ? r.width_pt : null,
      height_pt: typeof r.height_pt === 'number' ? r.height_pt : null,
      deleted_at: (r.deleted_at as string | null) ?? null,
    }));
    s.drafts = [
      ...draftDevices.map((r) => ({ id: String(r.id), kind: 'device' as const, level_id: (r.level_id as string | null) ?? null, state: String(r.state), deleted_at: null })),
      ...draftCables.map((r) => ({ id: String(r.id), kind: 'cable' as const, level_id: (r.level_id as string | null) ?? null, state: String(r.state), deleted_at: null })),
    ];
    s.photos = photos.map((r) => ({
      id: String(r.id),
      level_id: String(r.level_id),
      number: typeof r.number === 'number' ? r.number : null,
      device_id: (r.device_id as string | null) ?? null,
      deleted_at: null,
    }));
    return s;
  }

  // ------------------------------------------------------------------- run

  /** Evaluate and write the differences; serialised, so concurrent calls share or follow a run. */
  run(): Promise<RunReport> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.queued) {
        this.queued = false;
        void this.run();
      }
    });
    return this.running;
  }

  /** The pure half of a run (tests): the evaluation and the changes it implies, nothing written. */
  async plan(snap?: Snapshot): Promise<{ snap: Snapshot; out: EvalOutput; changes: Change[] }> {
    const s = snap ?? (await this.loadSnapshot());
    const index = indexSnapshot(s);
    const out = evaluate(s, this.rules, index, { now: this.now() });
    const maintained = new Map<string, Set<string>>();
    for (const u of out.upkeep) maintained.set(u.id, new Set([...(maintained.get(u.id) ?? []), ...Object.keys(u.fields)]));
    const citations = await this.citations(s, index.recordsByProposal, maintained);
    const changes = [
      ...reconcileProposals({ projectId: s.projectId, existing: s.proposals, output: out.proposals, ruleIds: out.ruleIds, citations }),
      ...reconcileFindings({ projectId: s.projectId, existing: s.findings, output: out.findings, lintIds: out.lintIds }),
    ];
    return { snap: s, out, changes };
  }

  private async runOnce(): Promise<RunReport> {
    const t0 = Date.now();
    const { out, changes } = await this.plan();
    for (const pr of out.problems) this.log('warn', `rule_${pr.kind}`, { rule: pr.rule_id, message: pr.message });
    let created = 0;
    let updated = 0;
    const ops = changes.length
      ? await this.editor.group(RUN_CTX, async (g) => {
          for (const c of changes) {
            if (c.kind === 'create') {
              await g.create(c.entity, { id: c.id, ...c.payload });
              created++;
            } else {
              const written = await g.setFields(c.entity, c.id, c.fields);
              if (written.length) updated++;
            }
          }
        })
      : [];
    // Upkeep (D170): one group per maintained record, reason naming the rule, so History reads
    // "Rule engine R3c" on the item. A record that already holds the values writes nothing.
    let upkeep = 0;
    let upkeepOps = 0;
    for (const u of out.upkeep) {
      try {
        const written = await this.editor.group({ change_type: 'Field survey', reason: `Rule engine ${u.rule_id}`, proposal_id: u.proposal_id }, (g) =>
          g.setFields(u.entity, u.id, u.fields),
        );
        if (written.length) {
          upkeep++;
          upkeepOps += written.length;
        }
      } catch (e) {
        this.log('warn', 'upkeep_failed', { rule: u.rule_id, entity: u.entity, id: u.id, message: String((e as Error)?.message ?? e) });
      }
    }
    const report: RunReport = {
      proposals: out.proposals.length,
      findings: out.findings.length,
      ops: ops.length + upkeepOps,
      created,
      updated,
      upkeep,
      problems: out.problems.length,
      ms: Date.now() - t0,
    };
    this.log(ops.length ? 'info' : 'info', 'run', { project: this.projectId, rules: this.rules.length, ...report });
    return report;
  }

  /**
   * Live records citing a proposal (punch items and parts with `proposal_id`): who created
   * them and when, from the record's create op, and whether their content differs from the
   * payload (an Edit). Only rows whose proposal is not already decided cost a query.
   */
  private async citations(
    s: Snapshot,
    byProposal: Map<string, (PunchItemRow | MissingPartRow)[]>,
    maintained: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  ): Promise<Map<string, Citation>> {
    const out = new Map<string, Citation>();
    const rows = new Map(s.proposals.map((p) => [p.id, p] as const));
    for (const [proposalId, records] of byProposal) {
      const row = rows.get(proposalId);
      const record = records[0] as unknown as Row;
      const edited = row ? recordDiffers(row, record, maintained.get(record.id as string)) : false;
      if (row && (row.state === 'accepted' || row.state === 'edited') && row.decided_by_id) {
        out.set(proposalId, { edited, decided_by_id: row.decided_by_id, decided_at: row.decided_at });
        continue;
      }
      const create = (await this.store.opsFor(record.id as string)).find((o) => o.kind === 'create');
      out.set(proposalId, { edited, decided_by_id: create?.user_id ?? null, decided_at: create?.client_ts ?? null });
    }
    return out;
  }

  // -------------------------------------------------------------- decisions

  async decide(proposalId: string, decision: Decision): Promise<DecideResult> {
    const row = await this.store.get<ProposalRow>('proposal', proposalId);
    if (!row) throw new DecideError(`Unknown proposal ${proposalId}`);
    if (row.deleted_at) throw new DecideError('This proposal was deleted');
    if (row.state === 'accepted' || row.state === 'edited') throw new DecideError('Already accepted');
    const rule = this.rules.find((r) => r.id === row.rule_id);
    const title = String(row.payload?.item ?? row.payload?.part ?? row.payload?.now ?? row.kind);
    const label = `${row.rule_id}: ${title}`.slice(0, 200);
    if (decision.kind === 'reject') {
      const ops = await this.editor.group({ change_type: 'Field survey', reason: `Reject ${label}`, proposal_id: row.id }, (g) =>
        g.setFields('proposal', row.id, { state: 'rejected', decided_by_id: this.opts.userId, decided_at: this.now() }),
      );
      this.log('info', 'reject', { proposal: row.id, rule: row.rule_id });
      return { state: 'rejected', recordIds: [], ops: ops.length };
    }
    const payload = decision.kind === 'edit' ? { ...(row.payload ?? {}), ...decision.payload } : (row.payload ?? {});
    const plan = acceptPlan({ ...row, subject: await this.subjectWithLevel(row.subject) }, payload);
    const state = decision.kind === 'edit' ? 'edited' : 'accepted';
    const recordIds: string[] = [];
    const ops = await this.editor.group({ change_type: 'Field survey', reason: `${decision.kind === 'edit' ? 'Edit' : 'Accept'} ${label}`, proposal_id: row.id }, async (g) => {
      for (const step of plan) {
        if (step.kind === 'create') {
          const { id } = await g.create(step.entity, { id: step.id, ...step.payload });
          recordIds.push(id);
        } else if (step.kind === 'set') {
          await g.setFields(step.entity, step.id, step.fields);
        } else {
          await g.link(step.entity, step.ownerId, step.key);
        }
      }
      // The row keeps the rule's payload: the record holds the edit, and every iPad derives
      // `edited` from record ≠ payload the same way (`recordDiffers`).
      await g.setFields('proposal', row.id, { state, decided_by_id: this.opts.userId, decided_at: this.now() });
    });
    this.log('info', decision.kind, { proposal: row.id, rule: row.rule_id, records: recordIds.length, known_rule: !!rule });
    return { state, recordIds, ops: ops.length };
  }

  // -------------------------------------------------------------- findings (T36)

  /**
   * Dismiss a finding with a reason (Phase 3 §9). One `Field survey` group, reason `Dismiss
   * <lint>: <reason>`. It stays dismissed while the rule says the same thing and reopens when
   * the message changes or the condition clears and returns (D178, `reconcile.ts`).
   */
  async dismiss(findingId: string, reason: string): Promise<number> {
    const text = reason.trim();
    if (!text) throw new DecideError('A dismissal needs a reason');
    const row = await this.store.get<FindingRow>('finding', findingId);
    if (!row || row.deleted_at) throw new DecideError(`Unknown finding ${findingId}`);
    if (row.state !== 'open') throw new DecideError(`This finding is ${row.state}`);
    const ops = await this.editor.group({ change_type: 'Field survey', reason: `Dismiss ${row.lint_id}: ${text}`.slice(0, 500) }, (g) =>
      g.setFields('finding', row.id, { state: 'dismissed', dismissed_reason: text }),
    );
    this.log('info', 'dismiss', { finding: row.id, lint: row.lint_id });
    return ops.length;
  }

  /** Undo a dismissal: the finding is open again (the next run resolves it if the condition is gone). */
  async reopen(findingId: string): Promise<number> {
    const row = await this.store.get<FindingRow>('finding', findingId);
    if (!row || row.deleted_at) throw new DecideError(`Unknown finding ${findingId}`);
    if (row.state !== 'dismissed') throw new DecideError(`This finding is ${row.state}`);
    const ops = await this.editor.group({ change_type: 'Field survey', reason: `Reopen ${row.lint_id}` }, (g) =>
      g.setFields('finding', row.id, { state: 'open', dismissed_reason: null }),
    );
    this.log('info', 'reopen', { finding: row.id, lint: row.lint_id });
    return ops.length;
  }

  /**
   * The subject with its `level_id` filled from the record when the proposal left it out
   * (seeded or older rows; `entity` is the pre-T33 spelling of `entity_kind`).
   */
  private async subjectWithLevel(subject: ProposalRow['subject']): Promise<ProposalRow['subject']> {
    if (!subject) return subject;
    const legacy = subject as { entity?: string };
    const s = { ...subject, entity_kind: subject.entity_kind ?? (legacy.entity as Subject['entity_kind']) };
    if (s.level_id || !s.entity_id) return s;
    if (s.entity_kind === 'device' || s.entity_kind === 'cable_end' || s.entity_kind === 'punch_item' || s.entity_kind === 'missing_part') {
      const rec = await this.store.get<{ level_id?: string | null }>(s.entity_kind, s.entity_id);
      if (rec?.level_id) s.level_id = rec.level_id;
    }
    return s;
  }

  /** The rule's text and the facts behind one proposal ("why?"), or null for an unknown proposal. */
  async explain(proposalId: string): Promise<string | null> {
    const row = await this.store.get<ProposalRow>('proposal', proposalId);
    if (!row) return null;
    const rule = this.rules.find((r) => r.id === row.rule_id);
    const why = typeof row.payload?.why === 'string' ? row.payload.why : null;
    const parts = [rule ? `${rule.id} — ${rule.title}: ${rule.text}` : `Rule ${row.rule_id}`, why].filter(Boolean);
    return parts.join('\n');
  }

  /** The proposal rows of a subject (device or end) that are still open, for screens. */
  async openProposals(entityIds: readonly string[]): Promise<ProposalRow[]> {
    if (!entityIds.length) return [];
    return this.store.list<ProposalRow>('proposal', {
      where: `project_id = ? AND state = 'proposed' AND json_extract(subject, '$.entity_id') IN (${entityIds.map(() => '?').join(', ')})`,
      params: [this.projectId, ...entityIds],
      orderBy: 'rule_id, id',
    });
  }

  async openFindings(levelId?: string): Promise<FindingRow[]> {
    return this.store.list<FindingRow>('finding', {
      where: levelId ? `project_id = ? AND state = 'open' AND level_id = ?` : `project_id = ? AND state = 'open'`,
      params: levelId ? [this.projectId, levelId] : [this.projectId],
      orderBy: 'lint_id, id',
    });
  }
}

/** What the rows look like once `changes` have materialised (tests of idempotence). */
export function afterChanges(snap: Snapshot, changes: readonly Change[]): Snapshot {
  return {
    ...snap,
    proposals: applyChanges(snap.proposals, changes, 'proposal'),
    findings: applyChanges(snap.findings, changes, 'finding'),
  };
}
