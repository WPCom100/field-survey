/**
 * DDL from the registry. Used once to generate a migration (`scripts/gen-ddl.ts`) and by the
 * schema drift test; the migrations themselves are frozen literal SQL.
 */

import type { ColumnSpec, EntitySpec } from './entities';

const SQL_TYPE: Record<ColumnSpec['type'], string> = {
  text: 'TEXT',
  int: 'INTEGER',
  real: 'REAL',
  bool: 'INTEGER',
  json: 'TEXT',
};

function quote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function columnSql(name: string, col: ColumnSpec): string {
  let s = `${name} ${SQL_TYPE[col.type]}`;
  if (col.notNull) s += ' NOT NULL';
  if (col.default !== undefined) {
    s += ` DEFAULT ${typeof col.default === 'number' ? col.default : quote(col.default)}`;
  }
  if (col.check) s += ` CHECK (${name} IN (${col.check.map(quote).join(', ')}))`;
  return s;
}

export function createTableSql(spec: EntitySpec): string {
  const cols = Object.entries(spec.columns).map(([n, c]) => '  ' + columnSql(n, c));
  cols.push(`  PRIMARY KEY (${spec.pk.join(', ')})`);
  return `CREATE TABLE ${spec.table} (\n${cols.join(',\n')}\n)`;
}

export function createIndexSql(spec: EntitySpec): string[] {
  return (spec.indexes ?? []).map(
    (cols) => `CREATE INDEX ix_${spec.table}_${cols.join('_')} ON ${spec.table} (${cols.join(', ')})`,
  );
}

export function entityDdl(spec: EntitySpec): string[] {
  return [createTableSql(spec), ...createIndexSql(spec)];
}
