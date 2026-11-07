/**
 * R3 — punch items (PLAN §6.1, CLAUDE.md §4 R3).
 *
 * - R3a: one "Run <signal> to <far end>" item per unpulled wire (`Cable not run`, `EC`), on the
 *   surveyed end only (E3), gated by R5; once the wire is run (`Issue`, "not terminated") the
 *   item to raise is a `Termination` one.
 * - R3b: an end `Issue` "no term kit" on a cable that takes termination kits (`R4b.kit` per code,
 *   or the cable's own `term_kit`; T103, D213) gets its own device-level item `Terminate <signal>
 *   to <far end>`, `Missing part`, `EC/ETC`, Notes "Waiting on DMX Termination Kits" (as the
 *   master's rows read; D175) — "Waiting on Fiber / Network Termination Kits" for those codes.
 * - R3c: every floor ends with one `sort_last` `Information` item per address kind (T146, D245,
 *   D246; per floor since T169, D258): "Missing all Device Neuron IDs" (`EC`), "Missing all Device
 *   IP addresses" (`ETC`), "Missing all Device DMX addresses" (`EC`) with Notes "All devices on this
 *   floor" when no device has the address yet; "Missing some …", Device "See notes", Notes = the
 *   floor's device IDs still missing, when some have it. Only devices that need that address
 *   count, by the wires they get (`addressNeeds`: a U run →
 *   Neuron ID, N / NG → IP address, X → DMX address; the type's flag overrides); once accepted the
 *   engine maintains each: Notes and the all / some wording rewritten, Closed when the list is
 *   empty, reopened on a new device without one (D49, D170).
 * - R3a / R3b skip an end that already holds an open item of their kind (`Cable not run`,
 *   `Termination`, a kit item), whatever its wording — the master's items, imported onto their
 *   ends (T119, D218).
 * - R3d: an item that says "test" or "commission" is flagged (no test or commissioning items).
 * - R3f: an item outside the project's `punch_item` vocabulary is flagged (dismissable).
 *
 * Owners, item texts, notes and the end that holds a Run item are rule parameters (T102,
 * `../params.ts`); the texts above are their defaults.
 */

import { DEFAULT_PARAMS, fillTemplate, ownerParam, textParam } from '../params';
import type { Rule, RuleContext } from '../rule';
import type { CableEndRow, LevelRow, PunchItemRow, Subject } from '../snapshot';
import {
  cableOf,
  compareIds,
  compareLevels,
  deviceLabel,
  endLabel,
  endLevel,
  hasOpenEndItem,
  hasOpenItemText,
  isKitItem,
  isOpen,
  kitNote,
  noteHas,
  signal,
  str,
  subjectOfEnd,
  takesKits,
  targetOf,
  terminationItem,
  waitsForSurvey,
} from './shared';
import { ADDRESS_ARTICLE, ADDRESS_FIELD, ADDRESS_KINDS, ADDRESS_LABEL, deviceAddressNeeds, type AddressKind } from './library';

// ------------------------------------------------------------------ R3a

export const R3a: Rule = {
  id: 'R3a',
  title: 'Cable not run',
  text: 'One "Run <signal> to <far end>" item per unpulled wire (`Cable not run`, `EC`), on the surveyed end only — when both ends are surveyed, on the start of the run (side A, D177); once the wire is run but not terminated, a `Termination` item instead. Far-end items wait for that floor\'s survey (R5).',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      const code = cableOf(ctx, e)?.cable ?? null;
      if (!code) continue;
      const level = endLevel(ctx, e);
      if (!level) continue;
      if (e.status === 'Not installed') {
        if (waitsForSurvey(ctx, e) || !carriesRunItem(ctx, e)) continue;
        const item = fillTemplate(textParam(ctx.params, 'R3a', 'run.item', code), { signal: signal(ctx, code), 'far end': targetOf(ctx, e) });
        if (hasOpenItemText(ctx, e.device_id, e.id, item) || otherEndHasRunItem(ctx, e) || hasOpenEndItem(ctx, e.id, (p) => p.type === 'Cable not run')) continue;
        const owner = ownerParam(ctx.params, 'R3a', 'run.owner', code);
        ctx.propose({
          subject: subjectOfEnd(ctx, e),
          kind: 'punch',
          payload: { item, type: 'Cable not run', owner, device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
          inputs: { status: e.status, item },
          params: [['R3a', 'run.item', code], ['R3a', 'run.owner', code], ['R3', 'signal', code]],
          why: `${endLabel(ctx, e)}${e.to_text ? ` (${e.to_text})` : ''} is Not installed: the wire has not been pulled.`,
        });
      } else if (e.status === 'Issue') {
        if (waitsForSurvey(ctx, e)) continue;
        const term = terminationItem(ctx, e);
        if (!term || hasOpenItemText(ctx, e.device_id, e.id, term.item) || hasOpenEndItem(ctx, e.id, (p) => p.type === 'Termination')) continue;
        ctx.propose({
          subject: subjectOfEnd(ctx, e),
          discriminator: 'terminate',
          kind: 'punch',
          payload: { item: term.item, type: 'Termination', owner: term.owner, device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
          inputs: { status: e.status, item: term.item },
          params: term.params,
          why: `${endLabel(ctx, e)} is Issue "${e.note}": the wire is run and waits for its termination.`,
        });
      }
    }
  },
};

