/**
 * R3 — punch items (PLAN §6.1, CLAUDE.md §4 R3).
 *
 * - R3a: one "Run <signal> to <far end>" item per unpulled wire (`Cable not run`, `EC`), on the
 *   surveyed end only (E3), gated by R5; once the wire is run (`Issue`, "not terminated") the
 *   item to raise is a `Termination` one.
 * - R3b: a DMX end `Issue` "no term kit" gets its own device-level item `Terminate DMX to <far
 *   end>`, `Missing part`, `EC/ETC`, Notes "Waiting on DMX Termination Kits" (as the master's
 *   rows read; D175).
 * - R3c: every numbering group ends with "Missing all Device Neuron IDs" (`Information`, `EC`,
 *   `sort_last`), Notes = the device IDs still missing; once accepted the engine maintains it:
 *   Notes rewritten, Closed when the list is empty, reopened on a new device without an ID
 *   (D49, D170).
 * - R3d: an item that says "test" or "commission" is flagged (no test or commissioning items).
 * - R3f: an item outside the project's `punch_item` vocabulary is flagged (dismissable).
 */

import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, LevelRow, PunchItemRow } from '../snapshot';
import {
  DMX_KITS_NOTE,
  NEURON_ITEM,
  cableOf,
  compareIds,
  compareLevels,
  deviceLabel,
  endLabel,
  endLevel,
  hasOpenItemText,
  isOpen,
  noteHas,
  signalOf,
  str,
  subjectOfEnd,
  targetOf,
  terminationItem,
  waitsForSurvey,
} from './shared';

// ------------------------------------------------------------------ R3a

export const R3a: Rule = {
  id: 'R3a',
  title: 'Cable not run',
  text: 'One "Run <signal> to <far end>" item per unpulled wire (`Cable not run`, `EC`), on the surveyed end only — when both ends are surveyed, on the start of the run (side A, D177); once the wire is run but not terminated, a `Termination` item instead. Far-end items wait for that floor\'s survey (R5).',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      const code = cableOf(ctx, e)?.cable ?? null;
      if (!code) continue;
      const level = endLevel(ctx, e);
      if (!level) continue;
      if (e.status === 'Not installed') {
        if (waitsForSurvey(ctx, e) || !carriesRunItem(ctx, e)) continue;
        const target = targetOf(ctx, e);
        const item = code === '0-10V' ? 'Run and land 0-10V control wiring' : target ? `Run ${signalOf(code)} to ${target}` : `Run ${signalOf(code)}`;
        if (hasOpenItemText(ctx, e.device_id, e.id, item) || otherEndHasRunItem(ctx, e)) continue;
        ctx.propose({
          subject: subjectOfEnd(ctx, e),
          kind: 'punch',
          payload: { item, type: 'Cable not run', owner: 'EC', device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
          inputs: { status: e.status, item },
          why: `${endLabel(ctx, e)}${e.to_text ? ` (${e.to_text})` : ''} is Not installed: the wire has not been pulled.`,
        });
      } else if (e.status === 'Issue') {
        if (waitsForSurvey(ctx, e)) continue;
        const term = terminationItem(ctx, e);
        if (!term || hasOpenItemText(ctx, e.device_id, e.id, term.item)) continue;
        ctx.propose({
          subject: subjectOfEnd(ctx, e),
          discriminator: 'terminate',
          kind: 'punch',
          payload: { item: term.item, type: 'Termination', owner: term.owner, device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
          inputs: { status: e.status, item: term.item },
          why: `${endLabel(ctx, e)} is Issue "${e.note}": the wire is run and waits for its termination.`,
        });
      }
    }
  },
};

/**
 * One "Run …" item per wire (R3): when both ends are surveyed `Not installed`, the item goes on
 * the **start of the run** — side A, the lower floor in the master, the riser's origin once the
 * riser is imported (D177, Landry: "the start of the run holds the item"). An end whose other
 * end is unsurveyed, or waits for its floor's survey (R5), carries it alone.
 */
function carriesRunItem(ctx: RuleContext, e: CableEndRow): boolean {
  const other = ctx.index.otherEnd(e);
  if (!other || other.status !== 'Not installed' || waitsForSurvey(ctx, other)) return true;
  return e.side === 'A';
}

/** A Run item the rule made on the other end (accepted before this end was surveyed) stands for the wire. */
function otherEndHasRunItem(ctx: RuleContext, e: CableEndRow): boolean {
  const other = ctx.index.otherEnd(e);
  if (!other) return false;
  return (ctx.index.punchByEnd.get(other.id) ?? []).some((p) => isOpen(p) && p.rule_id === 'R3a' && p.type === 'Cable not run');
}

// ------------------------------------------------------------------ R3b

/** The master's DMX-kit item: `Terminate DMX to <far end>` / Missing part / EC/ETC / "Waiting on DMX Termination Kits". */
export function isDmxKitItem(p: PunchItemRow): boolean {
  return p.rule_id === 'R3b' || (p.type === 'Missing part' && noteHas(p.notes, /Waiting on DMX Termination Kits/i));
}

