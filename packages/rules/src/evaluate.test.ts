import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { proposalId, proposalKey } from './rule';
import type { Rule } from './rule';
import { END_A, PANEL, PROJECT, RUN_RULE, ISSUE_RULE, sampleSnapshot } from './testing/sample';

describe('evaluate', () => {
  it('returns no proposals or findings for an empty rule set', () => {
    expect(evaluate(sampleSnapshot(), [])).toMatchObject({ proposals: [], findings: [], problems: [] });
  });

  it('keys each proposal by (rule, subject, discriminator), with a deterministic id and an inputs hash', () => {
    const out = evaluate(sampleSnapshot(), [RUN_RULE]);
    expect(out.proposals).toHaveLength(1);
    const p = out.proposals[0]!;
    expect(p.key).toBe(proposalKey('T.run', { entity_kind: 'cable_end', entity_id: END_A }));
    expect(p.id).toBe(proposalId(PROJECT, p.key));
    expect(p.payload).toMatchObject({ item: 'Run X to 06M-03', type: 'Cable not run', owner: 'EC', why: 'DMX to 06M-03 is Not installed.' });
    expect(p.inputs_hash).toHaveLength(64);
    // the same snapshot evaluates to the same output, on any iPad
    const again = evaluate(sampleSnapshot(), [RUN_RULE]);
    expect(again.proposals).toEqual(out.proposals);
    // a changed input changes the hash, not the id
    const s = sampleSnapshot();
    s.devices.find((d) => d.id !== PANEL)!.display_id = '06M-04';
    const changed = evaluate(s, [RUN_RULE]).proposals[0]!;
    expect(changed.id).toBe(p.id);
    expect(changed.inputs_hash).not.toBe(p.inputs_hash);
  });

  it('produces findings with the lint id, level and a key; owned lint ids include declared ones', () => {
    const s = sampleSnapshot();
    s.devices[0]!.status = 'Issue';
    const out = evaluate(s, [ISSUE_RULE]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ lint_id: 'T.issue.none', rule_id: 'T.issue', level_id: s.levels[0]!.id, subject: { entity_kind: 'device', entity_id: PANEL } });
    expect([...out.lintIds].sort()).toEqual(['T.issue', 'T.issue.none']);
  });

  it('reports a rule that throws and a duplicate key, and keeps the first proposal', () => {
    const bad: Rule = { id: 'T.bad', title: 'bad', text: '', run: () => { throw new Error('nope'); } };
    const twice: Rule = {
      id: 'T.twice', title: 'twice', text: '',
      run: (ctx) => {
        ctx.propose({ subject: { entity_kind: 'device', entity_id: PANEL }, kind: 'note', payload: { now: 'first' } });
        ctx.propose({ subject: { entity_kind: 'device', entity_id: PANEL }, kind: 'note', payload: { now: 'second' } });
        ctx.propose({ subject: { entity_kind: 'device', entity_id: PANEL }, discriminator: 'x', kind: 'note', payload: { now: 'third' } });
      },
    };
    const out = evaluate(sampleSnapshot(), [bad, twice, RUN_RULE]);
    expect(out.problems).toEqual([
      { rule_id: 'T.bad', kind: 'threw', message: 'nope' },
      { rule_id: 'T.twice', kind: 'duplicate', message: expect.stringContaining('T.twice|device:') },
    ]);
    expect(out.proposals.map((p) => p.payload.now ?? p.payload.item)).toEqual(['first', 'third', 'Run X to 06M-03']);
  });
});
