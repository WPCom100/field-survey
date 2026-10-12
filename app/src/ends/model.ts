/**
 * Read model of the connection end editor (T22, Phase 3 §4.5): one cable with both of its ends
 * stacked — the end the editor was opened on first — each with its endpoint (a device, possibly
 * on another level, or a placeholder), From/To text (D32), status, note and who surveyed it; plus
 * the riser label check. No React or Expo imports: runs in Node.
 */

import { displayNumber, reviewFields, type Store } from '@field-survey/core';

import type { CardPhoto, JumpTarget } from '../card/model';
import { photoStrip } from '../photo/links';

/** Chips under an end's note until T40 brings the project's `connection_note` vocabulary (CLAUDE.md §3). */
export const CONNECTION_PHRASES: readonly string[] = [
  'Not run',
  'Run, not terminated',
  'Run, not terminated; no term kit',
  'Not surveyed',
  'Waiting on DMX Termination Kits',
  'Reterminated - all good',
  'Land 0-10V control wiring',
  'Lands in ERP; needs to be run down to the NSPS below it',
];

export const CABLE_NAME: Readonly<Record<string, string>> = {
  X: 'DMX',
  N: 'network',
  NG: 'network + ground',
  U: 'Unison',
  F: 'fiber',
  P: 'panic',
  UV: 'UHCI-WM partition sensor',
  '0-10V': '0-10V',
  '120V': '120V',
};

export type EndEndpoint =
  | { kind: 'device'; deviceId: string; label: string; model: string | null; levelId: string; levelCode: string | null; deleted: boolean }
  | { kind: 'placeholder'; label: string }
  | { kind: 'none' };

export type EndView = {
  id: string;
  side: 'A' | 'B';
  /** `C-07`, or `NEW` until the server numbers it. */
  label: string;
  levelId: string | null;
  levelCode: string | null;
  endpoint: EndEndpoint;
  fromText: string | null;
  toText: string | null;
  status: string | null;
  note: string | null;
  surveyedBy: string | null;
  surveyedAt: string | null;
  statusSource: string | null;
  deleted: boolean;
  /** Fields with an open review item / an unsynced op of this iPad. */
  inReview: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  /** Where "Jump to" goes: the endpoint device (same level → select, else open its level). */
  jump: JumpTarget | null;
  /** Photos linked to this end (D128), with their other links named. */
  photos: CardPhoto[];
};

export type RiserCheck =
  | { state: 'none' }
  | { state: 'match'; riser: string }
  | { state: 'differs'; riser: string; to: string | null };

