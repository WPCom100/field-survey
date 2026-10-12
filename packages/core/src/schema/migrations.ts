/**
 * Client migrations. Each is a frozen list of statements applied in one transaction and recorded
 * in `schema_migration`. A database written by a newer app (a recorded version this build does
 * not know) is refused rather than guessed at.
 */

import type { SqlDriver } from '../sql-driver';
import { statements as m0001 } from './migrations/0001_initial';
import { statements as m0002 } from './migrations/0002_blob_kind';
import { statements as m0003 } from './migrations/0003_photo_link';
import { statements as m0004 } from './migrations/0004_punch_device_text';
import { statements as m0005 } from './migrations/0005_outbox_state';
import { statements as m0006 } from './migrations/0006_sheet_features';

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', statements: m0001 },
  { version: 2, name: 'blob_kind', statements: m0002 },
  { version: 3, name: 'photo_link', statements: m0003 },
  { version: 4, name: 'punch_device_text', statements: m0004 },
  { version: 5, name: 'outbox_state', statements: m0005 },
  { version: 6, name: 'sheet_features', statements: m0006 },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class MigrationError extends Error {}

/** Apply pending migrations; returns the schema version afterwards. */
export async function migrate(db: SqlDriver): Promise<number> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  const rows = await db.query<{ version: number }>(
    `SELECT version FROM schema_migration ORDER BY version`,
  );
  const applied = new Set(rows.map((r) => r.version));
  const newest = rows.length ? rows[rows.length - 1]!.version : 0;
  if (newest > SCHEMA_VERSION) {
    throw new MigrationError(
      `Database schema version ${newest} is newer than this app (${SCHEMA_VERSION}); update the app`,
    );
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const s of m.statements) await tx.exec(s);
      await tx.exec(`INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)`, [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
    });
  }
  return SCHEMA_VERSION;
}

export async function schemaVersion(db: SqlDriver): Promise<number> {
  const rows = await db.query<{ v: number | null }>(
    `SELECT max(version) AS v FROM schema_migration`,
  );
  return rows[0]?.v ?? 0;
}
