/**
 * R4 — missing parts (PLAN §6.1, CLAUDE.md §4 R4).
 *
 * - R4a: parts belong to the EC; another owner is flagged.
 * - R4b: a cable that takes termination kits (`R4b.kit` per code — X, F, N, NG by default — or
 *   the cable's own `term_kit`; T103, D213) gets one kit part per device end: "DMX termination
 *   kit - <far end> run", Qty 1, `EC`, `Needed`, Notes "Need to be ordered".
 *   - a pulled run waiting on its kit: from the accepted (or imported) kit item (R3b), sourced
 *     to the item;
 *   - an unpulled run: from its accepted Run item (R3a, `Cable not run`) — the end holding the
 *     item gets a kit sourced to the item, the far end its own kit sourced to that end, when it
 *     is a device on an in-scope level and its floor has been surveyed (R5);
 *   - an end that already has its kit (a kit part sourced to the end, or to an item on it) gets
 *     no second one, so the Terminate item that follows a pulled run adds nothing. A kit or kit
 *     item with no end (as the seed import leaves them) stands for the end of its device whose
 *     far end its text names.
 * - R4c: default Notes by kind for the part editor — `defaultPartNotes`.
 * - R4d: re-pulled wire is never a part; a network termination kit is one only on a cable that
 *   takes kits (D213). Flagged otherwise.
 *
 * The parts' owner, the part text, its Notes and the codes that take kits are rule parameters
 * (T102, `../params.ts`).
 */

import { fillTemplate, ownerParam, templatePattern, textParam, type ParamRef } from '../params';
import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, MissingPartRow, PunchItemRow, Subject } from '../snapshot';
import { cableOf, endByDestination, endLabel, endLevel, endsWithKit, isKitItem, isKitPart, isOpen, kitNoteCode, signal, takesKits, targetOf, waitsForSurvey } from './shared';

export const R4a: Rule = {
  id: 'R4a',
  title: 'Parts are the EC\'s',
  text: 'Missing parts have Owner `EC`; another owner is flagged.',
  run(ctx) {
    const owner = ownerParam(ctx.params, 'R4a', 'owner');
    for (const m of ctx.index.missingPart.values()) {
      if (m.owner === owner) continue;
      ctx.find({ subject: { entity_kind: 'missing_part', entity_id: m.id, level_id: m.level_id }, message: `Owner ${m.owner ?? '(none)'}: missing parts are the ${owner}'s` });
    }
  },
};

/** One kit to propose: for an end (or, an imported kit item with no end, for the item). */
interface Kit {
  item: PunchItemRow;
  end: CableEndRow | null;
  code: string;
  destination: string;
  /** The end is the far end of the Run item's run: sourced to the end, not the item. */
  far: boolean;
}

/** An end that gets a kit: a device end on an in-scope level. */
function kitEnd(ctx: RuleContext, e: CableEndRow): boolean {
  if (!e.device_id || !ctx.index.device.has(e.device_id)) return false;
  return !!endLevel(ctx, e)?.in_scope;
}

/** What the item text names as the far end, by the template that made it (the project's, then the default's). */
function destinationOf(item: string | null, patterns: readonly RegExp[]): string | null {
  if (!item) return null;
  for (const re of patterns) {
    const m = re.exec(item)?.[1]?.trim();
    if (m) return m;
  }
  return null;
}

