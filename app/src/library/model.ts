/**
 * Device-type library editor (T48, Phase 3 §10, D43, D48, D55, D65, D183): reads and edits of a
 * project's `library_type` rows. A new type is a **draft**, usable on the plan at once and
 * flagged until accepted (D48); a model typed freely in the field arrives here as a draft too
 * (T23, D55). Accepting a type with default cables lets R2g propose them for the devices that
 * already exist (rule drafts, never automatic edits). "Copy from…" copies accepted types from
 * another project or the app library. Every write is an op through `Editor` (`Master edit`).
 * No React or Expo imports: tested in Node.
 */

import { DEVICE_CATEGORIES, LIBRARY_STREAM, OpError, ROLE, ROLE_LABEL, canonicalCategory, isRole, roleOf, roleOfCategory, type EditContext, type Editor, type Role, type Store } from '@field-survey/core';
import { CABLE_CODES, neuronIdDefault, neuronIdDefaultForRole, parseLibraryAccessories, parseLibraryCables, type LibraryAccessory, type LibraryCable } from '@field-survey/rules';

export const LIBRARY_CTX: EditContext = { change_type: 'Master edit', reason: 'Device-type library' };

/** The D196 eleven (CLAUDE.md §3, core), the picker's order; a project's `vocab(category)` may add more. */
export const CATEGORIES = DEVICE_CATEGORIES;

/** The roles a type may carry (T112, D201), the picker's order, and how the picker names them. */
export const ROLES = ROLE;
export const ROLE_LABELS = ROLE_LABEL;

export { CABLE_CODES, neuronIdDefault, neuronIdDefaultForRole, roleOf, roleOfCategory, type LibraryAccessory, type LibraryCable, type Role };

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
  /** null = the app library (D65). */
  projectId: string | null;
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
  /** Stored flag; null = the category's default (T68, D185). */
  needsNeuronId: boolean | null;
  /** What applies: the flag, else the role's default (off for racks and NSPS). */
  neuronId: boolean;
  state: LibraryState;
  createdById: string | null;
  /** When the type's first op was made (the "added … 10/09" line). */
  createdAt: string | null;
  promotedFromId: string | null;
  /** T111 (D197): what a catalogue import kept on the type (null for a hand-made one). */
  description: string | null;
  datasheetUrl: string | null;
  sourceRef: SourceRef | null;
  /** Imported as another type's accessory: kept for the accessory lists, never offered as a device. */
  accessoryOnly: boolean;
  /** A project type already promoted: the app-library type made from it (D65). */
  promotedAs: string | null;
  /** Live devices of this project of the type (by link, or by model / alias for imported ones). */
  devices: number;
  /** Rules that read this type (Phase 3 §10 "Rules that reference this type"). */
  rules: string[];
}

