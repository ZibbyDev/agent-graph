import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { EdgeRecord, NodeRecord, Provenance } from './types.js';

export const SCHEMA_VERSION = 1;

/**
 * Storage layout. Three ideas drive it:
 *
 *  - `node_versions` is the append-only truth for nodes; `nodes` is the latest
 *    version denormalised so that match/recall never scan history. Both are
 *    written in one transaction, so they cannot disagree.
 *  - `edges` is append-only too. Retiring an edge is an UPDATE of two
 *    bookkeeping columns (`superseded_at`, `superseded_by`), never a DELETE,
 *    which is what makes `asOf` queries possible.
 *  - `access` is deliberately a separate table keyed by edge id: it is written
 *    on every recall and must never make a read of `edges` slower or change
 *    what a read returns. It is recorded for a future, evaluated ranking
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
`;

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

export type Row = Record<string, SQLOutputValue>;

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

export function rowToNode(r: Row): NodeRecord {
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
export function versionRowToNode(r: Row, createdBy: string, createdAt: number): NodeRecord {
  return rowToNode({ ...r, created_by: createdBy, created_at: createdAt });
}

export function rowToEdge(r: Row): EdgeRecord {
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
