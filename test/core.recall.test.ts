import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { openGraph, type Graph, type Locator } from '../src/index.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => (t += ms), get t() { return t; } };
}

const ids = (r: { hits: Array<{ node: { id: string } }> }) => r.hits.map((h) => h.node.id).sort();

/**
 * The hub fixture from the README's motivating case.
 *
 *   project:p  -has_repo(10)->  repo:r  -contains(10)->  ticket:1 … ticket:20
 *   ticket:1  -touched(1)->  file:a  <-touched(1)-  ticket:7
 *   ticket:1  -touched(1)->  file:b  <-touched(1)-  ticket:7      (cross-edge for subgraph)
 *   ticket:7  -belongs_to(1)->  project:p                          (the cheap road in)
 *   ticket:1  -duplicate_of(5)->  ticket:7                         (never on a path at budget 3)
 */
function hub(g: Graph, c: ReturnType<typeof clock>) {
  const put = (id: string, kind: string) => g.put({ id, kind, label: id, provenance: 'observed' });
  put('project:p', 'project');
  put('repo:r', 'repo');
  for (let i = 1; i <= 20; i++) put(`ticket:${i}`, 'ticket');
  put('file:a', 'file');
  put('file:b', 'file');
  g.link({ src: 'project:p', dst: 'repo:r', rel: 'has_repo', cost: 10, provenance: 'observed' });
  for (let i = 1; i <= 20; i++) g.link({ src: 'repo:r', dst: `ticket:${i}`, rel: 'contains', cost: 10, provenance: 'observed' });
  // The file:a legs are recorded before the file:b legs so that the two
  // equal-cost routes ticket:1 → ticket:7 resolve deterministically (ties go
  // to the earlier assertion) and file:b's legs are provably off-path.
  c.tick();
  const t1a = g.link({ src: 'ticket:1', dst: 'file:a', rel: 'touched', cost: 1, provenance: 'observed' });
  const t7a = g.link({ src: 'ticket:7', dst: 'file:a', rel: 'touched', cost: 1, provenance: 'observed' });
  c.tick();
  const t1b = g.link({ src: 'ticket:1', dst: 'file:b', rel: 'touched', cost: 1, provenance: 'observed' });
  const t7b = g.link({ src: 'ticket:7', dst: 'file:b', rel: 'touched', cost: 1, provenance: 'observed' });
  const t7p = g.link({ src: 'ticket:7', dst: 'project:p', rel: 'belongs_to', cost: 1, provenance: 'claimed' });
  const dup = g.link({ src: 'ticket:1', dst: 'ticket:7', rel: 'duplicate_of', cost: 5, provenance: 'claimed' });
  return { t1a, t7a, t1b, t7b, t7p, dup };
}

function fixture() {
  const c = clock();
  const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
  const edges = hub(g, c);
  return { g, c, edges };
}

