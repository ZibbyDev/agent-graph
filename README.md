# agent-graph-memory

A growable, time-aware memory graph for AI agents. **One SQLite file, zero runtime dependencies** — or one Postgres schema per graph when you have a Postgres. Use it from JavaScript, from the command line, plug it into any MCP-capable agent (Claude Code, Codex, …), or run it as an HTTP sidecar serving many graphs.

## The problem it solves

When several agents work in parallel, each one produces knowledge — what it touched, what it concluded, what blocked it. Without a shared structure, the next round can't find *the part that is relevant to this task*, and a manager can only see results (tickets, PRs), never the process: which files someone touched across the last three rounds, where a twice-returned task got stuck, whether someone is editing the same files right now.

Most agent-memory systems answer this with a flat list of "facts" ranked by recency, or with a vector index that can only return what you already knew to ask about. Neither holds **relations**, and neither lets the agent say *which slice of time* it wants.

`agent-graph` is the missing layer:

- **Untyped nodes and edges.** A ticket, a run, a file, a person, a conclusion — each is a node with a free-string `kind`. Any node can link to any node with a free-string `rel`. No fixed hierarchy, no fixed depth.
- **Edges are assertions, not facts.** Each edge has its own id, an `origin` (who asserted it), a `provenance` (`observed` by a runtime vs `claimed` by an agent), an optional `scope` (branch, version, environment), and two time axes. The same relation can be asserted twice, retired, and re-asserted. Nothing is ever deleted — `supersede()` stamps the old edge and records the replacement.
- **Two time axes, both yours to pick.** `validAt` asks "what was true at this instant"; `asOf` asks "what did the graph *know* at this instant" — for edges and for nodes (you get each node as the version current then, and a node first recorded later does not exist yet). They are independent parameters, not something inferred from prose.
- **Retrieval by weighted distance.** Give it entry points and a cost budget; it walks the graph and returns every node within reach, with the exact path it took. Edge costs are yours: "touched the same file" might cost 1, "same repository" might cost 10, so a hub node can't drag the whole project in.
- **Batch queries.** One call, many questions, one database load.
- **Embeddings only where you say.** Optional, and *you* decide which kinds and which text get a vector — see [Embeddings](#embeddings-you-decide-what-gets-embedded).

## Install

```sh
npm install agent-graph-memory
npm install pg          # only if you want the Postgres driver
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

## JavaScript

Every method returns a Promise — the same handle sits over SQLite or Postgres (see [Storage drivers](#storage-drivers)).

```js
import { openGraph } from 'agent-graph-memory';

// `trusted` because this code IS the runtime: it may record what it observed.
// A handle without it (an agent's MCP session) can only write `claimed`.
const g = await openGraph('./memory.sqlite', { origin: 'run:7f3a', trusted: true });

// Every endpoint must exist before it can be linked — ids are yours to mint.
await g.put({ id: 'run:7f3a', kind: 'run', label: 'developer on ticket 292', provenance: 'observed' });
await g.put({ id: 'ticket:292', kind: 'ticket', label: 'Remove stale release note', provenance: 'observed' });
await g.put({ id: 'file:repo/src/marketplace.js', kind: 'file', label: 'src/marketplace.js', provenance: 'observed' });
await g.link({ src: 'run:7f3a', dst: 'file:repo/src/marketplace.js', rel: 'touched', cost: 1, provenance: 'observed' });
await g.link({ src: 'run:7f3a', dst: 'ticket:292', rel: 'worked_on', provenance: 'observed' });

// An agent's own conclusion — claimed, scoped to a branch:
await g.link({
  src: 'run:7f3a', dst: 'file:repo/src/marketplace.js', rel: 'notes',
  scope: 'main', provenance: 'claimed',
  attrs: { text: 'Two releaseNotes declarations; the later one wins at runtime.' },
});

// Who else touched the files this ticket plans to touch?
const r = await g.recall({ seeds: ['ticket:292'], maxCost: 2, rels: ['worked_on', 'touched'] });
for (const hit of r.hits) console.log(hit.node.id, hit.cost, hit.path.map(e => e.rel));

// What did we know a week ago? (edges as then known, nodes as then described)
await g.recall({ seeds: ['file:repo/src/marketplace.js'], asOf: Date.now() - 7 * 864e5 });

// Several questions, one load. Hits carry `nodeId`; the record is in `nodes`, once.
const many = await g.recallMany([
  { seeds: ['ticket:292'], maxCost: 2 },
  { match: { kind: 'file', labelContains: 'marketplace' }, maxCost: 1, order: 'recent' },
]);
for (const hit of many.results[0].hits) console.log(many.nodes[hit.nodeId].label, hit.cost);
```

## Command line

```sh
agent-graph --db memory.sqlite --origin run:7f3a --trusted put  '{"id":"ticket:292","kind":"ticket","label":"…","provenance":"observed"}'
agent-graph --db memory.sqlite --origin run:7f3a --trusted link '{"src":"run:7f3a","dst":"ticket:292","rel":"worked_on","provenance":"observed"}'
agent-graph --db memory.sqlite recall   '{"seeds":["ticket:292"],"maxCost":2}'
agent-graph --db memory.sqlite trace    ticket:292
agent-graph --db memory.sqlite subgraph '{"seeds":["ticket:292"],"maxCost":2}'
agent-graph --db memory.sqlite stats
echo '{"queries":[{"seeds":["ticket:292"]},{"match":{"kind":"file"}}]}' | agent-graph --db memory.sqlite recall-many
```

```
agent-graph --db <path> [--origin <o>] [--privileged] [--trusted] [--read-only] <command> [json]
```

Commands: `put`, `link`, `supersede`, `match`, `get`, `recall`, `recall-many`, `subgraph`, `trace`, `trace-edge`, `stats`, `reembed` — the same operations as the MCP tools below. Each takes one JSON object (`get`, `trace` and `trace-edge` also accept a bare id); when the argument is omitted and stdin is not a terminal, the JSON is read from stdin. Arguments are validated against the tool's schema before anything runs (`recordedAt: "yesterday"` is a `ValidationError` naming the field). Results are pretty-printed JSON on stdout; a failure is `{"error":{"name","message"}}` on stderr with exit status 1, so a shell-driven agent can tell a `GuardError` from a `PermissionError` from a `ValidationError` from a typo. `--origin` stamps every write; `--trusted` allows `provenance: "observed"` (for a runtime, not a model); `--read-only` refuses the write commands.

## MCP (Claude Code, Codex, anything that speaks MCP)

The package ships an MCP server over stdio.

The bin is `agent-graph-mcp`, shipped inside the `agent-graph` package, so `npx` needs `--package`.

**Claude Code** — `.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "--package=agent-graph-memory", "agent-graph-mcp", "--db", "./memory.sqlite", "--origin", "claude"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "--package=agent-graph-memory", "agent-graph-mcp", "--db", "./memory.sqlite", "--origin", "codex"]
```

Add `--read-only` to expose only the read tools, or `--trusted` when the server acts for a runtime that may record `provenance: "observed"` — by default an agent-driven session can only write `claimed`.

Tools exposed: `graph_put`, `graph_link`, `graph_supersede`, `graph_reembed` (writes) and `graph_match`, `graph_get`, `graph_recall`, `graph_recall_many`, `graph_subgraph`, `graph_trace`, `graph_trace_edge`, `graph_stats` (reads). Every write is stamped with `--origin`; the tool descriptions explain the two time axes (`validAt`, `asOf`, `recordedBetween`) so a model can pick the slice it needs, and every call is validated against the same schema the model was shown. The server is hand-rolled newline-delimited JSON-RPC over stdio (no SDK dependency), speaks protocol versions 2024-11-05 through 2025-06-18, and returns tool failures — guard rejections, permission refusals and schema violations included — as `isError` results the model can read and recover from.

## Summaries first, payloads on demand

A recall can return `project: 'summary'` hits — id, kind, label, provenance, time, and the path as relation names — instead of whole records. The CLI, MCP and HTTP surfaces **default to summary** because an agent pays per token and mostly needs to decide *what to look at*; it then fetches a node's attrs by id with `graph_get` / `graph_trace`, or asks `project: 'full'` when it really wants the payloads. The JS API keeps `full` as its default.

## The model, in one paragraph

A **node** is `{ id, kind, label, attrs }`; `put()` on an existing id appends a version, so history is kept. An **edge** is `{ src, dst, rel, cost, directed, scope, attrs, origin, provenance, validFrom, validTo, recordedAt, supersededAt, supersedes }`. `recall()` resolves entry points (by id, by exact match, or by free text through the configured embeddings or a `Locator` you supply), then runs a bounded cheapest-path walk, filtering edges by time, scope, relation and provenance, and returns each reachable node with its cost and path. `recallMany()` runs several of those on one load; its hits carry `nodeId` and the shared `nodes` map holds each record once. `trace()` gives a node's versions and every edge ever attached to it; `traceEdge()` follows a supersession chain.

**World time defaults.** An edge with no `validFrom` is unbounded into the past: a fact asserted now may well have held before anyone recorded it, so a `validAt` query at any earlier instant still finds it. "Starts now" is not a default — pass `validFrom: Date.now()` when you mean it. No `validTo` means the fact still holds (an open edit window, a running job).

### Visualisation

`subgraph(query)` is the renderer's input: the nodes a `recall()` with the same query would reach, plus **every** live edge among them, not only the cheapest paths — "pick an area to view". Slice it with `recordedBetween` to animate how an area grew round by round; `asOf` replays what was believed at a point in time. Ids, kinds and rels are stable strings, so colour and shape can key on them. No renderer ships in v1; the CLI (`subgraph`) and the MCP tool (`graph_subgraph`) both export it as JSON.

## Example: four questions a fleet manager asks

`npm run example` builds a small fleet in memory — three members, three rounds of runs, tickets, files, one twice-returned ticket, one corrected claim, one run still editing — and answers, side by side with hand-written SQL over a flat `events` table built from the same facts:

1. Which files did member X touch across the last three rounds, and do they overlap the files ticket T plans to touch?
2. T was returned twice — where did it get stuck each time, by which run, when?
3. T depends on D — who worked on D last round, and what was the outcome?
4. Is anyone editing, right now, the files T plans to touch? (`validAt: now` — closed edit windows fall out of the walk.)

Both give the same answer; the graph one also carries the path walked, each hop's provenance and origin, and, for the corrected claim, the round-2 view (`asOf`) next to the live one. Source: `examples/fleet/`.

## Hosts without a persistent disk

Some hosts (a serverless function, a container that is recycled, a sandbox) cannot keep the SQLite file. The graph therefore exposes its writes:

```js
import { openGraph, journalToSql } from 'agent-graph-memory';

