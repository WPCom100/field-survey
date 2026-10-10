export type SqlParam = string | number | null | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqlDriver {
  exec(sql: string, params?: SqlParam[]): Promise<void>;
  query<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}
