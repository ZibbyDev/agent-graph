/**
 * agent-graph — public contract.
 *
 * Everything in this file is the API surface. The implementation files
 * (graph.ts, traverse.ts, schema.ts, redact.ts) satisfy these types; the CLI
 * and the MCP server are thin wrappers over `Graph`.
 *
 * DESIGN COMMITMENTS (from the PRD and the review reply):
 *   - Nodes and edges are UNTYPED at the framework level: `kind` and `rel`
 *     are free strings. The framework recognises no specific value.
 *   - An EDGE IS AN ASSERTION with its own id. `(src, dst, rel)` is NOT
 *     unique: the same relation can be asserted twice by two runs, invalidated
 *     and re-asserted, or hold different `scope`s at once.
 *   - Nothing is ever deleted. Invalidation is `supersede()`, which stamps the
 *     old edge and (optionally) records a replacement.
 *   - Two time axes, both explicit: `validFrom/validTo` is world time (when
 *     the fact held); `recordedAt/supersededAt` is knowledge time (when the
 *     graph learned it / retired it). Recall lets the caller pick either axis.
 *   - `provenance` is REQUIRED: `observed` (a runtime saw it) vs `claimed`
 *     (an agent judged it). Recall returns it on every hit.
 *   - Writes are scoped by `origin`. A handle opened `as(origin)` may only
 *     supersede its own edges and may not re-label another origin's node.
 *   - `observed` is a TRUSTED claim: only a handle opened `trusted: true`
 *     (a runtime, not a model) may write it. `as()` can only NARROW a handle.
 *   - v1 ranking is bounded weighted traversal only. No PageRank, no decay.
 *     Access counts are recorded but never used for ranking, and never
 *     written by a read-only handle (a read must not write).
 *   - Every successful write can be JOURNALED and later REPLAYED verbatim,
 *     so a host with no persistent disk can rebuild the graph at startup.
 */

export type Provenance = 'observed' | 'claimed';

/** A JSON Schema fragment. Kept loose on purpose: the tool schemas are data,
 *  not code, and are consumed by MCP clients as plain objects. */
export type JsonSchema = Record<string, unknown>;

/** One stored row, keyed by the SQL column names exactly as stored (`attrs`
 *  and `flags` are JSON strings, booleans are 0/1, nullable columns null). */
export type Row = Record<string, string | number | null>;

/** A whole database as rows — what `dump()` returns and `load()` takes, and
 *  the unit a host moves to and from a remote SQL store. */
export interface GraphDump {
  schemaVersion: number;
  nodes: Row[];
  nodeVersions: Row[];
  edges: Row[];
  access: Row[];
}

/** One SQL statement with positional parameters, as the store runs it. */
export interface SqlStatement {
  sql: string;
  params: Array<string | number | null>;
}

/** Canonical node id. Convention (not enforced): `kind:namespace/key`,
 *  e.g. `file:github.com/org/repo/src/x.ts`, `ticket:vikunja/292`,
 *  `run:exec-7f3a`. The caller mints it so the same entity is one node no
 *  matter which agent references it. */
export type NodeId = string;
export type EdgeId = string;

export interface NodeInput {
  id: NodeId;
  kind: string;
  label: string;
  attrs?: Record<string, unknown>;
  /** Who wrote this version (a run id, an agent name, a person). */
  origin: string;
  provenance: Provenance;
  /** ms epoch. Defaults to now. */
  recordedAt?: number;
}

export interface NodeRecord {
  id: NodeId;
  kind: string;
  label: string;
  attrs: Record<string, unknown>;
  origin: string;
  provenance: Provenance;
  /** Monotonic per node; `put()` on an existing id appends a version. */
  version: number;
  recordedAt: number;
  /** Origin that created version 1. */
  createdBy: string;
  createdAt: number;
  /** Set when a guard flagged this version's content (see `GuardReport`). */
  flags: string[];
}

