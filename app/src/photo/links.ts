/**
 * Photo links (T65, D128): a photo keeps `device_id` (the device it was taken from) and links to
 * further devices, connection ends and punch items through `photo_link` (`link_add` /
 * `link_remove`, like `part_source`). T21 photos and the seed import also carry one link in the
 * legacy `punch_item_id` / `cable_end_id` columns; both are read as links, new photos write
 * `photo_link` only. No React or Expo imports: runs in Node.
 *
 * - `linkOptions`: what the caption sheet's multi-select "Linked" picker lists — the photo
 *   device's connection ends, then the devices whose pins are within `NEARBY_PT` of its pin on
 *   the same sheet (nearest first) each with their ends, then the device's punch items, then any
 *   linked target not in that list (so it can still be unlinked).
 * - `photoStrip`: the photos of one device / connection end / punch item for a card or the end
 *   editor (their other links are not listed there, D134).
 */

import { displayNumber, type Store } from '@field-survey/core';

import type { CardPhoto } from '../card/model';

export type LinkKind = 'device' | 'cable_end' | 'punch';
export type LinkRef = { kind: LinkKind; id: string };
export type LinkOption = LinkRef & {
  label: string;
  /** Sheet points from the photo's device pin; 0 for its own ends and punch items, null = not on the plan. */
  distance: number | null;
};

/** D128 "close to one another": two inches of sheet (144 PDF points) around the photo's device pin. */
export const NEARBY_PT = 144;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const keyOf = (l: LinkRef) => `${l.kind}:${l.id}`;
const inList = (ids: readonly unknown[]) => ids.map(() => '?').join(', ');

export function sameLinks(a: readonly LinkRef[], b: readonly LinkRef[]): boolean {
  const ka = new Set(a.map(keyOf));
  return ka.size === new Set(b.map(keyOf)).size && b.every((l) => ka.has(keyOf(l)));
}

export function hasLink(links: readonly LinkRef[], l: LinkRef): boolean {
  return links.some((x) => x.kind === l.kind && x.id === l.id);
}

export function toggleLink(links: readonly LinkRef[], l: LinkRef): LinkRef[] {
  return hasLink(links, l) ? links.filter((x) => !(x.kind === l.kind && x.id === l.id)) : [...links, { kind: l.kind, id: l.id }];
}

/** Every link of a photo row: the legacy columns, then live `photo_link` rows (never its own device). */
export async function linksOf(store: Store, photo: Row): Promise<LinkRef[]> {
  const out: LinkRef[] = [];
  const add = (l: LinkRef) => {
    if (!(l.kind === 'device' && l.id === str(photo.device_id)) && !hasLink(out, l)) out.push(l);
  };
  if (str(photo.punch_item_id)) add({ kind: 'punch', id: String(photo.punch_item_id) });
  if (str(photo.cable_end_id)) add({ kind: 'cable_end', id: String(photo.cable_end_id) });
  for (const r of await store.list<Row>('photo_link', { where: 'photo_id = ?', params: [String(photo.id)], orderBy: 'rowid' })) {
    add({ kind: r.target_kind as LinkKind, id: String(r.target_id) });
  }
  return out;
}

/** Short names of link targets (`06M-05`, `C-07`, `#12`, `NEW`), by `kind:id`. */
export async function shortLabels(store: Store, refs: readonly LinkRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const levelCodes = new Map<string, string | null>();
  const levelCode = async (id: unknown) => {
    const k = String(id);
    if (!levelCodes.has(k)) levelCodes.set(k, str((await store.get<Row>('level', k))?.level));
    return levelCodes.get(k)!;
  };
  for (const r of refs) {
    const k = keyOf(r);
    if (out.has(k)) continue;
    if (r.kind === 'device') {
      const d = await store.get<Row>('device', r.id);
      out.set(k, d ? displayNumber('device', d, await levelCode(d.level_id)) : 'device');
    } else if (r.kind === 'cable_end') {
      const e = await store.get<Row>('cable_end', r.id);
      out.set(k, e ? displayNumber('cable_end', e) : 'end');
    } else {
      const p = await store.get<Row>('punch_item', r.id);
      const n = p ? displayNumber('punch_item', p) : '?';
      out.set(k, n === 'NEW' ? 'NEW' : `#${n}`);
    }
  }
  return out;
}

async function endOptions(store: Store, deviceId: string, prefix: string, distance: number | null): Promise<LinkOption[]> {
  const out: LinkOption[] = [];
  const ends = await store.list<Row>('cable_end', { where: 'device_id = ?', params: [deviceId], orderBy: 'display_id, id' });
  for (const e of ends) {
    const cable = await store.get<Row>('cable', String(e.cable_id));
    if (!cable || cable.deleted_at) continue;
    const text = `${displayNumber('cable_end', e)} ${str(cable.cable) ?? ''} → ${str(e.to_text) ?? '…'}`;
    out.push({ kind: 'cable_end', id: String(e.id), label: prefix ? `${prefix} · ${text}` : text, distance });
  }
  return out;
}