/**
 * One "Run …" item per wire (R3): when both ends are surveyed `Not installed`, the item goes on
 * the **start of the run** — side A, the lower floor in the master, the riser's origin once the
 * riser is imported (D177, Landry: "the start of the run holds the item"; the `R3a.run.end`
 * parameter can name side B instead). An end whose other end is unsurveyed, or waits for its
 * floor's survey (R5), carries it alone.
 */
function carriesRunItem(ctx: RuleContext, e: CableEndRow): boolean {
  const other = ctx.index.otherEnd(e);
  if (!other || other.status !== 'Not installed' || waitsForSurvey(ctx, other)) return true;
  return e.side === ctx.param('R3a', 'run.end');
}

/** A Run item the rule made on the other end (accepted before this end was surveyed) stands for the wire. */
function otherEndHasRunItem(ctx: RuleContext, e: CableEndRow): boolean {
  const other = ctx.index.otherEnd(e);
  if (!other) return false;
  return (ctx.index.punchByEnd.get(other.id) ?? []).some((p) => isOpen(p) && p.rule_id === 'R3a' && p.type === 'Cable not run');
}

// ------------------------------------------------------------------ R3b

export const R3b: Rule = {
  id: 'R3b',
  title: 'Termination kit item',
  text: 'An end that is Issue "no term kit" on a cable that takes termination kits (X, F, N and NG by default; a cable\'s own setting overrides its code — D213) gets its own device-level item: `Terminate <signal> to <far end>`, `Missing part`, `EC/ETC`, Notes "Waiting on DMX Termination Kits" (Fiber / Network for those codes). Waits for that floor\'s survey (R5).',
  run(ctx) {
    for (const e of ctx.index.cableEnd.values()) {
      if (e.status !== 'Issue' || !noteHas(e.note, /no term kit/i)) continue;
      const cable = cableOf(ctx, e);
      const code = cable?.cable ?? null;
      if (!code || !takesKits(ctx, cable)) continue;
      if (waitsForSurvey(ctx, e)) continue;
      const level = endLevel(ctx, e);
      if (!level) continue;
      const item = fillTemplate(textParam(ctx.params, 'R3b', 'item'), { signal: signal(ctx, code), 'far end': targetOf(ctx, e) });
      if (hasOpenItemText(ctx, e.device_id, e.id, item) || hasOpenEndItem(ctx, e.id, (p) => isKitItem(ctx, p))) continue;
      const device = e.device_id ? ctx.index.device.get(e.device_id) : null;
      const owner = ownerParam(ctx.params, 'R3b', 'owner');
      const notes = kitNote(ctx, code);
      ctx.propose({
        subject: device ? { entity_kind: 'device', entity_id: device.id, level_id: device.level_id } : subjectOfEnd(ctx, e),
        discriminator: e.id,
        kind: 'punch',
        payload: { item, type: 'Missing part', owner, notes, device_id: e.device_id, cable_end_id: e.id, level_id: level.id },
        inputs: { status: e.status, item },
        params: [['R3b', 'item'], ['R3b', 'owner'], ['R3b', 'notes', code], ['R3', 'signal', code], ['R4b', 'kit', code]],
        why: `${endLabel(ctx, e)} is Issue "${e.note}": the ${signal(ctx, code)} run waits for a termination kit.`,
      });
    }
  },
};

// ------------------------------------------------------------------ R3c

