import type { ChangeType, OpKind, OpState } from './vocab';
import type { EntityKind } from './schema/entities';

/**
 * One op (PLAN §3.1). Column names follow D76 (`project_id`, `user_id`); timestamps are ISO
 * 8601 strings; `was`/`now`/`payload` are plain JSON values.
 *
 * - `create`: `payload` is the full record (column → value).
 * - `set`: `field`, `was`, `now`, `base_op_id` = the field head the client had.
 * - `delete` / `restore`: `reason` says why.
 * - `link_add` / `link_remove`: `entity_id` is the owning record, `payload` the link key
 *   (`assignment`: `user_id`…; `part_source`: `target_kind`, `target_id`).
 * - `assign`: server-only; `field` + `now` carry a display number (PLAN §2.3).
 */
export interface Op {
  op_id: string;
  project_id: string;
  user_id: string;
  install_id: string;
  client_ts: string;
  server_seq?: number | null;
  server_ts?: string | null;
  entity_kind: EntityKind;
  entity_id: string;
  kind: OpKind;
  field?: string | null;
  was?: unknown;
  now?: unknown;
  payload?: Record<string, unknown> | null;
  base_op_id?: string | null;
  group_id?: string | null;
  change_type: ChangeType;
  reason?: string | null;
  ruling_id?: string | null;
  proposal_id?: string | null;
  state?: OpState;
}

/** An op as stored: every optional field present, `state` set. */
export type StoredOp = Required<Omit<Op, 'was' | 'now'>> & { was: unknown; now: unknown };