function pinOf(d: Row): { sheet: string; x: number; y: number } | null {
  const p = d.pin as Row | null;
  if (!p || typeof p !== 'object') return null;
  const x = num(p.x);
  const y = num(p.y);
  return x !== null && y !== null && str(p.sheet) ? { sheet: String(p.sheet), x, y } : null;
}

/** The caption sheet's link choices for a photo of `deviceId`; `linked` are kept even when far away. */
export async function linkOptions(store: Store, deviceId: string | null, linked: readonly LinkRef[] = [], radius = NEARBY_PT): Promise<LinkOption[]> {
  const out: LinkOption[] = [];
  const d = deviceId ? await store.get<Row>('device', deviceId) : null;
  if (d && deviceId) {
    out.push(...(await endOptions(store, deviceId, '', 0)));
    const pin = pinOf(d);
    if (pin) {
      const lv = await store.get<Row>('level', String(d.level_id));
      const near: { row: Row; distance: number }[] = [];
      for (const o of await store.list<Row>('device', { where: 'level_id = ? AND id <> ? AND pin IS NOT NULL', params: [String(d.level_id), deviceId] })) {
        const p = pinOf(o);
        if (!p || p.sheet !== pin.sheet) continue;
        const distance = Math.hypot(p.x - pin.x, p.y - pin.y);
        if (distance <= radius) near.push({ row: o, distance });
      }
      near.sort((a, b) => a.distance - b.distance);
      for (const { row, distance } of near) {
        const label = displayNumber('device', row, str(lv?.level));
        const model = [str(row.device), str(row.type)].filter(Boolean).join(' ') || str(row.category);
        out.push({ kind: 'device', id: String(row.id), label: model ? `${label} ${model}` : label, distance });
        out.push(...(await endOptions(store, String(row.id), label, distance)));
      }
    }
    const punch = await store.list<Row>('punch_item', { where: 'device_id = ?', params: [deviceId] });
    punch.sort((a, b) => Number(a.number ?? 1e9) - Number(b.number ?? 1e9));
    for (const p of punch) {
      const n = displayNumber('punch_item', p);
      out.push({ kind: 'punch', id: String(p.id), label: `${n === 'NEW' ? 'NEW' : `#${n}`} ${str(p.item) ?? ''}`.trim(), distance: 0 });
    }
  }
  const missing = linked.filter((l) => !hasLink(out, l) && !(l.kind === 'device' && l.id === deviceId));
  if (missing.length) {
    const labels = await shortLabels(store, missing);
    for (const l of missing) out.push({ ...l, label: labels.get(keyOf(l)) ?? l.kind, distance: null });
  }
  return out;
}

/**
 * The photos of a device (taken from it or linked to it), a connection end or a punch item, by
 * number, each with whether its bytes are still on this iPad only.
 */
export async function photoStrip(store: Store, target: LinkRef): Promise<CardPhoto[]> {
  const column = target.kind === 'device' ? 'device_id' : target.kind === 'cable_end' ? 'cable_end_id' : 'punch_item_id';
  const rows = await store.db.query<Row>(
    `SELECT * FROM photo WHERE deleted_at IS NULL AND (${column} = ? OR id IN (
       SELECT photo_id FROM photo_link WHERE deleted_at IS NULL AND target_kind = ? AND target_id = ?))`,
    [target.id, target.kind, target.id],
  );
  rows.sort((a, b) => Number(a.number ?? 1e9) - Number(b.number ?? 1e9) || String(a.id).localeCompare(String(b.id)));

  const images = rows.flatMap((p) => [str(p.image_blob), str(p.thumb_blob), str(p.markup_blob)]).filter((s): s is string => !!s);
  const waiting = new Set<string>();
  if (images.length) {
    for (const r of await store.db.query<{ sha256: string }>(`SELECT sha256 FROM blob WHERE upload_state <> 'complete' AND sha256 IN (${inList(images)})`, images)) {
      waiting.add(r.sha256);
    }
  }
  const out: CardPhoto[] = [];
  for (const p of rows) {
    out.push({
      id: String(p.id),
      label: displayNumber('photo', p),
      thumb: str(p.thumb_blob),
      image: str(p.image_blob),
      markup: str(p.markup_blob),
      subject: str(p.subject) ?? str(p.what_it_shows),
      waiting: [p.image_blob, p.thumb_blob, p.markup_blob].some((b) => !!str(b) && waiting.has(String(b))),
    });
  }
  return out;
}
