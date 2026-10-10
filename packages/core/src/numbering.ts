/**
 * Numbering on the client (T13, PLAN §2.3).
 *
 * Display numbers (punch `#`, part `#`, photo number, `C-nn`) are assigned by the server on
 * first receipt of the create op and reach the iPad as an `assign` op (D25, D81). Until then
 * the record is `NEW`: it has no number, and nothing shows or stores a provisional one
 * (CLAUDE.md §8). `unnumbered()` lists the `NEW` records with why they are still waiting, so a
 * create the server refuses (409, T10) or could not number (`assign_skipped`, D84) surfaces
 * instead of sitting in the outbox unnoticed.
 *
 * Device IDs of the `level_number` scheme are server-assigned too (D93, T63), per level code
 * rather than per numbering group: a device created without `display_id` is `NEW` and shows
 * `<level>-?` until its `assign` op arrives. Tagged devices (`level_tag`) carry their ID from
 * the start (`deviceIdFor`).
 */

import { ENTITIES, type EntityKind } from './schema/entities';
import type { Store } from './store';
import type { SqlRow } from './sql-driver';

/** Entity kind → its server-assigned display column (from the registry's `serverAssigned`). */
export const NUMBERED: Readonly<Partial<Record<EntityKind, string>>> = Object.fromEntries(
  Object.entries(ENTITIES).flatMap(([kind, spec]) =>
    Object.entries(spec.columns)
      .filter(([, col]) => col.serverAssigned)
      .map(([name]) => [kind, name]),
  ),
);

export type NumberedKind = 'punch_item' | 'missing_part' | 'photo' | 'cable_end';
export const NUMBERED_KINDS = Object.keys(NUMBERED) as NumberedKind[];

/** Kinds that can be `NEW`: the numbered kinds plus devices (D93). */
export type PendingKind = NumberedKind | 'device';

/** Pending kind → the column the server's `assign` op fills. */
export const SERVER_ASSIGNED: Readonly<Record<PendingKind, string>> = {
  ...(NUMBERED as Record<NumberedKind, string>),
  device: 'display_id',
};
export const PENDING_KINDS = Object.keys(SERVER_ASSIGNED) as PendingKind[];

/** The badge text for a record that has no server number yet. */
export const NEW_BADGE = 'NEW';

export function isNumbered(kind: string): kind is NumberedKind {
  return kind in NUMBERED;
}

/** True when the record is waiting for its server number (a device: for its ID). */
export function isNew(kind: PendingKind, row: Record<string, unknown>): boolean {
  const v = row[SERVER_ASSIGNED[kind]];
  return v === null || v === undefined;
}

/**
 * The display number as shown in lists and cards: `12`, `C-07`, `06M-04`, or for a `NEW`
 * record `NEW` (punch, part, photo, cable end) or `<level>-?` (device; show the `NEW` badge
 * beside it, `isNew`). Never a guess. `level` is the device's level code; without it the row's
 * `level` column is used (a joined query), else `?`.
 */
export function displayNumber(kind: PendingKind, row: Record<string, unknown>, level?: string | null): string {
  if (!isNew(kind, row)) return String(row[SERVER_ASSIGNED[kind]]);
  if (kind !== 'device') return NEW_BADGE;
  const code = level ?? (typeof row.level === 'string' ? row.level : null) ?? '?';
  return `${code}-?`;
}

/**
 * Why a `NEW` record has no number yet:
 * - `waiting`: its create is in the outbox (offline, or a push failed on the network/server
 *   side and will be retried; `last_error` says so);
 * - `refused`: the server refused the push carrying its create with 409 (integrity: it
 *   references a level or record the server does not know) or 422; retrying alone will not
 *   help, the data has to change;
 * - `unnumbered`: the server accepted the create but assigned nothing (no level, a level
 *   without a numbering group, or a device level with no code — logged `assign_skipped`);
 * - `no_create`: the row exists without a create op in the local log (should not happen).
 */
export type UnnumberedReason = 'waiting' | 'refused' | 'unnumbered' | 'no_create';

/** Failure messages carry the status (`POST /ops → 409` from `failureOf`). */
const REFUSED = /\b(409|422)\b/;

export interface UnnumberedRecord {
  entity_kind: PendingKind;
  id: string;
  level_id: string | null;
  reason: UnnumberedReason;
  create_op_id: string | null;
  client_ts: string | null;
  attempts: number;
  last_error: string | null;
}

/**
 * Every `NEW` record of a project (deleted ones skipped), oldest create first. The project is
 * taken from the create op; a record without one is reported under every project query.
 */
export async function unnumbered(store: Store, projectId: string): Promise<UnnumberedRecord[]> {
  const out: UnnumberedRecord[] = [];
  for (const kind of PENDING_KINDS) {
    const spec = ENTITIES[kind];
    const field = SERVER_ASSIGNED[kind];
    const rows = await store.db.query<SqlRow>(
      `SELECT t.id AS id, t.level_id AS level_id, o.op_id AS op_id, o.state AS state,
              o.server_seq AS server_seq, o.client_ts AS client_ts,
              x.op_id AS outbox_op, x.attempts AS attempts, x.last_error AS last_error
         FROM ${spec.table} t
         LEFT JOIN op o ON o.entity_id = t.id AND o.kind = 'create'
         LEFT JOIN outbox x ON x.op_id = o.op_id
        WHERE t.${field} IS NULL AND t.deleted_at IS NULL
          AND (o.project_id = ? OR o.op_id IS NULL)`,
      [projectId],
    );
    for (const r of rows) {
      const lastError = (r.last_error as string | null) ?? null;
      let reason: UnnumberedReason;
      if (r.op_id == null) reason = 'no_create';
      else if (r.outbox_op != null) reason = lastError && REFUSED.test(lastError) ? 'refused' : 'waiting';
      else reason = r.server_seq != null ? 'unnumbered' : 'waiting';
      out.push({
        entity_kind: kind,
        id: r.id as string,
        level_id: (r.level_id as string | null) ?? null,
        reason,
        create_op_id: (r.op_id as string | null) ?? null,
        client_ts: (r.client_ts as string | null) ?? null,
        attempts: Number(r.attempts ?? 0),
        last_error: lastError,
      });
    }
  }
  return out.sort((a, b) => (a.client_ts ?? '').localeCompare(b.client_ts ?? ''));
}
