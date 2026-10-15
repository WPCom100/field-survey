/**
 * The PLAN §6.3 lint checks the T34 rules do not already raise (T36). Findings only: they never
 * propose or write. The checks already covered elsewhere: Issue device without an open item
 * (`R1.no_item`), item text outside `vocab(punch_item)` (`R3f`), To ≠ riser (`R2b`), accessory
 * found < expected (`Acc`). "Ends with different code" cannot happen: a cable is one record with
 * one code (CLAUDE.md §8), so only incompatible statuses are checked.
 *
 * Every message names the facts the finding follows from and nothing volatile: a dismissed
 * finding reopens when its message changes (D178).
 */

import { DEVICE_CATEGORIES } from '../lints';
import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, DeviceRow, LevelRow, PunchItemRow } from '../snapshot';
import { governingCables } from './library';
import { isNeuronItem } from './r3';
import { SIGNAL, cableOf, compareIds, compareLevels, deviceLabel, endLabel, NEURON_ITEM, signalOf, str, subjectOfDevice, subjectOfEnd } from './shared';

function hasCode(ctx: RuleContext, d: DeviceRow, code: string): boolean {
  return (ctx.index.endsByDevice.get(d.id) ?? []).some((e) => cableOf(ctx, e)?.cable === code);
}

function punchLabel(p: PunchItemRow): string {
  return `Punch #${p.number ?? 'NEW'}${p.item ? ` "${p.item}"` : ''}`;
}

function levelNames(levels: readonly LevelRow[]): string {
  return levels.length === 1 ? `Level ${levels[0]!.level}` : `Levels ${levels.map((l) => l.level).join('/')}`;
}

// ------------------------------------------------------------------ library cables

export const LintPower: Rule = {
  id: 'lint.power_120v',
  title: 'NSPS/rack without 120V row',
  text: 'An NSPS or Equipment rack has a 120V row (PLAN §6.2, D52); one without is flagged. R2d offers the row as a draft.',
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      if (d.category !== 'NSPS' && d.category !== 'Equipment rack') continue;
      if (hasCode(ctx, d, '120V') || governingCables(ctx, d)) continue;
      ctx.find({ subject: subjectOfDevice(d), message: `${deviceLabel(ctx, d)}: ${d.category} without a 120V row` });
    }
  },
};

export const LintRelay: Rule = {
  id: 'lint.relay_cables',
  title: 'Relay panel without P or 0-10V row',
  text: 'A Relay panel has a P row and a 0-10V row (PLAN §6.2); a missing one is flagged. R2c offers it as a draft.',
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      if (d.category !== 'Relay panel' || governingCables(ctx, d)) continue;
      for (const code of ['P', '0-10V']) {
        if (!hasCode(ctx, d, code)) ctx.find({ subject: subjectOfDevice(d), discriminator: code, message: `${deviceLabel(ctx, d)}: Relay panel without a ${code} row` });
      }
    }
  },
};

// ------------------------------------------------------------------ punch items

export const LintOwner: Rule = {
  id: 'lint.item_owner',
  title: 'Punch item without Owner',
  text: 'Every punch item has an Owner (`EC`, `ETC` or `EC/ETC`); one without is flagged.',
  run(ctx) {
    for (const p of ctx.index.punchItem.values()) {
      if (p.owner) continue;
      ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `${punchLabel(p)}: no Owner` });
    }
  },
};

export const LintNeuronItem: Rule = {
  id: 'lint.neuron_item',
  title: 'Neuron ID item missing or not last',
  text: 'A numbering group with a device still missing its Neuron ID has a "Missing all Device Neuron IDs" item sorted last (R3c, D49); a group without one, or an item not sorted last, is flagged.',
  run(ctx) {
    for (const [groupId, group] of ctx.index.levelsByGroup) {
      const levels = group.slice().sort(compareLevels);
      const first = levels[0];
      if (!first) continue;
      const items = levels.flatMap((l) => ctx.index.punchByLevel.get(l.id) ?? []).filter(isNeuronItem);
      for (const p of items) {
        if (!p.sort_last) ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `${levelNames(levels)}: "${NEURON_ITEM}" is not sorted last` });
      }
      if (items.length) continue;
      const missing = levels.some((l) => (ctx.index.devicesByLevel.get(l.id) ?? []).some((d) => !str(d.neuron_id)));
      if (missing) {
        ctx.find({ subject: { entity_kind: 'numbering_group', entity_id: groupId, level_id: first.id }, message: `${levelNames(levels)}: no "${NEURON_ITEM}" item` });
      }
    }
  },
};

// ------------------------------------------------------------------ vocabulary