export const R4b: Rule = {
  id: 'R4b',
  title: 'Termination kit part',
  text: 'A cable that takes termination kits (X, F, N and NG by default; a cable\'s own setting overrides its code — D213) gets one kit part per device end: "DMX termination kit - <far end> run", Qty 1, `EC`, `Needed`, Notes "Need to be ordered". A pulled run waiting on its kit gets it from its kit item (R3b), sourced to the item. An unpulled run gets its kits once its Run item (R3a) is accepted: the end holding the item a kit sourced to the item, the far end its own sourced to that end when it is a device on an in-scope level, after that floor\'s survey (R5). An end that already has its kit gets no second one.',
  run(ctx) {
    const kitted = endsWithKit(ctx);
    // items with any part sourced to them (an imported kit item with no end)
    const sourced = new Set<string>();
    for (const [partId, sources] of ctx.index.sourcesByPart) {
      if (!ctx.index.missingPart.has(partId)) continue;
      for (const s of sources) if (s.target_kind === 'punch') sourced.add(s.target_id);
    }
    const kitPatterns = [templatePattern(textParam(ctx.params, 'R3b', 'item'), 'far end'), /^Terminate DMX to (.+)$/i];
    const runPatterns = (code: string) => [templatePattern(textParam(ctx.params, 'R3a', 'run.item', code), 'far end'), /^Run .+? to (.+)$/i];

    // Kit items first, so an end's kit is sourced to its own kit item when it has one.
    const kits = new Map<string, Kit>();
    const add = (key: string, kit: Kit) => {
      if (!kits.has(key)) kits.set(key, kit);
    };
    const open = [...ctx.index.punchItem.values()].filter(isOpen);
    const claimed = new Set(kitted);
    for (const p of open) {
      if (!isKitItem(ctx, p) || sourced.has(p.id)) continue;
      const own = p.cable_end_id ? (ctx.index.cableEnd.get(p.cable_end_id) ?? null) : null;
      const named = destinationOf(p.item, kitPatterns);
      // an imported kit item has no end: the run its text names on its device, if one does
      const run = own ? null : endByDestination(ctx, p.device_id, named, claimed);
      const end = own ?? run;
      const cable = end ? cableOf(ctx, end) : null;
      const code = cable?.cable ?? kitNoteCode(ctx, p.notes) ?? 'X';
      if (end ? !takesKits(ctx, cable) : !ctx.params.flagCode('R4b', 'kit', code)) continue;
      if (end && kitted.has(end.id)) continue;
      if (end) claimed.add(end.id);
      const destination = named || (end ? targetOf(ctx, end) : null) || 'missing';
      add(end ? end.id : `item:${p.id}`, { item: p, end, code, destination, far: false });
    }
    for (const p of open) {
      if (p.type !== 'Cable not run' || !p.cable_end_id) continue;
      const end = ctx.index.cableEnd.get(p.cable_end_id);
      const cable = end ? cableOf(ctx, end) : null;
      if (!end || !cable?.cable || !takesKits(ctx, cable)) continue;
      const code = cable.cable;
      for (const e of [end, ctx.index.otherEnd(end)]) {
        if (!e || kitted.has(e.id) || !kitEnd(ctx, e)) continue;
        const far = e !== end;
        if (far && waitsForSurvey(ctx, e)) continue;
        const destination = (!far ? destinationOf(p.item, runPatterns(code)) : null) || targetOf(ctx, e) || 'missing';
        add(e.id, { item: p, end: e, code, destination, far });
      }
    }

    const owner = ownerParam(ctx.params, 'R4a', 'owner');
    const notes = textParam(ctx.params, 'R4b', 'notes');
    for (const { item: p, end, code, destination, far } of kits.values()) {
      const deviceId = far ? end!.device_id : p.device_id;
      const device = deviceId ? ctx.index.device.get(deviceId) : null;
      const subject: Subject = device ? { entity_kind: 'device', entity_id: device.id, level_id: device.level_id } : { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id };
      const levelId = far ? (endLevel(ctx, end!)?.id ?? p.level_id) : p.level_id;
      const word = signal(ctx, code);
      const run = p.type === 'Cable not run';
      const params: ParamRef[] = [['R4a', 'owner'], ['R4b', 'part', code], ['R4b', 'notes'], ['R4b', 'kit', code], ['R3', 'signal', code]];
      const ref = `${p.number != null ? `#${p.number} ` : ''}"${p.item}"`;
      ctx.propose({
        subject,
        discriminator: far ? `${p.id}:${end!.id}` : p.id,
        kind: 'part',
        payload: {
          part: fillTemplate(textParam(ctx.params, 'R4b', 'part', code), { signal: word, 'far end': destination }),
          qty: 1,
          owner,
          part_status: 'Needed',
          notes,
          device_id: deviceId,
          level_id: levelId,
          sources: [far ? { target_kind: 'cable_end', target_id: end!.id } : { target_kind: 'punch', target_id: p.id }],
        },
        inputs: run ? { item: p.id, end: end!.id, destination } : { item: p.id, destination },
        params,
        why: !run
          ? `${ref} waits on a ${word} termination kit: one kit per end (R4b).`
          : far
            ? `${ref}: the ${word} run takes a termination kit at its far end too, ${endLabel(ctx, end!)} (R4b).`
            : `${ref}: the ${word} run is not pulled yet and takes a termination kit at this end (R4b).`,
      });
    }
  },
};

/** R4c: the Notes a new part gets by kind — a part or kit is ordered, a device or backbox is checked on site. */
export function defaultPartNotes(kind: 'part' | 'device'): string {
  return kind === 'device' ? 'Confirm whether on site' : 'Need to be ordered';
}

/**
 * Why a part is not a part, or null. `networkKits`: network termination kits are parts here (a
 * cable that takes kits stands behind this one, D213); off by default, as R4 read before T103.
 */
export function partProblem(m: Pick<MissingPartRow, 'part'>, opts: { networkKits?: boolean } = {}): string | null {
  const part = m.part ?? '';
  if (/belden|re-?pull/i.test(part)) return `Re-pulled wire is not a part: "${part}"`;
  if (!opts.networkKits && /network|\bnet\b/i.test(part) && /kit/i.test(part)) return `Network termination kits are not parts: "${part}"`;
  return null;
}

/**
 * May this part be a network termination kit (D213)? When it is sourced to a cable (through an
 * end, or an item on an end), that cable must take kits; an unsourced one follows the project's
 * `R4b.kit` for N / NG.
 */
function networkKitsAllowed(ctx: RuleContext, m: MissingPartRow): boolean {
  const cables = new Set<string>();
  for (const s of ctx.index.sourcesByPart.get(m.id) ?? []) {
    const endId = s.target_kind === 'cable_end' ? s.target_id : s.target_kind === 'punch' ? ctx.index.punchItem.get(s.target_id)?.cable_end_id : null;
    const end = endId ? ctx.index.cableEnd.get(endId) : null;
    if (end) cables.add(end.cable_id);
  }
  if (cables.size) return [...cables].some((id) => takesKits(ctx, ctx.index.cable.get(id)));
  return ctx.params.flagCode('R4b', 'kit', 'N') || ctx.params.flagCode('R4b', 'kit', 'NG');
}

export const R4d: Rule = {
  id: 'R4d',
  title: 'Not a part',
  text: 'Re-pulled wire is never a missing part (R4); a network termination kit is one only on a cable that takes termination kits (R4b, D213). Such a part is flagged otherwise.',
  run(ctx) {
    for (const m of ctx.index.missingPart.values()) {
      const problem = partProblem(m, { networkKits: isKitPart(m) && networkKitsAllowed(ctx, m) });
      if (problem) ctx.find({ subject: { entity_kind: 'missing_part', entity_id: m.id, level_id: m.level_id }, message: problem });
    }
  },
};
