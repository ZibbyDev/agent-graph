# agent-graph

A growable, time-aware memory graph for AI agents. **One SQLite file, zero runtime dependencies.** Use it from JavaScript, from the command line, or plug it into any MCP-capable agent (Claude Code, Codex, …).

## The problem it solves

When several agents work in parallel, each one produces knowledge — what it touched, what it concluded, what blocked it. Without a shared structure, the next round can't find *the part that is relevant to this task*, and a manager can only see results (tickets, PRs), never the process: which files someone touched across the last three rounds, where a twice-returned task got stuck, whether someone is editing the same files right now.

Most agent-memory systems answer this with a flat list of "facts" ranked by recency, or with a vector index that can only return what you already knew to ask about. Neither holds **relations**, and neither lets the agent say *which slice of time* it wants.

`agent-graph` is the missing layer:

- **Untyped nodes and edges.** A ticket, a run, a file, a person, a conclusion — each is a node with a free-string `kind`. Any node can link to any node with a free-string `rel`. No fixed hierarchy, no fixed depth.
- **Edges are assertions, not facts.** Each edge has its own id, an `origin` (who asserted it), a `provenance` (`observed` by a runtime vs `claimed` by an agent), an optional `scope` (branch, version, environment), and two time axes. The same relation can be asserted twice, retired, and re-asserted. Nothing is ever deleted — `supersede()` stamps the old edge and records the replacement.
- **Two time axes, both yours to pick.** `validAt` asks "what was true at this instant"; `asOf` asks "what did the graph *know* at this instant". They are independent parameters, not something inferred from prose.
- **Retrieval by weighted distance.** Give it entry points and a cost budget; it walks the graph and returns every node within reach, with the exact path it took. Edge costs are yours: "touched the same file" might cost 1, "same repository" might cost 10, so a hub node can't drag the whole project in.
- **Batch queries.** One call, many questions, one database load.

## Install

```sh
npm install agent-graph
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

## JavaScript

```js
import { openGraph } from 'agent-graph';

const g = openGraph('./memory.sqlite', { origin: 'run:7f3a' });

// Every endpoint must exist before it can be linked — ids are yours to mint.
g.put({ id: 'run:7f3a', kind: 'run', label: 'developer on ticket 292', provenance: 'observed' });
g.put({ id: 'ticket:292', kind: 'ticket', label: 'Remove stale release note', provenance: 'observed' });
g.put({ id: 'file:repo/src/marketplace.js', kind: 'file', label: 'src/marketplace.js', provenance: 'observed' });
g.link({ src: 'run:7f3a', dst: 'file:repo/src/marketplace.js', rel: 'touched', cost: 1, provenance: 'observed' });
g.link({ src: 'run:7f3a', dst: 'ticket:292', rel: 'worked_on', provenance: 'observed' });

// An agent's own conclusion — claimed, scoped to a branch:
g.link({
  src: 'run:7f3a', dst: 'file:repo/src/marketplace.js', rel: 'notes',
  scope: 'main', provenance: 'claimed',
  attrs: { text: 'Two releaseNotes declarations; the later one wins at runtime.' },
});

// Who else touched the files this ticket plans to touch?
const r = await g.recall({ seeds: ['ticket:292'], maxCost: 2, rels: ['worked_on', 'touched'] });
for (const hit of r.hits) console.log(hit.node.id, hit.cost, hit.path.map(e => e.rel));

// What did we know a week ago?
await g.recall({ seeds: ['file:repo/src/marketplace.js'], asOf: Date.now() - 7 * 864e5 });

