# Draft issue for expo/expo: closing a database with an FTS5 table crashes (expo-sqlite)

Not filed. T153 / D251. Landry decides whether to file it (github.com/expo/expo/issues, label
`expo-sqlite`). When it is fixed upstream, `ExpoSqliteDriver.open` can drop the option.

---

**Title:** [expo-sqlite][iOS] SIGSEGV in `sqlite3Fts5IndexClose` when a database with an FTS5 table is closed (finalizeUnusedStatementsBeforeClosing finalizes FTS5's internal statements)

**Versions:** expo 57.0.27, expo-sqlite 57.0.4 (bundled SQLite 3.50.3), iOS Simulator 26.5 and iPad (iPadOS 17+).

**What happens.** A database with an FTS5 virtual table that has been written or queried (so FTS5
has prepared its internal statements) crashes the app when it is closed: on `closeAsync()`, and on
a JS reload in a dev client, when the module's `OnDestroy` closes every cached database.

```
EXC_BAD_ACCESS (SIGSEGV)
exsqlite3_finalize
sqlite3Fts5IndexClose
fts5FreeVtab
fts5DisconnectMethod
sqlite3VtabUnlock
sqlite3VtabDisconnect
disconnectAllVtab
sqlite3Close
exsqlite3_close
SQLiteModule.closeDatabase(_:)
closure #5 in SQLiteModule.definition()   // OnDestroy
```

**Why.** `closeDatabase` calls `maybeFinalizeAllStatements` (on by default), which walks
`sqlite3_next_stmt` and calls `sqlite3_finalize` on every statement of the connection. That list
includes statements FTS5 prepared for itself and still holds pointers to. `sqlite3_close` then
disconnects the virtual table, and FTS5's teardown finalizes the same, already freed, statements.

**Repro.** (Distilled from the app; the app's own crash is reproduced by `app/maestro/reload.yaml`,
this snippet has not been run on its own; try it before filing.)

```ts
const db = await SQLite.openDatabaseAsync('t.db');
await db.execAsync(`CREATE VIRTUAL TABLE IF NOT EXISTS f USING fts5(text);
  INSERT INTO f(text) VALUES ('hello');`);
await db.getAllAsync(`SELECT rowid FROM f WHERE f MATCH 'hello'`);
await db.closeAsync();   // crashes
```

**Workaround.** `openDatabaseAsync(name, { finalizeUnusedStatementsBeforeClosing: false })`.
`sqlite3_close` disconnects virtual tables before it checks for unfinalized statements, so FTS5
cleans up its own.

**Suggested fix.** Finalize only the statements expo-sqlite created (it already tracks
`NativeStatement`s), not everything `sqlite3_next_stmt` returns; or call `sqlite3_close_v2`, which
defers the close until the remaining statements are finalized.
