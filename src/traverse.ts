import type { HandleContext, Store } from './graph.js';
import { rowToEdge, rowToNode, type Row } from './schema.js';
import type {
  EdgeRecord,
  MatchQuery,
  NodeId,
  NodeRecord,
  RecallHit,
  RecallManyResult,
  RecallQuery,
  RecallResult,
  Subgraph,
} from './types.js';

/**
 * Retrieval = seeds + a bounded, multi-source cheapest-path walk.
 *
 * The walk is Dijkstra over LIVE edges only. Every filter the caller can
 * express (time axes, scope, rel, provenance, direction) is pushed into the
 * SQL that expands a frontier node, so the traversal touches exactly the
 * edges that are allowed to carry it — a filtered-out edge is never loaded,
 * never relaxed, never in a path. That is what makes a result explainable:
 * each hit's `path` is a proof of why it was returned, under the filters given.
 */

const DEFAULT_MAX_COST = 2;
const DEFAULT_LIMIT = 50;

interface Settled {
  cost: number;
  seed: NodeId;
  /** Edge that reached this node (undefined for a seed) and the node before it. */
  via?: EdgeRecord;
  from?: NodeId;
}

// ---------------------------------------------------------------------------
// Seeds

async function resolveSeeds(
  ctx: HandleContext,
  q: RecallQuery,
): Promise<{ seeds: NodeId[]; seedSources: RecallResult['seedSources'] }> {
  const seen = new Set<NodeId>();
  const seedSources: RecallResult['seedSources'] = [];
  const add = (id: NodeId, via: 'seed' | 'match' | 'locate') => {
    if (seen.has(id)) return;
    seen.add(id);
    seedSources.push({ id, via });
  };

  // Unknown seed ids are skipped, not errors: a caller often passes ids it
  // merely suspects exist ("the file this ticket will touch"), and a batch of
  // questions should not fail because one guess was wrong. The audit trail
  // (`seedSources`) shows what actually resolved.
  for (const id of q.seeds ?? []) if (ctx.store.node(id)) add(id, 'seed');

  if (q.match) for (const n of matchNodes(ctx.store, q.match)) add(n.id, 'match');

  if (q.locate !== undefined) {
    if (!ctx.locator) throw new Error('recall: `locate` given but no locator is configured on this graph');
    const ids = await ctx.locator.locate(q.locate, { limit: q.limit ?? DEFAULT_LIMIT });
    for (const id of ids) if (ctx.store.node(id)) add(id, 'locate');
  }

  return { seeds: seedSources.map((s) => s.id), seedSources };
}

/**
 * Exact node lookup — the ONE implementation behind `Graph.match` and the
 * `match` clause of a recall, so the two can never disagree about what
 * "matches" means.
 */