export interface EdgeInput {
  src: NodeId;
  dst: NodeId;
  rel: string;
  /** Traversal cost. Lower = closer. Default 1. Must be > 0. */
  cost?: number;
  /** Default true. An undirected edge is traversable both ways at the same cost. */
  directed?: boolean;
  /** Branch / version / environment the assertion applies to. Free string. */
  scope?: string | null;
  attrs?: Record<string, unknown>;
  origin: string;
  provenance: Provenance;
  /** World time. `null` = unbounded on that side. */
  validFrom?: number | null;
  validTo?: number | null;
  /** Knowledge time. Defaults to now. */
  recordedAt?: number;
  /** Edge id this assertion replaces. Only settable through `supersede()`. */
  supersedes?: EdgeId | null;
  /** Pre-minted edge id. Optional: the graph mints one when omitted. Must be
   *  unique; a duplicate is an error on `link()` and a skip on `replay()`. */
  id?: EdgeId;
}

export interface EdgeRecord {
  id: EdgeId;
  src: NodeId;
  dst: NodeId;
  rel: string;
  cost: number;
  directed: boolean;
  scope: string | null;
  attrs: Record<string, unknown>;
  origin: string;
  provenance: Provenance;
  validFrom: number | null;
  validTo: number | null;
  recordedAt: number;
  supersededAt: number | null;
  supersedes: EdgeId | null;
  supersededBy: EdgeId | null;
  /** Set when a guard altered or flagged the content (see `GuardReport`). */
  flags: string[];
}

/** Which slice of time the caller wants. All fields optional and independent. */
export interface TimeFilter {
  /** World time: only edges whose [validFrom, validTo] contains this instant. */
  validAt?: number;
  /** Knowledge time: what the graph knew at this instant — edges recorded at or
   *  before it and not yet superseded at it, and for every node the VERSION
   *  current at that instant (a node whose first version is later does not
   *  exist yet: it cannot seed, match, or appear in hits). Defaults to "now"
   *  (live view: latest versions, live edges). */
  asOf?: number;
  /** Only edges recorded inside this window (either bound may be null). */
  recordedBetween?: [number | null, number | null];
}

export interface MatchQuery {
  kind?: string;
  /** Exact label match. */
  label?: string;
  /** Case-insensitive substring on label. */
  labelContains?: string;
  /** Every listed attr must equal (deep-equal on JSON) the node's value. */
  attrs?: Record<string, unknown>;
  limit?: number;
}

export interface RecallQuery extends TimeFilter {
  /** Entry points by id. */
  seeds?: NodeId[];
  /** Entry points by exact match (union with `seeds`). */
  match?: MatchQuery;
  /** Free-text entry through the configured `Locator` (union with the above).
   *  Errors if no locator is configured. */
  locate?: string;
  /** Maximum accumulated edge cost from any seed. Default 2. */
  maxCost?: number;
  /** Only traverse these relations (any if omitted). */
  rels?: string[];
  /** Only return nodes of these kinds (traversal still passes through others). */
  kinds?: string[];
  /** Only traverse edges with this scope (or null-scope edges, which are global). */
  scope?: string | string[];
  /** Only traverse edges with this provenance. */
  provenance?: Provenance[];
  /** Direction relative to the frontier. Default 'both'. */
  direction?: 'out' | 'in' | 'both';
  /** Cap on returned hits. Default 50. */
  limit?: number;
  /** 'cost' (default) = closest first; 'recent'/'oldest' by the node's latest recordedAt. */
  order?: 'cost' | 'recent' | 'oldest';
  /** Include the seeds themselves in hits. Default false. */
  includeSeeds?: boolean;
}

export interface RecallHit {
  node: NodeRecord;
  /** Accumulated cost of the cheapest path found. */
  cost: number;
  /** The edges walked, seed → node, in order. Empty for a seed. */
  path: EdgeRecord[];
  /** Which seed this hit was reached from. */
  seed: NodeId;
}

