/**
 * The rule registry the app runs. T33 ships the engine with no rules; T34 adds R1–R5 and
 * E5–E9 here (one file per rule family, each exporting `Rule`s), T36 the lint checks.
 * Order matters only for log lines; proposals are keyed, not ordered.
 */

import type { Rule } from '../rule';

export const RULES: readonly Rule[] = [];
