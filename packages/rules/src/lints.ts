/**
 * The lint view's checks (T36, Phase 3 §9, PLAN §6.3): every lint id the engine raises, grouped
 * under the check the view lists it by, in PLAN §6.3 order, then the other rule findings. Pure
 * data plus the "fix all via ruling" hand-off to T37 (`rulingSeeds`).
 */

import { DEVICE_CATEGORIES } from '@field-survey/core';

/** Device categories (the D196 eleven, CLAUDE.md §3); the project's `vocab(category)` may add more. */
export { DEVICE_CATEGORIES };

export interface LintCheck {
  /** Stable id for screens (`power_120v`). */
  id: string;
  /** The check as PLAN §6.3 names it. */
  title: string;
  /** Lint ids grouped under it. */
  lints: readonly string[];
  /** What to do about one, shown under the finding. */
  hint: string;
  /** Findings of this check can be fixed together by a ruling (T37). */
  ruling?: boolean;
}

export const LINT_CHECKS: readonly LintCheck[] = [
  { id: 'power_120v', title: 'NSPS/rack without 120V row', lints: ['lint.power_120v'], hint: 'Open the card and accept the R2d 120V draft, or add the row.' },
  { id: 'relay_cables', title: 'Relay panel without P or 0-10V row', lints: ['lint.relay_cables'], hint: 'Open the card and accept the R2c draft, or add the row.' },
  { id: 'issue_item', title: 'Issue device without open punch item', lints: ['R1.no_item'], hint: 'Add a punch item for what is wrong, or set the status the device really has.' },
  { id: 'item_owner', title: 'Punch item without Owner', lints: ['lint.item_owner'], hint: 'Give the item an Owner: EC, ETC or EC/ETC.' },
  { id: 'neuron_item', title: 'Neuron ID item missing or not last', lints: ['lint.neuron_item'], hint: 'Accept the R3c "Missing all Device Neuron IDs" draft; it is kept sorted last.' },
  { id: 'vocab', title: 'Value outside vocabulary', lints: ['lint.vocab', 'R3f'], hint: 'Change the value to the vocabulary\'s, or fix all of them with one ruling.', ruling: true },
  { id: 'far_end', title: 'Cable with missing far end', lints: ['lint.far_end'], hint: 'Open the end and pick the far end (a device or a placeholder).' },
  { id: 'end_status', title: 'Cable ends with incompatible statuses', lints: ['lint.end_status'], hint: 'A wire is run or not: survey both ends again and correct one.' },
  { id: 'riser', title: 'To does not match the riser', lints: ['R2b'], hint: 'The riser governs To: correct To, or keep the guess in the note.' },
  { id: 'neuron_dup', title: 'Duplicate Neuron ID', lints: ['lint.neuron_dup'], hint: 'One of the devices has the wrong Neuron ID: scan it again.' },
  { id: 'id_dup', title: 'Duplicate device ID', lints: ['lint.id_dup'], hint: 'Two live devices share an ID: delete the duplicate or correct the ID.' },
  { id: 'deleted_link', title: 'Linked to a deleted device', lints: ['lint.deleted_link'], hint: 'Link the record to the right device, or delete it.' },
  { id: 'pin_sheet', title: 'Pin outside the sheet', lints: ['lint.pin_sheet'], hint: 'Open the plan and move the pin onto the sheet.' },
  { id: 'locked_drafts', title: 'Level locked with unreviewed drafts', lints: ['lint.locked_drafts'], hint: 'Review the drafts in Setup, or unlock the level to do so.' },
  { id: 'accessory', title: 'Accessory found < expected', lints: ['Acc'], hint: 'Check the device; order the accessory as a missing part if it is not there.' },
  { id: 'accessory_group', title: 'Accessory group out of range', lints: ['lint.accessory_group'], hint: 'Count the group\'s accessories on the device again; order a missing one as a part, or correct a model counted twice.' },
  { id: 'status', title: 'Device status', lints: ['R1.untested', 'R1.complete'], hint: 'Outstanding wiring is Issue; nothing is Complete in this phase.' },
  { id: 'note_status', title: 'Note does not match status', lints: ['R2a'], hint: 'Correct the note or the status so they say the same thing.' },
  { id: 'test_item', title: 'Test or commissioning item', lints: ['R3d'], hint: 'This phase has no test or commissioning items: reword or delete it.' },
  { id: 'parts', title: 'Missing part problems', lints: ['R4a', 'R4d'], hint: 'Parts are the EC\'s; re-pulled wire and network kits are not parts.' },
];

const BY_LINT = new Map<string, LintCheck>(LINT_CHECKS.flatMap((c) => c.lints.map((l) => [l, c] as const)));

/** The check a lint id is listed under; unknown ids (another producer's, `import.*`) get one of their own. */
export function checkOf(lintId: string): LintCheck {
  const known = BY_LINT.get(lintId);
  if (known) return known;
  const prefix = lintId.split('.')[0] ?? lintId;
  if (prefix === 'import') return { id: 'import', title: 'Import', lints: [], hint: 'Raised by the workbook import; check the record against the master.' };
  return { id: `other:${lintId}`, title: lintId, lints: [lintId], hint: '' };
}

/** The order checks are listed in (catalogue order, then others by title). */
export function checkOrder(check: LintCheck): number {
  const i = LINT_CHECKS.findIndex((c) => c.id === check.id);
  return i >= 0 ? i : LINT_CHECKS.length;
}

/** One finding as the hand-off needs it. `value` is the record's current text when no fix is stored (R3f). */
export interface SeedInput {
  findingId: string;
  lintId: string;
  entityKind: string;
  entityId: string;
  levelId: string | null;
  fix: { field: string; from: string; to: string | null } | null;
  value?: string | null;
}

/**
 * What "Fix all via ruling" hands to the ruling editor (T37, PLAN §6.4): one seed per
 * (entity, field, from, to) — a rename when the vocabulary knows the canonical value, else a set
 * whose new value the ruling picks. Scope = the records and their levels.
 */
export interface RulingSeed {
  entity: string;
  field: string;
  action: 'rename' | 'set';
  from: string;
  to: string | null;
  recordIds: string[];
  levelIds: string[];
  findingIds: string[];
  /** Pre-filled ruling text: `Rename "ETC/EC" to "EC/ETC"`. */
  text: string;
}

export function rulingSeeds(findings: readonly SeedInput[]): RulingSeed[] {
  const out = new Map<string, RulingSeed>();
  for (const f of findings) {
    const fix = f.fix ?? (f.lintId === 'R3f' && f.value ? { field: 'item', from: f.value, to: null } : null);
    if (!fix) continue;
    const key = JSON.stringify([f.entityKind, fix.field, fix.from, fix.to]);
    let seed = out.get(key);
    if (!seed) {
      seed = {
        entity: f.entityKind,
        field: fix.field,
        action: fix.to != null ? 'rename' : 'set',
        from: fix.from,
        to: fix.to,
        recordIds: [],
        levelIds: [],
        findingIds: [],
        text: fix.to != null ? `Rename "${fix.from}" to "${fix.to}"` : `Replace "${fix.from}"`,
      };
      out.set(key, seed);
    }
    if (!seed.recordIds.includes(f.entityId)) seed.recordIds.push(f.entityId);
    if (f.levelId && !seed.levelIds.includes(f.levelId)) seed.levelIds.push(f.levelId);
    seed.findingIds.push(f.findingId);
  }
  return [...out.values()].sort((a, b) => b.recordIds.length - a.recordIds.length || a.from.localeCompare(b.from));
}
