/**
 * Tool definitions shared by the CLI and the MCP server.
 *
 * One definition per operation on `Graph`: a name, a description written for
 * a model deciding when to call it, a JSON Schema for the arguments (mirroring
 * `types.ts`), a read-only flag, and the `run` that applies the arguments to a
 * `Graph` handle. The CLI derives its commands from this array; the MCP server
 * derives `tools/list` from it. Neither carries its own copy of the schema, so
 * the two surfaces cannot drift.
 *
 * The schema is also what VALIDATES the arguments: every `run` below is
 * wrapped so the arguments are checked against `inputSchema` first
 * (validate.ts), and a violation is a `ValidationError` naming the field.
 * There is no second list of what a field must be.
 *
 * The `origin` of every write is the handle's origin (`--origin` on both
 * binaries); it is deliberately not an argument, because the point of the
 * origin is that the writer does not choose it per call. Likewise
 * `provenance: 'observed'` is only accepted when the binary was started with
 * `--trusted` — the tool descriptions say so, so a model does not try.
 */

import type { Graph, JsonSchema, Provenance } from './types.js';
import { validateArgs } from './validate.js';

export type { JsonSchema } from './types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when the tool never writes. `--read-only` exposes only these. */
  readOnly: boolean;
  run(graph: Graph, args: Record<string, unknown>): unknown | Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Schema building blocks
// ---------------------------------------------------------------------------

const PROVENANCE: JsonSchema = {
  type: 'string',
  enum: ['observed', 'claimed'] satisfies Provenance[],
  description:
    "Who vouches for this. 'observed' = a runtime or tool saw it happen (a file was written, a ticket moved). " +
    "'claimed' = an agent concluded or judged it (a diagnosis, a note, an opinion). Readers use this to decide how much to trust the record. " +
    "Default 'claimed'. 'observed' is accepted only when the server was started with --trusted; otherwise it is refused, so as an agent write 'claimed' (or omit).",
};

const PROVENANCE_OPTIONAL: JsonSchema = { ...PROVENANCE, description: `${PROVENANCE.description as string} Optional.` };

const ATTRS: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  description:
    'Free-form JSON attributes. Values that look like credentials (API keys, tokens, Bearer headers, private keys) are REJECTED and the write throws; never put secrets here.',
};

const MS_EPOCH = 'Integer milliseconds since the Unix epoch (Date.now()).';

const NODE_ID: JsonSchema = {
  type: 'string',
  description:
    "Canonical node id. Convention: `kind:namespace/key`, e.g. `file:github.com/org/repo/src/x.ts`, `ticket:vikunja/292`, `run:exec-7f3a`. " +
    'Mint it deterministically from the real-world identity so the same entity is one node whoever references it.',
};

const EDGE_ID: JsonSchema = {
  type: 'string',
  description: 'Edge (assertion) id, as returned by graph_link / graph_supersede or found on the `path` of a recall hit.',
};

/** Fields shared by graph_link and the `replacement` of graph_supersede. */
const EDGE_INPUT_PROPERTIES: Record<string, JsonSchema> = {
  src: { ...NODE_ID, description: 'Source node id. The node should exist (create it with graph_put first).' },
  dst: { ...NODE_ID, description: 'Destination node id. The node should exist (create it with graph_put first).' },
  rel: {
    type: 'string',
    description:
      "Relation name, free string, snake_case by convention: 'touched', 'worked_on', 'depends_on', 'in_repo', 'notes', 'returned'. The framework recognises no specific value.",
  },
  cost: {
    type: 'number',
    exclusiveMinimum: 0,
    default: 1,
    description:
      'Traversal cost; lower = closer. Recall walks cheapest-first within a budget (maxCost), so cost is how you keep hubs from pulling everything in: ' +
      "'touched the same file' might be 1, 'in the same repository' 10.",
  },
  directed: {
    type: 'boolean',
    default: true,
    description: 'Default true. An undirected edge is traversable both ways at the same cost.',
  },
  scope: {
    type: ['string', 'null'],
    description:
      'Branch / version / environment the assertion applies to (e.g. a git branch). Null or omitted = global, visible to every scoped query.',
  },
  attrs: { ...ATTRS, description: `${ATTRS.description as string} Typical: { reason }, { text }, { status }.` },
  provenance: PROVENANCE_OPTIONAL,
  validFrom: {
    type: ['integer', 'null'],
    description:
      `World time at which the fact started to hold. ${MS_EPOCH} Null OR OMITTED = unbounded past: a fact asserted now may have held before anyone recorded it, ` +
      'so a validAt query at any earlier instant still finds this edge. For "starts now" pass validFrom: Date.now() explicitly.',
  },
  validTo: {
    type: ['integer', 'null'],
    description: `World time at which the fact stopped holding. ${MS_EPOCH} Null/omitted = still holds (an OPEN fact, e.g. a run that is still editing a file).`,
  },
  recordedAt: {
    type: 'integer',
    description: `Knowledge time: when the graph learned this. ${MS_EPOCH} Defaults to now. Set it only when back-filling history.`,
  },
};

