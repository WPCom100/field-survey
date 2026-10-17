/**
 * TP-8 — rule golden tests over the seeded master (T35).
 *
 * `fixtures/master-ops.json` is the op log a client pulls after the server has imported
 * `fixtures/Lighting_Control_Survey_Master_B2-06_4.xlsx` (`server/tests/dump_master_ops.py`:
 * `POST /imports` + the worker, then `GET /ops` paged). It is replayed here into a Node store
 * through `Store.applyRemoteMany` — the pull path — and the engine runs over it as it would on
 * an iPad. The checks:
 *
 * 1. the replay is clean and the snapshot has the master's counts (T27's DoD);
 * 2. over the master as imported the engine proposes exactly the **known differences** below
 *    and nothing else, raises no finding, and its only writes are R3c's upkeep of the seven
 *    Neuron ID items (D175 (4)); a second run writes nothing;
 * 3. with the master's copied ends unsurveyed (D171) the differences marked `copied` go away;
 * 4. R3c: with the master's Neuron ID items removed the engine proposes one per numbering group
 *    with the master's Device text and the IDs still missing;
 * 5. R3b / R4b: with the master's DMX-kit items and their kits removed the engine re-proposes
 *    the item per "no term kit" end and, once each is accepted, its kit sourced to it;
 * 6. E5: an ERP-FT-LVD short of the BOM count offers the 0-10V end Issue "Not landed" and the
 *    panel "Land 0-10V control wiring", which the master holds on 01-01, 01-03 and 06M-02;
 * 7. R4b on unpulled runs (T103, D213): with the master's kits on unpulled DMX runs and their Run
 *    items removed, accepting the re-made Run items gives a kit at each device end of every
 *    cable that takes kits — the master's rows, plus the far ends and the network / fiber runs
 *    the master raised none for.
 *
 * Every difference between the engine's output and the master's rows is listed in this file
 * with the master row it stands against; the test checks that those rows exist as cited, so the
 * list cannot drift from the fixture. Regenerate the fixture after a seed-import change.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Editor, Store, type EditContext, type Op } from '@field-survey/core';
import { BetterSqliteDriver } from '@field-survey/core/node';
import { describe, expect, it } from 'vitest';

import { RuleEngine } from '../engine';
import { RULES } from '../rules/index';

import { compareIds, compareLevels, DMX_KITS_NOTE, NEURON_ITEM } from '../rules/shared';
import type { CableEndRow, MissingPartRow, ProposalRow, PunchItemRow, Snapshot } from '../snapshot';

const FILE = fileURLToPath(new URL('../../../../fixtures/master-ops.json', import.meta.url));
const missing = !existsSync(FILE);
const ME = '0199e000-0000-7000-8000-00000000c0de';
const CTX: EditContext = { change_type: 'Field survey', reason: 'TP-8' };
const NOW = '2026-10-15T12:00:00.000Z';

type Row = Record<string, unknown>;
/** A master row: level code, number on that level, item / part text. */
type MasterRef = readonly [level: string, number: number, text: string];

interface Difference {
  rule: 'R3a' | 'R3b';
  /** The end the proposal is about, `<level>/<end display id>`. */
  where: string;
  /** The engine's item text. */
  item: string;
  /** The master's row the engine's draft stands against, or null when the master has none. */
  master: MasterRef | null;
  why: string;
  /** The end is one the master copied from the other end ("(per …)"): unsurveyed under D171. */
  copied?: true;
}

/**
 * What the engine proposes over the master as imported, and why each is not a duplicate of a
 * master row (D175 (8) skips a draft only when an open item with the same text is on the same
 * device or end). Wording differences are the engine's D175 (2) form against the surveyor's
 * free text; the rest are rows the master folded into another item or filed elsewhere.
 */
const KNOWN_DIFFERENCES: readonly Difference[] = [
  // ---- R3a: Run / Terminate items
  { rule: 'R3a', where: '01/C-16', item: 'Run network & ground to 01-06', master: null, why: 'the master has no run item: the touchscreen itself is Not installed (01 #10)' },
  { rule: 'R3a', where: '01/C-17', item: 'Run Unison to equipment rack', master: ['01', 49, 'Run Unison to equipment rack'], why: 'the same text, but the master linked the item to no device or end ("Stations & sensors"), so it does not silence the draft on the stations\' end' },
  { rule: 'R3a', where: '02/C-09', item: 'Run Unison to P-NSPS-D', master: ['02', 7, 'Not installed: install P-NSPS-D and land 120V and Unison wire'], why: "the master folded the run into the NSPS's Not installed item; the engine files it where the run starts, the stations' end (D177)" },
  { rule: 'R3a', where: '02/C-14', item: 'Run 120V to P-NSPS-D Power Supply', master: ['02', 7, 'Not installed: install P-NSPS-D and land 120V and Unison wire'], why: "the master folded the run into the NSPS's Not installed item" },
  { rule: 'R3a', where: '03/C-13', item: 'Run DMX to Missing DMX run (one per UFMP4)', master: ['03', 27, 'Pull missing DMX cable'], why: "the master's items (03 #27/#28) sit on UFMP4 #1 and #2; the import left this end's device unresolved (D126) and its To text is the surveyor's note" },
  { rule: 'R3a', where: '04/C-08', item: 'Run UHCI-WM partition sensor to Level 06M 06M-01', master: ['04', 33, 'Not installed: install UHCI-WM'], why: 'the master has no run item for the partition-sensor wire: the device itself is Not installed' },
  { rule: 'R3a', where: '04/C-14', item: 'Run 120V to P-NSPS-D Power Supply', master: ['04', 29, 'Not installed: install P-NSPS-D and land 120V and Unison wire'], why: "the master folded the run into the NSPS's Not installed item" },
  { rule: 'R3a', where: '06/C-10', item: 'Terminate Unison to equipment rack', master: ['06M', 15, 'Terminate Unison runs at rack'], why: 'the master filed the termination on 06M under "PI1002 stations" with no device; the engine files it on the stations\' end on 06' },
  { rule: 'R3a', where: '06M/C-03', item: 'Run DMX to Spare DMX out', master: ['06M', 7, 'Run 2x spare DMX (Where?)'], why: 'wording, and the master item names no single end ("2x spare", no destination), so the import left it device-only (T119)' },
  { rule: 'R3a', where: '06M/C-07', item: 'Run DMX to Level 09', master: ['06M', 2, 'Run 2x DMX cables to Lvl 9 & 6M Equipment Rack'], why: 'one master item for two wires' },
  { rule: 'R3a', where: '06M/C-12', item: 'Run DMX to equipment rack', master: ['06M', 2, 'Run 2x DMX cables to Lvl 9 & 6M Equipment Rack'], why: 'one master item for two wires' },
  { rule: 'R3a', where: '06M/C-15', item: 'Terminate Unison to Stations & Sensors', master: ['06M', 15, 'Terminate Unison runs at rack'], why: "the rack end is the master's copy of 06/C-10 (\"(per C-10)\")", copied: true },
  // ---- R3b: DMX termination kit items
  { rule: 'R3b', where: '01/C-20', item: 'Terminate DMX to Level B1 CTB1LCPB', master: ['B1', 5, 'Terminate DMX to Level B2'], why: "the rack end is the master's copy of B1/C-02 (\"(per Level B1)\"); the kit item is B1's", copied: true },
  { rule: 'R3b', where: '02/C-12', item: 'Terminate DMX to CT02LCPB', master: ['02', 10, 'Terminate DMX to UFMP4'], why: "the UFMP4 end is the master's copy of 02/C-06 (\"(per C-06)\")", copied: true },
  { rule: 'R3b', where: '03/C-10', item: 'Terminate DMX to Level 04 CT04LCPA', master: ['03', 10, 'Terminate DMX'], why: "the master's items are on UFMP4 #1 and #2 (03 #10/#11); the import left this end's device unresolved (D126)" },
  { rule: 'R3b', where: '03/C-14', item: 'Terminate DMX to CT03LCPA', master: ['03', 10, 'Terminate DMX'], why: "the UFMP4 end is the master's copy of 03/C-01 (\"(per C-01)\")", copied: true },
  { rule: 'R3b', where: '06M/C-09', item: 'Terminate DMX to Level 09', master: ['06M', 12, 'Terminate DMX'], why: 'one master item for both CT06LCPA runs (names no single end, so the import left it device-only — T119)' },
  { rule: 'R3b', where: '06M/C-13', item: 'Terminate DMX to Level 04 CT04LCPA', master: ['06M', 12, 'Terminate DMX'], why: 'one master item for both CT06LCPA runs (names no single end, so the import left it device-only — T119)' },
];