describe('recall — weighted walk', () => {
  test('a cost-10 hub does not pull the project in at budget 3, a cost-1 chain does', async () => {
    const { g } = fixture();
    const r = await g.recall({ seeds: ['ticket:1'], maxCost: 3, direction: 'both' });
    assert.deepEqual(ids(r), ['file:a', 'file:b', 'project:p', 'ticket:7']);
    const project = r.hits.find((h) => h.node.id === 'project:p')!;
    assert.equal(project.cost, 3);
    assert.deepEqual(project.path.map((e) => e.rel), ['touched', 'touched', 'belongs_to']);
    assert.equal(project.seed, 'ticket:1');
    assert.ok(!r.hits.some((h) => h.node.id === 'repo:r'), 'repo (cost 10) is out of budget');
    assert.ok(!r.hits.some((h) => h.node.id === 'ticket:2'), 'the other 19 tickets never enter');

    // Without the cheap chain, the project is unreachable at this budget even
    // though it is two hops away through the hub.
    const cheap = g.recall({ seeds: ['ticket:1'], maxCost: 3, rels: ['touched', 'contains', 'has_repo'] });
    assert.deepEqual(ids(await cheap), ['file:a', 'file:b', 'ticket:7']);
  });

  test('hits are ordered by cost, path is seed → node, seeds are excluded by default', async () => {
    const { g } = fixture();
    const r = await g.recall({ seeds: ['ticket:1'], maxCost: 3 });
    assert.deepEqual(r.hits.map((h) => h.cost), [1, 1, 2, 3]);
    const t7 = r.hits.find((h) => h.node.id === 'ticket:7')!;
    assert.equal(t7.path[0].src, 'ticket:1');
    assert.equal(t7.path[1].src, 'ticket:7', 'undirected traversal of a directed edge is allowed in both mode');
    assert.equal(r.seeds.length, 1);
    assert.deepEqual(r.seedSources, [{ id: 'ticket:1', via: 'seed' }]);
    assert.ok(!r.hits.some((h) => h.node.id === 'ticket:1'));
  });

  test('includeSeeds puts the seed first with an empty path', async () => {
    const { g } = fixture();
    const r = await g.recall({ seeds: ['ticket:1'], maxCost: 1, includeSeeds: true });
    assert.equal(r.hits[0].node.id, 'ticket:1');
    assert.equal(r.hits[0].cost, 0);
    assert.deepEqual(r.hits[0].path, []);
    assert.equal(r.hits[0].seed, 'ticket:1');
  });

  test('multi-seed: each hit reports the seed it was reached from; unknown seeds are skipped', async () => {
    const { g } = fixture();
    const r = await g.recall({ seeds: ['ticket:1', 'ticket:9', 'ghost:0'], maxCost: 1 });
    assert.deepEqual(r.seeds, ['ticket:1', 'ticket:9']);
    assert.deepEqual(ids(r), ['file:a', 'file:b']);
    for (const h of r.hits) assert.equal(h.seed, 'ticket:1');
    // ticket:9 only reaches repo:r at cost 10 — nothing within budget 1.
    const r9 = await g.recall({ seeds: ['ticket:9'], maxCost: 10 });
    assert.deepEqual(ids(r9), ['repo:r']);
    assert.equal(r9.hits[0].seed, 'ticket:9');
  });

  test('direction out / in / both', async () => {
    const { g } = fixture();
    const out = await g.recall({ seeds: ['ticket:1'], maxCost: 3, direction: 'out' });
    assert.deepEqual(ids(out), ['file:a', 'file:b'], 'out: cannot walk back up a touched edge');
    const inn = await g.recall({ seeds: ['file:a'], maxCost: 3, direction: 'in' });
    assert.deepEqual(ids(inn), ['ticket:1', 'ticket:7'], 'in: only the tickets that touched it');
    const both = await g.recall({ seeds: ['file:a'], maxCost: 2, direction: 'both' });
    assert.deepEqual(ids(both), ['file:b', 'project:p', 'ticket:1', 'ticket:7']);
  });

  test('undirected edges traverse either way at the same cost, in any direction mode', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    for (const id of ['a', 'b', 'c']) g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    g.link({ src: 'a', dst: 'b', rel: 'peer', directed: false, cost: 1, provenance: 'observed' });
    g.link({ src: 'c', dst: 'b', rel: 'points', directed: true, cost: 1, provenance: 'observed' });
    assert.deepEqual(ids(await g.recall({ seeds: ['b'], maxCost: 1, direction: 'out' })), ['a']);
    assert.deepEqual(ids(await g.recall({ seeds: ['b'], maxCost: 1, direction: 'in' })), ['a', 'c']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], maxCost: 1, direction: 'in' })), ['b']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], maxCost: 2, direction: 'out' })), ['b'], 'c is upstream of b, unreachable going out');
  });

  test('ties: equal cost resolves to the earlier-recorded edge into the node', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    for (const id of ['s', 'x', 'y', 't']) g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    // Two equal-cost routes s→x→t and s→y→t. The x branch is discovered
    // first (older first hop) but its final leg is the newer assertion, so
    // the y branch must win: the tie-break is on the edge that reaches `t`.
    g.link({ src: 's', dst: 'x', rel: 'r', provenance: 'observed' });
    c.tick();
    g.link({ src: 's', dst: 'y', rel: 'r', provenance: 'observed' });
    c.tick();
    const yt = g.link({ src: 'y', dst: 't', rel: 'r', provenance: 'observed' });
    c.tick();
    g.link({ src: 'x', dst: 't', rel: 'r', provenance: 'observed' });
    const r = await g.recall({ seeds: ['s'], maxCost: 2 });
    const t = r.hits.find((h) => h.node.id === 't')!;
    assert.deepEqual(t.path.map((e) => e.src), ['s', 'y']);
    assert.equal(t.path[1].id, yt.id);
  });
});

