/**
 * The proposal / finding state machine (PLAN §6) as pure diffs, and its idempotence: applying
 * a run's changes and reconciling again yields nothing.
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { applyChanges, reconcileFindings, reconcileProposals, type Change } from './reconcile';
import type { FindingRow, ProposalRow } from './snapshot';
import { END_A, PANEL, PROJECT, RUN_RULE, ISSUE_RULE, sampleSnapshot } from './testing/sample';

const RULES = new Set(['T.run']);

function rows(changes: Change[], existing: ProposalRow[] = []): ProposalRow[] {
  return applyChanges(existing, changes, 'proposal');
}

function run(snap = sampleSnapshot()) {
  return evaluate(snap, [RUN_RULE]);
}

describe('reconcileProposals', () => {
  it('creates a proposed row for new output and is then idempotent', () => {
    const out = run();
    const c1 = reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES });
    expect(c1).toHaveLength(1);
    expect(c1[0]).toMatchObject({ kind: 'create', entity: 'proposal', id: out.proposals[0]!.id, payload: { state: 'proposed', rule_id: 'T.run', inputs_hash: out.proposals[0]!.inputs_hash } });
    const existing = rows(c1);
    expect(reconcileProposals({ projectId: PROJECT, existing, output: out.proposals, ruleIds: RULES })).toEqual([]);
  });

  it('supersedes a proposed row whose condition disappeared and proposes it again when it returns', () => {
    const out = run();
    let existing = rows(reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES }));
    const gone = sampleSnapshot();
    gone.cableEnds[0]!.status = 'Issue';
    const c2 = reconcileProposals({ projectId: PROJECT, existing, output: run(gone).proposals, ruleIds: RULES });
    expect(c2).toEqual([{ kind: 'set', entity: 'proposal', id: out.proposals[0]!.id, fields: { state: 'superseded' } }]);
    existing = rows(c2, existing);
    expect(reconcileProposals({ projectId: PROJECT, existing, output: run(gone).proposals, ruleIds: RULES })).toEqual([]);
    const c3 = reconcileProposals({ projectId: PROJECT, existing, output: out.proposals, ruleIds: RULES });
    expect(c3[0]).toMatchObject({ kind: 'set', fields: { state: 'proposed', inputs_hash: out.proposals[0]!.inputs_hash } });
  });

  it('keeps a rejected row rejected while the inputs hold, and re-proposes when they change', () => {
    const out = run();
    const existing = rows(reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES }));
    existing[0]!.state = 'rejected';
    existing[0]!.decided_by_id = 'u1';
    expect(reconcileProposals({ projectId: PROJECT, existing, output: out.proposals, ruleIds: RULES })).toEqual([]);
    const changed = sampleSnapshot();
    changed.devices[1]!.display_id = '06M-09'; // the target changes → new inputs
    const c = reconcileProposals({ projectId: PROJECT, existing, output: run(changed).proposals, ruleIds: RULES });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'set', fields: { state: 'proposed', decided_by_id: null, decided_at: null, payload: { item: 'Run X to 06M-09' } } });
  });

  it('updates the payload of a proposed row when the rule text changes but the inputs do not', () => {
    const out = run();
    const existing = rows(reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES }));
    const reworded = { ...out.proposals[0]!, payload: { ...out.proposals[0]!.payload, item: 'Pull X to 06M-03' } };
    const c = reconcileProposals({ projectId: PROJECT, existing, output: [reworded], ruleIds: RULES });
    expect(c).toEqual([{ kind: 'set', entity: 'proposal', id: reworded.id, fields: { payload: reworded.payload, inputs_hash: reworded.inputs_hash, kind: 'punch' } }]);
  });

  it('marks a row accepted (or edited) when a live record cites it, and creates it decided when the record arrived first', () => {
    const out = run();
    const p = out.proposals[0]!;
    const citations = new Map([[p.id, { edited: false, decided_by_id: 'u2', decided_at: '2026-10-15T10:00:00Z' }]]);
    // no row yet, record exists (made on another iPad): the row is created already accepted
    const c1 = reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES, citations });
    expect(c1[0]).toMatchObject({ kind: 'create', payload: { state: 'accepted', decided_by_id: 'u2' } });
    // a proposed row + a citing record → accepted with who/when
    const existing = rows(reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES }));
    const c2 = reconcileProposals({ projectId: PROJECT, existing, output: out.proposals, ruleIds: RULES, citations });
    expect(c2).toEqual([{ kind: 'set', entity: 'proposal', id: p.id, fields: { state: 'accepted', decided_by_id: 'u2', decided_at: '2026-10-15T10:00:00Z' } }]);
    const accepted = rows(c2, existing);
    expect(reconcileProposals({ projectId: PROJECT, existing: accepted, output: out.proposals, ruleIds: RULES, citations })).toEqual([]);
    // the record's content differs from the payload → edited
    const edited = new Map([[p.id, { edited: true, decided_by_id: 'u2', decided_at: 'x' }]]);
    expect(reconcileProposals({ projectId: PROJECT, existing: accepted, output: out.proposals, ruleIds: RULES, citations: edited })).toEqual([
      { kind: 'set', entity: 'proposal', id: p.id, fields: { state: 'edited' } },
    ]);
    // the rule goes quiet (condition gone) but the record cites the row: the decision stands
    expect(reconcileProposals({ projectId: PROJECT, existing: accepted, output: [], ruleIds: RULES, citations })).toEqual([]);
    // the record was deleted (no citation) and the rule still fires: proposed again
    const c3 = reconcileProposals({ projectId: PROJECT, existing: accepted, output: out.proposals, ruleIds: RULES });
    expect(c3[0]).toMatchObject({ kind: 'set', fields: { state: 'proposed', decided_by_id: null } });
  });

  it('leaves rows of unregistered rules and deleted rows alone', () => {
    const foreign: ProposalRow = {
      id: 'f1', project_id: PROJECT, rule_id: 'R9', subject: { entity_kind: 'device', entity_id: PANEL }, discriminator: 'legacy',
      kind: 'punch', payload: { item: 'old' }, inputs_hash: 'demo', state: 'proposed', decided_by_id: null, decided_at: null, deleted_at: null,
    };
    const out = run();
    const mine = rows(reconcileProposals({ projectId: PROJECT, existing: [], output: out.proposals, ruleIds: RULES }));
    const deleted = { ...mine[0]!, deleted_at: '2026-10-15T00:00:00Z' };
    const c = reconcileProposals({ projectId: PROJECT, existing: [foreign, deleted], output: [], ruleIds: RULES });
    expect(c).toEqual([]);
    // a legacy row with a v7 id but the same key is reused, not duplicated
    const legacy = { ...mine[0]!, id: '0190a5f0-0000-7000-8000-00000000f00d' };
    expect(reconcileProposals({ projectId: PROJECT, existing: [legacy], output: out.proposals, ruleIds: RULES })).toEqual([]);
  });
});

describe('reconcileFindings', () => {
  const LINTS = new Set(['T.issue', 'T.issue.none']);
  const issue = () => {
    const s = sampleSnapshot();
    s.devices[0]!.status = 'Issue';
    return s;
  };

  it('opens, updates, resolves and reopens findings; others\' lints untouched', () => {
    const out = evaluate(issue(), [ISSUE_RULE]);
    const c1 = reconcileFindings({ projectId: PROJECT, existing: [], output: out.findings, lintIds: LINTS });
    expect(c1[0]).toMatchObject({ kind: 'create', entity: 'finding', payload: { state: 'open', lint_id: 'T.issue.none', message: '06M-01 is Issue with no open punch item' } });
    let existing = applyChanges<FindingRow>([], c1, 'finding');
    expect(reconcileFindings({ projectId: PROJECT, existing, output: out.findings, lintIds: LINTS })).toEqual([]);
    // condition gone → resolved; back → open again
    const c2 = reconcileFindings({ projectId: PROJECT, existing, output: [], lintIds: LINTS });
    expect(c2).toEqual([{ kind: 'set', entity: 'finding', id: existing[0]!.id, fields: { state: 'resolved' } }]);
    existing = applyChanges(existing, c2, 'finding');
    const c3 = reconcileFindings({ projectId: PROJECT, existing, output: out.findings, lintIds: LINTS });
    expect(c3[0]).toMatchObject({ kind: 'set', fields: { state: 'open' } });
    // a changed message on an open finding is written
    existing = applyChanges(existing, c3, 'finding');
    const reworded = [{ ...out.findings[0]!, message: 'new words' }];
    expect(reconcileFindings({ projectId: PROJECT, existing, output: reworded, lintIds: LINTS })).toEqual([
      { kind: 'set', entity: 'finding', id: existing[0]!.id, fields: { message: 'new words', level_id: out.findings[0]!.level_id } },
    ]);
    // the import's findings are not ours to resolve
    const imported: FindingRow = { id: 'i1', project_id: PROJECT, level_id: null, lint_id: 'import.endpoint', subject: { entity_kind: 'cable_end', entity_id: END_A }, message: 'x', state: 'open', dismissed_reason: null, deleted_at: null };
    expect(reconcileFindings({ projectId: PROJECT, existing: [imported], output: [], lintIds: LINTS })).toEqual([]);
  });

  it('D178: a dismissed finding stays while its message holds, reopens when the message changes, and resolves when the condition goes', () => {
    const out = evaluate(issue(), [ISSUE_RULE]);
    const id = out.findings[0]!.id;
    const dismissed = (): FindingRow[] =>
      applyChanges<FindingRow>([], reconcileFindings({ projectId: PROJECT, existing: [], output: out.findings, lintIds: LINTS }), 'finding').map((r) => ({
        ...r,
        state: 'dismissed' as const,
        dismissed_reason: 'EC already told by email',
      }));
    // same facts → nothing written, the reason stays
    expect(reconcileFindings({ projectId: PROJECT, existing: dismissed(), output: out.findings, lintIds: LINTS })).toEqual([]);
    // the facts changed (the message names them) → open again, reason cleared
    const changed = [{ ...out.findings[0]!, message: '06M-01 is Issue with no open punch item (2 ends Not installed)' }];
    expect(reconcileFindings({ projectId: PROJECT, existing: dismissed(), output: changed, lintIds: LINTS })).toEqual([
      { kind: 'set', entity: 'finding', id, fields: { state: 'open', dismissed_reason: null, message: changed[0]!.message, level_id: out.findings[0]!.level_id } },
    ]);
    // the condition went away → resolved (the dismissal covered that occurrence)…
    const gone = reconcileFindings({ projectId: PROJECT, existing: dismissed(), output: [], lintIds: LINTS });
    expect(gone).toEqual([{ kind: 'set', entity: 'finding', id, fields: { state: 'resolved' } }]);
    // …and when it comes back it is raised again, the old reason cleared
    const resolved = applyChanges(dismissed(), gone, 'finding');
    expect(resolved[0]).toMatchObject({ state: 'resolved', dismissed_reason: 'EC already told by email' });
    expect(reconcileFindings({ projectId: PROJECT, existing: resolved, output: out.findings, lintIds: LINTS })).toEqual([
      { kind: 'set', entity: 'finding', id, fields: { state: 'open', message: out.findings[0]!.message, level_id: out.findings[0]!.level_id, dismissed_reason: null } },
    ]);
  });
});
