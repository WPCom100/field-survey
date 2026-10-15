/**
 * The rule interface (PLAN §6, T33). A rule is a pure function over the snapshot that
 * *proposes* records (drafts the surveyor accepts, edits or rejects on the card) and *finds*
 * problems (lint). It never writes: the engine turns its outputs into `proposal` / `finding`
 * rows and only an Accept creates a record (CLAUDE.md §4).
 *
 * Keying (PLAN §6): a proposal is identified by `(rule_id, subject, discriminator)`; the key
 * gives it a deterministic id, the same on every iPad (D169). `inputs_hash` says which facts it
 * was computed from: a rejected proposal stays rejected while the hash holds and comes back when
 * it changes.
 */

import { hashOf, hashUuid } from './hash';
import type { FindingRow, ProposalKind, ProposalRow, Snapshot, SnapshotIndex, Subject } from './snapshot';

export interface ProposalInput {
  subject: Subject;
  /** Tells apart several proposals of one rule on one subject (`'U run'`, a cable code…). */
  discriminator?: string | null;
  kind: ProposalKind;
  /** The record to create (punch/part/cable) or the field change (status/note); see `decide.ts`. */
  payload: Record<string, unknown>;
  /** The facts the proposal depends on; hashed into `inputs_hash`. Defaults to the payload. */
  inputs?: unknown;
  /** One sentence for "why?" on the card, naming the facts. */
  why?: string;
}

export interface FindingInput {
  subject: Subject;
  discriminator?: string | null;
  /** Defaults to the rule's id; a rule that raises several lints names each (`R1.untested`). */
  lint_id?: string;
  level_id?: string | null;
  /**
   * What message the finding shows. It names the facts the finding follows from: a dismissed
   * finding reopens when its message changes (D178).
   */
  message: string;
  /**
   * A vocabulary fix the lint view can hand to a ruling (T36 → T37): set `field` from `from` to
   * `to` (null: the ruling picks the value). Stored on the row's `subject`; put `from` in the
   * discriminator so a different value is a different finding.
   */
  fix?: FindingFix;
}

export interface FindingFix {
  field: string;
  from: string;
  to: string | null;
}

/**
 * Upkeep of a record a rule already owns (D170): fields the engine sets without an Accept. The
 * only use so far is R3c's accepted Neuron ID item (its Notes list, auto-close and reopen). The
 * engine writes the sets as `Field survey` ops, reason `Rule engine <rule_id>`, carrying
 * `proposal_id` when the record was accepted from a proposal. Unchanged values write nothing.
 */
export interface UpkeepInput {
  entity: 'punch_item' | 'missing_part' | 'cable_end' | 'device';
  id: string;
  fields: Record<string, unknown>;
  proposal_id?: string | null;
  why?: string;
}

export interface RuleContext {
  readonly snap: Snapshot;
  readonly index: SnapshotIndex;
  /** The run's clock (ISO 8601); `today()` is its date. Never put it in `inputs`. */
  readonly now: string;
  today(): string;
  propose(p: ProposalInput): void;
  find(f: FindingInput): void;
  maintain(u: UpkeepInput): void;
}

export interface Rule {
  /** `R3a`, `E5`, `lint.nsps_120v`… cited on every proposal and record (CLAUDE.md §4). */
  id: string;
  title: string;
  /** The rule's text as PLAN §6.1 / CLAUDE.md §4 state it; shown by `explain()`. */
  text: string;
  /** Lint ids this rule may raise besides its own id (so their findings resolve when it goes quiet). */
  lints?: readonly string[];
  run(ctx: RuleContext): void;
}

/** A proposal as the rules produced it this run, with its key, id and hash resolved. */
export interface ProposalOutput {
  id: string;
  key: string;
  rule_id: string;
  subject: Subject;
  discriminator: string | null;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  inputs_hash: string;
  why: string | null;
}

export interface FindingOutput {
  id: string;
  key: string;
  lint_id: string;
  rule_id: string;
  subject: Subject & { discriminator?: string | null; fix?: FindingFix };
  level_id: string | null;
  message: string;
}

export interface UpkeepOutput {
  rule_id: string;
  entity: UpkeepInput['entity'];
  id: string;
  fields: Record<string, unknown>;
  proposal_id: string | null;
  why: string | null;
}

/** `rule|kind:id|discriminator` — the (rule_id, subject, discriminator) key as one string. */
export function proposalKey(ruleId: string, subject: Subject, discriminator?: string | null): string {
  return `${ruleId}|${subject.entity_kind}:${subject.entity_id}|${discriminator ?? ''}`;
}

export function findingKey(lintId: string, subject: Subject, discriminator?: string | null): string {
  return `${lintId}|${subject.entity_kind}:${subject.entity_id}|${discriminator ?? ''}`;
}

/** The key of an existing row (null when the row has no usable subject). */
export function proposalRowKey(row: Pick<ProposalRow, 'rule_id' | 'subject' | 'discriminator'>): string | null {
  const s = row.subject;
  if (!s || typeof s.entity_id !== 'string' || typeof s.entity_kind !== 'string') return null;
  return proposalKey(row.rule_id, s, row.discriminator);
}

export function findingRowKey(row: Pick<FindingRow, 'lint_id' | 'subject'>): string | null {
  const s = row.subject;
  if (!s || typeof s.entity_id !== 'string' || typeof s.entity_kind !== 'string') return null;
  return findingKey(row.lint_id, s, s.discriminator);
}

/** Deterministic proposal id (D169): the same on every iPad for the same project and key. */
export function proposalId(projectId: string, key: string): string {
  return hashUuid('field-survey:proposal', [projectId, key]);
}

export function findingId(projectId: string, key: string): string {
  return hashUuid('field-survey:finding', [projectId, key]);
}

export function inputsHash(inputs: unknown): string {
  return hashOf(inputs);
}
