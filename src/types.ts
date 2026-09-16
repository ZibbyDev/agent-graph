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
 *   - v1 ranking is bounded weighted traversal only. No PageRank, no decay.
 *     Access counts are recorded but never used for ranking.
 */

export type Provenance = 'observed' | 'claimed';

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
   *  before it and not yet superseded at it. Defaults to "now" (live view). */
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

/** Batch form: one DB load, N queries. Results stay grouped by query; the
 *  `nodes` map is the shared, deduplicated node set so a node reached by
 *  several queries is serialised once. */
export interface RecallManyResult {
  results: RecallResult[];
  nodes: Record<NodeId, NodeRecord>;
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
  reason?: string;
  flags: string[];
}

export interface GraphOptions {
  /** Origin stamped on writes from this handle. Required for writes. */
  origin?: string;
  /** A privileged handle may supersede any edge and re-label any node. */
  privileged?: boolean;
  /** A read-only handle throws on any write. */
  readOnly?: boolean;
  locator?: Locator;
  /** Clock, for tests. */
  now?: () => number;
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

export interface Graph {
  /** Upsert. A new id creates version 1. An existing id appends a version:
   *  same origin may change anything; a different origin may only merge attrs
   *  (kind and label must match) unless privileged. */
  put(node: Omit<NodeInput, 'origin' | 'provenance'> & Partial<Pick<NodeInput, 'origin' | 'provenance'>>): NodeRecord;

  /** Append an assertion. Never merges with an existing edge. */
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

  trace(id: NodeId): Trace;
  traceEdge(id: EdgeId): EdgeTrace;

  stats(): GraphStats;

  /** A handle over the same database with a different origin / permissions. */
  as(origin: string, opts?: Omit<GraphOptions, 'origin'>): Graph;

  close(): void;
}
