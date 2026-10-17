/**
 * R2 — cables (PLAN §6.1, amended by D171 and D172).
 *
 * - R2a: no note is ever auto-filled; a note that contradicts the end's status is a finding.
 * - R2b: the riser governs To; a To text that does not say what the riser says is a finding.
 * - R2c / R2d / R2e: the library's default cables (PLAN §6.2) are **drafts** (`cable`
 *   proposals, D173) for a device that lacks them: a Relay panel's 0-10V → `Fixtures` and P →
 *   `EBDK panic wire` (single rows), an NSPS's or rack's 120V (`120v Power` → `P-NSPS-D Power
 *   Supply` / `Equipment rack`, D52), one Unison pair per level `Stations & Sensors` ↔ the NSPS
 *   (or the rack where the level has none).
 *   A device whose accepted library type defines default cables gets those instead (R2g,
 *   `library.ts`, T48); R2e's bus stays per level.
 * - R2f: nothing is copied between ends (D171); an unsurveyed end stays empty (`Unsurveyed`).
 *   An end on an out-of-scope level, or whose far end is, is offered `Not started` (D171).
 *
 * The library cables' From / To texts and starting statuses, and R2f's status, are rule
 * parameters (T102, `../params.ts`); the texts above are their defaults.
 */

import { riserCheck } from '@field-survey/core';

import { statusParam, textParam, type ParamRef } from '../params';
import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, DeviceRow, LevelRow } from '../snapshot';
import { deviceRole, governingCables } from './library';
import { BUS_LABEL, cableOf, compareIds, compareLevels, deviceLabel, endLabel, endLevel, endPlaceholder, noteHas, placeholderFor, str, subjectOfEnd } from './shared';

// ------------------------------------------------------------------ R2a

export const R2a: Rule = {
  id: 'R2a',
  title: 'Note matches status',
  text: 'Notes are never auto-filled (D172). "Not run" goes with `Not installed`, "Run, not terminated" with `Issue`, "no term kit" with a DMX (X) cable; a note that says otherwise is flagged.',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      const note = str(e.note);
      if (!note) continue;
      const code = cableOf(ctx, e)?.cable ?? null;
      const status = e.status ?? 'Unsurveyed';
      let problem: string | null = null;
      if (e.status === 'Not installed' && noteHas(note, /run, not terminated/i)) problem = `says "Run, not terminated" but the end is Not installed`;
      else if (e.status !== 'Not installed' && /^not run\b/i.test(note)) problem = `says "Not run" but the end is ${status}`;
      else if (noteHas(note, /no term kit/i) && code !== 'X') problem = `says "no term kit" but the cable is ${code ?? 'not DMX'}`;
      if (problem) ctx.find({ subject: subjectOfEnd(ctx, e), message: `${endLabel(ctx, e)}: the note ${problem}` });
    }
  },
};

// ------------------------------------------------------------------ R2b

export const R2b: Rule = {
  id: 'R2b',
  title: 'To matches the riser',
  text: 'The riser governs To (R2). A To text that does not say what the riser label says is flagged; the note may keep the alternate guess.',
  run(ctx) {
    for (const cable of ctx.index.cable.values()) {
      const label = str(cable.riser_to_label);
      if (!label) continue;
      const ends = (ctx.index.endsByCable.get(cable.id) ?? []).slice().sort((a, b) => a.side.localeCompare(b.side));
      const end = ends.find((e) => e.side === 'A' && str(e.to_text)) ?? ends.find((e) => str(e.to_text));
      if (!end) continue;
      const check = riserCheck(label, end.to_text);
      if (check.state === 'differs') {
        ctx.find({ subject: subjectOfEnd(ctx, end), message: `${endLabel(ctx, end)}: To "${end.to_text}" does not match the riser "${label}"` });
      }
    }
  },
};

// ------------------------------------------------------------------ R2c / R2d / R2e (library drafts, D173)

type EndDraft = Record<string, unknown>;

function hasCode(ctx: RuleContext, device: DeviceRow, code: string): boolean {
  return (ctx.index.endsByDevice.get(device.id) ?? []).some((e) => cableOf(ctx, e)?.cable === code);
}

function panelName(d: DeviceRow): string | null {
  return str(d.panel_name) ?? str(d.device) ?? str(d.display_id);
}

function deviceEnd(ctx: RuleContext, d: DeviceRow, side: 'A' | 'B', text: { from?: string | null; to?: string | null }, extra: EndDraft = {}): EndDraft {
  return { side, endpoint_kind: 'device', device_id: d.id, level_id: d.level_id, from_text: text.from ?? panelName(d), to_text: text.to ?? null, ...extra };
}

