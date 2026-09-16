import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { EdgeRecord, NodeRecord, Provenance, Row } from './types.js';

export const SCHEMA_VERSION = 1;

/**
 * Storage layout. Three ideas drive it:
 *
 *  - `node_versions` is the append-only truth for nodes; `nodes` is the latest
 *    version denormalised so that the live view (the default `asOf`) never
 *    scans history. Both are written in one transaction, so they cannot
 *    disagree. An `asOf` in the past reads `node_versions` instead — the
 *    version current at that instant — which is why it carries the same
 *    kind/label indexes as `nodes`.
 *  - `edges` is append-only too. Retiring an edge is an UPDATE of two
 *    bookkeeping columns (`superseded_at`, `superseded_by`), never a DELETE,
 *    which is what makes `asOf` queries possible.
 *  - `access` is deliberately a separate table keyed by edge id: it is written
 *    on every recall from a writable handle (never from a read-only one) and
 *    must never make a read of `edges` slower or change what a read returns. It is recorded for a future, evaluated ranking
 *    version — nothing in v1 reads it.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS node_versions (
  id          TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  attrs       TEXT    NOT NULL,
  origin      TEXT    NOT NULL,
  provenance  TEXT    NOT NULL,
  recorded_at INTEGER NOT NULL,
  flags       TEXT    NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  attrs       TEXT    NOT NULL,
  origin      TEXT    NOT NULL,
  provenance  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  flags       TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id            TEXT PRIMARY KEY,
  src           TEXT    NOT NULL,
  dst           TEXT    NOT NULL,
  rel           TEXT    NOT NULL,
  cost          REAL    NOT NULL,
  directed      INTEGER NOT NULL,
  scope         TEXT,
  attrs         TEXT    NOT NULL,
  origin        TEXT    NOT NULL,
  provenance    TEXT    NOT NULL,
  valid_from    INTEGER,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER,
  supersedes    TEXT,
  superseded_by TEXT,
  flags         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS access (
  edge_id TEXT PRIMARY KEY,
  count   INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS edges_src         ON edges (src);
CREATE INDEX IF NOT EXISTS edges_dst         ON edges (dst);
CREATE INDEX IF NOT EXISTS edges_rel         ON edges (rel);
CREATE INDEX IF NOT EXISTS edges_recorded_at ON edges (recorded_at);
CREATE INDEX IF NOT EXISTS nodes_kind        ON nodes (kind);
CREATE INDEX IF NOT EXISTS nodes_label       ON nodes (label);
CREATE INDEX IF NOT EXISTS node_versions_kind  ON node_versions (kind);
CREATE INDEX IF NOT EXISTS node_versions_label ON node_versions (label);
`;

/**
 * Column order of each table, as the INSERT statements below bind them and as
 * `dump()` / `load()` move rows. One list per table; the DDL above is checked
 * against these lists at open time so the two cannot drift.
 */
export const COLUMNS = {
  nodes: ['id', 'kind', 'label', 'attrs', 'origin', 'provenance', 'version', 'recorded_at', 'created_by', 'created_at', 'flags'],
  node_versions: ['id', 'version', 'kind', 'label', 'attrs', 'origin', 'provenance', 'recorded_at', 'flags'],
  edges: ['id', 'src', 'dst', 'rel', 'cost', 'directed', 'scope', 'attrs', 'origin', 'provenance', 'valid_from', 'valid_to', 'recorded_at', 'superseded_at', 'supersedes', 'superseded_by', 'flags'],
  access: ['edge_id', 'count', 'last_at'],
} as const;

export type TableName = keyof typeof COLUMNS;

/** Primary key of each table, for the ordered `dump()` and the IGNORE on load. */
export const PRIMARY_KEY: Record<TableName, readonly string[]> = {
  nodes: ['id'],
  node_versions: ['id', 'version'],
  edges: ['id'],
  access: ['edge_id'],
};

