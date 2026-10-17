/**
 * Read model of the connection end editor (T22, Phase 3 §4.5): one cable with both of its ends
 * stacked — the end the editor was opened on first — each with its endpoint (a device, possibly
 * on another level, or a placeholder), From/To text (D32), status, note and who surveyed it; plus
 * the riser label check. No React or Expo imports: runs in Node.
 */

import { displayNumber, reviewFields, riserCheck, type RiserCheck, type Store } from '@field-survey/core';
import { loadRuleParams } from '@field-survey/rules';

import type { CardPhoto, JumpTarget } from '../card/model';
import { photoStrip } from '../photo/links';
import { chipsFor, loadChipRows } from '../suggestions/model';

// The riser matcher lives in core since T34 (the rule engine's R2b uses the same one).
export { riserCheck, type RiserCheck };

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
  D: 'DALI',
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

export type CableView = {
  id: string;
  code: string | null;
  qty: number | null;
  singleRow: boolean;
  riserToLabel: string | null;
  vertical: string | null;
  deleted: boolean;
  /**
   * Termination kits (T103, D213): this cable's own setting (null = its code's), what its code
   * says (the project's `R4b.kit`), and the result.
   */
  termKit: { own: boolean | null; code: boolean; takes: boolean };
  /** The end the editor was opened on, then the other (or null when the cable has one end). */
  ends: [EndView, EndView | null];
  riser: RiserCheck;
  /** Chips under a Note: the library's for the cable code (T99), then the project's `connection_note` list, else `CONNECTION_PHRASES`. */
  phrases: readonly string[];
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
  const ruleParams = await loadRuleParams(store, project);
  const codeKits = ruleParams.flagCode('R4b', 'kit', str(cable.cable));
  const ownKits = cable.term_kit == null ? null : !!cable.term_kit;
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
    termKit: { own: ownKits, code: codeKits, takes: ownKits ?? codeKits },
    ends: [mine, other],
    // The riser governs the cable's To (R2): the A end's To text, else whichever end has one.
    riser: riserCheck(str(cable.riser_to_label), [mine, other].find((e) => e?.side === 'A' && e.toText)?.toText ?? mine.toText ?? other?.toText ?? null),
    // the cable code's suggestion chips first (T99, D174 (2)), then the project's list; the
    // "; no term kit" Note only on a cable that takes kits (T118, D213)
    phrases: chipsFor(await loadChipRows(store, project), { codes: [str(cable.cable)], params: ruleParams, termKit: ownKits }, 'connection_note', vocabRows.length ? vocabRows.map((v) => String(v.value)) : CONNECTION_PHRASES),
  };
}
