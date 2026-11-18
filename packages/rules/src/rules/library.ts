/**
 * Device-type library cables (T48, Phase 3 §10, D183; the one source since T199, D288–D294). What
 * a device takes comes from the Library and nowhere else: no rule says what a kind of device takes
 * (the by-role tables R2c / R2d retired, D290). `cablesOfDevice` gives a device's cables — its
 * type's, plus those of every accessory it carries (D288) — as **required** runs (an accepted
 * type's `default_cables`) and **optional** ones (its `optional_cables`, and every row of a draft
 * type). R2g offers each required run the device lacks as a `cable` draft (D173); an optional run
 * makes no draft and no row, the card only offers it (D292 (3)). `U` rows are R2e's (one Unison
 * bus per level, not per device), so R2g never offers them.
 *
 * A device's type is its `library_type_id`; an imported device has none, so the library type whose
 * model or alias equals the device's Device text is used. There is one library, the app's, read
 * by every project (T196, D287 (1)): a project holds no types of its own.
 */

import { roleOf, type ConnectionStatus, type Role } from '@field-survey/core';

import { DEFAULT_PARAMS, type ParamRef, type RuleParams } from '../params';
import type { Rule, RuleContext } from '../rule';
import type { DeviceRow, LibraryTypeRow, PlaceholderRow } from '../snapshot';
import { SIGNAL, cableOf, deviceLabel, str } from './shared';

/** The cable codes a library row may name (CLAUDE.md §3). */
export const CABLE_CODES: readonly string[] = Object.keys(SIGNAL);

/**
 * The cable codes a scope accepts (T117): the master's ten, then every code its Rules give a
 * signal word (`R3.signal`), as the cable-code lint reads them.
 */
export function cableCodes(params: RuleParams = DEFAULT_PARAMS): string[] {
  const own = Object.keys(params.get('R3', 'signal') as object).filter((c) => c !== '*' && !CABLE_CODES.includes(c));
  return [...CABLE_CODES, ...own];
}

/** One run of a device type: its code and the texts the generated ends get. */
export interface LibraryCable {
  code: string;
  /** The device end's From text; empty = the code's `R2g.from`, else the device's panel name / model. */
  from: string | null;
  /** The device end's To text (`Fixtures`, `P-NSPS-D Power Supply`). */
  to: string | null;
  /** The far end: a placeholder of this label when the project has one, else its From text. */
  far: string | null;
  single_row: boolean;
  qty: number | null;
  /** A status the device end starts with; empty = the code's `R2g.status` (a panic run: `Installed, untested`). */
  status: ConnectionStatus | null;
}

/**
 * An accessory a type may carry (D52: an NSPS kit's power supply, expected 1). A catalogue import
 * (T111, D197) also keeps the slot's `max_quantity` and, where the catalogue asks for "n of these",
 * the `group` the slot belongs to (`{label, min, max}`); `lint.accessory_group` reads both (T113).
 */
export interface LibraryAccessory {
  model: string;
  expected_qty: number | null;
  max_quantity?: number | null;
  group?: { label: string; min: number; max: number | null } | null;
}

const STATUSES: readonly string[] = ['Complete', 'Installed, untested', 'Issue', 'Not installed', 'No access', 'Not started'];

/**
 * Read a stored cable list defensively: a row without a code is dropped, and every other row is
 * kept whatever its code (T196, D287 (5)). A type's cables are the type's, the same in every
 * project, so a code the reading project's own list (`cableCodes`) lacks hides nothing: the run
 * is drafted or offered all the same, and the cable-code lint (`lint.vocab`) flags its code there.
 */
export function parseLibraryCables(v: unknown): LibraryCable[] {
  if (!Array.isArray(v)) return [];
  const out: LibraryCable[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const code = str(r.code);
    if (!code) continue;
    const qty = typeof r.qty === 'number' && Number.isFinite(r.qty) ? r.qty : null;
    const status = typeof r.status === 'string' && STATUSES.includes(r.status) ? (r.status as ConnectionStatus) : null;
    out.push({ code, from: str(r.from), to: str(r.to), far: str(r.far), single_row: r.single_row === true, qty, status });
  }
  return out;
}

