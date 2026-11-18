/**
 * Device-type library editor (T48, Phase 3 §10, D43, D48, D183; one library since T196 / T197,
 * D287, D292): reads and edits of the app library's `library_type` rows (`project_id` null), the
 * one library every project reads. Every write goes to the library stream (`/library/ops`, D184):
 * the functions refuse an editor on a project's stream, so nothing in a project edits a type
 * (D287 (2)). A new type is a **draft**, usable on the plan at once and flagged until accepted
 * (D48); a model typed freely in the field arrives here as a draft too (D292 (2)). Accepting a
 * type with default cables lets R2g propose them for the devices that already exist (rule
 * drafts, never automatic edits). Deleting, rejecting or renaming a type reaches every project:
 * the screen warns with the devices this iPad knows of (`typeChangeWarning`, D292 (6)).
 * No React or Expo imports: tested in Node.
 */

import { DEVICE_CATEGORIES, LIBRARY_STREAM, OpError, ROLE, ROLE_LABEL, canonicalCategory, isLibraryStream, isRole, roleOf, roleOfCategory, type EditContext, type Editor, type Role, type Store } from '@field-survey/core';
import { CABLE_CODES, RuleParams, addressNeeds, cableCodes, loadRuleParamRows, parseLibraryAccessories, parseLibraryCables, type AddressNeeds, type LibraryAccessory, type LibraryCable } from '@field-survey/rules';

import { offersPartChips } from '../suggestions/model';

export const LIBRARY_CTX: EditContext = { change_type: 'Master edit', reason: 'Device-type library' };

/** The D196 eleven (CLAUDE.md §3, core), the picker's order; a project's `vocab(category)` may add more. */
export const CATEGORIES = DEVICE_CATEGORIES;

/** The roles a type may carry (T112, D201), the picker's order, and how the picker names them. */
export const ROLES = ROLE;
export const ROLE_LABELS = ROLE_LABEL;

export { CABLE_CODES, addressNeeds, roleOf, roleOfCategory, type AddressNeeds, type LibraryAccessory, type LibraryCable, type Role };

/** D52: an NSPS kit carries its power supply, expected 1. Offered on types whose role is `nsps`. */
export const NSPS_POWER_SUPPLY: LibraryAccessory = { model: 'P-NSPS-D Power Supply', expected_qty: 1 };

export type LibraryState = 'draft' | 'accepted' | 'rejected';

/** `library_type.source_ref` as the DaVinci import writes it (T111); other keys are kept but not read. */
export interface SourceRef {
  kind: string;
  displayName: string | null;
  family: string | null;
  category: string | null;
  libraryTimestamp: string | null;
}
export type IdScheme = 'level_number' | 'level_tag';

export interface LibraryType {
  id: string;
  model: string;
  aliases: string[];
  category: string | null;
  /** Stored role (T112, D201); null = the category's role. */
  role: Role | null;
  /** What applies: the stored role, else the category's (`other` when the category names none). */
  effectiveRole: Role;
  /** null = the role's default (stations and sensors by tag letter, the rest numbered). */
  idScheme: IdScheme | null;
  defaultCables: LibraryCable[];
  optionalCables: LibraryCable[];
  optionalAccessories: LibraryAccessory[];
  /** Stored flags; null = by the wires its devices get (T68 / D185, T146 / D245). */
  needsNeuronId: boolean | null;
  needsIpAddress: boolean | null;
  needsDmxAddress: boolean | null;
  /** What the type alone implies (`addressNeeds` over its role and default cables): the flag, else by the wires. */
  neuronId: boolean;
  ipAddress: boolean;
  dmxAddress: boolean;
  state: LibraryState;
  createdById: string | null;
  /** When the type's first op was made (the "added … 10/09" line). */
  createdAt: string | null;
  /** T111 (D197): what a catalogue import kept on the type (null for a hand-made one). */
  description: string | null;
  datasheetUrl: string | null;
  sourceRef: SourceRef | null;
  /** Imported as another type's accessory: kept for the accessory lists, never offered as a device. */
  accessoryOnly: boolean;
  /** Deleted (soft): listed with the rejected ones, where Restore brings it back (D292 (6)). */
  deleted: boolean;
  /**
   * Live devices of the type (by link, or by model / alias for one with no link): in the open
   * project when the library was loaded for one, else in every project on this iPad.
   */
  devices: number;
  /** Live devices of the type in every project on this iPad: what a delete, reject or rename warns with (D292 (6)). */
  devicesOnIpad: number;
  /** Rules that read this type (Phase 3 §10 "Rules that reference this type"). */
  rules: string[];
}

