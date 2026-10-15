/**
 * Unit tests per rule (T34), over hand-built snapshots: exact phrases (CLAUDE.md §3), keys and
 * payloads, and what each rule leaves alone. Pure: `evaluate` only, nothing written.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../evaluate';
import type { Rule } from '../rule';
import { Build } from '../testing/build';
import { Acc, E5 } from './e5';
import { R1 } from './r1';
import { R2a, R2b, R2c, R2d, R2e, R2f } from './r2';
import { R3a, R3b, R3c, R3d, R3f } from './r3';
import { R4a, R4b, R4d } from './r4';
import { RULES } from './index';

const NOW = '2026-10-15T12:00:00.000Z';
const run = (b: Build, rules: readonly Rule[]) => evaluate(b.snap, rules, undefined, { now: NOW });
const items = (b: Build, rules: readonly Rule[]) => run(b, rules).proposals.map((p) => p.payload.item ?? p.payload.part ?? p.payload.now);
const messages = (b: Build, rules: readonly Rule[]) => run(b, rules).findings.map((f) => f.message);

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
    b.cable('N', { device: panel, display_id: 'C-03', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-04', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('X', { device: panel, display_id: 'C-05', status: 'Not installed', note: null }, { device: far });
    const out = run(b, [R2a]);
    expect(out.proposals).toEqual([]);
    expect(out.findings.map((f) => f.message)).toEqual([
      'C-01: the note says "Run, not terminated" but the end is Not installed',
      'C-02: the note says "Not run" but the end is Issue',
      'C-03: the note says "no term kit" but the cable is N',
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

describe('R2c / R2d / R2e library cables as drafts (D173)', () => {
  it('offers a Relay panel its 0-10V → Fixtures and P → EBDK panic wire single rows, paired to its EBDK', () => {
    const b = new Build();
    const { level, panel, fixtures } = floor(b);
    const ebdk = b.device(level, 'EBDK', { display_id: '06M-03', device: 'EBDK', panel_name: 'CT06LCPA' });
    b.device(level, 'EBDK', { display_id: '06M-04', device: 'EBDK', panel_name: 'CT06LCPB' });
    const out = run(b, [R2c]);
    expect(out.proposals.map((p) => [p.kind, p.discriminator])).toEqual([
      ['cable', '0-10V'],
      ['cable', 'P'],
    ]);
    const [v, p] = out.proposals;
    expect(v!.payload).toMatchObject({
      cable: { cable: '0-10V', qty: 1, single_row: true, origin: 'library', endpoint_confirmed: true },
      ends: [
        { side: 'A', endpoint_kind: 'device', device_id: panel.id, level_id: level.id, from_text: 'CT06LCPA', to_text: 'Fixtures' },
        { side: 'B', endpoint_kind: 'placeholder', placeholder_id: fixtures.id, from_text: 'Fixtures' },
      ],
    });
    expect(p!.payload).toMatchObject({
      cable: { cable: 'P', qty: 1, single_row: true },
      ends: [
        { side: 'A', device_id: panel.id, from_text: 'CT06LCPA', to_text: 'EBDK panic wire', status: 'Installed, untested', status_source: 'derived' },
        { side: 'B', endpoint_kind: 'device', device_id: ebdk.id, from_text: 'EBDK panic wire', to_text: 'CT06LCPA' },
      ],
    });
    expect(p!.why).toContain('its EBDK 06M-03');
    // once the panel has both codes, nothing is offered
    b.cable('0-10V', { device: panel, to_text: 'Fixtures' }, { placeholder: fixtures }, { single_row: true });
    b.cable('P', { device: panel, to_text: 'EBDK panic wire' }, { device: ebdk }, { single_row: true });
    expect(run(b, [R2c]).proposals).toEqual([]);
  });

  it('offers an NSPS and a rack their 120V row with the D52 To texts', () => {
    const b = new Build();
    const { level, power } = floor(b);
    const nsps = b.device(level, 'NSPS', { display_id: '06M-05', device: 'P-NSPS-D-KIT' });
    const rack = b.device(level, 'Equipment rack', { display_id: '06M-06', device: 'Equipment rack' });
    const out = run(b, [R2d]);
    expect(out.proposals.map((p) => (p.payload.ends as Record<string, unknown>[]).map((e) => [e.device_id ?? e.placeholder_id, e.from_text, e.to_text]))).toEqual([
      [[nsps.id, '120v Power', 'P-NSPS-D Power Supply'], [power.id, '120v Power', null]],
      [[rack.id, '120v Power', 'Equipment rack'], [power.id, '120v Power', null]],
    ]);
    expect(out.proposals.every((p) => (p.payload.cable as Record<string, unknown>).single_row === true)).toBe(true);
    b.cable('120V', { device: nsps, from_text: '120v Power', to_text: 'P-NSPS-D Power Supply' }, { placeholder: power }, { single_row: true });
    expect(run(b, [R2d]).proposals.map((p) => p.subject.entity_id)).toEqual([rack.id]);
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
    const { level, panel } = floor(b);
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

describe('R3b DMX termination kit item', () => {
  it('is a device-level Missing part item for EC/ETC with the master\'s note, keyed on the end', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    const far = b.device(level, 'Relay panel', { display_id: '06M-02' });
    const c = b.cable('X', { device: panel, display_id: 'C-01', to_text: 'DMX to Level 03 UFMP4s', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far });
    b.cable('N', { device: panel, display_id: 'C-02', status: 'Issue', note: 'Run, not terminated; no term kit' }, { device: far }); // not DMX
    const out = run(b, [R3b]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'punch',
      subject: { entity_kind: 'device', entity_id: panel.id, level_id: level.id },
      discriminator: c.a.id,
      payload: { item: 'Terminate DMX to Level 03 UFMP4s', type: 'Missing part', owner: 'EC/ETC', notes: 'Waiting on DMX Termination Kits', device_id: panel.id, cable_end_id: c.a.id, level_id: level.id },
    });
  });
});

describe('R3c Missing all Device Neuron IDs (D49, D170)', () => {
  function group() {
    const b = new Build();
    const l06 = b.level('06', { numbering_group_id: 'g6', floor_order: 7 });
    const l06m = b.level('06M', { numbering_group_id: 'g6', floor_order: 8 });
    const a = b.device(l06, 'Relay panel', { display_id: '06-02' });
    const s10 = b.device(l06m, 'Station', { display_id: '06M-S10' });
    const s2 = b.device(l06m, 'Station', { display_id: '06M-S2' });
    const done = b.device(l06, 'Relay panel', { display_id: '06-01', neuron_id: '00A1B2C3D4E5' });
    return { b, l06, l06m, a, s10, s2, done };
  }

  it('proposes one sort_last Information item per numbering group on its first level, Notes listing the IDs in order', () => {
    const { b, l06 } = group();
    b.level('01', { numbering_group_id: 'g1' }); // a group with no devices: nothing
    const out = run(b, [R3c]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'punch',
      subject: { entity_kind: 'numbering_group', entity_id: 'g6', level_id: l06.id },
      payload: { level_id: l06.id, item: 'Missing all Device Neuron IDs', type: 'Information', owner: 'EC', tracking_status: 'Open', sort_last: true, device_text: 'All devices', notes: '06-02, 06M-S2, 06M-S10' },
      why: '3 devices on Levels 06/06M have no Neuron ID.',
    });
    expect(out.upkeep).toEqual([]);
    // the same output on every run (deterministic id)
    expect(run(b, [R3c]).proposals[0]!.id).toBe(out.proposals[0]!.id);
  });

  it('maintains the existing item instead: Notes rewritten, Closed when empty, reopened on a new device', () => {
    const { b, l06, a, s10, s2 } = group();
    const item = b.punch(l06, { item: 'Missing all Device Neuron IDs', type: 'Information', sort_last: true, notes: null, proposal_id: 'prop-1' });
    let out = run(b, [R3c]);
    expect(out.proposals).toEqual([]);
    expect(out.upkeep).toEqual([{ rule_id: 'R3c', entity: 'punch_item', id: item.id, fields: { notes: '06-02, 06M-S2, 06M-S10' }, proposal_id: 'prop-1', why: '3 devices still without a Neuron ID' }]);
    a.neuron_id = '000000000001';
    s10.neuron_id = '000000000002';
    s2.neuron_id = '000000000003';
    out = run(b, [R3c]);
    expect(out.upkeep[0]!.fields).toEqual({ notes: null, tracking_status: 'Closed', date_closed: '2026-10-15' });
    item.tracking_status = 'Closed';
    item.date_closed = '2026-10-15';
    item.notes = null;
    expect(run(b, [R3c]).upkeep[0]!.fields).toEqual({ notes: null }); // nothing to change (the engine skips unchanged values)
    b.device(l06, 'Sensor', { display_id: '06-D1' });
    expect(run(b, [R3c]).upkeep[0]!.fields).toEqual({ notes: '06-D1', tracking_status: 'Open', date_closed: null });
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
    expect(out.proposals[0]!.why).toBe(`#${accepted.number} "Terminate DMX to Level 03" waits on a DMX termination kit: one kit per run (R4b).`);
  });

  it('R4a / R4d: owner other than EC, re-pulled wire and network kits are findings', () => {
    const b = new Build();
    const { level, panel } = floor(b);
    b.part(level, { device_id: panel.id, part: 'DMX termination kit - Level 03 run', owner: 'ETC' });
    b.part(level, { device_id: panel.id, part: 'Belden 8471 re-pull' });
    b.part(level, { device_id: panel.id, part: 'Network termination kit' });
    b.part(level, { device_id: panel.id, part: 'ERP-FT-LVD' });
    expect(messages(b, [R4a, R4d])).toEqual([
      "Owner ETC: missing parts are the EC's",
      'Re-pulled wire is not a part: "Belden 8471 re-pull"',
      'Network termination kits are not parts: "Network termination kit"',
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
        'R2c P',
        'R2d 120V',
        'R3a Land 0-10V control wiring',
        'R3a Run Unison to Stations & Sensors',
        'R3b Terminate DMX to 06M-09',
        'R3c Missing all Device Neuron IDs',
      ].sort(),
    );
    expect(a.findings.map((f) => f.lint_id).sort()).toEqual(['Acc', 'R1.no_item']);
    expect(RULES.map((r) => r.id)).toEqual(['R1', 'R2a', 'R2b', 'R2c', 'R2d', 'R2e', 'R2f', 'R3a', 'R3b', 'R3c', 'R3d', 'R3f', 'R4a', 'R4b', 'R4d', 'E5', 'Acc']);
    const empty = run(new Build(), RULES);
    expect(empty).toMatchObject({ proposals: [], findings: [], upkeep: [], problems: [] });
  });
});