export type CableView = {
  id: string;
  code: string | null;
  qty: number | null;
  singleRow: boolean;
  riserToLabel: string | null;
  vertical: string | null;
  deleted: boolean;
  /** The end the editor was opened on, then the other (or null when the cable has one end). */
  ends: [EndView, EndView | null];
  riser: RiserCheck;
  phrases: readonly string[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function tokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

/**
 * Does the stored To text say what the riser says? Lenient on case, punctuation and leading zeros,
 * and a riser word may be the start of a longer To word (riser "DMX TO LEVEL 03 UFMP" matches To
 * "DMX to Level 3 UFMP4s", Phase 3 §4.5), but every riser word must appear, in order.
 */
export function riserCheck(riserLabel: string | null, toText: string | null): RiserCheck {
  if (!riserLabel?.trim()) return { state: 'none' };
  const want = tokens(riserLabel);
  const have = tokens(toText ?? '');
  let j = 0;
  for (const w of want) {
    while (j < have.length && !have[j]!.startsWith(w)) j++;
    if (j === have.length) return { state: 'differs', riser: riserLabel.trim(), to: toText };
    j++;
  }
  return { state: 'match', riser: riserLabel.trim() };
}

async function endView(store: Store, e: Row, fromDeviceLevel: string | null): Promise<EndView> {
  const id = String(e.id);
  let endpoint: EndEndpoint = { kind: 'none' };
  let jump: JumpTarget | null = null;
  const levelId = str(e.level_id);
  let levelCode: string | null = null;
  if (str(e.device_id)) {
    const d = await store.get<Row>('device', String(e.device_id));
    if (d) {
      const lv = await store.get<Row>('level', String(d.level_id));
      const code = lv ? String(lv.level) : null;
      const label = displayNumber('device', d, code);
      endpoint = {
        kind: 'device',
        deviceId: String(d.id),
        label,
        model: [str(d.device), str(d.type)].filter(Boolean).join(' ') || str(d.category),
        levelId: String(d.level_id),
        levelCode: code,
        deleted: !!d.deleted_at,
      };
      levelCode = code;
      if (!d.deleted_at) {
        jump = { deviceId: String(d.id), levelId: String(d.level_id), label, sameLevel: d.level_id === fromDeviceLevel };
      }
    }
  } else if (str(e.placeholder_id)) {
    const p = await store.get<Row>('placeholder', String(e.placeholder_id));
    endpoint = { kind: 'placeholder', label: p ? String(p.label) : '(placeholder)' };
  }
  if (!levelCode && levelId) {
    const lv = await store.get<Row>('level', levelId);
    levelCode = lv ? String(lv.level) : null;
  }
  const ops = await store.opsFor(id);
  return {
    id,
    side: e.side === 'B' ? 'B' : 'A',
    label: displayNumber('cable_end', e),
    levelId: levelId ?? (endpoint.kind === 'device' ? endpoint.levelId : null),
    levelCode,
    endpoint,
    fromText: str(e.from_text),
    toText: str(e.to_text),
    status: str(e.status),
    note: str(e.note),
    surveyedBy: str(e.surveyed_by_id),
    surveyedAt: str(e.surveyed_at),
    statusSource: str(e.status_source),
    deleted: !!e.deleted_at,
    inReview: new Set(Object.keys(await reviewFields(store, id))),
    pending: new Set(ops.filter((o) => o.state === 'pending' && o.field).map((o) => o.field!)),
    jump,
    photos: await photoStrip(store, { kind: 'cable_end', id }),
  };
}

/** The cable of `endId` with both ends, this one first; null when the end is not on this iPad. */
export async function loadCableEnds(store: Store, endId: string): Promise<CableView | null> {
  const self = await store.get<Row>('cable_end', endId);
  if (!self) return null;
  const cable = await store.get<Row>('cable', String(self.cable_id));
  if (!cable) return null;
  const others = await store.list<Row>('cable_end', {
    where: 'cable_id = ? AND id <> ? AND deleted_at IS NULL',
    params: [String(self.cable_id), endId],
    orderBy: 'side, id',
  });
  const selfDevice = str(self.device_id) ? await store.get<Row>('device', String(self.device_id)) : null;
  const fromLevel = selfDevice ? String(selfDevice.level_id) : str(self.level_id);
  const mine = await endView(store, self, fromLevel);
  const other = others[0] ? await endView(store, others[0], fromLevel) : null;

  const project = String(cable.project_id);
  const vocabRows = await store.list<Row>('vocab', {
    where: `project_id = ? AND list = 'connection_note' AND canonical_of_id IS NULL`,
    params: [project],
    orderBy: 'id',
  });
  return {
    id: String(cable.id),
    code: str(cable.cable),
    qty: num(cable.qty),
    singleRow: !!cable.single_row,
    riserToLabel: str(cable.riser_to_label),
    vertical: str(cable.vertical),
    deleted: !!cable.deleted_at,
    ends: [mine, other],
    // The riser governs the cable's To (R2): the A end's To text, else whichever end has one.
    riser: riserCheck(str(cable.riser_to_label), [mine, other].find((e) => e?.side === 'A' && e.toText)?.toText ?? mine.toText ?? other?.toText ?? null),
    phrases: vocabRows.length ? vocabRows.map((v) => String(v.value)) : CONNECTION_PHRASES,
  };
}
