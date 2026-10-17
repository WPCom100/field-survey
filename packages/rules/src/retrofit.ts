/**
 * Retrofitting accepted items after a rule parameter changes (T116, T102 follow-up). A changed
 * owner or wording rewords the open drafts on the next run; accepted items keep their text
 * (D176 (3)) until a ruling changes them. This finds those items and groups them into rulings.
 *
 * An accepted item stops its own rule from proposing it again (the rule skips a text an open item
 * already has), so the rules are run over the snapshot **without** the rule-made records: once
 * under the parameters as they were, once as they are (`rewordEffects`). A record joins the
 * selection on a field when the change rewords that field (the two runs differ), the record does
 * not already read the new wording, and it still reads the old one or the one it was accepted
 * with (a field changed by hand is left alone; the ruling's preview can untick the rest). Pure.
 *
 * Punch items are compared on Item / Owner / Device; missing parts on Part / Owner (parts in a
 * second pass with the punch items kept, since R4b's kits follow accepted punch items). The
 * selection comes back grouped by (entity, field), one `reword` ruling each (T120): the ruling
 * writes, per record, what its rule now words, so a template with `<far end>` in it is one ruling.
 */

import type { ParamValue, RuleParamRow } from './params';
import { evaluate } from './evaluate';
import { proposalRowKey, type Rule } from './rule';
import { draftFromSelection, fieldOf, REWORD_FIELDS, type RewordEffects, type RewordParam, type RulingDraft } from './rulings';
import { compareLevels } from './rules/shared';
import { indexSnapshot, type MissingPartRow, type ProposalRow, type PunchItemRow, type Snapshot } from './snapshot';

export type RetrofitEntity = 'punch_item' | 'missing_part';

const ENTITIES: readonly RetrofitEntity[] = ['punch_item', 'missing_part'];

export interface RetrofitGroup {
  entity: RetrofitEntity;
  field: string;
  /** The field's label in the ruling editor ("Item", "Owner"…). */
  label: string;
  /** What the rule now words, distinct (one per record at most). */
  values: string[];
  /** The records, and their level codes (the ruling's scope), in floor order. */
  ids: string[];
  levelCodes: string[];
  /** The values they read now, distinct, for the notice. */
  was: string[];
}

type Rec = (PunchItemRow | MissingPartRow) & Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));

/** A ruling's stored `before` as the parameter rows a rules run reads. */
export function paramRowsOf(before: readonly RewordParam[], projectId: string): RuleParamRow[] {
  return before.map((p, i) => ({ id: `before-${i}`, project_id: projectId, rule_id: p.rule_id, key: p.key, value: p.value, state: 'accepted', deleted_at: null }));
}

/** The accepted, live rows as a ruling stores them (`reword.before`). */
export function rewordParams(rows: readonly RuleParamRow[]): RewordParam[] {
  return rows.filter((r) => r.deleted_at == null && r.state === 'accepted').map((r) => ({ rule_id: r.rule_id, key: r.key, value: r.value }));
}

/**
 * What the rules word on every live rule-made item (cited by a registered rule's proposal), per
 * record and field: `next` under the snapshot's parameters (null: its rule no longer words it),
 * `old` under `before` (null when `before` is null), `accepted` from the proposal it was accepted
 * from. `before` = the project's `rule_param` rows as they were.
 */