export interface RecallResult {
  query: RecallQuery;
  /** Resolved entry points after seeds/match/locate. */
  seeds: NodeId[];
  hits: RecallHit[];
  /** True if `limit` cut the result. */
  truncated: boolean;
  /** How the seeds were found, for the caller's audit trail. */
  seedSources: Array<{ id: NodeId; via: 'seed' | 'match' | 'locate' }>;
}

/** A hit inside a `recallMany` result: the node itself lives once in the
 *  shared `nodes` map, so a hit only names it. */
export interface RecallManyHit {
  nodeId: NodeId;
  cost: number;
  path: EdgeRecord[];
  seed: NodeId;
}

/** Batch form: one DB load, N queries. Results stay grouped by query; the
 *  `nodes` map is the shared, deduplicated node set so a node reached by
 *  several queries is serialised exactly once (hits carry `nodeId`, not the
 *  record). */
export interface RecallManyResult {
  results: Array<Omit<RecallResult, 'hits'> & { hits: RecallManyHit[] }>;
  nodes: Record<NodeId, NodeRecord>;
}

/** The induced subgraph around a recall: every reached node plus EVERY live
 *  edge (under the same filters) whose two endpoints were both reached — not
 *  only the path edges. This is what a visualiser consumes. */
export interface Subgraph {
  /** Resolved entry points, always included in `nodes`. */
  seeds: NodeId[];
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  /** True if `limit` cut the node set (edges are induced on the kept nodes). */
  truncated: boolean;
}

export interface Trace {
  /** Latest version, or undefined if the id is unknown. */
  node?: NodeRecord;
  /** Every version, oldest first. */
  versions: NodeRecord[];
  /** Edges where this node is src, all time (superseded included). */
  edgesOut: EdgeRecord[];
  /** Edges where this node is dst, all time (superseded included). */
  edgesIn: EdgeRecord[];
}

export interface EdgeTrace {
  edge?: EdgeRecord;
  /** Full supersession chain, oldest first, ending at the live assertion. */
  chain: EdgeRecord[];
}

export interface GraphStats {
  nodes: number;
  nodeVersions: number;
  edges: number;
  liveEdges: number;
  kinds: Record<string, number>;
  rels: Record<string, number>;
  /** Bytes of the database file (0 for :memory:). */
  bytes: number;
}

/** Pluggable semantic entry. The core ships no implementation that needs a
 *  model; `locate` returns candidate node ids for free text. */
export interface Locator {
  locate(text: string, opts: { limit: number }): Promise<NodeId[]>;
}

/** What a guard did to a write. Guards never silently drop content: a
 *  credential-shaped value is REJECTED (the write throws `GuardError`); an
 *  instruction-shaped label is accepted but flagged. */
export interface GuardReport {
  rejected: boolean;
  /** Names the pattern CLASS that matched ("github token"), never the text. */
  reason?: string;
  /** Which field of the write matched (`id`, `label`, `attrs`, …). */
  field?: string;
  flags: string[];
}

/**
 * One journaled write. Every field a replay needs is EXPLICIT — origin,
 * provenance, recordedAt, ids — so applying the op on another database
 * reproduces the record byte for byte, whatever that database's clock or
 * handle says. A `put` op carries the version as STORED (merged attrs, the
 * kind/label that were kept), not the raw request, because the merge rules
 * depend on who already owned the node and replay must not re-decide them.
 */
export type JournalOp =
  | { op: 'put'; input: NodeInput; version: number }
  | { op: 'link'; input: EdgeInput & { id: EdgeId } }
  | { op: 'supersede'; edgeId: EdgeId; at: number; replacement?: EdgeInput & { id: EdgeId } };

export interface GraphOptions {
  /** Origin stamped on writes from this handle. Required for writes. */
  origin?: string;
  /** A privileged handle may supersede any edge, re-label any node, write
   *  under another origin, derive handles for other origins, and `replay()`.
   *  Implies `trusted`. */
  privileged?: boolean;
  /** A trusted handle may write `provenance: 'observed'`. Meant for the
   *  runtime that actually saw the event; an agent-driven session stays
   *  untrusted and can only write `claimed`. */
  trusted?: boolean;
  /** A read-only handle throws on any write and records no access counts.
   *  Sticky: every handle derived from it is read-only too. */
  readOnly?: boolean;
  locator?: Locator;
  /** Clock, for tests. */
  now?: () => number;
  /** Called AFTER each successful write, in commit order, with the op that
   *  would reproduce it. Not called during `replay()`. Inherited by `as()`. */
  journal?: (op: JournalOp) => void;
}