describe('recall — time axes', () => {
  test('asOf shows the historical view before a supersede', async () => {
    const { g, c, edges } = fixture();
    const before = c.t;
    c.tick();
    g.supersede(edges.t7p.id, { src: 'ticket:7', dst: 'repo:r', rel: 'belongs_to', cost: 1, provenance: 'claimed' });
    const live = await g.recall({ seeds: ['ticket:7'], maxCost: 1, rels: ['belongs_to'] });
    assert.deepEqual(ids(live), ['repo:r'], 'live view sees the replacement only');
    const past = await g.recall({ seeds: ['ticket:7'], maxCost: 1, rels: ['belongs_to'], asOf: before });
    assert.deepEqual(ids(past), ['project:p'], 'asOf sees what was known then');
    const atSwitch = await g.recall({ seeds: ['ticket:7'], maxCost: 1, rels: ['belongs_to'], asOf: c.t });
    assert.deepEqual(ids(atSwitch), ['repo:r'], 'at the supersede instant exactly one assertion is visible');
    const prehistory = await g.recall({ seeds: ['ticket:7'], maxCost: 1, asOf: before - 100_000 });
    assert.deepEqual(ids(prehistory), [], 'before anything was recorded');
  });

  test('validAt excludes an edge whose validTo has passed and one whose validFrom is ahead', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    for (const id of ['a', 'b', 'd']) g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    g.link({ src: 'a', dst: 'b', rel: 'on_call', validFrom: 100, validTo: 200, provenance: 'observed' });
    g.link({ src: 'a', dst: 'd', rel: 'on_call', validFrom: 200, validTo: null, provenance: 'observed' });
    assert.deepEqual(ids(await g.recall({ seeds: ['a'] })), ['b', 'd'], 'no validAt: world time ignored');
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], validAt: 150 })), ['b']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], validAt: 200 })), ['d'], 'validTo is exclusive, validFrom inclusive');
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], validAt: 50 })), []);
  });

  test('recordedBetween window with null bounds', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    for (const id of ['a', 'b', 'd', 'e']) g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    const t0 = c.t;
    g.link({ src: 'a', dst: 'b', rel: 'r', provenance: 'observed' });
    c.tick();
    const t1 = c.t;
    g.link({ src: 'a', dst: 'd', rel: 'r', provenance: 'observed' });
    c.tick();
    const t2 = c.t;
    g.link({ src: 'a', dst: 'e', rel: 'r', provenance: 'observed' });
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], recordedBetween: [t1, t1] })), ['d']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], recordedBetween: [t1, null] })), ['d', 'e']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], recordedBetween: [null, t1] })), ['b', 'd']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], recordedBetween: [t0, t2] })), ['b', 'd', 'e']);
  });
});