/** Which record field each editable vocabulary list governs; `phrases` = "; "-separated chips. */
export const VOCAB_FIELDS: readonly { list: string; entity: 'device' | 'punch_item' | 'missing_part' | 'cable_end'; field: string; label: string; phrases?: boolean }[] = [
  { list: 'punch_item', entity: 'punch_item', field: 'item', label: 'Item' },
  { list: 'punch_note', entity: 'punch_item', field: 'notes', label: 'Notes', phrases: true },
  { list: 'part_note', entity: 'missing_part', field: 'notes', label: 'Notes', phrases: true },
  { list: 'device_note', entity: 'device', field: 'notes', label: 'Notes', phrases: true },
  { list: 'connection_note', entity: 'cable_end', field: 'note', label: 'Note', phrases: true },
  { list: 'type', entity: 'device', field: 'type', label: 'Type' },
  { list: 'category', entity: 'device', field: 'category', label: 'Category' },
];

function phrases(value: string, split: boolean): string[] {
  return split ? value.split(/;\s*/).map((s) => s.trim()).filter(Boolean) : [value.trim()];
}

export const LintVocab: Rule = {
  id: 'lint.vocab',
  title: 'Value outside vocabulary',
  text: 'Values come from the project vocabulary: an old spelling a rename recorded (`vocab.canonical_of`) is flagged with its canonical value, a device category outside the category list and a cable code outside the master\'s codes are flagged. Status, type and owner are fixed lists the pickers enforce; item text is R3f.',
  run(ctx) {
    const vocab = ctx.snap.vocab.filter((v) => v.deleted_at == null);
    const byId = new Map(vocab.map((v) => [v.id, v] as const));
    const seen = new Set<string>();
    const recordsOf = (entity: (typeof VOCAB_FIELDS)[number]['entity']): { id: string; level_id: string | null; row: Record<string, unknown>; name: string }[] => {
      switch (entity) {
        case 'device':
          return [...ctx.index.device.values()].map((d) => ({ id: d.id, level_id: d.level_id, row: d as unknown as Record<string, unknown>, name: deviceLabel(ctx, d) }));
        case 'punch_item':
          return [...ctx.index.punchItem.values()].map((p) => ({ id: p.id, level_id: p.level_id, row: p as unknown as Record<string, unknown>, name: punchLabel(p) }));
        case 'missing_part':
          return [...ctx.index.missingPart.values()].map((m) => ({ id: m.id, level_id: m.level_id, row: m as unknown as Record<string, unknown>, name: `Part #${m.number ?? 'NEW'}` }));
        case 'cable_end':
          return [...ctx.index.cableEnd.values()].map((e) => ({ id: e.id, level_id: subjectOfEnd(ctx, e).level_id ?? null, row: e as unknown as Record<string, unknown>, name: endLabel(ctx, e) }));
      }
    };
    // Old spellings (a variant row points at its canonical value).
    for (const spec of VOCAB_FIELDS) {
      const variants = new Map<string, string>();
      for (const v of vocab) {
        if (v.list !== spec.list || !v.canonical_of_id) continue;
        const canonical = byId.get(v.canonical_of_id);
        if (canonical && canonical.value !== v.value) variants.set(v.value, canonical.value);
      }
      if (!variants.size) continue;
      for (const r of recordsOf(spec.entity)) {
        const value = str(r.row[spec.field]);
        if (!value) continue;
        for (const part of phrases(value, !!spec.phrases)) {
          const to = variants.get(part);
          if (to === undefined) continue;
          seen.add(`${r.id}|${spec.field}`);
          ctx.find({
            subject: { entity_kind: spec.entity, entity_id: r.id, level_id: r.level_id },
            discriminator: `${spec.field}=${part}`,
            fix: { field: spec.field, from: part, to },
            message: `${r.name}: ${spec.label} "${part}" is an old spelling of "${to}"`,
          });
        }
      }
    }
    // Device category outside the list (CLAUDE.md §3 plus the project's own `category` entries).
    const categories = new Set<string>([...DEVICE_CATEGORIES, ...vocab.filter((v) => v.list === 'category' && !v.canonical_of_id).map((v) => v.value)]);
    for (const d of ctx.index.device.values()) {
      const c = str(d.category);
      if (!c || categories.has(c) || seen.has(`${d.id}|category`)) continue;
      ctx.find({
        subject: subjectOfDevice(d),
        discriminator: `category=${c}`,
        fix: { field: 'category', from: c, to: null },
        message: `${deviceLabel(ctx, d)}: Category "${c}" is not in the vocabulary`,
      });
    }
    // Cable code outside the master's codes.
    for (const cable of ctx.index.cable.values()) {
      const code = str(cable.cable);
      if (code && SIGNAL[code]) continue;
      const ends = (ctx.index.endsByCable.get(cable.id) ?? []).slice().sort((a, b) => a.side.localeCompare(b.side));
      const end = ends[0];
      const where = end ? `${endLabel(ctx, end)}: ` : '';
      ctx.find({
        subject: { entity_kind: 'cable', entity_id: cable.id, level_id: end ? (subjectOfEnd(ctx, end).level_id ?? null) : null },
        discriminator: `cable=${code ?? ''}`,
        ...(code ? { fix: { field: 'cable', from: code, to: null } } : {}),
        message: code ? `${where}Cable code "${code}" is not in the vocabulary` : `${where}Cable has no code`,
      });
    }
  },
};