/**
 * The parameters each address kind's item is worded from (`R3c.<key>`); the Neuron keys are T34's.
 * `item` is the "all" wording (no device on the floor has the address yet), `some` the wording of a
 * floor where some have it (T169, D258).
 */
const ITEM_KEY: Readonly<Record<AddressKind, { item: string; some: string; owner: string }>> = {
  neuron: { item: 'item', some: 'some.item', owner: 'owner' },
  ip: { item: 'ip.item', some: 'ip.some.item', owner: 'ip.owner' },
  dmx: { item: 'dmx.item', some: 'dmx.some.item', owner: 'dmx.owner' },
};

/** The proposal discriminator per kind: none for the Neuron item (T34's key, so no accepted or rejected draft moves on upgrade). */
const DISCRIMINATOR: Readonly<Record<AddressKind, string | null>> = { neuron: null, ip: 'ip', dmx: 'dmx' };

/** The project's "all" item text for a kind (`R3c.item`, `R3c.ip.item`, `R3c.dmx.item`). */
export function addressItemText(ctx: RuleContext, kind: AddressKind): string {
  return textParam(ctx.params, 'R3c', ITEM_KEY[kind].item);
}

/**
 * Every wording an item of `kind` is recognised by, and the engine may reword between: the
 * project's "all" and "some" texts and the built-in ones (the master's Neuron rows; an item
 * accepted before the project changed its wording).
 */
export function addressWordings(params: RuleContext['params'], kind: AddressKind): string[] {
  const keys = ITEM_KEY[kind];
  return [...new Set([keys.item, keys.some].flatMap((k) => [textParam(params, 'R3c', k), textParam(DEFAULT_PARAMS, 'R3c', k)]))];
}

/** The Device texts the engine may reword between ("All devices" / "See notes", the project's and the built-in). */
function addressDeviceTexts(params: RuleContext['params']): string[] {
  return ['device_text', 'some.device_text'].flatMap((k) => [textParam(params, 'R3c', k), textParam(DEFAULT_PARAMS, 'R3c', k)]);
}

/**
 * The Notes phrase of an item worded "all" (`R3c.all.notes`, and the built-in one): no device list,
 * so a screen that links the devices an item's Notes name lists none (T169).
 */
export function isAllNotes(params: RuleContext['params'], notes: string | null | undefined): boolean {
  const n = notes?.trim();
  return !!n && (n === textParam(params, 'R3c', 'all.notes') || n === textParam(DEFAULT_PARAMS, 'R3c', 'all.notes'));
}

/** The kind an R3c proposal is for, from its discriminator. */
export function addressKindOf(discriminator: string | null | undefined): AddressKind {
  return discriminator === 'ip' || discriminator === 'dmx' ? discriminator : 'neuron';
}

/**
 * R3c's item of one kind: made by the rule (its proposal's discriminator says which kind; an R3c
 * item with no proposal is the Neuron one, as before T146), or an item carrying one of the kind's
 * wordings (`addressWordings`).
 */
export function isAddressItem(ctx: RuleContext, kind: AddressKind, p: PunchItemRow): boolean {
  return addressItemKind(ctx.params, p, p.proposal_id ? (ctx.index.proposal.get(p.proposal_id) ?? null) : null) === kind;
}

/**
 * Which kind of R3c item a punch item is, or null: `isAddressItem` without a rule context, for
 * screens that read one item (the punch item editor, T162). `proposal` is the item's proposal row.
 */
export function addressItemKind(
  params: RuleContext['params'],
  p: { item: string | null; rule_id: string | null },
  proposal: { rule_id: string; discriminator: string | null } | null,
): AddressKind | null {
  if (proposal?.rule_id === 'R3c') return addressKindOf(proposal.discriminator);
  const item = p.item;
  const text = item != null ? ADDRESS_KINDS.find((k) => addressWordings(params, k).includes(item)) : undefined;
  if (text) return text;
  // an R3c item whose proposal is gone and whose text matches no kind: the Neuron item under another wording
  return p.rule_id === 'R3c' ? 'neuron' : null;
}

/** The R3c items of one kind among the given levels, the rule's own first, then `sort_last`, then by number. */
export function addressItems(ctx: RuleContext, kind: AddressKind, levels: readonly LevelRow[]): PunchItemRow[] {
  return levels
    .flatMap((l) => ctx.index.punchByLevel.get(l.id) ?? [])
    .filter((p) => isAddressItem(ctx, kind, p))
    .sort((a, b) => Number(b.rule_id === 'R3c') - Number(a.rule_id === 'R3c') || Number(b.sort_last) - Number(a.sort_last) || (a.number ?? 0) - (b.number ?? 0));
}

