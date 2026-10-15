/**
 * Does a connection end's stored To text say what the riser says (R2b, PLAN §6.1)? Shared by the
 * end editor (T22) and the rule engine (T34); T39's cable view uses it too. Lenient on case,
 * punctuation and leading zeros, and a riser word may be the start of a longer To word (riser
 * "DMX TO LEVEL 03 UFMP" matches To "DMX to Level 3 UFMP4s", Phase 3 §4.5), but every riser word
 * must appear, in order.
 */

export type RiserCheck =
  | { state: 'none' }
  | { state: 'match'; riser: string }
  | { state: 'differs'; riser: string; to: string | null };

function tokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

export function riserCheck(riserLabel: string | null | undefined, toText: string | null | undefined): RiserCheck {
  if (!riserLabel?.trim()) return { state: 'none' };
  const want = tokens(riserLabel);
  const have = tokens(toText ?? '');
  let j = 0;
  for (const w of want) {
    while (j < have.length && !have[j]!.startsWith(w)) j++;
    if (j === have.length) return { state: 'differs', riser: riserLabel.trim(), to: toText ?? null };
    j++;
  }
  return { state: 'match', riser: riserLabel.trim() };
}