describe('recall — filters', () => {
  test('scope: null-scope edges are global, scoped edges need to be asked for', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    for (const id of ['a', 'g', 'm', 'f']) g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    g.link({ src: 'a', dst: 'g', rel: 'r', provenance: 'observed' });
    g.link({ src: 'a', dst: 'm', rel: 'r', scope: 'main', provenance: 'observed' });
    g.link({ src: 'a', dst: 'f', rel: 'r', scope: 'feature/x', provenance: 'observed' });
    assert.deepEqual(ids(await g.recall({ seeds: ['a'] })), ['f', 'g', 'm'], 'no scope filter: everything');
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], scope: 'main' })), ['g', 'm']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], scope: ['main', 'feature/x'] })), ['f', 'g', 'm']);
    assert.deepEqual(ids(await g.recall({ seeds: ['a'], scope: 'release' })), ['g'], 'only the global edge');
  });

  test('rels restrict traversal; kinds restrict output only', async () => {
    const { g } = fixture();
    const rels = await g.recall({ seeds: ['ticket:1'], maxCost: 3, rels: ['touched'] });
    assert.deepEqual(ids(rels), ['file:a', 'file:b', 'ticket:7'], 'belongs_to is not walked');
    const kinds = await g.recall({ seeds: ['ticket:1'], maxCost: 3, kinds: ['project'] });
    assert.deepEqual(ids(kinds), ['project:p'], 'traversal passed through files and a ticket to get here');
    assert.equal(kinds.hits[0].path.length, 3);
  });

  test('provenance filter', async () => {
    const { g } = fixture();
    const observed = await g.recall({ seeds: ['ticket:1'], maxCost: 3, provenance: ['observed'] });
    assert.deepEqual(ids(observed), ['file:a', 'file:b', 'ticket:7'], 'the claimed belongs_to edge is not walked');
    const claimed = await g.recall({ seeds: ['ticket:1'], maxCost: 5, provenance: ['claimed'] });
    assert.deepEqual(ids(claimed), ['ticket:7'], 'only the claimed duplicate_of edge (cost 5)');
    assert.deepEqual(claimed.hits[0].path.map((e) => e.rel), ['duplicate_of']);
  });

  test('limit and truncated', async () => {
    const { g } = fixture();
    const r = await g.recall({ seeds: ['repo:r'], maxCost: 10, direction: 'out', limit: 5 });
    assert.equal(r.hits.length, 5);
    assert.equal(r.truncated, true);
    const all = await g.recall({ seeds: ['repo:r'], maxCost: 10, direction: 'out' });
    assert.equal(all.hits.length, 20);
    assert.equal(all.truncated, false);
  });

  test('order recent / oldest by node recordedAt', async () => {
    const c = clock();
    const g = openGraph(':memory:', { origin: 'run:a', now: c.now });
    g.put({ id: 's', kind: 'k', label: 's', provenance: 'observed' });
    for (const id of ['old', 'mid', 'new']) {
      c.tick();
      g.put({ id, kind: 'k', label: id, provenance: 'observed' });
    }
    // Link in reverse so cost/insertion order cannot masquerade as time order.
    for (const id of ['new', 'mid', 'old']) g.link({ src: 's', dst: id, rel: 'r', provenance: 'observed' });
    const recent = await g.recall({ seeds: ['s'], order: 'recent' });
    assert.deepEqual(recent.hits.map((h) => h.node.id), ['new', 'mid', 'old']);
    const oldest = await g.recall({ seeds: ['s'], order: 'oldest' });
    assert.deepEqual(oldest.hits.map((h) => h.node.id), ['old', 'mid', 'new']);
  });

  test('match and locate as entry points; locate without a locator throws', async () => {
    const { g } = fixture();
    const byMatch = await g.recall({ match: { kind: 'file', labelContains: 'FILE:A' }, maxCost: 1 });
    assert.deepEqual(byMatch.seeds, ['file:a']);
    assert.deepEqual(byMatch.seedSources, [{ id: 'file:a', via: 'match' }]);
    assert.deepEqual(ids(byMatch), ['ticket:1', 'ticket:7']);

    await assert.rejects(g.recall({ locate: 'marketplace' }), /no locator/);

    const locator: Locator = { async locate() { return ['ticket:7', 'ghost:1', 'file:a']; } };
    const l = g.as('run:l', { locator });
    const r = await l.recall({ seeds: ['file:a'], locate: 'anything', maxCost: 1 });
    assert.deepEqual(r.seedSources, [
      { id: 'file:a', via: 'seed' },
      { id: 'ticket:7', via: 'locate' },
    ], 'union, deduplicated, first source wins, unknown ids dropped');
  });
});

describe('recallMany', () => {
  test('results stay grouped; nodes is one deduplicated map', async () => {
    const { g } = fixture();
    const r = await g.recallMany([
      { seeds: ['ticket:1'], maxCost: 1 },
      { seeds: ['ticket:7'], maxCost: 1, includeSeeds: true },
      { match: { kind: 'nothing-like-this' } },
    ]);
    assert.equal(r.results.length, 3);
    assert.deepEqual(ids(r.results[0]), ['file:a', 'file:b']);
    assert.deepEqual(ids(r.results[1]), ['file:a', 'file:b', 'project:p', 'ticket:7']);
    assert.deepEqual(r.results[2].hits, []);
    assert.deepEqual(Object.keys(r.nodes).sort(), ['file:a', 'file:b', 'project:p', 'ticket:7']);
    assert.equal(r.nodes['ticket:7'].kind, 'ticket');
  });
});

