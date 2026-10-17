/**
 * Place devices from the unplaced list (T46, Phase 3 §3.4): what is still to be put on a level's
 * plan, the panel pins proposed from the sheet's text tags, and the progress per level. Pure: a
 * `Store` in, plain rows out; no React or Expo imports, tested in Node.
 *
 * The unplaced list of a level (D205):
 * - **Devices** of the level with no pin on any sheet — the seeded master's, a device added from
 *   Needs review — listed by their ID; placing one only sets its pin.
 * - **Draft units**: accepted / edited device drafts of the level, and the **pool** (drafts with no
 *   level, offered on every in-scope level), with units left = qty − devices placed from the draft
 *   (`baseline_ref_id`) − devices of the level already standing for it. A device stands for a
 *   draft when it carries the draft's panel tag, else when it has the draft's model, and it was not
 *   placed from another draft; each device stands for one draft at most (drafts in id order). So
 *   reviewing a level seeded from the master never lists its panels twice (D193 (1)).
 * - A draft flagged **not on this sheet** (`draft_device.not_on_sheet`) leaves the list for the
 *   Flagged section until it is unflagged.
 */

import { canonicalCategory, isRole, type Role, type SheetFeatures, type Store } from '@field-survey/core';

export type Point = { x: number; y: number };

import { loadDeviceTypes, roleOfDevice, typeForDraft, type DeviceTypes } from '../library/neuron';

// ------------------------------------------------------------------ shapes

export type DraftAccessory = { model: string; qty: number | null; role: string; sourceRef: Record<string, unknown> | null };

type ItemBase = {
  /** `device:<id>` or `draft:<id>`: one row of the list. */
  key: string;
  /** What the row says first: the ID for a device, the panel tag or model for a draft. */
  title: string;
  model: string | null;
  category: string | null;
  role: Role;
  /** The panel tag (`CT06LCPA`) — the device's `panel_name`, the draft's `name`. */
  panelName: string | null;
};

export type UnplacedDevice = ItemBase & {
  kind: 'device';
  deviceId: string;
  levelId: string;
  /** `06M-04`, or `06M-?` while the server has not numbered it (D93). */
  label: string;
  isNew: boolean;
  room: string | null;
  drawingPosition: string | null;
};

export type UnplacedDraft = ItemBase & {
  kind: 'draft';
  draftId: string;
  /** null = the pool: the level comes from the sheet it is placed on. */
  levelId: string | null;
  pool: boolean;
  qty: number;
  /** Devices made from it (any level, for the pool). */
  placed: number;
  /** Devices of its level already standing for it (the master's). */
  covered: number;
  remaining: number;
  notOnSheet: boolean;
  /** The library type it will get (`typeForDraft`, T115), if the library has one. */
  libraryTypeId: string | null;
  /** The type's category, else the draft's (canonical). */
  deviceCategory: string | null;
  accessories: DraftAccessory[];
  name: string | null;
};

export type UnplacedItem = UnplacedDevice | UnplacedDraft;

export type LevelPlacement = {
  levelId: string;
  code: string;
  inScope: boolean;
  /** Live devices of the level. */
  devices: number;
  /** …with a pin on some sheet. */
  placed: number;
  /** Live devices with no pin (the list's device rows). */
  unplacedDevices: number;
  /** Units still to place from the level's own drafts (flagged ones left out). */
  draftUnits: number;
  /** Drafts of the level flagged not on this sheet, with units left. */
  flagged: number;
};

export type PlacementProgress = {
  levels: LevelPlacement[];
  /** The pool: units left across its drafts, and the flagged ones. */
  pool: { draftUnits: number; flagged: number };
};

export type LevelUnplaced = {
  levelId: string;
  code: string;
  /** Device rows and draft rows with units left, level drafts before the pool; flagged left out. */
  items: UnplacedItem[];
  /** Drafts flagged not on this sheet (level and pool), with units left. */
  flagged: UnplacedDraft[];
  progress: LevelPlacement;
};

// ------------------------------------------------------------------ small parsers

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const truthy = (v: unknown): boolean => v === true || v === 1;

function json<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

/** Model and tag comparison: spaces ignored, any case. */
export const tagKey = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase();

function pinOf(v: unknown): { sheet: string; x: number; y: number } | null {
  const p = json<Row>(v);
  if (!p) return null;
  const sheet = str(p.sheet);
  const x = num(p.x);
  const y = num(p.y);
  return sheet && x != null && y != null ? { sheet, x, y } : null;
}

