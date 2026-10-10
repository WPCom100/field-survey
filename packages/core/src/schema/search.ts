/**
 * Search over device / punch / part / photo text (PLAN §5 dashboard search, side-list search).
 *
 * `search_doc` (created by migration 0001) holds one text row per live record, kept current by
 * triggers on the four source tables. On top of it, `ensureSearchIndex` creates an FTS5
 * external-content table `search_fts` when the SQLite build has FTS5 (expo-sqlite compiles it
 * in on iOS — A21; better-sqlite3 too) and falls back to `LIKE` over `search_doc` otherwise.
 * The mode is recorded in `sync_state('search_mode')`.
 */

import type { SqlDriver } from '../sql-driver';

export type SearchMode = 'fts5' | 'like';

/** Text each source row contributes. `#` + number so "#12" finds punch 12. */
export const SEARCH_SOURCES: Record<string, { level: string; text: string[] }> = {
  device: {
    level: 'level_id',
    text: [
      'display_id',
      'category',
      'device',
      'type',
      'room_location',
      'drawing_position',
      'notes',
      'neuron_id',
      'panel_name',
    ],
  },
  punch_item: { level: 'level_id', text: ['#number', 'item', 'type', 'notes'] },
  missing_part: {
    level: 'level_id',
    text: ['#number', 'device_location', 'part', 'part_no', 'notes'],
  },
  photo: { level: 'level_id', text: ['#number', 'location', 'subject', 'what_it_shows'] },
};

function textExpr(cols: string[]): string {
  return cols
    .map((c) =>
      c.startsWith('#')
        ? `coalesce('#' || NEW.${c.slice(1)}, '')`
        : `coalesce(NEW.${c}, '')`,
    )
    .join(" || ' ' || ");
}

/** Triggers that keep `search_doc` current; part of migration 0001. */
export function searchDocTriggerSql(): string[] {
  const out: string[] = [];
  for (const [table, src] of Object.entries(SEARCH_SOURCES)) {
    const insert =
      `INSERT INTO search_doc (entity_kind, entity_id, level_id, text) ` +
      `SELECT '${table}', NEW.id, NEW.${src.level}, trim(${textExpr(src.text)}) ` +
      `WHERE NEW.deleted_at IS NULL`;
    out.push(
      `CREATE TRIGGER ${table}_search_ai AFTER INSERT ON ${table} BEGIN ${insert}; END`,
      `CREATE TRIGGER ${table}_search_au AFTER UPDATE ON ${table} BEGIN ` +
        `DELETE FROM search_doc WHERE entity_id = NEW.id; ${insert}; END`,
      `CREATE TRIGGER ${table}_search_ad AFTER DELETE ON ${table} BEGIN ` +
        `DELETE FROM search_doc WHERE entity_id = OLD.id; END`,
    );
  }
  return out;
}

const FTS_DDL = [
  `CREATE VIRTUAL TABLE search_fts USING fts5(text, entity_kind UNINDEXED, entity_id UNINDEXED, level_id UNINDEXED, content='search_doc', content_rowid='id', tokenize='unicode61')`,
  `CREATE TRIGGER search_doc_fts_ai AFTER INSERT ON search_doc BEGIN INSERT INTO search_fts(rowid, text, entity_kind, entity_id, level_id) VALUES (NEW.id, NEW.text, NEW.entity_kind, NEW.entity_id, NEW.level_id); END`,
  `CREATE TRIGGER search_doc_fts_ad AFTER DELETE ON search_doc BEGIN INSERT INTO search_fts(search_fts, rowid, text, entity_kind, entity_id, level_id) VALUES ('delete', OLD.id, OLD.text, OLD.entity_kind, OLD.entity_id, OLD.level_id); END`,
  `CREATE TRIGGER search_doc_fts_au AFTER UPDATE ON search_doc BEGIN INSERT INTO search_fts(search_fts, rowid, text, entity_kind, entity_id, level_id) VALUES ('delete', OLD.id, OLD.text, OLD.entity_kind, OLD.entity_id, OLD.level_id); INSERT INTO search_fts(rowid, text, entity_kind, entity_id, level_id) VALUES (NEW.id, NEW.text, NEW.entity_kind, NEW.entity_id, NEW.level_id); END`,
  `INSERT INTO search_fts(search_fts) VALUES ('rebuild')`,
];

async function hasTable(db: SqlDriver, name: string): Promise<boolean> {
  const rows = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Create the FTS5 index if possible and record the mode. `want = 'like'` forces the fallback
 * (tests cover both paths). Safe to call on every open.
 */
export async function ensureSearchIndex(
  db: SqlDriver,
  want: 'auto' | 'like' = 'auto',
): Promise<SearchMode> {
  let mode: SearchMode = 'like';
  if (want === 'auto') {
    if (await hasTable(db, 'search_fts')) {
      mode = 'fts5';
    } else {
      try {
        await db.transaction(async (tx) => {
          for (const s of FTS_DDL) await tx.exec(s);
        });
        mode = 'fts5';
      } catch {
        mode = 'like'; // no FTS5 in this SQLite build (A21 fallback)
      }
    }
  }
  await db.exec(
    `INSERT INTO sync_state (key, value) VALUES ('search_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(mode)],
  );
  return mode;
}

export interface SearchOptions {
  projectId?: string;
  levelId?: string;
  kinds?: string[];
  limit?: number;
}

export interface SearchHit {
  entity_kind: string;
  entity_id: string;
  level_id: string | null;
}

/** Terms as FTS5 phrases with prefix matching: `06M-04` → `"06M-04"*`, never a syntax error. */
export function ftsQuery(input: string): string {
  return input
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(' ');
}

export async function runSearch(
  db: SqlDriver,
  mode: SearchMode,
  input: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const terms = input.split(/\s+/).filter((w) => w.length > 0);
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.levelId) {
    where.push('d.level_id = ?');
    params.push(opts.levelId);
  }
  if (opts.projectId) {
    where.push('d.level_id IN (SELECT id FROM level WHERE project_id = ?)');
    params.push(opts.projectId);
  }
  if (opts.kinds && opts.kinds.length > 0) {
    where.push(`d.entity_kind IN (${opts.kinds.map(() => '?').join(', ')})`);
    params.push(...opts.kinds);
  }
  if (mode === 'fts5') {
    const sql =
      `SELECT d.entity_kind, d.entity_id, d.level_id FROM search_fts f ` +
      `JOIN search_doc d ON d.id = f.rowid WHERE search_fts MATCH ? ` +
      (where.length ? `AND ${where.join(' AND ')} ` : '') +
      `ORDER BY f.rank LIMIT ?`;
    return db.query<SearchHit>(sql, [ftsQuery(input), ...params, limit]);
  }
  const likes = terms.map(() => `d.text LIKE ? ESCAPE '\\'`);
  const likeParams = terms.map((t) => '%' + t.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  const sql =
    `SELECT d.entity_kind, d.entity_id, d.level_id FROM search_doc d WHERE ${likes.join(' AND ')} ` +
    (where.length ? `AND ${where.join(' AND ')} ` : '') +
    `ORDER BY d.entity_kind, d.text LIMIT ?`;
  return db.query<SearchHit>(sql, [...likeParams, ...params, limit]);
}
