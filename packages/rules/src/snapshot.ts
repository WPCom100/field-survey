/**
 * The in-memory project snapshot the rules read (PLAN §6, T33). Rows are the client columns of
 * PLAN §2.2 as `Store.list` decodes them (D76 names, JSON parsed, booleans as booleans), one
 * array per table, deleted rows included with their `deleted_at` so lints can see them. The
 * engine (`engine.ts`) loads it from a core `Store`; tests build it by hand. Nothing here
 * touches a database.
 */

import type { ConnectionStatus, DeviceStatus, Owner, PartStatus, PunchType, TrackingStatus } from '@field-survey/core';

export interface Deletable {
  deleted_at: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  settings: Record<string, unknown> | null;
}

export interface LevelRow extends Deletable {
  id: string;
  project_id: string;
  level: string;
  floor_order: number | null;
  numbering_group_id: string;
  in_scope: boolean;
  split_of_id: string | null;
  surveyed: string | null;
  updated: string | null;
  state: 'setup' | 'baseline_locked';
  baseline_locked_at: string | null;
}

export interface NumberingGroupRow {
  id: string;
  project_id: string;
  label: string;
}

export interface DeviceRow extends Deletable {
  id: string;
  level_id: string;
  display_id: string | null;
  category: string | null;
  device: string | null;
  type: string | null;
  room_location: string | null;
  drawing_position: string | null;
  status: DeviceStatus | null;
  notes: string | null;
  pin: { sheet: string; x: number; y: number } | null;
  neuron_id: string | null;
  origin: string | null;
  found_on_site: boolean | null;
  panel_name: string | null;
  library_type_id: string | null;
}

export interface AccessoryRow extends Deletable {
  id: string;
  device_id: string;
  model: string | null;
  expected_qty: number | null;
  found_qty: number | null;
  notes: string | null;
}

export interface CableRow extends Deletable {
  id: string;
  project_id: string;
  cable: string | null;
  qty: number | null;
  origin: string | null;
  single_row: boolean;
  riser_to_label: string | null;
  vertical: string | null;
  end_a_id: string | null;
  end_b_id: string | null;
  endpoint_confirmed: boolean;
}

export interface CableEndRow extends Deletable {
  id: string;
  cable_id: string;
  side: 'A' | 'B';
  endpoint_kind: 'device' | 'placeholder' | null;
  device_id: string | null;
  placeholder_id: string | null;
  level_id: string | null;
  display_id: string | null;
  from_text: string | null;
  to_text: string | null;
  status: ConnectionStatus | null;
  note: string | null;
  surveyed_by_id: string | null;
  surveyed_at: string | null;
  status_source: 'surveyed' | 'copied' | 'derived' | null;
}

export interface PlaceholderRow extends Deletable {
  id: string;
  project_id: string;
  label: string;
  kind: string;
  level_id: string | null;
}

export interface PunchItemRow extends Deletable {
  id: string;
  level_id: string;
  number: number | null;
  device_id: string | null;
  cable_end_id: string | null;
  device_text: string | null;
  item: string | null;
  type: PunchType | null;
  owner: Owner | null;
  tracking_status: TrackingStatus | null;
  date_closed: string | null;
  notes: string | null;
  rule_id: string | null;
  proposal_id: string | null;
  sort_last: boolean;
}

export interface MissingPartRow extends Deletable {
  id: string;
  level_id: string;
  number: number | null;
  device_id: string | null;
  device_location: string | null;
  part: string | null;
  part_no: string | null;
  qty: number | null;
  owner: Owner | null;
  part_status: PartStatus | null;
  notes: string | null;
  rule_id: string | null;
  proposal_id: string | null;
}

export interface PartSourceRow extends Deletable {
  missing_part_id: string;
  target_kind: 'punch' | 'device' | 'cable_end';
  target_id: string;
}

export interface LibraryTypeRow extends Deletable {
  id: string;
  project_id: string | null;
  model: string;
  aliases: string[] | null;
  category: string | null;
  id_scheme: string | null;
  default_cables: unknown;
  optional_cables: unknown;
  optional_accessories: unknown;
  state: 'draft' | 'accepted' | 'rejected';
}

