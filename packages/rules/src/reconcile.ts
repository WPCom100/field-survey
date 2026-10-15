/**
 * Turn one evaluation into the smallest set of changes to the stored `proposal` and `finding`
 * rows (pure; the engine applies them as ops). The state machine of PLAN §6:
 *
 * | stored row            | rule output present                          | absent                 |
 * |-----------------------|----------------------------------------------|------------------------|
 * | none                  | create `proposed`                            | —                      |
 * | `proposed`            | same hash → nothing; else new payload + hash | → `superseded`         |
 * | `superseded`          | → `proposed` again                           | nothing                |
 * | `rejected`            | same hash → stays rejected; else → `proposed`| nothing                |
 * | `accepted` / `edited` | cited by a live record → nothing; else → `proposed` | nothing          |
 *
 * A live record whose `proposal_id` names the row makes it `accepted` (`edited` when its
 * fields differ from the payload) wherever the row is, so a decision taken on one iPad shows
 * on every other once the record has synced, even before the proposal row's own ops arrive.
 *
 * Rows whose `rule_id` is not registered are never touched (another app version's, or seeded).
 * Findings: `open` ↔ `resolved` follow the output; `dismissed` rows stay dismissed (T36 adds
 * the reappear-on-input-change rule and the reason).
 */

import { stableStringify } from './hash';
import type { FindingRow, ProposalRow, ProposalState } from './snapshot';

import { findingRowKey, proposalRowKey, type FindingOutput, type ProposalOutput } from './rule';

export type Change =
  | { kind: 'create'; entity: 'proposal' | 'finding'; id: string; payload: Record<string, unknown> }
  | { kind: 'set'; entity: 'proposal' | 'finding'; id: string; fields: Record<string, unknown> };

/** A live record that cites a proposal (`recordsByProposal`), reduced to what reconcile needs. */
export interface Citation {
  /** True when the record's fields differ from the proposal payload (an Edit-then-accept). */
  edited: boolean;
  decided_by_id: string | null;
  decided_at: string | null;
}

export interface ReconcileInput {
  projectId: string;
  existing: readonly ProposalRow[];
  output: readonly ProposalOutput[];
  /** Rule ids this engine owns; rows of other rules are left alone. */
  ruleIds: ReadonlySet<string>;
  /** Proposal id → the live record accepted from it. */
  citations?: ReadonlyMap<string, Citation>;
}

function clearedDecision(): Record<string, unknown> {
  return { decided_by_id: null, decided_at: null };
}

export function reconcileProposals(input: ReconcileInput): Change[] {
  const changes: Change[] = [];
  const byKey = new Map<string, ProposalRow>();
  for (const row of input.existing) {
    if (row.deleted_at != null) continue;
    const key = proposalRowKey(row);
    if (key) byKey.set(key, row);
  }
  const seen = new Set<string>();
  for (const out of input.output) {
    seen.add(out.key);
    const row = byKey.get(out.key);
    const cited = input.citations?.get(row?.id ?? out.id);
    if (!row) {
      if (cited) {
        // The record exists already (made elsewhere, row not synced yet): create the row decided.
        changes.push({
          kind: 'create',
          entity: 'proposal',
          id: out.id,
          payload: rowPayload(input.projectId, out, cited.edited ? 'edited' : 'accepted', cited),
        });
      } else {
        changes.push({ kind: 'create', entity: 'proposal', id: out.id, payload: rowPayload(input.projectId, out, 'proposed') });
      }
      continue;
    }
    const sameHash = row.inputs_hash === out.inputs_hash;
    const samePayload = stableStringify(row.payload ?? {}) === stableStringify(out.payload);
    if (cited) {
      const want: ProposalState = cited.edited ? 'edited' : 'accepted';
      if (row.state !== want || (row.decided_by_id == null && cited.decided_by_id)) {
        changes.push({
          kind: 'set',
          entity: 'proposal',
          id: row.id,
          fields: {
            state: want,
            ...(row.decided_by_id == null && cited.decided_by_id ? { decided_by_id: cited.decided_by_id, decided_at: cited.decided_at } : {}),
          },
        });
      }
      continue;
    }
    switch (row.state) {
      case 'proposed':
        if (!sameHash || !samePayload) {
          changes.push({ kind: 'set', entity: 'proposal', id: row.id, fields: { payload: out.payload, inputs_hash: out.inputs_hash, kind: out.kind } });
        }
        break;
      case 'superseded':
        changes.push({
          kind: 'set',
          entity: 'proposal',
          id: row.id,
          fields: { state: 'proposed', payload: out.payload, inputs_hash: out.inputs_hash, kind: out.kind, ...clearedDecision() },
        });
        break;
      case 'rejected':
        if (!sameHash) {
          changes.push({
            kind: 'set',
            entity: 'proposal',
            id: row.id,
            fields: { state: 'proposed', payload: out.payload, inputs_hash: out.inputs_hash, kind: out.kind, ...clearedDecision() },
          });
        }
        break;
      case 'accepted':
      case 'edited':
        // Accepted, but no live record cites it (deleted, or an older app wrote none): propose again.
        changes.push({
          kind: 'set',
          entity: 'proposal',
          id: row.id,
          fields: { state: 'proposed', payload: out.payload, inputs_hash: out.inputs_hash, kind: out.kind, ...clearedDecision() },
        });
        break;
    }
  }
  for (const [key, row] of byKey) {
    if (seen.has(key) || !input.ruleIds.has(row.rule_id)) continue;
    const cited = input.citations?.get(row.id);
    if (cited) {
      const want: ProposalState = cited.edited ? 'edited' : 'accepted';
      if (row.state !== want) changes.push({ kind: 'set', entity: 'proposal', id: row.id, fields: { state: want } });
      continue;
    }
    // A decided row without output keeps its decision; only an open proposal is superseded.
    if (row.state === 'proposed') {
      changes.push({ kind: 'set', entity: 'proposal', id: row.id, fields: { state: 'superseded' } });
    }
  }
  return changes;
}