/** One floor and an address kind: how many of its devices need the address, and the labels of those still missing it (natural ID order). */
export interface FloorAddresses {
  needing: number;
  missing: string[];
}

export function floorAddresses(ctx: RuleContext, kind: AddressKind, level: LevelRow): FloorAddresses {
  const field = ADDRESS_FIELD[kind];
  const needing = (ctx.index.devicesByLevel.get(level.id) ?? []).filter((d) => deviceAddressNeeds(ctx, d)[kind]);
  const missing = needing
    .filter((d) => !str(d[field]))
    .sort((a, b) => compareIds(a.display_id ?? `${level.level}-?`, b.display_id ?? `${level.level}-?`))
    .map((d) => deviceLabel(ctx, d));
  return { needing: needing.length, missing };
}

/** What an open address item on a floor reads (T169): "all" with the Notes phrase when none has the address, else "some" with the list. */
interface AddressWording {
  some: boolean;
  item: string;
  device_text: string;
  notes: string;
  params: [string, string][];
}

function addressWording(ctx: RuleContext, kind: AddressKind, f: FloorAddresses): AddressWording | null {
  if (!f.missing.length) return null;
  const keys = ITEM_KEY[kind];
  if (f.missing.length >= f.needing) {
    return {
      some: false,
      item: textParam(ctx.params, 'R3c', keys.item),
      device_text: textParam(ctx.params, 'R3c', 'device_text'),
      notes: textParam(ctx.params, 'R3c', 'all.notes'),
      params: [['R3c', keys.item], ['R3c', keys.owner], ['R3c', 'device_text'], ['R3c', 'all.notes']],
    };
  }
  return {
    some: true,
    item: textParam(ctx.params, 'R3c', keys.some),
    device_text: textParam(ctx.params, 'R3c', 'some.device_text'),
    notes: f.missing.join(', '),
    params: [['R3c', keys.some], ['R3c', keys.owner], ['R3c', 'some.device_text']],
  };
}

/**
 * The subject of a floor's address draft (and of the lint that asks for it): a numbering group of
 * one level keeps T34's group subject, so its accepted or rejected drafts stay where they are; the
 * floors of a shared group (06 / 06M, D33) are each their own level (T169).
 */
export function addressSubject(level: LevelRow, groupLevels: readonly LevelRow[]): Subject {
  return groupLevels.length === 1 && level.numbering_group_id
    ? { entity_kind: 'numbering_group', entity_id: level.numbering_group_id, level_id: level.id }
    : { entity_kind: 'level', entity_id: level.id, level_id: level.id };
}

export const R3c: Rule = {
  id: 'R3c',
  title: 'Missing all Device Neuron IDs / IP addresses / DMX addresses',
  text: 'Every floor with a device still missing an address ends with one item per address kind (`Information`, sorted last). When no device on the floor that needs the address has one: "Missing all Device Neuron IDs" (`EC`), "Missing all Device IP addresses" (`ETC`), "Missing all Device DMX addresses" (`EC`), Device "All devices", Notes "All devices on this floor". When some have it: "Missing some Device …", Device "See notes", Notes listing the floor\'s device IDs still missing (T169). A device needs an address by the wires it gets (D245: a Unison run → Neuron ID, a network run → IP address, a DMX run → DMX address; stations and sensors ride the Unison bus; an NSPS or rack hosts it without a Neuron chip), unless its type says otherwise. Once accepted the engine keeps each item: its Notes and its all / some wording rewritten on each capture, Closed when every device has its address, reopened on a new device without one (D49, D170, D258).',
  run(ctx) {
    for (const group of ctx.index.levelsByGroup.values()) {
      const levels = group.slice().sort(compareLevels);
      for (const level of levels) {
        if (!ctx.index.devicesByLevel.get(level.id)?.length) continue;
        for (const kind of ADDRESS_KINDS) {
          const f = floorAddresses(ctx, kind, level);
          const wording = addressWording(ctx, kind, f);
          const existing = addressItems(ctx, kind, [level])[0];
          if (existing) {
            maintainAddressItem(ctx, kind, existing, wording, f.missing.length);
            continue;
          }
          if (!wording) continue;
          const subject = addressSubject(level, levels);
          ctx.propose({
            subject,
            discriminator: DISCRIMINATOR[kind],
            kind: 'punch',
            payload: {
              level_id: level.id,
              item: wording.item,
              type: 'Information',
              owner: ownerParam(ctx.params, 'R3c', ITEM_KEY[kind].owner),
              tracking_status: 'Open',
              notes: wording.notes,
              sort_last: true,
              device_text: wording.device_text,
            },
            // T34's inputs on a one-level group, so a rejected draft stays rejected; the floor on a shared one
            inputs: subject.entity_kind === 'numbering_group' ? { group: subject.entity_id } : { level: level.id },
            params: wording.params,
            why: wording.some
              ? `${f.missing.length} of the ${f.needing} devices on Level ${level.level} that need ${ADDRESS_ARTICLE[kind]} ${f.missing.length === 1 ? 'has' : 'have'} none.`
              : f.needing === 1
                ? `The one device on Level ${level.level} that needs ${ADDRESS_ARTICLE[kind]} has none.`
                : `None of the ${f.needing} devices on Level ${level.level} that need ${ADDRESS_ARTICLE[kind]} has one.`,
          });
        }
      }
    }
  },
};

