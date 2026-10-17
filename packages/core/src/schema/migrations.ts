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
import { statements as m0007 } from './migrations/0007_install';
import { statements as m0008 } from './migrations/0008_vocab_state';
import { statements as m0009 } from './migrations/0009_needs_neuron_id';
import { statements as m0010 } from './migrations/0010_davinci_library';
import { statements as m0011 } from './migrations/0011_library_role';
import { statements as m0012 } from './migrations/0012_draft_device_role';
import { statements as m0013 } from './migrations/0013_rule_param';
import { statements as m0014 } from './migrations/0014_suggestion';

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
  { version: 7, name: 'install', statements: m0007 },
  { version: 8, name: 'vocab_state', statements: m0008 },
  { version: 9, name: 'needs_neuron_id', statements: m0009 },
  { version: 10, name: 'davinci_library', statements: m0010 },
  { version: 11, name: 'library_role', statements: m0011 },
  { version: 12, name: 'draft_device_role', statements: m0012 },
  { version: 13, name: 'rule_param', statements: m0013 },
  { version: 14, name: 'suggestion', statements: m0014 },
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
