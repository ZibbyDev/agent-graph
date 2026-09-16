import { statSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { guardFields } from './guards.js';
import { newEdgeId } from './ids.js';
import {
  COLUMNS,
  isMemoryPath,
  openDatabase,
  PRIMARY_KEY,
  rowParams,
  rowToEdge,
  rowToNode,
  SCHEMA_VERSION,
  SQL,
  toRow,
  versionRowToNode,
  type SqlRow,
  type TableName,
} from './schema.js';
import { edgeRecordFrom, edgeStatement, nodeRecordFrom, nodeStatements, retireStatement, type ResolvedNode } from './sql.js';
import { canonical, matchNodes, recall, recallMany, subgraph } from './traverse.js';
import {
  PermissionError,
  type EdgeId,
  type EdgeInput,
  type EdgeRecord,
  type EdgeTrace,
  type Graph,
  type GraphDump,
  type GraphOptions,
  type GraphStats,
  type JournalOp,
  type Locator,
  type MatchQuery,
  type NodeId,
  type NodeRecord,
  type Provenance,
  type RecallManyResult,
  type RecallQuery,
  type RecallResult,
  type Row,
  type SqlStatement,
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
  readonly getNodeAt: StatementSync;
  readonly getVersion: StatementSync;
  readonly getEdge: StatementSync;
  /** Prepared once per distinct SQL string; the write path hands over
   *  `SqlStatement`s (see sql.ts) rather than calling named statements. */
  private readonly prepared = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    this.getNode = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`);
    // The version current at an instant: the highest version recorded at or
    // before it. Ordering by version (not recorded_at) keeps `asOf = now`
    // identical to the `nodes` table even when history was back-filled out
    // of order. Lineage columns come from `nodes`, which every version shares.
    this.getNodeAt = this.db.prepare(
      `SELECT v.*, n.created_by, n.created_at FROM node_versions v JOIN nodes n ON n.id = v.id
       WHERE v.id = ? AND v.recorded_at <= ? ORDER BY v.version DESC LIMIT 1`,
    );
    this.getVersion = this.db.prepare(
      `SELECT v.*, n.created_by, n.created_at FROM node_versions v JOIN nodes n ON n.id = v.id
       WHERE v.id = ? AND v.version = ?`,
    );
    this.getEdge = this.db.prepare(`SELECT * FROM edges WHERE id = ?`);
  }

  /** Run one write statement; returns the number of rows it changed. */
  run(stmt: SqlStatement): number {
    let p = this.prepared.get(stmt.sql);
    if (!p) {
      p = this.db.prepare(stmt.sql);
      this.prepared.set(stmt.sql, p);
    }
    return Number(p.run(...stmt.params).changes);
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

  /** Latest version (the live view). */
  node(id: NodeId): NodeRecord | undefined {
    const r = this.getNode.get(id) as SqlRow | undefined;
    return r ? rowToNode(r) : undefined;
  }

  /** The version current at `asOf`; `undefined` when the node did not exist
   *  yet. With `asOf` undefined this IS `node()` — the fast path stays. */
  nodeAt(id: NodeId, asOf: number | undefined): NodeRecord | undefined {
    if (asOf === undefined) return this.node(id);
    const r = this.getNodeAt.get(id, asOf) as SqlRow | undefined;
    return r ? rowToNode(r) : undefined;
  }

  /** One specific version, or undefined. */
  version(id: NodeId, version: number): NodeRecord | undefined {
    const r = this.getVersion.get(id, version) as SqlRow | undefined;
    return r ? rowToNode(r) : undefined;
  }

  edge(id: EdgeId): EdgeRecord | undefined {
    const r = this.getEdge.get(id) as SqlRow | undefined;
    return r ? rowToEdge(r) : undefined;
  }

  /** Every row of a table, ordered by its primary key. */
  rows(table: TableName): Row[] {
    const order = PRIMARY_KEY[table].join(', ');
    return (this.db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY ${order}`).all() as SqlRow[]).map(toRow);
  }
}

/** The per-handle settings a traversal needs; passed to traverse.ts so it
 *  never has to know about the handle class. */
