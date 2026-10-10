import Database from 'better-sqlite3';
import type { SqlDriver, SqlParam, SqlRow } from './sql-driver.js';

export class BetterSqliteDriver implements SqlDriver {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
  }

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    if (params.length === 0) this.db.exec(sql);
    else this.db.prepare(sql).run(...params);
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
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