/**
 * Differences T119 removed: the master's item is worded otherwise, but the import now puts it on
 * the end it names, and an end holding an open item of the same kind gets no second (D218). The
 * test checks each master row sits on that end.
 */
const LINKED_BY_IMPORT: readonly { rule: 'R3a' | 'R3b'; where: string; master: MasterRef; was: string }[] = [
  { rule: 'R3a', where: 'B2/C-04', master: ['B2', 4, 'Run 120V to NSPS power supply'], was: 'Run 120V to P-NSPS-D Power Supply' },
  { rule: 'R3a', where: '01/C-12', master: ['01', 45, 'Run DMX to UFMP4s'], was: 'Run DMX to UFMP4 (7)' },
  { rule: 'R3a', where: '01/C-14', master: ['01', 48, 'Terminate network to Level 02'], was: 'Terminate network to Level 02 02-03' },
  { rule: 'R3a', where: '04/C-07', master: ['04', 32, 'Run DMX from Level 06'], was: 'Run DMX to Level 06M 06M-01' },
  { rule: 'R3a', where: '06M/C-04', master: ['06M', 10, 'Terminate 2x network runs to ERn4 Level 16'], was: 'Terminate network to Level 16' },
  { rule: 'R3a', where: '06M/C-05', master: ['06M', 8, 'Run fiber to Equipment rack Level 28'], was: 'Run fiber to Level 28' },
  { rule: 'R3a', where: '06M/C-06', master: ['06M', 9, 'Terminate fiber to Equipment rack Level 01'], was: 'Terminate fiber to Level 01 01-05' },
  { rule: 'R3a', where: '06M/C-25', master: ['06M', 17, 'Run 120V to equipment rack'], was: 'Run 120V to Equipment rack' },
  { rule: 'R3b', where: 'B2/C-01', master: ['B2', 2, 'Terminate DMX to Level B1'], was: 'Terminate DMX to Level B1 CTB1LCPB' },
  { rule: 'R3b', where: '01/C-18', master: ['01', 40, 'Terminate DMX from CT01LCPB'], was: 'Terminate DMX to CT01LCPB' },
  { rule: 'R3b', where: '01/C-19', master: ['01', 41, 'Terminate DMX from CT01LCPA'], was: 'Terminate DMX to CT01LCPA' },
  { rule: 'R3b', where: '04/C-02', master: ['04', 5, 'Terminate DMX to Level 03'], was: 'Terminate DMX to Level 03 UFMP4s' },
  { rule: 'R3b', where: '04/C-05', master: ['04', 27, 'Terminate DMX to Level 03'], was: 'Terminate DMX to Level 03 CT03LCPB' },
];

/**
 * R4b over the master as imported (T119): the master's own Run items on a cable that takes kits,
 * now on their ends, get a kit at each device end that has none (D213 (c)) — the network and fiber
 * runs the master raised no kit for, and one far end. `where` is the end the kit is for; `run` the
 * master's Run item it comes from (sourced to it, or to the far end when `far`).
 */
const KNOWN_KITS: readonly { where: string; device: string; part: string; run: MasterRef; why: string; far?: true }[] = [
  { where: '01/C-13', device: '01-05', part: 'Network termination kit - Walter Tower ETC P-CCS run', run: ['01', 47, 'Run network to Walter Tower ETC P-CCS'], why: 'network takes kits (D213); the far end is the Walter Tower placeholder, so this end only' },
  { where: 'B2/C-05', device: 'B2-03', part: 'Network termination kit - P-NSPS-D run', run: ['B2', 5, 'Run network to P-NSPS-D'], why: "network takes kits (D213); the part names the master item's destination" },
  { where: '01/C-21', device: '01-05', part: 'Network termination kit - Level B2 P-NSPS-D run', run: ['B2', 5, 'Run network to P-NSPS-D'], why: 'the rack end of B2/C-05', far: true },
  { where: '06M/C-05', device: '06M-01', part: 'Fiber termination kit - Equipment rack Level 28 run', run: ['06M', 8, 'Run fiber to Equipment rack Level 28'], why: 'fiber takes kits (D213); the master raised none for the unpulled fiber run to Level 28' },
  { where: '06M/C-18', device: '06M-01', part: 'DMX termination kit - Level 04 UFMP8 run', run: ['04', 32, 'Run DMX from Level 06'], why: "the 06M end of 04/C-07, whose 04 end has the master's 04 #5 (\"Level 06 run\", sourced to 04 #32)", far: true },
];

const kitKey = (k: { where: string; part: string }) => `R4b ${k.where}: ${k.part}`;

/** The ends whose status the master copied from the other end (note "(per …)"): Unsurveyed under D171. */
const COPIED_ENDS = ['01/C-20', '01/C-21', '02/C-12', '03/C-14', '06M/C-15', '06M/C-17', '06M/C-18', '06M/C-19'];

/** The master's seven Neuron ID items (D49), by level and number. */
const NEURON_ITEMS: readonly MasterRef[] = [
  ['B2', 9, NEURON_ITEM], ['B1', 28, NEURON_ITEM], ['01', 53, NEURON_ITEM], ['02', 32, NEURON_ITEM],
  ['03', 31, NEURON_ITEM], ['04', 44, NEURON_ITEM], ['06', 18, NEURON_ITEM],
];

/**
 * R3b / R4b over the D171 view with the master's kit items and kits removed: the item and the
 * kit the engine makes per DMX "no term kit" end, each against the master's pair.
 */
