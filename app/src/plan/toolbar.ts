/**
 * The plan toolbar's words (T177). Pure: runs in Node tests.
 *
 * - The back button says where it goes: the plan opens from the Levels home, Needs review, Lint,
 *   the Dashboard, Cable / riser, Setup or another level's plan, and ◀ returns there. The board's
 *   "◀ Levels" is the case of the home (and of a plan opened with nothing under it, where ◀
 *   replaces the stack with the home).
 * - The title is the level code; the line under it names the level and counts its devices.
 */

import { levelName } from '../home/data';

/** The Stack's route names (expo-router file names) → the screen's name as the sidebar spells it. */
const BACK_LABEL: Readonly<Record<string, string>> = {
  index: 'Levels',
  review: 'Needs review',
  cables: 'Cable / riser',
  dashboard: 'Dashboard',
  rulings: 'Rulings',
  lint: 'Lint',
  export: 'Export',
  vocabulary: 'Vocabulary',
  library: 'Library',
  sync: 'Sync',
  projects: 'Projects',
  'setup/[projectId]': 'Setup',
};

/** The back button's label for the route under the plan; `undefined` (nothing under it) is Levels. */
export function backLabelFor(previousRoute: string | undefined): string {
  if (previousRoute === undefined) return 'Levels';
  return BACK_LABEL[previousRoute] ?? (previousRoute.startsWith('setup/') ? 'Setup' : 'Back');
}

/** "Level 6 mezzanine · 23 devices"; "23 devices" for a code with no name. */
export function levelCaption(code: string, devices: number): string {
  return [levelName(code), `${devices} ${devices === 1 ? 'device' : 'devices'}`].filter(Boolean).join(' · ');
}