export function parseLibraryAccessories(v: unknown): LibraryAccessory[] {
  if (!Array.isArray(v)) return [];
  const out: LibraryAccessory[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const model = str(r.model);
    if (!model) continue;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const a: LibraryAccessory = { model, expected_qty: num(r.expected_qty) };
    if (num(r.max_quantity) !== null) a.max_quantity = num(r.max_quantity);
    const g = r.group && typeof r.group === 'object' ? (r.group as Record<string, unknown>) : null;
    if (g && str(g.label) && num(g.min) !== null) a.group = { label: str(g.label)!, min: num(g.min)!, max: num(g.max) };
    out.push(a);
  }
  return out;
}

const modelKey = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** What `findDeviceType` reads of a type; the app's own rows satisfy it too. */
export type TypeLike = Pick<LibraryTypeRow, 'id' | 'model' | 'aliases' | 'state'>;

/**
 * Types by model key (model and every alias), built once per `types` map and kept beside it
 * (T131). With the catalogue in the library (≈ 1,130 rows, ~3 aliases each) a scan per device
 * cost a rules run half a second on the PC and seconds on the iPad; the index makes a lookup a
 * map get. The maps this is called with are built per load and never mutated afterwards; a map
 * whose size changed is re-indexed all the same.
 */
const KEY_INDEX = new WeakMap<ReadonlyMap<string, TypeLike>, { size: number; byKey: Map<string, TypeLike[]> }>();

function keyIndex<T extends TypeLike>(types: ReadonlyMap<string, T>): Map<string, T[]> {
  const cached = KEY_INDEX.get(types);
  if (cached && cached.size === types.size) return cached.byKey as Map<string, T[]>;
  const byKey = new Map<string, T[]>();
  const add = (k: string, t: T) => {
    const list = byKey.get(k);
    if (list) {
      if (!list.includes(t)) list.push(t);
    } else byKey.set(k, [t]);
  };
  for (const t of types.values()) {
    add(modelKey(t.model), t);
    for (const a of t.aliases ?? []) if (typeof a === 'string') add(modelKey(a), t);
  }
  KEY_INDEX.set(types, { size: types.size, byKey });
  return byKey;
}

/**
 * The type a device belongs to among `types` (the app library's live rows, T196): its
 * `library_type_id`, else a not rejected type whose model or alias matches its Device text, the
 * first by id when two do.
 */
export function findDeviceType<T extends TypeLike>(types: ReadonlyMap<string, T>, d: Pick<DeviceRow, 'library_type_id' | 'device'>): T | null {
  if (d.library_type_id) return types.get(d.library_type_id) ?? null;
  const text = str(d.device);
  if (!text) return null;
  const matches = (keyIndex(types).get(modelKey(text)) ?? []).filter((t) => t.state !== 'rejected').sort((a, b) => a.id.localeCompare(b.id));
  return matches[0] ?? null;
}

/** The type a device belongs to: its `library_type_id`, else a live, not rejected type matching its Device text. */
export function typeOfDevice(ctx: RuleContext, d: DeviceRow): LibraryTypeRow | null {
  return findDeviceType(ctx.index.libraryType, d);
}

/**
 * The device's role (T112, D201): its type's `role`, else the role its type's category implies,
 * else its own category's (`roleOf` in core). What R2e, R2g's 120V To text, the lints and the
 * Neuron ID default key on instead of the master's category strings.
 */
export function deviceRole(ctx: RuleContext, d: DeviceRow): Role {
  return roleOf(typeOfDevice(ctx, d), d);
}

// ------------------------------------------------------------------ addresses (T146, D245)

/** The three addresses a device may need: Neuron ID (Unison), IP address (network), DMX address. */
export type AddressKind = 'neuron' | 'ip' | 'dmx';
export const ADDRESS_KINDS: readonly AddressKind[] = ['neuron', 'ip', 'dmx'];

export interface AddressNeeds {
  neuron: boolean;
  ip: boolean;
  dmx: boolean;
}

