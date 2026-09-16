import { statSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { guardWrite } from './guards.js';
import { newEdgeId } from './ids.js';
import { isMemoryPath, openDatabase, rowToEdge, rowToNode, versionRowToNode, type Row } from './schema.js';
import { matchNodes, recall, recallMany, subgraph } from './traverse.js';
import {
  PermissionError,
  type EdgeId,
  type EdgeInput,
  type EdgeRecord,
  type EdgeTrace,
  type Graph,
  type GraphOptions,
  type GraphStats,
  type Locator,
  type MatchQuery,
  type NodeId,
  type NodeRecord,
  type RecallManyResult,
  type RecallQuery,
  type RecallResult,
  type Subgraph,
  type Trace,
} from './types.js';

type PutInput = Parameters<Graph['put']>[0];
type LinkInput = Parameters<Graph['link']>[0];

/**
 * One `Store` per database connection; N handles share it. Handles differ
 * only in origin / permissions / locator / clock, so `as()` is cheap and
 * every handle sees every other handle's writes immediately (same connection,
 * no cache).
 */
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  closed = false;

  readonly getNode: StatementSync;
  readonly getEdge: StatementSync;
  readonly insertVersion: StatementSync;
  readonly upsertNode: StatementSync;
  readonly insertEdge: StatementSync;
  readonly retireEdge: StatementSync;
  readonly bumpAccess: StatementSync;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    this.getNode = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`);
    this.getEdge = this.db.prepare(`SELECT * FROM edges WHERE id = ?`);
    this.insertVersion = this.db.prepare(
      `INSERT INTO node_versions (id, version, kind, label, attrs, origin, provenance, recorded_at, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.upsertNode = this.db.prepare(
      `INSERT INTO nodes (id, kind, label, attrs, origin, provenance, version, recorded_at, created_by, created_at, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         kind = excluded.kind, label = excluded.label, attrs = excluded.attrs,
         origin = excluded.origin, provenance = excluded.provenance, version = excluded.version,
         recorded_at = excluded.recorded_at, flags = excluded.flags`,
    );
    this.insertEdge = this.db.prepare(
      `INSERT INTO edges (id, src, dst, rel, cost, directed, scope, attrs, origin, provenance,
                          valid_from, valid_to, recorded_at, superseded_at, supersedes, superseded_by, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
    );
    this.retireEdge = this.db.prepare(
      `UPDATE edges SET superseded_at = ?, superseded_by = ? WHERE id = ? AND superseded_at IS NULL`,
    );
    this.bumpAccess = this.db.prepare(
      `INSERT INTO access (edge_id, count, last_at) VALUES (?, 1, ?)
       ON CONFLICT (edge_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    );
  }

  /** Run `fn` inside a transaction. Nested calls are not supported and not
   *  needed: every public write is a single unit. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  node(id: NodeId): NodeRecord | undefined {
    const r = this.getNode.get(id) as Row | undefined;
    return r ? rowToNode(r) : undefined;
  }

  edge(id: EdgeId): EdgeRecord | undefined {
    const r = this.getEdge.get(id) as Row | undefined;
    return r ? rowToEdge(r) : undefined;
  }
}

/** The per-handle settings a traversal needs; passed to traverse.ts so it
 *  never has to know about the handle class. */
export interface HandleContext {
  store: Store;
  now: () => number;
  locator?: Locator;
}

class GraphHandle implements Graph {
  private readonly origin?: string;
  private readonly privileged: boolean;
  private readonly readOnly: boolean;
  private readonly locator?: Locator;
  private readonly now: () => number;

  constructor(private readonly store: Store, opts: GraphOptions) {
    this.origin = opts.origin;
    this.privileged = opts.privileged ?? false;
    this.readOnly = opts.readOnly ?? false;
    this.locator = opts.locator;
    this.now = opts.now ?? Date.now;
  }

  // -- guards shared by every write -----------------------------------------

  private ctx(): HandleContext {
    this.assertOpen();
    return { store: this.store, now: this.now, locator: this.locator };
  }

  private assertOpen(): void {
    if (this.store.closed) throw new Error('agent-graph: graph is closed');
  }

  /** Every write passes here first: a read-only handle never gets as far as
   *  the guards or the database. */
  private writeOrigin(explicit: string | undefined, what: string): string {
    this.assertOpen();
    if (this.readOnly) throw new PermissionError(`${what}: handle is read-only`);
    const origin = explicit ?? this.origin;
    if (!origin) throw new Error(`${what}: an origin is required (open the graph with { origin } or pass it on the input)`);
    return origin;
  }

  // -- nodes ----------------------------------------------------------------

  put(input: PutInput): NodeRecord {
    const origin = this.writeOrigin(input.origin, 'put');
    if (!input.id) throw new Error('put: id is required');
    if (!input.kind) throw new Error('put: kind is required');
    if (typeof input.label !== 'string') throw new Error('put: label is required');

    const existing = this.store.node(input.id);
    const recordedAt = input.recordedAt ?? this.now();
    let kind = input.kind;
    let label = input.label;
    let attrs: Record<string, unknown>;
    let provenance = input.provenance ?? existing?.provenance ?? 'claimed';

    if (!existing) {
      attrs = input.attrs ?? {};
    } else if (origin === existing.createdBy || this.privileged) {
      // The creator (or a privileged maintainer) owns the node and may change
      // anything. Omitting attrs means "leave them"; passing them replaces.
      attrs = input.attrs ?? existing.attrs;
    } else {
      // Another origin may only ENRICH: same identity (kind, label), attrs
      // shallow-merged on top of what is there. This is what lets two agents
      // both know about `file:x` without either being able to rewrite what
      // the other said it is.
      if (input.kind !== existing.kind || input.label !== existing.label) {
        throw new PermissionError(
          `put: '${input.id}' was created by origin '${existing.createdBy}'; origin '${origin}' may merge attrs but not change kind/label (open with privileged: true to override)`,
        );
      }
      kind = existing.kind;
      label = existing.label;
      attrs = { ...existing.attrs, ...(input.attrs ?? {}) };
    }

    // Guard the content as it will be STORED (merged attrs included), so a
    // credential cannot be smuggled in via a merge either.
    const flags = guardWrite(`node '${input.id}'`, label, attrs);

    const version = existing ? existing.version + 1 : 1;
    const createdBy = existing ? existing.createdBy : origin;
    const createdAt = existing ? existing.createdAt : recordedAt;
    const attrsJson = JSON.stringify(attrs);
    const flagsJson = JSON.stringify(flags);

    this.store.transaction(() => {
      this.store.insertVersion.run(input.id, version, kind, label, attrsJson, origin, provenance, recordedAt, flagsJson);
      this.store.upsertNode.run(
        input.id, kind, label, attrsJson, origin, provenance, version, recordedAt, createdBy, createdAt, flagsJson,
      );
    });

    return { id: input.id, kind, label, attrs, origin, provenance, version, recordedAt, createdBy, createdAt, flags };
  }

  match(q: MatchQuery): NodeRecord[] {
    this.assertOpen();
    return matchNodes(this.store, q);
  }

  get(id: NodeId): NodeRecord | undefined {
    this.assertOpen();
    return this.store.node(id);
  }

  trace(id: NodeId): Trace {
    this.assertOpen();
    const node = this.store.node(id);
    const versions = node
      ? (this.store.db
          .prepare(`SELECT * FROM node_versions WHERE id = ? ORDER BY version ASC`)
          .all(id) as Row[]).map((r) => versionRowToNode(r, node.createdBy, node.createdAt))
      : [];
    const edgesOut = (this.store.db
      .prepare(`SELECT * FROM edges WHERE src = ? ORDER BY recorded_at ASC, id ASC`)
      .all(id) as Row[]).map(rowToEdge);
    const edgesIn = (this.store.db
      .prepare(`SELECT * FROM edges WHERE dst = ? ORDER BY recorded_at ASC, id ASC`)
      .all(id) as Row[]).map(rowToEdge);
    return { node, versions, edgesOut, edgesIn };
  }

  // -- edges ----------------------------------------------------------------

  link(input: LinkInput): EdgeRecord {
    const origin = this.writeOrigin(input.origin, 'link');
    return this.insertEdge(input, origin, input.provenance ?? 'claimed', null, input.recordedAt ?? this.now());
  }

  /** Shared by `link` and `supersede`: `supersedes` is only ever set by the
   *  latter, which is the single place allowed to relate two assertions. */
  private insertEdge(
    input: LinkInput,
    origin: string,
    provenance: EdgeInput['provenance'],
    supersedes: EdgeId | null,
    recordedAt: number,
  ): EdgeRecord {
    if (!input.src || !input.dst) throw new Error('link: src and dst are required');
    if (!input.rel) throw new Error('link: rel is required');
    const cost = input.cost ?? 1;
    if (!(typeof cost === 'number' && Number.isFinite(cost) && cost > 0)) {
      throw new Error(`link: cost must be a finite number > 0 (got ${String(input.cost)})`);
    }
    // Both endpoints must exist so the graph never holds an edge to nothing;
    // a dangling reference would make every recall from it a silent miss.
    if (!this.store.node(input.src)) throw new Error(`link: src node '${input.src}' does not exist — put() it first`);
    if (!this.store.node(input.dst)) throw new Error(`link: dst node '${input.dst}' does not exist — put() it first`);

    const attrs = input.attrs ?? {};
    const flags = guardWrite(`edge ${input.src} -[${input.rel}]-> ${input.dst}`, input.rel, attrs);
    const edge: EdgeRecord = {
      id: newEdgeId(recordedAt),
      src: input.src,
      dst: input.dst,
      rel: input.rel,
      cost,
      directed: input.directed ?? true,
      scope: input.scope ?? null,
      attrs,
      origin,
      provenance,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      recordedAt,
      supersededAt: null,
      supersedes,
      supersededBy: null,
      flags,
    };
    this.store.insertEdge.run(
      edge.id, edge.src, edge.dst, edge.rel, edge.cost, edge.directed ? 1 : 0, edge.scope, JSON.stringify(attrs),
      edge.origin, edge.provenance, edge.validFrom, edge.validTo, edge.recordedAt, edge.supersedes, JSON.stringify(flags),
    );
    return edge;
  }

  supersede(edgeId: EdgeId, replacement?: LinkInput): EdgeRecord {
    this.assertOpen();
    if (this.readOnly) throw new PermissionError('supersede: handle is read-only');
    const old = this.store.edge(edgeId);
    if (!old) throw new Error(`supersede: edge '${edgeId}' does not exist`);
    if (old.supersededAt !== null) {
      throw new Error(`supersede: edge '${edgeId}' was already superseded at ${old.supersededAt}${old.supersededBy ? ` by '${old.supersededBy}'` : ''}`);
    }
    if (!this.privileged && old.origin !== this.origin) {
      throw new PermissionError(
        `supersede: edge '${edgeId}' was asserted by origin '${old.origin}'; this handle is '${this.origin ?? '(none)'}' (open with privileged: true to override)`,
      );
    }
    // Retirement and replacement share one instant so that at asOf = t the
    // graph shows exactly one of the two assertions, never both or neither.
    const t = replacement?.recordedAt ?? this.now();

    return this.store.transaction(() => {
      if (!replacement) {
        this.store.retireEdge.run(t, null, edgeId);
        return { ...old, supersededAt: t, supersededBy: null };
      }
      const origin = this.writeOrigin(replacement.origin, 'supersede');
      const fresh = this.insertEdge(replacement, origin, replacement.provenance ?? old.provenance, edgeId, t);
      this.store.retireEdge.run(t, fresh.id, edgeId);
      return fresh;
    });
  }

  getEdge(id: EdgeId): EdgeRecord | undefined {
    this.assertOpen();
    return this.store.edge(id);
  }

  traceEdge(id: EdgeId): EdgeTrace {
    this.assertOpen();
    const edge = this.store.edge(id);
    if (!edge) return { edge: undefined, chain: [] };
    // Walk back to the root, then forward to the live tip. The `seen` set is
    // only a safety net: the write path cannot create a cycle, but a chain is
    // read from disk and a corrupt one must not hang the reader.
    const seen = new Set<EdgeId>([edge.id]);
    let root = edge;
    while (root.supersedes) {
      const prev = this.store.edge(root.supersedes);
      if (!prev || seen.has(prev.id)) break;
      seen.add(prev.id);
      root = prev;
    }
    const chain: EdgeRecord[] = [root];
    let tip = root;
    const forward = new Set<EdgeId>([root.id]);
    while (tip.supersededBy) {
      const next = this.store.edge(tip.supersededBy);
      if (!next || forward.has(next.id)) break;
      forward.add(next.id);
      chain.push(next);
      tip = next;
    }
    return { edge, chain };
  }

  // -- retrieval ------------------------------------------------------------

  recall(q: RecallQuery): Promise<RecallResult> {
    return recall(this.ctx(), q);
  }

  recallMany(qs: RecallQuery[]): Promise<RecallManyResult> {
    return recallMany(this.ctx(), qs);
  }

  subgraph(q: RecallQuery): Promise<Subgraph> {
    return subgraph(this.ctx(), q);
  }

  // -- housekeeping ---------------------------------------------------------

  stats(): GraphStats {
    this.assertOpen();
    const db = this.store.db;
    const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    const histogram = (sql: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of db.prepare(sql).all() as Array<{ k: string; n: number }>) out[r.k] = Number(r.n);
      return out;
    };
    let bytes = 0;
    if (!isMemoryPath(this.store.path)) {
      try { bytes = statSync(this.store.path).size; } catch { bytes = 0; }
    }
    return {
      nodes: count(`SELECT COUNT(*) AS n FROM nodes`),
      nodeVersions: count(`SELECT COUNT(*) AS n FROM node_versions`),
      edges: count(`SELECT COUNT(*) AS n FROM edges`),
      liveEdges: count(`SELECT COUNT(*) AS n FROM edges WHERE superseded_at IS NULL`),
      kinds: histogram(`SELECT kind AS k, COUNT(*) AS n FROM nodes GROUP BY kind ORDER BY kind`),
      rels: histogram(`SELECT rel AS k, COUNT(*) AS n FROM edges GROUP BY rel ORDER BY rel`),
      bytes,
    };
  }

  as(origin: string, opts: Omit<GraphOptions, 'origin'> = {}): Graph {
    this.assertOpen();
    // Clock and locator are properties of the database session, so they carry
    // over; permissions are properties of the caller, so they start from the
    // safe default unless the new handle asks for them.
    return new GraphHandle(this.store, {
      origin,
      privileged: opts.privileged ?? false,
      readOnly: opts.readOnly ?? false,
      locator: opts.locator ?? this.locator,
      now: opts.now ?? this.now,
    });
  }

  close(): void {
    if (this.store.closed) return;
    this.store.closed = true;
    this.store.db.close();
  }
}

/**
 * Open a graph. `path` is a SQLite file (created if missing) or `:memory:`.
 * The returned handle owns the connection; `as()` derives further handles
 * over it, and `close()` on any of them closes all.
 */
export function openGraph(path: string, opts: GraphOptions = {}): Graph {
  return new GraphHandle(new Store(path), opts);
}
