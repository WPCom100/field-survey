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
export { Editor, EditBatch, OpError, type EditContext, type EditorOptions } from './editor';
export {
  Store,
  StoreError,
  type LocalOutcome,
  type RemoteOutcome,
  type RemoteResult,
  type PushAck,
  type OpenOptions,
  type ListOptions,
} from './store';
export {
  SyncEngine,
  TransportError,
  type SyncTransport,
  type TransportFailure,
  type PushBody,
  type PushResponse,
  type PullResponse,
  type SyncState,
  type SyncStatus,
  type SyncReport,
  type SyncLog,
  type SyncEngineOptions,
  type ReviewMark,
} from './sync';
export { HttpTransport, type HttpTransportOptions } from './http-transport';
export { HttpClient, httpFailure, errorCode, failureOf, type HttpClientOptions } from './http';
export {
  BlobQueue,
  BlobUploadError,
  UPLOAD_PRIORITY,
  DOWNLOAD_PRIORITY,
  DEFAULT_MIME,
  type BlobKind,
  type RemoteBlob,
  type BlobMeta,
  type ChunkSource,
  type BlobTransport,
  type BlobFiles,
  type BlobQueueState,
  type BlobQueueStatus,
  type BlobReport,
  type BlobLog,
  type BlobQueueOptions,
} from './blobs';
export { HttpBlobTransport, type HttpBlobTransportOptions } from './http-blob-transport';
