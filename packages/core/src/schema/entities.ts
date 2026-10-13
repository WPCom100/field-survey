/**
 * Client table registry: every entity in PLAN §2.2 with the column names fixed by D76
 * (snake_case of the master header; `ID` → `display_id`, `#` → `number`, `From`/`To` →
 * `from_text`/`to_text`, references `<entity>_id`). Op `field` names are these column names.
 *
 * The registry is what `Store.apply` validates against and how rows are coded (JSON, booleans).
 * The DDL in `migrations/0001_initial.ts` was generated from it (`scripts/gen-ddl.ts`) and is
 * frozen; `schema.test.ts` checks the migrated database still matches the registry, so a
 * registry change without a new migration fails the suite.
 *
 * SQLite storage: uuid / timestamp / date → TEXT (ISO 8601), bool → INTEGER 0/1, json → TEXT.
 * No foreign keys on the client: ops arriving offline must always apply (D76 makes referential
 * integrity a lint, never a constraint); indexes cover the lookups the screens need.
 */

import * as v from '../vocab';

export type ColumnType = 'text' | 'int' | 'real' | 'bool' | 'json';

export interface ColumnSpec {
  type: ColumnType;
  notNull?: boolean;
  default?: string | number;
  check?: readonly string[];
  /** Assigned by the server (PLAN §2.3); a local `set` is refused, `assign` writes it. */
  serverAssigned?: boolean;
}

export type EntityRole =
  /** A versioned, soft-deletable record materialised from `create`/`set`/`delete`/`restore`. */
  | 'record'
  /** A link row keyed by several columns, written by `link_add`/`link_remove`. */
  | 'link'
  /** A record without `version`/soft delete (`app_user`, `numbering_group`, `blob`…). */
  | 'plain'
  /** Client-only bookkeeping, never the target of an op. */
  | 'local';

export interface EntitySpec {
  table: string;
  role: EntityRole;
  /** Primary key columns; records and plain entities use `['id']`. */
  pk: readonly string[];
  /** For links: the column holding the op's `entity_id` (the owning record). */
  owner?: string;
  columns: Record<string, ColumnSpec>;
  indexes?: readonly (readonly string[])[];
}

const t = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type: 'text', ...extra });
const i = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type: 'int', ...extra });
const r = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type: 'real', ...extra });
const b = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type: 'bool', ...extra });
const j = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type: 'json', ...extra });
const id = (): ColumnSpec => ({ type: 'text', notNull: true });
const enumCol = (values: readonly string[], extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  type: 'text',
  check: values,
  ...extra,
});

/** Columns of a versioned, soft-deletable record (PLAN §2.1). */
export const SYNCED_COLUMNS: Record<string, ColumnSpec> = {
  version: i({ notNull: true, default: 0 }),
  head_seq: i(),
  deleted_at: t(),
  deleted_by_id: t(),
  delete_reason: t(),
};

/** Columns a `create` payload may not carry and a `set` may not touch. */
export const PROTECTED_COLUMNS = new Set(['id', ...Object.keys(SYNCED_COLUMNS)]);

const record = (
  table: string,
  columns: Record<string, ColumnSpec>,
  indexes: readonly (readonly string[])[] = [],
): EntitySpec => ({
  table,
  role: 'record',
  pk: ['id'],
  columns: { id: id(), ...columns, ...SYNCED_COLUMNS },
  indexes,
});

const plain = (
  table: string,
  columns: Record<string, ColumnSpec>,
  pk: readonly string[] = ['id'],
  indexes: readonly (readonly string[])[] = [],
): EntitySpec => ({ table, role: 'plain', pk, columns, indexes });

const link = (
  table: string,
  owner: string,
  pk: readonly string[],
  columns: Record<string, ColumnSpec>,
  indexes: readonly (readonly string[])[] = [],
): EntitySpec => ({
  table,
  role: 'link',
  pk,
  owner,
  columns: { ...columns, deleted_at: t(), deleted_by_id: t() },
  indexes,
});

const local = (
  table: string,
  columns: Record<string, ColumnSpec>,
  pk: readonly string[],
  indexes: readonly (readonly string[])[] = [],
): EntitySpec => ({ table, role: 'local', pk, columns, indexes });