function insertInto(table: TableName, prefix = 'INSERT'): string {
  const cols = COLUMNS[table];
  return `${prefix} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
}

/**
 * Every statement that writes. The store prepares exactly these strings and
 * `journalToSql()` renders exactly these strings, so "the SQL the store runs"
 * has one definition.
 */
export const SQL = {
  insertVersion: insertInto('node_versions'),
  /** Live writes always carry a higher version, so the latest row wins
   *  unconditionally. */
  upsertNode:
    `${insertInto('nodes')}
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind, label = excluded.label, attrs = excluded.attrs,
       origin = excluded.origin, provenance = excluded.provenance, version = excluded.version,
       recorded_at = excluded.recorded_at, flags = excluded.flags`,
  insertEdge: insertInto('edges'),
  retireEdge: `UPDATE edges SET superseded_at = ?, superseded_by = ? WHERE id = ? AND superseded_at IS NULL`,
  bumpAccess:
    `INSERT INTO access (edge_id, count, last_at) VALUES (?, 1, ?)
     ON CONFLICT (edge_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
  // Bulk load: append-only tables ignore a row whose key is already there;
  // `nodes` keeps whichever version is higher, because two dumps may have
  // been taken at different times and the newer one must not be undone.
  loadVersion: insertInto('node_versions', 'INSERT OR IGNORE'),
  loadEdge: insertInto('edges', 'INSERT OR IGNORE'),
  loadAccess: insertInto('access', 'INSERT OR IGNORE'),
  loadNode:
    `${insertInto('nodes')}
     ON CONFLICT (id) DO UPDATE SET
       kind = excluded.kind, label = excluded.label, attrs = excluded.attrs,
       origin = excluded.origin, provenance = excluded.provenance, version = excluded.version,
       recorded_at = excluded.recorded_at, created_by = excluded.created_by, created_at = excluded.created_at, flags = excluded.flags
     WHERE excluded.version > nodes.version`,
} as const;

/** The positional parameters for `table`, taken from a row by column name. A
 *  missing column binds NULL and lets the NOT NULL constraint speak. */
export function rowParams(table: TableName, row: Row): Array<string | number | null> {
  return COLUMNS[table].map((c) => (row[c] === undefined ? null : row[c]));
}

export function isMemoryPath(path: string): boolean {
  return path === ':memory:' || path === '' || path.startsWith('file::memory:');
}

/** Open (creating if needed) and migrate a database file. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL lets a reader (another agent's handle, a CLI `stats`) proceed while a
  // writer is mid-transaction. It is meaningless for an in-memory database.
  if (!isMemoryPath(path)) db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(DDL);
  // Tripwire: the column lists are what every write binds and what dump/load
  // move; a DDL edit that forgets them must fail here, not corrupt a row.
  for (const table of Object.keys(COLUMNS) as TableName[]) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
    const expected = [...COLUMNS[table]];
    if (actual.join(',') !== expected.join(',')) {
      db.close();
      throw new Error(`agent-graph: table ${table} has columns [${actual.join(', ')}] but this build binds [${expected.join(', ')}]`);
    }
  }
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (Number(row.value) > SCHEMA_VERSION) {
    // Refuse rather than guess: a newer writer may have added columns this
    // build does not know how to keep consistent.
    db.close();
    throw new Error(
      `agent-graph: database schema_version ${row.value} is newer than this library supports (${SCHEMA_VERSION})`,
    );
  }
  return db;
}

// ---------------------------------------------------------------------------
// Row ↔ record mapping. Kept here, next to the DDL, so a column rename has one
// place to be wrong.

export type SqlRow = Record<string, SQLOutputValue>;

/** A raw row as the public `Row` shape (bigint → number; blobs never occur). */
export function toRow(r: SqlRow): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'string' || typeof v === 'number' ? v : String(v);
  }
  return out;
}

function parseJson<T>(text: SQLOutputValue, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function num(v: SQLOutputValue): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

function numOrNull(v: SQLOutputValue): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function rowToNode(r: SqlRow): NodeRecord {
  return {
    id: r.id as string,
    kind: r.kind as string,
    label: r.label as string,
    attrs: parseJson<Record<string, unknown>>(r.attrs, {}),
    origin: r.origin as string,
    provenance: r.provenance as Provenance,
    version: num(r.version),
    recordedAt: num(r.recorded_at),
    createdBy: r.created_by as string,
    createdAt: num(r.created_at),
    flags: parseJson<string[]>(r.flags, []),
  };
}

/** A `node_versions` row lacks `created_by/created_at`; the caller supplies
 *  them from the latest row so every version carries the same lineage. */
export function versionRowToNode(r: SqlRow, createdBy: string, createdAt: number): NodeRecord {
  return rowToNode({ ...r, created_by: createdBy, created_at: createdAt });
}

export function rowToEdge(r: SqlRow): EdgeRecord {
  return {
    id: r.id as string,
    src: r.src as string,
    dst: r.dst as string,
    rel: r.rel as string,
    cost: num(r.cost),
    directed: num(r.directed) !== 0,
    scope: (r.scope as string | null) ?? null,
    attrs: parseJson<Record<string, unknown>>(r.attrs, {}),
    origin: r.origin as string,
    provenance: r.provenance as Provenance,
    validFrom: numOrNull(r.valid_from),
    validTo: numOrNull(r.valid_to),
    recordedAt: num(r.recorded_at),
    supersededAt: numOrNull(r.superseded_at),
    supersedes: (r.supersedes as string | null) ?? null,
    supersededBy: (r.superseded_by as string | null) ?? null,
    flags: parseJson<string[]>(r.flags, []),
  };
}
