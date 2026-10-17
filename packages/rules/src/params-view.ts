/**
 * The Rules tab's model (T102, D176 (4)): the catalogue grouped by rule, each group with the
 * rule's own text, each parameter with its value in this scope, its default and whether it is
 * set. Pure: the rows come from `loadRuleParamRows`.
 */

import { stableStringify } from './hash';
import { PARAMS, isByCode, paramSpec, resolveValue, type ParamSpec, type ParamValue, type RuleParamRow } from './params';
import { QUICK_ACTION_TEXT, RULES, R5_TEXT } from './rules';
import { CABLE_CODES } from './rules/library';

export interface ParamItem {
  spec: ParamSpec;
  /** The value in this scope (the stored value over the default). */
  value: ParamValue;
  /** True when this scope sets it away from the built-in default. */
  set: boolean;
  /** The app library's row state (`draft` until accepted); null on a project or with no row. */
  state: 'draft' | 'accepted' | 'rejected' | null;
  /** For a per-code parameter: the codes to list (`*` first, then the known codes and any set). */
  codes: string[];
}

export interface ParamGroup {
  rule: string;
  title: string;
  /** The rule's text as the engine explains it. */
  text: string;
  items: ParamItem[];
}

const EXTRA: Readonly<Record<string, { title: string; text: string }>> = {
  R3: { title: 'Signal words', text: 'The word each cable code stands for in item text ("Run DMX to …", "Terminate network to …"), shared by R3a and R3b.' },
  R5: { title: 'Survey gate', text: R5_TEXT },
  ...Object.fromEntries(Object.entries(QUICK_ACTION_TEXT).map(([k, v]) => [k, { title: `Quick action: ${v.title}`, text: v.text }])),
};

export function ruleTitle(rule: string): { title: string; text: string } {
  const r = RULES.find((x) => x.id === rule);
  return r ? { title: r.title, text: r.text } : (EXTRA[rule] ?? { title: rule, text: '' });
}

/** The groups in catalogue order for one scope's rows (a project's, or the app library's). */
export function paramGroups(rows: readonly RuleParamRow[], opts: { app?: boolean } = {}): ParamGroup[] {
  const byKey = new Map<string, RuleParamRow>();
  for (const r of rows) if (r.deleted_at == null) byKey.set(`${r.rule_id}|${r.key}`, r);
  const usable = (row: RuleParamRow | undefined) => !!row && row.value != null && (opts.app || row.state === 'accepted');
  // The codes every per-code table lists: the library's, plus any the scope gave a signal word.
  const signalSpec = paramSpec('R3', 'signal')!;
  const signalRow = byKey.get('R3|signal');
  const known = [...new Set([...CABLE_CODES, ...Object.keys(resolveValue(signalSpec, usable(signalRow) ? signalRow!.value : null) as object)])];
  const groups: ParamGroup[] = [];
  for (const spec of PARAMS) {
    let g = groups[groups.length - 1];
    if (!g || g.rule !== spec.rule) {
      g = { rule: spec.rule, ...ruleTitle(spec.rule), items: [] };
      groups.push(g);
    }
    const row = byKey.get(`${spec.rule}|${spec.key}`);
    // A project reads accepted rows only; the app library shows its drafts as they stand.
    const value = resolveValue(spec, usable(row) ? row!.value : null);
    const set = stableStringify(value) !== stableStringify(spec.default);
    const codes = isByCode(spec.kind) ? codeList(spec, value as Record<string, string>, known) : [];
    g.items.push({ spec, value, set, state: opts.app && row ? row.state : null, codes });
  }
  return groups;
}

function codeList(spec: ParamSpec, value: Record<string, string>, known: readonly string[]): string[] {
  const extra = Object.keys(value).filter((c) => c !== '*' && !known.includes(c));
  return [...('*' in (spec.default as object) ? ['*'] : []), ...known, ...extra.sort()];
}

/** One code's value in a per-code item, and whether it comes from `*` (not set for that code). */
export function codeValue(item: ParamItem, code: string): { value: string; inherited: boolean } {
  const map = item.value as Record<string, string>;
  if (code in map) return { value: map[code]!, inherited: false };
  return { value: map['*'] ?? code, inherited: true };
}

/** The per-code map with one code set (or, `null`, cleared back to the default / `*`). */
export function withCode(item: ParamItem, code: string, v: string | null): Record<string, string> {
  const map = { ...(item.value as Record<string, string>) };
  const def = item.spec.default as Record<string, string>;
  if (v == null) {
    if (code in def) map[code] = def[code]!;
    else delete map[code];
  } else map[code] = v;
  return map;
}

/** A short text of a value for lists and notices. */
export function describeValue(spec: ParamSpec, value: ParamValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') {
    if (spec.kind === 'status') return value || 'No status (Unsurveyed)';
    if (spec.kind === 'side') return value === 'A' ? 'Start of the run (side A)' : 'End of the run (side B)';
    return value;
  }
  return Object.entries(value)
    .map(([c, v]) => `${c === '*' ? 'other' : c}: ${v}`)
    .join(' · ');
}

export { paramSpec };
