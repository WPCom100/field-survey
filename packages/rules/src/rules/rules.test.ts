/**
 * Unit tests per rule (T34), over hand-built snapshots: exact phrases (CLAUDE.md §3), keys and
 * payloads, and what each rule leaves alone. Pure: `evaluate` only, nothing written.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../evaluate';
import { inputsHash, proposalKey, type Rule } from '../rule';
import { indexSnapshot } from '../snapshot';
import { Build } from '../testing/build';
import { Acc, E5 } from './e5';
import { R1 } from './r1';
import { RuleParams, type RuleParamRow } from '../params';
import { CABLE_CODES, R2g, addressNeeds, cableCodes, cablesOfDevice, fillLibraryCable, needsNeuronId, parseLibraryCables } from './library';
import { R2a, R2b, R2c, R2d, R2e, R2f } from './r2';
import { LintCableNeedsAccessory, LintFarEnd, LintVocab } from './lint';
import { R3a, R3b, R3c, R3d, R3f } from './r3';
import { R4a, R4b, R4d } from './r4';
import { RULES } from './index';

const NOW = '2026-10-15T12:00:00.000Z';
const run = (b: Build, rules: readonly Rule[]) => evaluate(b.snap, rules, undefined, { now: NOW });
const items = (b: Build, rules: readonly Rule[]) => run(b, rules).proposals.map((p) => p.payload.item ?? p.payload.part ?? p.payload.now);
const messages = (b: Build, rules: readonly Rule[]) => run(b, rules).findings.map((f) => f.message);
/** The library's live types as the rules index them. */
const typesOf = (b: Build) => indexSnapshot(b.snap).libraryType;

/** A floor with a surveyed date, a relay panel and the Fixtures / bus / power placeholders. */
function floor(b: Build, code = '06M') {
  const level = b.level(code, { surveyed: '2026-10-13' });
  const panel = b.device(level, 'Relay panel', { display_id: `${code}-01`, device: 'CT06LCPA', panel_name: 'CT06LCPA' });
  const fixtures = b.placeholder('Fixtures', 'fixtures');
  const bus = b.placeholder('Stations & Sensors', 'station_bus');
  const power = b.placeholder('120v Power', 'power');
  return { level, panel, fixtures, bus, power };
}

describe('R1 device status findings', () => {
  it('flags Installed, untested with outstanding wiring, Issue without an open item, and Complete before the completion phase', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    panel.status = 'Installed, untested';
    const far = b.device(level, 'Relay panel', { display_id: '06M-02', status: 'Issue' });
    b.cable('X', { device: panel, status: 'Not installed' }, { device: far });
    const done = b.device(level, 'Station', { display_id: '06M-S1', status: 'Complete' });
    const ok = b.device(level, 'Station', { display_id: '06M-S2', status: 'Issue' });
    b.punch(level, { device_id: ok.id, item: 'Fix it', type: 'Wiring' });
    const out = run(b, [R1]);
    expect(out.findings.map((f) => [f.lint_id, f.subject.entity_id, f.message])).toEqual([
      ['R1.untested', panel.id, 'Installed, untested with outstanding wiring/termination → Issue (suggested)'],
      ['R1.no_item', far.id, 'Issue device with no open punch item'],
      ['R1.complete', done.id, 'Complete used before the completion phase'],
    ]);
    expect(out.proposals).toEqual([]);
    expect(out.lintIds).toEqual(new Set(['R1', 'R1.untested', 'R1.no_item', 'R1.complete']));
  });

  it('is quiet when nothing is outstanding, an open item exists, or the completion phase is on', () => {
    const b = new Build(undefined, { completion_phase: true });
    const { level, panel } = floor(b);
    panel.status = 'Installed, untested';
    b.cable('X', { device: panel, status: 'Installed, untested' }, null);
    b.punch(level, { device_id: panel.id, item: 'Closed one', type: 'Wiring', tracking_status: 'Closed' });
    b.device(level, 'Station', { display_id: '06M-S1', status: 'Complete' });
    expect(run(b, [R1]).findings).toEqual([]);
  });
});

describe('R2a note / status mismatch (lint only, D172)', () => {
  it('flags the three contradictions and never proposes a note', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    b.cable('X', { device: panel, display_id: 'C-01', status: 'Not installed', note: 'Run, not terminated' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-02', status: 'Issue', note: 'Not run' }, { device: far });
    b.cable('U', { device: panel, display_id: 'C-03', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-04', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-05', status: 'Not installed', note: null }, { device: far });
    // T103 (D213): network takes kits by default; a cable's own setting overrides its code
    b.cable('N', { device: panel, display_id: 'C-06', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-07', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far }, { term_kit: false });
    b.cable('U', { device: panel, display_id: 'C-08', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far }, { term_kit: true });
    const out = run(b, [R2a]);
    expect(out.proposals).toEqual([]);
    expect(out.findings.map((f) => f.message)).toEqual([
      'C-01: the note says "Run, not terminated" but the end is Not installed',
      'C-02: the note says "Not run" but the end is Issue',
      'C-03: the note says "no term kit" but this U cable takes no termination kits',
      'C-07: the note says "no term kit" but this X cable takes no termination kits',
    ]);
  });
});

describe('R2b To ≠ riser', () => {
  it('flags the A end whose To text does not say what the riser label says', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    b.cable('N', { device: panel, display_id: 'C-11', to_text: 'Network to Level 07 rack' }, { device: far }, { riser_to_label: 'NETWORK TO LEVEL 07 RACK' });
    const bad = b.cable('U', { device: panel, display_id: 'C-15', to_text: 'Stations & Sensors' }, { device: far }, { riser_to_label: 'UNISON TO 06M STATIONS' });
    b.cable('X', { device: panel, display_id: 'C-16', to_text: null }, { device: far }, { riser_to_label: 'DMX TO LEVEL 03' });
    const out = run(b, [R2b]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ subject: { entity_kind: 'cable_end', entity_id: bad.a.id, level_id: level.id }, message: 'C-15: To "Stations & Sensors" does not match the riser "UNISON TO 06M STATIONS"' });
  });
});

describe('no cable by role (T199, D289, D290); R2e, the level\'s Unison bus, stays a draft (D173)', () => {
  it('being a relay panel, an NSPS or a rack gives a device no cable: no draft, no finding', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    b.device(level, 'EBDK', { display_id: '06M-03', device: 'EBDK', panel_name: 'CT06LCPA' });
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05', device: 'P-NSPS-D-KIT' });
    const rack = b.device(level, 'Equipment rack', { display_id: '06M-06', device: 'Equipment rack' });
    const out = run(b, RULES);
    expect(out.problems).toEqual([]);
    const cables = out.proposals.filter((p) => p.kind === 'cable');
    // the only cable draft is the level's bus (R2e), hosted by the NSPS
    expect(cables.map((p) => [p.rule_id, p.subject.entity_kind, p.discriminator])).toEqual([['R2e', 'level', 'U']]);
    expect(out.findings.filter((x) => [panel.id, nsps.id, rack.id].includes(x.subject.entity_id)).map((x) => x.lint_id)).toEqual([]);
    // R2c and R2d stay registered and draft nothing; their lints are gone
    expect(run(b, [R2c, R2d])).toMatchObject({ proposals: [], findings: [] });
    expect(RULES.map((r) => r.id).filter((id) => /power_120v|relay_cables/.test(id))).toEqual([]);
  });

  it('offers one Unison pair per in-scope level, Stations & Sensors ↔ the NSPS, or the rack where there is none', () => {
    const b = new Build();
    const { level, bus } = floor(b);
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05', device: 'P-NSPS-D' });
    const l01 = b.level('01', { surveyed: '2026-10-13' });
    const rack = b.device(l01, 'Equipment rack', { display_id: '01-01', device: 'Equipment rack' });
    b.level('09', { in_scope: false });
    const l03 = b.level('03');
    b.device(l03, 'Station', { display_id: '03-S1' }); // no host → nothing
    const out = run(b, [R2e]);
    expect(out.proposals.map((p) => [p.subject.entity_kind, p.subject.entity_id, p.discriminator])).toEqual([
      ['level', level.id, 'U'],
      ['level', l01.id, 'U'],
    ]);
    expect(out.proposals[0]!.payload).toMatchObject({
      cable: { cable: 'U', qty: null, single_row: false, origin: 'library' },
      ends: [
        { side: 'A', device_id: nsps.id, level_id: level.id, from_text: 'P-NSPS-D', to_text: 'Unison from stations & sensors' },
        { side: 'B', endpoint_kind: 'placeholder', placeholder_id: bus.id, level_id: level.id, from_text: 'Stations & Sensors', to_text: 'Devices to P-NSPS-D' },
      ],
    });
    expect((out.proposals[1]!.payload.ends as Record<string, unknown>[])[1]).toMatchObject({ to_text: 'Devices to equipment rack' });
    expect((out.proposals[1]!.payload.ends as Record<string, unknown>[])[0]).toMatchObject({ device_id: rack.id });
    // a level with any U end already is left alone
    b.cable('U', { device: nsps, to_text: 'Unison from stations & sensors' }, { placeholder: bus, level });
    expect(run(b, [R2e]).proposals.map((p) => p.subject.entity_id)).toEqual([l01.id]);
  });
});