export interface LibraryView {
  types: LibraryType[];
  drafts: number;
  /** Open sync-conflict items on the library's types (Needs review, D184). */
  inReview: number;
  /** The cable codes the types may name: the master's, then the app library's Rules' own (T117). */
  codes: string[];
  /** The codes that offer no Part chips: network codes whose kits the app library's Rules turn off (T118, D213). */
  noPartCodes: string[];
}

/** The cable codes a type may name (`cableCodes` over the app library's accepted Rules). */
export async function libraryCableCodes(store: Store): Promise<string[]> {
  return cableCodes(await libraryParams(store));
}

async function libraryParams(store: Store): Promise<RuleParams> {
  return new RuleParams(await loadRuleParamRows(store, null));
}

/** A type is edited in the library only (D287 (2)): an editor on a project's stream is refused. */
function libraryOnly(editor: Editor): void {
  if (!isLibraryStream(editor.projectId)) throw new OpError('Device types are edited in the Library.');
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const modelKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** Collapse spaces, trim; empty → null. */
export function clean(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/**
 * What the type editor's form holds, as one string (T125): the editor is rebuilt only when this
 * changes, so a Save does not bring back the pre-save values while the reload is on its way, and a
 * change pulled from another iPad still refreshes the form.
 */
export function editorStamp(t: LibraryType): string {
  return JSON.stringify([t.id, t.model, t.category, t.role, t.aliases, t.idScheme, t.needsNeuronId, t.needsIpAddress, t.needsDmxAddress, t.defaultCables, t.optionalCables, t.optionalAccessories, t.state]);
}

/** "A, B ,a" → ["A", "B"]: comma-separated aliases, deduplicated ignoring case and spaces. */
export function parseAliases(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const a = clean(part);
    if (a && !out.some((x) => modelKey(x) === modelKey(a))) out.push(a);
  }
  return out;
}

/** The rules a type's devices are read by: R2c / R2d / R2e by role (T112), R2g once it has default cables. */
export function rulesForType(role: Role, defaultCables: readonly LibraryCable[]): string[] {
  const out: string[] = [];
  const governs = defaultCables.length > 0;
  if (role === 'relay_panel' && !governs) out.push('R2c');
  if ((role === 'nsps' || role === 'equipment_rack') && !governs) out.push('R2d');
  if (role === 'nsps' || role === 'equipment_rack') out.push('R2e');
  if (governs) out.push('R2g');
  return out;
}

/** "120V · 120v Power → P-NSPS-D Power Supply · single row" for a table cell. */
export function describeCable(c: LibraryCable): string {
  const route = [c.from, c.to ?? c.far].filter(Boolean).join(' → ');
  return [c.code, route || null, c.single_row ? 'single row' : '2 ends', c.qty != null ? `qty ${c.qty}` : null, c.status].filter(Boolean).join(' · ');
}

function toType(r: Row, params: RuleParams): Omit<LibraryType, 'devices' | 'devicesOnIpad' | 'rules' | 'createdAt'> {
  const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
  // what the type alone implies for a device of it with no cable record (T146): its flags, else its default cables and role
  const needs = addressNeeds(
    { needs_neuron_id: flag(r.needs_neuron_id), needs_ip_address: flag(r.needs_ip_address), needs_dmx_address: flag(r.needs_dmx_address), category: str(r.category), role: r.role, state: 'accepted', default_cables: r.default_cables },
    { category: str(r.category) },
    null,
    params,
  );
  return {
    id: String(r.id),
    model: String(r.model),
    aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [],
    category: str(r.category),
    role: isRole(r.role) ? r.role : null,
    effectiveRole: roleOf({ role: r.role, category: str(r.category) }, null),
    idScheme: r.id_scheme === 'level_tag' || r.id_scheme === 'level_number' ? r.id_scheme : null,
    defaultCables: parseLibraryCables(r.default_cables),
    optionalCables: parseLibraryCables(r.optional_cables),
    optionalAccessories: parseLibraryAccessories(r.optional_accessories),
    needsNeuronId: flag(r.needs_neuron_id),
    needsIpAddress: flag(r.needs_ip_address),
    needsDmxAddress: flag(r.needs_dmx_address),
    neuronId: needs.neuron,
    ipAddress: needs.ip,
    dmxAddress: needs.dmx,
    state: r.state === 'accepted' || r.state === 'rejected' ? r.state : 'draft',
    createdById: str(r.created_by_id),
    description: str(r.description),
    datasheetUrl: str(r.datasheet_url),
    sourceRef: sourceRefOf(r.source_ref),
    accessoryOnly: r.accessory_only === true,
    deleted: r.deleted_at != null,
  };
}

function sourceRefOf(v: unknown): SourceRef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const kind = str(r.kind);
  if (!kind) return null;
  return { kind, displayName: str(r.display_name), family: str(r.family), category: str(r.category), libraryTimestamp: str(r.library_timestamp) };
}

