/**
 * A snapshot builder for rule tests (T34): short calls that add levels, devices, cables with
 * their ends, placeholders, items, parts, accessories and vocabulary to an in-memory snapshot.
 * Ids are deterministic (`<kind>-<n>`), so expectations can name them.
 */

import { emptySnapshot, type CableEndRow, type CableRow, type DeviceRow, type LevelRow, type LibraryTypeRow, type MissingPartRow, type PlaceholderRow, type PunchItemRow, type Snapshot } from '../snapshot';

export const PROJECT = '0190a5f0-0000-7000-8000-00000000bb01';

export class Build {
  readonly snap: Snapshot;
  private n = 0;

  constructor(projectId = PROJECT, settings: Record<string, unknown> | null = null) {
    this.snap = emptySnapshot(projectId);
    this.snap.project = { id: projectId, name: 'Test', settings };
  }

  private id(kind: string): string {
    return `${kind}-${++this.n}`;
  }

  level(code: string, p: Partial<LevelRow> = {}): LevelRow {
    const row: LevelRow = {
      id: this.id('level'), project_id: this.snap.projectId, level: code, floor_order: this.snap.levels.length + 1,
      numbering_group_id: p.numbering_group_id ?? `group-${code}`, in_scope: true, split_of_id: null, surveyed: null, updated: null,
      state: 'setup', baseline_locked_at: null, deleted_at: null, ...p,
    };
    this.snap.levels.push(row);
    if (!this.snap.numberingGroups.some((g) => g.id === row.numbering_group_id)) {
      this.snap.numberingGroups.push({ id: row.numbering_group_id, project_id: this.snap.projectId, label: code });
    }
    return row;
  }

  device(level: LevelRow, category: string, p: Partial<DeviceRow> = {}): DeviceRow {
    const row: DeviceRow = {
      id: this.id('device'), level_id: level.id, display_id: null, category, device: null, type: null, room_location: null, drawing_position: null,
      status: null, notes: null, pin: null, neuron_id: null, origin: 'baseline', found_on_site: null, panel_name: null, library_type_id: null, deleted_at: null,
      ...p,
    };
    this.snap.devices.push(row);
    return row;
  }

  placeholder(label: string, kind: string, p: Partial<PlaceholderRow> = {}): PlaceholderRow {
    const row: PlaceholderRow = { id: this.id('ph'), project_id: this.snap.projectId, label, kind, level_id: null, deleted_at: null, ...p };
    this.snap.placeholders.push(row);
    return row;
  }

  /** A cable with one or two ends; each end is a device, a placeholder or nothing (`null`). */
  cable(
    code: string,
    a: { device?: DeviceRow; placeholder?: PlaceholderRow; level?: LevelRow } & Partial<CableEndRow>,
    b: ({ device?: DeviceRow; placeholder?: PlaceholderRow; level?: LevelRow } & Partial<CableEndRow>) | null = null,
    cable: Partial<CableRow> = {},
  ): { cable: CableRow; a: CableEndRow; b: CableEndRow | null } {
    const id = this.id('cable');
    const mk = (side: 'A' | 'B', e: { device?: DeviceRow; placeholder?: PlaceholderRow; level?: LevelRow } & Partial<CableEndRow>): CableEndRow => {
      const { device, placeholder, level, ...rest } = e;
      const row: CableEndRow = {
        id: this.id('end'), cable_id: id, side, endpoint_kind: device ? 'device' : placeholder ? 'placeholder' : null,
        device_id: device?.id ?? null, placeholder_id: placeholder?.id ?? null, level_id: level?.id ?? device?.level_id ?? null, display_id: null,
        from_text: null, to_text: null, status: null, note: null, surveyed_by_id: null, surveyed_at: null, status_source: null, deleted_at: null, ...rest,
      };
      this.snap.cableEnds.push(row);
      return row;
    };
    const endA = mk('A', a);
    const endB = b ? mk('B', b) : null;
    const row: CableRow = {
      id, project_id: this.snap.projectId, cable: code, qty: 1, origin: 'riser', single_row: false, riser_to_label: null, vertical: null,
      end_a_id: endA.id, end_b_id: endB?.id ?? null, endpoint_confirmed: true, deleted_at: null, ...cable,
    };
    this.snap.cables.push(row);
    return { cable: row, a: endA, b: endB };
  }

  punch(level: LevelRow, p: Partial<PunchItemRow> = {}): PunchItemRow {
    const row: PunchItemRow = {
      id: this.id('punch'), level_id: level.id, number: this.snap.punchItems.length + 1, device_id: null, cable_end_id: null, device_text: null,
      item: null, type: null, owner: 'EC', tracking_status: 'Open', date_closed: null, notes: null, rule_id: null, proposal_id: null, sort_last: false, deleted_at: null,
      ...p,
    };
    this.snap.punchItems.push(row);
    return row;
  }

  part(level: LevelRow, p: Partial<MissingPartRow> = {}, sources: { target_kind: 'punch' | 'device' | 'cable_end'; target_id: string }[] = []): MissingPartRow {
    const row: MissingPartRow = {
      id: this.id('part'), level_id: level.id, number: this.snap.missingParts.length + 1, device_id: null, device_location: null, part: null, part_no: null,
      qty: 1, owner: 'EC', part_status: 'Needed', notes: null, rule_id: null, proposal_id: null, deleted_at: null, ...p,
    };
    this.snap.missingParts.push(row);
    for (const s of sources) this.snap.partSources.push({ missing_part_id: row.id, deleted_at: null, ...s });
    return row;
  }

  accessory(device: DeviceRow, model: string, expected: number | null, found: number | null) {
    const row = { id: this.id('acc'), device_id: device.id, model, expected_qty: expected, found_qty: found, notes: null, deleted_at: null };
    this.snap.accessories.push(row);
    return row;
  }

  /** A device type of this project (T48); accepted unless said otherwise. */
  libraryType(model: string, category: string, p: Partial<LibraryTypeRow> = {}): LibraryTypeRow {
    const row: LibraryTypeRow = {
      id: this.id('type'), project_id: this.snap.projectId, model, aliases: null, category, id_scheme: null, default_cables: null,
      optional_cables: null, optional_accessories: null, needs_neuron_id: null, role: null, state: 'accepted', deleted_at: null, ...p,
    };
    this.snap.libraryTypes.push(row);
    return row;
  }

  vocab(list: string, ...values: string[]): void {
    for (const value of values) this.snap.vocab.push({ id: this.id('vocab'), project_id: this.snap.projectId, list, value, canonical_of_id: null, deleted_at: null });
  }

  /** An old spelling of a value already in the list (`vocab.canonical_of`, D179). */
  vocabVariant(list: string, value: string, canonical: string): void {
    const c = this.snap.vocab.find((v) => v.list === list && v.value === canonical && !v.canonical_of_id);
    if (!c) throw new Error(`no canonical ${list} value ${canonical}`);
    this.snap.vocab.push({ id: this.id('vocab'), project_id: this.snap.projectId, list, value, canonical_of_id: c.id, deleted_at: null });
  }
}