export interface VocabRow extends Deletable {
  id: string;
  project_id: string;
  list: string;
  value: string;
  canonical_of_id: string | null;
}

/** A plan sheet, for the pin-outside-the-sheet lint (T36): its size in PDF points. */
export interface SheetRow extends Deletable {
  id: string;
  level_id: string;
  width_pt: number | null;
  height_pt: number | null;
}

/**
 * A photo, reduced to what the deleted-link lint reads (T36). The engine loads only live photos
 * whose device is deleted (a project holds thousands of photos and no other rule reads them).
 */
export interface PhotoRow extends Deletable {
  id: string;
  level_id: string;
  number: number | null;
  device_id: string | null;
}

/** An unreviewed setup draft (`draft_device` / `draft_cable` in state `proposed`), for the locked-level lint (T36). */
export interface DraftRow extends Deletable {
  id: string;
  kind: 'device' | 'cable';
  level_id: string | null;
  state: string;
}

/** A ruling (T37, `rulings.ts`): filter and action are JSON the ruling module parses. */
export interface RulingRow extends Deletable {
  id: string;
  project_id: string;
  text: string;
  scope_levels: unknown;
  filter: unknown;
  action: unknown;
  standing: boolean;
  created_by_id: string | null;
  created_at: string | null;
  applied_at: string | null;
  op_count: number | null;
}

export type ProposalState = 'proposed' | 'accepted' | 'edited' | 'rejected' | 'superseded';
export type ProposalKind = 'punch' | 'part' | 'cable' | 'status' | 'note';

/** What a proposal or finding is about. `level_id` lets screens filter by level. */
export interface Subject {
  entity_kind: 'device' | 'cable_end' | 'cable' | 'punch_item' | 'missing_part' | 'accessory' | 'photo' | 'level' | 'numbering_group' | 'project';
  entity_id: string;
  level_id?: string | null;
}

export interface ProposalRow extends Deletable {
  id: string;
  project_id: string;
  rule_id: string;
  subject: Subject | null;
  discriminator: string | null;
  kind: ProposalKind;
  payload: Record<string, unknown> | null;
  inputs_hash: string | null;
  state: ProposalState;
  decided_by_id: string | null;
  decided_at: string | null;
}

export type FindingState = 'open' | 'resolved' | 'dismissed';

export interface FindingRow extends Deletable {
  id: string;
  project_id: string;
  level_id: string | null;
  lint_id: string;
  subject: (Subject & { discriminator?: string | null; fix?: { field: string; from: string; to: string | null } }) | null;
  message: string | null;
  state: FindingState;
  dismissed_reason: string | null;
}

export interface Snapshot {
  projectId: string;
  project: ProjectRow | null;
  levels: LevelRow[];
  numberingGroups: NumberingGroupRow[];
  devices: DeviceRow[];
  accessories: AccessoryRow[];
  cables: CableRow[];
  cableEnds: CableEndRow[];
  placeholders: PlaceholderRow[];
  punchItems: PunchItemRow[];
  missingParts: MissingPartRow[];
  partSources: PartSourceRow[];
  libraryTypes: LibraryTypeRow[];
  vocab: VocabRow[];
  proposals: ProposalRow[];
  findings: FindingRow[];
  sheets: SheetRow[];
  photos: PhotoRow[];
  drafts: DraftRow[];
  /** Rulings (T37); the standing ones propose on new matches. */
  rulings: RulingRow[];
}

/** An empty snapshot; tests and the engine start from it. */
export function emptySnapshot(projectId: string): Snapshot {
  return {
    projectId,
    project: null,
    levels: [],
    numberingGroups: [],
    devices: [],
    accessories: [],
    cables: [],
    cableEnds: [],
    placeholders: [],
    punchItems: [],
    missingParts: [],
    partSources: [],
    libraryTypes: [],
    vocab: [],
    proposals: [],
    findings: [],
    sheets: [],
    photos: [],
    drafts: [],
    rulings: [],
  };
}

