import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openGraph } from '../src/index.js';
import { findTool } from '../src/tools.js';

/**
 * The summary projection exists because an agent pays per token: a recall
 * should hand back what is needed to DECIDE what to look at (id, kind, label,
 * time, provenance, the path's relation names) and nothing else. Payloads are
 * fetched by id afterwards.
 */
async function fixture() {
  const g = await openGraph(':memory:', { origin: 'runtime', privileged: true, now: () => 1_000 });
  await g.put({ id: 'ticket:1', kind: 'ticket', label: 'T1', attrs: { body: 'x'.repeat(5_000) }, provenance: 'observed' });
  await g.put({ id: 'run:a', kind: 'run', label: 'run a', attrs: { log: 'y'.repeat(5_000) }, provenance: 'observed' });
  await g.link({ src: 'run:a', dst: 'ticket:1', rel: 'worked_on', attrs: { outcome: 'merged', notes: 'z'.repeat(5_000) }, provenance: 'observed' });
  return g;
}

describe('projection', () => {
  test("recall project:'summary' drops attrs and edge payloads, keeps what identifies", async () => {
    const g = await fixture();
    const r = await g.recall({ seeds: ['ticket:1'], project: 'summary' });
    assert.equal(r.hits.length, 1);
    const hit = r.hits[0];
    assert.deepEqual(Object.keys(hit.node).sort(), ['id', 'kind', 'label', 'provenance', 'recordedAt', 'version']);
    assert.equal(hit.node.label, 'run a');
    assert.deepEqual(Object.keys(hit.path[0]).sort(), ['cost', 'dst', 'id', 'provenance', 'recordedAt', 'rel', 'src']);
    assert.equal(hit.path[0].rel, 'worked_on');
    assert.ok(JSON.stringify(r).length < 1_000, 'a summary result is small');
    // The default is still the full record for the JS API.
    const full = await g.recall({ seeds: ['ticket:1'] });
    assert.equal((full.hits[0].node.attrs.log as string).length, 5_000);
    await g.close();
  });

  test('recallMany and subgraph honour the projection', async () => {
    const g = await fixture();
    const many = await g.recallMany([{ seeds: ['ticket:1'], project: 'summary' }]);
    assert.equal('attrs' in many.nodes['run:a'], false);
    assert.equal(many.results[0].hits[0].nodeId, 'run:a');
    const sg = await g.subgraph({ seeds: ['ticket:1'], project: 'summary' });
    assert.ok(sg.nodes.every((n) => !('attrs' in n)));
    assert.ok(sg.edges.every((e) => !('attrs' in e)));
    await g.close();
  });

  test('the tool surface defaults to summary and can ask for full', async () => {
    const g = await fixture();
    const recall = findTool('graph_recall')!;
    const byDefault = (await recall.run(g, { seeds: ['ticket:1'] })) as { hits: Array<{ node: Record<string, unknown> }> };
    assert.equal('attrs' in byDefault.hits[0].node, false);
    const full = (await recall.run(g, { seeds: ['ticket:1'], project: 'full' })) as { hits: Array<{ node: Record<string, unknown> }> };
    assert.equal('attrs' in full.hits[0].node, true);
    await g.close();
  });
});
