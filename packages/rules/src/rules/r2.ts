/**
 * R2 — cables (PLAN §6.1, amended by D171 and D172).
 *
 * - R2a: no note is ever auto-filled; a note that contradicts the end's status is a finding.
 * - R2b: the riser governs To; a To text that does not say what the riser says is a finding.
 * - R2c / R2d: **retired** (T199, D289, D290): they draft nothing. Being a relay panel, an NSPS
 *   or a rack gives a device no cable: what a device takes comes from its library type and the
 *   accessories it carries (R2g, `library.ts`), and the texts these two wrote by role are now
 *   R2g's per-code settings. Both stay registered, so the engine supersedes an open draft an
 *   earlier version raised (a row of an unregistered rule is never touched) and "why?" on a
 *   cable accepted from one still has a text.
 * - R2e: one Unison pair per level, `Stations & Sensors` ↔ the NSPS (or the rack where the level
 *   has none), a **draft** (`cable` proposal, D173). The bus is the level's, not something a
 *   device type takes (D183 (3)), so it stays a rule.
 * - R2f: nothing is copied between ends (D171); an unsurveyed end stays empty (`Unsurveyed`).
 *   An end on an out-of-scope level, or whose far end is, is offered `Not started` (D171).
 *
 * The bus row's To texts and starting status, and R2f's status, are rule parameters (T102,
 * `../params.ts`); the texts above are their defaults.
 */

import { riserCheck } from '@field-survey/core';

import { statusParam, textParam } from '../params';
import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, DeviceRow, LevelRow } from '../snapshot';
import { deviceRole } from './library';
import { BUS_LABEL, cableOf, compareIds, compareLevels, deviceLabel, endLabel, endLevel, endPlaceholder, noteHas, placeholderFor, str, subjectOfEnd, takesKits } from './shared';

// ------------------------------------------------------------------ R2a

export const R2a: Rule = {
  id: 'R2a',
  title: 'Note matches status',
  text: 'Notes are never auto-filled (D172). "Not run" goes with `Not installed`, "Run, not terminated" with `Issue`, "no term kit" with a cable that takes termination kits (R4b, D213); a note that says otherwise is flagged.',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      const note = str(e.note);
      if (!note) continue;
      const code = cableOf(ctx, e)?.cable ?? null;
      const status = e.status ?? 'Unsurveyed';
      let problem: string | null = null;
      if (e.status === 'Not installed' && noteHas(note, /run, not terminated/i)) problem = `says "Run, not terminated" but the end is Not installed`;
      else if (e.status !== 'Not installed' && /^not run\b/i.test(note)) problem = `says "Not run" but the end is ${status}`;
      else if (noteHas(note, /no term kit/i) && !takesKits(ctx, cableOf(ctx, e))) problem = `says "no term kit" but this ${code ?? ''} cable takes no termination kits`.replace('  ', ' ');
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

// ------------------------------------------------------------------ R2e (the level's Unison bus, a draft: D173)

type EndDraft = Record<string, unknown>;

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

/** A starting status for the bus's host end (`R2e.status`): the fields, or none for `Unsurveyed`. */
function startStatus(ctx: RuleContext, rule: string, key: string): EndDraft {
  const status = statusParam(ctx.params, rule, key);
  return status ? { status, status_source: 'derived' } : {};
}

/** Retired (T199, D289, D290): drafts nothing; registered so its old open drafts are superseded. */
export const R2c: Rule = {
  id: 'R2c',
  title: 'Relay panel library cables (retired)',
  text: 'Retired (D289, D290): being a relay panel gives a device no cable. A 0-10V or panic run comes from the device\'s library type or an accessory it carries (R2g); a panic run\'s far end is a device a person picks (D294).',
  run() {},
};

/** Retired (T199, D290): drafts nothing; registered so its old open drafts are superseded. */
export const R2d: Rule = {
  id: 'R2d',
  title: '120V library cable (retired)',
  text: 'Retired (D290): being an NSPS or an equipment rack gives a device no cable. Its 120V feed comes from its library type or the power supply it carries (R2g, D288, D291).',
  run() {},
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
