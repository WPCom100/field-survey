/**
 * R4 — missing parts (PLAN §6.1, CLAUDE.md §4 R4).
 *
 * - R4a: parts belong to the EC; another owner is flagged.
 * - R4b: an accepted (or imported) DMX-kit item (R3b) gets its part: "DMX termination kit -
 *   <destination> run", Qty 1, `EC`, `Needed`, Notes "Need to be ordered", sourced to the item;
 *   one kit per run.
 * - R4c: default Notes by kind for the part editor — `defaultPartNotes`.
 * - R4d: re-pulled wire and network termination kits are never parts; flagged.
 */

import type { Rule } from '../rule';
import type { MissingPartRow } from '../snapshot';
import { isOpen, targetOf } from './shared';
import { isDmxKitItem } from './r3';

export const R4a: Rule = {
  id: 'R4a',
  title: 'Parts are the EC\'s',
  text: 'Missing parts have Owner `EC`; another owner is flagged.',
  run(ctx) {
    for (const m of ctx.index.missingPart.values()) {
      if (m.owner === 'EC') continue;
      ctx.find({ subject: { entity_kind: 'missing_part', entity_id: m.id, level_id: m.level_id }, message: `Owner ${m.owner ?? '(none)'}: missing parts are the EC's` });
    }
  },
};

export const R4b: Rule = {
  id: 'R4b',
  title: 'DMX termination kit part',
  text: 'A DMX-kit item (R3b) gets its part: "DMX termination kit - <destination> run", Qty 1, `EC`, `Needed`, Notes "Need to be ordered", sourced to the item. One kit per run.',
  run(ctx) {
    // parts already sourced to a punch item
    const sourced = new Set<string>();
    for (const [partId, sources] of ctx.index.sourcesByPart) {
      if (!ctx.index.missingPart.has(partId)) continue;
      for (const s of sources) if (s.target_kind === 'punch') sourced.add(s.target_id);
    }
    for (const p of ctx.index.punchItem.values()) {
      if (!isOpen(p) || !isDmxKitItem(p) || sourced.has(p.id)) continue;
      const end = p.cable_end_id ? ctx.index.cableEnd.get(p.cable_end_id) : null;
      const fromItem = p.item ? /^Terminate DMX to (.+)$/i.exec(p.item)?.[1] : null;
      const destination = fromItem?.trim() || (end ? targetOf(ctx, end) : null) || 'missing';
      const device = p.device_id ? ctx.index.device.get(p.device_id) : null;
      ctx.propose({
        subject: device ? { entity_kind: 'device', entity_id: device.id, level_id: device.level_id } : { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id },
        discriminator: p.id,
        kind: 'part',
        payload: {
          part: `DMX termination kit - ${destination} run`,
          qty: 1,
          owner: 'EC',
          part_status: 'Needed',
          notes: 'Need to be ordered',
          device_id: p.device_id,
          level_id: p.level_id,
          sources: [{ target_kind: 'punch', target_id: p.id }],
        },
        inputs: { item: p.id, destination },
        why: `${p.number != null ? `#${p.number} ` : ''}"${p.item}" waits on a DMX termination kit: one kit per run (R4b).`,
      });
    }
  },
};

/** R4c: the Notes a new part gets by kind — a part or kit is ordered, a device or backbox is checked on site. */
export function defaultPartNotes(kind: 'part' | 'device'): string {
  return kind === 'device' ? 'Confirm whether on site' : 'Need to be ordered';
}

export function partProblem(m: Pick<MissingPartRow, 'part'>): string | null {
  const part = m.part ?? '';
  if (/belden|re-?pull/i.test(part)) return `Re-pulled wire is not a part: "${part}"`;
  if (/network|\bnet\b/i.test(part) && /kit/i.test(part)) return `Network termination kits are not parts: "${part}"`;
  return null;
}

export const R4d: Rule = {
  id: 'R4d',
  title: 'Not a part',
  text: 'Re-pulled wire and network termination kits are never missing parts (R4); such a part is flagged.',
  run(ctx) {
    for (const m of ctx.index.missingPart.values()) {
      const problem = partProblem(m);
      if (problem) ctx.find({ subject: { entity_kind: 'missing_part', entity_id: m.id, level_id: m.level_id }, message: problem });
    }
  },
};