export class GuardError extends Error {
  constructor(message: string, public readonly report: GuardReport) {
    super(message);
    this.name = 'GuardError';
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** A tool argument that does not fit its schema (CLI / MCP boundary). The
 *  message names the field. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface Graph {
  /** Upsert. A new id creates version 1. An existing id appends a version:
   *  the creating origin (or a privileged handle) may change anything; a
   *  different origin may only ADD attrs whose keys are not there yet (kind
   *  and label must match, an existing key with a different value is refused)
   *  and gets no inherited provenance — it states one or writes `claimed`. */
  put(node: Omit<NodeInput, 'origin' | 'provenance'> & Partial<Pick<NodeInput, 'origin' | 'provenance'>>): NodeRecord;

  /** Append an assertion. Never merges with an existing edge. `id` may be
   *  pre-minted (must be unique). */
  link(edge: Omit<EdgeInput, 'origin' | 'provenance' | 'supersedes'> & Partial<Pick<EdgeInput, 'origin' | 'provenance'>>): EdgeRecord;

  /** Retire an assertion. Permission: same origin as the edge, or privileged.
   *  With `replacement`, records the new assertion with `supersedes` set and
   *  returns it; without, returns the retired edge. */
  supersede(edgeId: EdgeId, replacement?: Omit<EdgeInput, 'origin' | 'provenance' | 'supersedes'> & Partial<Pick<EdgeInput, 'origin' | 'provenance'>>): EdgeRecord;

  /** Exact lookup of nodes (latest versions). */
  match(q: MatchQuery): NodeRecord[];

  get(id: NodeId): NodeRecord | undefined;
  getEdge(id: EdgeId): EdgeRecord | undefined;

  recall(q: RecallQuery): Promise<RecallResult>;
  recallMany(qs: RecallQuery[]): Promise<RecallManyResult>;

  /** Same seed resolution and bounded walk as `recall` (seeds always
   *  included), returning the induced subgraph instead of paths. Does not
   *  record access counts. Async only because `locate` may be. */
  subgraph(q: RecallQuery): Promise<Subgraph>;

  trace(id: NodeId): Trace;
  traceEdge(id: EdgeId): EdgeTrace;

  stats(): GraphStats;

  /** Re-apply journaled writes verbatim (origins, provenance, recordedAt and
   *  ids exactly as journaled), in the given order. Requires a privileged AND
   *  trusted handle. Idempotent: an op already present (edge id exists, put
   *  version already recorded, edge already superseded) is counted in
   *  `skipped`, so replaying overlapping journals is safe. Guards still run;
   *  the journal hook is not invoked. */
  replay(ops: JournalOp[]): { applied: number; skipped: number };

  /** Every row of every table, ordered by primary key. Any handle. */
  dump(): GraphDump;

  /** Bulk-insert rows from a `dump()`. Privileged only. Append-only tables
   *  (`node_versions`, `edges`, `access`) are INSERT OR IGNORE by primary key;
   *  `nodes` is upserted with the higher version winning — so loading the
   *  same dump twice changes nothing. Guards run on every row. Atomic. */
  load(dump: GraphDump): { inserted: number; skipped: number };

  /** A handle over the same database that can only NARROW this one: read-only
   *  is inherited and cannot be cleared; `privileged` needs a privileged
   *  parent; `trusted` needs a trusted or privileged parent; a different
   *  origin needs a privileged parent. Violations throw `PermissionError`. */
  as(origin: string, opts?: Omit<GraphOptions, 'origin' | 'journal'>): Graph;

  close(): void;
}