export interface HandleContext {
  store: Store;
  now: () => number;
  locator?: Locator;
  /** A read must not write: a read-only handle records no access counts. */
  readOnly: boolean;
}

class GraphHandle implements Graph {
  private readonly origin?: string;
  private readonly privileged: boolean;
  private readonly trusted: boolean;
  private readonly readOnly: boolean;
  private readonly locator?: Locator;
  private readonly now: () => number;
  private readonly journal?: (op: JournalOp) => void;

  constructor(private readonly store: Store, opts: GraphOptions) {
    // The handle's own origin is persisted on every write it makes, so it is
    // guarded once here rather than on every write (and before any message
    // could echo it).
    guardFields('open', { origin: opts.origin });
    this.origin = opts.origin;
    this.privileged = opts.privileged ?? false;
    // Privilege is the maintenance role; a maintainer that may rewrite any
    // record may certainly vouch for what a runtime observed.
    this.trusted = (opts.trusted ?? false) || this.privileged;
    this.readOnly = opts.readOnly ?? false;
    this.locator = opts.locator;
    this.now = opts.now ?? Date.now;
    this.journal = opts.journal;
  }

  // -- guards shared by every write -----------------------------------------

  private ctx(): HandleContext {
    this.assertOpen();
    return { store: this.store, now: this.now, locator: this.locator, readOnly: this.readOnly };
  }

  private assertOpen(): void {
    if (this.store.closed) throw new Error('agent-graph: graph is closed');
  }

  /** Every write passes here first: a read-only handle never gets as far as
   *  the guards or the database. */
  private assertWritable(what: string): void {
    this.assertOpen();
    if (this.readOnly) throw new PermissionError(`${what}: handle is read-only`);
  }

  private writeOrigin(explicit: string | undefined, what: string): string {
    // An explicit origin is persisted, so it is guarded before any message
    // below could echo it.
    guardFields(what, { origin: explicit });
    // The origin on a write is an identity claim, and the whole permission
    // model (ownership, supersede rights) hangs off it. A handle may therefore
    // only write as itself; writing under another name — a manager recording
    // on a member's behalf — is a privileged act.
    if (explicit !== undefined && this.origin !== undefined && explicit !== this.origin && !this.privileged) {
      throw new PermissionError(`${what}: handle '${this.origin}' cannot write as '${explicit}' (open with { privileged: true })`);
    }
    const origin = explicit ?? this.origin;
    if (!origin) throw new Error(`${what}: an origin is required (open the graph with { origin } or pass it on the input)`);
    return origin;
  }

  /** `observed` means "a runtime saw this happen". A model asserting it would
   *  launder its own conclusion into evidence, so only a handle the host
   *  opened as trusted may write it. */
  private checkProvenance(p: unknown, what: string): Provenance {
    if (p !== 'observed' && p !== 'claimed') throw new Error(`${what}: provenance must be 'observed' or 'claimed'`);
    if (p === 'observed' && !this.trusted) {
      throw new PermissionError(
        `${what}: provenance 'observed' is reserved for runtimes — open the graph with { trusted: true } (or start the server with --trusted); an agent writes 'claimed'`,
      );
    }
    return p;
  }

  // -- nodes ----------------------------------------------------------------