function placeholderEnd(ctx: RuleContext, kind: string, label: string, side: 'A' | 'B', text: { from?: string | null; to?: string | null }, levelId: string | null = null): EndDraft {
  const p = placeholderFor(ctx, kind, label);
  return { side, endpoint_kind: p ? 'placeholder' : null, placeholder_id: p?.id ?? null, level_id: levelId, from_text: text.from ?? null, to_text: text.to ?? null };
}

/** A starting status for a library end (`R2c.panic.status`…): the fields, or none for `Unsurveyed`. */
function startStatus(ctx: RuleContext, rule: string, key: string): EndDraft {
  const status = statusParam(ctx.params, rule, key);
  return status ? { status, status_source: 'derived' } : {};
}

function proposeCable(ctx: RuleContext, device: DeviceRow, code: string, cable: Record<string, unknown>, ends: EndDraft[], why: string, params: readonly ParamRef[]): void {
  ctx.propose({
    subject: { entity_kind: 'device', entity_id: device.id, level_id: device.level_id },
    discriminator: code,
    kind: 'cable',
    payload: { cable: { cable: code, origin: 'library', endpoint_confirmed: true, ...cable }, ends },
    inputs: { device: device.id, code },
    params,
    why,
  });
}

export const R2c: Rule = {
  id: 'R2c',
  title: 'Relay panel library cables',
  text: 'A relay panel (role `relay_panel`, D201) has a 0-10V run to `Fixtures` and a panic (P) run to `EBDK panic wire`, each a single row; P is always treated as run (`Installed, untested`). Offered as drafts to accept (D173).',
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      if (deviceRole(ctx, d) !== 'relay_panel' || governingCables(ctx, d)) continue; // an accepted type's cables govern (R2g)
      const label = deviceLabel(ctx, d);
      if (!hasCode(ctx, d, '0-10V')) {
        const to = textParam(ctx.params, 'R2c', 'fixtures.to');
        proposeCable(
          ctx,
          d,
          '0-10V',
          { qty: 1, single_row: true },
          [deviceEnd(ctx, d, 'A', { to }, startStatus(ctx, 'R2c', 'fixtures.status')), placeholderEnd(ctx, 'fixtures', 'Fixtures', 'B', { from: 'Fixtures' })],
          `${label} is a Relay panel with no 0-10V run (library: 0-10V → ${to}).`,
          [['R2c', 'fixtures.to'], ['R2c', 'fixtures.status']],
        );
      }
      if (!hasCode(ctx, d, 'P')) {
        const name = panelName(d);
        const ebdk = (ctx.index.devicesByLevel.get(d.level_id) ?? [])
          .filter((x) => name && str(x.panel_name) === name && deviceRole(ctx, x) === 'ebdk')
          .sort((a, b) => compareIds(a.display_id ?? '', b.display_id ?? ''))[0];
        const to = textParam(ctx.params, 'R2c', 'panic.to');
        const far: EndDraft = ebdk
          ? deviceEnd(ctx, ebdk, 'B', { from: to, to: name })
          : { side: 'B', endpoint_kind: null, level_id: d.level_id, from_text: to, to_text: name };
        proposeCable(
          ctx,
          d,
          'P',
          { qty: 1, single_row: true },
          [deviceEnd(ctx, d, 'A', { to }, startStatus(ctx, 'R2c', 'panic.status')), far],
          `${label} is a Relay panel with no panic (P) run (library: P → ${to}${ebdk ? `, its EBDK ${deviceLabel(ctx, ebdk)}` : ''}).`,
          [['R2c', 'panic.to'], ['R2c', 'panic.status']],
        );
      }
    }
  },
};

export const R2d: Rule = {
  id: 'R2d',
  title: '120V library cable',
  text: 'An NSPS or equipment rack (role `nsps` / `equipment_rack`, D201) has one 120V row, `120v Power` → `P-NSPS-D Power Supply` (NSPS) or `Equipment rack` (rack), D52. Offered as a draft to accept (D173).',
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      const role = deviceRole(ctx, d);
      if (role !== 'nsps' && role !== 'equipment_rack') continue;
      if (hasCode(ctx, d, '120V') || governingCables(ctx, d)) continue;
      const toKey = role === 'nsps' ? 'nsps.to' : 'rack.to';
      const to = textParam(ctx.params, 'R2d', toKey);
      const from = textParam(ctx.params, 'R2d', 'from');
      proposeCable(
        ctx,
        d,
        '120V',
        { qty: 1, single_row: true },
        [deviceEnd(ctx, d, 'A', { from, to }, startStatus(ctx, 'R2d', 'status')), placeholderEnd(ctx, 'power', '120v Power', 'B', { from: '120v Power' })],
        `${deviceLabel(ctx, d)} is a${role === 'nsps' ? 'n NSPS' : 'n Equipment rack'} with no 120V row (library: ${from} → ${to}).`,
        [['R2d', 'from'], ['R2d', toKey], ['R2d', 'status']],
      );
    }
  },
};