/** The device column each kind is stored in, the type's override flag, and the `R3c` code map. */
export const ADDRESS_FIELD: Readonly<Record<AddressKind, 'neuron_id' | 'ip_address' | 'dmx_address'>> = { neuron: 'neuron_id', ip: 'ip_address', dmx: 'dmx_address' };
export const ADDRESS_FLAG: Readonly<Record<AddressKind, 'needs_neuron_id' | 'needs_ip_address' | 'needs_dmx_address'>> = { neuron: 'needs_neuron_id', ip: 'needs_ip_address', dmx: 'needs_dmx_address' };
export const ADDRESS_CODES_KEY: Readonly<Record<AddressKind, 'neuron_codes' | 'ip_codes' | 'dmx_codes'>> = { neuron: 'neuron_codes', ip: 'ip_codes', dmx: 'dmx_codes' };
/** How each kind is named in messages ("3 devices still without a Neuron ID"). */
export const ADDRESS_LABEL: Readonly<Record<AddressKind, string>> = { neuron: 'Neuron ID', ip: 'IP address', dmx: 'DMX address' };
export const ADDRESS_ARTICLE: Readonly<Record<AddressKind, string>> = { neuron: 'a Neuron ID', ip: 'an IP address', dmx: 'a DMX address' };

/** Roles whose devices carry no Neuron ID unless their type says so (T68, D185): they host the Unison pair without a Neuron chip. */
export const NO_NEURON_ROLES: readonly Role[] = ['equipment_rack', 'nsps'];

/** Roles whose wire is the `Stations & Sensors` placeholder end (D50, R2e): always on their level's Unison pair. */
export const BUS_ROLES: readonly Role[] = ['station', 'sensor'];

/** What `addressNeeds` reads of a type; the app's own rows satisfy it too. */
export type AddressTypeLike = {
  needs_neuron_id?: boolean | null;
  needs_ip_address?: boolean | null;
  needs_dmx_address?: boolean | null;
  category?: string | null;
  role?: unknown;
  state?: string;
  default_cables?: unknown;
};

/**
 * Which addresses a device needs (T146, D245, D246, D247): read off the **wires it gets** — the
 * codes of its live cable ends (`codes`, any end status: an unpulled run still lands here), else,
 * for a device with no cable record, the codes of its required cables (`required`: its accepted
 * type's default cables and its carried accessories', `cablesOfDevice`, D288 (2); without it the
 * type's default cables alone) — through
 * the `R3c.neuron_codes` / `ip_codes` / `dmx_codes` maps (U → Neuron ID, N / NG → IP address,
 * X → DMX address by default). A `station` / `sensor` role device always counts as on its
 * level's Unison pair (its wire is the `Stations & Sensors` placeholder end, never a cable end
 * of its own). The type's explicit flag (true / false) overrides; null means "by the wires". An
 * `nsps` / `equipment_rack` hosts the Unison pair but carries no Neuron chip, so its U end counts
 * for nothing unless its type says Needed (D185's exception, kept).
 */
export function addressNeeds(
  type: AddressTypeLike | null,
  d: { category: string | null },
  codes: Iterable<string> | null | undefined,
  params: RuleParams = DEFAULT_PARAMS,
  required?: Iterable<string> | null,
): AddressNeeds {
  const role = roleOf(type, d);
  const wires = new Set(codes ?? []);
  if (!wires.size) {
    if (required) for (const c of required) wires.add(c);
    else if (type && type.state === 'accepted') for (const c of parseLibraryCables(type.default_cables)) wires.add(c.code);
  }
  if (BUS_ROLES.includes(role)) wires.add('U');
  const need = (kind: AddressKind): boolean => {
    const flag = type?.[ADDRESS_FLAG[kind]];
    if (flag != null) return flag;
    if (kind === 'neuron' && NO_NEURON_ROLES.includes(role)) return false;
    for (const c of wires) if (params.flagCode('R3c', ADDRESS_CODES_KEY[kind], c)) return true;
    return false;
  };
  return { neuron: need('neuron'), ip: need('ip'), dmx: need('dmx') };
}

/** Whether a device needs a Neuron ID: `addressNeeds(…).neuron` (the name T68 gave it; D185 (2)). */
export function needsNeuronId(type: AddressTypeLike | null, d: { category: string | null }, codes?: Iterable<string> | null, params?: RuleParams): boolean {
  return addressNeeds(type, d, codes, params).neuron;
}

/** The codes of the device's live cable ends. */
export function deviceCodes(ctx: RuleContext, d: Pick<DeviceRow, 'id'>): string[] {
  const out: string[] = [];
  for (const e of ctx.index.endsByDevice.get(d.id) ?? []) {
    const code = cableOf(ctx, e)?.cable;
    if (code) out.push(code);
  }
  return out;
}