  put(input: PutInput): NodeRecord {
    this.assertWritable('put');
    const origin = this.writeOrigin(input.origin, 'put');
    if (typeof input.id !== 'string' || input.id === '') throw new Error('put: id is required');
    if (typeof input.kind !== 'string' || input.kind === '') throw new Error('put: kind is required');
    if (typeof input.label !== 'string') throw new Error('put: label is required');
    // Raw inputs are guarded before the ownership checks below, whose messages
    // quote the id — a credential-shaped id must never reach a message.
    guardFields('put', { id: input.id, kind: input.kind, label: input.label, attrs: input.attrs });

    const existing = this.store.node(input.id);
    const recordedAt = input.recordedAt ?? this.now();
    let kind = input.kind;
    let label = input.label;
    let attrs: Record<string, unknown>;
    let provenance: unknown;

    if (!existing) {
      attrs = input.attrs ?? {};
      provenance = input.provenance ?? 'claimed';
    } else if (origin === existing.createdBy || this.privileged) {
      // The creator (or a privileged maintainer) owns the node and may change
      // anything. Omitting attrs means "leave them"; omitting provenance
      // means "as before" — both are the owner restating its own record.
      attrs = input.attrs ?? existing.attrs;
      provenance = input.provenance ?? existing.provenance;
    } else {
      // Another origin may only ENRICH: same identity (kind, label), and only
      // attrs it does not contradict. This is what lets two agents both know
      // about `file:x` without either rewriting what the other said it is —
      // including quietly, one key at a time.
      if (input.kind !== existing.kind || input.label !== existing.label) {
        throw new PermissionError(
          `put: '${input.id}' was created by origin '${existing.createdBy}'; origin '${origin}' may add attrs but not change kind/label (open with privileged: true to override)`,
        );
      }
      const added = input.attrs ?? {};
      for (const key of Object.keys(added)) {
        if (key in existing.attrs && canonical(existing.attrs[key]) !== canonical(added[key])) {
          throw new PermissionError(
            `put: '${input.id}' already has attr '${key}' (set by origin '${existing.origin}'); origin '${origin}' may add new attrs but not overwrite (open with privileged: true to override)`,
          );
        }
      }
      kind = existing.kind;
      label = existing.label;
      attrs = { ...existing.attrs, ...added };
      // No inheritance across origins: the previous version's provenance was
      // someone else's vouching. This writer states its own or gets `claimed`.
      provenance = input.provenance ?? 'claimed';
    }

    const resolved: ResolvedNode = { id: input.id, kind, label, attrs, origin, provenance: this.checkProvenance(provenance, 'put'), recordedAt };
    const node = this.writeVersion(resolved, existing);
    this.journal?.({ op: 'put', input: resolved, version: node.version });
    return node;
  }

  /** Store one fully decided version. Shared by `put` and `replay`, so the
   *  two cannot disagree about what a version row contains. Guards the content
   *  as it will be STORED (merged attrs included), so a credential cannot be
   *  smuggled in via a merge either. */
  private writeVersion(n: ResolvedNode, existing: NodeRecord | undefined): NodeRecord {
    const flags = guardFields('put', { id: n.id, kind: n.kind, label: n.label, origin: n.origin, attrs: n.attrs });
    const version = existing ? existing.version + 1 : 1;
    const createdBy = existing ? existing.createdBy : n.origin;
    const createdAt = existing ? existing.createdAt : n.recordedAt;
    const statements = nodeStatements(n, version, createdBy, createdAt, flags);
    this.store.transaction(() => {
      for (const s of statements) this.store.run(s);
    });
    return nodeRecordFrom(n, version, createdBy, createdAt, flags);
  }