// 1. Journal: every successful write, after commit, in commit order.
const g = await openGraph(':memory:', {
  origin: 'run:7f3a', trusted: true,
  journal: (op) => appendToDurableLog(JSON.stringify(op)),   // your append-only store
});

// 2. Replay at startup — needs a privileged AND trusted handle, because it writes
//    other origins' records verbatim (their origin, provenance, recordedAt, ids).
const boot = await openGraph(':memory:', { origin: 'boot', privileged: true });
const { applied, skipped } = await boot.replay(readWholeLog().map(JSON.parse));
```

Every op is explicit — `put` carries the version as stored (merged attrs included), `link` and `supersede` carry the edge ids the graph minted — so a replay on any database reproduces the same rows. Replay is idempotent: an op already present (edge id exists, that put version already recorded, edge already superseded) is counted as `skipped`, so overlapping journals and re-runs are safe, and two writers' journals can be merged by `recordedAt` and replayed in either merge order. Guards still run (a journaled credential is refused with the op's index; ops before it stay applied, so fix the log and replay again). The journal hook is not called during a replay.

Two more shapes for the same need. `journalToSql(op, dialect?)` renders an op as the exact `INSERT`/`UPDATE` statements the store itself runs (`'sqlite'` by default, `'postgres'` for `$n` placeholders), for a host that keeps a remote SQL copy and would rather apply the writes there than hold a log. And `dump()` / `load(dump)` move whole tables as rows: `load` is privileged, atomic, guarded, and idempotent (append-only tables `INSERT OR IGNORE` by primary key; `nodes` keeps the higher version), so a host can hydrate from rows fetched elsewhere and write rows back. Vectors are derived data and travel with neither — `reembed()` rebuilds them on the copy.

## Storage drivers

The store speaks one dialect of SQL and hands every statement to a **driver**; the driver renders it for its engine and runs it. Two ship:

| | SQLite (default) | Postgres |
|---|---|---|
| Open | `openGraph('./memory.sqlite')` or `':memory:'` | `openGraph({ driver: 'postgres', connectionString, schema })` |
| Dependencies | none (`node:sqlite`) | the `pg` package, an optional peer dependency loaded only when used |
| Unit of a graph | one file | one **schema** (`CREATE SCHEMA IF NOT EXISTS`, then `search_path`) — the tenancy unit; `dropGraph(target)` drops it |
| Embeddings | float32 blobs, cosine in JS | pgvector `vector` + `<=>` when the extension is available, BYTEA + JS cosine otherwise |
| Concurrency | one connection, statements serialised; each write is one transaction | one `pg.Client` per graph, same rules |

```js
const g = await openGraph(
  { driver: 'postgres', connectionString: 'postgres://user:pw@db/app', schema: 'tenant_42' },
  { origin: 'run:7f3a', trusted: true },
);
```

The schema DDL and every write statement have one definition (`schema.ts`); `renderSql(sql, dialect)` is exported so a host applying `journalToSql` output to its own database can render for either engine. A dump taken on one engine loads on the other — epochs are numbers, JSON is text, booleans are 0/1 on both, and Postgres text columns use `COLLATE "C"` so `ORDER BY id` agrees with SQLite's byte order.

## Embeddings: you decide what gets embedded

Off by default. Turn it on by giving the graph a model:

```js
import { openGraph, openAiCompatibleEmbedder } from 'agent-graph-memory';