/** `addressNeeds` with the device's type, wires and required cables looked up in the snapshot. */
export function deviceAddressNeeds(ctx: RuleContext, d: DeviceRow): AddressNeeds {
  const plan = deviceCables(ctx, d);
  return addressNeeds(plan.type, d, deviceCodes(ctx, d), ctx.params, plan.required.map((r) => r.cable.code));
}

/** `deviceAddressNeeds(…).neuron`. */
export function deviceNeedsNeuronId(ctx: RuleContext, d: DeviceRow): boolean {
  return deviceAddressNeeds(ctx, d).neuron;
}

// ------------------------------------------------------------------ a device's cables (T199, D288, D292)

/** What `cablesOfDevice` reads of a type; the app's own rows satisfy it too. */
export type CableTypeLike = TypeLike & { default_cables?: unknown; optional_cables?: unknown; optional_accessories?: unknown };

/** An accessory row of a device, as the snapshot and the card both hold it. */
export interface CarriedRow {
  model: string | null;
  expected_qty?: number | null;
  found_qty?: number | null;
}

/** One run a device takes, and where the Library says so. */
export interface DeviceCable {
  cable: LibraryCable;
  /** The library type the row is on: the device's own, or a carried accessory's. */
  typeId: string;
  /** The accessory that adds it (its type's model); null = the device's own type. */
  via: string | null;
}

/** An accessory the device carries: a row matched to a library type, or a forced slot with no row. */
export interface CarriedAccessory<T> {
  type: T;
  model: string;
  /** How many: the rows' expected (else found, else 1) quantities, or the forced slot's. */
  count: number;
  /** Part of the device with no accessory row: a slot with its own expected quantity (D288 (3)). */
  forced: boolean;
}

export interface DeviceCables<T> {
  /** The device's type (`findDeviceType`), also when it is a draft or rejected. */
  type: T | null;
  /** Runs the device must have: default cables of its accepted type and its accepted carried accessories. */
  required: DeviceCable[];
  /** Runs it may have: optional cables, and every row of a draft type (offered, never drafted). */
  optional: DeviceCable[];
  carried: CarriedAccessory<T>[];
  /** Accessory slots of the type the device does not carry, with the codes each would add (D288 (4)). */
  absent: { model: string; codes: string[] }[];
}

const positive = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/**
 * An accessory's row × the number carried (D288 (2)): a single-row run (P, 0-10V, 120V, D: one
 * row per device) keeps one row with its quantity multiplied — two 24-channel 0-10V cards are
 * one `0-10V` row of 48; any other run is that many runs.
 */
function times(c: LibraryCable, n: number): LibraryCable[] {
  if (n <= 1) return [c];
  if (c.single_row) return [{ ...c, qty: c.qty == null ? null : c.qty * n }];
  return Array.from({ length: n }, () => c);
}

/** The codes an accessory type's rows name (default and optional), each once. */
export function accessoryCodes(type: CableTypeLike): string[] {
  return [...new Set([...parseLibraryCables(type.default_cables), ...parseLibraryCables(type.optional_cables)].map((c) => c.code))];
}

/**
 * **The one function that gives a device's cables** (T199, D288 (2), (3); D292 (1), (3)): its
 * type's, plus those of every accessory it carries.
 *
 * - **Carried:** each accessory row of the device whose model names a library type (model or
 *   alias, through the indexed lookup), × the row's expected quantity, else its found one, else 1
 *   — a row counts whether the accessory was found or not; and each slot of the type with an
 *   expected quantity ≥ 1 of its own (the UH10002's faceplate, the ERn2's processor, an NSPS
 *   kit's supply), with no row needed: it is part of the device. The alternatives of a
 *   choose-among group (D202: "one of these back boxes") carry no expected quantity of their
 *   own, so none counts until its row exists. A row wins over its slot.
 * - **Required / optional:** an **accepted** type's `default_cables` are required and its
 *   `optional_cables` optional, the device's own type and each carried accessory's alike; a
 *   **draft** type's rows are all optional (D183 (2), D288 (2)); a rejected type gives nothing.
 * - **Absent:** the type's other slots, with what each would add — a device does not take those
 *   cables (`lint.cable_needs_accessory`), and the Library shows them beside the slot.
 *
 * Pure: `types` is the app library's live rows (the rules' index or the app's own map).
 */
