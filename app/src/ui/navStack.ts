/**
 * The stack rule (D280, `docs/nav-plan.md` §2.2, T188). Pure: runs in Node tests.
 *
 * - **Sections** are the sidebar's entries (and Projects behind its project button). A sidebar or
 *   rail tap *resets* the root Stack to Levels → that section (Levels itself: just Levels), never
 *   a push, so the stack is never deeper than Levels → section → the details opened from it, and
 *   the Levels home under everything keeps its key (it is not remounted).
 * - **Back**: a section directly on Levels shows none (nothing to go back to); every other screen
 *   shows one, labelled with the screen under it (`backLabelFor`), and a screen with nothing under
 *   it says Levels (its back replaces the stack with the home).
 * - **Transition**: a section directly on Levels appears and leaves with no slide and takes no
 *   edge swipe, so a section switch never animates the rail; details slide as before.
 *
 * Route names are expo-router's file names under `app/src/app` (`index`, `review`,
 * `plan/[levelId]`, `setup/[projectId]`, …); `navStack.test.ts` pins every one this file reads.
 */

/** The sidebar's entries, PLAN §5's names (D266 (1)). */
export type NavName =
  | 'Levels'
  | 'Needs review'
  | 'Cable / riser'
  | 'Dashboard'
  | 'Rulings'
  | 'Lint'
  | 'Export'
  | 'Setup'
  | 'Vocabulary'
  | 'Library'
  | 'Sync';

/** A place the sidebar or the rail opens: its entries, and Projects (the project button). */
export type Section = NavName | 'Projects';

export type NavRoute = { name: string; key?: string; params?: object };

const param = (r: NavRoute | undefined, k: string): unknown => (r?.params as Record<string, unknown> | undefined)?.[k];
export type NavState = { index: number; routes: readonly NavRoute[] };
/** What a section tap does to the Stack: `navigation.reset(state)`. */
export type NavReset = { index: number; routes: NavRoute[] };

/** The section's route name; the project-scoped ones take `?project=`, Setup `[projectId]`. */
const SECTION_ROUTE: Readonly<Record<Section, string>> = {
  Levels: 'index',
  'Needs review': 'review',
  'Cable / riser': 'cables',
  Dashboard: 'dashboard',
  Rulings: 'rulings',
  Lint: 'lint',
  Export: 'export',
  Setup: 'setup/[projectId]',
  Vocabulary: 'vocabulary',
  Library: 'library',
  Sync: 'sync',
  Projects: 'projects',
};

/** Open with no project: the app-level ones. The rest are drawn dim until a project is open. */
const NO_PROJECT: ReadonlySet<Section> = new Set(['Sync', 'Projects']);

const SECTION_ROUTES: ReadonlySet<string> = new Set(Object.values(SECTION_ROUTE));

/** The route names → the screen's name as the sidebar spells it (the back button's word). */
const BACK_LABEL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(SECTION_ROUTE).map(([name, route]) => [route, name])),
  'new-project': 'New project',
  'rule-defaults': 'Rule defaults',
};

/** Whether the entry can be opened: every section but Sync and Projects needs a project. */
export function sectionEnabled(section: Section, projectId: string | null): boolean {
  return NO_PROJECT.has(section) || !!projectId;
}

/** Whether a route name is a section's (the Levels home included). */
export function isSectionRoute(name: string): boolean {
  return SECTION_ROUTES.has(name);
}

/** The route a section tap opens. */
export function sectionRoute(section: Section, projectId: string | null): NavRoute {
  const name = SECTION_ROUTE[section];
  if (NO_PROJECT.has(section) || !projectId) return { name };
  return { name, params: section === 'Setup' ? { projectId } : { project: projectId } };
}

const sameParams = (a: NavRoute, b: NavRoute) => {
  const ka = Object.keys(a.params ?? {});
  const kb = Object.keys(b.params ?? {});
  return ka.length === kb.length && ka.every((k) => String(param(a, k)) === String(param(b, k)));
};

/**
 * The Stack after a sidebar or rail tap on `section`: Levels → section (Levels: Levels alone),
 * reusing the Levels home already at the bottom (its key kept, `project` set to the open one).
 * `null` when the stack is already exactly that, or the entry is not open with no project.
 */
export function sectionTap(state: NavState | undefined, section: Section, projectId: string | null): NavReset | null {
  if (!sectionEnabled(section, projectId)) return null;
  const routes = state?.routes ?? [];
  const bottom = routes[0]?.name === 'index' ? routes[0] : undefined;
  const home: NavRoute = bottom
    ? projectId && param(bottom, 'project') !== projectId
      ? { ...bottom, params: { ...bottom.params, project: projectId } }
      : bottom
    : projectId
      ? { name: 'index', params: { project: projectId } }
      : { name: 'index' };
  if (section === 'Levels') {
    if (routes.length === 1 && home === bottom) return null;
    return { index: 0, routes: [home] };
  }
  const target = sectionRoute(section, projectId);
  const top = routes[1];
  if (routes.length === 2 && home === bottom && top?.name === target.name && sameParams(top, target)) return null;
  return { index: 1, routes: [home, target] };
}

/** A section opened from the sidebar or the rail: directly on the Levels home. */
export function isSectionOnLevels(state: NavState | undefined, i: number): boolean {
  const routes = state?.routes ?? [];
  return i === 1 && routes[0]?.name === 'index' && isSectionRoute(routes[1]?.name ?? '');
}

/** The back button's label for the route under a screen; `undefined` (nothing under it) is Levels. */
export function backLabelFor(previousRoute: string | undefined): string {
  if (previousRoute === undefined) return 'Levels';
  return BACK_LABEL[previousRoute] ?? (previousRoute.startsWith('setup/') ? 'Setup' : 'Back');
}

/**
 * The back button of the route at `i`: `null` for none (the Levels home, a section at the bottom,
 * a section directly on Levels), else the label naming the screen under it.
 */
export function backFor(state: NavState | undefined, i: number): string | null {
  const route = state?.routes[i];
  if (!route) return null;
  if (i === 0) return isSectionRoute(route.name) ? null : backLabelFor(undefined);
  if (isSectionOnLevels(state, i)) return null;
  return backLabelFor(state?.routes[i - 1]?.name);
}

/** The native-stack options of a route: no slide and no edge swipe for a section on Levels. */
export function transitionFor(state: NavState | undefined, routeKey: string): { animation?: 'none'; gestureEnabled?: boolean } {
  const i = state?.routes.findIndex((r) => r.key === routeKey) ?? -1;
  return isSectionOnLevels(state, i) ? { animation: 'none', gestureEnabled: false } : {};
}