  match(q: MatchQuery): NodeRecord[] {
    this.assertOpen();
    return matchNodes(this.store, q, undefined);
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
          .all(id) as SqlRow[]).map((r) => versionRowToNode(r, node.createdBy, node.createdAt))
      : [];
    const edgesOut = (this.store.db
      .prepare(`SELECT * FROM edges WHERE src = ? ORDER BY recorded_at ASC, id ASC`)
      .all(id) as SqlRow[]).map(rowToEdge);
    const edgesIn = (this.store.db
      .prepare(`SELECT * FROM edges WHERE dst = ? ORDER BY recorded_at ASC, id ASC`)
      .all(id) as SqlRow[]).map(rowToEdge);
    return { node, versions, edgesOut, edgesIn };
  }

  // -- edges ----------------------------------------------------------------

  link(input: LinkInput): EdgeRecord {
    this.assertWritable('link');
    const origin = this.writeOrigin(input.origin, 'link');
    const provenance = this.checkProvenance(input.provenance ?? 'claimed', 'link');
    const edge = this.insertEdge('link', input, origin, provenance, null, input.recordedAt ?? this.now());
    this.journal?.({ op: 'link', input: edgeInputOf(edge) });
    return edge;
  }

  /** Shared by `link`, `supersede` and `replay`: `supersedes` is only ever set
   *  by supersede, which is the single place allowed to relate two
   *  assertions. Guards run first, so no message below can quote a
   *  credential-shaped id. */
  private insertEdge(
    what: string,
    input: LinkInput,
    origin: string,
    provenance: Provenance,
    supersedes: EdgeId | null,
    recordedAt: number,
  ): EdgeRecord {
    const attrs = input.attrs ?? {};
    guardFields(what, { id: input.id, src: input.src, dst: input.dst, rel: input.rel, scope: input.scope, origin, attrs });
    if (!input.src || !input.dst) throw new Error(`${what}: src and dst are required`);
    if (!input.rel) throw new Error(`${what}: rel is required`);
    const cost = input.cost ?? 1;
    if (!(typeof cost === 'number' && Number.isFinite(cost) && cost > 0)) {
      throw new Error(`${what}: cost must be a finite number > 0 (got ${String(input.cost)})`);
    }
    // Both endpoints must exist so the graph never holds an edge to nothing;
    // a dangling reference would make every recall from it a silent miss.
    if (!this.store.node(input.src)) throw new Error(`${what}: src node '${input.src}' does not exist — put() it first`);
    if (!this.store.node(input.dst)) throw new Error(`${what}: dst node '${input.dst}' does not exist — put() it first`);
    // A pre-minted id is the journal's way of keeping ids stable across
    // databases; it must not collide with an assertion already recorded.
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || input.id === '') throw new Error(`${what}: id must be a non-empty string`);
      if (this.store.edge(input.id)) throw new Error(`${what}: edge id '${input.id}' already exists`);
    }
    const edge = edgeRecordFrom(
      { ...input, id: input.id ?? newEdgeId(recordedAt), cost, attrs, origin, provenance, recordedAt },
      supersedes,
      recordedAt,
    );
    this.store.run(edgeStatement(edge));
    return edge;
  }

  supersede(edgeId: EdgeId, replacement?: LinkInput): EdgeRecord {
    this.assertWritable('supersede');
    guardFields('supersede', { edgeId });
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
    // Decide everything about the replacement BEFORE the transaction, so a
    // refused replacement leaves the old edge untouched.
    const origin = replacement ? this.writeOrigin(replacement.origin, 'supersede') : undefined;
    const provenance = replacement ? this.checkProvenance(replacement.provenance ?? old.provenance, 'supersede') : undefined;

    const result = this.store.transaction(() => {
      if (!replacement) {
        this.store.run(retireStatement(edgeId, t, null));
        return { ...old, supersededAt: t, supersededBy: null };
      }
      const fresh = this.insertEdge('supersede', replacement, origin!, provenance!, edgeId, t);
      this.store.run(retireStatement(edgeId, t, fresh.id));
      return fresh;
    });
    this.journal?.({ op: 'supersede', edgeId, at: t, ...(replacement ? { replacement: edgeInputOf(result) } : {}) });
    return result;
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

  // -- journal replay -------------------------------------------------------

  replay(ops: JournalOp[]): { applied: number; skipped: number } {
    this.assertWritable('replay');
    // Replay writes other origins' records under their names, with their
    // provenance (`observed` included) and their timestamps: that is every
    // power the permission model reserves, so it needs every grant.
    if (!this.privileged || !this.trusted) {
      throw new PermissionError('replay: requires a handle opened with { privileged: true, trusted: true } — it re-applies other origins\' writes verbatim');
    }
    if (!Array.isArray(ops)) throw new Error('replay: ops must be an array of journal ops');
    let applied = 0;
    let skipped = 0;
    ops.forEach((op, i) => {
      try {
        if (this.replayOne(op)) applied++;
        else skipped++;
      } catch (err) {
        // Ops already applied stay applied (each is its own transaction and
        // every op is idempotent), so the caller can fix the journal and
        // replay again. The index says where to look.
        if (err instanceof Error) err.message = `replay: op #${i} (${(op as { op?: string })?.op ?? '?'}): ${err.message}`;
        throw err;
      }
    });
    return { applied, skipped };
  }

  /** Apply one op; false when it is already present. Guards run through the
   *  same `writeVersion` / `insertEdge` as live writes, so a journaled
   *  credential cannot enter through the back door. */
  private replayOne(op: JournalOp): boolean {
    switch (op.op) {
      case 'put': {
        const inp = op.input;
        if (typeof inp?.id !== 'string' || typeof inp.kind !== 'string' || typeof inp.label !== 'string') {
          throw new Error('put op needs id, kind and label');
        }
        if (typeof inp.origin !== 'string' || inp.origin === '') throw new Error('put op needs an explicit origin');
        if (typeof inp.recordedAt !== 'number' || !Number.isFinite(inp.recordedAt)) throw new Error('put op needs an explicit recordedAt');
        if (typeof op.version !== 'number') throw new Error('put op needs a version');
        const provenance = this.checkProvenance(inp.provenance, 'put');
        const existing = this.store.node(inp.id);
        // The same op seen twice: the journaled version row is already there,
        // written by the same origin at the same instant. A DIFFERENT write
        // that happens to claim the same version number (two writers that
        // both saw version 1) is not a duplicate — it is kept, as the next
        // version, rather than dropped.
        const row = this.store.version(inp.id, op.version);
        if (row && row.origin === inp.origin && row.recordedAt === inp.recordedAt) return false;
        this.writeVersion({ ...inp, attrs: inp.attrs ?? {}, provenance, recordedAt: inp.recordedAt }, existing);
        return true;
      }
      case 'link': {
        const inp = op.input;
        if (typeof inp?.id !== 'string' || inp.id === '') throw new Error('link op needs an explicit edge id');
        if (this.store.edge(inp.id)) return false;
        this.insertEdge('link', inp, explicitOrigin(inp, 'link'), this.checkProvenance(inp.provenance, 'link'), null, explicitTime(inp, 'link'));
        return true;
      }
      case 'supersede': {
        if (typeof op.edgeId !== 'string' || op.edgeId === '') throw new Error('supersede op needs edgeId');
        if (typeof op.at !== 'number' || !Number.isFinite(op.at)) throw new Error('supersede op needs an explicit at');
        guardFields('supersede', { edgeId: op.edgeId });
        const old = this.store.edge(op.edgeId);
        if (!old) throw new Error(`supersede: edge '${op.edgeId}' does not exist (is its link op missing from the journal?)`);
        // Already retired — by this op on an earlier replay, or by another
        // writer. Either way the retirement stands and a second replacement
        // would fork the chain, so the whole op is skipped.
        if (old.supersededAt !== null) return false;
        const rep = op.replacement;
        if (rep && (typeof rep.id !== 'string' || rep.id === '')) throw new Error('supersede op replacement needs an explicit edge id');
        if (rep && this.store.edge(rep.id)) throw new Error(`supersede: replacement edge id '${rep.id}' already exists but '${op.edgeId}' is still live`);
        const origin = rep ? explicitOrigin(rep, 'supersede') : undefined;
        const provenance = rep ? this.checkProvenance(rep.provenance, 'supersede') : undefined;
        this.store.transaction(() => {
          if (!rep) {
            this.store.run(retireStatement(op.edgeId, op.at, null));
            return;
          }
          const fresh = this.insertEdge('supersede', rep, origin!, provenance!, op.edgeId, op.at);
          this.store.run(retireStatement(op.edgeId, op.at, fresh.id));
        });
        return true;
      }
      default:
        throw new Error(`unknown op '${String((op as { op?: unknown })?.op)}'`);
    }
  }

  // -- bulk snapshot --------------------------------------------------------

  dump(): GraphDump {
    this.assertOpen();
    return {
      schemaVersion: SCHEMA_VERSION,
      nodes: this.store.rows('nodes'),
      nodeVersions: this.store.rows('node_versions'),
      edges: this.store.rows('edges'),
      access: this.store.rows('access'),
    };
  }

  load(dump: GraphDump): { inserted: number; skipped: number } {
    this.assertWritable('load');
    // Rows carry their own origins, provenance and timestamps — the same
    // powers replay needs, minus nothing.
    if (!this.privileged) throw new PermissionError('load: requires a privileged handle — rows carry other origins\' writes verbatim');
    if (!dump || typeof dump !== 'object') throw new Error('load: dump must be a GraphDump');
    if (typeof dump.schemaVersion !== 'number' || dump.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`load: dump schemaVersion ${String(dump.schemaVersion)} is newer than this library supports (${SCHEMA_VERSION})`);
    }
    const tables: Array<[TableName, Row[] | undefined, string]> = [
      ['node_versions', dump.nodeVersions, SQL.loadVersion],
      ['nodes', dump.nodes, SQL.loadNode],
      ['edges', dump.edges, SQL.loadEdge],
      ['access', dump.access, SQL.loadAccess],
    ];
    for (const [table, rows] of tables) {
      if (!Array.isArray(rows)) throw new Error(`load: dump.${table === 'node_versions' ? 'nodeVersions' : table} must be an array of rows`);
    }
    let inserted = 0;
    let skipped = 0;
    // One transaction: a dump is a snapshot, and half of one is worse than
    // none. Guards run on every string column — rows fetched from elsewhere
    // are as untrusted as any other input.
    this.store.transaction(() => {
      for (const [table, rows, sql] of tables) {
        for (const row of rows!) {
          if (table !== 'access') {
            const { id, kind, label, origin, attrs, src, dst, rel, scope } = row;
            guardFields(`load ${table}`, { id, kind, label, origin, attrs, src, dst, rel, scope });
          }
          const changes = this.store.run({ sql, params: rowParams(table, row) });
          if (changes > 0) inserted++;
          else skipped++;
        }
      }
    });
    return { inserted, skipped };
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

  as(origin: string, opts: Omit<GraphOptions, 'origin' | 'journal'> = {}): Graph {
    this.assertOpen();
    guardFields('as', { origin });
    // A derived handle can only give up power, never gain it: whoever holds
    // this handle was granted exactly this much, and `as()` must not be a
    // way round that. Clock, locator and journal are properties of the
    // database session, so they carry over.
    if (origin !== this.origin && !this.privileged) {
      throw new PermissionError(`as: handle '${this.origin ?? '(none)'}' cannot derive a handle for origin '${origin}' (only a privileged handle may)`);
    }
    if (opts.privileged && !this.privileged) throw new PermissionError('as: cannot grant privileged from a non-privileged handle');
    if (opts.trusted && !this.trusted) throw new PermissionError('as: cannot grant trusted from an untrusted handle');
    if (this.readOnly && opts.readOnly === false) throw new PermissionError('as: read-only is sticky and cannot be cleared');
    return new GraphHandle(this.store, {
      origin,
      privileged: opts.privileged ?? false,
      trusted: opts.trusted ?? false,
      readOnly: this.readOnly || (opts.readOnly ?? false),
      locator: opts.locator ?? this.locator,
      now: opts.now ?? this.now,
      journal: this.journal,
    });
  }

  close(): void {
    if (this.store.closed) return;
    this.store.closed = true;
    this.store.db.close();
  }
}

