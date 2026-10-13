/**
 * The project the Levels home last showed (T83). Screens reached from the home without a
 * `project` param (Needs review from Sync, a bare "← Levels" link) open this one instead of the
 * first project on the iPad. Memory only: a cold start opens the first project, as before.
 */
let current: string | null = null;

export function rememberProject(id: string | null): void {
  if (id) current = id;
}

/** `wanted` (a route param) if it is one of `known`, else the remembered project if known, else the first. */
export function pickProject(known: readonly string[], wanted?: string | null): string | null {
  if (wanted && known.includes(wanted)) return wanted;
  if (current && known.includes(current)) return current;
  return known[0] ?? null;
}