const model = openAiCompatibleEmbedder({ baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', dims: 768 }); // Ollama; OpenAI and vLLM speak the same shape

const g = await openGraph('./memory.sqlite', {
  origin: 'run:7f3a', trusted: true,
  embedding: {
    ...model,
    kinds: ['note', 'ticket'],                                        // only these kinds get a vector
    text: (n) => (n.attrs.summary ? `${n.label}\n${n.attrs.summary}` : n.label),   // what the vector is OF; return null to skip a node
    maxChars: 1000,                                                   // cut before embedding
  },
});
```

**Why three knobs.** Embedding every node of a busy graph costs real money and latency for very little: a run, a file path, a repo are found by id or exact match, and only a few kinds carry prose worth a vector. So the core embeds nothing you did not select — `kinds` picks the kinds, `text` picks the words (default: the label only), `maxChars` (default 2000) caps the size — and a large graph can keep its vector table small and its model bill flat.

- `put()` embeds the new version after it commits. A failed model call is logged and **never fails the write**: a model that is down loses a vector, not a fact.
- `recall({ locate: 'rounding rule in pricing' })` and `match({ semantic: '…', kind: 'note' })` search by similarity; the query text goes through the same `embed`. `asOf` still applies (a node that did not exist then cannot be found). A host-supplied `Locator` takes precedence over the built-in search when both are configured.
- `reembed({ kinds?, since? })` recomputes vectors under the current rule — the way to change *what* is embedded after the fact, or to backfill nodes written before embeddings were on. Nodes the rule now excludes have their vector removed.
- Storage is one row per node in `node_vectors`, the vector of the version it was computed from. SQLite: brute-force cosine over the stored vectors of the requested kinds (fine at the sizes an agent memory reaches). Postgres with pgvector: `ORDER BY embedding <=> $q LIMIT k`.
- `openAiCompatibleEmbedder({ baseUrl, apiKey?, model, dims })` is the one built-in provider: a POST to `/v1/embeddings`, no SDK. It refuses a response whose dimension is not `dims`, so a misconfigured model cannot fill the table with incomparable rows. Any `{ embed(texts) => Promise<number[][]>, dims }` works in its place.

## Server mode

`agent-graph-server` is what a sidecar runs: plain `node:http`, one process, many graphs.

```sh
agent-graph-server --driver sqlite   --sqlite-dir /data/graphs [--port 8787] [--host 127.0.0.1] [--auth-token …]
agent-graph-server --driver postgres --pg postgres://user:pw@db/app [--port …] [--auth-token …]
```

| Route | Body | Result |
|---|---|---|
| `GET /health` | — | `{ ok: true, driver, version }` |
| `POST /graph/<op>` | `{ graphId, origin?, trusted?, privileged?, readOnly?, embedding?, ...toolArgs }` | the tool result as JSON |

`<op>` is a tool name without its `graph_` prefix: `put`, `link`, `supersede`, `match`, `get`, `recall`, `recall_many`, `subgraph`, `trace`, `trace_edge`, `stats`, `reembed`, plus `drop` (deletes the graph's file or schema; requires `confirm: true`). The tool arguments are validated by the same schema the CLI and MCP server use — there is one definition of the tool surface.

- **`graphId`** (required, `^[A-Za-z0-9_.:-]{1,128}$`) selects the storage: `<dir>/<graphId>.sqlite`, or the Postgres schema named after it (ids longer than 63 bytes get a prefix + hash). The server does not know whose graph it is — the caller derived the id and is trusted to have done so.
- **`origin`** names the writer. A write without one is refused (400); a read needs none.
- **`embedding`** — `{ baseUrl, apiKey?, model, dims, text?: 'label' | 'label+attrs' | { attrs: [...] }, kinds?, maxChars? }` — is per request, never per process: one server serves tenants with different models. Graphs are cached per (graphId, embedding fingerprint).
- Errors are `{ error: { name, message } }`: 400 `ValidationError`/`GuardError`, 403 `PermissionError`, 404 unknown op, 401 bad bearer token, 500 anything else. On start the process prints one line `{"listening":{host,port,driver,version}}` to stdout.

**MCP or HTTP?** The MCP server is for an *agent* holding one graph over stdio: the model sees the tools and calls them. The HTTP server is for a *platform* fronting many graphs: it derives `graphId`, decides `trusted`/`privileged`, holds the model credentials, and calls the same operations over the network. Both are thin over `tools.ts`.

## What it deliberately does not do

- No vector index in the core beyond what the engine gives (pgvector's exact `<=>` scan; brute force on SQLite). An HNSW index is a later, measured change.
- No PageRank, no strengthening, no decay. Ranking is cost and time only, so every result is explainable by its path. Access counts are recorded for a later, evaluated version.
- No entity extraction. You mint node ids; the framework does not read prose and guess.

## Changelog

- **0.2.0** — Storage is a driver: SQLite (default) or Postgres (`pg`, optional). **Every `Graph` method is now `async`** and `openGraph()` returns a Promise; each write is one transaction. Configurable embeddings (`embedding` option, `reembed()`, `recall({ locate })`, `match({ semantic })`, `openAiCompatibleEmbedder`). `agent-graph-server` HTTP sidecar. `dropGraph()`, `renderSql()`, `journalToSql(op, dialect)`.
- **0.1.0** — First release: SQLite, JS API, CLI, MCP server, journal/replay, dump/load.

## Safety

- Values that look like credentials (`sk-…`, `ghp_…`, `Bearer …`, AWS keys, …) are **rejected**, not stored — the write throws, in every persisted string (id, kind, label, rel, scope, origin, attrs), and the error names the field and the pattern class, never the value.
- Labels that read as instructions to a model ("ignore previous…", "you must…") are accepted but flagged, so a reader can tell.
- `provenance: 'observed'` is a **trusted** claim: only a handle opened `trusted: true` (or a binary started with `--trusted`) may write it. An agent's session writes `claimed`, so a model cannot launder its conclusion into evidence.
- A handle opened as one `origin` cannot supersede another origin's edges or re-label another origin's nodes; on someone else's node it may only **add** attrs whose keys are not there yet, and it never inherits their provenance. Open with `privileged: true` for maintenance.
- `as()` only narrows: read-only is inherited and cannot be cleared, `privileged` needs a privileged parent, `trusted` needs a trusted or privileged parent, and only a privileged handle may derive a handle for a different origin. A read-only handle never writes — not even access counts.

## License

MIT.
