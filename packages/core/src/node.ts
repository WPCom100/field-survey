// Node-only entry (`@field-survey/core/node`): the better-sqlite3 driver for tests and tools.
// Never import this from the app.
export { BetterSqliteDriver } from './better-sqlite-driver';
// The in-memory server stand-in, for app read-model tests that need a sync round (T26).
export { FakeServer } from './testing/fake-server';