/** One line naming where an imported type came from (`DaVinci · Paradigm / Controllers · NSPS`). */
export function sourceLine(ref: SourceRef | null): string | null {
  if (!ref) return null;
  const name = ref.kind === 'davinci' ? 'DaVinci' : ref.kind;
  const where = [ref.family, ref.category].filter(Boolean).join(' / ');
  return [name, where || null, ref.displayName].filter(Boolean).join(' · ');
}

/** Live devices per type on this iPad: by link, and by Device text (model key) for the ones with none. */
interface DeviceTally {
  byLink: Map<string, { all: number; here: number }>;
  byText: Map<string, { all: number; here: number }>;
}

async function tallyDevices(store: Store, projectId: string | null): Promise<DeviceTally> {
  const rows = await store.db.query<{ library_type_id: string | null; device: string | null; project_id: string | null }>(
    `SELECT d.library_type_id, d.device, l.project_id FROM device d JOIN level l ON l.id = d.level_id
     WHERE d.deleted_at IS NULL AND l.deleted_at IS NULL`,
  );
  const tally: DeviceTally = { byLink: new Map(), byText: new Map() };
  const bump = (map: Map<string, { all: number; here: number }>, key: string, here: boolean) => {
    const n = map.get(key) ?? { all: 0, here: 0 };
    n.all++;
    if (here) n.here++;
    map.set(key, n);
  };
  for (const d of rows) {
    const here = projectId != null && d.project_id === projectId;
    if (d.library_type_id) bump(tally.byLink, d.library_type_id, here);
    else if (d.device && d.device.trim()) bump(tally.byText, modelKey(d.device), here);
  }
  return tally;
}

/**
 * A type's devices in the tally: its links, plus the unlinked devices named like its model or an
 * alias — only while it is live and not rejected, as the rules match them (`findDeviceType`).
 */
function countOf(tally: DeviceTally, t: Pick<LibraryType, 'id' | 'model' | 'aliases' | 'state' | 'deleted'>): { all: number; here: number } {
  const out = { ...(tally.byLink.get(t.id) ?? { all: 0, here: 0 }) };
  if (t.deleted || t.state === 'rejected') return out;
  for (const k of new Set([t.model, ...t.aliases].map(modelKey))) {
    const n = tally.byText.get(k);
    if (!n) continue;
    out.all += n.all;
    out.here += n.here;
  }
  return out;
}

/**
 * The library (the app library's types, D287 (1)) by category in the CLAUDE.md §3 order, drafts
 * first within a category, rejected and deleted ones last. `projectId` (the open project, from
 * the sidebar's Library) makes each type's `devices` that project's count; without one it is
 * every project's on this iPad.
 */