// ------------------------------------------------------------------ cables

function hasEndpoint(e: CableEndRow): boolean {
  return !!(e.device_id || e.placeholder_id);
}

export const LintFarEnd: Rule = {
  id: 'lint.far_end',
  title: 'Cable with missing far end',
  text: 'A cable has two ends, each a device or a placeholder (D26); a cable with one end, or an end naming neither, is flagged on the end that has one.',
  run(ctx) {
    for (const cable of ctx.index.cable.values()) {
      const ends = (ctx.index.endsByCable.get(cable.id) ?? []).slice().sort((a, b) => a.side.localeCompare(b.side));
      if (!ends.length) continue;
      const anchored = ends.find(hasEndpoint) ?? ends[0]!;
      const signal = signalOf(cable.cable);
      if (ends.length < 2) {
        ctx.find({ subject: subjectOfEnd(ctx, anchored), message: `${endLabel(ctx, anchored)}: ${signal} cable has no far end` });
        continue;
      }
      const missing = ends.filter((e) => !hasEndpoint(e));
      if (!missing.length) continue;
      const text = missing.length === 2 ? 'neither end names a device or placeholder' : `the far end${str(missing[0]!.from_text) ? ` "${str(missing[0]!.from_text)}"` : ''} names no device or placeholder`;
      ctx.find({ subject: subjectOfEnd(ctx, anchored), message: `${endLabel(ctx, anchored)}: ${signal} cable, ${text}` });
    }
  },
};

const RUN_STATUSES: readonly (string | null)[] = ['Complete', 'Installed, untested'];

export const LintEndStatus: Rule = {
  id: 'lint.end_status',
  title: 'Cable ends with incompatible statuses',
  text: 'A wire is either run or not: one end `Not installed` while the other is `Complete` or `Installed, untested` is flagged on the `Not installed` end.',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      if (e.status !== 'Not installed') continue;
      const other = ctx.index.otherEnd(e);
      if (!other || !RUN_STATUSES.includes(other.status)) continue;
      ctx.find({ subject: subjectOfEnd(ctx, e), message: `${endLabel(ctx, e)}: Not installed here, ${other.status} at the other end (${endLabel(ctx, other)})` });
    }
  },
};

// ------------------------------------------------------------------ duplicates

function duplicates(ctx: RuleContext, key: (d: DeviceRow) => string | null): Map<string, DeviceRow[]> {
  const out = new Map<string, DeviceRow[]>();
  for (const d of ctx.index.device.values()) {
    const k = key(d);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(d);
    else out.set(k, [d]);
  }
  for (const [k, list] of out) if (list.length < 2) out.delete(k);
  return out;
}

function others(ctx: RuleContext, list: readonly DeviceRow[], d: DeviceRow): string {
  return list
    .filter((x) => x.id !== d.id)
    .map((x) => deviceLabel(ctx, x))
    .sort(compareIds)
    .join(', ');
}

export const LintNeuronDup: Rule = {
  id: 'lint.neuron_dup',
  title: 'Duplicate Neuron ID',
  text: 'A Neuron ID belongs to one device; the same ID on several devices of the project is flagged on each.',
  run(ctx) {
    for (const list of duplicates(ctx, (d) => str(d.neuron_id)?.toUpperCase() ?? null).values()) {
      for (const d of list) ctx.find({ subject: subjectOfDevice(d), message: `${deviceLabel(ctx, d)}: Neuron ID ${str(d.neuron_id)} is also on ${others(ctx, list, d)}` });
    }
  },
};

export const LintIdDup: Rule = {
  id: 'lint.id_dup',
  title: 'Duplicate device ID',
  text: 'Device IDs are unique per project (D25, D88); the same ID on several live devices is flagged on each.',
  run(ctx) {
    for (const list of duplicates(ctx, (d) => str(d.display_id)).values()) {
      for (const d of list) ctx.find({ subject: subjectOfDevice(d), message: `${deviceLabel(ctx, d)}: ID also used by ${list.length - 1} other device${list.length === 2 ? '' : 's'}` });
    }
  },
};

