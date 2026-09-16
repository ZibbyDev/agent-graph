/**
 * The FLAT BASELINE: the same facts as two plain SQLite tables, queried with
 * hand-written SQL. This is what most agent-memory stores amount to — a list
 * of events plus a list of things — and it is here so `run.ts` can show,
 * side by side, what the graph answer carries that the flat one does not.
 *
 *   entities(id, kind, label, attrs)                 one row per thing, latest state
 *   events(id, t, verb, src, dst, attrs, valid_from, valid_to,
 *          provenance, scope, superseded_at, supersedes)
 *                                                    one row per fact
 *
 * Note what had to be modelled by hand for the flat table to keep up:
 * `superseded_at` / `supersedes` are columns here only because we knew the
 * question about corrected claims was coming. In the graph they are part of
 * every assertion.
 */

import { DatabaseSync } from 'node:sqlite';
import type { Fact } from './fixture.js';

export type SqlRow = Record<string, unknown>;

export function buildFlat(facts: Fact[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, attrs TEXT NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, t INTEGER NOT NULL, verb TEXT NOT NULL,
      src TEXT NOT NULL, dst TEXT NOT NULL, attrs TEXT NOT NULL,
      valid_from INTEGER, valid_to INTEGER,
      provenance TEXT NOT NULL, scope TEXT, origin TEXT NOT NULL,
      superseded_at INTEGER, supersedes TEXT
    );
    CREATE INDEX events_verb_dst ON events(verb, dst);
    CREATE INDEX events_verb_src ON events(verb, src);
  `);

  const upsertEntity = db.prepare(
    `INSERT INTO entities (id, kind, label, attrs) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, attrs = excluded.attrs`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (id, t, verb, src, dst, attrs, valid_from, valid_to, provenance, scope, origin, superseded_at, supersedes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const retire = db.prepare(`UPDATE events SET superseded_at = ? WHERE id = ?`);
  const getEntity = db.prepare(`SELECT attrs FROM entities WHERE id = ?`);

  let seq = 0;
  const idFor = (key: string | undefined): string => key ?? `ev-${++seq}`;

  for (const fact of facts) {
    if ('node' in fact) {
      // Mirror the graph's merge rule loosely: a later write on the same id
      // overlays attrs. (The flat store has no origin rule to enforce.)
      const prev = getEntity.get(fact.node.id) as { attrs: string } | undefined;
      const attrs = prev ? { ...JSON.parse(prev.attrs), ...(fact.node.attrs ?? {}) } : (fact.node.attrs ?? {});
      upsertEntity.run(fact.node.id, fact.node.kind, fact.node.label, JSON.stringify(attrs));
    } else if ('edge' in fact) {
      const e = fact.edge;
      insertEvent.run(idFor(e.key), fact.at, e.rel, e.src, e.dst, JSON.stringify(e.attrs ?? {}), e.validFrom ?? null, e.validTo ?? null, e.provenance, e.scope ?? null, e.origin ?? fact.by, null);
    } else {
      // No permission model here: the refused attempt has nowhere to go.
      if (fact.expectDenied) continue;
      retire.run(fact.at, fact.supersede.key);
      const r = fact.supersede.replacement;
      if (r) {
        insertEvent.run(idFor(r.key), fact.at, r.rel, r.src, r.dst, JSON.stringify(r.attrs ?? {}), r.validFrom ?? null, r.validTo ?? null, r.provenance, r.scope ?? null, r.origin ?? fact.by, fact.supersede.key);
      }
    }
  }
  return db;
}

export function all(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): SqlRow[] {
  return db.prepare(sql).all(...params) as SqlRow[];
}
