/**
 * A cable end that waits for its draft device (T136, D235): the cable was accepted with one placed
 * end, so this end names the draft (`draft_device_id`) and has no device until the draft is placed.
 * The card, the plan's Conns, the end editor and the cable view all name it the same way:
 * `Equipment Rack 18U (draft on 06M, not placed yet)`. No React or Expo imports.
 */

import type { Store } from '@field-survey/core';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The end names a draft and nothing else yet: no device, no placeholder. */
export function waitsForDraft(e: Row | undefined | null): boolean {
  return !!e && !!str(e.draft_device_id) && !str(e.device_id) && !str(e.placeholder_id);
}

/** What a draft device reads as before it is placed: its tag or model, its level. */
export function draftEndLabel(d: Row | undefined, levelCode: string | null): string {
  const what = (d && (str(d.name) ?? str(d.model) ?? str(d.category))) ?? 'draft device';
  return `${what} (draft${levelCode ? ` on ${levelCode}` : ''}, not placed yet)`;
}

/** `draftEndLabel` for every waiting end among `ends`, by draft id. */
export async function loadDraftEndLabels(store: Store, ends: readonly Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(ends.filter(waitsForDraft).map((e) => String(e.draft_device_id)))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await store.db.query<Row>(
    `SELECT d.id, d.name, d.model, d.category, l.level AS level FROM draft_device d LEFT JOIN level l ON l.id = d.level_id WHERE d.id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const id of ids) out.set(id, draftEndLabel(byId.get(id), str(byId.get(id)?.level)));
  return out;
}