export interface LibraryView {
  types: LibraryType[];
  drafts: number;
  /** Open sync-conflict items on this library's types (Needs review, D184). */
  inReview: number;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const modelKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** Collapse spaces, trim; empty → null. */
export function clean(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
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

function scopeWhere(scope: string | null): { where: string; params: string[] } {
  return scope ? { where: 'project_id = ?', params: [scope] } : { where: 'project_id IS NULL', params: [] };
}

function toType(r: Row): Omit<LibraryType, 'devices' | 'rules' | 'createdAt' | 'promotedAs'> {
  return {
    id: String(r.id),
    projectId: str(r.project_id),
    model: String(r.model),
    aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [],
    category: str(r.category),
    role: isRole(r.role) ? r.role : null,
    effectiveRole: roleOf({ role: r.role, category: str(r.category) }, null),
    idScheme: r.id_scheme === 'level_tag' || r.id_scheme === 'level_number' ? r.id_scheme : null,
    defaultCables: parseLibraryCables(r.default_cables),
    optionalCables: parseLibraryCables(r.optional_cables),
    optionalAccessories: parseLibraryAccessories(r.optional_accessories),
    needsNeuronId: typeof r.needs_neuron_id === 'boolean' ? r.needs_neuron_id : null,
    neuronId: typeof r.needs_neuron_id === 'boolean' ? r.needs_neuron_id : neuronIdDefaultForRole(roleOf({ role: r.role, category: str(r.category) }, null)),
    state: r.state === 'accepted' || r.state === 'rejected' ? r.state : 'draft',
    createdById: str(r.created_by_id),
    promotedFromId: str(r.promoted_from_id),
    description: str(r.description),
    datasheetUrl: str(r.datasheet_url),
    sourceRef: sourceRefOf(r.source_ref),
    accessoryOnly: r.accessory_only === true,
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

/**
 * The library of a project (or the app library, `scope` null): live types by category in the
 * CLAUDE.md §3 order, drafts first within a category, rejected ones last.
 */
export async function loadLibrary(store: Store, scope: string | null): Promise<LibraryView> {
  const { where, params } = scopeWhere(scope);
  const rows = await store.list<Row>('library_type', { where, params, orderBy: 'id' });
  // devices of the project, to count each type's (by link, else by Device text = model or alias)
  const devices = scope
    ? await store.db.query<{ library_type_id: string | null; device: string | null }>(
        `SELECT d.library_type_id, d.device FROM device d JOIN level l ON l.id = d.level_id
         WHERE l.project_id = ? AND d.deleted_at IS NULL`,
        [scope],
      )
    : [];
  // project types promoted to the app library (its rows' promoted_from_id)
  const promoted = new Map<string, string>();
  if (scope) {
    const app = await store.list<Row>('library_type', { where: 'project_id IS NULL AND promoted_from_id IS NOT NULL' });
    for (const a of app) promoted.set(String(a.promoted_from_id), String(a.id));
  }
  const types: LibraryType[] = [];
  for (const r of rows) {
    const t = toType(r);
    const keys = new Set([t.model, ...t.aliases].map(modelKey));
    const count = devices.filter((d) => (d.library_type_id ? d.library_type_id === t.id : !!d.device && keys.has(modelKey(d.device)))).length;
    const first = (await store.opsFor(t.id))[0];
    types.push({ ...t, createdAt: first?.client_ts ?? null, promotedAs: promoted.get(t.id) ?? null, devices: count, rules: rulesForType(t.effectiveRole, t.defaultCables) });
  }
  // the eleven in order (an old master spelling sorts with its canonical value), then the project's own
  const catIndex = (c: string | null) => {
    const i = CATEGORIES.indexOf(canonicalCategory(c) as (typeof CATEGORIES)[number]);
    return i < 0 ? CATEGORIES.length : i;
  };
  const rejected = (t: LibraryType) => Number(t.state === 'rejected');
  types.sort(
    (a, b) =>
      rejected(a) - rejected(b) ||
      catIndex(a.category) - catIndex(b.category) ||
      Number(a.state !== 'draft') - Number(b.state !== 'draft') ||
      a.model.localeCompare(b.model, 'en', { numeric: true }),
  );
  const open = await store.list<{ subject: { entity_kind?: string } | null }>('review_item', {
    where: `state = 'open' AND project_id = ?`,
    params: [scope ?? LIBRARY_STREAM],
  });
  const inReview = open.filter((i) => i.subject?.entity_kind === 'library_type').length;
  return { types, drafts: types.filter((t) => t.state === 'draft').length, inReview };
}

async function assertFreeModel(store: Store, scope: string | null, model: string, exceptId: string | null): Promise<void> {
  const { types } = await loadLibrary(store, scope);
  const k = modelKey(model);
  const clash = types.find((t) => t.id !== exceptId && t.state !== 'rejected' && (modelKey(t.model) === k || t.aliases.some((a) => modelKey(a) === k)));
  if (clash) throw new OpError(`"${model}" is already in the library (${clash.model}).`);
}

/** "+ New type": a draft of this scope; a model already there (model or alias) is refused. */
export async function createType(editor: Editor, store: Store, scope: string | null, input: { model: string; category: string | null }): Promise<string> {
  const model = clean(input.model);
  if (!model) throw new OpError('Type the model first.');
  await assertFreeModel(store, scope, model, null);
  const { id } = await editor.create(
    'library_type',
    { project_id: scope, model, category: clean(input.category), state: 'draft', created_by_id: editor.userId },
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
  /** null = back to the category's default. */
  needsNeuronId?: boolean | null;
}

function checkCables(list: readonly LibraryCable[], what: string): LibraryCable[] | null {
  for (const c of list) {
    if (!CABLE_CODES.includes(c.code)) throw new OpError(`${what}: "${c.code}" is not a cable code (${CABLE_CODES.join(', ')}).`);
    if (c.qty != null && (!Number.isInteger(c.qty) || c.qty < 0)) throw new OpError(`${what}: the quantity must be a whole number.`);
  }
  // an empty list is stored as null: the category table applies again (D183)
  return list.length ? list.map((c) => ({ ...c, from: clean(c.from), to: clean(c.to), far: clean(c.far) })) : null;
}

/** Save an edit of a type as one group of field sets; unchanged fields write nothing. */
export async function updateType(editor: Editor, store: Store, id: string, patch: TypePatch): Promise<void> {
  const row = await store.get<Row>('library_type', id);
  if (!row || row.deleted_at) throw new OpError('This type is not on this iPad.');
  const scope = str(row.project_id);
  const values: Row = {};
  if (patch.model !== undefined) {
    const model = clean(patch.model);
    if (!model) throw new OpError('A type needs a model.');
    if (model !== row.model) await assertFreeModel(store, scope, model, id);
    values.model = model;
  }
  if (patch.category !== undefined) values.category = clean(patch.category);
  if (patch.role !== undefined) {
    if (patch.role !== null && !isRole(patch.role)) throw new OpError(`"${String(patch.role)}" is not a role (${ROLE.join(', ')}).`);
    values.role = patch.role;
  }
  if (patch.aliases !== undefined) values.aliases = patch.aliases.length ? patch.aliases : null;
  if (patch.idScheme !== undefined) values.id_scheme = patch.idScheme;
  if (patch.defaultCables !== undefined) values.default_cables = checkCables(patch.defaultCables, 'Default cables');
  if (patch.optionalCables !== undefined) values.optional_cables = checkCables(patch.optionalCables, 'Optional cables');
  if (patch.needsNeuronId !== undefined) values.needs_neuron_id = patch.needsNeuronId;
  if (patch.optionalAccessories !== undefined) {
    const list = patch.optionalAccessories.map((a) => ({ model: clean(a.model), expected_qty: a.expected_qty }));
    if (list.some((a) => !a.model)) throw new OpError('An accessory needs a model.');
    if (list.some((a) => a.expected_qty != null && (!Number.isInteger(a.expected_qty) || a.expected_qty < 0))) throw new OpError('An expected quantity must be a whole number.');
    values.optional_accessories = list.length ? list : null;
  }
  await editor.group(LIBRARY_CTX, (g) => g.setFields('library_type', id, values));
}

export async function acceptType(editor: Editor, id: string): Promise<void> {
  await editor.setField('library_type', id, 'state', 'accepted', LIBRARY_CTX);
}

/** Reject a draft (devices keep their link; the type leaves the pickers). */
export async function rejectType(editor: Editor, id: string): Promise<void> {
  await editor.setField('library_type', id, 'state', 'rejected', LIBRARY_CTX);
}

/** Back to draft (a rejected type, or an accepted one to rework). */
export async function reopenType(editor: Editor, id: string): Promise<void> {
  await editor.setField('library_type', id, 'state', 'draft', LIBRARY_CTX);
}

export interface CopySource {
  /** null = the app library. */
  id: string | null;
  name: string;
  types: LibraryType[];
}

/** Where "Copy from…" can copy: the app library and every other project on this iPad, accepted types only. */
export async function copySources(store: Store, scope: string | null): Promise<CopySource[]> {
  const out: CopySource[] = [];
  if (scope) out.push({ id: null, name: 'App library', types: (await loadLibrary(store, null)).types.filter((t) => t.state === 'accepted') });
  const projects = await store.list<Row>('project', { orderBy: 'created_at' });
  for (const p of projects) {
    if (String(p.id) === scope) continue;
    const types = (await loadLibrary(store, String(p.id))).types.filter((t) => t.state === 'accepted');
    out.push({ id: String(p.id), name: String(p.name), types });
  }
  return out.filter((s) => s.types.length);
}

/**
 * Copy types into `scope` as new accepted rows (they were accepted at the source; the server's
 * copy at project creation does the same, D65). A model the target already has is skipped.
 * One group for the whole copy. Copying a project's type into the app library (`scope` null) is
 * a promotion: the copy records `promoted_from_id`. The editor must write to the target's
 * stream (`libraryEditor` for the app library).
 */
export async function copyTypes(editor: Editor, store: Store, scope: string | null, typeIds: readonly string[]): Promise<{ copied: number; skipped: string[] }> {
  const have = new Set((await loadLibrary(store, scope)).types.filter((t) => t.state !== 'rejected').flatMap((t) => [t.model, ...t.aliases].map(modelKey)));
  const rows: Row[] = [];
  for (const id of typeIds) {
    const r = await store.get<Row>('library_type', id);
    if (r && !r.deleted_at) rows.push(r);
  }
  const skipped: string[] = [];
  let copied = 0;
  await editor.group(LIBRARY_CTX, async (g) => {
    for (const r of rows) {
      const k = modelKey(String(r.model));
      if (have.has(k)) {
        skipped.push(String(r.model));
        continue;
      }
      have.add(k);
      await g.create('library_type', {
        project_id: scope,
        model: r.model,
        aliases: r.aliases ?? null,
        category: r.category ?? null,
        id_scheme: r.id_scheme ?? null,
        default_cables: r.default_cables ?? null,
        optional_cables: r.optional_cables ?? null,
        optional_accessories: r.optional_accessories ?? null,
        // only when set: a server without migration 0010 refuses the column (T68)
        ...(r.needs_neuron_id != null ? { needs_neuron_id: r.needs_neuron_id } : {}),
        // likewise the T111 columns (Alembic 0011); `source_ref` travels with the copy
        ...(r.description != null ? { description: r.description } : {}),
        ...(r.datasheet_url != null ? { datasheet_url: r.datasheet_url } : {}),
        ...(r.source_ref != null ? { source_ref: r.source_ref } : {}),
        ...(r.accessory_only != null ? { accessory_only: r.accessory_only } : {}),
        // and the T112 role (migration 0011 / Alembic 0012)
        ...(r.role != null ? { role: r.role } : {}),
        state: 'accepted',
        created_by_id: editor.userId,
        ...(scope === null && r.project_id ? { promoted_from_id: r.id } : {}),
      });
      copied++;
    }
  });
  return { copied, skipped };
}

/**
 * "Promote to app library" (D65): an accepted project type becomes an app-library type (new row,
 * `promoted_from_id` = the project type), which every project created afterwards copies. Refused
 * for a draft, and when the app library already has the model (or an alias of it).
 */
export async function promoteType(libraryEditor: Editor, store: Store, typeId: string): Promise<string> {
  if (libraryEditor.projectId !== LIBRARY_STREAM) throw new OpError('Promotion writes to the app library.');
  const row = await store.get<Row>('library_type', typeId);
  if (!row || row.deleted_at || !row.project_id) throw new OpError('Only a project type can be promoted.');
  if (row.state !== 'accepted') throw new OpError('Accept the type before promoting it.');
  const out = await copyTypes(libraryEditor, store, null, [typeId]);
  if (!out.copied) throw new OpError(`The app library already has ${String(row.model)}.`);
  const made = await store.list<Row>('library_type', { where: 'project_id IS NULL AND promoted_from_id = ?', params: [typeId], orderBy: 'id' });
  return String(made.at(-1)!.id);
}

/** A blank cable row for the editor's "+ add". */
export function blankCable(code = 'X'): LibraryCable {
  return { code, from: null, to: null, far: null, single_row: false, qty: 1, status: null };
}