export const R3b: Rule = {
  id: 'R3b',
  title: 'DMX termination kit item',
  text: 'A DMX (X) end that is Issue "no term kit" gets its own device-level item: `Terminate DMX to <far end>`, `Missing part`, `EC/ETC`, Notes "Waiting on DMX Termination Kits". Waits for that floor\'s survey (R5).',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      if (e.status !== 'Issue' || cableOf(ctx, e)?.cable !== 'X' || !noteHas(e.note, /no term kit/i)) continue;
      if (waitsForSurvey(ctx, e)) continue;
      const level = endLevel(ctx, e);
      if (!level) continue;
      const target = targetOf(ctx, e);
      const item = target ? `Terminate DMX to ${target}` : 'Terminate DMX';
      if (hasOpenItemText(ctx, e.device_id, e.id, item)) continue;
      const device = e.device_id ? ctx.index.device.get(e.device_id) : null;
      ctx.propose({
        subject: device ? { entity_kind: 'device', entity_id: device.id, level_id: device.level_id } : subjectOfEnd(ctx, e),
        discriminator: e.id,
        kind: 'punch',
        payload: { item, type: 'Missing part', owner: 'EC/ETC', notes: DMX_KITS_NOTE, device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
        inputs: { status: e.status, item },
        why: `${endLabel(ctx, e)} is Issue "${e.note}": the DMX run waits for a termination kit.`,
      });
    }
  },
};

// ------------------------------------------------------------------ R3c

function isNeuronItem(p: PunchItemRow): boolean {
  return p.rule_id === 'R3c' || p.item === NEURON_ITEM;
}

export const R3c: Rule = {
  id: 'R3c',
  title: 'Missing all Device Neuron IDs',
  text: 'Every numbering group ends with "Missing all Device Neuron IDs" (`Information`, `EC`, sorted last) whose Notes list the device IDs still missing. Once accepted the engine keeps it: Notes rewritten on each capture, Closed when the list is empty, reopened on a new device without an ID (D49, D170).',
  run(ctx) {
    for (const [groupId, group] of ctx.index.levelsByGroup) {
      const levels = group.slice().sort(compareLevels);
      const first = levels[0];
      if (!first) continue;
      const devices = levels.flatMap((l) => (ctx.index.devicesByLevel.get(l.id) ?? []).map((d) => ({ d, l })));
      if (!devices.length) continue;
      const missing = devices
        .filter(({ d }) => !str(d.neuron_id))
        .sort((a, b) => compareLevels(a.l, b.l) || compareIds(a.d.display_id ?? `${a.l.level}-?`, b.d.display_id ?? `${b.l.level}-?`))
        .map(({ d }) => deviceLabel(ctx, d));
      const notes = missing.length ? missing.join(', ') : null;
      const existing = levels
        .flatMap((l) => ctx.index.punchByLevel.get(l.id) ?? [])
        .filter(isNeuronItem)
        .sort((a, b) => Number(b.rule_id === 'R3c') - Number(a.rule_id === 'R3c') || Number(b.sort_last) - Number(a.sort_last) || (a.number ?? 0) - (b.number ?? 0))[0];
      if (existing) {
        maintainNeuronItem(ctx, existing, notes, missing.length);
        continue;
      }
      if (!missing.length) continue;
      ctx.propose({
        subject: { entity_kind: 'numbering_group', entity_id: groupId, level_id: first.id },
        kind: 'punch',
        payload: {
          level_id: first.id,
          item: NEURON_ITEM,
          type: 'Information',
          owner: 'EC',
          tracking_status: 'Open',
          notes,
          sort_last: true,
          device_text: 'All devices',
        },
        inputs: { group: groupId },
        why: `${missing.length} device${missing.length === 1 ? '' : 's'} on ${levelNames(levels)} ${missing.length === 1 ? 'has' : 'have'} no Neuron ID.`,
      });
    }
  },
};

function levelNames(levels: LevelRow[]): string {
  return levels.length === 1 ? `Level ${levels[0]!.level}` : `Levels ${levels.map((l) => l.level).join('/')}`;
}

function maintainNeuronItem(ctx: RuleContext, item: PunchItemRow, notes: string | null, missing: number): void {
  const fields: Record<string, unknown> = { notes };
  if (missing === 0) {
    if (isOpen(item)) {
      fields.tracking_status = 'Closed';
      fields.date_closed = ctx.today();
    }
  } else if (!isOpen(item)) {
    fields.tracking_status = 'Open';
    fields.date_closed = null;
  }
  ctx.maintain({
    entity: 'punch_item',
    id: item.id,
    fields,
    proposal_id: item.proposal_id,
    why: missing ? `${missing} device${missing === 1 ? '' : 's'} still without a Neuron ID` : 'Every device has its Neuron ID',
  });
}

// ------------------------------------------------------------------ R3d / R3f

export const R3d: Rule = {
  id: 'R3d',
  title: 'No test or commissioning items',
  text: 'This phase has no test or commissioning items; an item whose text says "test" or "commission" is flagged.',
  run(ctx) {
    for (const p of ctx.index.punchItem.values()) {
      if (!isOpen(p) || !p.item || !/\b(test|commission)/i.test(p.item)) continue;
      ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `Item mentions testing or commissioning: "${p.item}"` });
    }
  },
};

export const R3f: Rule = {
  id: 'R3f',
  title: 'Item outside the vocabulary',
  text: 'Item text is picked from the project\'s `punch_item` vocabulary (R3e); a hand-typed item outside it is flagged (dismissable). Rule-made items are not checked.',
  run(ctx) {
    const vocab = new Set(ctx.snap.vocab.filter((v) => v.deleted_at == null && v.list === 'punch_item').map((v) => v.value));
    if (!vocab.size) return;
    for (const p of ctx.index.punchItem.values()) {
      if (!isOpen(p) || p.rule_id || !p.item || vocab.has(p.item)) continue;
      ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `Item outside the vocabulary: "${p.item}"` });
    }
  },
};

/** For tests and T35: the ends R3a / R3b would act on, with R5 applied. */
export function actionableEnds(ctx: RuleContext): CableEndRow[] {
  return [...ctx.index.cableEnd.values()].filter((e) => (e.status === 'Not installed' || e.status === 'Issue') && !waitsForSurvey(ctx, e));
}