describe('R2g device-type library cables (T48, D183)', () => {
  const tenV = { code: '0-10V', to: 'Fixtures', far: 'Fixtures', single_row: true, qty: 1 };
  it('an accepted type offers its default cables to every device of the type, by id or by model / alias', () => {
    const b = new Build();
    const { level, panel, fixtures } = floor(b);
    const type = b.libraryType('ERP-FT-241P', 'Relay panel', { aliases: ['CT06LCPA'], default_cables: [tenV, { code: 'X', to: 'DMX to Fixtures', far: 'Gateway' }, { code: 'X', to: 'DMX 2' }, { code: 'U', to: 'bus' }] });
    const linked = b.device(level, 'Relay panel', { display_id: '06M-02', device: 'Other', library_type_id: type.id });
    const out = run(b, [R2g]);
    // the panel matches by alias (its Device text), the second by id; U is R2e's, never R2g's
    expect(out.proposals.map((p) => [p.subject.entity_id, p.discriminator])).toEqual([
      [panel.id, '0-10V'], [panel.id, 'X'], [panel.id, 'X#2'],
      [linked.id, '0-10V'], [linked.id, 'X'], [linked.id, 'X#2'],
    ]);
    expect(out.proposals[0]!.payload).toMatchObject({
      cable: { cable: '0-10V', qty: 1, single_row: true, origin: 'library', endpoint_confirmed: true },
      ends: [
        { side: 'A', endpoint_kind: 'device', device_id: panel.id, from_text: 'CT06LCPA', to_text: 'Fixtures' },
        { side: 'B', endpoint_kind: 'placeholder', placeholder_id: fixtures.id, from_text: 'Fixtures' },
      ],
    });
    // no placeholder named "Gateway": the far end is text only
    expect((out.proposals[1]!.payload.ends as Record<string, unknown>[])[1]).toMatchObject({ endpoint_kind: null, from_text: 'Gateway', level_id: level.id });
    expect(out.proposals[0]!.why).toBe('06M-01 is a ERP-FT-241P (library: 0-10V → Fixtures).');
    // one X run present → only the second X is still offered on the panel
    b.cable('X', { device: panel, to_text: 'DMX to Fixtures' });
    expect(run(b, [R2g]).proposals.filter((p) => p.subject.entity_id === panel.id).map((p) => p.discriminator)).toEqual(['0-10V', 'X#2']);
  });

  it('only an accepted type\'s default cables are required: a draft type and an optional cable draft nothing (D183 (2), D292 (3))', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05', device: 'P-NSPS-D-KIT' });
    const draft = b.libraryType('CT06LCPA', 'Relay panel', { state: 'draft', default_cables: [tenV] });
    // the import writes a type's rows undecided: optional, nothing required (D292 (1))
    const empty = b.libraryType('P-NSPS-D-KIT', 'NSPS', { optional_cables: [{ code: '120V', single_row: true, qty: 1 }, { code: 'N' }] });
    expect(run(b, [R2g]).proposals).toEqual([]);
    // a draft type's rows, and an accepted type's optional ones, are offered on the card only
    expect(cablesOfDevice(typesOf(b), panel).optional.map((r) => r.cable.code)).toEqual(['0-10V']);
    expect(cablesOfDevice(typesOf(b), nsps)).toMatchObject({ required: [], optional: [{ cable: { code: '120V' }, via: null }, { cable: { code: 'N' }, via: null }] });
    // accepting the draft, and answering Required for the NSPS's 120V, makes both runs R2g's
    draft.state = 'accepted';
    empty.optional_cables = [{ code: 'N' }];
    empty.default_cables = [{ code: '120V', from: '120v Power', to: 'P-NSPS-D Power Supply', far: '120v Power', single_row: true, qty: 1 }];
    const out = run(b, [R2g]);
    expect(out.proposals.map((p) => [p.subject.entity_id, p.discriminator])).toEqual([[panel.id, '0-10V'], [nsps.id, '120V']]);
    // editing the template changes the inputs, so the open draft is re-proposed with the new text
    const before = out.proposals[1]!.inputs_hash;
    empty.default_cables = [{ code: '120V', from: '120v Power', to: 'NSPS power', far: '120v Power', single_row: true, qty: 1 }];
    const after = run(b, [R2g]).proposals[1]!;
    expect(after.inputs_hash).not.toBe(before);
    expect((after.payload.ends as Record<string, unknown>[])[0]).toMatchObject({ to_text: 'NSPS power' });
    // a rejected type is never matched by model
    empty.state = 'rejected';
    expect(run(b, [R2g]).proposals.map((p) => p.subject.entity_id)).toEqual([panel.id]);
  });

  it("a type's row is never hidden by a code the project's list lacks; the code lint flags it there (T196, D287 (5))", () => {
    const b = new Build();
    const { panel } = floor(b);
    b.libraryType('CT06LCPA', 'Relay panel', { default_cables: [tenV, { code: 'DX', to: 'DALI-2 bus', far: 'Fixtures' }, { to: 'no code' }] });
    // the project's Rules give DX no signal word: the run is drafted all the same
    expect(cableCodes()).toEqual(CABLE_CODES);
    const out = run(b, [R2g]);
    expect(out.proposals.map((p) => [p.subject.entity_id, p.discriminator])).toEqual([[panel.id, '0-10V'], [panel.id, 'DX']]);
    expect(out.proposals[1]!.payload).toMatchObject({ cable: { cable: 'DX' } });
    // a row with no code is the only one dropped
    expect(parseLibraryCables([{ code: 'DX' }, { code: 'X' }, { code: '' }, { to: 'x' }]).map((c) => c.code)).toEqual(['DX', 'X']);
    // the project's list is what the cable-code lint reads: DX is flagged until its Rules name it (T117)
    b.cable('DX', { device: panel });
    expect(run(b, [LintVocab]).findings.map((f) => f.subject.discriminator)).toEqual(['cable=DX']);
    const row: RuleParamRow = { id: 'rp', project_id: b.snap.projectId, rule_id: 'R3', key: 'signal', value: { DX: 'DALI-2' }, state: 'accepted', deleted_at: null };
    b.snap.ruleParams = [row];
    expect(cableCodes(new RuleParams([row]))).toEqual([...CABLE_CODES, 'DX']);
    expect(run(b, [LintVocab]).findings).toEqual([]);
  });
});

describe('R2f no copied status (D171)', () => {
  it('never copies a surveyed status to the other end; offers Not started for runs to or on an out-of-scope level', () => {
    const b = new Build();
    const { panel } = floor(b);
    const l03 = b.level('03', { surveyed: '2026-10-13' });
    const l09 = b.level('09', { in_scope: false });
    const far = b.device(l03, 'Relay panel', { display_id: '03-01' });
    const rack9 = b.device(l09, 'Equipment rack', { display_id: '09-01' });
    // surveyed here, unsurveyed there, both in scope: nothing
    b.cable('X', { device: panel, display_id: 'C-01', status: 'Issue', note: 'Run, not terminated', surveyed_at: NOW }, { device: far });
    // far end on an out-of-scope level: both ends offered Not started
    const up = b.cable('N', { device: panel, display_id: 'C-20', to_text: 'Network to Level 09' }, { device: rack9 });
    // placeholder "Level 10 (not in scope)"
    const lvl10 = b.placeholder('Level 10', 'level_not_in_scope');
    const ph = b.cable('N', { device: panel, display_id: 'C-21', to_text: 'Network to Level 10' }, { placeholder: lvl10 });
    // already Not started: nothing
    b.cable('N', { device: panel, display_id: 'C-22', status: 'Not started' }, { placeholder: lvl10 });
    const out = run(b, [R2f]);
    expect(out.proposals.map((p) => [p.subject.entity_id, p.kind, p.payload.now, p.why])).toEqual([
      [up.a.id, 'status', 'Not started', 'C-20: The far end is on Level 09, out of scope.'],
      [up.b!.id, 'status', 'Not started', '09-01 network end: Level 09 is out of scope; it will not be surveyed.'],
      [ph.a.id, 'status', 'Not started', 'C-21: The far end "Level 10" is out of scope.'],
    ]);
    expect(out.proposals[0]!.payload.extra).toEqual({ status_source: 'derived' });
    for (const e of b.snap.cableEnds) if (e.status == null && e.cable_id === b.snap.cableEnds[1]!.cable_id) expect(out.proposals.some((p) => p.subject.entity_id === e.id)).toBe(false);
  });
});