// Several questions, one load:
await g.recallMany([
  { seeds: ['ticket:292'], maxCost: 2 },
  { match: { kind: 'file', labelContains: 'marketplace' }, maxCost: 1, order: 'recent' },
]);
```

## Command line

```sh
agent-graph --db memory.sqlite --origin run:7f3a put  '{"id":"ticket:292","kind":"ticket","label":"…","provenance":"observed"}'
agent-graph --db memory.sqlite --origin run:7f3a link '{"src":"run:7f3a","dst":"ticket:292","rel":"worked_on","provenance":"observed"}'
agent-graph --db memory.sqlite recall   '{"seeds":["ticket:292"],"maxCost":2}'
agent-graph --db memory.sqlite trace    ticket:292
agent-graph --db memory.sqlite subgraph '{"seeds":["ticket:292"],"maxCost":2}'
agent-graph --db memory.sqlite stats
echo '{"queries":[{"seeds":["ticket:292"]},{"match":{"kind":"file"}}]}' | agent-graph --db memory.sqlite recall-many
```

```
agent-graph --db <path> [--origin <o>] [--privileged] [--read-only] <command> [json]
```

Commands: `put`, `link`, `supersede`, `match`, `get`, `recall`, `recall-many`, `subgraph`, `trace`, `trace-edge`, `stats` — the same operations as the MCP tools below. Each takes one JSON object (`get`, `trace` and `trace-edge` also accept a bare id); when the argument is omitted and stdin is not a terminal, the JSON is read from stdin. Results are pretty-printed JSON on stdout; a failure is `{"error":{"name","message"}}` on stderr with exit status 1, so a shell-driven agent can tell a `GuardError` from a `PermissionError` from a typo. `--origin` stamps every write; `--read-only` refuses the write commands.

## MCP (Claude Code, Codex, anything that speaks MCP)

The package ships an MCP server over stdio.

**Claude Code** — `.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "agent-graph-mcp", "--db", "./memory.sqlite", "--origin", "claude"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "agent-graph-mcp", "--db", "./memory.sqlite", "--origin", "codex"]
```

Tools exposed: `graph_put`, `graph_link`, `graph_supersede` (writes) and `graph_match`, `graph_get`, `graph_recall`, `graph_recall_many`, `graph_subgraph`, `graph_trace`, `graph_trace_edge`, `graph_stats` (reads). Pass `--read-only` to expose only the read tools. Every write is stamped with `--origin`; the tool descriptions explain the two time axes (`validAt`, `asOf`, `recordedBetween`) so a model can pick the slice it needs. The server is hand-rolled newline-delimited JSON-RPC over stdio (no SDK dependency), speaks protocol versions 2024-11-05 through 2025-06-18, and returns tool failures — guard rejections included — as `isError` results the model can read and recover from.

## The model, in one paragraph

A **node** is `{ id, kind, label, attrs }`; `put()` on an existing id appends a version, so history is kept. An **edge** is `{ src, dst, rel, cost, directed, scope, attrs, origin, provenance, validFrom, validTo, recordedAt, supersededAt, supersedes }`. `recall()` resolves entry points (by id, by exact match, or through an optional `Locator` you supply for semantic search), then runs a bounded cheapest-path walk, filtering edges by time, scope, relation and provenance, and returns each reachable node with its cost and path. `trace()` gives a node's versions and every edge ever attached to it; `traceEdge()` follows a supersession chain.

### Visualisation

`subgraph(query)` is the renderer's input: the nodes a `recall()` with the same query would reach, plus **every** live edge among them, not only the cheapest paths — "pick an area to view". Slice it with `recordedBetween` to animate how an area grew round by round; `asOf` replays what was believed at a point in time. Ids, kinds and rels are stable strings, so colour and shape can key on them. No renderer ships in v1; the CLI (`subgraph`) and the MCP tool (`graph_subgraph`) both export it as JSON.

## Example: four questions a fleet manager asks

`npm run example` builds a small fleet in memory — three members, three rounds of runs, tickets, files, one twice-returned ticket, one corrected claim, one run still editing — and answers, side by side with hand-written SQL over a flat `events` table built from the same facts:

1. Which files did member X touch across the last three rounds, and do they overlap the files ticket T plans to touch?
2. T was returned twice — where did it get stuck each time, by which run, when?
3. T depends on D — who worked on D last round, and what was the outcome?
4. Is anyone editing, right now, the files T plans to touch? (`validAt: now` — closed edit windows fall out of the walk.)

Both give the same answer; the graph one also carries the path walked, each hop's provenance and origin, and, for the corrected claim, the round-2 view (`asOf`) next to the live one. Source: `examples/fleet/`.

## What it deliberately does not do (v1)

- No semantic search in the core. Supply a `Locator` if you want free-text entry; the framework only needs it to return node ids.
- No PageRank, no strengthening, no decay. Ranking is cost and time only, so every result is explainable by its path. Access counts are recorded for a later, evaluated version.
- No entity extraction. You mint node ids; the framework does not read prose and guess.

## Safety

- Values that look like credentials (`sk-…`, `ghp_…`, `Bearer …`, AWS keys, …) are **rejected**, not stored — the write throws.
- Labels that read as instructions to a model ("ignore previous…", "you must…") are accepted but flagged, so a reader can tell.
- A handle opened as one `origin` cannot supersede another origin's edges or re-label another origin's nodes. Open with `privileged: true` for maintenance.

## License

MIT.