// ------------------------------------------------------------------ links, pins, locks

export const LintDeletedLink: Rule = {
  id: 'lint.deleted_link',
  title: 'Linked to a deleted device',
  text: 'A punch item, missing part, connection end or photo that still points at a deleted device is flagged: relink it or delete it.',
  run(ctx) {
    const deleted = new Map(ctx.snap.devices.filter((d) => d.deleted_at != null).map((d) => [d.id, d] as const));
    if (!deleted.size) return;
    const gone = (id: string | null) => (id ? deleted.get(id) : undefined);
    const label = (d: DeviceRow) => deviceLabel(ctx, d);
    for (const p of ctx.index.punchItem.values()) {
      const d = gone(p.device_id);
      if (d) ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `${punchLabel(p)}: linked to deleted device ${label(d)}` });
    }
    for (const m of ctx.index.missingPart.values()) {
      const d = gone(m.device_id);
      if (d) ctx.find({ subject: { entity_kind: 'missing_part', entity_id: m.id, level_id: m.level_id }, message: `Part #${m.number ?? 'NEW'}${m.part ? ` "${m.part}"` : ''}: linked to deleted device ${label(d)}` });
    }
    for (const e of ctx.index.cableEnd.values()) {
      const d = gone(e.device_id);
      if (d) ctx.find({ subject: subjectOfEnd(ctx, e), message: `${e.display_id ?? `${signalOf(cableOf(ctx, e)?.cable)} end`}: endpoint is deleted device ${label(d)}` });
    }
    for (const ph of ctx.snap.photos ?? []) {
      if (ph.deleted_at != null) continue;
      const d = gone(ph.device_id);
      if (d) ctx.find({ subject: { entity_kind: 'photo', entity_id: ph.id, level_id: ph.level_id }, message: `Photo #${ph.number ?? 'NEW'}: linked to deleted device ${label(d)}` });
    }
  },
};

export const LintPin: Rule = {
  id: 'lint.pin_sheet',
  title: 'Pin outside the sheet',
  text: 'A pin lies on its sheet (sheet coordinates, PDF points from the CropBox top-left); one outside the sheet, or on a deleted sheet, is flagged.',
  run(ctx) {
    const deletedSheets = new Set((ctx.snap.sheets ?? []).filter((s) => s.deleted_at != null).map((s) => s.id));
    for (const d of ctx.index.device.values()) {
      const pin = d.pin;
      if (!pin || typeof pin.x !== 'number' || typeof pin.y !== 'number' || !pin.sheet) continue;
      if (deletedSheets.has(pin.sheet) && !ctx.index.sheet.has(pin.sheet)) {
        ctx.find({ subject: subjectOfDevice(d), message: `${deviceLabel(ctx, d)}: pin is on a deleted sheet` });
        continue;
      }
      const sheet = ctx.index.sheet.get(pin.sheet);
      if (!sheet || sheet.width_pt == null || sheet.height_pt == null) continue;
      if (pin.x < 0 || pin.y < 0 || pin.x > sheet.width_pt || pin.y > sheet.height_pt) {
        ctx.find({ subject: subjectOfDevice(d), message: `${deviceLabel(ctx, d)}: pin outside the sheet` });
      }
    }
  },
};

export const LintLockedDrafts: Rule = {
  id: 'lint.locked_drafts',
  title: 'Level locked with unreviewed drafts',
  text: 'A level\'s baseline is locked once its drafts are reviewed (PLAN §5 Setup); a locked level that still has unreviewed device or cable drafts is flagged.',
  run(ctx) {
    const byLevel = new Map<string, number>();
    for (const dr of ctx.snap.drafts ?? []) {
      if (dr.deleted_at != null || dr.state !== 'proposed' || !dr.level_id) continue;
      byLevel.set(dr.level_id, (byLevel.get(dr.level_id) ?? 0) + 1);
    }
    for (const level of ctx.index.level.values()) {
      if (level.state !== 'baseline_locked') continue;
      const n = byLevel.get(level.id) ?? 0;
      if (n) ctx.find({ subject: { entity_kind: 'level', entity_id: level.id, level_id: level.id }, message: `Level ${level.level} is locked with ${n} unreviewed draft${n === 1 ? '' : 's'}` });
    }
  },
};

export const LINT_RULES: readonly Rule[] = [
  LintPower,
  LintRelay,
  LintOwner,
  LintNeuronItem,
  LintVocab,
  LintFarEnd,
  LintEndStatus,
  LintNeuronDup,
  LintIdDup,
  LintDeletedLink,
  LintPin,
  LintLockedDrafts,
];
