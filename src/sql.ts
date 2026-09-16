/**
 * Writes as SQL statements.
 *
 * The store does not build its INSERTs inline: it asks this file for the
 * statements a decided node version or edge turns into, and runs them. The
 * same functions render a journal op for a host that wants to apply the
 * journal to a remote SQL store itself (`journalToSql`). One definition of
 * "what a write does to the tables", two consumers — so the remote copy and
 * the local one cannot disagree about a column.
 *
 * Nothing here guards content: a journaled op already passed the guards when
 * it was written, and the store guards before it gets here. The flags column
 * IS recomputed (same scan the store uses), because the journal carries the
 * content, not the derived flags.
 */

import { collectFlags } from './guards.js';
import { rowParams, SQL } from './schema.js';
import type { EdgeId, EdgeInput, EdgeRecord, JournalOp, NodeInput, NodeRecord, Row, SqlStatement } from './types.js';

/** A node version with every field decided (what `put` stores). */
export type ResolvedNode = NodeInput & { attrs: Record<string, unknown>; recordedAt: number };

/** The flags the store writes for a node version — the guard scan over every
 *  persisted string of the row. */
export function nodeFlags(n: ResolvedNode): string[] {
  return collectFlags({ id: n.id, kind: n.kind, label: n.label, origin: n.origin, attrs: n.attrs });
}

/** The two statements a node version is: the append-only history row and the
 *  denormalised latest row. `createdBy`/`createdAt` only land on a new node;
 *  the upsert leaves them alone for an existing one. */
export function nodeStatements(n: ResolvedNode, version: number, createdBy: string, createdAt: number, flags: string[]): SqlStatement[] {
  const attrs = JSON.stringify(n.attrs);
  const flagsJson = JSON.stringify(flags);
  const versionRow: Row = {
    id: n.id, version, kind: n.kind, label: n.label, attrs, origin: n.origin, provenance: n.provenance, recorded_at: n.recordedAt, flags: flagsJson,
  };
  const nodeRow: Row = {
    ...versionRow, created_by: createdBy, created_at: createdAt,
  };
  return [
    { sql: SQL.insertVersion, params: rowParams('node_versions', versionRow) },
    { sql: SQL.upsertNode, params: rowParams('nodes', nodeRow) },
  ];
}

/** Materialise an edge input (defaults applied) into the record the store
 *  writes. `id` must already be decided. */
export function edgeRecordFrom(input: EdgeInput & { id: EdgeId }, supersedes: EdgeId | null, recordedAt: number): EdgeRecord {
  const attrs = input.attrs ?? {};
  const scope = input.scope ?? null;
  return {
    id: input.id,
    src: input.src,
    dst: input.dst,
    rel: input.rel,
    cost: input.cost ?? 1,
    directed: input.directed ?? true,
    scope,
    attrs,
    origin: input.origin,
    provenance: input.provenance,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    recordedAt,
    supersededAt: null,
    supersedes,
    supersededBy: null,
    flags: collectFlags({ id: input.id, src: input.src, dst: input.dst, rel: input.rel, scope, origin: input.origin, attrs }),
  };
}

export function edgeStatement(e: EdgeRecord): SqlStatement {
  const row: Row = {
    id: e.id, src: e.src, dst: e.dst, rel: e.rel, cost: e.cost, directed: e.directed ? 1 : 0, scope: e.scope,
    attrs: JSON.stringify(e.attrs), origin: e.origin, provenance: e.provenance, valid_from: e.validFrom, valid_to: e.validTo,
    recorded_at: e.recordedAt, superseded_at: e.supersededAt, supersedes: e.supersedes, superseded_by: e.supersededBy,
    flags: JSON.stringify(e.flags),
  };
  return { sql: SQL.insertEdge, params: rowParams('edges', row) };
}

export function retireStatement(edgeId: EdgeId, at: number, by: EdgeId | null): SqlStatement {
  return { sql: SQL.retireEdge, params: [at, by, edgeId] };
}

/** The row `nodeStatements` writes to `nodes`, as a record — so `put` can
 *  return what it stored without reading it back. */
export function nodeRecordFrom(n: ResolvedNode, version: number, createdBy: string, createdAt: number, flags: string[]): NodeRecord {
  return { id: n.id, kind: n.kind, label: n.label, attrs: n.attrs, origin: n.origin, provenance: n.provenance, version, recordedAt: n.recordedAt, createdBy, createdAt, flags };
}

/**
 * Render one journal op as the statements the store would run for it, in
 * order. Pure. For a `put` the node's lineage (`created_by`, `created_at`) is
 * taken from the op itself; it is only stored when the row is NEW, which for
 * a complete journal is exactly version 1 — the same op that created it.
 */
export function journalToSql(op: JournalOp): SqlStatement[] {
  switch (op.op) {
    case 'put': {
      const n = explicitNode(op.input);
      return nodeStatements(n, op.version, n.origin, n.recordedAt, nodeFlags(n));
    }
    case 'link': {
      const e = edgeRecordFrom(op.input, null, explicitTime(op.input.recordedAt, 'link'));
      return [edgeStatement(e)];
    }
    case 'supersede': {
      if (!op.replacement) return [retireStatement(op.edgeId, op.at, null)];
      const fresh = edgeRecordFrom(op.replacement, op.edgeId, op.at);
      // Same order as the store: the replacement exists before the old edge
      // points at it, so a reader between the two never follows a dangling id.
      return [edgeStatement(fresh), retireStatement(op.edgeId, op.at, fresh.id)];
    }
    default:
      throw new Error(`journalToSql: unknown op '${String((op as { op?: unknown }).op)}'`);
  }
}

function explicitNode(n: NodeInput): ResolvedNode {
  return { ...n, attrs: n.attrs ?? {}, recordedAt: explicitTime(n.recordedAt, 'put') };
}

function explicitTime(t: number | undefined, what: string): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`journalToSql: ${what} op needs an explicit recordedAt`);
  return t;
}
