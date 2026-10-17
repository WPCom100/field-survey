/**
 * Retrofitting accepted items after a rule parameter changes (T116, T102 follow-up). A changed
 * owner or wording rewords the open drafts on the next run; accepted items keep their text
 * (D176 (3)) until a ruling changes them. This finds those items and groups them into rulings.
 *
 * An accepted item stops its own rule from proposing it again (the rule skips a text an open item
 * already has), so the rules are run over the snapshot **without** the rule-made records: once
 * under the parameters as they were, once as they are. A record joins the selection on a field
 * when the change rewords that field (the two runs differ), the record does not already read the
 * new wording, and it still reads the old one or the one it was accepted with (a field changed by
 * hand is left alone; the ruling's preview can untick the rest). Pure.
 *
 * Punch items are compared on Item / Owner / Device; missing parts on Part / Owner (parts in a
 * second pass with the punch items kept, since R4b's kits follow accepted punch items). One
 * `set` ruling carries one value, so the selection comes back grouped by (entity, field, new value).
 */

import type { ParamValue, RuleParamRow } from './params';
import { evaluate } from './evaluate';
import { proposalRowKey, type Rule } from './rule';
import { draftFromSelection, fieldOf, type RulingDraft } from './rulings';
import { compareLevels } from './rules/shared';
import { indexSnapshot, type MissingPartRow, type ProposalRow, type PunchItemRow, type Snapshot } from './snapshot';

export type RetrofitEntity = 'punch_item' | 'missing_part';

const FIELDS: Readonly<Record<RetrofitEntity, readonly string[]>> = {
  punch_item: ['item', 'owner', 'device_text'],
  missing_part: ['part', 'owner'],
};

export interface RetrofitGroup {
  entity: RetrofitEntity;
  field: string;
  /** The field's label in the ruling editor ("Item", "Owner"…). */
  label: string;
  /** What the rule now words. */
  value: string;
  /** The records, and their level codes (the ruling's scope), in floor order. */
  ids: string[];
  levelCodes: string[];
  /** The values they read now, distinct, for the notice. */
  was: string[];
}

type Rec = (PunchItemRow | MissingPartRow) & Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * The accepted items the change from `before` (the project's `rule_param` rows as they were) to
 * the snapshot's rows would word differently, grouped for one ruling each: most records first.
 */
export function retrofitGroups(snap: Snapshot, rules: readonly Rule[], before: readonly RuleParamRow[], opts: { now?: string } = {}): RetrofitGroup[] {
  const ruleIds = new Set(rules.map((r) => r.id));
  const rowById = new Map<string, ProposalRow>();
  for (const p of snap.proposals) if (p.deleted_at == null && ruleIds.has(p.rule_id)) rowById.set(p.id, p);
  const cited = (r: PunchItemRow | MissingPartRow) => r.deleted_at == null && r.proposal_id != null && rowById.has(r.proposal_id);
  const punch = snap.punchItems.filter(cited);
  const parts = snap.missingParts.filter(cited);

  const groups = new Map<string, RetrofitGroup & { recs: Rec[] }>();
  const pass = (entity: RetrofitEntity, recs: readonly (PunchItemRow | MissingPartRow)[], without: Snapshot) => {
    if (!recs.length) return;
    const run = (params: readonly RuleParamRow[] | undefined) => {
      const s = params ? { ...without, ruleParams: [...params] } : without;
      return new Map(evaluate(s, rules, indexSnapshot(s), opts).proposals.map((o) => [o.key, o.payload] as const));
    };
    const was = run(before);
    const now = run(undefined);
    for (const r of recs as Rec[]) {
      const row = rowById.get(r.proposal_id!)!;
      const key = proposalRowKey(row);
      const oldP = key ? was.get(key) : undefined;
      const newP = key ? now.get(key) : undefined;
      if (!oldP || !newP) continue;
      for (const field of FIELDS[entity]) {
        if (!(field in newP)) continue;
        const next = str(newP[field]);
        const cur = str(r[field]);
        if (next === str(oldP[field]) || cur === next || !next) continue;
        if (cur !== str(oldP[field]) && cur !== str(row.payload?.[field])) continue; // changed by hand
        const gk = `${entity}|${field}|${next}`;
        let g = groups.get(gk);
        if (!g) {
          g = { entity, field, label: fieldOf(entity, field)?.label ?? field, value: next, ids: [], levelCodes: [], was: [], recs: [] };
          groups.set(gk, g);
        }
        g.recs.push(r);
      }
    }
  };
  const punchIds = new Set(punch.map((p) => p.id));
  pass('punch_item', punch, { ...snap, punchItems: snap.punchItems.filter((p) => !punchIds.has(p.id)) });
  const partIds = new Set(parts.map((p) => p.id));
  pass('missing_part', parts, {
    ...snap,
    missingParts: snap.missingParts.filter((p) => !partIds.has(p.id)),
    partSources: snap.partSources.filter((s) => !partIds.has(s.missing_part_id)),
  });

  const index = indexSnapshot(snap);
  const levelOf = (r: Rec) => index.level.get(r.level_id) ?? null;
  const order = (e: RetrofitEntity, f: string) => (e === 'punch_item' ? 0 : 10) + FIELDS[e].indexOf(f);
  return [...groups.values()]
    .map(({ recs, ...g }) => {
      const sorted = recs.slice().sort((a, b) => {
        const la = levelOf(a);
        const lb = levelOf(b);
        return (la && lb ? compareLevels(la, lb) : 0) || (a.number ?? Infinity) - (b.number ?? Infinity) || a.id.localeCompare(b.id);
      });
      return {
        ...g,
        ids: sorted.map((r) => r.id),
        levelCodes: [...new Set(sorted.map((r) => levelOf(r)?.level).filter((c): c is string => !!c))],
        was: [...new Set(sorted.map((r) => str(r[g.field])))],
      };
    })
    .sort((a, b) => b.ids.length - a.ids.length || order(a.entity, a.field) - order(b.entity, b.field) || a.value.localeCompare(b.value));
}

/** The group as a ruling draft: its records, their levels, `set <field> = <new value>`, `reason` as the text. */
export function retrofitDraft(g: RetrofitGroup, reason: string): RulingDraft {
  const d = draftFromSelection(g.entity, g.ids, g.levelCodes);
  return { ...d, text: reason, action: { kind: 'set', field: g.field, value: g.value } };
}

/** "3 punch items: Owner → ETC" for the Rules tab's notice. */
export function describeRetrofit(g: RetrofitGroup): string {
  const n = g.ids.length;
  const what = g.entity === 'punch_item' ? `punch item${n === 1 ? '' : 's'}` : `missing part${n === 1 ? '' : 's'}`;
  return `${n} ${what}: ${g.label} → "${g.value}"`;
}

/** The ruling's suggested reason after a change to one parameter. */
export function retrofitReason(rule: string, label: string, value: ParamValue | null): string {
  return `Rule parameter ${rule} · ${label} changed${value == null ? ' back to the default' : ''}: accepted items reworded to match`;
}
