import { describe, expect, it } from 'vitest';
import { BetterSqliteDriver } from './index.js';

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
});