interface KitPair {
  where: string;
  device: string | null;
  item: string;
  part: string;
  masterItem: MasterRef;
  masterPart: MasterRef;
}
const KIT_PAIRS: readonly KitPair[] = [
  { where: 'B2/C-01', device: 'B2-01', item: 'Terminate DMX to Level B1 CTB1LCPB', part: 'DMX termination kit - Level B1 CTB1LCPB run', masterItem: ['B2', 2, 'Terminate DMX to Level B1'], masterPart: ['B2', 1, 'DMX termination kit - Level B1 run'] },
  { where: 'B1/C-01', device: 'B1-01', item: 'Terminate DMX to Level 01', part: 'DMX termination kit - Level 01 run', masterItem: ['B1', 4, 'Terminate DMX to Level 01'], masterPart: ['B1', 2, 'DMX termination kit - Level 01 run'] },
  { where: 'B1/C-02', device: 'B1-01', item: 'Terminate DMX to Level B2', part: 'DMX termination kit - Level B2 run', masterItem: ['B1', 5, 'Terminate DMX to Level B2'], masterPart: ['B1', 3, 'DMX termination kit - Level B2 run'] },
  { where: '01/C-18', device: '01-05', item: 'Terminate DMX to CT01LCPB', part: 'DMX termination kit - CT01LCPB run', masterItem: ['01', 40, 'Terminate DMX from CT01LCPB'], masterPart: ['01', 19, 'DMX termination kit - CT01LCPB run'] },
  { where: '01/C-19', device: '01-05', item: 'Terminate DMX to CT01LCPA', part: 'DMX termination kit - CT01LCPA run', masterItem: ['01', 41, 'Terminate DMX from CT01LCPA'], masterPart: ['01', 20, 'DMX termination kit - CT01LCPA run'] },
  { where: '02/C-01', device: '02-01', item: 'Terminate DMX to Level 03', part: 'DMX termination kit - Level 03 run', masterItem: ['02', 4, 'Terminate DMX to Level 03'], masterPart: ['02', 1, 'DMX termination kit - Level 03 run'] },
  { where: '02/C-02', device: '02-01', item: 'Terminate DMX to Level 01', part: 'DMX termination kit - Level 01 run', masterItem: ['02', 5, 'Terminate DMX to Level 01'], masterPart: ['02', 2, 'DMX termination kit - Level 01 run'] },
  { where: '02/C-05', device: '02-04', item: 'Terminate DMX to Level 03', part: 'DMX termination kit - Level 03 run', masterItem: ['02', 9, 'Terminate DMX to Level 03'], masterPart: ['02', 3, 'DMX termination kit - Level 03 run'] },
  { where: '02/C-06', device: '02-04', item: 'Terminate DMX to UFMP4', part: 'DMX termination kit - UFMP4 run', masterItem: ['02', 10, 'Terminate DMX to UFMP4'], masterPart: ['02', 4, 'DMX termination kit - UFMP4 run'] },
  { where: '03/C-01', device: '03-01', item: 'Terminate DMX to UFMP4s', part: 'DMX termination kit - UFMP4s run', masterItem: ['03', 3, 'Terminate DMX to UFMP4s'], masterPart: ['03', 2, 'DMX termination kit - UFMP4 run'] },
  { where: '03/C-02', device: '03-01', item: 'Terminate DMX to Level 02', part: 'DMX termination kit - Level 02 run', masterItem: ['03', 4, 'Terminate DMX to Level 02'], masterPart: ['03', 3, 'DMX termination kit - Level 02 run'] },
  { where: '03/C-06', device: '03-03', item: 'Terminate DMX to Level 04', part: 'DMX termination kit - Level 04 run', masterItem: ['03', 7, 'Terminate DMX to Level 04'], masterPart: ['03', 4, 'DMX termination kit - Level 04 run'] },
  { where: '03/C-07', device: '03-03', item: 'Terminate DMX to Level 02', part: 'DMX termination kit - Level 02 run', masterItem: ['03', 8, 'Terminate DMX to Level 02'], masterPart: ['03', 5, 'DMX termination kit - Level 02 run'] },
  { where: '03/C-10', device: null, item: 'Terminate DMX to Level 04 CT04LCPA', part: 'DMX termination kit - Level 04 CT04LCPA run', masterItem: ['03', 10, 'Terminate DMX'], masterPart: ['03', 6, 'DMX termination kit - CT03LCPA or Level 04 run'] },
  { where: '04/C-02', device: '04-01', item: 'Terminate DMX to Level 03 UFMP4s', part: 'DMX termination kit - Level 03 UFMP4s run', masterItem: ['04', 5, 'Terminate DMX to Level 03'], masterPart: ['04', 3, 'DMX termination kit - Level 03 run'] },
  { where: '04/C-05', device: '04-03', item: 'Terminate DMX to Level 03 CT03LCPB', part: 'DMX termination kit - Level 03 CT03LCPB run', masterItem: ['04', 27, 'Terminate DMX to Level 03'], masterPart: ['04', 4, 'DMX termination kit - Level 03 run'] },
  { where: '06M/C-09', device: '06M-04', item: 'Terminate DMX to Level 09', part: 'DMX termination kit - Level 09 run', masterItem: ['06M', 12, 'Terminate DMX'], masterPart: ['06M', 12, 'DMX termination kit - Level 09 run'] },
  { where: '06M/C-13', device: '06M-04', item: 'Terminate DMX to Level 04 CT04LCPA', part: 'DMX termination kit - Level 04 CT04LCPA run', masterItem: ['06M', 12, 'Terminate DMX'], masterPart: ['06M', 13, 'DMX termination kit - Level 04 run'] },
];

/**
 * Test 5's removal takes 04 #2 (sourced to the kit item 04 #4 and to the Run item 04 #3) and
 * 06M #13 with it, so the unpulled 04/C-01 — its Run item 04 #3 on that end since T119 — gets
 * its kits back from the Run item: this end, and the far end until 06M/C-13's kit item is accepted.
 */
const RUN_KITS_AFTER_REMOVAL: readonly { where: string; part: string; run: MasterRef; far?: true }[] = [
  { where: '04/C-01', part: 'DMX termination kit - Level 06 run', run: ['04', 3, 'Run DMX to Level 06'] },
  { where: '06M/C-13', part: 'DMX termination kit - Level 04 CT04LCPA run', run: ['04', 3, 'Run DMX to Level 06'], far: true },
];

/** The master's DMX-kit items the engine does not re-make, and why. */
const KIT_ITEMS_MASTER_ONLY: readonly (readonly [MasterRef, string])[] = [
  [['03', 11, 'Terminate DMX'], 'the second UFMP4 of one Connections row ("UFMP4 #1, #2"): the engine makes one item per end'],
  [['04', 4, 'Terminate DMX to Level 06'], 'the wire is not run yet (04/C-01 Not installed): R3a\'s "Run DMX to Level 06" (04 #3) stands; the master raised the kit item with the run'],
];

/**
 * R4b on unpulled runs (T103, D213): the master's Run items whose kits it raised with the run
 * (Landry: every run that needs terminating gets its kit, at both device ends), and the end the
 * import puts each Run item on (T119; null where its text names no single end).
 */
const UNPULLED_MASTER: readonly { run: MasterRef; end: string | null; kits: readonly MasterRef[] }[] = [
  { run: ['01', 42, 'Run DMX to B3A Canyon'], end: '01/C-09', kits: [['01', 8, 'DMX termination kit - B3A Canyon run']] },
  { run: ['01', 43, 'Run DMX to C13A Oculus'], end: '01/C-10', kits: [['01', 9, 'DMX termination kit - C13A Oculus run']] },
  { run: ['01', 44, 'Run DMX to D1 ED Column Capital'], end: '01/C-11', kits: [['01', 10, 'DMX termination kit - D1 ED Column Capital run']] },
  { run: ['01', 45, 'Run DMX to UFMP4s'], end: '01/C-12', kits: [['01', 11, 'DMX termination kit - UFMP4 run']] },
  { run: ['03', 27, 'Pull missing DMX cable'], end: null, kits: [['03', 15, 'DMX termination kit - missing run']] },
  { run: ['03', 28, 'Pull missing DMX cable'], end: null, kits: [['03', 16, 'DMX termination kit - missing run']] },
  { run: ['04', 3, 'Run DMX to Level 06'], end: '04/C-01', kits: [['04', 2, 'DMX termination kit - Level 06 run']] },
  { run: ['06M', 2, 'Run 2x DMX cables to Lvl 9 & 6M Equipment Rack'], end: null, kits: [['06M', 10, 'DMX termination kit - Level 09 run'], ['06M', 11, 'DMX termination kit - 6M Equipment Rack run']] },
  { run: ['06M', 5, 'Run DMX to B3B Elev Core C fixture'], end: '06M/C-01', kits: [['06M', 4, 'DMX termination kit - B3B Elev Core C fixture run']] },
  { run: ['06M', 6, 'Run DMX to B7 Stair A fixture'], end: '06M/C-02', kits: [['06M', 5, 'DMX termination kit - B7 Stair A fixture run']] },
  { run: ['06M', 7, 'Run 2x spare DMX (Where?)'], end: null, kits: [['06M', 6, 'DMX termination kit - spare DMX out runs']] },
];