describe('R3a Cable not run / Termination', () => {
  it('names the run from the To text, the far device or the placeholder, with the master\'s wording per code', () => {
    const b = new Build();
    const { level, panel, bus, fixtures } = floor(b);
    const l03 = b.level('03', { surveyed: '2026-10-13' });
    const far = b.device(l03, 'Relay panel', { display_id: '03-01' });
    const here = b.device(level, 'Foundry panel', { display_id: '06M-07', device: 'UFMP4' });
    b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03 CT03LCPA', status: 'Not installed' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-02', status: 'Not installed' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-03', status: 'Not installed' }, { device: here });
    b.cable('U', { device: panel, display_id: 'C-04', status: 'Not installed' }, { placeholder: bus });
    b.cable('0-10V', { device: panel, display_id: 'C-05', to_text: 'Fixtures', status: 'Not installed' }, { placeholder: fixtures }, { single_row: true });
    b.cable('N', { device: panel, display_id: 'C-06', to_text: 'Network to Level 03', status: 'Not installed' }, null);
    const out = run(b, [R3a]);
    expect(out.proposals.map((p) => p.payload.item)).toEqual([
      'Run DMX to Level 03 CT03LCPA',
      'Run DMX to Level 03 03-01',
      'Run DMX to 06M-07',
      'Run Unison to Stations & Sensors',
      'Run and land 0-10V control wiring',
      'Run network to Level 03',
    ]);
    const first = out.proposals[0]!;
    expect(first).toMatchObject({ kind: 'punch', subject: { entity_kind: 'cable_end', level_id: level.id }, discriminator: null });
    expect(first.payload).toMatchObject({ type: 'Cable not run', owner: 'EC', device_id: panel.id, level_id: level.id });
    expect(first.payload).not.toHaveProperty('device_text');
    expect(first.why).toBe('C-01 (DMX to Level 03 CT03LCPA) is Not installed: the wire has not been pulled.');
  });

  it('turns into a Termination item once the wire is run but not terminated; a DMX "no term kit" end is R3b\'s', () => {
    const b = new Build();
    const { level, panel, fixtures } = floor(b);
    const far = b.device(level, 'Equipment rack', { display_id: '06M-09' });
    b.cable('N', { device: panel, display_id: 'C-01', to_text: 'Network to Level 02', status: 'Issue', note: 'Net run, not terminated' }, { device: far });
    b.cable('F', { device: panel, display_id: 'C-02', to_text: 'Equipment rack Level 06', status: 'Issue', note: 'Run, not terminated' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-03', to_text: 'DMX to CT01LCPB', status: 'Issue', note: 'Run, not terminated at rack' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-04', to_text: 'DMX to Level B1', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('0-10V', { device: panel, display_id: 'C-05', to_text: 'Fixtures', status: 'Issue', note: 'Not landed' }, { placeholder: fixtures }, { single_row: true });
    b.cable('120V', { device: far, display_id: 'C-06', from_text: '120v Power', to_text: 'Equipment rack', status: 'Issue', note: 'Needs landing' }, null, { single_row: true });
    b.cable('U', { device: panel, display_id: 'C-07', status: 'Issue', note: '2 runs outside conduit' }, { device: far });
    const out = run(b, [R3a, R3b]);
    expect(out.proposals.map((p) => [p.rule_id, p.payload.item, p.payload.type, p.payload.owner])).toEqual([
      ['R3a', 'Terminate network to Level 02', 'Termination', 'ETC'],
      ['R3a', 'Terminate fiber to 06M-09', 'Termination', 'EC/ETC'],
      ['R3a', 'Terminate DMX to CT01LCPB', 'Termination', 'EC/ETC'],
      ['R3a', 'Land 0-10V control wiring', 'Termination', 'EC'],
      ['R3a', 'Land 120V power', 'Termination', 'EC'],
      ['R3b', 'Terminate DMX to Level B1', 'Missing part', 'EC/ETC'],
    ]);
    expect(out.proposals[0]!.discriminator).toBe('terminate');
  });

  it('R5: waits for the floor\'s survey; an open item with the same text already there means no draft', () => {
    const b = new Build();
    const { panel } = floor(b);
    const l03 = b.level('03'); // no Surveyed date
    const far = b.device(l03, 'Relay panel', { display_id: '03-01' });
    const c = b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03', status: 'Not installed' }, { device: far, to_text: 'DMX to Level 06M', status: 'Not installed' });
    expect(items(b, [R3a])).toEqual(['Run DMX to Level 03']); // the 03 end waits
    c.b!.surveyed_at = NOW; // someone surveyed it on an iPad → no longer waits; one item per wire, on side A
    expect(items(b, [R3a])).toEqual(['Run DMX to Level 03']);
    c.a.status = 'Installed, untested'; // only the far end is still unpulled → it carries the item
    expect(items(b, [R3a])).toEqual(['Run DMX to Level 06M']);
    b.punch(l03, { device_id: far.id, item: 'Run DMX to Level 06M', type: 'Cable not run' });
    expect(items(b, [R3a])).toEqual([]);
  });

  it('T119 (D218): an end holding an open item of the same kind gets no second, whatever its wording; a closed one or another kind does not count', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    const run1 = b.cable('F', { device: panel, display_id: 'C-01', to_text: 'Equipment rack Level 28', status: 'Not installed' }, null);
    const term = b.cable('N', { device: panel, display_id: 'C-02', to_text: 'ERn4 Level 16', status: 'Issue', note: 'Run, not terminated' }, null);
    const kit = b.cable('X', { device: panel, display_id: 'C-03', to_text: 'DMX to Level 01', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    expect(items(b, [R3a, R3b])).toEqual(['Run fiber to Equipment rack Level 28', 'Terminate network to ERn4 Level 16', 'Terminate DMX to Level 01']);
    // the master's wording, imported onto the ends (T119)
    const closed = b.punch(level, { device_id: panel.id, cable_end_id: run1.a.id, item: 'Run fiber to rack', type: 'Cable not run', tracking_status: 'Closed' });
    b.punch(level, { device_id: panel.id, cable_end_id: term.a.id, item: 'Secure the jack', type: 'Wiring' }); // another kind
    expect(items(b, [R3a, R3b])).toHaveLength(3);
    closed.tracking_status = 'Open';
    b.punch(level, { device_id: panel.id, cable_end_id: term.a.id, item: 'Terminate 2x network runs to ERn4 Level 16', type: 'Termination' });
    b.punch(level, { device_id: panel.id, cable_end_id: kit.a.id, item: 'Terminate DMX from Level 01', type: 'Missing part', notes: 'Waiting on DMX Termination Kits' });
    expect(items(b, [R3a, R3b])).toEqual([]);
  });

  it('raises one Run item per wire (D177): on the start of the run (side A), even a placeholder end; a Run item the rule made on the other end stands for the wire', () => {
    const b = new Build();
    const { level, panel, bus } = floor(b);
    const rack = b.device(level, 'Equipment rack', { display_id: '06M-09' });
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05' });
    // both ends surveyed Not installed → side A, the start of the run
    b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to equipment rack', status: 'Not installed' }, { device: rack, display_id: 'C-02', to_text: 'DMX to CT06LCPA', status: 'Not installed' });
    // the run starts at the stations (a placeholder end): the item sits there, with no device
    b.cable('U', { placeholder: bus, level, display_id: 'C-03', to_text: 'Devices to P-NSPS-D', status: 'Not installed' }, { device: nsps, display_id: 'C-04', to_text: 'Unison from stations & sensors', status: 'Not installed' });
    // the rule's own item on the B end (accepted before A was surveyed) keeps A quiet
    const c = b.cable('N', { device: panel, display_id: 'C-05', to_text: 'Network to equipment rack', status: 'Not installed' }, { device: rack, display_id: 'C-06', to_text: 'Network to CT06LCPA', status: 'Not installed' });
    b.punch(level, { device_id: rack.id, cable_end_id: c.b!.id, item: 'Run network to CT06LCPA', type: 'Cable not run', rule_id: 'R3a' });
    const out = run(b, [R3a]);
    expect(out.proposals.map((p) => [p.payload.item, p.payload.device_id])).toEqual([
      ['Run DMX to equipment rack', panel.id],
      ['Run Unison to P-NSPS-D', null],
    ]);
  });

  it('names a single row\'s far end by its To text: a 120V run reads "Run 120V to P-NSPS-D Power Supply", never the power placeholder', () => {
    const b = new Build();
    const { level, power } = floor(b);
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05' });
    const rack = b.device(level, 'Equipment rack', { display_id: '06M-09' });
    b.cable('120V', { device: nsps, display_id: 'C-01', from_text: '120v Power', to_text: 'P-NSPS-D Power Supply', status: 'Not installed', note: 'Not run' }, { placeholder: power }, { single_row: true });
    b.cable('120V', { device: rack, display_id: 'C-02', from_text: '120v Power', to_text: 'Equipment rack', status: 'Not installed', note: 'Not run' }, { placeholder: power }, { single_row: true });
    expect(items(b, [R3a])).toEqual(['Run 120V to P-NSPS-D Power Supply', 'Run 120V to Equipment rack']);
  });
});

describe('R3b termination kit item', () => {
  it('is a device-level Missing part item for EC/ETC with the master\'s note, keyed on the end', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    const c = b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03 UFMP4s', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('U', { device: panel, display_id: 'C-02', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far }); // Unison takes no kits
    const out = run(b, [R3b]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'punch',
      subject: { entity_kind: 'device', entity_id: panel.id, level_id: level.id },
      discriminator: c.a.id,
      payload: { item: 'Terminate DMX to Level 03 UFMP4s', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', device_id: panel.id, cable_end_id: c.a.id, level_id: level.id },
    });
  });

  it('T103 (D213): every code that takes kits (X, F, N, NG by default), worded per code; a cable\'s own setting overrides its code', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Equipment rack', { display_id: '06M-09' });
    const issue = (display_id: string) => ({ device: panel, display_id, status: 'Issue' as const, note: 'Run, not terminated; no term kit' });
    b.cable('F', issue('C-01'), { device: far });
    b.cable('N', issue('C-02'), { device: far });
    b.cable('NG', issue('C-03'), { device: far });
    b.cable('X', issue('C-04'), { device: far }, { term_kit: false }); // this cable: no kits
    b.cable('D', issue('C-05'), { device: far }, { term_kit: true }); // DALI is off by code; this one takes kits
    b.cable('U', issue('C-06'), { device: far });
    expect(run(b, [R3b]).proposals.map((p) => [p.payload.item, p.payload.notes, p.payload.owner])).toEqual([
      ['Terminate fiber to 06M-09', 'Waiting on Fiber Termination Kits', 'EC/ETC'],
      ['Terminate network to 06M-09', 'Waiting on Network Termination Kits', 'EC/ETC'],
      ['Terminate network & ground to 06M-09', 'Waiting on Network Termination Kits', 'EC/ETC'],
      ['Terminate DALI to 06M-09', 'Waiting on DALI Termination Kits', 'EC/ETC'],
    ]);
    // the cables that take no kits get R3a's Termination item instead
    expect(run(b, [R3a]).proposals.map((p) => p.payload.item)).toEqual(['Terminate DMX to 06M-09', 'Terminate Unison to 06M-09']);
  });
});

describe('R3c address items per floor: Missing all / some Device Neuron IDs / IP addresses / DMX addresses (D49, D170, D245, D246, D258)', () => {
  /**
   * One numbering group (06 + 06M): an NSPS hosting the Unison pair (U end, no Neuron chip), two
   * stations riding the bus (Neuron) and one with its ID captured, a gateway with a network run and
   * a DMX run (IP and DMX), a relay panel on the DMX run (DMX) that carries a Neuron ID it does not
   * need, and a rack with only its 120V feed (nothing). 06 holds the NSPS, the panel and the rack.
   */
  function group() {
    const b = new Build();
    const l06 = b.level('06', { numbering_group_id: 'g6', floor_order: 7 });
    const l06m = b.level('06M', { numbering_group_id: 'g6', floor_order: 8 });
    const bus = b.placeholder('Stations & Sensors', 'station_bus');
    const nsps = b.device(l06, 'NSPS', { display_id: '06-02', device: 'P-NSPS-D' });
    b.cable('U', { device: nsps, status: 'Not installed' }, { placeholder: bus });
    const s10 = b.device(l06m, 'Station', { display_id: '06M-S10' });
    const s2 = b.device(l06m, 'Station', { display_id: '06M-S2' });
    const s1 = b.device(l06m, 'Station', { display_id: '06M-S1', neuron_id: '00A1B2C3D4E6' });
    const gw = b.device(l06m, 'Equipment', { display_id: '06M-03', device: 'RSN-DMX8-R' });
    b.cable('N', { device: gw, status: 'Not installed' }, null);
    const panel = b.device(l06, 'Relay panel', { display_id: '06-01', neuron_id: '00A1B2C3D4E5' });
    b.cable('X', { device: panel }, { device: gw });
    const rack = b.device(l06, 'Equipment rack', { display_id: '06-04' });
    b.cable('120V', { device: rack }, null, { single_row: true });
    const lv = (levelId: unknown) => (levelId === l06.id ? '06' : levelId === l06m.id ? '06M' : '?');
    const rp = (key: string, value: unknown): RuleParamRow => ({ id: `rp-${key}`, project_id: b.snap.projectId, rule_id: 'R3c', key, value, state: 'accepted', deleted_at: null });
    return { b, l06, l06m, nsps, s10, s2, s1, gw, panel, rack, lv, rp };
  }

  it('proposes one sort_last Information item per floor and kind: "all" with the Notes phrase when none has the address, "some" with the floor\'s list (T169)', () => {
    const { b, lv } = group();
    b.level('01', { numbering_group_id: 'g1' }); // a floor with no devices: nothing
    const out = run(b, [R3c]);
    expect(out.proposals.map((p) => [lv(p.payload.level_id), p.discriminator, p.payload.item, p.payload.owner, p.payload.device_text, p.payload.notes, p.why])).toEqual([
      ['06', 'dmx', 'Missing all Device DMX addresses', 'EC', 'All devices', 'All devices on this floor', 'The one device on Level 06 that needs a DMX address has none.'],
      ['06M', null, 'Missing some Device Neuron IDs', 'EC', 'See notes', '06M-S2, 06M-S10', '2 of the 3 devices on Level 06M that need a Neuron ID have none.'],
      ['06M', 'ip', 'Missing all Device IP addresses', 'ETC', 'All devices', 'All devices on this floor', 'The one device on Level 06M that needs an IP address has none.'],
      ['06M', 'dmx', 'Missing all Device DMX addresses', 'EC', 'All devices', 'All devices on this floor', 'The one device on Level 06M that needs a DMX address has none.'],
    ]);
    for (const p of out.proposals) {
      // the floors of a shared group (06 / 06M, D33) are each their own subject
      expect(p).toMatchObject({ kind: 'punch', subject: { entity_kind: 'level', entity_id: p.payload.level_id, level_id: p.payload.level_id } });
      expect(p.payload).toMatchObject({ type: 'Information', tracking_status: 'Open', sort_last: true });
    }
    expect(out.upkeep).toEqual([]);
    // the same output on every run (deterministic ids)
    expect(run(b, [R3c]).proposals.map((p) => p.id)).toEqual(out.proposals.map((p) => p.id));
  });

  it('a floor alone in its numbering group keeps T34\'s subject, key and inputs, so its accepted or rejected drafts stay where they were', () => {
    const b = new Build();
    const l = b.level('07', { numbering_group_id: 'g7' });
    b.device(l, 'Station', { display_id: '07-S1' });
    b.device(l, 'Station', { display_id: '07-S2' });
    const out = run(b, [R3c]);
    expect(out.proposals).toHaveLength(1);
    const subject = { entity_kind: 'numbering_group' as const, entity_id: 'g7', level_id: l.id };
    expect(out.proposals[0]).toMatchObject({ key: proposalKey('R3c', subject, null), subject, discriminator: null, inputs_hash: inputsHash({ group: 'g7' }) });
    expect(out.proposals[0]!.payload).toMatchObject({ item: 'Missing all Device Neuron IDs', notes: 'All devices on this floor', device_text: 'All devices' });
  });

  it('keeps an accepted item: Notes and the all / some wording follow the floor, Closed when every device has one, reopened on a new device (D170, D258)', () => {
    const { b, l06m, s10, s2, s1, gw, lv } = group();
    const neuron = b.punch(l06m, { item: 'Missing all Device Neuron IDs', type: 'Information', sort_last: true, device_text: 'All devices', proposal_id: 'prop-1' });
    const ip = b.punch(l06m, { item: 'Missing all Device IP addresses', type: 'Information', sort_last: true });
    let out = run(b, [R3c]);
    expect(out.proposals.map((p) => [lv(p.payload.level_id), p.discriminator])).toEqual([['06', 'dmx'], ['06M', 'dmx']]); // the DMX items are still to be made
    expect(out.upkeep).toEqual([
      { rule_id: 'R3c', entity: 'punch_item', id: neuron.id, fields: { notes: '06M-S2, 06M-S10', item: 'Missing some Device Neuron IDs', device_text: 'See notes' }, proposal_id: 'prop-1', why: '2 devices still without a Neuron ID' },
      { rule_id: 'R3c', entity: 'punch_item', id: ip.id, fields: { notes: 'All devices on this floor', item: 'Missing all Device IP addresses', device_text: 'All devices' }, proposal_id: null, why: '1 device still without an IP address' },
    ]);
    const apply = () => {
      for (const u of out.upkeep) Object.assign(b.snap.punchItems.find((p) => p.id === u.id)!, u.fields);
    };
    apply();
    expect(run(b, [R3c]).upkeep.map((u) => u.fields)).toEqual(out.upkeep.map((u) => u.fields)); // the same values: the engine writes nothing
    // the floor's one captured ID is cleared: none has one, the item reads "all" again
    s1.neuron_id = null;
    out = run(b, [R3c]);
    expect(out.upkeep[0]!.fields).toEqual({ notes: 'All devices on this floor', item: 'Missing all Device Neuron IDs', device_text: 'All devices' });
    apply();
    // every device gets its address: Closed, the wording left as it reads
    s10.neuron_id = '000000000002';
    s2.neuron_id = '000000000003';
    s1.neuron_id = '000000000004';
    gw.ip_address = '10.101.4.23';
    out = run(b, [R3c]);
    expect(out.upkeep.map((u) => u.fields)).toEqual([
      { notes: null, item: 'Missing all Device Neuron IDs', device_text: 'All devices', tracking_status: 'Closed', date_closed: '2026-10-15' },
      { notes: null, item: 'Missing all Device IP addresses', device_text: 'All devices', tracking_status: 'Closed', date_closed: '2026-10-15' },
    ]);
    apply();
    // a new sensor reopens the Neuron item, worded "some" (three of the four have theirs); the IP item stays closed
    b.device(l06m, 'Sensor', { display_id: '06M-D1' });
    out = run(b, [R3c]);
    expect(out.upkeep.map((u) => u.fields)).toEqual([
      { notes: '06M-D1', item: 'Missing some Device Neuron IDs', device_text: 'See notes', tracking_status: 'Open', date_closed: null },
      { notes: null, item: 'Missing all Device IP addresses', device_text: 'All devices' },
    ]);
  });

  it('an item kept for the whole group before T169 stays on its floor: it closes when that floor has none missing, and the other floor gets its own draft', () => {
    const { b, l06, lv } = group();
    const neuron = b.punch(l06, { item: 'Missing all Device Neuron IDs', type: 'Information', sort_last: true, device_text: 'All devices', notes: '06M-S2, 06M-S10', rule_id: 'R3c', proposal_id: 'prop-1' });
    const out = run(b, [R3c]);
    expect(out.upkeep).toEqual([
      { rule_id: 'R3c', entity: 'punch_item', id: neuron.id, fields: { notes: null, item: 'Missing all Device Neuron IDs', device_text: 'All devices', tracking_status: 'Closed', date_closed: '2026-10-15' }, proposal_id: 'prop-1', why: 'Every device has its Neuron ID' },
    ]);
    expect(out.proposals.filter((p) => p.discriminator === null).map((p) => [lv(p.payload.level_id), p.payload.item, p.payload.notes])).toEqual([['06M', 'Missing some Device Neuron IDs', '06M-S2, 06M-S10']]);
  });

  it('an R3c item is told from the others by its proposal\'s discriminator, else by its text; one worded otherwise keeps its Item and Device', () => {
    const { b, l06m, lv, rp } = group();
    b.snap.ruleParams = [rp('ip.item', 'Missing all IP addresses')];
    // an accepted IP item under the project's wording, and a rule-made item whose proposal says "dmx" though its text was edited
    const ip = b.punch(l06m, { item: 'Missing all IP addresses', type: 'Information', sort_last: true });
    b.snap.proposals.push({ id: 'prop-dmx', project_id: b.snap.projectId, rule_id: 'R3c', subject: { entity_kind: 'level', entity_id: l06m.id }, discriminator: 'dmx', kind: 'punch', payload: null, inputs_hash: null, state: 'accepted', decided_by_id: null, decided_at: null, deleted_at: null });
    const dmx = b.punch(l06m, { item: 'DMX addresses still to capture', device_text: 'Gateways', type: 'Information', sort_last: true, rule_id: 'R3c', proposal_id: 'prop-dmx' });
    const out = run(b, [R3c]);
    expect(out.proposals.map((p) => [lv(p.payload.level_id), p.discriminator])).toEqual([['06', 'dmx'], ['06M', null]]);
    expect(out.upkeep.map((u) => [u.id, u.fields])).toEqual([
      [ip.id, { notes: 'All devices on this floor', item: 'Missing all IP addresses', device_text: 'All devices' }],
      [dmx.id, { notes: 'All devices on this floor' }],
    ]);
  });

  it('the "some" wording, its Device text and the "all" Notes phrase are parameters; an item on the built-in wording takes the project\'s', () => {
    const { b, l06m, lv, rp } = group();
    b.snap.ruleParams = [rp('some.item', 'Neuron IDs still to capture'), rp('some.device_text', 'Listed in Notes'), rp('all.notes', 'None captured yet')];
    const out = run(b, [R3c]);
    expect(out.proposals.filter((p) => lv(p.payload.level_id) === '06M').map((p) => [p.discriminator, p.payload.item, p.payload.device_text, p.payload.notes])).toEqual([
      [null, 'Neuron IDs still to capture', 'Listed in Notes', '06M-S2, 06M-S10'],
      ['ip', 'Missing all Device IP addresses', 'All devices', 'None captured yet'],
      ['dmx', 'Missing all Device DMX addresses', 'All devices', 'None captured yet'],
    ]);
    const item = b.punch(l06m, { item: 'Missing some Device Neuron IDs', device_text: 'See notes', type: 'Information', sort_last: true });
    expect(run(b, [R3c]).upkeep).toMatchObject([{ id: item.id, fields: { notes: '06M-S2, 06M-S10', item: 'Neuron IDs still to capture', device_text: 'Listed in Notes' } }]);
  });

  it('a type\'s flag overrides the wires both ways; the rules\' code maps are parameters (D245 (1), D247)', () => {
    const { b, l06, l06m, nsps, panel, lv, rp } = group();
    // the NSPS type says Needed: the host is listed; a station type says Not needed: its devices drop
    b.libraryType('P-NSPS-D', 'NSPS', { needs_neuron_id: true });
    const station = b.libraryType('PI1002', 'Station', { needs_neuron_id: false, needs_ip_address: true });
    b.device(l06m, 'Station', { display_id: '06M-S7', library_type_id: station.id, ip_address: '10.101.4.7' });
    // the panel's type says no DMX address though a DMX run lands on it
    const erp = b.libraryType('ERP24-FT', 'Relay panel', { needs_dmx_address: false });
    panel.library_type_id = erp.id;
    let out = run(b, [R3c]);
    expect(out.proposals.map((p) => [lv(p.payload.level_id), p.discriminator, p.payload.notes])).toEqual([
      ['06', null, 'All devices on this floor'], // the NSPS, alone on 06
      ['06M', null, '06M-S2, 06M-S10'],
      ['06M', 'ip', '06M-03'], // "some": the station type's IP need counts 06M-S7, which has one
      ['06M', 'dmx', 'All devices on this floor'],
    ]);
    expect(nsps.display_id).toBe('06-02');
    // the project says a DALI run (D) needs a DMX address too, and its IP item belongs to EC/ETC
    b.snap.ruleParams = [rp('dmx_codes', { D: true }), rp('ip.owner', 'EC/ETC')];
    const dali = b.device(l06, 'Equipment', { display_id: '06-05', device: 'DALI gateway' });
    b.cable('D', { device: dali }, null);
    out = run(b, [R3c]);
    expect(out.proposals.filter((p) => p.discriminator === 'dmx').map((p) => [lv(p.payload.level_id), p.payload.notes])).toEqual([
      ['06', 'All devices on this floor'],
      ['06M', 'All devices on this floor'],
    ]);
    expect(out.proposals.find((p) => p.discriminator === 'ip')!.payload.owner).toBe('EC/ETC');
  });

  it('proposes nothing for a floor whose devices need no address', () => {
    const b = new Build();
    const l = b.level('07', { numbering_group_id: 'g7' });
    const rack = b.device(l, 'Equipment rack', { display_id: '07-01' });
    b.cable('120V', { device: rack }, null, { single_row: true });
    const nsps = b.device(l, 'NSPS', { display_id: '07-02' });
    b.cable('U', { device: nsps }, { placeholder: b.placeholder('Stations & Sensors', 'station_bus') });
    b.device(l, 'Relay panel', { display_id: '07-03' }); // no cable record, no type: nothing is known of its wires
    expect(run(b, [R3c]).proposals).toEqual([]);
  });

  it('R3f leaves the address items alone, whatever the project\'s punch_item vocabulary holds (the engine rewords them)', () => {
    const { b, l06m } = group();
    b.vocab('punch_item', 'Missing all Device Neuron IDs');
    b.punch(l06m, { item: 'Missing some Device Neuron IDs', type: 'Information', sort_last: true });
    const hand = b.punch(l06m, { item: 'Missing some labels', type: 'Information' });
    expect(run(b, [R3f]).findings.map((f) => f.subject.entity_id)).toEqual([hand.id]);
  });
});

describe('addressNeeds (T146, D245): what a device needs is read off the wires it gets', () => {
  const station = { category: 'Station' };
  const any = { category: 'Equipment' };
  it('U → Neuron ID, N / NG → IP address, X → DMX address; other codes nothing', () => {
    expect(addressNeeds(null, any, ['U'])).toEqual({ neuron: true, ip: false, dmx: false });
    expect(addressNeeds(null, any, ['N'])).toEqual({ neuron: false, ip: true, dmx: false });
    expect(addressNeeds(null, any, ['NG'])).toEqual({ neuron: false, ip: true, dmx: false });
    expect(addressNeeds(null, any, ['X'])).toEqual({ neuron: false, ip: false, dmx: true });
    expect(addressNeeds(null, any, ['X', 'N', 'U'])).toEqual({ neuron: true, ip: true, dmx: true });
    expect(addressNeeds(null, any, ['P', '0-10V', '120V', 'F', 'UV', 'D'])).toEqual({ neuron: false, ip: false, dmx: false });
    expect(addressNeeds(null, { category: 'Relay panel' }, [])).toEqual({ neuron: false, ip: false, dmx: false });
    expect(needsNeuronId(null, { category: 'Power Distribution' }, ['U'])).toBe(true);
  });
  it('a device with no cable record reads its accepted type\'s default cables; a draft type\'s count for nothing', () => {
    const type = { category: 'Touchscreen', state: 'accepted', default_cables: [{ code: 'N' }, { code: 'X' }] };
    expect(addressNeeds(type, any, [])).toEqual({ neuron: false, ip: true, dmx: true });
    expect(addressNeeds(type, any, null)).toEqual({ neuron: false, ip: true, dmx: true });
    expect(addressNeeds({ ...type, state: 'draft' }, any, [])).toEqual({ neuron: false, ip: false, dmx: false });
    // the device's own ends win over the type's templates
    expect(addressNeeds(type, any, ['U'])).toEqual({ neuron: true, ip: false, dmx: false });
  });
  it('a station or sensor rides the Stations & Sensors bus: Neuron ID with no ends of its own (D50, R2e)', () => {
    expect(addressNeeds(null, station, [])).toEqual({ neuron: true, ip: false, dmx: false });
    expect(addressNeeds(null, { category: 'Sensor' }, null)).toEqual({ neuron: true, ip: false, dmx: false });
    expect(addressNeeds({ category: 'Equipment', role: 'station' }, any, ['N'])).toEqual({ neuron: true, ip: true, dmx: false });
  });
  it('an NSPS or rack hosting the Unison pair needs no Neuron ID (D185), but an IP or DMX address when such a run lands on it', () => {
    expect(addressNeeds(null, { category: 'NSPS' }, ['U', '120V'])).toEqual({ neuron: false, ip: false, dmx: false });
    expect(addressNeeds(null, { category: 'Equipment Panels' }, ['U', 'N', 'X'])).toEqual({ neuron: false, ip: true, dmx: true });
    expect(addressNeeds({ category: 'Equipment', role: 'nsps' }, any, ['U'])).toEqual({ neuron: false, ip: false, dmx: false });
  });
  it('the type\'s explicit flag overrides both ways; null is by the wires', () => {
    expect(addressNeeds({ needs_neuron_id: true, category: 'NSPS' }, any, ['U'])).toEqual({ neuron: true, ip: false, dmx: false });
    expect(addressNeeds({ needs_neuron_id: false, category: 'Station' }, station, [])).toEqual({ neuron: false, ip: false, dmx: false });
    expect(addressNeeds({ needs_ip_address: true, needs_dmx_address: true }, any, [])).toEqual({ neuron: false, ip: true, dmx: true });
    expect(addressNeeds({ needs_ip_address: false, needs_dmx_address: false }, any, ['N', 'X', 'U'])).toEqual({ neuron: true, ip: false, dmx: false });
    expect(addressNeeds({ needs_neuron_id: null, needs_ip_address: null, needs_dmx_address: null }, any, ['N'])).toEqual({ neuron: false, ip: true, dmx: false });
  });
  it('reads the code maps from the project\'s parameters', () => {
    const params = new RuleParams([{ id: 'rp', project_id: 'p', rule_id: 'R3c', key: 'ip_codes', value: { N: false, F: true }, state: 'accepted', deleted_at: null }]);
    expect(addressNeeds(null, any, ['N'], params)).toEqual({ neuron: false, ip: false, dmx: false });
    expect(addressNeeds(null, any, ['F'], params)).toEqual({ neuron: false, ip: true, dmx: false });
    expect(addressNeeds(null, any, ['NG'], params).ip).toBe(true);
  });
});

describe('R3d / R3f item text lints', () => {
  it('flags test/commission items and, when the vocabulary exists, hand-typed items outside it', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const t = b.punch(level, { device_id: panel.id, item: 'Test the panel', type: 'Information' });
    b.punch(level, { device_id: panel.id, item: 'Commissioning walk', type: 'Information', tracking_status: 'Closed' });
    const odd = b.punch(level, { device_id: panel.id, item: 'Something odd', type: 'Wiring' });
    b.punch(level, { device_id: panel.id, item: 'Run DMX to Level 03', type: 'Cable not run', rule_id: 'R3a' });
    b.punch(level, { device_id: panel.id, item: 'Land 0-10V control wiring', type: 'Termination' });
    expect(messages(b, [R3d, R3f])).toEqual(['Item mentions testing or commissioning: "Test the panel"']);
    b.vocab('punch_item', 'Land 0-10V control wiring', 'Test the panel');
    const out = run(b, [R3d, R3f]);
    expect(out.findings.map((f) => [f.lint_id, f.subject.entity_id])).toEqual([
      ['R3d', t.id],
      ['R3f', odd.id],
    ]);
  });
});