function accessoriesOf(v: unknown): DraftAccessory[] {
  return (json<Row[]>(v) ?? [])
    .filter((a): a is Row => !!a && typeof a === 'object')
    .map((a) => ({ model: str(a.model) ?? '?', qty: num(a.qty), role: str(a.role) ?? 'accessory', sourceRef: json<Row>(a.source_ref) }));
}

// ------------------------------------------------------------------ the computation

type LevelRow = { id: string; level: string; in_scope: unknown };

type DeviceRec = {
  id: string;
  levelId: string;
  displayId: string | null;
  category: string | null;
  device: string | null;
  panelName: string | null;
  room: string | null;
  drawingPosition: string | null;
  pinned: boolean;
  baselineRef: string | null;
  role: Role;
};

type DraftRec = {
  id: string;
  levelId: string | null;
  levelCode: string | null;
  model: string | null;
  name: string | null;
  category: string | null;
  role: Role | null;
  qty: number;
  notOnSheet: boolean;
  accessories: DraftAccessory[];
};

type Computed = {
  levels: LevelRow[];
  devices: DeviceRec[];
  drafts: (DraftRec & { placed: number; covered: number; remaining: number; typeId: string | null; typeRole: Role; deviceCategory: string | null })[];
};

async function compute(store: Store, projectId: string): Promise<Computed> {
  const levels = await store.list<LevelRow>('level', { where: 'project_id = ?', params: [projectId], orderBy: 'floor_order, level' });
  const types = await loadDeviceTypes(store, projectId);
  const rawDevices = await store.db.query<Row>(
    `SELECT d.id, d.level_id, d.display_id, d.category, d.device, d.panel_name, d.room_location, d.drawing_position, d.pin, d.baseline_ref_id, d.library_type_id
       FROM device d JOIN level l ON l.id = d.level_id
      WHERE l.project_id = ? AND d.deleted_at IS NULL`,
    [projectId],
  );
  const devices: DeviceRec[] = rawDevices.map((d) => ({
    id: String(d.id),
    levelId: String(d.level_id),
    displayId: str(d.display_id),
    category: str(d.category),
    device: str(d.device),
    panelName: str(d.panel_name),
    room: str(d.room_location),
    drawingPosition: str(d.drawing_position),
    pinned: pinOf(d.pin) !== null,
    baselineRef: str(d.baseline_ref_id),
    role: roleOfDevice(types, d),
  }));

  const rawDrafts = await store.list<Row>('draft_device', {
    where: `project_id = ? AND state IN ('accepted', 'edited')`,
    params: [projectId],
    orderBy: 'id',
  });
  const draftIds = new Set(rawDrafts.map((d) => String(d.id)));
  const placedBy = new Map<string, number>();
  for (const d of devices) if (d.baselineRef) placedBy.set(d.baselineRef, (placedBy.get(d.baselineRef) ?? 0) + 1);

  // devices that may stand for a draft of their level: not placed from a draft of this project
  const free = new Map<string, DeviceRec[]>();
  for (const d of devices) {
    if (d.baselineRef && draftIds.has(d.baselineRef)) continue;
    free.set(d.levelId, [...(free.get(d.levelId) ?? []), d]);
  }
  const claimed = new Set<string>();

  const drafts: Computed['drafts'] = [];
  for (const r of rawDrafts) {
    const ref = json<Row>(r.source_ref);
    const rec: DraftRec = {
      id: String(r.id),
      levelId: str(r.level_id),
      levelCode: str(ref?.level_code),
      model: str(r.model),
      name: str(r.name),
      category: str(r.category),
      role: isRole(r.role) ? r.role : null,
      qty: Math.max(0, num(r.qty) ?? 1),
      notOnSheet: truthy(r.not_on_sheet),
      accessories: accessoriesOf(r.accessories),
    };
    // a floor the project lacks (`code:09`) is nowhere to place it
    if (!rec.levelId && rec.levelCode) continue;
    const placed = placedBy.get(rec.id) ?? 0;
    const { type, role } = typeForDraft(types, rec);
    let covered = 0;
    if (rec.levelId) {
      const want = Math.max(0, rec.qty - placed);
      const pool = (free.get(rec.levelId) ?? []).filter((d) => !claimed.has(d.id));
      const tag = tagKey(rec.name);
      const model = tagKey(rec.model);
      // as `deviceForDraft`: the panel tag first (the riser names panels by it; a rack by its
      // Device text), then the model, then — for one unit — the only device of its role
      const byTag = tag ? pool.filter((d) => tagKey(d.panelName) === tag || tagKey(d.device) === tag) : [];
      const byModel = model ? pool.filter((d) => tagKey(d.device) === model && !byTag.includes(d)) : [];
      const sameRole = pool.filter((d) => d.role === role);
      const byRole = rec.qty === 1 && role !== 'other' && !byTag.length && !byModel.length && sameRole.length === 1 ? sameRole : [];
      for (const d of [...byTag, ...byModel, ...byRole]) {
        if (covered >= want) break;
        claimed.add(d.id);
        covered++;
      }
    }
    drafts.push({
      ...rec,
      placed,
      covered,
      remaining: Math.max(0, rec.qty - placed - covered),
      typeId: type?.id ?? null,
      typeRole: role,
      deviceCategory: canonicalCategory(type?.category ?? null) ?? canonicalCategory(rec.category) ?? rec.category,
    });
  }
  return { levels, devices, drafts };
}

