/**
 * Reading and editing rule parameters in a core `Store` (T102, D176, D211). Every change is an
 * op through the `Editor` (CLAUDE.md §5): `Master edit`, reason `Rule parameter <rule>.<key>`.
 *
 * - On a project (`editor.projectId` = the project) a value applies at once: the row is
 *   `accepted`, and the next rules run rewords the open drafts (D176 (3)).
 * - On the app library's stream (`LIBRARY_STREAM`, D184) the row is the app-level default; each
 *   change makes it a `draft` until accepted (D43/D48), and only accepted defaults are copied
 *   into a new project (server `projects.py`).
 *
 * Values are stored compactly: a per-code map keeps only the entries that differ from the
 * default, and a value equal to the default is stored as null (the row stays, its history too).
 */

import { isLibraryStream, OpError, type EditContext, type Editor, type Store } from '@field-survey/core';

import { stableStringify } from './hash';
import { isByCode, paramSpec, resolveValue, ruleParamId, RuleParams, validEntry, type CodeEntry, type ParamValue, type RuleParamRow } from './params';

export const RULE_PARAM_REASON = 'Rule parameter';

function ctxFor(rule: string, key: string): EditContext {
  return { change_type: 'Master edit', reason: `${RULE_PARAM_REASON} ${rule}.${key}` };
}

/** The scope's `rule_param` rows (live and deleted): a project's, or the app library's (null). */
export function loadRuleParamRows(store: Store, projectId: string | null): Promise<RuleParamRow[]> {
  return store.list<RuleParamRow>('rule_param', {
    where: projectId == null ? 'project_id IS NULL' : 'project_id = ?',
    params: projectId == null ? [] : [projectId],
    includeDeleted: true,
    orderBy: 'id',
  });
}

/** A project's parameters as the rules read them (quick actions, screens). */
export async function loadRuleParams(store: Store, projectId: string): Promise<RuleParams> {
  return new RuleParams(await loadRuleParamRows(store, projectId));
}

/**
 * What to store for `value`: null when it equals the default, a per-code map without the
 * entries the default already has; throws on a value the parameter cannot take.
 */
export function compactValue(rule: string, key: string, value: ParamValue | null): ParamValue | null {
  const spec = paramSpec(rule, key);
  if (!spec) throw new OpError(`Unknown rule parameter ${rule}.${key}`);
  if (value == null) return null;
  if (isByCode(spec.kind)) {
    if (typeof value !== 'object') throw new OpError(`${spec.label}: expected a value per cable code`);
    const def = spec.default as Record<string, CodeEntry>;
    const out: Record<string, CodeEntry> = {};
    for (const [rawCode, v] of Object.entries(value)) {
      const code = rawCode.trim();
      if (!code) continue;
      if (!validEntry(spec.kind, v)) throw new OpError(`${spec.label}, ${code === '*' ? 'any other code' : code}: "${String(v)}" is not allowed`);
      const t = typeof v === 'string' ? v.trim() : v;
      if (def[code] !== t) out[code] = t;
    }
    return Object.keys(out).length ? out : null;
  }
  if (!validEntry(spec.kind, value)) throw new OpError(`${spec.label}: "${String(value)}" is not allowed`);
  const v = typeof value === 'string' && spec.kind === 'text' ? value.trim() : value;
  return stableStringify(resolveValue(spec, v)) === stableStringify(spec.default) ? null : v;
}

function scopeOf(editor: Editor): string | null {
  return isLibraryStream(editor.projectId) ? null : editor.projectId;
}

/**
 * Set a parameter in the editor's scope (null value = back to the default). Writes nothing when
 * the stored value would not change (a project) — on the app library a re-set of a rejected or
 * draft default still records it as a draft.
 */
export async function setRuleParam(editor: Editor, rule: string, key: string, value: ParamValue | null): Promise<number> {
  const stored = compactValue(rule, key, value);
  const scope = scopeOf(editor);
  const id = ruleParamId(scope, rule, key);
  const row = await editor.store.get<RuleParamRow>('rule_param', id);
  const state = scope ? 'accepted' : 'draft';
  if (!row) {
    if (stored == null && scope) return 0; // a project on the default needs no row
    const ops = await editor.group(ctxFor(rule, key), (g) =>
      g.create('rule_param', { id, project_id: scope, rule_id: rule, key, value: stored, state }),
    );
    return ops.length;
  }
  const same = stableStringify(row.value ?? null) === stableStringify(stored);
  if (same && row.deleted_at == null && (scope ? row.state === 'accepted' : row.state === 'draft')) return 0;
  const ops = await editor.group(ctxFor(rule, key), async (g) => {
    if (row.deleted_at != null) await g.restore('rule_param', id);
    await g.setFields('rule_param', id, { value: stored, state });
  });
  return ops.length;
}

/** App library only: accept or reject a default (only accepted defaults are copied into new projects). */
export async function decideRuleParam(editor: Editor, rule: string, key: string, state: 'accepted' | 'rejected'): Promise<number> {
  if (scopeOf(editor) != null) throw new OpError('Only app-level defaults are accepted or rejected; a project value applies at once.');
  const id = ruleParamId(null, rule, key);
  const row = await editor.store.get<RuleParamRow>('rule_param', id);
  if (!row || row.deleted_at != null) throw new OpError('This default has not been changed.');
  const ops = await editor.group(ctxFor(rule, key), (g) => g.setField('rule_param', id, 'state', state));
  return ops.length;
}
