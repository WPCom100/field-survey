import Database from 'better-sqlite3';
import type { SqlDriver, SqlParam, SqlRow } from './sql-driver';

/** `SqlDriver` over better-sqlite3 for Node tests. Transactions do not nest. */
export class BetterSqliteDriver implements SqlDriver {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    if (params.length === 0) this.db.exec(sql);
    else this.db.prepare(sql).run(...params);
  }

  async query<T extends object = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.db.inTransaction) throw new Error('BetterSqliteDriver: transactions do not nest');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
