import { describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from './node';

describe('BetterSqliteDriver', () => {
  it('creates a table, inserts and reads a row', async () => {
    const db = new BetterSqliteDriver();
    await db.exec('CREATE TABLE placeholder (id TEXT PRIMARY KEY, name TEXT)');
    await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO placeholder (id, name) VALUES (?, ?)', ['a', 'hello']);
    });
    expect(await db.query('SELECT id, name FROM placeholder')).toEqual([{ id: 'a', name: 'hello' }]);
    db.close();
  });

  it('rolls back a failed transaction', async () => {
    const db = new BetterSqliteDriver();
    await db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t (id) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT * FROM t')).toEqual([]);
    db.close();
  });
});
