/**
 * Fixed value lists (CLAUDE.md §3, PLAN §2–3). Exact strings, never paraphrased.
 * Mirrors `server/app/vocab.py`; editable lists (category, cable code, notes, captions…)
 * live in the `vocab` table instead.
 */

export const DEVICE_STATUS = [
  'Complete',
  'Installed, untested',
  'Issue',
  'Not installed',
  'No access',
] as const;
export const CONNECTION_STATUS = [...DEVICE_STATUS, 'Not started'] as const;
export const PUNCH_TYPE = [
  'Missing part',
  'Cable not run',
  'Termination',
  'Wiring',
  'Not installed',
  'Replace Part',
  'Missed Survey',
  'Information',
  'Access',
] as const;
export const OWNER = ['EC', 'ETC', 'EC/ETC'] as const;
export const TRACKING_STATUS = ['Open', 'In progress', 'Closed'] as const;
export const PART_STATUS = ['Needed', 'Ordered', 'On site', 'Installed'] as const;
export const CHANGE_TYPE = [
  'Field survey',
  'Ruling',
  'Reconcile',
  'Correction',
  'Riser cross-check',
  'MSS ruling',
  'Master edit',
] as const;

export const ORIGIN = ['baseline', 'import', 'field_addition', 'library', 'manual'] as const;
export const LEVEL_STATE = ['setup', 'baseline_locked'] as const;
export const SHEET_KIND = ['display', 'source'] as const;
export const NEURON_METHOD = ['typed', 'scan'] as const;
export const CABLE_ORIGIN = ['riser', 'library', 'import', 'manual'] as const;
export const CABLE_SIDE = ['A', 'B'] as const;
export const ENDPOINT_KIND = ['device', 'placeholder'] as const;
export const STATUS_SOURCE = ['surveyed', 'copied', 'derived'] as const;
export const PLACEHOLDER_KIND = [
  'fixtures',
  'power',
  'station_bus',
  'level_not_in_scope',
  'external',
  'fixture_run',
  'spare',
  'unknown',
  'custom',
] as const;
export const PART_SOURCE_TARGET = ['punch', 'device', 'cable_end'] as const;
/** D128: what a photo can be linked to besides the device it was taken from. */
export const PHOTO_LINK_TARGET = ['device', 'cable_end', 'punch'] as const;
export const UPLOAD_STATE = ['local', 'partial', 'complete'] as const;
export const OP_KIND = [
  'create',
  'set',
  'delete',
  'restore',
  'link_add',
  'link_remove',
  'assign',
] as const;
export const OP_STATE = [
  'pending',
  'applied',
  'review',
  'rejected',
  'superseded',
  'awaiting_approval',
] as const;
export const REVIEW_KIND = [
  'sync_conflict',
  'extraction',
  'source_conflict',
  'import_pair',
  'lint',
  'mss',
] as const;
export const REVIEW_STATE = ['open', 'resolved', 'dismissed'] as const;
export const PROPOSAL_KIND = ['punch', 'part', 'cable', 'status', 'note'] as const;
export const PROPOSAL_STATE = ['proposed', 'accepted', 'edited', 'rejected', 'superseded'] as const;
export const FINDING_STATE = ['open', 'resolved', 'dismissed'] as const;
export const IMPORT_KIND = ['bom', 'riser', 'plans', 'master_xlsx', 'floor_xlsx', 'mss'] as const;
export const DRAFT_STATE = ['proposed', 'accepted', 'edited', 'rejected'] as const;
export const ID_SCHEME = ['level_number', 'level_tag'] as const;
export const LIBRARY_STATE = ['draft', 'accepted', 'rejected'] as const;
// T112 (D201): `library_type.role`; the same list as `ROLE` in roles.ts (kept here for the CHECK).
export const LIBRARY_ROLE = ['relay_panel', 'foundry_panel', 'ebdk', 'equipment_rack', 'nsps', 'touchscreen', 'station', 'sensor', 'other'] as const;
export const VOCAB_LIST = [
  'device_note',
  'punch_item',
  'punch_note',
  'part_note',
  'connection_note',
  'photo_caption',
  'model_map',
  'level_alias',
  'category',
  'type',
  // T111 (D197): the cable codes; a DaVinci port protocol with no code lands here as a draft
  'cable_code',
] as const;
export const EXPORT_KIND = ['xlsx', 'floor_pdf'] as const;

// Client-only lists (outbox and blob queue, PLAN §3.4).
export const BLOB_DIRECTION = ['upload', 'download'] as const;
export const BLOB_KIND = ['thumb', 'image', 'markup', 'ink', 'sheet', 'export'] as const;
export const QUEUE_STATE = ['queued', 'active', 'done', 'failed'] as const;
/** Outbox rows: `pending` is pushed; `quarantined` (the server refused it, T75/D145) waits for Retry. */
export const OUTBOX_STATE = ['pending', 'quarantined'] as const;

export type DeviceStatus = (typeof DEVICE_STATUS)[number];
export type ConnectionStatus = (typeof CONNECTION_STATUS)[number];
export type PunchType = (typeof PUNCH_TYPE)[number];
export type Owner = (typeof OWNER)[number];
export type TrackingStatus = (typeof TRACKING_STATUS)[number];
export type PartStatus = (typeof PART_STATUS)[number];
export type ChangeType = (typeof CHANGE_TYPE)[number];
export type OpKind = (typeof OP_KIND)[number];
export type OpState = (typeof OP_STATE)[number];
