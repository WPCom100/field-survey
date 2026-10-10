import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlParam, SqlRow } from '@field-survey/core';

/**
 * `SqlDriver` over expo-sqlite (D71). The same SQL runs under `BetterSqliteDriver` in Node.
 * Statements inside `transaction()` run on the exclusive connection expo-sqlite hands to
 * `withExclusiveTransactionAsync`; transactions do not nest.
 */
class Connection implements SqlDriver {
  constructor(protected readonly db: SQLite.SQLiteDatabase) {}

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    if (params.length === 0) await this.db.execAsync(sql);
    else await this.db.runAsync(sql, params);
  }

  async query<T extends object = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params);
  }

  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    void fn;
    return Promise.reject(new Error('ExpoSqliteDriver: transactions do not nest'));
  }
}

export class ExpoSqliteDriver extends Connection {
  /** Open (or create) the database file in the app sandbox and set the pragmas we rely on. */
  static async open(name = 'field-survey.db'): Promise<ExpoSqliteDriver> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    return new ExpoSqliteDriver(db);
  }

  override async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await this.db.withExclusiveTransactionAsync(async (txn) => {
      result = await fn(new Connection(txn));
    });
    return result as T;
  }

  close(): Promise<void> {
    return this.db.closeAsync();
  }
}
