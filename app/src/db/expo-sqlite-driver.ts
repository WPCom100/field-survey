import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlParam, SqlRow } from '@field-survey/core';

/** Runs statements on one expo-sqlite connection. */
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

/**
 * `SqlDriver` over expo-sqlite (D71). The same SQL runs under `BetterSqliteDriver` in Node.
 *
 * **One connection, one queue.** Every statement and every transaction is serialised through a
 * promise queue; a transaction is `BEGIN IMMEDIATE … COMMIT` on that same connection, and its
 * statements go through the `tx` handle, which skips the queue. Nothing else can interleave into
 * an open transaction, so no second connection is needed.
 *
 * Not `withExclusiveTransactionAsync`: it opens a new connection per transaction, and on iOS
 * (expo-sqlite 57, SQLite 3.50.3) committing/closing that connection after a write to the FTS5
 * index crashes the app natively — found on the iPad in T17, the first device write (D102).
 *
 * Inside `transaction(fn)`, `fn` must use `tx` only: a call on the driver itself would wait for
 * the transaction to end, which waits for `fn` — a deadlock. `Store` keeps to this.
 */
export class ExpoSqliteDriver implements SqlDriver {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly conn: Connection;

  constructor(private readonly db: SQLite.SQLiteDatabase) {
    this.conn = new Connection(db);
  }

  /** Open (or create) the database file in the app sandbox and set the pragmas we rely on. */
  static async open(name = 'field-survey.db'): Promise<ExpoSqliteDriver> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    return new ExpoSqliteDriver(db);
  }

  /** Delete a database file that is not open (best effort: a missing file is not an error). */
  static async remove(name: string): Promise<void> {
    try {
      await SQLite.deleteDatabaseAsync(name);
    } catch {
      // not there
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  exec(sql: string, params: SqlParam[] = []): Promise<void> {
    return this.serial(() => this.conn.exec(sql, params));
  }

  query<T extends object = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.serial(() => this.conn.query<T>(sql, params));
  }

  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.db.execAsync('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = await fn(this.conn);
      } catch (e) {
        try {
          await this.db.execAsync('ROLLBACK');
        } catch {
          // already rolled back by SQLite (e.g. after SQLITE_FULL); the original error matters
        }
        throw e;
      }
      await this.db.execAsync('COMMIT');
      return result;
    });
  }

  close(): Promise<void> {
    return this.serial(() => this.db.closeAsync());
  }
}