export async function loadLibrary(store: Store, projectId: string | null = null): Promise<LibraryView> {
  const rows = await store.list<Row>('library_type', { where: 'project_id IS NULL', orderBy: 'id', includeDeleted: true });
  const ruleParams = await libraryParams(store);
  const codes = cableCodes(ruleParams);
  const noPartCodes = codes.filter((c) => !offersPartChips(ruleParams, c));
  const tally = await tallyDevices(store, projectId);
  const types: LibraryType[] = [];
  for (const r of rows) {
    const t = toType(r, ruleParams);
    const n = countOf(tally, t);
    const first = (await store.opsFor(t.id))[0];
    types.push({ ...t, createdAt: first?.client_ts ?? null, devices: projectId ? n.here : n.all, devicesOnIpad: n.all, rules: rulesForType(t.effectiveRole, t.defaultCables) });
  }
  // the eleven in order (an old master spelling sorts with its canonical value), then any other
  const catIndex = (c: string | null) => {
    const i = CATEGORIES.indexOf(canonicalCategory(c) as (typeof CATEGORIES)[number]);
    return i < 0 ? CATEGORIES.length : i;
  };
  const rejected = (t: LibraryType) => Number(t.state === 'rejected' || t.deleted);
  types.sort(
    (a, b) =>
      rejected(a) - rejected(b) ||
      catIndex(a.category) - catIndex(b.category) ||
      Number(a.state !== 'draft') - Number(b.state !== 'draft') ||
      a.model.localeCompare(b.model, 'en', { numeric: true }),
  );
  const open = await store.list<{ subject: { entity_kind?: string } | null }>('review_item', {
    where: `state = 'open' AND project_id = ?`,
    params: [LIBRARY_STREAM],
  });
  const inReview = open.filter((i) => i.subject?.entity_kind === 'library_type').length;
  return { types, drafts: types.filter((t) => t.state === 'draft' && !t.deleted).length, inReview, codes, noPartCodes };
}