describe('R4 missing parts', () => {
  it('R4b: a DMX-kit item without a sourced part gets its kit, named after the run, sourced to the item', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    const c = b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    const accepted = b.punch(level, { device_id: panel.id, cable_end_id: c.a.id, item: 'Terminate DMX to Level 03', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', rule_id: 'R3b', proposal_id: 'p1' });
    const imported = b.punch(level, { device_id: panel.id, item: 'Terminate DMX', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits' });
    const sourced = b.punch(level, { device_id: panel.id, item: 'Terminate DMX to Level 01', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits' });
    b.part(level, { device_id: panel.id, part: 'DMX termination kit - Level 01 run' }, [{ target_kind: 'punch', target_id: sourced.id }]);
    b.punch(level, { device_id: panel.id, item: 'Terminate DMX to Level 04', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', tracking_status: 'Closed' });
    const out = run(b, [R4b]);
    expect(out.proposals.map((p) => [p.discriminator, p.payload.part])).toEqual([
      [accepted.id, 'DMX termination kit - Level 03 run'],
      [imported.id, 'DMX termination kit - missing run'],
    ]);
    expect(out.proposals[0]).toMatchObject({
      kind: 'part',
      subject: { entity_kind: 'device', entity_id: panel.id, level_id: level.id },
      payload: { qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered', device_id: panel.id, level_id: level.id, sources: [{ target_kind: 'punch', target_id: accepted.id }] },
    });
    expect(out.proposals[0]!.why).toBe(`#${accepted.number} "Terminate DMX to Level 03" waits on a DMX termination kit: one kit per end (R4b).`);
  });

  it('R4b (T103, D213): an accepted Run item gets a kit at each device end — the item\'s end sourced to the item, the far end to its end', () => {
    const b = new Build();
    const { level, panel, fixtures } = floor(b);
    const l03 = b.level('03', { surveyed: '2026-10-10' });
    const far = b.device(l03, 'Relay panel', { display_id: '03-01' });
    const c = b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03 CT03LCPA', status: 'Not installed' }, { device: far, display_id: 'C-04', to_text: 'DMX to Level 06M CT06LCPA' });
    const run1 = b.punch(level, { device_id: panel.id, cable_end_id: c.a.id, item: 'Run DMX to Level 03 CT03LCPA', type: 'Cable not run', rule_id: 'R3a', proposal_id: 'p1' });
    // a placeholder far end (fixtures) gets none; a network run takes kits too
    const fx = b.cable('X', { device: panel, display_id: 'C-02', to_text: 'DMX to B3A Canyon', status: 'Not installed' }, { placeholder: fixtures });
    const run2 = b.punch(level, { device_id: panel.id, cable_end_id: fx.a.id, item: 'Run DMX to B3A Canyon', type: 'Cable not run' });
    const n = b.cable('N', { device: panel, display_id: 'C-03', status: 'Not installed' }, { device: far, display_id: 'C-05' });
    const run3 = b.punch(level, { device_id: panel.id, cable_end_id: n.a.id, item: 'Run network to Level 03 03-01', type: 'Cable not run' });
    // Unison takes no kits; a closed Run item asks for nothing
    const u = b.cable('U', { device: panel, display_id: 'C-06', status: 'Not installed' }, { device: far });
    b.punch(level, { device_id: panel.id, cable_end_id: u.a.id, item: 'Run Unison to 03-01', type: 'Cable not run' });
    const done = b.cable('X', { device: panel, display_id: 'C-07', status: 'Installed, untested' }, { device: far });
    b.punch(level, { device_id: panel.id, cable_end_id: done.a.id, item: 'Run DMX to 03-01', type: 'Cable not run', tracking_status: 'Closed' });
    const out = run(b, [R4b]);
    expect(out.proposals.map((p) => [p.discriminator, p.payload.part, p.payload.level_id, p.payload.device_id, p.payload.sources])).toEqual([
      [run1.id, 'DMX termination kit - Level 03 CT03LCPA run', level.id, panel.id, [{ target_kind: 'punch', target_id: run1.id }]],
      [`${run1.id}:${c.b!.id}`, 'DMX termination kit - Level 06M CT06LCPA run', l03.id, far.id, [{ target_kind: 'cable_end', target_id: c.b!.id }]],
      [run2.id, 'DMX termination kit - B3A Canyon run', level.id, panel.id, [{ target_kind: 'punch', target_id: run2.id }]],
      [run3.id, 'Network termination kit - Level 03 03-01 run', level.id, panel.id, [{ target_kind: 'punch', target_id: run3.id }]],
      [`${run3.id}:${n.b!.id}`, 'Network termination kit - Level 06M 06M-01 run', l03.id, far.id, [{ target_kind: 'cable_end', target_id: n.b!.id }]],
    ]);
    expect(out.proposals[0]).toMatchObject({ kind: 'part', subject: { entity_kind: 'device', entity_id: panel.id }, payload: { qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered' } });
    expect(out.proposals[1]!.why).toBe(`#${run1.number} "Run DMX to Level 03 CT03LCPA": the DMX run takes a termination kit at its far end too, C-04 (R4b).`);

    // the kits accepted, the wire pulled: the kit item that follows on either end adds no second kit
    b.part(level, { device_id: panel.id, part: 'DMX termination kit - Level 03 CT03LCPA run', rule_id: 'R4b' }, [{ target_kind: 'punch', target_id: run1.id }]);
    b.part(l03, { device_id: far.id, part: 'DMX termination kit - Level 06M CT06LCPA run', rule_id: 'R4b' }, [{ target_kind: 'cable_end', target_id: c.b!.id }]);
    run1.tracking_status = 'Closed';
    b.punch(level, { device_id: panel.id, cable_end_id: c.a.id, item: 'Terminate DMX to Level 03 CT03LCPA', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', rule_id: 'R3b' });
    b.punch(l03, { device_id: far.id, cable_end_id: c.b!.id, item: 'Terminate DMX to Level 06M CT06LCPA', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', rule_id: 'R3b' });
    expect(run(b, [R4b]).proposals.map((p) => p.discriminator)).toEqual([run2.id, run3.id, `${run3.id}:${n.b!.id}`]);
  });

  it('R4b (T103): the far end waits for its floor\'s survey (R5), and gets no kit on an out-of-scope level; a cable or code with kits off gets none', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const l03 = b.level('03'); // not surveyed
    const l09 = b.level('09', { in_scope: false, surveyed: '2026-10-01' });
    const far03 = b.device(l03, 'Relay panel', { display_id: '03-01' });
    const far09 = b.device(l09, 'Relay panel', { display_id: '09-01' });
    const a = b.cable('X', { device: panel, display_id: 'C-01', status: 'Not installed' }, { device: far03 });
    const r1 = b.punch(level, { device_id: panel.id, cable_end_id: a.a.id, item: 'Run DMX to Level 03 03-01', type: 'Cable not run' });
    const c = b.cable('F', { device: panel, display_id: 'C-02', status: 'Not installed' }, { device: far09 });
    const r2 = b.punch(level, { device_id: panel.id, cable_end_id: c.a.id, item: 'Run fiber to Level 09 09-01', type: 'Cable not run' });
    const off = b.cable('X', { device: panel, display_id: 'C-03', status: 'Not installed' }, { device: far03 }, { term_kit: false });
    b.punch(level, { device_id: panel.id, cable_end_id: off.a.id, item: 'Run DMX to Level 03 03-01', type: 'Cable not run' });
    expect(run(b, [R4b]).proposals.map((p) => [p.discriminator, p.payload.part])).toEqual([
      [r1.id, 'DMX termination kit - Level 03 03-01 run'],
      [r2.id, 'Fiber termination kit - Level 09 09-01 run'],
    ]);
    l03.surveyed = '2026-10-16';
    expect(run(b, [R4b]).proposals.map((p) => p.discriminator)).toEqual([r1.id, `${r1.id}:${a.b!.id}`, r2.id]);
  });

  it('R4a / R4d: owner other than EC, re-pulled wire and network kits are findings', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    b.part(level, { device_id: panel.id, part: 'DMX termination kit - Level 03 run', owner: 'ETC' });
    b.part(level, { device_id: panel.id, part: 'Belden 8471 re-pull' });
    b.part(level, { device_id: panel.id, part: 'Network termination kit' });
    b.part(level, { device_id: panel.id, part: 'ERP-FT-LVD' });
    // T103 (D213): network kits are parts while N / NG take kits (the default) …
    expect(messages(b, [R4a, R4d])).toEqual([
      "Owner ETC: missing parts are the EC's",
      'Re-pulled wire is not a part: "Belden 8471 re-pull"',
    ]);
    // … and, sourced to a cable, only when that cable takes them
    const far = b.device(level, 'Equipment rack', { display_id: '06M-09' });
    const c = b.cable('N', { device: panel, display_id: 'C-01' }, { device: far }, { term_kit: false });
    b.part(level, { device_id: panel.id, part: 'Network termination kit - 06M-09 run', rule_id: 'R4b' }, [{ target_kind: 'cable_end', target_id: c.a.id }]);
    expect(messages(b, [R4d])).toEqual(['Re-pulled wire is not a part: "Belden 8471 re-pull"', 'Network termination kits are not parts: "Network termination kit - 06M-09 run"']);
    b.snap.ruleParams = [{ id: 'rp', project_id: b.snap.projectId, rule_id: 'R4b', key: 'kit', value: { N: false, NG: false }, state: 'accepted', deleted_at: null }];
    expect(messages(b, [R4d])).toEqual([
      'Re-pulled wire is not a part: "Belden 8471 re-pull"',
      'Network termination kits are not parts: "Network termination kit"',
      'Network termination kits are not parts: "Network termination kit - 06M-09 run"',
    ]);
  });
});

describe('E5 and the accessory finding', () => {
  it('offers the 0-10V end Issue "Not landed" and the panel "Land 0-10V control wiring"; any short accessory is a finding', () => {
    const b = new Build();
    const { level, panel, fixtures } = floor(b);
    b.accessory(panel, 'ERP-FT-LVD', 2, 1);
    b.accessory(panel, 'ERP-RTO', 1, 1);
    const other = b.device(level, 'NSPS', { display_id: '06M-05' });
    b.accessory(other, 'Power supply', 1, 0);
    const c = b.cable('0-10V', { device: panel, display_id: 'C-08', to_text: 'Fixtures', status: 'Installed, untested' }, { placeholder: fixtures }, { single_row: true });
    const out = run(b, [E5, Acc]);
    expect(out.proposals.map((p) => [p.kind, p.subject.entity_id, p.discriminator, p.payload.now ?? p.payload.item])).toEqual([
      ['status', c.a.id, 'E5', 'Issue'],
      ['punch', panel.id, 'E5', 'Land 0-10V control wiring'],
    ]);
    expect(out.proposals[0]!.payload.extra).toEqual({ note: 'Not landed', status_source: 'derived' });
    expect(out.proposals[1]!.payload).toMatchObject({ type: 'Wiring', owner: 'EC', device_id: panel.id, cable_end_id: c.a.id, level_id: level.id });
    expect(out.findings.map((f) => [f.subject.entity_id, f.message])).toEqual([
      [panel.id, 'ERP-FT-LVD: found 1 of 2'],
      [other.id, 'Power supply: found 0 of 1'],
    ]);
    // the end accepted as Issue "Not landed": the status draft goes, R3a's Termination item is the one "Land …" draft
    c.a.status = 'Issue';
    c.a.note = 'Not landed';
    const both = run(b, [E5, R3a]);
    expect(both.proposals.map((p) => [p.rule_id, p.payload.item])).toEqual([['R3a', 'Land 0-10V control wiring']]);
  });
});

describe('the registry', () => {
  it('runs every rule without a problem, deterministically, and leaves an empty project alone', () => {
    const b = new Build();
    const { level, panel, fixtures, bus } = floor(b);
    const far = b.device(level, 'Equipment rack', { display_id: '06M-09', status: 'Issue' });
    b.cable('X', { device: panel, display_id: 'C-03', to_text: 'DMX to 06M-09', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('0-10V', { device: panel, display_id: 'C-08', to_text: 'Fixtures', status: 'Issue', note: 'Not landed' }, { placeholder: fixtures }, { single_row: true });
    b.cable('U', { device: panel, to_text: 'Stations & Sensors', status: 'Not installed' }, { placeholder: bus });
    b.accessory(panel, 'ERP-FT-LVD', 2, 1);
    const a = run(b, RULES);
    const c = run(b, RULES);
    expect(a.problems).toEqual([]);
    expect(a.proposals.map((p) => p.id)).toEqual(c.proposals.map((p) => p.id));
    expect(a.proposals.map((p) => `${p.rule_id} ${p.payload.item ?? p.payload.part ?? p.payload.now ?? (p.payload.cable as { cable: string }).cable}`).sort()).toEqual(
      [
        'R3a Land 0-10V control wiring',
        'R3a Run Unison to Stations & Sensors',
        'R3b Terminate DMX to 06M-09',
        'R3c Missing all Device Neuron IDs',
        'R3c Missing all Device DMX addresses',
      ].sort(),
    );
    // the T36 lints name what the drafts would add: the Neuron and DMX items (no cable by role any more, T199)
    expect(a.findings.map((f) => f.lint_id).sort()).toEqual(['Acc', 'R1.no_item', 'lint.neuron_item', 'lint.dmx_item'].sort());
    expect(RULES.map((r) => r.id)).toEqual([
      'R1', 'R2a', 'R2b', 'R2c', 'R2d', 'R2e', 'R2f', 'R2g', 'R3a', 'R3b', 'R3c', 'R3d', 'R3f', 'R4a', 'R4b', 'R4d', 'E5', 'Acc',
      'lint.cable_needs_accessory', 'lint.item_owner', 'lint.neuron_item', 'lint.vocab', 'lint.type_category', 'lint.type_gone', 'lint.far_end', 'lint.end_status',
      'lint.neuron_dup', 'lint.ip_dup', 'lint.id_dup', 'lint.deleted_link', 'lint.pin_sheet', 'lint.locked_drafts', 'lint.accessory_group', 'ruling',
    ]);
    const empty = run(new Build(), RULES);
    expect(empty).toMatchObject({ proposals: [], findings: [], upkeep: [], problems: [] });
  });
});

describe('roles (T112, D201): R2e, the 120V To text and the Neuron ID exception read the device role, not the category string', () => {
  it("a type's role governs; the D196 categories with no type imply a role only where one is named", () => {
    const b = new Build();
    const { level, power } = floor(b);
    // an NSPS of the D196 `Equipment` category: its type says what it is, and requires a 120V feed
    const feed = { code: '120V', single_row: true, qty: 1 };
    const nspsType = b.libraryType('P-NSPS-D-KIT', 'Equipment', { role: 'nsps', default_cables: [feed] });
    const nsps = b.device(level, 'Equipment', { display_id: '06M-05', device: 'P-NSPS-D-KIT', library_type_id: nspsType.id });
    // a gateway of the same category, its type naming no role: the feed has no To by role
    const gwType = b.libraryType('RSN-DMX8-R', 'Equipment', { default_cables: [feed] });
    const gateway = b.device(level, 'Equipment', { display_id: '06M-06', device: 'RSN-DMX8-R', library_type_id: gwType.id });
    // a rack shell in Equipment Panels: the category names the role
    const rackType = b.libraryType('Equipment Rack 18U', 'Equipment Panels', { default_cables: [feed] });
    const rack = b.device(level, 'Equipment Panels', { display_id: '06M-07', device: 'Equipment Rack 18U' });
    const out = run(b, [R2g]);
    expect(out.proposals.map((p) => [p.subject.entity_id, ...(['from_text', 'to_text'] as const).map((k) => (p.payload.ends as Record<string, unknown>[])[0]![k])])).toEqual([
      [nsps.id, '120v Power', 'P-NSPS-D Power Supply'],
      [gateway.id, '120v Power', null],
      [rack.id, '120v Power', 'Equipment rack'],
    ]);
    expect(out.proposals[0]!.why).toBe('06M-05 is a P-NSPS-D-KIT (library: 120V → P-NSPS-D Power Supply).');
    expect(out.proposals.every((p) => (p.payload.ends as Record<string, unknown>[])[1]!.placeholder_id === power.id)).toBe(true);
    expect(rackType.role).toBeNull();
    // R2e: the NSPS hosts the bus by role
    const bus = run(b, [R2e]).proposals[0]!;
    expect((bus.payload.ends as Record<string, unknown>[])[0]).toMatchObject({ device_id: nsps.id, from_text: 'P-NSPS-D-KIT' });
  });

  it('addressNeeds: the Neuron exception reads the role of the type (its role, else its category), else the device category', () => {
    expect(needsNeuronId({ needs_neuron_id: null, category: 'Equipment', role: 'nsps' }, { category: 'Equipment' }, ['U'])).toBe(false);
    expect(needsNeuronId({ needs_neuron_id: null, category: 'Equipment', role: 'other' }, { category: 'NSPS' }, ['U'])).toBe(true);
    expect(needsNeuronId({ needs_neuron_id: null, category: 'Equipment', role: null }, { category: 'NSPS' }, ['U'])).toBe(true); // Equipment names no role
    expect(needsNeuronId({ needs_neuron_id: true, category: null, role: 'equipment_rack' }, { category: 'Equipment Panels' }, [])).toBe(true);
    expect(needsNeuronId(null, { category: 'Equipment Panels' }, ['U'])).toBe(false);
    expect(needsNeuronId(null, { category: 'Power Distribution' }, ['U'])).toBe(true);
    // a station type of a category naming no role still rides the bus by its role
    expect(needsNeuronId({ needs_neuron_id: null, category: 'Equipment', role: 'station' }, { category: 'Equipment' }, [])).toBe(true);
  });
});

describe("a device's cables come from the library: accessories add theirs (T199, D288–D294)", () => {
  const ends = (p: { payload: Record<string, unknown> }) => p.payload.ends as Record<string, unknown>[];
  const cableOf = (p: { payload: Record<string, unknown> }) => p.payload.cable as Record<string, unknown>;

  /** An Echo relay panel type: DMX and panic of its own, a 0-10V option-card slot and a DALI kit slot. */
  function echo(b: Build) {
    const f = floor(b);
    const card = b.libraryType('ERP-FT-LVD', 'Power Distribution', { aliases: ['0-10V Option Kit - FT (24 CH)'], default_cables: [{ code: '0-10V', single_row: true, qty: 24 }] });
    const dali = b.libraryType('ERP-FT-DALI', 'Power Distribution', { default_cables: [{ code: 'D', single_row: true, qty: 24 }] });
    const type = b.libraryType('ERP24-FT', 'Power Distribution', {
      role: 'relay_panel',
      aliases: ['CT06LCPA'],
      default_cables: [{ code: 'X' }],
      optional_accessories: [
        { model: 'ERP-FT-LVD', expected_qty: null, max_quantity: 2 },
        { model: 'ERP-FT-DALI', expected_qty: null, max_quantity: 2 },
      ],
    });
    return { ...f, card, dali, type };
  }

  it('golden case: no 0-10V card → no 0-10V draft, no offer, and a 0-10V end is a finding; card added → the run is drafted (required) or offered (optional), × the card count; card row deleted → the finding, the cable untouched', () => {
    const b = new Build();
    const { panel, fixtures, card } = echo(b);
    // no card: the panel takes X only; 0-10V is neither drafted nor offered (D288 (4), D289 (1))
    let plan = cablesOfDevice(typesOf(b), panel, []);
    expect(plan.required.map((r) => r.cable.code)).toEqual(['X']);
    expect(plan.optional).toEqual([]);
    expect(plan.absent).toEqual([{ model: 'ERP-FT-LVD', codes: ['0-10V'] }, { model: 'ERP-FT-DALI', codes: ['D'] }]);
    expect(run(b, [R2g]).proposals.map((p) => p.discriminator)).toEqual(['X']);
    expect(run(b, [LintCableNeedsAccessory]).findings).toEqual([]);
    // a 0-10V end on it: the finding names the accessory; nothing is changed
    const run10 = b.cable('0-10V', { device: panel, to_text: 'Fixtures' }, { placeholder: fixtures }, { single_row: true });
    const flagged = run(b, [R2g, LintCableNeedsAccessory]);
    expect(flagged.findings.map((x) => [x.lint_id, x.subject.entity_id, x.subject.discriminator, x.message])).toEqual([['lint.cable_needs_accessory', panel.id, '0-10V', '06M-01: 0-10V needs ERP-FT-LVD']]);
    expect(flagged.upkeep).toEqual([]);
    run10.cable.deleted_at = NOW; // set the run aside for the draft checks below

    // two cards (the row's expected quantity): the card's required run is the panel's, one row of 2 × 24
    const row = b.accessory(panel, '0-10V Option Kit - FT (24 CH)', 2, null); // named by its alias, as a BOM line does
    plan = cablesOfDevice(typesOf(b), panel, b.snap.accessories);
    expect(plan.carried.map((c) => [c.model, c.count, c.forced])).toEqual([['ERP-FT-LVD', 2, false]]);
    expect(plan.required.map((r) => [r.cable.code, r.cable.qty, r.via])).toEqual([['X', null, null], ['0-10V', 48, 'ERP-FT-LVD']]);
    const drafted = run(b, [R2g]).proposals.find((p) => p.discriminator === '0-10V')!;
    expect(drafted.payload).toMatchObject({
      cable: { cable: '0-10V', qty: 48, single_row: true, origin: 'library' },
      ends: [
        { side: 'A', device_id: panel.id, from_text: 'CT06LCPA', to_text: 'Fixtures' },
        { side: 'B', endpoint_kind: 'placeholder', placeholder_id: fixtures.id, from_text: 'Fixtures' },
      ],
    });
    expect(drafted.why).toBe('06M-01 carries ERP-FT-LVD (library: 0-10V → Fixtures).');
    // found counts where nothing is expected; a row with neither still counts once (found or not)
    row.expected_qty = null;
    row.found_qty = 1;
    expect(cablesOfDevice(typesOf(b), panel, b.snap.accessories).required[1]!.cable.qty).toBe(24);
    row.found_qty = 0;
    expect(cablesOfDevice(typesOf(b), panel, b.snap.accessories).carried[0]!.count).toBe(1);
    row.expected_qty = 2;

    // "just because a panel has a card does not mean it has to have a 0-10V run" (D292 (1)): the
    // card's row answered Optional is offered, never drafted
    card.optional_cables = card.default_cables;
    card.default_cables = null;
    plan = cablesOfDevice(typesOf(b), panel, b.snap.accessories);
    expect(plan.optional.map((r) => [r.cable.code, r.cable.qty, r.via])).toEqual([['0-10V', 48, 'ERP-FT-LVD']]);
    expect(run(b, [R2g]).proposals.map((p) => p.discriminator)).toEqual(['X']);
    // a draft card type's rows are offered only, default ones too (D288 (2))
    card.default_cables = card.optional_cables;
    card.optional_cables = null;
    card.state = 'draft';
    expect(cablesOfDevice(typesOf(b), panel, b.snap.accessories)).toMatchObject({ required: [{ cable: { code: 'X' } }], optional: [{ cable: { code: '0-10V', qty: 48 } }] });
    card.state = 'accepted';

    // with the card and the run there, all is quiet; delete the card row: the finding, the cable untouched
    run10.cable.deleted_at = null;
    expect(run(b, [R2g, LintCableNeedsAccessory])).toMatchObject({ findings: [], proposals: [{ discriminator: 'X' }] });
    (row as { deleted_at: string | null }).deleted_at = NOW;
    const after = run(b, [R2g, LintCableNeedsAccessory]);
    expect(after.findings.map((x) => x.message)).toEqual(['06M-01: 0-10V needs ERP-FT-LVD']);
    expect(after.proposals.map((p) => p.discriminator)).toEqual(['X']);
    expect(after.upkeep).toEqual([]);
    expect(run10.cable.deleted_at).toBeNull();
  });

  it('a DALI option kit adds D × 24, one row per device (two kits: 48); a run that is not single-row comes once per accessory; a code no slot could give is not the lint\'s business', () => {
    const b = new Build();
    const { panel, level } = echo(b);
    b.accessory(panel, 'ERP-FT-DALI', 1, null);
    let out = run(b, [R2g]);
    expect(out.proposals.map((p) => [p.discriminator, cableOf(p).qty, cableOf(p).single_row])).toEqual([['X', null, false], ['D', 24, true]]);
    // D has no far end among the settings: the row's far end is left for a person
    expect(ends(out.proposals[1]!)).toMatchObject([{ device_id: panel.id, to_text: null }, { endpoint_kind: null, from_text: null }]);
    b.snap.accessories[0]!.expected_qty = 2;
    expect(run(b, [R2g]).proposals.map((p) => [p.discriminator, cableOf(p).qty])).toEqual([['X', null], ['D', 48]]);
    // a network module ×2 with one N port each: two runs, after the type's own
    const net = b.libraryType('ERn-Net', 'Equipment', { default_cables: [{ code: 'N' }] });
    const rackType = b.libraryType('ERn2', 'Equipment Panels', { default_cables: [{ code: 'N' }], optional_accessories: [{ model: 'ERn-Net', expected_qty: null, max_quantity: 2 }] });
    const rack = b.device(level, 'Equipment Panels', { display_id: '06M-09', library_type_id: rackType.id });
    b.accessory(rack, 'ERn-Net', 2, null);
    out = run(b, [R2g]);
    expect(out.proposals.filter((p) => p.subject.entity_id === rack.id).map((p) => [p.discriminator, (p.inputs_hash ? p.why : '')])).toEqual([
      ['N', '06M-09 is a ERn2 (library: N → its far end).'],
      ['N#2', '06M-09 carries ERn-Net (library: N → its far end).'],
      ['N#3', '06M-09 carries ERn-Net (library: N → its far end).'],
    ]);
    expect(net.state).toBe('accepted');
    // a fiber end on the rack: no slot of its type gives F, so this lint says nothing
    b.cable('F', { device: rack });
    expect(run(b, [LintCableNeedsAccessory]).findings).toEqual([]);
  });

  it("the NSPS kit's forced supply counts without a row: its 120V is the kit's, once (D288 (3)); a choose-among alternative does not", () => {
    const b = new Build();
    const { level, power } = floor(b);
    const supply = b.libraryType('P-NSPS-D Power Supply', 'Power Supplies', { accessory_only: true, default_cables: [{ code: '120V', single_row: true, qty: 1 }] } as never);
    const boxA = b.libraryType('Back box A', 'Wall Plates', { default_cables: [{ code: 'NG' }] });
    const kit = b.libraryType('P-NSPS-D-KIT', 'Equipment', {
      role: 'nsps',
      default_cables: [{ code: 'N' }],
      optional_accessories: [
        { model: 'P-NSPS-D Power Supply', expected_qty: 1, max_quantity: 1 },
        // one of these back boxes (D202): an alternative has no expected quantity of its own
        { model: 'Back box A', expected_qty: null, max_quantity: 1, group: { label: 'Back boxes', min: 1, max: 1 } },
      ],
    });
    const nsps = b.device(level, 'Equipment', { display_id: '06M-05', device: 'P-NSPS-D-KIT', library_type_id: kit.id });
    const plan = cablesOfDevice(typesOf(b), nsps, []);
    expect(plan.carried.map((c) => [c.model, c.count, c.forced])).toEqual([['P-NSPS-D Power Supply', 1, true]]);
    expect(plan.absent).toEqual([{ model: 'Back box A', codes: ['NG'] }]);
    const out = run(b, [R2g]);
    expect(out.proposals.map((p) => p.discriminator)).toEqual(['N', '120V']);
    // the feed reads From 120v Power, To by what it feeds (an NSPS, D52), the far end the placeholder
    expect(out.proposals[1]!.payload).toMatchObject({
      cable: { cable: '120V', qty: 1, single_row: true },
      ends: [
        { side: 'A', device_id: nsps.id, from_text: '120v Power', to_text: 'P-NSPS-D Power Supply' },
        { side: 'B', endpoint_kind: 'placeholder', placeholder_id: power.id, from_text: '120v Power' },
      ],
    });
    // the supply's own row on the device changes nothing (a row wins over its slot): still once
    b.accessory(nsps, 'P-NSPS-D Power Supply', 1, 0);
    expect(run(b, [R2g]).proposals.map((p) => [p.discriminator, cableOf(p).qty])).toEqual([['N', null], ['120V', 1]]);
    expect(supply.state).toBe('accepted');
    expect(boxA.state).toBe('accepted');
    // a forced slot inside a group still counts (the ERn2's processor is one of its "two ERn modules")
    kit.optional_accessories = [{ model: 'Back box A', expected_qty: 1, max_quantity: 1, group: { label: 'Modules', min: 2, max: 2 } }];
    expect(cablesOfDevice(typesOf(b), nsps, []).carried.map((c) => [c.model, c.count, c.forced])).toEqual([['Back box A', 1, true]]);
  });

  it("a panic run is never paired by a rule: the required run is offered with its far end empty and the far-end lint flags it once made (D293 (1), D294)", () => {
    const b = new Build();
    const { level, panel } = floor(b);
    b.libraryType('CT06LCPA', 'Power Distribution', { role: 'relay_panel', default_cables: [{ code: 'P', single_row: true, qty: 1 }] });
    const ebdk = b.device(level, 'EBDK', { display_id: '06M-03', device: 'EBDK', panel_name: 'CT06LCPA' }); // the level's one EBDK: still not assumed
    const [p] = run(b, [R2g]).proposals;
    expect(p!.payload).toMatchObject({
      cable: { cable: 'P', single_row: true, qty: 1 },
      ends: [
        { side: 'A', device_id: panel.id, from_text: 'CT06LCPA', to_text: null, status: 'Installed, untested', status_source: 'derived' },
        { side: 'B', endpoint_kind: null, from_text: null, to_text: null },
      ],
    });
    expect(JSON.stringify(p!.payload)).not.toContain('EBDK');
    expect(JSON.stringify(p!.payload)).not.toContain(ebdk.id);
    expect(p!.why).toBe('06M-01 is a CT06LCPA (library: P → its far end).');
    // accepted as it stands, the run has no far end until a person picks the device
    b.cable('P', { device: panel }, {}, { single_row: true });
    expect(run(b, [R2g]).proposals).toEqual([]);
    expect(run(b, [LintFarEnd]).findings.map((x) => x.message)).toEqual(['06M-01 panic end: panic cable, the far end names no device or placeholder']);
  });

  it('the texts a row leaves empty are per-code settings, listed on the draft; a text typed on the row wins (D290 (3), D293)', () => {
    const blank = { code: '0-10V', from: null, to: null, far: null, single_row: true, qty: 1, status: null };
    expect(fillLibraryCable(blank, 'relay_panel')).toEqual({
      cable: { ...blank, to: 'Fixtures', far: 'Fixtures' },
      params: [['R2g', 'from', '0-10V'], ['R2g', 'to', '0-10V'], ['R2g', 'far', '0-10V'], ['R2g', 'status', '0-10V']],
    });
    expect(fillLibraryCable({ ...blank, code: 'P' }, 'relay_panel').cable).toMatchObject({ from: null, to: null, far: null, status: 'Installed, untested' });
    expect(fillLibraryCable({ ...blank, code: '120V' }, 'equipment_rack').cable).toMatchObject({ from: '120v Power', to: 'Equipment rack', far: '120v Power', status: null });
    expect(fillLibraryCable({ ...blank, code: '120V' }, 'relay_panel').cable).toMatchObject({ from: '120v Power', to: null, far: '120v Power' });
    expect(fillLibraryCable({ ...blank, code: 'X' }, 'other').cable).toEqual({ ...blank, code: 'X' });
    // the row's own texts win, and then no setting is read for them
    const own = fillLibraryCable({ ...blank, code: '120V', from: 'Panel LP-2', to: 'NSPS PS', far: 'LP-2', status: 'Not started' }, 'nsps');
    expect(own).toEqual({ cable: { ...blank, code: '120V', from: 'Panel LP-2', to: 'NSPS PS', far: 'LP-2', status: 'Not started' }, params: [] });
    // a project's own values: the list by role is Landry's to extend (D293 (3)); a changed setting re-words the draft
    const row = (key: string, value: unknown): RuleParamRow => ({ id: key, project_id: 'p', rule_id: 'R2g', key, value, state: 'accepted', deleted_at: null });
    const mine = new RuleParams([row('to_120v', { relay_panel: 'Relay panel feed' }), row('to', { '0-10V': 'Fixture loads' }), row('status', { P: '' })]);
    expect(fillLibraryCable({ ...blank, code: '120V' }, 'relay_panel', mine).cable.to).toBe('Relay panel feed');
    expect(fillLibraryCable({ ...blank, code: '120V' }, 'nsps', mine).cable.to).toBe('P-NSPS-D Power Supply');
    expect(fillLibraryCable(blank, 'relay_panel', mine).cable.to).toBe('Fixture loads');
    expect(fillLibraryCable({ ...blank, code: 'P' }, 'relay_panel', mine).cable.status).toBeNull();
    const b = new Build();
    floor(b);
    b.libraryType('CT06LCPA', 'Power Distribution', { default_cables: [blank] });
    const before = run(b, [R2g]).proposals[0]!;
    b.snap.ruleParams = [{ id: 'x', project_id: b.snap.projectId, rule_id: 'R2g', key: 'to', value: { '0-10V': 'Fixture loads' }, state: 'accepted', deleted_at: null }];
    const after = run(b, [R2g]).proposals[0]!;
    expect(ends(after)[0]!.to_text).toBe('Fixture loads');
    expect(after.inputs_hash).not.toBe(before.inputs_hash);
  });

  it("the addresses a device needs read its required cables, a carried accessory's with its type's (D245, D288 (2))", () => {
    const b = new Build();
    const { level } = floor(b);
    const net = b.libraryType('ERn-Net', 'Equipment', { default_cables: [{ code: 'N' }] });
    const type = b.libraryType('ERn2', 'Equipment Panels', { default_cables: [{ code: 'X' }], optional_accessories: [{ model: 'ERn-Net', expected_qty: null }] });
    const rack = b.device(level, 'Equipment Panels', { display_id: '06M-09', library_type_id: type.id });
    const needs = (rows: Parameters<typeof cablesOfDevice>[2]) => addressNeeds(type, rack, [], undefined, cablesOfDevice(typesOf(b), rack, rows).required.map((r) => r.cable.code));
    expect(needs([])).toEqual({ neuron: false, ip: false, dmx: true });
    expect(needs([{ model: 'ERn-Net', expected_qty: 1 }])).toEqual({ neuron: false, ip: true, dmx: true });
    // an optional run is no wire the device gets until it is there
    net.optional_cables = net.default_cables;
    net.default_cables = null;
    expect(needs([{ model: 'ERn-Net', expected_qty: 1 }])).toEqual({ neuron: false, ip: false, dmx: true });
    // without the list, the type's own default cables as before
    expect(addressNeeds(type, rack, [])).toEqual({ neuron: false, ip: false, dmx: true });
  });
});
