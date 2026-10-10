// Public surface of @field-survey/core. No React, no Expo, no Node-only imports here:
// this file is bundled into the iPad app. Node test helpers live in `./node`.

export type { SqlDriver, SqlParam, SqlRow } from './sql-driver';
export type { Op, StoredOp } from './op';
export { uuidv7, isUuid, setRandomSource, type RandomBytes } from './ids';
export * as vocab from './vocab';
export type { ChangeType, OpKind, OpState } from './vocab';
export {
  ENTITIES,
  ENTITY_KINDS,
  PROTECTED_COLUMNS,
  SYNCED_COLUMNS,
  entity,
  isOpTarget,
  encodeValue,
  decodeValue,
  decodeRow,
  type EntityKind,
  type EntitySpec,
  type ColumnSpec,
  type ColumnType,
  type EntityRole,
  type SqlValue,
} from './schema/entities';
export { MIGRATIONS, SCHEMA_VERSION, MigrationError, migrate, schemaVersion } from './schema/migrations';
export { entityDdl, createTableSql, createIndexSql } from './schema/ddl';
export {
  ensureSearchIndex,
  ftsQuery,
  runSearch,
  SEARCH_SOURCES,
  type SearchHit,
  type SearchMode,
  type SearchOptions,
} from './schema/search';
export {
  Store,
  StoreError,
  type LocalOutcome,
  type RemoteOutcome,
  type RemoteResult,
  type OpenOptions,
  type ListOptions,
} from './store';
