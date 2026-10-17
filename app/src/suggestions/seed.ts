/**
 * The app library's standard suggestion chips (T99, D174 (3), D212): a seed per category and
 * cable code, loaded as drafts for Landry to accept, edit or reject. The phrases are the master's
 * standard phrases (CLAUDE.md §3) placed where they belong, plus the three Landry named in D172 /
 * D174. The kit chips ("; no term kit", "<Signal> termination kit") are not seeded: `chipsFor` computes
 * them from the project's `R4b.kit` (T118, D217). No React or Expo imports.
 */

import type { SuggestionInput } from './model';

const note = (scope: 'category' | 'code', ref: string, target: SuggestionInput['target'], ...texts: string[]): SuggestionInput[] => texts.map((text) => ({ scope, ref, target, text }));

export const SUGGESTION_SEED: readonly SuggestionInput[] = [
  // categories (the D196 names): device Notes
  ...note('category', 'Station', 'device_note', 'Stuck buttons', 'Empty box on wall.'),
  ...note('category', 'Touchscreen', 'device_note', 'Empty box on wall.'),
  ...note('category', 'Sensor', 'device_note', 'Empty box on wall.'),
  ...note('category', 'Wall Plates', 'device_note', 'Empty box on wall.'),
  ...note('category', 'Equipment', 'device_note', 'Not installed: install P-NSPS-D and land 120V and Unison wire', 'Lands in ERP; needs to be run down to the NSPS below it'),
  ...note('category', 'Power Distribution', 'device_note', 'Replace wire nuts with Wagos (provided in box)', 'Land 0-10V control wiring'),
  ...note('category', 'Emergency Equipment', 'device_note', 'Replace wire nuts with Wagos (provided in box)'),
  // cable codes: end Notes and punch items
  ...note('code', 'X', 'connection_note', 'Run, not terminated; no term kit', 'Waiting on DMX Termination Kits'),
  ...note('code', 'X', 'punch_item', 'Missing DMX termination kit'),
  ...note('code', 'N', 'connection_note', 'Missing network termination'),
  ...note('code', 'N', 'punch_item', 'Missing network termination'),
  ...note('code', 'NG', 'connection_note', 'Missing network termination'),
  ...note('code', 'NG', 'punch_item', 'Missing network termination'),
  ...note('code', 'U', 'connection_note', 'Replace wire nuts with Wagos (provided in box)', 'Re-pull correct wire type (Belden 8471) and re-terminate with Wagos (provided in box); provide ground'),
  ...note('code', '0-10V', 'connection_note', 'Land 0-10V control wiring'),
  ...note('code', '120V', 'connection_note', 'Lands in ERP; needs to be run down to the NSPS below it'),
];