export function matchNodes(store: Store, q: MatchQuery): NodeRecord[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (q.kind !== undefined) { where.push('kind = ?'); params.push(q.kind); }
  if (q.label !== undefined) { where.push('label = ?'); params.push(q.label); }
  if (q.labelContains !== undefined) {
    // instr() rather than LIKE so `%` and `_` in the needle stay literal.
    where.push('instr(lower(label), lower(?)) > 0');
    params.push(q.labelContains);
  }
  const limit = q.limit ?? 100;
  const attrKeys = q.attrs ? Object.keys(q.attrs) : [];
  let sql = `SELECT * FROM nodes${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
  // Attr equality is decided in JS on canonical JSON (key order must not
  // matter), so the SQL LIMIT is only safe when no attr filter follows it.
  if (attrKeys.length === 0) { sql += ' LIMIT ?'; params.push(limit); }
  const out: NodeRecord[] = [];
  for (const r of store.db.prepare(sql).iterate(...params)) {
    const node = rowToNode(r as Row);
    if (attrKeys.length && !attrKeys.every((k) => canonical(node.attrs[k]) === canonical(q.attrs![k]))) continue;
    out.push(node);
    if (out.length >= limit) break;
  }
  return out;
}

/** JSON with sorted object keys, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = o[k]; return acc; }, {});
    }
    return val;
  });
}

// ---------------------------------------------------------------------------
// Edge expansion: one prepared statement per query, bound per frontier node.

interface Expander {
  /** Live edges incident on `node` under every filter, direction applied. */
  edgesFrom(node: NodeId): EdgeRecord[];
  /** Live edges under every filter whose BOTH endpoints are in `ids`. */
  edgesWithin(ids: NodeId[]): EdgeRecord[];
}

function buildExpander(ctx: HandleContext, q: RecallQuery): Expander {
  const filters: string[] = [];
  const params: Array<string | number> = [];

  // Knowledge time: what the graph knew at `asOf`. Default is "now", i.e. the
  // live view. An edge counts if it had been recorded and not yet retired.
  const asOf = q.asOf ?? ctx.now();
  filters.push('recorded_at <= ?', '(superseded_at IS NULL OR superseded_at > ?)');
  params.push(asOf, asOf);

  // World time: was the fact true at `validAt`? Unbounded sides are NULL.
  if (q.validAt !== undefined) {
    filters.push('(valid_from IS NULL OR valid_from <= ?)', '(valid_to IS NULL OR valid_to > ?)');
    params.push(q.validAt, q.validAt);
  }

  if (q.recordedBetween) {
    const [a, b] = q.recordedBetween;
    if (a !== null && a !== undefined) { filters.push('recorded_at >= ?'); params.push(a); }
    if (b !== null && b !== undefined) { filters.push('recorded_at <= ?'); params.push(b); }
  }

  // A null-scope edge is global: it applies in every scope, so it always
  // passes. Scoped edges pass only when their scope was asked for.
  if (q.scope !== undefined) {
    const scopes = Array.isArray(q.scope) ? q.scope : [q.scope];
    filters.push(`(scope IS NULL OR scope IN (${placeholders(scopes.length)}))`);
    params.push(...scopes);
  }
  if (q.rels && q.rels.length) {
    filters.push(`rel IN (${placeholders(q.rels.length)})`);
    params.push(...q.rels);
  }
  if (q.provenance && q.provenance.length) {
    filters.push(`provenance IN (${placeholders(q.provenance.length)})`);
    params.push(...q.provenance);
  }

  // Direction is relative to the frontier node. Undirected edges are
  // traversable either way regardless of the requested direction.
  const direction = q.direction ?? 'both';
  const incident =
    direction === 'out'
      ? '((directed = 1 AND src = ?) OR (directed = 0 AND (src = ? OR dst = ?)))'
      : direction === 'in'
        ? '((directed = 1 AND dst = ?) OR (directed = 0 AND (src = ? OR dst = ?)))'
        : '(src = ? OR dst = ?)';
  const incidentArity = direction === 'both' ? 2 : 3;

  const common = filters.join(' AND ');
  // Ordering by recorded_at makes tie-breaking deterministic without a sort
  // in JS: among equal-cost relaxations the earlier-recorded edge wins.
  const perNode = ctx.store.db.prepare(
    `SELECT * FROM edges WHERE ${incident} AND ${common} ORDER BY recorded_at ASC, id ASC`,
  );

  return {
    edgesFrom(node) {
      const bind = incidentArity === 2 ? [node, node] : [node, node, node];
      return (perNode.all(...bind, ...params) as Row[]).map(rowToEdge);
    },
    edgesWithin(ids) {
      if (ids.length === 0) return [];
      const inSet = new Set(ids);
      const out: EdgeRecord[] = [];
      // Bind the src list in chunks (SQLite caps bound variables) and check
      // dst membership in JS, so cross-chunk edges are never missed.
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const rows = ctx.store.db
          .prepare(`SELECT * FROM edges WHERE src IN (${placeholders(slice.length)}) AND ${common} ORDER BY recorded_at ASC, id ASC`)
          .all(...slice, ...params) as Row[];
        for (const r of rows) if (inSet.has(r.dst as string)) out.push(rowToEdge(r));
      }
      return out;
    },
  };
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

// ---------------------------------------------------------------------------
// The walk

interface HeapEntry {
  cost: number;
  /** recorded_at of the edge that produced this entry; seeds use -Infinity so
   *  they always come out first. */
  tie: number;
  seq: number;
  node: NodeId;
}

/** Minimal binary heap ordered by (cost, tie, seq). */
class MinHeap {
  private a: HeapEntry[] = [];
  get size(): number { return this.a.length; }
  push(e: HeapEntry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop(): HeapEntry | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function less(x: HeapEntry, y: HeapEntry): boolean {
  return x.cost !== y.cost ? x.cost < y.cost : x.tie !== y.tie ? x.tie < y.tie : x.seq < y.seq;
}

/**
 * Multi-source Dijkstra. Returns the settled map (node → how it was reached).
 * Nodes beyond `maxCost` are never enqueued, so the frontier stays bounded by
 * the budget, not by the size of the graph — a hub with a thousand cheap
 * neighbours is only expanded if the budget actually reaches it.
 */
function walk(expander: Expander, seeds: NodeId[], maxCost: number): Map<NodeId, Settled> {
  const best = new Map<NodeId, Settled>();
  const done = new Set<NodeId>();
  const heap = new MinHeap();
  let seq = 0;

  for (const s of seeds) {
    best.set(s, { cost: 0, seed: s });
    heap.push({ cost: 0, tie: -Infinity, seq: seq++, node: s });
  }

  while (heap.size) {
    const cur = heap.pop()!;
    if (done.has(cur.node)) continue;
    const settled = best.get(cur.node)!;
    if (settled.cost !== cur.cost) continue; // stale entry
    done.add(cur.node);

    for (const e of expander.edgesFrom(cur.node)) {
      const next = e.src === cur.node ? e.dst : e.src;
      if (next === cur.node) continue; // self-loop: nothing to reach
      const cost = settled.cost + e.cost;
      if (cost > maxCost) continue;
      const prev = best.get(next);
      // Replace on strictly lower cost, or on equal cost via an earlier
      // assertion: two equally cheap explanations are resolved in favour of
      // the one the graph has known longer.
      if (!prev || cost < prev.cost || (cost === prev.cost && !done.has(next) && (prev.via?.recordedAt ?? -Infinity) > e.recordedAt)) {
        best.set(next, { cost, seed: settled.seed, via: e, from: cur.node });
        heap.push({ cost, tie: e.recordedAt, seq: seq++, node: next });
      }
    }
  }
  return best;
}

function pathTo(best: Map<NodeId, Settled>, node: NodeId): EdgeRecord[] {
  const path: EdgeRecord[] = [];
  let cur: NodeId | undefined = node;
  while (cur !== undefined) {
    const step: Settled = best.get(cur)!;
    if (!step.via) break;
    path.push(step.via);
    cur = step.from;
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// Public entry points

export async function recall(ctx: HandleContext, q: RecallQuery): Promise<RecallResult> {
  const { seeds, seedSources } = await resolveSeeds(ctx, q);
  const expander = buildExpander(ctx, q);
  const best = walk(expander, seeds, q.maxCost ?? DEFAULT_MAX_COST);

  const seedSet = new Set(seeds);
  const kinds = q.kinds ? new Set(q.kinds) : undefined;

  let hits: RecallHit[] = [];
  for (const [id, s] of best) {
    if (seedSet.has(id) && !q.includeSeeds) continue;
    const node = ctx.store.node(id);
    if (!node) continue; // cannot happen: link() requires both endpoints
    if (kinds && !kinds.has(node.kind)) continue;
    hits.push({ node, cost: s.cost, path: pathTo(best, id), seed: s.seed });
  }

  const order = q.order ?? 'cost';
  hits.sort((a, b) => {
    if (order === 'recent') return b.node.recordedAt - a.node.recordedAt || a.cost - b.cost || cmp(a.node.id, b.node.id);
    if (order === 'oldest') return a.node.recordedAt - b.node.recordedAt || a.cost - b.cost || cmp(a.node.id, b.node.id);
    // 'cost': closest first; among equals the one reached by the earlier
    // assertion, then id for a stable order across runs.
    return a.cost - b.cost || lastRecorded(a) - lastRecorded(b) || cmp(a.node.id, b.node.id);
  });

  const limit = q.limit ?? DEFAULT_LIMIT;
  const truncated = hits.length > limit;
  if (truncated) hits = hits.slice(0, limit);

  recordAccess(ctx, hits);

  return { query: q, seeds, hits, truncated, seedSources };
}

export async function recallMany(ctx: HandleContext, qs: RecallQuery[]): Promise<RecallManyResult> {
  const results: RecallResult[] = [];
  const nodes: Record<NodeId, NodeRecord> = {};
  for (const q of qs) {
    const r = await recall(ctx, q);
    results.push(r);
    for (const h of r.hits) nodes[h.node.id] = h.node;
  }
  return { results, nodes };
}

/**
 * The induced subgraph around a recall: the same walk, then EVERY live edge
 * (under the same filters) between any two reached nodes — including the
 * cross-edges a shortest-path tree leaves out. Seeds are always included,
 * because a picture of a neighbourhood without its centre is not a picture.
 * Access counts are not touched: this is an export, not a retrieval.
 */
export async function subgraph(ctx: HandleContext, q: RecallQuery): Promise<Subgraph> {
  const { seeds } = await resolveSeeds(ctx, q);
  const expander = buildExpander(ctx, q);
  const best = walk(expander, seeds, q.maxCost ?? DEFAULT_MAX_COST);
  const kinds = q.kinds ? new Set(q.kinds) : undefined;

  let nodes: Array<{ node: NodeRecord; cost: number }> = [];
  for (const [id, s] of best) {
    const node = ctx.store.node(id);
    if (!node) continue;
    if (kinds && !kinds.has(node.kind)) continue;
    nodes.push({ node, cost: s.cost });
  }
  const order = q.order ?? 'cost';
  nodes.sort((a, b) => {
    if (order === 'recent') return b.node.recordedAt - a.node.recordedAt || a.cost - b.cost || cmp(a.node.id, b.node.id);
    if (order === 'oldest') return a.node.recordedAt - b.node.recordedAt || a.cost - b.cost || cmp(a.node.id, b.node.id);
    return a.cost - b.cost || cmp(a.node.id, b.node.id);
  });

  // The limit applies to the node set; seeds are exempt so the cut never
  // removes the centre of the picture.
  const limit = q.limit ?? DEFAULT_LIMIT;
  const seedSet = new Set(seeds);
  const kept: NodeRecord[] = [];
  let reached = 0;
  let truncated = false;
  for (const { node } of nodes) {
    if (seedSet.has(node.id)) kept.push(node);
    else if (reached < limit) { kept.push(node); reached++; }
    else truncated = true;
  }

  const edges = expander.edgesWithin(kept.map((n) => n.id));
  return { seeds, nodes: kept, edges, truncated };
}

// ---------------------------------------------------------------------------

/** Bump `access` for every edge of every returned path, in one transaction.
 *  Recorded only — nothing reads it back for ranking (see README). */
function recordAccess(ctx: HandleContext, hits: RecallHit[]): void {
  const t = ctx.now();
  const ids: string[] = [];
  for (const h of hits) for (const e of h.path) ids.push(e.id);
  if (ids.length === 0) return;
  ctx.store.transaction(() => {
    for (const id of ids) ctx.store.bumpAccess.run(id, t);
  });
}

function lastRecorded(h: RecallHit): number {
  return h.path.length ? h.path[h.path.length - 1].recordedAt : -Infinity;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