function rowPayload(projectId: string, out: ProposalOutput, state: ProposalState, cited?: Citation): Record<string, unknown> {
  return {
    project_id: projectId,
    rule_id: out.rule_id,
    subject: out.subject,
    discriminator: out.discriminator,
    kind: out.kind,
    payload: out.payload,
    inputs_hash: out.inputs_hash,
    state,
    decided_by_id: cited?.decided_by_id ?? null,
    decided_at: cited?.decided_at ?? null,
  };
}

export interface ReconcileFindingsInput {
  projectId: string;
  existing: readonly FindingRow[];
  output: readonly FindingOutput[];
  /** Lint ids this engine owns (`ownedLintIds`); other findings (the import's, T27) are left alone. */
  lintIds: ReadonlySet<string>;
}

export function reconcileFindings(input: ReconcileFindingsInput): Change[] {
  const changes: Change[] = [];
  const byKey = new Map<string, FindingRow>();
  for (const row of input.existing) {
    if (row.deleted_at != null) continue;
    const key = findingRowKey(row);
    if (key) byKey.set(key, row);
  }
  const seen = new Set<string>();
  for (const out of input.output) {
    seen.add(out.key);
    const row = byKey.get(out.key);
    if (!row) {
      changes.push({
        kind: 'create',
        entity: 'finding',
        id: out.id,
        payload: { project_id: input.projectId, level_id: out.level_id, lint_id: out.lint_id, subject: out.subject, message: out.message, state: 'open' },
      });
      continue;
    }
    switch (row.state) {
      case 'open':
        if (row.message !== out.message || (row.level_id ?? null) !== out.level_id) {
          changes.push({ kind: 'set', entity: 'finding', id: row.id, fields: { message: out.message, level_id: out.level_id } });
        }
        break;
      case 'resolved':
        changes.push({ kind: 'set', entity: 'finding', id: row.id, fields: { state: 'open', message: out.message, level_id: out.level_id } });
        break;
      case 'dismissed':
        break;
    }
  }
  for (const [key, row] of byKey) {
    if (seen.has(key) || !input.lintIds.has(row.lint_id)) continue;
    if (row.state === 'open') changes.push({ kind: 'set', entity: 'finding', id: row.id, fields: { state: 'resolved' } });
  }
  return changes;
}

/**
 * Apply changes to in-memory rows (tests, and the engine's idempotence check): what the rows
 * look like once the ops have materialised.
 */
export function applyChanges<T extends { id: string }>(rows: readonly T[], changes: readonly Change[], entity: 'proposal' | 'finding'): T[] {
  const out = rows.map((r) => ({ ...r }));
  for (const c of changes) {
    if (c.entity !== entity) continue;
    if (c.kind === 'create') out.push({ id: c.id, deleted_at: null, ...c.payload } as unknown as T);
    else {
      const row = out.find((r) => r.id === c.id);
      if (row) Object.assign(row, c.fields);
    }
  }
  return out;
}