/** The journal form of an edge: every persisted field, explicit. `supersedes`
 *  is left out because the op kind already says it. */
function edgeInputOf(e: EdgeRecord): EdgeInput & { id: EdgeId } {
  return {
    id: e.id,
    src: e.src,
    dst: e.dst,
    rel: e.rel,
    cost: e.cost,
    directed: e.directed,
    scope: e.scope,
    attrs: e.attrs,
    origin: e.origin,
    provenance: e.provenance,
    validFrom: e.validFrom,
    validTo: e.validTo,
    recordedAt: e.recordedAt,
  };
}

function explicitOrigin(inp: EdgeInput, what: string): string {
  if (typeof inp.origin !== 'string' || inp.origin === '') throw new Error(`${what} op needs an explicit origin`);
  return inp.origin;
}

function explicitTime(inp: EdgeInput, what: string): number {
  if (typeof inp.recordedAt !== 'number' || !Number.isFinite(inp.recordedAt)) throw new Error(`${what} op needs an explicit recordedAt`);
  return inp.recordedAt;
}

/**
 * Open a graph. `path` is a SQLite file (created if missing) or `:memory:`.
 * The returned handle owns the connection and is the trust root: it gets
 * exactly the grants asked for; `as()` derives narrower handles over it, and
 * `close()` on any of them closes all.
 */
export function openGraph(path: string, opts: GraphOptions = {}): Graph {
  return new GraphHandle(new Store(path), opts);
}