export const ENTITIES = {
  app_user: plain('app_user', {
    id: id(),
    entra_oid: t(),
    name: t({ notNull: true }),
    email: t(),
    last_seen: t(),
    created_at: t(),
  }),

  project: record('project', {
    name: t({ notNull: true }),
    site: t(),
    parties: j(),
    settings: j(),
    copied_from_id: t(),
    created_at: t(),
  }),

  /** One iPad's label (T86, D155): `id` = the install id; written as an op so it syncs. */
  install: record('install', {
    label: t(),
    user_id: t(),
    updated_at: t(),
  }),

  numbering_group: plain(
    'numbering_group',
    {
      id: id(),
      project_id: id(),
      label: t({ notNull: true }),
      counter_punch: i({ notNull: true, default: 0 }),
      counter_part: i({ notNull: true, default: 0 }),
      counter_photo: i({ notNull: true, default: 0 }),
      counter_cable: i({ notNull: true, default: 0 }),
    },
    ['id'],
    [['project_id']],
  ),

  level: record(
    'level',
    {
      project_id: id(),
      level: t({ notNull: true }),
      floor_order: i(),
      numbering_group_id: id(),
      in_scope: b({ notNull: true, default: 1 }),
      split_of_id: t(),
      surveyed: t(),
      updated: t(),
      state: enumCol(v.LEVEL_STATE, { notNull: true, default: 'setup' }),
      baseline_locked_at: t(),
      baseline_locked_by_id: t(),
      display_sheet_id: t(),
    },
    [['project_id']],
  ),

  sheet: record(
    'sheet',
    {
      level_id: id(),
      kind: enumCol(v.SHEET_KIND, { notNull: true }),
      blob: t(),
      page: i(),
      title: t(),
      width_pt: r(),
      height_pt: r(),
      grid_sets: j(),
      /** The plan text pass (T45, D147): rooms, tags, loose bubbles, source-sheet boundaries. */
      features: j(),
      revision: t(),
    },
    [['level_id']],
  ),

  assignment: link('assignment', 'level_id', ['level_id', 'user_id'], {
    level_id: id(),
    user_id: id(),
    assigned_by_id: t(),
    assigned_at: t(),
  }),

  device: record(
    'device',
    {
      level_id: id(),
      display_id: t(),
      category: t(),
      device: t(),
      type: t(),
      room_location: t(),
      drawing_position: t(),
      status: enumCol(v.DEVICE_STATUS),
      notes: t(),
      pin: j(),
      neuron_id: t(),
      neuron_evidence_photo_id: t(),
      neuron_method: enumCol(v.NEURON_METHOD),
      origin: enumCol(v.ORIGIN),
      found_on_site: b(),
      baseline_ref_id: t(),
      panel_name: t(),
      library_type_id: t(),
    },
    [['level_id'], ['neuron_id'], ['display_id']],
  ),

  accessory: record(
    'accessory',
    {
      device_id: id(),
      model: t(),
      expected_qty: i(),
      found_qty: i(),
      notes: t(),
      source_ref: j(),
    },
    [['device_id']],
  ),

  cable: record(
    'cable',
    {
      project_id: id(),
      cable: t(),
      qty: i(),
      origin: enumCol(v.CABLE_ORIGIN),
      single_row: b({ notNull: true, default: 0 }),
      riser_ref: j(),
      riser_to_label: t(),
      vertical: t(),
      end_a_id: t(),
      end_b_id: t(),
      endpoint_confirmed: b({ notNull: true, default: 0 }),
    },
    [['project_id']],
  ),

  cable_end: record(
    'cable_end',
    {
      cable_id: id(),
      side: enumCol(v.CABLE_SIDE, { notNull: true }),
      endpoint_kind: enumCol(v.ENDPOINT_KIND),
      device_id: t(),
      placeholder_id: t(),
      level_id: t(),
      display_id: t({ serverAssigned: true }),
      from_text: t(),
      to_text: t(),
      status: enumCol(v.CONNECTION_STATUS),
      note: t(),
      surveyed_by_id: t(),
      surveyed_at: t(),
      status_source: enumCol(v.STATUS_SOURCE),
    },
    [['cable_id'], ['device_id'], ['level_id']],
  ),

  placeholder: record(
    'placeholder',
    {
      project_id: id(),
      label: t({ notNull: true }),
      kind: enumCol(v.PLACEHOLDER_KIND, { notNull: true }),
      level_id: t(),
    },
    [['project_id']],
  ),

  punch_item: record(
    'punch_item',
    {
      level_id: id(),
      number: i({ serverAssigned: true }),
      device_id: t(),
      cable_end_id: t(),
      // The master's Device text, kept verbatim by the import and exported as stored (D136).
      device_text: t(),
      item: t(),
      type: enumCol(v.PUNCH_TYPE),
      owner: enumCol(v.OWNER),
      tracking_status: enumCol(v.TRACKING_STATUS),
      date_closed: t(),
      notes: t(),
      rule_id: t(),
      proposal_id: t(),
      sort_last: b({ notNull: true, default: 0 }),
    },
    [['level_id'], ['device_id']],
  ),

  missing_part: record(
    'missing_part',
    {
      level_id: id(),
      number: i({ serverAssigned: true }),
      device_id: t(),
      device_location: t(),
      part: t(),
      part_no: t(),
      qty: i(),
      owner: enumCol(v.OWNER),
      part_status: enumCol(v.PART_STATUS),
      notes: t(),
      rule_id: t(),
      proposal_id: t(),
    },
    [['level_id'], ['device_id']],
  ),

  part_source: link(
    'part_source',
    'missing_part_id',
    ['missing_part_id', 'target_kind', 'target_id'],
    {
      missing_part_id: id(),
      target_kind: enumCol(v.PART_SOURCE_TARGET, { notNull: true }),
      target_id: id(),
    },
  ),

  /** D128 (T65): a photo linked to further devices, connection ends and punch items. */
  photo_link: link(
    'photo_link',
    'photo_id',
    ['photo_id', 'target_kind', 'target_id'],
    {
      photo_id: id(),
      target_kind: enumCol(v.PHOTO_LINK_TARGET, { notNull: true }),
      target_id: id(),
    },
    [['target_kind', 'target_id']],
  ),

  photo: record(
    'photo',
    {
      level_id: id(),
      number: i({ serverAssigned: true }),
      location: t(),
      subject: t(),
      what_it_shows: t(),
      device_id: t(),
      punch_item_id: t(),
      cable_end_id: t(),
      image_blob: t(),
      thumb_blob: t(),
      markup_blob: t(),
      taken_by_id: t(),
      taken_at: t(),
      seed_thumbnail_only: b({ notNull: true, default: 0 }),
    },
    [['level_id'], ['device_id'], ['punch_item_id'], ['cable_end_id']],
  ),

  ink_layer: record(
    'ink_layer',
    {
      sheet_id: id(),
      user_id: id(),
      drawing_blob: t(),
      updated_at: t(),
    },
    [['sheet_id', 'user_id']],
  ),

  // Content-addressed; `local_path`/`last_used_at` are client-only (cache, PLAN §3.4).
  blob: plain(
    'blob',
    {
      sha256: t({ notNull: true }),
      size: i({ notNull: true }),
      mime: t({ notNull: true }),
      width: i(),
      height: i(),
      upload_state: enumCol(v.UPLOAD_STATE, { notNull: true, default: 'local' }),
      chunks_received: j({ notNull: true, default: '[]' }),
      created_at: t(),
      local_path: t(),
      last_used_at: t(),
      // Migration 0002 (T12): what the bytes are, for cache eviction tiers. Client-only.
      kind: enumCol(v.BLOB_KIND),
    },
    ['sha256'],
    [['local_path']],
  ),

  review_item: record(
    'review_item',
    {
      project_id: id(),
      level_id: t(),
      kind: enumCol(v.REVIEW_KIND, { notNull: true }),
      subject: j(),
      op_a_id: t(),
      op_b_id: t(),
      candidates: j(),
      ruling: b({ notNull: true, default: 0 }),
      state: enumCol(v.REVIEW_STATE, { notNull: true, default: 'open' }),
      resolved_by_id: t(),
      resolved_at: t(),
      resolution: j(),
    },
    [['project_id', 'state']],
  ),

  ruling: record(
    'ruling',
    {
      project_id: id(),
      text: t({ notNull: true }),
      scope_levels: j(),
      filter: j(),
      action: j(),
      standing: b({ notNull: true, default: 0 }),
      created_by_id: t(),
      created_at: t(),
      applied_at: t(),
      op_count: i(),
    },
    [['project_id']],
  ),

  proposal: record(
    'proposal',
    {
      project_id: id(),
      rule_id: t({ notNull: true }),
      subject: j(),
      discriminator: t(),
      kind: enumCol(v.PROPOSAL_KIND, { notNull: true }),
      payload: j(),
      inputs_hash: t(),
      state: enumCol(v.PROPOSAL_STATE, { notNull: true, default: 'proposed' }),
      decided_by_id: t(),
      decided_at: t(),
    },
    [['project_id', 'rule_id', 'discriminator']],
  ),

  finding: record(
    'finding',
    {
      project_id: id(),
      level_id: t(),
      lint_id: t({ notNull: true }),
      subject: j(),
      message: t(),
      state: enumCol(v.FINDING_STATE, { notNull: true, default: 'open' }),
      dismissed_reason: t(),
    },
    [['project_id', 'state']],
  ),

  import_batch: plain(
    'import_batch',
    {
      id: id(),
      project_id: id(),
      kind: enumCol(v.IMPORT_KIND, { notNull: true }),
      files: j(),
      job_state: t(),
      stats: j(),
      created_by_id: t(),
      created_at: t(),
    },
    ['id'],
    [['project_id']],
  ),

  draft_device: record(
    'draft_device',
    {
      project_id: id(),
      import_batch_id: t(),
      level_id: t(),
      model: t(),
      model_raw: t(),
      candidates: j(),
      name: t(),
      category: t(),
      qty: i(),
      accessories: j(),
      source_ref: j(),
      level_basis: t(),
      extraction: t(),
      confidence: r(),
      conflicts: j(),
      state: enumCol(v.DRAFT_STATE, { notNull: true, default: 'proposed' }),
      placed: b({ notNull: true, default: 0 }),
      not_on_sheet: b({ notNull: true, default: 0 }),
    },
    [['project_id'], ['level_id']],
  ),

  draft_cable: record(
    'draft_cable',
    {
      project_id: id(),
      import_batch_id: t(),
      level_id: t(),
      code: t(),
      qty: i(),
      from_label: t(),
      to_label: t(),
      to_level_id: t(),
      origin: t(),
      candidates: j(),
      source_ref: j(),
      level_basis: t(),
      extraction: t(),
      confidence: r(),
      conflicts: j(),
      state: enumCol(v.DRAFT_STATE, { notNull: true, default: 'proposed' }),
      placed: b({ notNull: true, default: 0 }),
      not_on_sheet: b({ notNull: true, default: 0 }),
    },
    [['project_id'], ['level_id']],
  ),

  // `project_id` null = app-level library (D65).
  library_type: record(
    'library_type',
    {
      project_id: t(),
      model: t({ notNull: true }),
      aliases: j(),
      category: t(),
      id_scheme: enumCol(v.ID_SCHEME),
      default_cables: j(),
      optional_cables: j(),
      optional_accessories: j(),
      state: enumCol(v.LIBRARY_STATE, { notNull: true, default: 'draft' }),
      created_by_id: t(),
      promoted_from_id: t(),
    },
    [['project_id']],
  ),

  vocab: record(
    'vocab',
    {
      project_id: id(),
      list: enumCol(v.VOCAB_LIST, { notNull: true }),
      value: t({ notNull: true }),
      canonical_of_id: t(),
    },
    [['project_id', 'list']],
  ),

  export: plain(
    'export',
    {
      id: id(),
      project_id: id(),
      kind: enumCol(v.EXPORT_KIND, { notNull: true }),
      params: j(),
      blob: t(),
      created_by_id: t(),
      created_at: t(),
      diff_summary: j(),
    },
    ['id'],
    [['project_id']],
  ),

  // --- the op log and its heads (PLAN §3.1, §2.1) ---

  op: local(
    'op',
    {
      op_id: id(),
      project_id: id(),
      user_id: id(),
      install_id: id(),
      client_ts: t({ notNull: true }),
      server_seq: i(),
      server_ts: t(),
      entity_kind: t({ notNull: true }),
      entity_id: id(),
      kind: enumCol(v.OP_KIND, { notNull: true }),
      field: t(),
      was: j(),
      now: j(),
      payload: j(),
      base_op_id: t(),
      group_id: t(),
      change_type: enumCol(v.CHANGE_TYPE, { notNull: true }),
      reason: t(),
      ruling_id: t(),
      proposal_id: t(),
      state: enumCol(v.OP_STATE, { notNull: true, default: 'pending' }),
    },
    ['op_id'],
    [
      ['entity_id', 'field'],
      ['project_id', 'server_seq'],
      ['project_id', 'state'],
    ],
  ),

  field_head: local(
    'field_head',
    {
      entity_id: id(),
      field: t({ notNull: true }),
      op_id: id(),
    },
    ['entity_id', 'field'],
  ),

  // --- client-only queues and state ---

  /** Local ops waiting for a push, drained in `client_ts` order (PLAN §3.2). */
  outbox: local(
    'outbox',
    {
      op_id: id(),
      project_id: id(),
      client_ts: t({ notNull: true }),
      attempts: i({ notNull: true, default: 0 }),
      last_error: t(),
      created_at: t({ notNull: true }),
      /** `quarantined` = refused by the server (409/422); pushed again only on Retry (T75). */
      state: enumCol(v.OUTBOX_STATE, { notNull: true, default: 'pending' }),
    },
    ['op_id'],
    [['project_id', 'client_ts']],
  ),

  /** Blob transfers (PLAN §3.4): thumbnails first, chunked uploads resume after a kill. */
  blob_queue: local(
    'blob_queue',
    {
      sha256: t({ notNull: true }),
      direction: enumCol(v.BLOB_DIRECTION, { notNull: true }),
      kind: enumCol(v.BLOB_KIND, { notNull: true }),
      priority: i({ notNull: true, default: 0 }),
      state: enumCol(v.QUEUE_STATE, { notNull: true, default: 'queued' }),
      attempts: i({ notNull: true, default: 0 }),
      next_attempt_at: t(),
      last_error: t(),
      created_at: t({ notNull: true }),
    },
    ['sha256', 'direction'],
    [['direction', 'state', 'priority']],
  ),

  /** Key/value: `install_id`, `search_mode`, `last_server_seq:<project_id>`… */
  sync_state: local(
    'sync_state',
    {
      key: t({ notNull: true }),
      value: j(),
    },
    ['key'],
  ),
} as const satisfies Record<string, EntitySpec>;

