/**
 * The plan toolbar's words (T177). Pure: runs in Node tests.
 *
 * - The back button's label (the screen under the plan) is the shell's: `backFor` in
 *   `ui/navStack.ts` (D280, T188).
 * - The title is the level code; the line under it names the level and counts its devices.
 */

import { levelName } from '../home/data';

/** "Level 6 mezzanine · 23 devices"; "23 devices" for a code with no name. */
export function levelCaption(code: string, devices: number): string {
  return [levelName(code), `${devices} ${devices === 1 ? 'device' : 'devices'}`].filter(Boolean).join(' · ');
}
