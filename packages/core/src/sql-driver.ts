export type SqlParam = string | number | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

/**
 * The one way `packages/core` touches SQLite: `ExpoSqliteDriver` on the iPad,
 * `BetterSqliteDriver` in Node (D71). Same SQL on both.
 */
export interface SqlDriver {
  /** Run a statement; with no params the text may hold several statements. */
  exec(sql: string, params?: SqlParam[]): Promise<void>;
  /** Run a query and return every row as a plain object. */
  query<T extends object = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Run `fn` inside one transaction (rolled back if it throws). Transactions do not nest. */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}