const EDGE_INPUT: JsonSchema = {
  type: 'object',
  properties: EDGE_INPUT_PROPERTIES,
  required: ['src', 'dst', 'rel'],
  additionalProperties: false,
};

const MATCH_QUERY_PROPERTIES: Record<string, JsonSchema> = {
  kind: { type: 'string', description: "Node kind to match exactly, e.g. 'file', 'ticket', 'run'." },
  label: { type: 'string', description: 'Exact label match.' },
  labelContains: { type: 'string', description: 'Case-insensitive substring on the label.' },
  attrs: {
    type: 'object',
    additionalProperties: true,
    description: 'Every listed attribute must deep-equal (as JSON) the value on the node.',
  },
  semantic: {
    type: 'string',
    description:
      'Free text: the nodes whose embedding is nearest to it, most similar first; the other criteria then filter that list. ' +
      'Only works when the graph was opened with an embedding model, and only finds nodes that were embedded (the deployment decides which kinds and which text). Errors otherwise.',
  },
  limit: { type: 'integer', minimum: 1, description: 'Maximum number of nodes to return.' },
};

const MATCH_QUERY: JsonSchema = {
  type: 'object',
  properties: MATCH_QUERY_PROPERTIES,
  additionalProperties: false,
};

/** RecallQuery, documented field by field. */
const RECALL_QUERY_PROPERTIES: Record<string, JsonSchema> = {
  seeds: {
    type: 'array',
    items: NODE_ID,
    description: 'Entry points by node id. Union with `match` and `locate`. At least one of them must resolve to a node.',
  },
  match: { ...MATCH_QUERY, description: 'Entry points by exact match on kind / label / attrs (union with `seeds`).' },
  locate: {
    type: 'string',
    description:
      'Entry points by free text (union with `seeds` / `match`): the nodes nearest to this text by embedding, or through a host-supplied locator. ' +
      'Only available when the graph was opened with an embedding model or a locator; errors otherwise. Prefer `seeds`/`match` when you know an id or an exact label.',
  },
  maxCost: {
    type: 'number',
    minimum: 0,
    default: 2,
    description:
      'Budget: maximum accumulated edge cost from any seed. Default 2. With default costs of 1 this is "two hops". Raise it to cross expensive hub edges (e.g. in_repo at cost 10).',
  },
  rels: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only traverse edges with these relation names. Omit for any. The most effective way to shape a query: list exactly the hops the question needs.',
  },
  kinds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only RETURN nodes of these kinds. Traversal still passes through other kinds, so you can ask for files reached via runs without receiving the runs.',
  },
  scope: {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'Only traverse edges with this scope (or null-scope edges, which are global). E.g. a branch name.',
  },
  provenance: {
    type: 'array',
    items: PROVENANCE,
    description: "Only traverse edges with these provenances. ['observed'] = ignore agents' claims; ['claimed'] = only conclusions.",
  },
  direction: {
    type: 'string',
    enum: ['out', 'in', 'both'],
    default: 'both',
    description: "Edge direction relative to the frontier. 'out' follows src→dst only, 'in' dst→src only, 'both' (default) either way.",
  },
  limit: { type: 'integer', minimum: 1, default: 50, description: 'Cap on returned hits. Default 50. `truncated` in the result says whether it cut.' },
  order: {
    type: 'string',
    enum: ['cost', 'recent', 'oldest'],
    default: 'cost',
    description: "'cost' (default) = closest first; 'recent' / 'oldest' = by the node's latest recordedAt.",
  },
  includeSeeds: { type: 'boolean', default: false, description: 'Include the seed nodes themselves as hits (cost 0, empty path). Default false.' },
  project: {
    type: 'string', enum: ['summary', 'full'], default: 'summary',
    description: "How much of each hit to return. 'summary' (default here): id, kind, label, provenance, time and the path's relation names — enough to decide what to look at; fetch a node's attrs by id with graph_get or graph_trace. 'full': whole records including attrs — costs tokens, ask only when you need the payloads.",
  },
  validAt: {
    type: 'integer',
    description:
      `WORLD-time filter. ${MS_EPOCH} Only traverse edges whose [validFrom, validTo] contains this instant — "what was true then". ` +
      'Use Date.now() to see only facts that still hold (e.g. files being edited RIGHT NOW: open edges with validTo null). Omit to ignore world time.',
  },
  asOf: {
    type: 'integer',
    description:
      `KNOWLEDGE-time filter. ${MS_EPOCH} What the graph KNEW at this instant: only edges recorded at or before it and not yet superseded at it, ` +
      'and each node as the VERSION current then (a node first recorded later does not exist yet: it cannot seed, match or be returned). ' +
      'Defaults to now (the live view: latest versions, superseded assertions hidden). Set it in the past to reconstruct an earlier state of knowledge, e.g. to see a claim before it was corrected.',
  },
  recordedBetween: {
    type: 'array',
    items: { type: ['integer', 'null'] },
    minItems: 2,
    maxItems: 2,
    description:
      `KNOWLEDGE-time window [from, to], each ${MS_EPOCH} or null for open-ended. Only traverse edges recorded inside it — "what was learned during round 3". ` +
      'Independent of validAt (world time) and asOf (knowledge cut-off); combine freely.',
  },
};

