import type { Driver, SqlParam } from './driver.js';
import { PostgresDriver } from './drivers/postgres.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { embedNodes, reembed as reembedNodes } from './embedding.js';
import { guardFields } from './guards.js';
import { newEdgeId } from './ids.js';
import {
  COLUMNS,
  initSchema,
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
  type EmbeddingConfig,
  type Graph,
  type GraphDump,
  type GraphOptions,
  type GraphStats,
  type JournalOp,
  type Locator,
  type MatchQuery,
  type NodeId,
  type NodeRecord,
  type OpenTarget,
  type Provenance,
  type RecallManyResult,
  type RecallQuery,
  type RecallResult,
  type ReembedOptions,
  type ReembedResult,
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
 * no cache). The store knows nothing about dialects: it hands SQLite-flavoured
 * statements to the driver, which renders them (see driver.ts).
 */
export class Store {
  closed = false;

  constructor(readonly driver: Driver) {}

  /** Run one write statement; returns the number of rows it changed. */
  async run(stmt: SqlStatement): Promise<number> {
    return (await this.driver.run(stmt.sql, stmt.params)).changes;
  }

  /** Run `fn` atomically. A nested call joins the enclosing transaction, so a
   *  shared helper (`insertEdge`, `writeVersion`) can be used both on its own
   *  and inside a larger unit. */
  transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.driver.transaction(fn);
  }

  private async one(sql: string, params: SqlParam[]): Promise<SqlRow | undefined> {
    return (await this.driver.all(sql, params))[0];
  }

  /** Latest version (the live view). */
  async node(id: NodeId): Promise<NodeRecord | undefined> {
    const r = await this.one(`SELECT * FROM nodes WHERE id = ?`, [id]);
    return r ? rowToNode(r) : undefined;
  }

  /** The version current at `asOf`; `undefined` when the node did not exist
   *  yet. With `asOf` undefined this IS `node()` — the fast path stays. The
   *  version current at an instant is the highest version recorded at or
   *  before it; ordering by version (not recorded_at) keeps `asOf = now`
   *  identical to the `nodes` table even when history was back-filled out of
   *  order. Lineage columns come from `nodes`, which every version shares. */
  async nodeAt(id: NodeId, asOf: number | undefined): Promise<NodeRecord | undefined> {
    if (asOf === undefined) return this.node(id);
    const r = await this.one(
      `SELECT v.*, n.created_by, n.created_at FROM node_versions v JOIN nodes n ON n.id = v.id
       WHERE v.id = ? AND v.recorded_at <= ? ORDER BY v.version DESC LIMIT 1`,
      [id, asOf],
    );
    return r ? rowToNode(r) : undefined;
  }

  /** One specific version, or undefined. */
  async version(id: NodeId, version: number): Promise<NodeRecord | undefined> {
    const r = await this.one(
      `SELECT v.*, n.created_by, n.created_at FROM node_versions v JOIN nodes n ON n.id = v.id
       WHERE v.id = ? AND v.version = ?`,
      [id, version],
    );
    return r ? rowToNode(r) : undefined;
  }

  async edge(id: EdgeId): Promise<EdgeRecord | undefined> {
    const r = await this.one(`SELECT * FROM edges WHERE id = ?`, [id]);
    return r ? rowToEdge(r) : undefined;
  }

  /** Every row of a table, ordered by its primary key. */
  async rows(table: TableName): Promise<Row[]> {
    const order = PRIMARY_KEY[table].join(', ');
    return (await this.driver.all(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY ${order}`)).map(toRow);
  }
}

/** The per-handle settings a traversal or an embedding needs; passed to
 *  traverse.ts / embedding.ts so they never have to know the handle class. */
export interface HandleContext {
  store: Store;
  now: () => number;
  locator?: Locator;
  embedding?: EmbeddingConfig;
  /** A read must not write: a read-only handle records no access counts. */
  readOnly: boolean;
  log: (line: string) => void;
}

class GraphHandle implements Graph {
  private readonly origin?: string;
  private readonly privileged: boolean;
  private readonly trusted: boolean;
  private readonly readOnly: boolean;
  private readonly locator?: Locator;
  private readonly embedding?: EmbeddingConfig;
  private readonly now: () => number;
  private readonly journal?: (op: JournalOp) => void;
  private readonly log: (line: string) => void;

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
    this.embedding = opts.embedding;
    this.now = opts.now ?? Date.now;
    this.journal = opts.journal;
    this.log = opts.log ?? ((line) => process.stderr.write(`[agent-graph] ${line}\n`));
  }

  // -- guards shared by every write -----------------------------------------

  // Every public method is `async`, even where nothing is awaited before a
  // check can throw: a caller must see ONE failure shape (a rejection),
  // whatever the driver and whichever check fired first.
  private ctx(): HandleContext {
    this.assertOpen();
    return { store: this.store, now: this.now, locator: this.locator, embedding: this.embedding, readOnly: this.readOnly, log: this.log };
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

  async put(input: PutInput): Promise<NodeRecord> {
    this.assertWritable('put');
    const origin = this.writeOrigin(input.origin, 'put');
    if (typeof input.id !== 'string' || input.id === '') throw new Error('put: id is required');
    if (typeof input.kind !== 'string' || input.kind === '') throw new Error('put: kind is required');
    if (typeof input.label !== 'string') throw new Error('put: label is required');
    // Raw inputs are guarded before the ownership checks below, whose messages
    // quote the id — a credential-shaped id must never reach a message.
    guardFields('put', { id: input.id, kind: input.kind, label: input.label, attrs: input.attrs });

    // Read-decide-write in ONE transaction: the ownership rules below depend on
    // `existing`, and a concurrent writer must not change it under us.
    const { node, resolved } = await this.store.transaction(async () => {
      const existing = await this.store.node(input.id);
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
      return { node: await this.writeVersion(resolved, existing), resolved };
    });
    this.journal?.({ op: 'put', input: resolved, version: node.version });
    // After commit, outside the transaction: a slow or failing model call must
    // neither hold the connection nor undo a fact that was already recorded.
    if (this.embedding) {
      try {
        await embedNodes(this.ctx(), [node]);
      } catch (err) {
        this.log(`embedding of '${node.id}' v${node.version} failed (the write is committed): ${(err as Error).message}`);
      }
    }
    return node;
  }

  /** Store one fully decided version. Shared by `put` and `replay`, so the
   *  two cannot disagree about what a version row contains. Guards the content
   *  as it will be STORED (merged attrs included), so a credential cannot be
   *  smuggled in via a merge either. */
  private async writeVersion(n: ResolvedNode, existing: NodeRecord | undefined): Promise<NodeRecord> {
    const flags = guardFields('put', { id: n.id, kind: n.kind, label: n.label, origin: n.origin, attrs: n.attrs });
    const version = existing ? existing.version + 1 : 1;
    const createdBy = existing ? existing.createdBy : n.origin;
    const createdAt = existing ? existing.createdAt : n.recordedAt;
    const statements = nodeStatements(n, version, createdBy, createdAt, flags);
    await this.store.transaction(async () => {
      for (const s of statements) await this.store.run(s);
    });
    return nodeRecordFrom(n, version, createdBy, createdAt, flags);
  }

  async match(q: MatchQuery): Promise<NodeRecord[]> {
    return matchNodes(this.ctx(), q, undefined);
  }

  async get(id: NodeId): Promise<NodeRecord | undefined> {
    this.assertOpen();
    return this.store.node(id);
  }

  async trace(id: NodeId): Promise<Trace> {
    this.assertOpen();
    const node = await this.store.node(id);
    const versions = node
      ? (await this.store.driver.all(`SELECT * FROM node_versions WHERE id = ? ORDER BY version ASC`, [id])).map((r) =>
          versionRowToNode(r, node.createdBy, node.createdAt),
        )
      : [];
    const edgesOut = (await this.store.driver.all(`SELECT * FROM edges WHERE src = ? ORDER BY recorded_at ASC, id ASC`, [id])).map(rowToEdge);
    const edgesIn = (await this.store.driver.all(`SELECT * FROM edges WHERE dst = ? ORDER BY recorded_at ASC, id ASC`, [id])).map(rowToEdge);
    return { node, versions, edgesOut, edgesIn };
  }

  // -- edges ----------------------------------------------------------------

  async link(input: LinkInput): Promise<EdgeRecord> {
    this.assertWritable('link');
    const origin = this.writeOrigin(input.origin, 'link');
    const provenance = this.checkProvenance(input.provenance ?? 'claimed', 'link');
    const edge = await this.store.transaction(() => this.insertEdge('link', input, origin, provenance, null, input.recordedAt ?? this.now()));
    this.journal?.({ op: 'link', input: edgeInputOf(edge) });
    return edge;
  }

  /** Shared by `link`, `supersede` and `replay`: `supersedes` is only ever set
   *  by supersede, which is the single place allowed to relate two
   *  assertions. Guards run first, so no message below can quote a
   *  credential-shaped id. Callers wrap it in a transaction so the existence
   *  checks and the insert are one unit. */
  private async insertEdge(
    what: string,
    input: LinkInput,
    origin: string,
    provenance: Provenance,
    supersedes: EdgeId | null,
    recordedAt: number,
  ): Promise<EdgeRecord> {
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
    if (!(await this.store.node(input.src))) throw new Error(`${what}: src node '${input.src}' does not exist — put() it first`);
    if (!(await this.store.node(input.dst))) throw new Error(`${what}: dst node '${input.dst}' does not exist — put() it first`);
    // A pre-minted id is the journal's way of keeping ids stable across
    // databases; it must not collide with an assertion already recorded.
    if (input.id !== undefined) {
      if (typeof input.id !== 'string' || input.id === '') throw new Error(`${what}: id must be a non-empty string`);
      if (await this.store.edge(input.id)) throw new Error(`${what}: edge id '${input.id}' already exists`);
    }
    const edge = edgeRecordFrom(
      { ...input, id: input.id ?? newEdgeId(recordedAt), cost, attrs, origin, provenance, recordedAt },
      supersedes,
      recordedAt,
    );
    await this.store.run(edgeStatement(edge));
    return edge;
  }

  async supersede(edgeId: EdgeId, replacement?: LinkInput): Promise<EdgeRecord> {
    this.assertWritable('supersede');
    guardFields('supersede', { edgeId });
    // Decide everything about the replacement BEFORE touching the old edge, so
    // a refused replacement leaves it untouched.
    const origin = replacement ? this.writeOrigin(replacement.origin, 'supersede') : undefined;
    const result = await this.store.transaction(async () => {
      const old = await this.store.edge(edgeId);
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
      if (!replacement) {
        await this.store.run(retireStatement(edgeId, t, null));
        return { ...old, supersededAt: t, supersededBy: null };
      }
      const provenance = this.checkProvenance(replacement.provenance ?? old.provenance, 'supersede');
      const fresh = await this.insertEdge('supersede', replacement, origin!, provenance, edgeId, t);
      await this.store.run(retireStatement(edgeId, t, fresh.id));
      return fresh;
    });
    const at = replacement ? result.recordedAt : result.supersededAt!;
    this.journal?.({ op: 'supersede', edgeId, at, ...(replacement ? { replacement: edgeInputOf(result) } : {}) });
    return result;
  }

  async getEdge(id: EdgeId): Promise<EdgeRecord | undefined> {
    this.assertOpen();
    return this.store.edge(id);
  }

  async traceEdge(id: EdgeId): Promise<EdgeTrace> {
    this.assertOpen();
    const edge = await this.store.edge(id);
    if (!edge) return { edge: undefined, chain: [] };
    // Walk back to the root, then forward to the live tip. The `seen` set is
    // only a safety net: the write path cannot create a cycle, but a chain is
    // read from disk and a corrupt one must not hang the reader.
    const seen = new Set<EdgeId>([edge.id]);
    let root = edge;
    while (root.supersedes) {
      const prev = await this.store.edge(root.supersedes);
      if (!prev || seen.has(prev.id)) break;
      seen.add(prev.id);
      root = prev;
    }
    const chain: EdgeRecord[] = [root];
    let tip = root;
    const forward = new Set<EdgeId>([root.id]);
    while (tip.supersededBy) {
      const next = await this.store.edge(tip.supersededBy);
      if (!next || forward.has(next.id)) break;
      forward.add(next.id);
      chain.push(next);
      tip = next;
    }
    return { edge, chain };
  }

  // -- journal replay -------------------------------------------------------

  async replay(ops: JournalOp[]): Promise<{ applied: number; skipped: number }> {
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
    for (const [i, op] of ops.entries()) {
      try {
        if (await this.store.transaction(() => this.replayOne(op))) applied++;
        else skipped++;
      } catch (err) {
        // Ops already applied stay applied (each is its own transaction and
        // every op is idempotent), so the caller can fix the journal and
        // replay again. The index says where to look.
        if (err instanceof Error) err.message = `replay: op #${i} (${(op as { op?: string })?.op ?? '?'}): ${err.message}`;
        throw err;
      }
    }
    return { applied, skipped };
  }

  /** Apply one op; false when it is already present. Guards run through the
   *  same `writeVersion` / `insertEdge` as live writes, so a journaled
   *  credential cannot enter through the back door. Runs inside the
   *  per-op transaction `replay` opens. */
  private async replayOne(op: JournalOp): Promise<boolean> {
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
        const existing = await this.store.node(inp.id);
        // The same op seen twice: the journaled version row is already there,
        // written by the same origin at the same instant. A DIFFERENT write
        // that happens to claim the same version number (two writers that
        // both saw version 1) is not a duplicate — it is kept, as the next
        // version, rather than dropped.
        const row = await this.store.version(inp.id, op.version);
        if (row && row.origin === inp.origin && row.recordedAt === inp.recordedAt) return false;
        await this.writeVersion({ ...inp, attrs: inp.attrs ?? {}, provenance, recordedAt: inp.recordedAt }, existing);
        return true;
      }
      case 'link': {
        const inp = op.input;
        if (typeof inp?.id !== 'string' || inp.id === '') throw new Error('link op needs an explicit edge id');
        if (await this.store.edge(inp.id)) return false;
        await this.insertEdge('link', inp, explicitOrigin(inp, 'link'), this.checkProvenance(inp.provenance, 'link'), null, explicitTime(inp, 'link'));
        return true;
      }
      case 'supersede': {
        if (typeof op.edgeId !== 'string' || op.edgeId === '') throw new Error('supersede op needs edgeId');
        if (typeof op.at !== 'number' || !Number.isFinite(op.at)) throw new Error('supersede op needs an explicit at');
        guardFields('supersede', { edgeId: op.edgeId });
        const old = await this.store.edge(op.edgeId);
        if (!old) throw new Error(`supersede: edge '${op.edgeId}' does not exist (is its link op missing from the journal?)`);
        // Already retired — by this op on an earlier replay, or by another
        // writer. Either way the retirement stands and a second replacement
        // would fork the chain, so the whole op is skipped.
        if (old.supersededAt !== null) return false;
        const rep = op.replacement;
        if (rep && (typeof rep.id !== 'string' || rep.id === '')) throw new Error('supersede op replacement needs an explicit edge id');
        if (rep && (await this.store.edge(rep.id))) throw new Error(`supersede: replacement edge id '${rep.id}' already exists but '${op.edgeId}' is still live`);
        if (!rep) {
          await this.store.run(retireStatement(op.edgeId, op.at, null));
          return true;
        }
        const fresh = await this.insertEdge('supersede', rep, explicitOrigin(rep, 'supersede'), this.checkProvenance(rep.provenance, 'supersede'), op.edgeId, op.at);
        await this.store.run(retireStatement(op.edgeId, op.at, fresh.id));
        return true;
      }
      default:
        throw new Error(`unknown op '${String((op as { op?: unknown })?.op)}'`);
    }
  }

  // -- bulk snapshot --------------------------------------------------------

  async dump(): Promise<GraphDump> {
    this.assertOpen();
    return {
      schemaVersion: SCHEMA_VERSION,
      nodes: await this.store.rows('nodes'),
      nodeVersions: await this.store.rows('node_versions'),
      edges: await this.store.rows('edges'),
      access: await this.store.rows('access'),
    };
  }

  async load(dump: GraphDump): Promise<{ inserted: number; skipped: number }> {
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
    await this.store.transaction(async () => {
      for (const [table, rows, sql] of tables) {
        for (const row of rows!) {
          if (table !== 'access') {
            const { id, kind, label, origin, attrs, src, dst, rel, scope } = row;
            guardFields(`load ${table}`, { id, kind, label, origin, attrs, src, dst, rel, scope });
          }
          const changes = await this.store.run({ sql, params: rowParams(table, row) });
          if (changes > 0) inserted++;
          else skipped++;
        }
      }
    });
    return { inserted, skipped };
  }

  // -- retrieval ------------------------------------------------------------

  // The interface overloads on `project: 'summary'`; one implementation
  // serves both shapes, so the implementation signatures are the wide ones.
  async recall(q: RecallQuery): Promise<RecallResult<any, any>> {
    return recall(this.ctx(), q);
  }

  async recallMany(qs: RecallQuery[]): Promise<RecallManyResult<any, any>> {
    return recallMany(this.ctx(), qs);
  }

  async subgraph(q: RecallQuery): Promise<Subgraph<any, any>> {
    return subgraph(this.ctx(), q);
  }

  // -- embeddings -----------------------------------------------------------

  async reembed(opts: ReembedOptions = {}): Promise<ReembedResult> {
    // Vectors are derived, but writing them is still writing.
    this.assertWritable('reembed');
    return reembedNodes(this.ctx(), opts);
  }

  // -- housekeeping ---------------------------------------------------------

  async stats(): Promise<GraphStats> {
    this.assertOpen();
    const driver = this.store.driver;
    const count = async (sql: string): Promise<number> => Number((await driver.all(sql))[0]?.n ?? 0);
    const histogram = async (sql: string): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const r of await driver.all(sql)) out[r.k as string] = Number(r.n);
      return out;
    };
    return {
      nodes: await count(`SELECT COUNT(*) AS n FROM nodes`),
      nodeVersions: await count(`SELECT COUNT(*) AS n FROM node_versions`),
      edges: await count(`SELECT COUNT(*) AS n FROM edges`),
      liveEdges: await count(`SELECT COUNT(*) AS n FROM edges WHERE superseded_at IS NULL`),
      kinds: await histogram(`SELECT kind AS k, COUNT(*) AS n FROM nodes GROUP BY kind ORDER BY kind`),
      rels: await histogram(`SELECT rel AS k, COUNT(*) AS n FROM edges GROUP BY rel ORDER BY rel`),
      bytes: await driver.storageBytes(),
    };
  }

  as(origin: string, opts: Omit<GraphOptions, 'origin' | 'journal'> = {}): Graph {
    this.assertOpen();
    guardFields('as', { origin });
    // A derived handle can only give up power, never gain it: whoever holds
    // this handle was granted exactly this much, and `as()` must not be a
    // way round that. Clock, locator, embedding, journal and log are
    // properties of the database session, so they carry over.
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
      embedding: opts.embedding ?? this.embedding,
      now: opts.now ?? this.now,
      journal: this.journal,
      log: opts.log ?? this.log,
    });
  }

  async close(): Promise<void> {
    if (this.store.closed) return;
    this.store.closed = true;
    await this.store.driver.close();
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

// ---------------------------------------------------------------------------
// Opening and dropping

/** The driver for a target, connected; the schema is NOT yet initialised. */
async function driverFor(target: OpenTarget): Promise<Driver> {
  if (typeof target === 'string') return new SqliteDriver(target);
  if (target.driver === 'sqlite') return new SqliteDriver(target.path);
  if (target.driver === 'postgres') return PostgresDriver.open(target);
  throw new Error(`agent-graph: unknown driver '${String((target as { driver?: unknown }).driver)}' (sqlite | postgres)`);
}

/**
 * Open a graph. The target is a SQLite file path (created if missing, or
 * `:memory:`), or `{ driver: 'postgres', connectionString, schema }` — one
 * Postgres schema per graph. The returned handle owns the connection and is
 * the trust root: it gets exactly the grants asked for; `as()` derives
 * narrower handles over it, and `close()` on any of them closes all.
 */
export async function openGraph(target: OpenTarget, opts: GraphOptions = {}): Promise<Graph> {
  // Guard the origin before opening anything: a refused handle should not
  // leave an empty database file behind.
  guardFields('open', { origin: opts.origin });
  const driver = await driverFor(target);
  try {
    await initSchema(driver);
  } catch (err) {
    await Promise.resolve(driver.close()).catch(() => {});
    throw err;
  }
  return new GraphHandle(new Store(driver), opts);
}

/**
 * Delete a graph's storage: the SQLite file (with its WAL companions) or the
 * Postgres schema, everything in it included. Irreversible; there is no
 * `Graph` method for it on purpose — a handle that can read a graph should
 * not be one call away from erasing it.
 */
export async function dropGraph(target: OpenTarget): Promise<void> {
  const driver = await driverFor(target);
  await driver.destroy();
}