export function cablesOfDevice<T extends CableTypeLike>(types: ReadonlyMap<string, T>, d: Pick<DeviceRow, 'library_type_id' | 'device'>, rows: readonly CarriedRow[] = []): DeviceCables<T> {
  const type = findDeviceType(types, d);
  const named = (model: string | null | undefined): T | null => {
    const t = model ? findDeviceType(types, { device: model, library_type_id: null }) : null;
    return t && t.id !== type?.id ? t : null;
  };
  const carried = new Map<string, CarriedAccessory<T>>();
  for (const r of rows) {
    const t = named(r.model);
    if (!t) continue;
    const n = positive(r.expected_qty) ?? positive(r.found_qty) ?? 1;
    const have = carried.get(t.id);
    if (have) have.count += n;
    else carried.set(t.id, { type: t, model: t.model, count: n, forced: false });
  }
  const absent: { model: string; codes: string[] }[] = [];
  const seenAbsent = new Set<string>();
  if (type && type.state !== 'rejected') {
    for (const s of parseLibraryAccessories(type.optional_accessories)) {
      const t = named(s.model);
      if (!t || carried.has(t.id) || seenAbsent.has(t.id)) continue;
      const forced = positive(s.expected_qty);
      if (forced !== null) {
        carried.set(t.id, { type: t, model: t.model, count: forced, forced: true });
        continue;
      }
      seenAbsent.add(t.id);
      const codes = accessoryCodes(t);
      if (codes.length) absent.push({ model: t.model, codes });
    }
  }
  const required: DeviceCable[] = [];
  const optional: DeviceCable[] = [];
  const add = (t: T, via: string | null, n: number) => {
    if (t.state === 'rejected') return;
    const put = (list: DeviceCable[], cables: LibraryCable[]) => {
      for (const c of cables) for (const x of times(c, n)) list.push({ cable: x, typeId: t.id, via });
    };
    put(t.state === 'accepted' ? required : optional, parseLibraryCables(t.default_cables));
    put(optional, parseLibraryCables(t.optional_cables));
  };
  if (type) add(type, null, 1);
  const list = [...carried.values()].sort((a, b) => a.type.id.localeCompare(b.type.id));
  for (const c of list) add(c.type, c.model, c.count);
  return { type, required, optional, carried: list, absent };
}

/** `cablesOfDevice` per device, once per rules run. */
const DEVICE_CABLES = new WeakMap<object, Map<string, DeviceCables<LibraryTypeRow>>>();

/** The device's cables in the snapshot: its type's and its carried accessories' (`cablesOfDevice`). */
export function deviceCables(ctx: RuleContext, d: DeviceRow): DeviceCables<LibraryTypeRow> {
  let cache = DEVICE_CABLES.get(ctx.index);
  if (!cache) DEVICE_CABLES.set(ctx.index, (cache = new Map()));
  let plan = cache.get(d.id);
  if (!plan) cache.set(d.id, (plan = cablesOfDevice(ctx.index.libraryType, d, ctx.index.accessoriesByDevice.get(d.id) ?? [])));
  return plan;
}

/**
 * A library run with the texts its row leaves empty filled from the per-code settings (T199, D290
 * (3), D293): From `R2g.from`, To `R2g.to` — a 120V run by what it feeds first (`R2g.to_120v`, the
 * device's role) — the far end `R2g.far` and the starting status `R2g.status`. A text typed on
 * the row wins. A panic run has no far end and no To among the defaults: it runs to a device a
 * person picks, never to a generic label (D293 (1), D294). `params` are the settings read, for
 * the proposal's `params`.
 */
export function fillLibraryCable(c: LibraryCable, role: Role, params: RuleParams = DEFAULT_PARAMS): { cable: LibraryCable; params: ParamRef[] } {
  const refs: ParamRef[] = [];
  const read = (key: string, k: string = c.code): string | null => {
    refs.push(['R2g', key, k]);
    const v = params.entry('R2g', key, k);
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };
  const from = c.from ?? read('from');
  const to = c.to ?? (c.code === '120V' ? read('to_120v', role) : null) ?? read('to');
  const far = c.far ?? read('far');
  let status = c.status;
  if (!status) {
    const s = read('status');
    status = s && STATUSES.includes(s) ? (s as ConnectionStatus) : null;
  }
  return { cable: { ...c, from, to, far, status }, params: refs };
}

