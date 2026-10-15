/**
 * Accept / Edit / Reject of rule drafts on the card (Phase 3 §4.3, PLAN §6). The rule engine
 * (`packages/rules`, T33) implements `ProposalDecider` through `src/rules/engine.ts`
 * (`ruleDecider`): Accept creates the record with `rule_id`/`proposal_id`, Edit-then-accept
 * writes the edited record and marks the proposal `edited`, Reject keeps it rejected until its
 * inputs change. `NOT_WIRED` is what a read-only card (no editor) gets: buttons shown, disabled.
 */

export type ProposalDecision =
  | { kind: 'accept' }
  | { kind: 'edit'; payload: Record<string, unknown> }
  | { kind: 'reject' };

export interface ProposalDecider {
  /** False on a read-only card: the buttons are shown but disabled. */
  readonly wired: boolean;
  decide(proposalId: string, decision: ProposalDecision): Promise<void>;
  /** The rule text and the inputs that fired it ("why?"), or null if unknown. */
  explain(proposalId: string): Promise<string | null>;
}

export const NOT_WIRED: ProposalDecider = {
  wired: false,
  decide: () => Promise.reject(new Error('Read-only: open the card with an editor to decide (T33).')),
  explain: () => Promise.resolve(null),
};

/**
 * Quick actions of Phase 3 §4.3 (PLAN §6.1 E6/E7/E9), run through `runQuickAction` of
 * `@field-survey/rules` (T34). `input` is the one thing the action asks for first (`null` = run
 * at once); `optional` means an empty answer is fine. "Not found on site" has no rule yet (D-less;
 * see TASKS) and stays disabled.
 */
export const QUICK_ACTIONS = [
  { key: 'E6', label: 'Spot-check fixed', input: 'What was found (optional)', optional: true, enabled: true },
  { key: 'E7', label: 'Non-ETC device', input: 'Make of the device found', optional: false, enabled: true },
  { key: 'E9', label: 'Relocated', input: 'Room / Location now', optional: false, enabled: true },
  { key: 'not_found', label: 'Not found on site', input: null, optional: true, enabled: false },
] as const;

export type QuickActionKey = (typeof QUICK_ACTIONS)[number]['key'];