export function rewordEffects(snap: Snapshot, rules: readonly Rule[], before: readonly RuleParamRow[] | null, opts: { now?: string } = {}): RewordEffects {
  const ruleIds = new Set(rules.map((r) => r.id));
  const rowById = new Map<string, ProposalRow>();
  for (const p of snap.proposals) if (p.deleted_at == null && ruleIds.has(p.rule_id)) rowById.set(p.id, p);
  const cited = (r: PunchItemRow | MissingPartRow) => r.deleted_at == null && r.proposal_id != null && rowById.has(r.proposal_id);
  const punch = snap.punchItems.filter(cited);
  const parts = snap.missingParts.filter(cited);

  const out = new Map<string, Record<string, { next: string | null; old: string | null; accepted: string | null }>>();
  const pass = (entity: RetrofitEntity, recs: readonly (PunchItemRow | MissingPartRow)[], without: Snapshot) => {
    if (!recs.length) return;
    const run = (params: readonly RuleParamRow[] | undefined) => {
      const s = params ? { ...without, ruleParams: [...params] } : without;
      return new Map(evaluate(s, rules, indexSnapshot(s), opts).proposals.map((o) => [o.key, o.payload] as const));
    };
    const was = before ? run(before) : null;
    const now = run(undefined);
    for (const r of recs) {
      const row = rowById.get(r.proposal_id!)!;
      const key = proposalRowKey(row);
      const oldP = key ? was?.get(key) : undefined;
      const newP = key ? now.get(key) : undefined;
      const fields: Record<string, { next: string | null; old: string | null; accepted: string | null }> = {};
      for (const field of REWORD_FIELDS[entity] ?? []) {
        fields[field] = {
          next: newP && field in newP && str(newP[field]) ? str(newP[field]) : null,
          old: oldP && field in oldP ? str(oldP[field]) : null,
          accepted: row.payload && field in row.payload ? str(row.payload[field]) : null,
        };
      }
      out.set(r.id, fields);
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
  return out;
}

/**
 * The accepted items the change from `before` (the project's `rule_param` rows as they were) to
 * the snapshot's rows would word differently, grouped for one ruling each: most records first.
 */
export function retrofitGroups(snap: Snapshot, rules: readonly Rule[], before: readonly RuleParamRow[], opts: { now?: string } = {}): RetrofitGroup[] {
  const effects = rewordEffects(snap, rules, before, opts);
  const groups = new Map<string, { entity: RetrofitEntity; field: string; recs: { r: Rec; next: string }[] }>();
  for (const entity of ENTITIES) {
    const recs = (entity === 'punch_item' ? snap.punchItems : snap.missingParts) as Rec[];
    for (const r of recs) {
      const fields = effects.get(r.id);
      if (!fields) continue;
      for (const field of REWORD_FIELDS[entity] ?? []) {
        const e = fields[field];
        if (!e?.next || e.old == null) continue; // not worded now, or not worded before
        const cur = str(r[field]);
        if (e.next === e.old || cur === e.next) continue;
        if (cur !== e.old && cur !== (e.accepted ?? '')) continue; // changed by hand
        const gk = `${entity}|${field}`;
        let g = groups.get(gk);
        if (!g) groups.set(gk, (g = { entity, field, recs: [] }));
        g.recs.push({ r, next: e.next });
      }
    }
  }

  const index = indexSnapshot(snap);
  const levelOf = (r: Rec) => index.level.get(r.level_id) ?? null;
  const order = (e: RetrofitEntity, f: string) => (e === 'punch_item' ? 0 : 10) + (REWORD_FIELDS[e]?.indexOf(f) ?? 0);
  return [...groups.values()]
    .map(({ entity, field, recs }): RetrofitGroup => {
      const sorted = recs.slice().sort(({ r: a }, { r: b }) => {
        const la = levelOf(a);
        const lb = levelOf(b);
        return (la && lb ? compareLevels(la, lb) : 0) || (a.number ?? Infinity) - (b.number ?? Infinity) || a.id.localeCompare(b.id);
      });
      return {
        entity,
        field,
        label: fieldOf(entity, field)?.label ?? field,
        values: [...new Set(sorted.map((x) => x.next))],
        ids: sorted.map((x) => x.r.id),
        levelCodes: [...new Set(sorted.map((x) => levelOf(x.r)?.level).filter((c): c is string => !!c))],
        was: [...new Set(sorted.map((x) => str(x.r[field])))],
      };
    })
    .sort((a, b) => b.ids.length - a.ids.length || order(a.entity, a.field) - order(b.entity, b.field));
}

/**
 * The group as a ruling draft: its records, their levels, `reword <field>` with the parameters as
 * they were (`before`, the rows `retrofitGroups` was given), `reason` as the text.
 */
export function retrofitDraft(g: RetrofitGroup, reason: string, before: readonly RuleParamRow[]): RulingDraft {
  const d = draftFromSelection(g.entity, g.ids, g.levelCodes);
  return { ...d, text: reason, action: { kind: 'reword', field: g.field, before: rewordParams(before) } };
}

/** "3 punch items: Owner → "ETC"", or "3 punch items: Item reworded (3 wordings)" for the Rules tab's notice. */
export function describeRetrofit(g: RetrofitGroup): string {
  const n = g.ids.length;
  const what = g.entity === 'punch_item' ? `punch item${n === 1 ? '' : 's'}` : `missing part${n === 1 ? '' : 's'}`;
  return g.values.length === 1 ? `${n} ${what}: ${g.label} → "${g.values[0]}"` : `${n} ${what}: ${g.label} reworded (${g.values.length} wordings)`;
}

/** The ruling's suggested reason after a change to one parameter. */
export function retrofitReason(rule: string, label: string, value: ParamValue | null): string {
  return `Rule parameter ${rule} · ${label} changed${value == null ? ' back to the default' : ''}: accepted items reworded to match`;
}
