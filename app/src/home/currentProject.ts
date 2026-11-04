/**
 * The project the Levels home last showed (T83). Screens reached from the home without a
 * `project` param (Needs review from Sync, a bare "← Levels" link) open this one instead of the
 * first project on the iPad. Memory only: a cold start opens the first project, as before.
 */
let current: string | null = null;

export function rememberProject(id: string | null): void {
  if (id) current = id;
}

/**
 * True while the home is asked for a project (`wanted`, the route param) that the local store
 * does not hold yet: a project created a moment ago reaches the store with the next sync, and
 * falling back to another project then would lose it for good (T151, found by the Mac rig).
 */
export function awaitingProject(known: readonly string[], wanted: string | null | undefined, shown: string | null): boolean {
  return !!wanted && shown === wanted && !known.includes(wanted);
}

/** `wanted` (a route param) if it is one of `known`, else the remembered project if known, else the first. */
export function pickProject(known: readonly string[], wanted?: string | null): string | null {
  if (wanted && known.includes(wanted)) return wanted;
  if (current && known.includes(current)) return current;
  return known[0] ?? null;
}
