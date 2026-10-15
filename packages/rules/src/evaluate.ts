/**
 * Run every rule over a snapshot (pure). Outputs are deduplicated by key: the first proposal a
 * run makes for a key wins and a second is reported, never silently merged. A rule that throws
 * is skipped and reported (the field must keep working; the error reaches the log).
 */

import { indexSnapshot, type Snapshot, type SnapshotIndex } from './snapshot';
import {
  findingId,
  findingKey,
  inputsHash,
  proposalId,
  proposalKey,
  type FindingInput,
  type FindingOutput,
  type ProposalInput,
  type ProposalOutput,
  type Rule,
  type RuleContext,
  type UpkeepInput,
  type UpkeepOutput,
} from './rule';

export interface EvalProblem {
  rule_id: string;
  /** `threw` (the rule crashed), `duplicate` (a second proposal/finding for one key). */
  kind: 'threw' | 'duplicate';
  message: string;
}

export interface EvalOutput {
  proposals: ProposalOutput[];
  findings: FindingOutput[];
  /** Field sets the engine applies without an Accept (D170); one entry per (rule, record). */
  upkeep: UpkeepOutput[];
  problems: EvalProblem[];
  /** Rule ids that ran (registered), and every lint id they own. */
  ruleIds: Set<string>;
  lintIds: Set<string>;
}

export interface EvalOptions {
  /** The run's clock (ISO 8601); defaults to now. */
  now?: string;
}

/** The lint ids a rule set owns: each rule's id plus its declared `lints`. */
export function ownedLintIds(rules: readonly Rule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) {
    out.add(r.id);
    for (const l of r.lints ?? []) out.add(l);
  }
  return out;
}

export function evaluate(snap: Snapshot, rules: readonly Rule[], index: SnapshotIndex = indexSnapshot(snap), opts: EvalOptions = {}): EvalOutput {
  const proposals = new Map<string, ProposalOutput>();
  const findings = new Map<string, FindingOutput>();
  const upkeep = new Map<string, UpkeepOutput>();
  const problems: EvalProblem[] = [];
  const now = opts.now ?? new Date().toISOString();
  for (const rule of rules) {
    const ctx: RuleContext = {
      snap,
      index,
      now,
      today: () => now.slice(0, 10),
      propose(p: ProposalInput) {
        const key = proposalKey(rule.id, p.subject, p.discriminator);
        if (proposals.has(key)) {
          problems.push({ rule_id: rule.id, kind: 'duplicate', message: `second proposal for ${key}` });
          return;
        }
        const payload: Record<string, unknown> = { ...p.payload };
        if (p.why) payload.why = p.why;
        proposals.set(key, {
          id: proposalId(snap.projectId, key),
          key,
          rule_id: rule.id,
          subject: { ...p.subject },
          discriminator: p.discriminator ?? null,
          kind: p.kind,
          payload,
          inputs_hash: inputsHash(p.inputs === undefined ? p.payload : p.inputs),
          why: p.why ?? null,
        });
      },
      find(f: FindingInput) {
        const lintId = f.lint_id ?? rule.id;
        const key = findingKey(lintId, f.subject, f.discriminator);
        if (findings.has(key)) {
          problems.push({ rule_id: rule.id, kind: 'duplicate', message: `second finding for ${key}` });
          return;
        }
        findings.set(key, {
          id: findingId(snap.projectId, key),
          key,
          lint_id: lintId,
          rule_id: rule.id,
          subject: { ...f.subject, ...(f.discriminator != null ? { discriminator: f.discriminator } : {}), ...(f.fix ? { fix: { ...f.fix } } : {}) },
          level_id: f.level_id ?? f.subject.level_id ?? null,
          message: f.message,
        });
      },
      maintain(u: UpkeepInput) {
        const key = `${rule.id}|${u.entity}:${u.id}`;
        const prev = upkeep.get(key);
        upkeep.set(key, {
          rule_id: rule.id,
          entity: u.entity,
          id: u.id,
          fields: { ...(prev?.fields ?? {}), ...u.fields },
          proposal_id: u.proposal_id ?? prev?.proposal_id ?? null,
          why: u.why ?? prev?.why ?? null,
        });
      },
    };
    try {
      rule.run(ctx);
    } catch (e) {
      problems.push({ rule_id: rule.id, kind: 'threw', message: String((e as Error)?.message ?? e) });
    }
  }
  return {
    proposals: [...proposals.values()],
    findings: [...findings.values()],
    upkeep: [...upkeep.values()],
    problems,
    ruleIds: new Set(rules.map((r) => r.id)),
    lintIds: ownedLintIds(rules),
  };
}
