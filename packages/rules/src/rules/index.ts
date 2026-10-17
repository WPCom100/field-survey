/**
 * The rule registry the app runs (T34): PLAN §6.1 as amended by D170–D173. One file per rule
 * family, each exporting `Rule`s. Order matters only for log lines; proposals are keyed, not
 * ordered. R5 is not a rule of its own: it is the `waitsForSurvey` gate R3a, R3b and R4b apply
 * (`shared.ts`). E6 / E7 / E9 are quick actions a person runs (`quick.ts`), not evaluations.
 * T36 adds the PLAN §6.3 lint checks the rules above do not raise (`lint.ts`, `LINT_RULES`).
 * T48 adds R2g, the accepted device types' default cables (`library.ts`).
 * T37 adds the standing rulings (`../rulings.ts`, `RulingRule`): one rule over every standing ruling.
 */

import type { Rule } from '../rule';
import { Acc, E5 } from './e5';
import { R1 } from './r1';
import { R2g } from './library';
import { R2a, R2b, R2c, R2d, R2e, R2f } from './r2';
import { R3a, R3b, R3c, R3d, R3f } from './r3';
import { R4a, R4b, R4d } from './r4';
import { LINT_RULES } from './lint';
import { RulingRule } from '../rulings';

export const RULES: readonly Rule[] = [R1, R2a, R2b, R2c, R2d, R2e, R2f, R2g, R3a, R3b, R3c, R3d, R3f, R4a, R4b, R4d, E5, Acc, ...LINT_RULES, RulingRule];

/** R5's text for "why?" and docs; the gate itself is `waitsForSurvey`. */
export const R5_TEXT = 'Far-end items wait for that floor\'s survey: an end on a level with no Surveyed date that nobody has surveyed raises no R3a / R3b / R4b item yet.';

export { R1, R2a, R2b, R2c, R2d, R2e, R2f, R2g, R3a, R3b, R3c, R3d, R3f, R4a, R4b, R4d, E5, Acc };
export { isNeuronItem, actionableEnds } from './r3';
export { LINT_RULES, VOCAB_FIELDS } from './lint';
export { defaultPartNotes, partProblem } from './r4';
export { LAND_0_10V } from './e5';
export { SIGNAL, NEURON_ITEM, DMX_KITS_NOTE, BUS_LABEL, signalOf, signal, targetOf, terminationItem, waitsForSurvey, compareIds, compareLevels, takesKits, isKitItem, isKitPart, kitNote } from './shared';
export { runQuickAction, appendPhrase, QUICK_ACTION_TEXT, type QuickAction, type QuickActionResult } from './quick';
export {
  CABLE_CODES,
  cableCodes,
  NO_NEURON_ROLES,
  cableTitle,
  deviceNeedsNeuronId,
  deviceRole,
  libraryCablePayload,
  placeholderLabelled,
  findDeviceType,
  governingCables,
  needsNeuronId,
  neuronIdDefault,
  neuronIdDefaultForRole,
  parseLibraryAccessories,
  parseLibraryCables,
  typeOfDevice,
  type LibraryAccessory,
  type LibraryCable,
  type TypeLike,
} from './library';