/**
 * What R4b proposes once every re-made Run item is accepted: per end (`far` = sourced to the far
 * end, not the item), against the master's kit, or why the master has none.
 */
const UNPULLED_KITS: readonly { where: string; device: string; part: string; master: MasterRef | null; why: string; far?: true; viaItem?: MasterRef }[] = [
  { where: '01/C-09', device: '01-05', part: 'DMX termination kit - B3A Canyon run', master: ['01', 8, 'DMX termination kit - B3A Canyon run'], why: 'the same row' },
  { where: '01/C-10', device: '01-05', part: 'DMX termination kit - C13A Oculus run', master: ['01', 9, 'DMX termination kit - C13A Oculus run'], why: 'the same row' },
  { where: '01/C-11', device: '01-05', part: 'DMX termination kit - D1 ED Column Capital run', master: ['01', 10, 'DMX termination kit - D1 ED Column Capital run'], why: 'the same row' },
  { where: '01/C-12', device: '01-05', part: 'DMX termination kit - UFMP4 (7) run', master: ['01', 11, 'DMX termination kit - UFMP4 run'], why: 'wording: the To text counts the UFMP4s' },
  {
    where: '04/C-01',
    device: '04-01',
    part: 'DMX termination kit - Level 06 run',
    master: ['04', 2, 'DMX termination kit - Level 06 run'],
    why: "the same row, made before any Run item is accepted: the master's kit item 04 #4 (no end) waits on it, and its text names 04/C-01's run",
    viaItem: ['04', 4, 'Terminate DMX to Level 06'],
  },
  { where: '06M/C-01', device: '06M-01', part: 'DMX termination kit - B3B Elev Core C fixture run', master: ['06M', 4, 'DMX termination kit - B3B Elev Core C fixture run'], why: 'the same row' },
  { where: '06M/C-02', device: '06M-01', part: 'DMX termination kit - B7 Stair A fixture run', master: ['06M', 5, 'DMX termination kit - B7 Stair A fixture run'], why: 'the same row' },
  { where: '06M/C-03', device: '06M-01', part: 'DMX termination kit - Spare DMX out run', master: ['06M', 6, 'DMX termination kit - spare DMX out runs'], why: 'wording: one cable record for the two spares' },
  { where: '06M/C-07', device: '06M-02', part: 'DMX termination kit - Level 09 run', master: ['06M', 10, 'DMX termination kit - Level 09 run'], why: 'the same row' },
  { where: '06M/C-12', device: '06M-02', part: 'DMX termination kit - equipment rack run', master: ['06M', 11, 'DMX termination kit - 6M Equipment Rack run'], why: 'wording: the To text names no level' },
  { where: '06M/C-14', device: '06M-01', part: 'DMX termination kit - CT06LCPB run', master: null, why: "the rack end of 06M/C-12: the master raised one kit per run, on the run's start", far: true },
  { where: '01/C-16', device: '01-05', part: 'Network termination kit - 01-06 run', master: null, why: 'network takes kits (D213); the master raised none' },
  { where: '01/C-24', device: '01-06', part: 'Network termination kit - equipment rack run', master: null, why: 'network takes kits (D213): the touchscreen end of 01/C-16', far: true },
];

/** The master's unpulled-run kits the engine does not re-make, and why. */
const UNPULLED_MASTER_ONLY: readonly (readonly [MasterRef, string])[] = [
  [['03', 15, 'DMX termination kit - missing run'], "on UFMP4 #1: the import left 03/C-13's device unresolved (D126), and a kit goes on a device end only"],
  [['03', 16, 'DMX termination kit - missing run'], 'on UFMP4 #2: as 03 #15'],
];

/** E5: the master's panels short of ERP-FT-LVD cards, their Land items and 0-10V ends. */
const LVD_SHORT: readonly { device: string; expected: number; found: number; end: string; masterItem: MasterRef }[] = [
  { device: '01-01', expected: 2, found: 1, end: '01/C-03', masterItem: ['01', 3, 'Land 0-10V control wiring'] },
  { device: '01-03', expected: 2, found: 1, end: '01/C-07', masterItem: ['01', 5, 'Land 0-10V control wiring'] },
  { device: '06M-02', expected: 1, found: 0, end: '06M/C-11', masterItem: ['06M', 16, 'Land 0-10V control wiring'] },
];

// ----------------------------------------------------------------- harness

interface Master {
  store: Store;
  editor: Editor;
  engine: RuleEngine;
  projectId: string;
  outcomes: Record<string, number>;
}

async function openMaster(): Promise<Master> {
  const dump = JSON.parse(readFileSync(FILE, 'utf8')) as { project_id: string; ops: Op[] };
  const store = await Store.open(new BetterSqliteDriver(), { installId: '0199e000-0000-7000-8000-000000000001', search: 'like' });
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < dump.ops.length; i += 500) {
    for (const r of await store.applyRemoteMany(dump.ops.slice(i, i + 500))) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  }
  const editor = new Editor(store, { projectId: dump.project_id, userId: ME, now: () => NOW });
  const engine = new RuleEngine(store, { projectId: dump.project_id, userId: ME, rules: RULES, now: () => NOW });
  return { store, editor, engine, projectId: dump.project_id, outcomes };
}

/** Lookups by the master's labels over a snapshot. */
class Labels {
  readonly levelById = new Map<string, string>();
  readonly deviceById = new Map<string, string>();
  readonly endById = new Map<string, string>();
  readonly endByLabel = new Map<string, CableEndRow>();
  readonly deviceByLabel = new Map<string, string>();
  constructor(readonly snap: Snapshot) {
    for (const l of snap.levels) this.levelById.set(l.id, l.level);
    for (const d of snap.devices) {
      if (d.display_id) {
        this.deviceById.set(d.id, d.display_id);
        this.deviceByLabel.set(d.display_id, d.id);
      }
    }
    for (const e of snap.cableEnds) {
      if (!e.display_id) continue;
      const label = `${this.levelById.get(e.level_id ?? '') ?? '?'}/${e.display_id}`;
      this.endById.set(e.id, label);
      this.endByLabel.set(label, e);
    }
  }

  /** Where a proposal is: the end it is about (R3b's discriminator is the end id), else the device. */
  whereOf(p: { rule_id: string; subject: ProposalRow['subject']; discriminator: string | null }): string {
    if (p.rule_id === 'R3b' && p.discriminator) return this.endById.get(p.discriminator) ?? p.discriminator;
    const s = p.subject;
    if (!s) return '?';
    if (s.entity_kind === 'cable_end') return this.endById.get(s.entity_id) ?? s.entity_id;
    if (s.entity_kind === 'device') return this.deviceById.get(s.entity_id) ?? s.entity_id;
    return `${s.entity_kind}:${s.entity_id}`;
  }