const RECALL_QUERY: JsonSchema = {
  type: 'object',
  properties: RECALL_QUERY_PROPERTIES,
  additionalProperties: false,
};

const TIME_AXES_NOTE =
  'Time filters: validAt = world time (was the fact true then?), asOf = knowledge time (did the graph know it then? hides later supersessions), ' +
  'recordedBetween = knowledge window (learned during this period). All optional and independent.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`"${key}" must be a non-empty string`);
  }
  return v;
}

function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new TypeError(`"${key}" must be an object`);
  }
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const definitions: ToolDefinition[] = [
  {
    name: 'graph_put',
    readOnly: false,
    description:
      'Create or update a node (an entity: a file, ticket, run, person, repo, conclusion). Upsert by id: a new id creates version 1; an existing id appends a version, so history is kept. ' +
      "Call it before linking so both ends of an edge exist. On a node another origin created you may only ADD attrs whose keys are not there yet (kind and label must match; an existing key with a different value is refused) — " +
      'use a new key or a note edge instead of overwriting. Credential-shaped values anywhere (id, kind, label, attrs) are rejected; instruction-shaped labels are accepted but flagged.',
    inputSchema: {
      type: 'object',
      properties: {
        id: NODE_ID,
        kind: { type: 'string', description: "Free-string kind: 'file', 'ticket', 'run', 'member', 'repo', 'epic', 'note', …" },
        label: { type: 'string', description: 'Human-readable name (a path, a ticket title, a run name). Used by graph_match labelContains.' },
        attrs: ATTRS,
        provenance: PROVENANCE_OPTIONAL,
        recordedAt: { type: 'integer', description: `Knowledge time of this version. ${MS_EPOCH} Defaults to now.` },
      },
      required: ['id', 'kind', 'label'],
      additionalProperties: false,
    },
    run(graph, args) {
      return graph.put(args as Parameters<Graph['put']>[0]);
    },
  },
  {
    name: 'graph_link',
    readOnly: false,
    description:
      'Assert a relation between two nodes (src →rel→ dst). Every call appends a NEW edge with its own id — it never merges with an existing one, so the same relation can be asserted by several runs, ' +
      'retired, and re-asserted. Set cost to shape later recall (cheap = close), validFrom/validTo for when the fact held in the world (omitted validFrom = has always held; omitted validTo = still holds), ' +
      "scope for branch/environment, and provenance ('claimed' unless the server was started with --trusted).",
    inputSchema: {
      ...EDGE_INPUT,
      description: 'The assertion to record. src and dst should already exist.',
    },
    run(graph, args) {
      return graph.link(args as Parameters<Graph['link']>[0]);
    },
  },
  {
    name: 'graph_supersede',
    readOnly: false,
    description:
      'Retire an assertion (edge) because it was wrong or no longer holds, optionally recording the corrected assertion in its place. Nothing is deleted: the old edge is stamped supersededAt and ' +
      'stays visible to asOf queries and graph_trace_edge. Permission: you may only supersede edges written by your own origin (or any edge when privileged). ' +
      'Use this instead of re-linking when you are correcting a claim, so readers can follow the chain.',
    inputSchema: {
      type: 'object',
      properties: {
        edgeId: { ...EDGE_ID, description: 'Id of the edge to retire.' },
        replacement: {
          ...EDGE_INPUT,
          description: 'Optional corrected assertion. Recorded with `supersedes` pointing at the retired edge and returned. Omit to retire without replacement.',
        },
      },
      required: ['edgeId'],
      additionalProperties: false,
    },
    run(graph, args) {
      const edgeId = requireString(args, 'edgeId');
      const replacement = args.replacement === undefined ? undefined : requireObject(args, 'replacement');
      return graph.supersede(edgeId, replacement as Parameters<Graph['supersede']>[1]);
    },
  },
  {
    name: 'graph_match',
    readOnly: true,
    description:
      'Find nodes by exact criteria (kind, label, labelContains, attrs). Returns latest versions only, no traversal. Use it to discover ids before a graph_recall, or to check whether an entity already exists before graph_put.',
    inputSchema: { ...MATCH_QUERY, description: 'All fields optional and ANDed together.' },
    run(graph, args) {
      return graph.match(args as Parameters<Graph['match']>[0]);
    },
  },
  {
    name: 'graph_get',
    readOnly: true,
    description:
      'Fetch one node (by `id`) or one edge (by `edgeId`) — latest version, no traversal. Returns null when unknown. Cheapest way to check existence or read current attrs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { ...NODE_ID, description: 'Node id to fetch.' },
        edgeId: { ...EDGE_ID, description: 'Edge id to fetch instead of a node.' },
      },
      oneOf: [{ required: ['id'] }, { required: ['edgeId'] }],
      additionalProperties: false,
    },
    run(graph, args) {
      const hasId = typeof args.id === 'string';
      const hasEdge = typeof args.edgeId === 'string';
      if (hasId === hasEdge) throw new TypeError('graph_get takes exactly one of "id" or "edgeId"');
      return (hasId ? graph.get(args.id as string) : graph.getEdge(args.edgeId as string)) ?? null;
    },
  },
  {
    name: 'graph_recall',
    readOnly: true,
    description:
      'The main read. Start from entry points (seeds by id and/or match) and walk the graph cheapest-first within a cost budget, returning every reachable node with its cost, the exact path of edges walked ' +
      '(each with origin, provenance, scope, validity) and which seed reached it. Shape the walk with rels (which hops), kinds (what to return), direction, scope, provenance. ' +
      TIME_AXES_NOTE +
      ' Typical questions: "which files did this member touch" (seeds member, rels [performed_by, touched], kinds [file]); "who is editing these files right now" (seeds files, rels [touched], direction in, validAt now).',
    inputSchema: { ...RECALL_QUERY, description: 'One recall query.' },
    run(graph, args) {
      // The tool surface defaults to the summary projection (the schema's
      // `default` is documentation; the validator does not fill it in).
      return graph.recall({ project: 'summary', ...(args as Parameters<Graph['recall']>[0]) });
    },
  },
  {
    name: 'graph_recall_many',
    readOnly: true,
    description:
      'Several graph_recall queries in one call and one database load. Results stay grouped per query (same order as `queries`); each hit carries `nodeId`, `cost`, `path`, `seed` — the node record itself is in ' +
      'the shared `nodes` map, exactly once however many queries reach it. Prefer this when a task needs more than one view (e.g. "what did X touch" and "who is editing T\'s files now" together).',
    inputSchema: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: RECALL_QUERY, minItems: 1, description: 'The recall queries, answered in order.' },
      },
      required: ['queries'],
      additionalProperties: false,
    },
    run(graph, args) {
      const queries = args.queries;
      if (!Array.isArray(queries)) throw new TypeError('"queries" must be an array of recall queries');
      const withDefault = (queries as Parameters<Graph['recallMany']>[0]).map((q) => ({ project: 'summary' as const, ...q }));
      return graph.recallMany(withDefault);
    },
  },
  {
    name: 'graph_subgraph',
    readOnly: true,
    description:
      'Export the induced subgraph around a query: every node a graph_recall with the same arguments would reach, plus ALL live edges among those nodes (not just the cheapest paths). ' +
      'This is the input for visualisation — "pick an area to view" — and for hand-offs that need the full local structure. Same filters as graph_recall (rels, kinds, scope, provenance, direction, maxCost); the seeds are always in `nodes`, whatever `kinds` says. ' +
      TIME_AXES_NOTE +
      ' Slice with recordedBetween to render how an area grew round by round. Ids, kinds and rels are stable, so a renderer can key colour and shape on them.',
    inputSchema: { ...RECALL_QUERY, description: 'A recall query; the result is the subgraph induced by what it reaches.' },
    run(graph, args) {
      return graph.subgraph({ project: 'summary', ...(args as Parameters<Graph['subgraph']>[0]) });
    },
  },
  {
    name: 'graph_trace',
    readOnly: true,
    description:
      "A node's full history: every version (oldest first) and every edge ever attached to it, in or out, including superseded ones. Use it to audit how an entity was described over time or to find an edge id to supersede.",
    inputSchema: {
      type: 'object',
      properties: { id: { ...NODE_ID, description: 'Node id to trace.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run(graph, args) {
      return graph.trace(requireString(args, 'id'));
    },
  },
  {
    name: 'graph_trace_edge',
    readOnly: true,
    description:
      "An assertion's supersession chain: the edge itself and every edge it replaced or was replaced by, oldest first, ending at the live assertion. Use it to see how a claim was corrected over time.",
    inputSchema: {
      type: 'object',
      properties: { id: { ...EDGE_ID, description: 'Edge id anywhere in the chain.' } },
      required: ['id'],
      additionalProperties: false,
    },
    run(graph, args) {
      return graph.traceEdge(requireString(args, 'id'));
    },
  },
  {
    name: 'graph_stats',
    readOnly: true,
    description:
      'Counts: nodes, node versions, edges, live edges, per-kind and per-rel totals, database bytes. Use it to orient in an unfamiliar graph (which kinds and rels exist) before querying.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(graph) {
      return graph.stats();
    },
  },
  {
    name: 'graph_reembed',
    readOnly: false,
    description:
      'Recompute the embedding vectors of the selected nodes (latest versions) under the graph\'s current embedding rule — after the rule changed (different text, different kinds), or to backfill nodes written before embeddings were configured. ' +
      'Nodes the rule excludes have their vector removed. Only available when the graph was opened with an embedding model. Returns { embedded, cleared, skipped }.',
    inputSchema: {
      type: 'object',
      properties: {
        kinds: { type: 'array', items: { type: 'string' }, description: 'Only nodes of these kinds. Omit for every kind the rule allows.' },
        since: { type: 'integer', description: `Only nodes whose latest version was recorded at or after this instant. ${MS_EPOCH}` },
      },
      additionalProperties: false,
    },
    run(graph, args) {
      return graph.reembed(args as Parameters<Graph['reembed']>[0]);
    },
  },
];

/**
 * The tools as the two surfaces see them: `run` validates the arguments
 * against the tool's own `inputSchema` before touching the graph, so a
 * malformed call (`recordedAt: "yesterday"`, `provenance: "invented"`, a
 * misspelt field) is refused by name at the boundary rather than half-applied
 * or silently ignored.
 */
export const tools: ToolDefinition[] = definitions.map((t) => ({
  ...t,
  run(graph, args) {
    validateArgs(t.name, t.inputSchema, args);
    return t.run(graph, args);
  },
}));

/** Lookup by tool name; undefined when unknown. */
export function findTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

/** The tools a handle may use: all of them, or only the read-only ones. */
export function toolsFor(readOnly: boolean): ToolDefinition[] {
  return readOnly ? tools.filter((t) => t.readOnly) : tools;
}

/** True when the schema declares required arguments; used by the CLI to
 *  decide whether a missing JSON argument means "read stdin" or "{}". */
export function hasRequiredArgs(tool: ToolDefinition): boolean {
  const req = tool.inputSchema.required;
  return Array.isArray(req) && req.length > 0;
}
