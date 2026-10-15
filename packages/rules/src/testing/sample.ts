/**
 * Test fixtures for the engine (not a rule of PLAN §6; T34 writes those): a small project
 * snapshot and two sample rules shaped like R3a and R1, enough to exercise keying, hashing,
 * supersede, decisions and findings.
 */

import { emptySnapshot, type CableEndRow, type DeviceRow, type Snapshot } from '../snapshot';
import type { Rule } from '../rule';

export const PROJECT = '0190a5f0-0000-7000-8000-00000000aa01';
export const LEVEL = '0190a5f0-0000-7000-8000-00000000aa06';
export const GROUP = '0190a5f0-0000-7000-8000-00000000aa0c';
export const PANEL = '0190a5f0-0000-7000-8000-00000000d001';
export const FAR = '0190a5f0-0000-7000-8000-00000000d002';
export const CABLE = '0190a5f0-0000-7000-8000-00000000c001';
export const END_A = '0190a5f0-0000-7000-8000-00000000e001';
export const END_B = '0190a5f0-0000-7000-8000-00000000e002';

export function device(partial: Partial<DeviceRow> & Pick<DeviceRow, 'id'>): DeviceRow {
  return {
    level_id: LEVEL,
    display_id: null,
    category: 'Relay panel',
    device: 'CT06LCPA',
    type: null,
    room_location: null,
    drawing_position: null,
    status: null,
    notes: null,
    pin: null,
    neuron_id: null,
    origin: 'baseline',
    found_on_site: null,
    panel_name: null,
    library_type_id: null,
    deleted_at: null,
    ...partial,
  };
}

export function end(partial: Partial<CableEndRow> & Pick<CableEndRow, 'id' | 'side'>): CableEndRow {
  return {
    cable_id: CABLE,
    endpoint_kind: 'device',
    device_id: null,
    placeholder_id: null,
    level_id: LEVEL,
    display_id: null,
    from_text: null,
    to_text: null,
    status: null,
    note: null,
    surveyed_by_id: null,
    surveyed_at: null,
    status_source: null,
    deleted_at: null,
    ...partial,
  };
}

/** A panel and a far device joined by one DMX cable; end A at the panel is `Not installed`. */
export function sampleSnapshot(): Snapshot {
  const s = emptySnapshot(PROJECT);
  s.levels.push({
    id: LEVEL, project_id: PROJECT, level: '06M', floor_order: 1, numbering_group_id: GROUP, in_scope: true, split_of_id: null,
    surveyed: null, updated: null, state: 'setup', baseline_locked_at: null, deleted_at: null,
  });
  s.numberingGroups.push({ id: GROUP, project_id: PROJECT, label: '06/06M' });
  s.devices.push(device({ id: PANEL, display_id: '06M-01' }), device({ id: FAR, display_id: '06M-03' }));
  s.cables.push({
    id: CABLE, project_id: PROJECT, cable: 'X', qty: 1, origin: 'riser', single_row: false, riser_to_label: null, vertical: null,
    end_a_id: END_A, end_b_id: END_B, endpoint_confirmed: true, deleted_at: null,
  });
  s.cableEnds.push(
    end({ id: END_A, side: 'A', device_id: PANEL, to_text: 'DMX to 06M-03', status: 'Not installed', note: 'Not run' }),
    end({ id: END_B, side: 'B', device_id: FAR, from_text: 'DMX from 06M-01' }),
  );
  return s;
}

/** Like R3a: one "Run …" punch proposal per `Not installed` end, keyed on the end. */
export const RUN_RULE: Rule = {
  id: 'T.run',
  title: 'Cable not run',
  text: 'An end marked Not installed gets a "Run <code> to <other end>" punch item for the EC.',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      if (e.status !== 'Not installed') continue;
      const cable = ctx.index.cable.get(e.cable_id);
      const other = ctx.index.otherEnd(e);
      const target = other?.device_id ? (ctx.index.device.get(other.device_id)?.display_id ?? '?') : 'far end';
      ctx.propose({
        subject: { entity_kind: 'cable_end', entity_id: e.id, level_id: e.level_id },
        kind: 'punch',
        payload: { item: `Run ${cable?.cable ?? '?'} to ${target}`, type: 'Cable not run', owner: 'EC', device_id: e.device_id, cable_end_id: e.id },
        inputs: { status: e.status, target },
        why: `${e.to_text ?? e.id} is Not installed.`,
      });
    }
  },
};

/** Like R1: an `Issue` device with no open punch item is a finding. */
export const ISSUE_RULE: Rule = {
  id: 'T.issue',
  title: 'Issue without an item',
  text: 'An Issue device needs an open punch item.',
  lints: ['T.issue.none'],
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      if (d.status !== 'Issue') continue;
      const open = (ctx.index.punchByDevice.get(d.id) ?? []).some((p) => p.tracking_status !== 'Closed');
      if (!open) {
        ctx.find({ subject: { entity_kind: 'device', entity_id: d.id, level_id: d.level_id }, lint_id: 'T.issue.none', message: `${d.display_id ?? d.id} is Issue with no open punch item` });
      }
    }
  },
};
