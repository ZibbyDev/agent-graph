/**
 * The fleet example as an acceptance test: build the fixture, ask the four
 * manager questions both ways, and pin the answers.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildFlat } from '../examples/fleet/baseline.js';
import {
  ADA,
  BO,
  buildGraph,
  CLAIM_EDGE_1,
  CLAIM_EDGE_2,
  D,
  F_CART,
  F_CHECKOUT,
  F_ORDERS,
  F_PRICING,
  F_README,
  type Fixture,
  HOUR,
  NOTE_CLAIM_1,
  NOTE_CLAIM_2,
  NOW,
  R1,
  R2,
  R3,
  RUN_R1_CY,
  RUN_R2_BO,
  RUN_R2_CY,
  RUN_R3_BO,
  T,
} from '../examples/fleet/fixture.js';
import {
  claimsGraph,
  claimsSql,
  q1Graph,
  q1q4Many,
  q1Sql,
  q2Graph,
  q2Sql,
  q3Graph,
  q3Sql,
  q4Graph,
  q4Sql,
  qPlannedFor,
  ROUND2_EARLY,
} from '../examples/fleet/questions.js';

/** Strip the graph-only evidence so a graph answer can be compared with a flat one. */
function bare<T extends object>(x: T): unknown {
  return JSON.parse(JSON.stringify(x, (k, v) => (['path', 'provenance', 'edgeId', 'supersedes', 'supersededBy'].includes(k) ? undefined : v)));
}