/** The level's Unison host: its NSPS (by role, D201), else its equipment rack; lowest ID first. */
function unisonHost(ctx: RuleContext, level: LevelRow): { host: DeviceRow; role: 'nsps' | 'equipment_rack' } | null {
  const devices = (ctx.index.devicesByLevel.get(level.id) ?? []).slice().sort((a, b) => compareIds(a.display_id ?? '', b.display_id ?? ''));
  const roles = new Map(devices.map((d) => [d.id, deviceRole(ctx, d)] as const));
  const nsps = devices.find((d) => roles.get(d.id) === 'nsps');
  if (nsps) return { host: nsps, role: 'nsps' };
  const rack = devices.find((d) => roles.get(d.id) === 'equipment_rack');
  return rack ? { host: rack, role: 'equipment_rack' } : null;
}

export const R2e: Rule = {
  id: 'R2e',
  title: 'Unison bus per level',
  text: 'Each level has one Unison pair: `Stations & Sensors` ↔ its NSPS (or the equipment rack where the level has no NSPS; by role, D201). Offered as a draft to accept (D173).',
  run(ctx) {
    const levels = [...ctx.index.level.values()].filter((l) => l.in_scope).sort(compareLevels);
    for (const level of levels) {
      const found = unisonHost(ctx, level);
      if (!found) continue;
      const { host, role } = found;
      const hasBus = [...ctx.index.cableEnd.values()].some((e) => cableOf(ctx, e)?.cable === 'U' && endLevel(ctx, e)?.id === level.id);
      if (hasBus) continue;
      const hostName = str(host.device) ?? (role === 'nsps' ? 'P-NSPS-D' : 'Equipment rack');
      const busKey = role === 'nsps' ? 'bus.to_nsps' : 'bus.to_rack';
      const toHost = textParam(ctx.params, 'R2e', busKey);
      ctx.propose({
        subject: { entity_kind: 'level', entity_id: level.id, level_id: level.id },
        discriminator: 'U',
        kind: 'cable',
        payload: {
          cable: { cable: 'U', qty: null, origin: 'library', single_row: false, endpoint_confirmed: true },
          ends: [
            deviceEnd(ctx, host, 'A', { from: hostName, to: textParam(ctx.params, 'R2e', 'host.to') }, startStatus(ctx, 'R2e', 'status')),
            placeholderEnd(ctx, 'station_bus', BUS_LABEL, 'B', { from: BUS_LABEL, to: toHost }, level.id),
          ],
          device_id: host.id,
        },
        inputs: { level: level.id, host: host.id },
        params: [['R2e', 'host.to'], ['R2e', busKey], ['R2e', 'status']],
        why: `Level ${level.level} has no Unison bus row (library: ${BUS_LABEL} ↔ ${deviceLabel(ctx, host)}).`,
      });
    }
  },
};

// ------------------------------------------------------------------ R2f

function outOfScope(level: LevelRow | null): boolean {
  return !!level && !level.in_scope;
}

export const R2f: Rule = {
  id: 'R2f',
  title: 'Unsurveyed end',
  text: 'Nothing is copied from the other end (D171): an unsurveyed end stays empty (`Unsurveyed`) until someone surveys it. A run to or on an out-of-scope level is `Not started`, offered as a draft.',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      if (e.status != null) continue;
      const level = endLevel(ctx, e);
      let why: string | null = null;
      if (outOfScope(level)) why = `Level ${level!.level} is out of scope; it will not be surveyed.`;
      else {
        const other = ctx.index.otherEnd(e);
        const farLevel = other ? endLevel(ctx, other) : null;
        const farPlaceholder = other ? endPlaceholder(ctx, other) : null;
        if (outOfScope(farLevel)) why = `The far end is on Level ${farLevel!.level}, out of scope.`;
        else if (farPlaceholder?.kind === 'level_not_in_scope') why = `The far end "${farPlaceholder.label}" is out of scope.`;
      }
      if (!why) continue;
      propose(ctx, e, why);
    }
  },
};

function propose(ctx: RuleContext, e: CableEndRow, why: string): void {
  const now = statusParam(ctx.params, 'R2f', 'status');
  if (!now) return; // set to "no status": nothing to offer
  ctx.propose({
    subject: subjectOfEnd(ctx, e),
    kind: 'status',
    payload: { now, extra: { status_source: 'derived' } },
    inputs: { status: e.status, why },
    params: [['R2f', 'status']],
    why: `${endLabel(ctx, e)}: ${why}`,
  });
}
