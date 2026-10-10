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
 * Device IDs are different: they are chosen on the iPad at placement/creation, per level, from
 * the library type's ID scheme (`deviceIdFor`, D88).
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

/** The badge text for a record that has no server number yet. */
export const NEW_BADGE = 'NEW';

export function isNumbered(kind: string): kind is NumberedKind {
  return kind in NUMBERED;
}

/** True when the record is waiting for its server number. */
export function isNew(kind: NumberedKind, row: Record<string, unknown>): boolean {
  const v = row[NUMBERED[kind]!];
  return v === null || v === undefined;
}

/** The display number as shown in lists and cards: `12`, `C-07`, or `NEW` (never a guess). */
export function displayNumber(kind: NumberedKind, row: Record<string, unknown>): string {
  return isNew(kind, row) ? NEW_BADGE : String(row[NUMBERED[kind]!]);
}

/**
 * Why a `NEW` record has no number yet:
 * - `waiting`: its create is in the outbox (offline, or a push failed on the network/server
 *   side and will be retried; `last_error` says so);
 * - `refused`: the server refused the push carrying its create with 409 (integrity: it
 *   references a level or record the server does not know) or 422; retrying alone will not
 *   help, the data has to change;
 * - `unnumbered`: the server accepted the create but assigned nothing (no level, or a level
 *   without a numbering group — logged `assign_skipped` on the server);
 * - `no_create`: the row exists without a create op in the local log (should not happen).
 */
export type UnnumberedReason = 'waiting' | 'refused' | 'unnumbered' | 'no_create';

/** Failure messages carry the status (`POST /ops → 409` from `failureOf`). */
const REFUSED = /\b(409|422)\b/;

export interface UnnumberedRecord {
  entity_kind: NumberedKind;
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
  for (const kind of NUMBERED_KINDS) {
    const spec = ENTITIES[kind];
    const field = NUMBERED[kind]!;
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