describe('fleet example', () => {
  let fx: Fixture;
  let db: ReturnType<typeof buildFlat>;

  before(() => {
    fx = buildGraph();
    db = buildFlat(fx.facts);
  });
  after(() => {
    fx.graph.close();
    db.close();
  });

  it('builds the scenario: three rounds, one refused supersede', () => {
    const s = fx.graph.stats();
    assert.equal(s.kinds.member, 3);
    assert.equal(s.kinds.ticket, 5);
    assert.equal(s.kinds.file, 5);
    assert.equal(s.kinds.note, 2);
    assert.ok(s.kinds.run >= 8);
    assert.equal(s.edges - s.liveEdges, 1, 'exactly one superseded edge');
    assert.deepEqual(fx.denied.map((d) => [d.by, d.key, d.error.split(':')[0]]), [[RUN_R2_BO, CLAIM_EDGE_1, 'PermissionError']]);
    assert.ok(fx.edgeIds[CLAIM_EDGE_1] && fx.edgeIds[CLAIM_EDGE_2]);
  });

  it('Q1: files Ada touched, and the overlap with T’s plan', async () => {
    const g = await q1Graph(fx.graph, ADA);
    assert.deepEqual(g.touched.map((t) => t.file), [F_PRICING, F_README, F_ORDERS]);
    assert.deepEqual([...new Set(g.touched.map((t) => Math.floor((t.at - R1) / (24 * HOUR)) + 1))], [1, 2], 'rounds 1 and 2');
    assert.deepEqual(g.planned.map((p) => p.file).sort(), [F_CART, F_CHECKOUT, F_PRICING].sort());
    assert.deepEqual(g.overlap, [F_PRICING]);
    // Evidence: every touched file is reached member ← run → file, both hops observed.
    for (const t of g.touched) {
      assert.deepEqual(t.path!.map((h) => h.rel), ['performed_by', 'touched']);
      assert.deepEqual(t.path!.map((h) => h.provenance), ['observed', 'observed']);
      assert.equal(t.path![0].forward, false, 'performed_by is walked against its direction (member ← run)');
      assert.equal(t.path![1].forward, true);
    }
    assert.deepEqual(bare(g), bare(q1Sql(db, ADA)), 'flat SQL agrees on the bare answer');
  });

  it('Q2: two returns, in time order, with the expected reasons', async () => {
    const g = await q2Graph(fx.graph);
    assert.equal(g.returns.length, 2);
    assert.deepEqual(g.returns.map((r) => r.run), [RUN_R1_CY, RUN_R2_CY]);
    assert.ok(g.returns[0].at < g.returns[1].at);
    assert.ok(g.returns[0].at >= R1 && g.returns[0].at < R2);
    assert.ok(g.returns[1].at >= R2 && g.returns[1].at < R3);
    assert.match(g.returns[0].reason, /^blocked: ticket 100/);
    assert.match(g.returns[1].reason, /^tests failing: .*rounds half-up/);
    assert.deepEqual(g.returns.map((r) => r.provenance), ['observed', 'observed']);
    assert.deepEqual(bare(g), bare(q2Sql(db)));
  });

  it('Q3: D was worked last round by Bo, merged', async () => {
    const g = await q3Graph(fx.graph);
    assert.deepEqual(g.dependsOn, [D]);
    assert.deepEqual(g.lastRound.map((r) => [r.run, r.member, r.outcome, r.pr]), [[RUN_R2_BO, BO, 'merged', 'acme/shop#412']]);
    assert.deepEqual(g.lastRound[0].path!.map((h) => h.rel), ['worked_on']);
    assert.deepEqual(bare(g), bare(q3Sql(db)));
  });

  it('Q4: exactly the open run is editing a planned file right now', async () => {
    const g = await q4Graph(fx.graph);
    assert.deepEqual(g.planned.sort(), [F_CART, F_CHECKOUT, F_PRICING].sort());
    assert.equal(g.editing.length, 1, 'Cy’s closed edit of pricing.ts this round must not appear');
    const [e] = g.editing;
    assert.equal(e.run, RUN_R3_BO);
    assert.equal(e.file, F_PRICING);
    assert.equal(e.status, 'running');
    assert.equal(e.since, R3 + 1 * HOUR);
    assert.deepEqual(e.path!.map((h) => h.rel), ['worked_on', 'plans_to_touch', 'touched']);
    assert.deepEqual(bare(g), bare(q4Sql(db)));

    // Asked at a time when Bo had not yet opened the file, nobody is editing.
    const before = await q4Graph(fx.graph, T, R3 + 0.9 * HOUR);
    assert.deepEqual(before.editing.map((x) => x.run), ['run:r3-cy'], 'Cy’s edit window contains that instant');
    const none = await q4Graph(fx.graph, T, R3 + 0.1 * HOUR);
    assert.deepEqual(none.editing, []);
  });

  it('Q1 + Q4 in one recallMany call agree with the separate calls', async () => {
    const many = await q1q4Many(fx.graph, ADA);
    assert.equal(many.raw.results.length, 3);
    assert.deepEqual(many.q1, await q1Graph(fx.graph, ADA));
    assert.deepEqual(many.q4, await q4Graph(fx.graph));
    // Shared node map: every hit of every result is in it, once.
    const ids = new Set(many.raw.results.flatMap((r) => r.hits.map((h) => h.node.id)));
    assert.deepEqual(Object.keys(many.raw.nodes).sort(), [...ids].sort());
  });

  it('asOf: the round-2 view shows the superseded claim; the live view shows the correction', async () => {
    const early = await claimsGraph(fx.graph, ROUND2_EARLY);
    assert.deepEqual(early.notes.map((n) => n.note), [NOTE_CLAIM_1]);
    assert.equal(early.notes[0].edgeId, fx.edgeIds[CLAIM_EDGE_1]);
    assert.equal(early.notes[0].supersededBy, fx.edgeIds[CLAIM_EDGE_2], 'the record itself knows it was later retired');

    const live = await claimsGraph(fx.graph);
    assert.deepEqual(live.notes.map((n) => n.note), [NOTE_CLAIM_2]);
    assert.equal(live.notes[0].edgeId, fx.edgeIds[CLAIM_EDGE_2]);
    assert.equal(live.notes[0].supersedes, fx.edgeIds[CLAIM_EDGE_1]);

    // At the exact instant of the correction the graph shows the new claim, never both or neither.
    const atCorrection = await claimsGraph(fx.graph, R2 + 3 * HOUR);
    assert.deepEqual(atCorrection.notes.map((n) => n.note), [NOTE_CLAIM_2]);

    const chain = fx.graph.traceEdge(fx.edgeIds[CLAIM_EDGE_1]).chain;
    assert.deepEqual(chain.map((e) => e.id), [fx.edgeIds[CLAIM_EDGE_1], fx.edgeIds[CLAIM_EDGE_2]]);
    assert.equal(chain[0].supersededAt, R2 + 3 * HOUR);
    assert.equal(chain[1].supersededAt, null);
    assert.equal(chain[1].origin, RUN_R2_BO, 'the privileged handle recorded the correction in Bo’s name');

    assert.deepEqual(bare(early), bare(claimsSql(db, ROUND2_EARLY)));
    assert.deepEqual(bare(live), bare(claimsSql(db, NOW)));
  });

  it('subgraph: the area around T’s plan carries every live edge among its nodes', async () => {
    const sg = await fx.graph.subgraph({ ...qPlannedFor(T), kinds: undefined });
    const ids = new Set(sg.nodes.map((n) => n.id));
    assert.ok(ids.has(T));
    for (const f of [F_CART, F_CHECKOUT, F_PRICING]) assert.ok(ids.has(f), `${f} in subgraph`);
    for (const e of sg.edges) {
      assert.ok(ids.has(e.src) && ids.has(e.dst), 'edges are induced on the node set');
      assert.equal(e.supersededAt, null, 'only live edges');
    }
    assert.deepEqual([...new Set(sg.edges.map((e) => e.rel))].sort(), ['plans_to_touch', 'worked_on']);
  });
});
