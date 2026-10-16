/**
 * Seed data for a project's vocabulary and placeholder lists (T40; CLAUDE.md §3, PLAN §7.5).
 * Exact strings from the master workbook. No React or Expo imports.
 */

import { vocab } from '@field-survey/core';

import { STANDARD_PHRASES } from '../card/model';
import { CONNECTION_PHRASES } from '../ends/model';

/** The editable picker lists, in the order the editor shows them. */
export const VOCAB_LISTS = [
  { list: 'device_note', title: 'Device notes', hint: "Chips under a device's Notes." },
  { list: 'connection_note', title: 'Connection notes', hint: "Chips under a connection end's Note." },
  { list: 'punch_item', title: 'Punch items', hint: 'Phrases for the Item field of a punch item.' },
  { list: 'punch_note', title: 'Punch notes', hint: 'Phrases for the Notes of a punch item.' },
  { list: 'part_note', title: 'Part notes', hint: 'Phrases for the Notes of a missing part.' },
  { list: 'photo_caption', title: 'Photo captions', hint: 'Chips on the photo caption.' },
  { list: 'category', title: 'Device categories', hint: 'Device Category picker; a pin shape follows the category (D64).' },
  { list: 'cable_code', title: 'Cable codes', hint: 'The codes a cable can carry (CLAUDE.md §3). A DaVinci port protocol with no code arrives here as a draft (T111); accepting it records a decision, it does not make a code yet.' },
] as const satisfies readonly { list: (typeof vocab.VOCAB_LIST)[number]; title: string; hint: string }[];

export type VocabListKey = (typeof VOCAB_LISTS)[number]['list'];

export const SEED_VOCAB: Readonly<Record<VocabListKey, readonly string[]>> = {
  device_note: STANDARD_PHRASES,
  connection_note: CONNECTION_PHRASES,
  punch_item: ['Missing all Device Neuron IDs'],
  punch_note: ['Waiting on DMX Termination Kits', 'Need to be ordered', 'Confirm whether on site'],
  part_note: ['Need to be ordered', 'Confirm whether on site', 'Confirm whether on site (provided in box)'],
  photo_caption: STANDARD_PHRASES,
  category: ['Relay panel', 'Foundry panel', 'EBDK', 'Equipment rack', 'NSPS', 'Touchscreen', 'Station', 'Sensor'],
  cable_code: ['X', 'N', 'NG', 'U', 'F', 'P', 'UV', '0-10V', '120V'],
};

export type PlaceholderKind = (typeof vocab.PLACEHOLDER_KIND)[number];

export const PLACEHOLDER_KIND_LABEL: Readonly<Record<PlaceholderKind, string>> = {
  fixtures: 'Fixtures',
  power: 'Power',
  station_bus: 'Station / sensor bus',
  level_not_in_scope: 'Level not in scope',
  external: 'External',
  fixture_run: 'Fixture run',
  spare: 'Spare',
  unknown: 'Unknown',
  custom: 'Custom',
};

/** PLAN §7.5 seed placeholders. */
export const SEED_PLACEHOLDERS: readonly { label: string; kind: PlaceholderKind }[] = [
  { label: 'Fixtures', kind: 'fixtures' },
  { label: '120v Power', kind: 'power' },
  { label: 'Stations & Sensors', kind: 'station_bus' },
  { label: 'Level 09', kind: 'level_not_in_scope' },
  { label: 'Level 10', kind: 'level_not_in_scope' },
  { label: 'Level 11', kind: 'level_not_in_scope' },
  { label: 'Level 12', kind: 'level_not_in_scope' },
  { label: 'Walter Tower ETC P-CCS', kind: 'external' },
  { label: 'B3A Canyon', kind: 'fixture_run' },
  { label: 'C13A Oculus', kind: 'fixture_run' },
  { label: 'D1 ED Column Capital', kind: 'fixture_run' },
  { label: 'B3B Elev Core C fixture', kind: 'fixture_run' },
  { label: 'B7 Stair A fixture', kind: 'fixture_run' },
  { label: 'Spare DMX out', kind: 'spare' },
  { label: 'Missing DMX run (one per UFMP4)', kind: 'unknown' },
];
