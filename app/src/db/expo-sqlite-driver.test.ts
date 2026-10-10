import { describe, expect, it, vi } from 'vitest';

// expo-sqlite is native; the driver only needs a database object with the four async calls.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(), deleteDatabaseAsync: vi.fn() }));

import type * as SQLite from 'expo-sqlite';

import { ExpoSqliteDriver } from './expo-sqlite-driver';

function fakeDb() {
  const log: string[] = [];
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const db = {
    execAsync: vi.fn(async (sql: string) => {
      await tick();
      log.push(sql);
    }),
    runAsync: vi.fn(async (sql: string) => {
      await tick();
      if (sql.includes('FAIL')) throw new Error('constraint');
      log.push(sql);
    }),
    getAllAsync: vi.fn(async (sql: string) => {
      await tick();
      log.push(sql);
      return [];
    }),
    closeAsync: vi.fn(async () => log.push('close')),
  };
  return { db: db as unknown as SQLite.SQLiteDatabase, log };
}

describe('ExpoSqliteDriver (D102: one connection, one queue)', () => {
  it('runs a transaction as BEGIN IMMEDIATE … COMMIT and lets nothing interleave', async () => {
    const { db, log } = fakeDb();
    const d = new ExpoSqliteDriver(db);
    const tx = d.transaction(async (t) => {
      await t.exec('INSERT a', [1]);
      await t.exec('INSERT b', [2]);
      return 'done';
    });
    const outside = d.query('SELECT outside'); // issued while the transaction is open
    expect(await tx).toBe('done');
    await outside;
    expect(log).toEqual(['BEGIN IMMEDIATE', 'INSERT a', 'INSERT b', 'COMMIT', 'SELECT outside']);
  });

  it('rolls back on error, rethrows, and keeps serving later calls', async () => {
    const { db, log } = fakeDb();
    const d = new ExpoSqliteDriver(db);
    await expect(
      d.transaction(async (t) => {
        await t.exec('INSERT ok', [1]);
        await t.exec('INSERT FAIL', [2]);
      }),
    ).rejects.toThrow('constraint');
    await d.exec('UPDATE after', [3]);
    expect(log).toEqual(['BEGIN IMMEDIATE', 'INSERT ok', 'ROLLBACK', 'UPDATE after']);
  });

  it('serialises plain statements in call order and refuses nested transactions', async () => {
    const { db, log } = fakeDb();
    const d = new ExpoSqliteDriver(db);
    await Promise.all([d.exec('A', [1]), d.query('B'), d.exec('C')]);
    expect(log).toEqual(['A', 'B', 'C']);
    await expect(d.transaction((t) => t.transaction(async () => 1))).rejects.toThrow('do not nest');
    expect(log.slice(-2)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