const live = <T extends Deletable>(rows: readonly T[]): T[] => rows.filter((r) => r.deleted_at == null);

function groupBy<T>(rows: readonly T[], key: (r: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Lookups the rules share, built once per evaluation over the **live** rows (deleted ones stay
 * reachable through the snapshot arrays). Every map is keyed by id.
 */
export interface SnapshotIndex {
  level: Map<string, LevelRow>;
  levelByCode: Map<string, LevelRow>;
  numberingGroup: Map<string, NumberingGroupRow>;
  levelsByGroup: Map<string, LevelRow[]>;
  device: Map<string, DeviceRow>;
  devicesByLevel: Map<string, DeviceRow[]>;
  accessoriesByDevice: Map<string, AccessoryRow[]>;
  cable: Map<string, CableRow>;
  cableEnd: Map<string, CableEndRow>;
  endsByCable: Map<string, CableEndRow[]>;
  endsByDevice: Map<string, CableEndRow[]>;
  placeholder: Map<string, PlaceholderRow>;
  punchItem: Map<string, PunchItemRow>;
  punchByDevice: Map<string, PunchItemRow[]>;
  punchByEnd: Map<string, PunchItemRow[]>;
  punchByLevel: Map<string, PunchItemRow[]>;
  missingPart: Map<string, MissingPartRow>;
  partsByDevice: Map<string, MissingPartRow[]>;
  sourcesByPart: Map<string, PartSourceRow[]>;
  libraryType: Map<string, LibraryTypeRow>;
  sheet: Map<string, SheetRow>;
  /** Live punch items and parts by the proposal they were accepted from. */
  recordsByProposal: Map<string, (PunchItemRow | MissingPartRow)[]>;
  /** The other end of a cable end (null when the cable has one end so far). */
  otherEnd(end: CableEndRow): CableEndRow | null;
}

export function indexSnapshot(s: Snapshot): SnapshotIndex {
  const levels = live(s.levels);
  const devices = live(s.devices);
  const cables = live(s.cables);
  const ends = live(s.cableEnds);
  const punch = live(s.punchItems);
  const parts = live(s.missingParts);
  const byId = <T extends { id: string }>(rows: readonly T[]) => new Map(rows.map((r) => [r.id, r] as const));
  const endsByCable = groupBy(ends, (e) => e.cable_id);
  const recordsByProposal = new Map<string, (PunchItemRow | MissingPartRow)[]>();
  for (const r of [...punch, ...parts]) {
    if (!r.proposal_id) continue;
    const list = recordsByProposal.get(r.proposal_id);
    if (list) list.push(r);
    else recordsByProposal.set(r.proposal_id, [r]);
  }
  return {
    level: byId(levels),
    levelByCode: new Map(levels.map((l) => [l.level, l] as const)),
    numberingGroup: byId(s.numberingGroups),
    levelsByGroup: groupBy(levels, (l) => l.numbering_group_id),
    device: byId(devices),
    devicesByLevel: groupBy(devices, (d) => d.level_id),
    accessoriesByDevice: groupBy(live(s.accessories), (a) => a.device_id),
    cable: byId(cables),
    cableEnd: byId(ends),
    endsByCable,
    endsByDevice: groupBy(ends, (e) => e.device_id),
    placeholder: byId(live(s.placeholders)),
    punchItem: byId(punch),
    punchByDevice: groupBy(punch, (p) => p.device_id),
    punchByEnd: groupBy(punch, (p) => p.cable_end_id),
    punchByLevel: groupBy(punch, (p) => p.level_id),
    missingPart: byId(parts),
    partsByDevice: groupBy(parts, (m) => m.device_id),
    sourcesByPart: groupBy(live(s.partSources), (ps) => ps.missing_part_id),
    libraryType: byId(live(s.libraryTypes)),
    sheet: byId(live(s.sheets ?? [])),
    recordsByProposal,
    otherEnd(end) {
      const pair = endsByCable.get(end.cable_id) ?? [];
      return pair.find((e) => e.id !== end.id) ?? null;
    },
  };
}