const inScope = (l: LevelRow) => l.in_scope !== 0 && l.in_scope !== false;

function progressOf(c: Computed, l: LevelRow): LevelPlacement {
  const mine = c.devices.filter((d) => d.levelId === l.id);
  const drafts = c.drafts.filter((d) => d.levelId === l.id && d.remaining > 0);
  return {
    levelId: l.id,
    code: l.level,
    inScope: inScope(l),
    devices: mine.length,
    placed: mine.filter((d) => d.pinned).length,
    unplacedDevices: mine.filter((d) => !d.pinned).length,
    draftUnits: drafts.filter((d) => !d.notOnSheet).reduce((n, d) => n + d.remaining, 0),
    flagged: drafts.filter((d) => d.notOnSheet).length,
  };
}

/** Progress of every level (Setup → 5 Place devices, the Lock table, Needs review). */
export async function loadPlacementProgress(store: Store, projectId: string): Promise<PlacementProgress> {
  const c = await compute(store, projectId);
  const pool = c.drafts.filter((d) => !d.levelId && d.remaining > 0);
  return {
    levels: c.levels.map((l) => progressOf(c, l)),
    pool: { draftUnits: pool.filter((d) => !d.notOnSheet).reduce((n, d) => n + d.remaining, 0), flagged: pool.filter((d) => d.notOnSheet).length },
  };
}

function draftTitle(d: { name: string | null; model: string | null; category: string | null }): string {
  return d.name ?? d.model ?? d.category ?? 'Draft device';
}

/** The unplaced list of one level: its pinless devices, its draft units, then the pool's. */
export async function loadUnplaced(store: Store, projectId: string, levelId: string): Promise<LevelUnplaced | null> {
  const c = await compute(store, projectId);
  const level = c.levels.find((l) => l.id === levelId);
  if (!level) return null;
  const devices: UnplacedDevice[] = c.devices
    .filter((d) => d.levelId === levelId && !d.pinned)
    .map((d): UnplacedDevice => ({
      kind: 'device',
      key: `device:${d.id}`,
      deviceId: d.id,
      levelId: d.levelId,
      label: d.displayId ?? `${level.level}-?`,
      isNew: !d.displayId,
      title: d.displayId ?? `${level.level}-?`,
      model: d.device,
      category: d.category,
      role: d.role,
      panelName: d.panelName,
      room: d.room,
      drawingPosition: d.drawingPosition,
    }))
    .sort((a, b) => Number(a.isNew) - Number(b.isNew) || a.label.localeCompare(b.label, 'en', { numeric: true }));
  const draftItem = (d: Computed['drafts'][number]): UnplacedDraft => ({
    kind: 'draft',
    key: `draft:${d.id}`,
    draftId: d.id,
    levelId: d.levelId,
    pool: !d.levelId,
    title: draftTitle(d),
    model: d.model,
    name: d.name,
    category: d.category,
    role: d.typeRole,
    panelName: d.name,
    qty: d.qty,
    placed: d.placed,
    covered: d.covered,
    remaining: d.remaining,
    notOnSheet: d.notOnSheet,
    libraryTypeId: d.typeId,
    deviceCategory: d.deviceCategory,
    accessories: d.accessories,
  });
  const order = (a: UnplacedDraft, b: UnplacedDraft) => Number(a.pool) - Number(b.pool) || a.title.localeCompare(b.title, 'en', { numeric: true }) || a.draftId.localeCompare(b.draftId);
  const drafts = c.drafts.filter((d) => (d.levelId === levelId || (!d.levelId && inScope(level))) && d.remaining > 0).map(draftItem).sort(order);
  return {
    levelId,
    code: level.level,
    items: [...devices, ...drafts.filter((d) => !d.notOnSheet)],
    flagged: drafts.filter((d) => d.notOnSheet),
    progress: progressOf(c, level),
  };
}

