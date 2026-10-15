// Public surface of @field-survey/rules (T33). Pure parts first (snapshot, rule interface,
// evaluate, reconcile, decide plans), then the engine over a core `Store`. No React, no Expo,
// no SQL here: the store does the reading and every write is an op through the `Editor`.

export { sha256Hex, stableStringify, hashOf, hashUuid } from './hash';
export {
  emptySnapshot,
  indexSnapshot,
  type Snapshot,
  type SnapshotIndex,
  type Subject,
  type Deletable,
  type ProjectRow,
  type LevelRow,
  type NumberingGroupRow,
  type DeviceRow,
  type AccessoryRow,
  type CableRow,
  type CableEndRow,
  type PlaceholderRow,
  type PunchItemRow,
  type MissingPartRow,
  type PartSourceRow,
  type LibraryTypeRow,
  type VocabRow,
  type ProposalRow,
  type ProposalState,
  type ProposalKind,
  type FindingRow,
  type FindingState,
} from './snapshot';
export {
  proposalKey,
  findingKey,
  proposalRowKey,
  findingRowKey,
  proposalId,
  findingId,
  inputsHash,
  type Rule,
  type RuleContext,
  type ProposalInput,
  type FindingInput,
  type ProposalOutput,
  type FindingOutput,
} from './rule';
export { evaluate, ownedLintIds, type EvalOutput, type EvalProblem } from './evaluate';
export { reconcileProposals, reconcileFindings, applyChanges, type Change, type Citation, type ReconcileInput, type ReconcileFindingsInput } from './reconcile';
export { acceptPlan, editableKeys, recordDiffers, DecideError, type RecordPlan } from './decide';
export { RuleEngine, afterChanges, type RuleEngineOptions, type RuleLog, type RunReport, type Decision, type DecideResult } from './engine';
export { RULES } from './rules';
