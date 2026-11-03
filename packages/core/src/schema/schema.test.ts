import { describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from '../node';
import { ENTITIES, entity } from './entities';
import { MIGRATIONS, MigrationError, SCHEMA_VERSION, migrate, schemaVersion } from './migrations';
import { SEARCH_SOURCES, searchDocTriggerSql } from './search';
import { statements as m0020 } from './migrations/0020_search_addresses';

type TableInfo = { name: string; type: string; notnull: number; pk: number; dflt_value: string | null };

async function fresh(): Promise<BetterSqliteDriver> {
  const db = new BetterSqliteDriver();
  await migrate(db);
  return db;
}

describe('migrations', () => {
  it('applies every migration to a fresh database and is idempotent', async () => {
    const db = await fresh();
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    const rows = await db.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migration ORDER BY version',
    );
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    db.close();
  });

  it('refuses a database from a newer app', async () => {
    const db = await fresh();
    await db.exec(`INSERT INTO schema_migration VALUES (?, 'future', '2030-01-01')`, [
      SCHEMA_VERSION + 1,
    ]);
    await expect(migrate(db)).rejects.toBeInstanceOf(MigrationError);
    db.close();
  });

  it('creates every table in the registry with exactly the registry columns (no drift)', async () => {
    const db = await fresh();
    for (const spec of Object.values(ENTITIES)) {
      const info = await db.query<TableInfo>(`PRAGMA table_info(${spec.table})`);
      expect(info.length, spec.table).toBeGreaterThan(0);
      // Order-insensitive: a column added by a later `ALTER TABLE` (migration 0004) lands after the
      // synced columns, while the registry lists it with the entity's own columns.
      expect(info.map((c) => c.name).sort(), spec.table).toEqual(Object.keys(spec.columns).sort());
      for (const c of info) {
        const col = spec.columns[c.name]!;
        expect(c.notnull === 1, `${spec.table}.${c.name} notnull`).toBe(!!col.notNull);
        expect(c.pk > 0, `${spec.table}.${c.name} pk`).toBe(spec.pk.includes(c.name));
      }
    }
    db.close();
  });

  it('has the PLAN §2.2 entities, the heads, the outbox and the blob queue', () => {
    const expected = [
      'project', 'level', 'numbering_group', 'sheet', 'app_user', 'assignment', 'device',
      'accessory', 'cable', 'cable_end', 'placeholder', 'punch_item', 'missing_part',
      'part_source', 'photo', 'photo_link', 'ink_layer', 'blob', 'op', 'review_item', 'ruling', 'proposal',
      'finding', 'import_batch', 'draft_device', 'draft_cable', 'library_type', 'rule_param', 'suggestion', 'vocab', 'export',
      'install', 'field_head', 'outbox', 'blob_queue', 'sync_state',
    ];
    for (const k of expected) expect(entity(k).table).toBe(k);
  });

  it('uses the D76 column names on the master-column entities', () => {
    expect(Object.keys(ENTITIES.device.columns)).toEqual(
      expect.arrayContaining(['display_id', 'room_location', 'drawing_position', 'neuron_id', 'ip_address', 'dmx_address']),
    );
    expect(Object.keys(ENTITIES.cable_end.columns)).toEqual(
      expect.arrayContaining(['from_text', 'to_text', 'display_id']),
    );
    expect(Object.keys(ENTITIES.punch_item.columns)).toEqual(
      expect.arrayContaining(['number', 'tracking_status', 'date_closed', 'sort_last']),
    );
    expect(Object.keys(ENTITIES.missing_part.columns)).toEqual(
      expect.arrayContaining(['number', 'device_location', 'part_no', 'part_status']),
    );
    expect(Object.keys(ENTITIES.photo.columns)).toEqual(
      expect.arrayContaining(['number', 'what_it_shows', 'seed_thumbnail_only']),
    );
    expect(ENTITIES.library_type.columns.project_id!.notNull).toBeFalsy();
  });

  it('enforces the fixed vocabularies as CHECK constraints', async () => {
    const db = await fresh();
    await expect(
      db.exec(`INSERT INTO device (id, level_id, status) VALUES ('d', 'l', 'Installed')`),
    ).rejects.toThrow(/CHECK/);
    await db.exec(`INSERT INTO device (id, level_id, status) VALUES ('d', 'l', 'Installed, untested')`);
    db.close();
  });

  it('keeps search_doc current through the source-table triggers', async () => {
    const db = await fresh();
    for (const [table, src] of Object.entries(SEARCH_SOURCES)) {
      const cols = Object.keys(entity(table).columns);
      for (const c of src.text) expect(cols, `${table}.${c}`).toContain(c.replace(/^#/, ''));
    }
    await db.exec(`INSERT INTO device (id, level_id, display_id, notes) VALUES ('d1', 'l1', '06M-04', 'Empty box on wall.')`);
    await db.exec(`INSERT INTO punch_item (id, level_id, number, item) VALUES ('p1', 'l1', 12, 'Run DMX')`);
    const squash = (rows: { entity_id: string; text: string }[]) =>
      rows.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') }));
    let docs = squash(await db.query('SELECT entity_id, text FROM search_doc ORDER BY entity_id'));
    expect(docs).toEqual([
      { entity_id: 'd1', text: '06M-04 Empty box on wall.' },
      { entity_id: 'p1', text: '#12 Run DMX' },
    ]);
    await db.exec(`UPDATE device SET notes = 'Reterminated - all good' WHERE id = 'd1'`);
    await db.exec(`UPDATE punch_item SET deleted_at = '2026-10-10' WHERE id = 'p1'`);
    docs = squash(await db.query('SELECT entity_id, text FROM search_doc ORDER BY entity_id'));
    expect(docs).toEqual([{ entity_id: 'd1', text: '06M-04 Reterminated - all good' }]);
    await db.exec(`DELETE FROM device WHERE id = 'd1'`);
    expect(await db.query('SELECT * FROM search_doc')).toEqual([]);
    db.close();
  });

  it('0020 recreates the device search triggers from SEARCH_SOURCES and indexes the addresses', async () => {
    const [ai, au] = searchDocTriggerSql(['device']);
    expect(m0020.slice(2, 4)).toEqual([ai, au]);
    // a version-19 database with an address captured before 0020
    const db = new BetterSqliteDriver();
    await db.exec(
      `CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
    );
    for (const m of MIGRATIONS.filter((m) => m.version < 20)) {
      for (const st of m.statements) await db.exec(st);
      await db.exec(`INSERT INTO schema_migration VALUES (?, ?, '2026-11-03')`, [m.version, m.name]);
    }
    await db.exec(`INSERT INTO device (id, level_id, display_id, ip_address, dmx_address) VALUES ('d1', 'l1', '06M-05', '10.101.4.23', '1/001')`);
    await db.exec(`INSERT INTO device (id, level_id, display_id, deleted_at) VALUES ('d2', 'l1', '06M-06', '2026-11-01')`);
    await db.exec(`INSERT INTO punch_item (id, level_id, number, item) VALUES ('p1', 'l1', 12, 'Run DMX')`);
    const texts = async () =>
      (await db.query<{ entity_id: string; text: string }>('SELECT entity_id, text FROM search_doc ORDER BY entity_id'))
        .map((r) => `${r.entity_id}: ${r.text.replace(/\s+/g, ' ')}`);
    expect(await texts()).toEqual(['d1: 06M-05', 'p1: #12 Run DMX']);
    expect(await migrate(db)).toBe(SCHEMA_VERSION);
    expect(await texts()).toEqual(['d1: 06M-05 10.101.4.23 1/001', 'p1: #12 Run DMX']);
    await db.exec(`UPDATE device SET dmx_address = '2/017' WHERE id = 'd1'`);
    expect(await texts()).toEqual(['d1: 06M-05 10.101.4.23 2/017', 'p1: #12 Run DMX']);
    db.close();
  });
});