  /** The end an R4b kit is for: the end it is sourced to (`far`), else the end of the item it is sourced to. */
  kitWhere(p: { payload: Record<string, unknown> | null }): { where: string; far: boolean } {
    const s = (p.payload!.sources as { target_kind: string; target_id: string }[])[0]!;
    if (s.target_kind === 'cable_end') return { where: this.endById.get(s.target_id)!, far: true };
    const item = this.snap.punchItems.find((x) => x.id === s.target_id)!;
    return { where: this.endById.get(item.cable_end_id!)!, far: false };
  }

  /** A proposal's key: the item for R3a / R3b, the kit's end and part for R4b. */
  keyOf(p: { rule_id: string; subject: ProposalRow['subject']; discriminator: string | null; payload: Record<string, unknown> | null }): string {
    if (p.rule_id === 'R4b') return kitKey({ where: this.kitWhere(p).where, part: String(p.payload?.part) });
    return key({ rule: p.rule_id, where: this.whereOf(p), item: String(p.payload?.item) });
  }

  punch([level, number, text]: MasterRef): PunchItemRow {
    const row = this.snap.punchItems.find((p) => this.levelById.get(p.level_id) === level && p.number === number);
    if (!row) throw new Error(`no punch item ${level} #${number}`);
    expect(row.item, `${level} #${number}`).toBe(text);
    return row;
  }

  part([level, number, text]: MasterRef): MissingPartRow {
    const row = this.snap.missingParts.find((p) => this.levelById.get(p.level_id) === level && p.number === number);
    if (!row) throw new Error(`no missing part ${level} #${number}`);
    expect(row.part, `part ${level} #${number}`).toBe(text);
    return row;
  }

  end(label: string): CableEndRow {
    const e = this.endByLabel.get(label);
    if (!e) throw new Error(`no end ${label}`);
    return e;
  }
}

const key = (d: { rule: string; where: string; item: string }) => `${d.rule} ${d.where}: ${d.item}`;
const sorted = (xs: readonly string[]) => [...xs].sort();

/** The snapshot with the master's copied ends unsurveyed (D171), as the iPad would hold them. */
function d171View(snap: Snapshot, labels: Labels): Snapshot {
  const copied = new Set(COPIED_ENDS.map((l) => labels.end(l).id));
  return { ...snap, cableEnds: snap.cableEnds.map((e) => (copied.has(e.id) ? { ...e, status: null, status_source: null, note: null, surveyed_at: null, surveyed_by_id: null } : e)) };
}

async function unsurveyCopiedEnds(m: Master, labels: Labels): Promise<void> {
  await m.editor.group(CTX, async (g) => {
    for (const l of COPIED_ENDS) await g.setFields('cable_end', labels.end(l).id, { status: null, status_source: null, note: null, surveyed_at: null, surveyed_by_id: null });
  });
}

const openProposals = (m: Master) => m.store.list<ProposalRow>('proposal', { where: `project_id = ? AND state = 'proposed'`, params: [m.projectId], orderBy: 'rule_id, id' });

/** The master's own findings: the import's four unresolved From texts (D126), which the rules never touch. */
const IMPORT_FINDINGS = [
  "01 C-23: From 'UFMP4 (7)' matches no device or placeholder",
  "03 C-10: From 'UFMP4 #1, #2' matches no device or placeholder",
  "03 C-13: From 'UFMP4 #1, #2' matches no device or placeholder",
  "03 C-14: From 'UFMP4 #1, #2' matches no device or placeholder",
];

/**
 * The lint view's "Cable with missing far end" over the master (T36): the twelve cables whose far
 * end the import left unresolved (D126; the import lists them as `import_pair` reviews and
 * findings), as `<end> <message>`. A real finding over the master, not a rule difference.
 */
const FAR_END_FINDINGS: readonly string[] = [
  '01/C-05 C-05: DMX cable, the far end names no device or placeholder',
  '01/C-12 C-12: DMX cable, the far end "UFMP4 (7)" names no device or placeholder',
  '02/C-01 C-01: DMX cable, the far end names no device or placeholder',
  '02/C-02 C-02: DMX cable, the far end names no device or placeholder',
  '02/C-05 C-05: DMX cable, the far end names no device or placeholder',
  '03/C-01 C-01: DMX cable, the far end "UFMP4 #1, #2" names no device or placeholder',
  '03/C-02 C-02: DMX cable, the far end names no device or placeholder',
  '03/C-05 C-05: network cable, the far end names no device or placeholder',
  '03/C-07 C-07: DMX cable, the far end names no device or placeholder',
  '04/C-02 C-02: DMX cable, the far end "UFMP4 #1, #2" names no device or placeholder',
  '04/C-12 C-12: network cable, the far end names no device or placeholder',
  '(unnumbered) NEW: DMX cable, the far end "UFMP4 #1, #2" names no device or placeholder',
];

/** Open findings the rules raised (the import's `import.*` ones set aside, and checked to be the four known; the twelve far ends checked and set aside too). */
async function ruleFindings(m: Master, labels?: Labels) {
  const all = await m.engine.openFindings();
  expect(all.filter((f) => f.lint_id.startsWith('import.')).map((f) => f.message).sort()).toEqual(IMPORT_FINDINGS);
  const far = all.filter((f) => f.lint_id === 'lint.far_end');
  if (labels) expect(far.map((f) => `${labels.endById.get(f.subject!.entity_id) ?? '(unnumbered)'} ${f.message}`).sort()).toEqual([...FAR_END_FINDINGS].sort());
  else expect(far).toHaveLength(FAR_END_FINDINGS.length);
  return all.filter((f) => !f.lint_id.startsWith('import.') && f.lint_id !== 'lint.far_end');
}

// ------------------------------------------------------------------- tests