/** The first (by id) of `placeholders` labelled `label`, case-insensitively. */
export function placeholderLabelled<P extends Pick<PlaceholderRow, 'id' | 'label' | 'level_id'>>(placeholders: Iterable<P>, label: string): P | null {
  const k = label.toLowerCase();
  return [...placeholders].sort((a, b) => a.id.localeCompare(b.id)).find((p) => p.label.toLowerCase() === k) ?? null;
}

/**
 * The `cable` proposal payload of one library run on a device (`decide.ts`): the cable with the
 * template's code / qty / single row, the device end with its From / To texts, and the far end on
 * the placeholder labelled `far` (else text only). R2g's drafts and the card's "+ add" (T105) both
 * build it here.
 */
export function libraryCablePayload(
  d: Pick<DeviceRow, 'id' | 'level_id' | 'panel_name' | 'device' | 'display_id'>,
  c: LibraryCable,
  placeholders: Iterable<Pick<PlaceholderRow, 'id' | 'label' | 'level_id'>>,
): { cable: Record<string, unknown>; ends: Record<string, unknown>[] } {
  const ph = c.far ? placeholderLabelled(placeholders, c.far) : null;
  const near: Record<string, unknown> = {
    side: 'A', endpoint_kind: 'device', device_id: d.id, level_id: d.level_id,
    from_text: c.from ?? str(d.panel_name) ?? str(d.device) ?? str(d.display_id), to_text: c.to,
    ...(c.status ? { status: c.status, status_source: 'derived' } : {}),
  };
  const far: Record<string, unknown> = ph
    ? { side: 'B', endpoint_kind: 'placeholder', placeholder_id: ph.id, level_id: ph.level_id, from_text: c.far, to_text: null }
    : { side: 'B', endpoint_kind: null, level_id: d.level_id, from_text: c.far, to_text: null };
  return { cable: { cable: c.code, qty: c.qty, single_row: c.single_row, origin: 'library', endpoint_confirmed: true }, ends: [near, far] };
}

/** `120V → P-NSPS-D Power Supply`: a library run (or a `cable` payload) as the card names it. */
export function cableTitle(code: string | null, to: string | null, far: string | null): string {
  return `${code ?? 'cable'} → ${to ?? far ?? 'its far end'}`;
}

function countCode(ctx: RuleContext, d: DeviceRow, code: string): number {
  return (ctx.index.endsByDevice.get(d.id) ?? []).filter((e) => cableOf(ctx, e)?.cable === code).length;
}

export const R2g: Rule = {
  id: 'R2g',
  title: 'Device-type library cables',
  text: "A device's cables come from the Library (D290): the default cables of its accepted type, and of the accessories it carries (D288), are offered as drafts where the device lacks them. A run whose row gives no text takes its From / To / far end / starting status from the per-code settings (0-10V → Fixtures; 120V from 120v Power, To by what it feeds); a panic run's far end is left for a person to pick (D294). Optional cables are offered on the card, never drafted (D292 (3)). Unison (U) stays per level (R2e).",
  run(ctx) {
    for (const d of ctx.index.device.values()) {
      const plan = deviceCables(ctx, d);
      if (!plan.required.length) continue;
      const role = roleOf(plan.type, d);
      const seen = new Map<string, number>();
      for (const r of plan.required) {
        const code = r.cable.code;
        if (code === 'U') continue;
        const n = seen.get(code) ?? 0;
        seen.set(code, n + 1);
        if (countCode(ctx, d, code) > n) continue; // the device already has this run
        const { cable, params } = fillLibraryCable(r.cable, role, ctx.params);
        const title = cableTitle(cable.code, cable.to, cable.far);
        ctx.propose({
          subject: { entity_kind: 'device', entity_id: d.id, level_id: d.level_id },
          discriminator: n === 0 ? code : `${code}#${n + 1}`,
          kind: 'cable',
          payload: libraryCablePayload(d, cable, ctx.index.placeholder.values()),
          inputs: { device: d.id, type: r.typeId, cable: r.cable },
          params,
          why: r.via ? `${deviceLabel(ctx, d)} carries ${r.via} (library: ${title}).` : `${deviceLabel(ctx, d)} is a ${plan.type!.model} (library: ${title}).`,
        });
      }
    }
  },
};