async function assertFreeModel(store: Store, model: string, exceptId: string | null): Promise<void> {
  const rows = await store.list<Row>('library_type', { where: `project_id IS NULL AND state <> 'rejected'`, orderBy: 'id' });
  const k = modelKey(model);
  const aliasesOf = (r: Row) => (Array.isArray(r.aliases) ? (r.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : []);
  const clash = rows.find((r) => String(r.id) !== exceptId && (modelKey(String(r.model)) === k || aliasesOf(r).some((a) => modelKey(a) === k)));
  if (clash) throw new OpError(`"${model}" is already in the library (${String(clash.model)}).`);
}

/** "+ New type": a draft in the library; a model already there (model or alias) is refused. */
export async function createType(editor: Editor, store: Store, input: { model: string; category: string | null }): Promise<string> {
  libraryOnly(editor);
  const model = clean(input.model);
  if (!model) throw new OpError('Type the model first.');
  await assertFreeModel(store, model, null);
  const { id } = await editor.create(
    'library_type',
    { project_id: null, model, category: clean(input.category), state: 'draft', created_by_id: editor.userId },
    LIBRARY_CTX,
  );
  return id;
}

export interface TypePatch {
  model?: string;
  category?: string | null;
  /** null = the category's role (T112). */
  role?: Role | null;
  aliases?: string[];
  idScheme?: IdScheme | null;
  defaultCables?: LibraryCable[];
  optionalCables?: LibraryCable[];
  optionalAccessories?: LibraryAccessory[];
  /** null = back to "by the wires" (T146, D245). */
  needsNeuronId?: boolean | null;
  needsIpAddress?: boolean | null;
  needsDmxAddress?: boolean | null;
}

function checkCables(list: readonly LibraryCable[], what: string, codes: readonly string[]): LibraryCable[] | null {
  for (const c of list) {
    if (!codes.includes(c.code)) throw new OpError(`${what}: "${c.code}" is not a cable code (${codes.join(', ')}).`);
    if (c.qty != null && (!Number.isInteger(c.qty) || c.qty < 0)) throw new OpError(`${what}: the quantity must be a whole number.`);
  }
  // an empty list is stored as null: the category table applies again (D183)
  return list.length ? list.map((c) => ({ ...c, from: clean(c.from), to: clean(c.to), far: clean(c.far) })) : null;
}

/** Save an edit of a type as one group of field sets; unchanged fields write nothing. */
export async function updateType(editor: Editor, store: Store, id: string, patch: TypePatch): Promise<void> {
  libraryOnly(editor);
  const row = await store.get<Row>('library_type', id);
  if (!row || row.deleted_at) throw new OpError('This type is not on this iPad.');
  const values: Row = {};
  if (patch.model !== undefined) {
    const model = clean(patch.model);
    if (!model) throw new OpError('A type needs a model.');
    if (model !== row.model) await assertFreeModel(store, model, id);
    values.model = model;
  }
  if (patch.category !== undefined) values.category = clean(patch.category);
  if (patch.role !== undefined) {
    if (patch.role !== null && !isRole(patch.role)) throw new OpError(`"${String(patch.role)}" is not a role (${ROLE.join(', ')}).`);
    values.role = patch.role;
  }
  if (patch.aliases !== undefined) values.aliases = patch.aliases.length ? patch.aliases : null;
  if (patch.idScheme !== undefined) values.id_scheme = patch.idScheme;
  const codes = patch.defaultCables !== undefined || patch.optionalCables !== undefined ? await libraryCableCodes(store) : [];
  if (patch.defaultCables !== undefined) values.default_cables = checkCables(patch.defaultCables, 'Default cables', codes);
  if (patch.optionalCables !== undefined) values.optional_cables = checkCables(patch.optionalCables, 'Optional cables', codes);
  if (patch.needsNeuronId !== undefined) values.needs_neuron_id = patch.needsNeuronId;
  if (patch.needsIpAddress !== undefined) values.needs_ip_address = patch.needsIpAddress;
  if (patch.needsDmxAddress !== undefined) values.needs_dmx_address = patch.needsDmxAddress;
  if (patch.optionalAccessories !== undefined) {
    // A catalogue slot's max quantity and group (D197 (4)) ride along: `lint.accessory_group` reads them (T113).
    const list = patch.optionalAccessories.map((a): LibraryAccessory => ({
      model: clean(a.model) ?? '',
      expected_qty: a.expected_qty,
      ...(a.max_quantity != null ? { max_quantity: a.max_quantity } : {}),
      ...(a.group ? { group: a.group } : {}),
    }));
    if (list.some((a) => !a.model)) throw new OpError('An accessory needs a model.');
    if (list.some((a) => a.expected_qty != null && (!Number.isInteger(a.expected_qty) || a.expected_qty < 0))) throw new OpError('An expected quantity must be a whole number.');
    values.optional_accessories = list.length ? list : null;
  }
  await editor.group(LIBRARY_CTX, (g) => g.setFields('library_type', id, values));
}

export async function acceptType(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('library_type', id, 'state', 'accepted', LIBRARY_CTX);
}

/** Reject a type (devices keep their link and Lint flags them, D292 (6); the type leaves the pickers). */
export async function rejectType(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('library_type', id, 'state', 'rejected', LIBRARY_CTX);
}

/** Back to draft (a rejected type, or an accepted one to rework). */
export async function reopenType(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.setField('library_type', id, 'state', 'draft', LIBRARY_CTX);
}

/**
 * Delete a type (a soft delete: nothing is hard-deleted). Its devices keep their link and Lint
 * flags them (`lint.type_gone`, D292 (6)); the type is listed with the rejected ones, where
 * `restoreType` brings it back.
 */
export async function deleteType(editor: Editor, id: string): Promise<void> {
  libraryOnly(editor);
  await editor.delete('library_type', id, LIBRARY_CTX);
}

/** Undo a delete: the type is live again in its state; a model taken meanwhile by another type is refused. */
export async function restoreType(editor: Editor, store: Store, id: string): Promise<void> {
  libraryOnly(editor);
  const row = await store.get<Row>('library_type', id);
  if (!row) throw new OpError('This type is not on this iPad.');
  if (!row.deleted_at) return;
  if (row.state !== 'rejected') await assertFreeModel(store, String(row.model), id);
  await editor.restore('library_type', id, LIBRARY_CTX);
}

export type TypeChange = 'delete' | 'reject' | 'rename';

/** What the Library asks before a change that reaches every project (D292 (6)). */
export interface TypeChangeWarning {
  title: string;
  message: string;
  /** The confirm button's word. */
  confirm: string;
}

/**
 * The question before deleting, rejecting or renaming a type (D292 (6)): every project reads the
 * one library, so the change reaches all of them; the count is the devices this iPad knows of
 * (`devicesOnIpad`). A delete always asks; a reject or a rename that no device here uses goes
 * ahead without a question (null).
 */
export function typeChangeWarning(t: Pick<LibraryType, 'model' | 'devicesOnIpad'>, change: TypeChange, newModel?: string): TypeChangeWarning | null {
  const n = t.devicesOnIpad;
  const used = `${n} device${n === 1 ? '' : 's'} on this iPad ${n === 1 ? 'uses' : 'use'} it`;
  switch (change) {
    case 'delete':
      return {
        title: `Delete ${t.model}?`,
        message: n ? `${used}. ${n === 1 ? 'It keeps' : 'They keep'} the type and Lint flags ${n === 1 ? 'it' : 'them'}, in every project.` : 'No device on this iPad uses it. Every project loses the type.',
        confirm: 'Delete',
      };
    case 'reject':
      return n ? { title: `Reject ${t.model}?`, message: `${used}. ${n === 1 ? 'It keeps' : 'They keep'} the type and Lint flags ${n === 1 ? 'it' : 'them'}, in every project.`, confirm: 'Reject' } : null;
    case 'rename':
      return n && newModel ? { title: `Rename ${t.model} to ${newModel}?`, message: `${used}. Every project reads the new model.`, confirm: 'Rename' } : null;
  }
}

/**
 * Search over a type's names (T114): every word of the query must appear in the model, an alias
 * or the catalogue display name, ignoring case and spaces ("paradigm station" finds a
 * "Paradigm Touchscreen Station"). An empty query matches everything.
 */
export function matchesQuery(names: readonly (string | null | undefined)[], query: string): boolean {
  const words = query.toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = names.filter((n): n is string => !!n).map((n) => n.toUpperCase());
  const squashed = hay.map(modelKey);
  return words.every((w) => hay.some((h) => h.includes(w)) || squashed.some((h) => h.includes(w)));
}

export const ACCESSORY_GROUP = 'Accessories (not placeable)';
export const REJECTED_GROUP = 'Rejected and deleted';
export const NO_CATEGORY_GROUP = 'No category';

/** The list group a type sits in: its category, the accessories (T111), or the rejected and deleted ones. */
export function groupOf(t: Pick<LibraryType, 'state' | 'accessoryOnly' | 'category' | 'deleted'>): string {
  return t.state === 'rejected' || t.deleted ? REJECTED_GROUP : t.accessoryOnly ? ACCESSORY_GROUP : (t.category ?? NO_CATEGORY_GROUP);
}

export interface LibraryGroup {
  key: string;
  types: LibraryType[];
  drafts: number;
}

export interface LibraryFilter {
  query?: string;
  /** A group key (`groupOf`); null = every group. */
  group?: string | null;
  draftsOnly?: boolean;
}

/**
 * The list at catalogue size (T114): the types that pass the filter, by group in the
 * `loadLibrary` order with the accessories and the rejected ones last.
 */
export function libraryGroups(types: readonly LibraryType[], filter: LibraryFilter = {}): LibraryGroup[] {
  const out = new Map<string, LibraryType[]>();
  for (const t of types) {
    const key = groupOf(t);
    if (filter.group && key !== filter.group) continue;
    if (filter.draftsOnly && (t.state !== 'draft' || t.deleted)) continue;
    if (!matchesQuery([t.model, ...t.aliases, t.sourceRef?.displayName], filter.query ?? '')) continue;
    out.set(key, [...(out.get(key) ?? []), t]);
  }
  const rank = (k: string) => (k === REJECTED_GROUP ? 2 : k === ACCESSORY_GROUP ? 1 : 0);
  return [...out.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, list]) => ({ key, types: list, drafts: list.filter((t) => t.state === 'draft' && !t.deleted).length }));
}

/**
 * "Accept all drafts in <group>" (T114): every draft of the group, each with its own `state` op
 * in one group, so each accept is still recorded as reviewed by this person (prompt Must).
 * Returns how many.
 */
export async function acceptAllDrafts(editor: Editor, store: Store, group: string): Promise<number> {
  libraryOnly(editor);
  if (group === REJECTED_GROUP) throw new OpError('Rejected types are reopened one by one.');
  const { types } = await loadLibrary(store);
  const drafts = types.filter((t) => t.state === 'draft' && !t.deleted && groupOf(t) === group);
  if (!drafts.length) return 0;
  await editor.group({ ...LIBRARY_CTX, reason: `Device-type library: Accept all drafts in ${group}` }, async (g) => {
    for (const t of drafts) await g.setField('library_type', t.id, 'state', 'accepted');
  });
  return drafts.length;
}

/** A blank cable row for the editor's "+ add". */
export function blankCable(code = 'X'): LibraryCable {
  return { code, from: null, to: null, far: null, single_row: false, qty: 1, status: null };
}