describe.skipIf(missing)(`TP-8 rule golden tests over the seeded master${missing ? ' — SKIPPED: fixtures/master-ops.json is missing (run server/tests/dump_master_ops.py)' : ''}`, () => {
  it('replays the import cleanly into a Node store with the master\'s counts', async () => {
    const m = await openMaster();
    expect(m.outcomes).toEqual({ applied: 1076, recorded: 375 }); // the project's create + 1,075 import ops (7 numbering groups among them); 375 historical ops recorded, never materialised (Change Log, D124)
    const snap = await m.engine.loadSnapshot();
    expect(snap.project?.name).toBe('Tower');
    expect(snap.levels.map((l) => l.level).sort()).toEqual(['01', '02', '03', '04', '06', '06M', 'B1', 'B2']);
    expect(snap.numberingGroups).toHaveLength(7); // 06 and 06M share one (D33)
    expect(snap.devices).toHaveLength(210);
    expect(snap.cableEnds.filter((e) => e.display_id)).toHaveLength(107);
    expect(snap.punchItems).toHaveLength(215);
    expect(snap.missingParts).toHaveLength(85);
    expect(snap.partSources).toHaveLength(156);
    expect(snap.levels.every((l) => l.numbering_group_id && snap.numberingGroups.some((g) => g.id === l.numbering_group_id))).toBe(true);
  });

  it('over the master as imported proposes exactly the known differences, no findings, and maintains the seven Neuron ID items', async () => {
    const m = await openMaster();
    const labels = new Labels(await m.engine.loadSnapshot());
    // every cited master row exists with the cited text
    for (const d of KNOWN_DIFFERENCES) if (d.master) labels.punch(d.master);
    // T119: the master's items the import put on their ends stand for the engine's (D218)
    for (const l of LINKED_BY_IMPORT) expect(labels.punch(l.master).cable_end_id, l.where).toBe(labels.end(l.where).id);
    for (const k of KNOWN_KITS) expect(labels.punch(k.run).cable_end_id, k.where).not.toBeNull();
    const r1 = await m.engine.run();
    expect(r1.problems).toBe(0);
    expect(r1.findings).toBe(FAR_END_FINDINGS.length);
    const rows = await openProposals(m);
    const got = rows.map((p) => labels.keyOf(p));
    expect(sorted(got)).toEqual(sorted([...KNOWN_DIFFERENCES.map(key), ...KNOWN_KITS.map(kitKey)]));
    for (const l of LINKED_BY_IMPORT) expect(got, l.where).not.toContain(key({ rule: l.rule, where: l.where, item: l.was }));
    for (const p of rows.filter((x) => x.rule_id === 'R4b')) {
      const { where, far } = labels.kitWhere(p);
      const k = KNOWN_KITS.find((x) => x.where === where)!;
      expect(far, where).toBe(!!k.far);
      const source = far ? { target_kind: 'cable_end', target_id: labels.end(where).id } : { target_kind: 'punch', target_id: labels.punch(k.run).id };
      expect(p.payload, where).toMatchObject({ qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered', device_id: labels.deviceByLabel.get(k.device), level_id: labels.end(where).level_id, sources: [source] });
    }
    for (const p of rows.filter((x) => x.rule_id !== 'R4b')) {
      const d = KNOWN_DIFFERENCES.find((x) => x.rule === p.rule_id && x.where === labels.whereOf(p))!;
      const end = labels.end(d.where);
      expect(p.payload, key(d)).toMatchObject({ cable_end_id: end.id, level_id: end.level_id, device_id: end.device_id });
      if (p.rule_id === 'R3b') expect(p.payload).toMatchObject({ type: 'Missing part', owner: 'EC/ETC', notes: DMX_KITS_NOTE });
      else if (p.discriminator === 'terminate') expect(p.payload).toMatchObject({ type: 'Termination' });
      else expect(p.payload).toMatchObject({ type: 'Cable not run', owner: 'EC' });
    }
    expect(await ruleFindings(m, labels)).toEqual([]);
    // R3c: the master's Neuron items get their Notes (empty in the workbook) — one "Rule engine R3c" op each, nothing else touched
    expect(r1.upkeep).toBe(7);
    const snap = await m.engine.loadSnapshot();
    const after = new Labels(snap);
    for (const ref of NEURON_ITEMS) {
      const item = after.punch(ref);
      expect(item).toMatchObject({ type: 'Information', owner: 'EC', tracking_status: 'Open', sort_last: true, device_text: 'All devices' });
      expect(item.notes).toBe(expectedNeuronNotes(snap, item.level_id));
      const ops = await m.store.opsFor(item.id);
      expect(ops.filter((o) => o.reason === 'Rule engine R3c').map((o) => o.field)).toEqual(['notes']);
    }
    // a second run writes nothing
    expect((await m.engine.run()).ops).toBe(0);
  });

  it('with the master\'s copied ends unsurveyed (D171) the copied differences go away and nothing else changes', async () => {
    const m = await openMaster();
    const snap = await m.engine.loadSnapshot();
    const labels = new Labels(snap);
    for (const l of COPIED_ENDS) expect(labels.end(l).note, l).toMatch(/\(per /);
    expect(snap.cableEnds.filter((e) => /\(per /.test(e.note ?? '')).map((e) => labels.endById.get(e.id)).sort()).toEqual([...COPIED_ENDS].sort());
    const { out } = await m.engine.plan(d171View(snap, labels));
    const got = out.proposals.map((p) => labels.keyOf(p));
    expect(sorted(got)).toEqual(sorted([...KNOWN_DIFFERENCES.filter((d) => !d.copied).map(key), ...KNOWN_KITS.map(kitKey)]));
    expect(out.findings.filter((f) => f.lint_id !== 'lint.far_end')).toEqual([]);
    expect(out.findings.filter((f) => f.lint_id === 'lint.far_end')).toHaveLength(FAR_END_FINDINGS.length);
  });

  it('R3c: without the master\'s Neuron ID items the engine proposes one per numbering group, on its first level, listing the IDs still missing', async () => {
    const m = await openMaster();
    const snap = await m.engine.loadSnapshot();
    const labels = new Labels(snap);
    const neuron = new Set(NEURON_ITEMS.map((ref) => labels.punch(ref).id));
    const { out } = await m.engine.plan({ ...snap, punchItems: snap.punchItems.filter((p) => !neuron.has(p.id)) });
    expect(out.upkeep).toEqual([]);
    const drafts = out.proposals.filter((p) => p.rule_id === 'R3c');
    expect(drafts).toHaveLength(7);
    expect(new Set(drafts.map((p) => p.subject.entity_id)).size).toBe(7);
    for (const p of drafts) {
      const levels = snap.levels.filter((l) => l.numbering_group_id === p.subject.entity_id).sort(compareLevels);
      const first = levels[0]!;
      expect(p.subject).toMatchObject({ entity_kind: 'numbering_group', level_id: first.id });
      expect(p.payload).toEqual({ level_id: first.id, item: NEURON_ITEM, type: 'Information', owner: 'EC', tracking_status: 'Open', notes: expectedNeuronNotes(snap, first.id), sort_last: true, device_text: 'All devices', why: expect.any(String) });
    }
    // the master's rows are exactly what the drafts would make
    for (const ref of NEURON_ITEMS) {
      const item = labels.punch(ref);
      const draft = drafts.find((p) => p.payload.level_id === item.level_id)!;
      expect(draft, `${ref[0]} #${ref[1]}`).toBeDefined();
      expect(item).toMatchObject({ item: NEURON_ITEM, type: 'Information', owner: 'EC', sort_last: true, device_text: 'All devices' });
    }
    // every other proposal is one of the known differences (the Neuron items hide nothing)
    const rest = out.proposals.filter((p) => p.rule_id !== 'R3c').map((p) => labels.keyOf(p));
    expect(sorted(rest)).toEqual(sorted([...KNOWN_DIFFERENCES.map(key), ...KNOWN_KITS.map(kitKey)]));
  });

  it('R3b / R4b: without the master\'s DMX-kit items and kits the engine re-makes the item per "no term kit" end and, once accepted, its kit sourced to it', async () => {
    const m = await openMaster();
    let labels = new Labels(await m.engine.loadSnapshot());
    await unsurveyCopiedEnds(m, labels);
    // the master's pairs: every DMX-kit item and the kit(s) sourced to it
    const kitItems = labels.snap.punchItems.filter((p) => !p.deleted_at && p.type === 'Missing part' && !!p.notes?.includes(DMX_KITS_NOTE));
    expect(kitItems).toHaveLength(19);
    expect(kitItems.every((p) => p.type === 'Missing part' && p.owner === 'EC/ETC' && p.tracking_status === 'Open')).toBe(true);
    const kitItemIds = new Set(kitItems.map((p) => p.id));
    const kits = labels.snap.missingParts.filter((x) => !x.deleted_at && labels.snap.partSources.some((s) => s.missing_part_id === x.id && s.target_kind === 'punch' && kitItemIds.has(s.target_id)));
    expect(kits).toHaveLength(20); // 06M #12 has two kits (Level 09 and Level 04 runs)
    expect(kits.every((x) => /^DMX termination kit - .+ run$/.test(x.part ?? '') && x.qty === 1 && x.owner === 'EC' && x.part_status === 'Needed' && x.notes === 'Need to be ordered')).toBe(true);
    for (const pair of KIT_PAIRS) {
      expect(kitItemIds.has(labels.punch(pair.masterItem).id), pair.where).toBe(true);
      expect(kits.some((k) => k.id === labels.part(pair.masterPart).id), pair.where).toBe(true);
    }
    for (const [ref] of KIT_ITEMS_MASTER_ONLY) expect(kitItemIds.has(labels.punch(ref).id)).toBe(true);
    await m.editor.group(CTX, async (g) => {
      for (const k of kits) await g.delete('missing_part', k.id);
      for (const p of kitItems) await g.delete('punch_item', p.id);
    });

    // 1. the items come back, one per DMX end that is Issue "no term kit"
    const r1 = await m.engine.run();
    expect(r1.problems).toBe(0);
    const r3b = (await openProposals(m)).filter((p) => p.rule_id === 'R3b');
    expect(sorted(r3b.map((p) => `${labels.whereOf(p)}: ${p.payload?.item}`))).toEqual(sorted(KIT_PAIRS.map((k) => `${k.where}: ${k.item}`)));
    for (const p of r3b) {
      const pair = KIT_PAIRS.find((k) => k.where === labels.whereOf(p))!;
      const end = labels.end(pair.where);
      expect(p.payload, pair.where).toMatchObject({ type: 'Missing part', owner: 'EC/ETC', notes: DMX_KITS_NOTE, cable_end_id: end.id, level_id: end.level_id, device_id: pair.device ? labels.deviceByLabel.get(pair.device) : null });
      expect(p.subject).toMatchObject(pair.device ? { entity_kind: 'device', entity_id: labels.deviceByLabel.get(pair.device) } : { entity_kind: 'cable_end', entity_id: end.id });
    }
    // no kit from an item before it exists: R4b drafts only the master's Run items' kits (T119) — the
    // KNOWN_KITS, and 04 #3's (04/C-01, unpulled), whose kit 04 #2 went with its kit item 04 #4, at
    // both its ends
    const runKits = (await openProposals(m)).filter((p) => p.rule_id === 'R4b');
    expect(sorted(runKits.map((p) => labels.keyOf(p)))).toEqual(sorted([...KNOWN_KITS.map(kitKey), ...RUN_KITS_AFTER_REMOVAL.map(kitKey)]));
    for (const p of runKits) {
      const { where, far } = labels.kitWhere(p);
      const k = [...KNOWN_KITS, ...RUN_KITS_AFTER_REMOVAL].find((x) => x.where === where)!;
      expect(far, where).toBe(!!k.far);
      if (!far) expect((p.payload!.sources as { target_id: string }[])[0]!.target_id, where).toBe(labels.punch(k.run).id);
    }

    // 2. Accept every item → the kits, one per run, sourced to the item
    const itemIds = new Map<string, string>();
    for (const p of r3b) itemIds.set(labels.whereOf(p), (await m.engine.decide(p.id, { kind: 'accept' })).recordIds[0]!);
    await m.engine.run();
    const accepted = new Set(itemIds.values());
    const fromItem = (p: ProposalRow) => accepted.has((p.payload!.sources as { target_id: string }[])[0]!.target_id);
    const r4b = (await openProposals(m)).filter((p) => p.rule_id === 'R4b' && fromItem(p));
    const byItem = new Map(r4b.map((p) => [p.discriminator, p] as const));
    expect(r4b).toHaveLength(KIT_PAIRS.length);
    for (const pair of KIT_PAIRS) {
      const itemId = itemIds.get(pair.where)!;
      const p = byItem.get(itemId);
      expect(p, pair.where).toBeDefined();
      const end = labels.end(pair.where);
      expect(p!.payload, pair.where).toEqual({ part: pair.part, qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered', device_id: pair.device ? labels.deviceByLabel.get(pair.device) : null, level_id: end.level_id, sources: [{ target_kind: 'punch', target_id: itemId }], why: expect.any(String) });
      const item = (await m.store.get<PunchItemRow>('punch_item', itemId))!;
      expect(item).toMatchObject({ item: pair.item, type: 'Missing part', owner: 'EC/ETC', notes: DMX_KITS_NOTE, rule_id: 'R3b', tracking_status: 'Open' });
    }
    // 3. Accept the kits → parts with their links; afterwards the engine is quiet
    for (const p of r4b) await m.engine.decide(p.id, { kind: 'accept' });
    expect((await m.engine.run()).ops).toBe(0);
    labels = new Labels(await m.engine.loadSnapshot());
    const made = labels.snap.missingParts.filter((x) => !x.deleted_at && x.rule_id === 'R4b');
    expect(made).toHaveLength(KIT_PAIRS.length);
    for (const x of made) {
      const src = labels.snap.partSources.filter((s) => s.missing_part_id === x.id && !s.deleted_at);
      expect(src).toHaveLength(1);
      expect([...itemIds.values()]).toContain(src[0]!.target_id);
    }
    // what is left: the master's Run items' kits; 06M/C-13's kit now comes from its own kit item
    const left = (await openProposals(m)).filter((p) => p.rule_id === 'R3b' || p.rule_id === 'R4b');
    expect(sorted(left.map((p) => labels.keyOf(p)))).toEqual(sorted([...KNOWN_KITS.map(kitKey), ...RUN_KITS_AFTER_REMOVAL.filter((k) => k.where === '04/C-01').map(kitKey)]));
  });

  it('E5: an ERP-FT-LVD short of the BOM count offers the 0-10V end Issue "Not landed" and the panel "Land 0-10V control wiring", as the master holds them', async () => {
    const m = await openMaster();
    const labels = new Labels(await m.engine.loadSnapshot());
    const panels = LVD_SHORT.map((s) => ({ ...s, deviceId: labels.deviceByLabel.get(s.device)!, endId: labels.end(s.end).id, item: labels.punch(s.masterItem) }));
    for (const p of panels) {
      expect(p.item).toMatchObject({ device_id: p.deviceId, type: 'Termination', owner: 'EC', tracking_status: 'Open' });
      expect(labels.end(p.end).status).toBe('Issue');
    }
    // the master already holds E5's rows: the shortfall adds only the accessory findings
    await m.editor.group(CTX, async (g) => {
      for (const p of panels) await g.create('accessory', { device_id: p.deviceId, model: 'ERP-FT-LVD', expected_qty: p.expected, found_qty: p.found });
    });
    const r1 = await m.engine.run();
    expect((await openProposals(m)).filter((p) => p.rule_id === 'E5')).toEqual([]);
    expect((await ruleFindings(m)).map((f) => [f.lint_id, labels.deviceById.get(f.subject!.entity_id), f.message]).sort()).toEqual(
      panels.map((p) => ['Acc', p.device, `ERP-FT-LVD: found ${p.found} of ${p.expected}`]).sort(),
    );
    expect(r1.findings).toBe(3 + FAR_END_FINDINGS.length);
    // before the survey found them: the Land items gone and the 0-10V ends not yet Issue → E5 proposes both
    await m.editor.group(CTX, async (g) => {
      for (const p of panels) {
        await g.delete('punch_item', p.item.id);
        await g.setFields('cable_end', p.endId, { status: 'Installed, untested', note: null });
      }
    });
    await m.engine.run();
    const e5 = (await openProposals(m)).filter((p) => p.rule_id === 'E5');
    expect(e5).toHaveLength(6);
    for (const p of panels) {
      const status = e5.find((x) => x.kind === 'status' && x.subject?.entity_id === p.endId)!;
      expect(status.payload).toMatchObject({ now: 'Issue', extra: { note: 'Not landed', status_source: 'derived' } });
      const punch = e5.find((x) => x.kind === 'punch' && x.subject?.entity_id === p.deviceId)!;
      expect(punch.payload).toMatchObject({ item: 'Land 0-10V control wiring', type: 'Wiring', owner: 'EC', device_id: p.deviceId, cable_end_id: p.endId, level_id: labels.end(p.end).level_id });
      // the master's row: same text, device and owner; its Type is `Termination` (R3a's branch, D175 (3)) where E5 says `Wiring`
      expect(p.item.item).toBe('Land 0-10V control wiring');
    }
    // Accept all six → the ends read Issue "Not landed", the items exist, and R3a raises no second Land item
    for (const p of e5) await m.engine.decide(p.id, { kind: 'accept' });
    expect((await m.engine.run()).ops).toBe(0);
    for (const p of panels) {
      expect(await m.store.get<Row>('cable_end', p.endId)).toMatchObject({ status: 'Issue', note: 'Not landed', status_source: 'derived' });
      const items = await m.store.list<PunchItemRow>('punch_item', { where: `device_id = ? AND item = ? AND deleted_at IS NULL`, params: [p.deviceId, 'Land 0-10V control wiring'] });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ rule_id: 'E5', type: 'Wiring', owner: 'EC' });
    }
    expect((await openProposals(m)).filter((p) => p.rule_id === 'E5' || p.rule_id === 'R3a')).toHaveLength(KNOWN_DIFFERENCES.filter((d) => d.rule === 'R3a').length);
  });

  it('R4b on unpulled runs (T103, D213): accepted Run items get a kit at each device end — the master\'s kits, plus the far ends and the network / fiber runs', async () => {
    const m = await openMaster();
    let labels = new Labels(await m.engine.loadSnapshot());
    await unsurveyCopiedEnds(m, labels);
    // the master's rows as cited, each kit sourced to its Run item
    const runs = UNPULLED_MASTER.map((u) => ({ run: labels.punch(u.run), end: u.end, kits: u.kits.map((k) => labels.part(k)) }));
    for (const { run, end, kits } of runs) {
      expect(run, run.item!).toMatchObject({ type: 'Cable not run', cable_end_id: end ? labels.end(end).id : null });
      for (const k of kits) expect(labels.snap.partSources.some((s) => s.missing_part_id === k.id && s.target_kind === 'punch' && s.target_id === run.id), k.part!).toBe(true);
    }
    for (const k of UNPULLED_KITS) if (k.master) expect(runs.some((r) => r.kits.some((x) => x.id === labels.part(k.master!).id)), k.where).toBe(true);
    for (const [ref] of UNPULLED_MASTER_ONLY) labels.part(ref);
    expect(UNPULLED_KITS.filter((k) => k.master).length + UNPULLED_MASTER_ONLY.length).toBe(runs.flatMap((r) => r.kits).length);
    await m.editor.group(CTX, async (g) => {
      for (const { run, kits } of runs) {
        for (const k of kits) await g.delete('missing_part', k.id);
        await g.delete('punch_item', run.id);
      }
    });

    // 1. the Run items come back on their ends; before one is accepted, only the kit a master kit item still waits on,
    //    and the kits of the master's Run items left in place (KNOWN_KITS, T119)
    await m.engine.run();
    const r3a = (await openProposals(m)).filter((p) => p.rule_id === 'R3a' && p.payload?.type === 'Cable not run');
    const early = (await openProposals(m)).filter((p) => p.rule_id === 'R4b');
    const viaItem = UNPULLED_KITS.filter((k) => k.viaItem);
    expect(sorted(early.map((p) => labels.keyOf(p)))).toEqual(sorted([...viaItem.map(kitKey), ...KNOWN_KITS.map(kitKey)]));
    for (const k of viaItem) expect(early.some((p) => (p.payload?.sources as { target_id: string }[])[0]!.target_id === labels.punch(k.viaItem!).id), k.where).toBe(true);
    for (const p of early) await m.engine.decide(p.id, { kind: 'accept' });
    // 2. Accept the Run items → one kit per device end of each cable that takes kits; 04/C-01 already has its kit
    for (const p of r3a) await m.engine.decide(p.id, { kind: 'accept' });
    await m.engine.run();
    labels = new Labels(await m.engine.loadSnapshot());
    const r4b = (await openProposals(m)).filter((p) => p.rule_id === 'R4b');
    expect(sorted(r4b.map((p) => labels.keyOf(p)))).toEqual(sorted(UNPULLED_KITS.filter((k) => !k.viaItem).map(kitKey)));
    for (const p of r4b) {
      const { where, far } = labels.kitWhere(p);
      const k = UNPULLED_KITS.find((x) => x.where === where)!;
      const end = labels.end(where);
      expect(far, where).toBe(!!k.far);
      expect(p.payload, where).toMatchObject({ qty: 1, owner: 'EC', part_status: 'Needed', notes: 'Need to be ordered', device_id: labels.deviceByLabel.get(k.device), level_id: end.level_id });
      expect(end.device_id, where).toBe(labels.deviceByLabel.get(k.device));
    }
    // 3. Accept the kits → quiet; then the wire is pulled and waits on its kit: the kit item adds no second kit
    for (const p of r4b) await m.engine.decide(p.id, { kind: 'accept' });
    expect((await m.engine.run()).ops).toBe(0);
    const c09 = labels.end('01/C-09');
    const runItem = labels.snap.punchItems.find((x) => !x.deleted_at && x.cable_end_id === c09.id && x.type === 'Cable not run')!;
    await m.editor.group(CTX, async (g) => {
      await g.setFields('punch_item', runItem.id, { tracking_status: 'Closed', date_closed: '2026-10-15' });
      await g.setFields('cable_end', c09.id, { status: 'Issue', note: 'Run, not terminated; no term kit', status_source: 'surveyed', surveyed_at: NOW });
    });
    await m.engine.run();
    const kitItem = (await openProposals(m)).filter((p) => p.rule_id === 'R3b' && p.payload?.cable_end_id === c09.id);
    expect(kitItem.map((p) => p.payload?.item)).toEqual(['Terminate DMX to B3A Canyon']);
    await m.engine.decide(kitItem[0]!.id, { kind: 'accept' });
    await m.engine.run();
    expect((await openProposals(m)).filter((p) => p.rule_id === 'R4b')).toEqual([]);
  });
});

/**
 * The IDs with no Neuron ID in the numbering group of `levelId`: level order, then natural ID order
 * (D175 (4)); racks and NSPS need none (T68, D185 — the master import has no library types).
 */
function expectedNeuronNotes(snap: Snapshot, levelId: string): string | null {
  expect(snap.libraryTypes.filter((t) => !t.deleted_at)).toEqual([]);
  const level = snap.levels.find((l) => l.id === levelId)!;
  const levels = snap.levels.filter((l) => l.numbering_group_id === level.numbering_group_id && !l.deleted_at).sort(compareLevels);
  const ids = levels.flatMap((l) =>
    snap.devices
      .filter((d) => d.level_id === l.id && !d.deleted_at && !(d.neuron_id ?? '').trim() && !['Equipment rack', 'NSPS'].includes(d.category ?? ''))
      .map((d) => d.display_id ?? `${l.level}-?`)
      .sort(compareIds),
  );
  return ids.length ? ids.join(', ') : null;
}