// ------------------------------------------------------------------ list filters

export type PlaceScope = 'level' | 'pool' | 'flagged';

/** The rows a scope and a role filter keep. */
export function itemsIn(u: LevelUnplaced, scope: PlaceScope, role: Role | null = null): UnplacedItem[] {
  const rows = scope === 'flagged' ? u.flagged : u.items.filter((i) => (scope === 'pool' ? i.kind === 'draft' && i.pool : !(i.kind === 'draft' && i.pool)));
  return role ? rows.filter((i) => i.role === role) : rows;
}

/** The roles present in the list, for the Type filter. */
export function rolesIn(u: LevelUnplaced): Role[] {
  return [...new Set([...u.items, ...u.flagged].map((i) => i.role))].sort();
}

/** Units an item stands for in the list: 1 for a device, the units left for a draft. */
export const unitsOf = (i: UnplacedItem): number => (i.kind === 'device' ? 1 : i.remaining);

/** How a row reads: `06M-04 · ERP48 CT06LCPA`, `PI1002 · pool ×120`. */
export function itemLine(i: UnplacedItem): string {
  if (i.kind === 'device') return [i.label, i.panelName ?? i.model ?? i.category].filter(Boolean).join(' · ');
  const what = i.name && i.model && i.name !== i.model ? `${i.name} (${i.model})` : i.title;
  return `${what} · ${i.pool ? 'pool ' : ''}×${i.remaining}`;
}

// ------------------------------------------------------------------ proposals from text tags

/** Roles a sheet tag names (`CT06LCPA`, `EBDK`, `UFMP8`, `ERP48`, `NSPS`, rack parts — D147 (2)); stations and sensors are always placed by hand. */
export const TAGGED_ROLES: ReadonlySet<Role> = new Set<Role>(['relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps']);
/** Two tags of one text this close (pt) are one: the composite overlays its source sheets. */
export const TAG_SAME_PT = 24;
/** A tag this close (pt) to a pin already on the sheet is taken. */
export const TAG_TAKEN_PT = 30;

export type Proposal = { key: string; itemKey: string; at: Point; tag: string };

/**
 * Dashed pins proposed at the sheet's text tags (Phase 2 "Pre-placement", Phase 3 §3.4): a tag
 * whose text is an unplaced panel's tag or model (or one `-` part of the model of 4+ characters:
 * `ERP48` in `ERP48-FT-481P`, `NSPS` in `P-NSPS-D`), not next to a pin already on the sheet. Exact
 * matches are given out first; every tag goes to one item, every item gets as many tags as it has
 * units. Nothing is written until a person confirms one.
 */
export function tagProposals(features: Pick<SheetFeatures, 'tags'>, items: readonly UnplacedItem[], pins: readonly Point[]): Proposal[] {
  const tags: { text: string; key: string; at: Point }[] = [];
  for (const t of features.tags) {
    const key = tagKey(t.text);
    if (!key) continue;
    if (tags.some((o) => o.key === key && Math.hypot(o.at.x - t.x, o.at.y - t.y) <= TAG_SAME_PT)) continue;
    if (pins.some((p) => Math.hypot(p.x - t.x, p.y - t.y) <= TAG_TAKEN_PT)) continue;
    tags.push({ text: t.text, key, at: { x: t.x, y: t.y } });
  }
  const wanted = items.filter((i) => TAGGED_ROLES.has(i.role) && unitsOf(i) > 0);
  const left = new Map(wanted.map((i) => [i.key, unitsOf(i)]));
  const used = new Set<number>();
  const out: Proposal[] = [];
  const pass = (keysOf: (i: UnplacedItem) => string[]) => {
    for (const i of wanted) {
      const keys = new Set(keysOf(i).filter(Boolean));
      if (!keys.size) continue;
      tags.forEach((t, n) => {
        if ((left.get(i.key) ?? 0) <= 0 || used.has(n) || !keys.has(t.key)) return;
        used.add(n);
        left.set(i.key, (left.get(i.key) ?? 0) - 1);
        out.push({ key: `${i.key}@${n}`, itemKey: i.key, at: t.at, tag: t.text });
      });
    }
  };
  pass((i) => [tagKey(i.panelName), tagKey(i.model)]);
  pass((i) => (i.model ?? '').split('-').map(tagKey).filter((k) => k.length >= 4));
  return out;
}

export type { DeviceTypes };