describe('subgraph', () => {
  test('returns the induced subgraph: cross-edges between reached nodes that no recall path contains', async () => {
    const { g, edges } = fixture();
    const recall = await g.recall({ seeds: ['ticket:1'], maxCost: 3 });
    const pathEdgeIds = new Set(recall.hits.flatMap((h) => h.path.map((e) => e.id)));
    assert.ok(!pathEdgeIds.has(edges.t7b.id), 'ticket:7→file:b is not on any cheapest path');
    assert.ok(!pathEdgeIds.has(edges.dup.id), 'the cost-5 duplicate_of edge is never walked');

    const sg = await g.subgraph({ seeds: ['ticket:1'], maxCost: 3 });
    assert.deepEqual(sg.seeds, ['ticket:1']);
    assert.deepEqual(sg.nodes.map((n) => n.id).sort(), ['file:a', 'file:b', 'project:p', 'ticket:1', 'ticket:7'], 'seed always included');
    const edgeIds = new Set(sg.edges.map((e) => e.id));
    assert.ok(edgeIds.has(edges.t7b.id), 'cross-edge ticket:7→file:b included');
    assert.ok(edgeIds.has(edges.dup.id), 'cross-edge ticket:1→ticket:7 included even though it costs more than the budget');
    assert.equal(sg.edges.length, 6, 'every live edge among the five nodes; nothing touching repo:r');
    assert.ok(sg.edges.every((e) => e.src !== 'repo:r' && e.dst !== 'repo:r'));
    assert.equal(sg.truncated, false);
  });

  test('honours the same filters as recall and does not bump access', async () => {
    const { g, c, edges } = fixture();
    const sg = await g.subgraph({ seeds: ['ticket:1'], maxCost: 3, provenance: ['observed'] });
    assert.deepEqual(sg.nodes.map((n) => n.id).sort(), ['file:a', 'file:b', 'ticket:1', 'ticket:7']);
    assert.ok(sg.edges.every((e) => e.provenance === 'observed'), 'induced edges obey the provenance filter too');
    assert.equal(sg.edges.length, 4);

    c.tick();
    g.supersede(edges.t7b.id);
    const after = await g.subgraph({ seeds: ['ticket:1'], maxCost: 3 });
    assert.ok(!after.edges.some((e) => e.id === edges.t7b.id), 'superseded edges are not live');
    const past = await g.subgraph({ seeds: ['ticket:1'], maxCost: 3, asOf: c.t - 1 });
    assert.ok(past.edges.some((e) => e.id === edges.t7b.id), 'asOf restores it');

    const limited = await g.subgraph({ seeds: ['repo:r'], maxCost: 10, direction: 'out', limit: 3 });
    assert.equal(limited.nodes.length, 4, 'limit counts non-seed nodes; the seed is exempt');
    assert.equal(limited.truncated, true);
  });
});

describe('access counts', () => {
  test('every edge in every returned recall path is counted; subgraph never counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-graph-'));
    const path = join(dir, 'g.sqlite');
    try {
      const c = clock();
      const g = openGraph(path, { origin: 'run:a', now: c.now });
      const edges = hub(g, c);
      await g.subgraph({ seeds: ['ticket:1'], maxCost: 3 });
      await g.recall({ seeds: ['ticket:1'], maxCost: 2 });
      // Paths: t1a, t1b, t1a+t7a → t1a twice, t1b once, t7a once.
      g.close();

      const db = new DatabaseSync(path);
      const rows = db.prepare('SELECT edge_id, count, last_at FROM access ORDER BY edge_id').all() as Array<{ edge_id: string; count: number; last_at: number }>;
      db.close();
      const byId = Object.fromEntries(rows.map((r) => [r.edge_id, r.count]));
      assert.deepEqual(byId, { [edges.t1a.id]: 2, [edges.t1b.id]: 1, [edges.t7a.id]: 1 });
      assert.ok(rows.every((r) => r.last_at === c.t));

      const g2 = openGraph(path, { readOnly: true, now: c.now });
      assert.ok(g2.stats().bytes > 0, 'file-backed database reports its size');
      assert.equal(g2.stats().edges, 27);
      g2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