/**
 * The upkeep of an accepted address item (D170): Notes; the all / some wording of Item and Device
 * when the item reads one of the wordings the engine knows (T169, D258 — an item reworded to
 * anything else keeps its text); Closed when the floor's list is empty, reopened when it is not.
 * Item and Device are always among the fields once recognised (writing what the item already reads
 * is no op), so a reworded item never reads as edited against its draft.
 */
function maintainAddressItem(ctx: RuleContext, kind: AddressKind, item: PunchItemRow, wording: AddressWording | null, missing: number): void {
  const fields: Record<string, unknown> = { notes: wording?.notes ?? null };
  if (item.item != null && addressWordings(ctx.params, kind).includes(item.item)) {
    fields.item = wording?.item ?? item.item;
    const dt = item.device_text ?? null;
    if (dt == null || !dt.trim() || addressDeviceTexts(ctx.params).includes(dt)) fields.device_text = wording?.device_text ?? dt;
  }
  if (missing === 0) {
    if (isOpen(item)) {
      fields.tracking_status = 'Closed';
      fields.date_closed = ctx.today();
    }
  } else if (!isOpen(item)) {
    fields.tracking_status = 'Open';
    fields.date_closed = null;
  }
  ctx.maintain({
    entity: 'punch_item',
    id: item.id,
    fields,
    proposal_id: item.proposal_id,
    why: missing ? `${missing} device${missing === 1 ? '' : 's'} still without ${ADDRESS_ARTICLE[kind]}` : `Every device has its ${ADDRESS_LABEL[kind]}`,
  });
}

// ------------------------------------------------------------------ R3d / R3f

export const R3d: Rule = {
  id: 'R3d',
  title: 'No test or commissioning items',
  text: 'This phase has no test or commissioning items; an item whose text says "test" or "commission" is flagged.',
  run(ctx) {
    for (const p of ctx.index.punchItem.values()) {
      if (!isOpen(p) || !p.item || !/\b(test|commission)/i.test(p.item)) continue;
      ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `Item mentions testing or commissioning: "${p.item}"` });
    }
  },
};

export const R3f: Rule = {
  id: 'R3f',
  title: 'Item outside the vocabulary',
  text: 'Item text is picked from the project\'s `punch_item` vocabulary (R3e); a hand-typed item outside it is flagged (dismissable). Rule-made items and the address items the rules keep (R3c, reworded by the engine — T169) are not checked.',
  run(ctx) {
    const vocab = new Set(ctx.snap.vocab.filter((v) => v.deleted_at == null && v.list === 'punch_item').map((v) => v.value));
    if (!vocab.size) return;
    for (const p of ctx.index.punchItem.values()) {
      if (!isOpen(p) || p.rule_id || !p.item || vocab.has(p.item) || addressItemKind(ctx.params, p, null)) continue;
      ctx.find({ subject: { entity_kind: 'punch_item', entity_id: p.id, level_id: p.level_id }, message: `Item outside the vocabulary: "${p.item}"` });
    }
  },
};

/** For tests and T35: the ends R3a / R3b would act on, with R5 applied. */
export function actionableEnds(ctx: RuleContext): CableEndRow[] {
  return [...ctx.index.cableEnd.values()].filter((e) => (e.status === 'Not installed' || e.status === 'Issue') && !waitsForSurvey(ctx, e));
}