export type EntityKind = keyof typeof ENTITIES;

export const ENTITY_KINDS = Object.keys(ENTITIES) as EntityKind[];

export function entity(kind: string): EntitySpec {
  const spec = (ENTITIES as Record<string, EntitySpec>)[kind];
  if (!spec) throw new Error(`Unknown entity kind: ${kind}`);
  return spec;
}

/** Entity kinds an op may target (records, links and plain records; never local tables). */
export function isOpTarget(kind: string): kind is EntityKind {
  const spec = (ENTITIES as Record<string, EntitySpec>)[kind];
  return !!spec && spec.role !== 'local';
}

// --- value coding ---

export type SqlValue = string | number | null | Uint8Array;

export function encodeValue(col: ColumnSpec, value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  switch (col.type) {
    case 'json':
      return JSON.stringify(value);
    case 'bool':
      return value ? 1 : 0;
    case 'int':
    case 'real':
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      throw new TypeError(`Expected a number, got ${typeof value}`);
    case 'text':
      if (typeof value === 'string') return value;
      if (value instanceof Uint8Array) return value;
      throw new TypeError(`Expected a string, got ${typeof value}`);
  }
}

export function decodeValue(col: ColumnSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (col.type) {
    case 'json':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'bool':
      return value === 1 || value === true || value === '1';
    default:
      return value;
  }
}

export function decodeRow<T = Record<string, unknown>>(
  spec: EntitySpec,
  row: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    const col = spec.columns[name];
    out[name] = col ? decodeValue(col, value) : value;
  }
  return out as T;
}
