/**
 * Embeddings, against a deterministic fake model: a bag-of-words hash into a
 * small vector, so "pricing rounding rule" and "rounding in pricing" land
 * close and "checkout coupon" lands far. No network, no real model — the
 * property under test is the plumbing (what gets embedded, when, and how a
 * query finds it), not embedding quality.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EmbeddingConfig, Graph } from '../../src/index.js';
import { vectorIndex } from '../../src/embedding.js';
import { clock, type Harness } from './harness.js';

export const DIMS = 16;

/** Word hashing → fixed-dim vector, normalised. Deterministic. */
export function fakeVector(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let hsh = 2166136261;
    for (const ch of word) hsh = Math.imul(hsh ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[hsh % dims] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** The fake `embed`, recording every call so a test can count them. */
export function fakeEmbedder(): EmbeddingConfig & { calls: string[][]; fail: boolean } {
  const self = {
    calls: [] as string[][],
    fail: false,
    dims: DIMS,
    async embed(texts: string[]) {
      self.calls.push(texts);
      if (self.fail) throw new Error('model is down');
      return texts.map((t) => fakeVector(t));
    },
  };
  return self;
}

/** A private view on the vector table via a handle's context. */
async function vectors(g: Graph) {
  // The handle exposes no vector API by design; the test reaches the same
  // helper the implementation uses through a minimal context.
  const ctx = (g as unknown as { ctx(): Parameters<typeof vectorIndex>[0] }).ctx();
  return vectorIndex(ctx);
}

export function embeddingSuite(h: Harness): void {
  describe('embeddings — what gets embedded is configured', () => {
    test('default rule: every kind, label only, computed on put; a re-put replaces the vector', async () => {
      const c = clock();
      const emb = fakeEmbedder();
      const g = await h.open({ origin: 'rt', trusted: true, now: c.now, embedding: emb });
      await g.put({ id: 'n:1', kind: 'note', label: 'pricing rounding rule', attrs: { text: 'ignored by the default rule' } });
      await g.put({ id: 'f:1', kind: 'file', label: 'src/pricing.ts' });
      assert.deepEqual(emb.calls, [['pricing rounding rule'], ['src/pricing.ts']], 'label only, one call per put');
      assert.deepEqual(await vectors(g), [{ id: 'f:1', version: 1, dims: DIMS }, { id: 'n:1', version: 1, dims: DIMS }]);
      await g.put({ id: 'n:1', kind: 'note', label: 'pricing rounding rule (half-up)' });
      assert.deepEqual((await vectors(g)).find((v) => v.id === 'n:1'), { id: 'n:1', version: 2, dims: DIMS }, 'one vector per node, of the latest version');
    });

    test('kinds whitelist and a text rule decide what is embedded; null skips; maxChars truncates', async () => {
      const emb = fakeEmbedder();
      const g = await h.open({
        origin: 'rt', trusted: true,
        embedding: {
          ...emb,
          kinds: ['note', 'ticket'],
          maxChars: 12,
          text: (n) => (n.attrs.skip ? null : `${n.label} ${String(n.attrs.text ?? '')}`),
        },
      });
      await g.put({ id: 'f:1', kind: 'file', label: 'src/pricing.ts' });
      await g.put({ id: 'n:1', kind: 'note', label: 'rounding', attrs: { text: 'half-up on the final amount' } });
      await g.put({ id: 'n:2', kind: 'note', label: 'private', attrs: { skip: true } });
      await g.put({ id: 't:1', kind: 'ticket', label: 'Apply coupon' });
      assert.deepEqual(emb.calls, [['rounding hal'], ['Apply coupon']], 'file kind skipped, null skipped, text cut at 12 chars');
      assert.deepEqual((await vectors(g)).map((v) => v.id), ['n:1', 't:1']);
    });

    test('a failing model never fails the write; the failure is logged', async () => {
      const emb = fakeEmbedder();
      const log: string[] = [];
      const g = await h.open({ origin: 'rt', trusted: true, embedding: emb, log: (l) => log.push(l) });
      emb.fail = true;
      const n = await g.put({ id: 'n:1', kind: 'note', label: 'still stored' });
      assert.equal(n.version, 1);
      assert.equal((await g.get('n:1'))?.label, 'still stored');
      assert.deepEqual(await vectors(g), []);
      assert.equal(log.length, 1);
      assert.match(log[0], /embedding of 'n:1' v1 failed .*model is down/);
      // A wrong dimension is refused the same way.
      const bad = await h.open({ origin: 'rt', trusted: true, embedding: { dims: 3, embed: async (t) => t.map(() => [1, 2]) }, log: (l) => log.push(l) });
      await bad.put({ id: 'x', kind: 'k', label: 'x' });
      assert.match(log[1], /not 3 finite numbers/);
    });

    test('recall({ locate }) and match({ semantic }) find the nearest embedded node; kinds and asOf apply', async () => {
      const c = clock();
      const emb = fakeEmbedder();
      const g = await h.open({ origin: 'rt', trusted: true, now: c.now, embedding: emb });
      await g.put({ id: 'n:pricing', kind: 'note', label: 'rounding rule in the pricing service is half-up' });
      await g.put({ id: 'n:checkout', kind: 'note', label: 'coupon applied at checkout before tax' });
      await g.put({ id: 't:pricing', kind: 'ticket', label: 'pricing rounding' });
      await g.put({ id: 'f:1', kind: 'file', label: 'src/checkout.ts' });
      await g.link({ src: 'n:pricing', dst: 'f:1', rel: 'about' });
      c.tick();
      await g.put({ id: 'n:late', kind: 'note', label: 'pricing rounding half-up, again, later' });

      const m = await g.match({ semantic: 'half-up rounding in pricing', limit: 2 });
      assert.equal(m.length, 2);
      assert.deepEqual(m.map((n) => n.id).sort(), ['n:late', 'n:pricing'], 'the two pricing notes are the nearest');
      assert.ok(!m.some((n) => n.id === 'n:checkout'), 'the checkout note is not among the top two');
      const byKind = await g.match({ semantic: 'pricing rounding', kind: 'ticket' });
      assert.deepEqual(byKind.map((n) => n.id), ['t:pricing'], 'kind is pushed into the vector query');
      const filtered = await g.match({ semantic: 'pricing rounding', labelContains: 'checkout' });
      assert.deepEqual(filtered.map((n) => n.id).sort(), ['f:1', 'n:checkout'], 'the other criteria filter the ranked list (both labels contain checkout)');

      const r = await g.recall({ locate: 'pricing rounding', maxCost: 1, limit: 1 });
      assert.deepEqual(r.seedSources, [{ id: 't:pricing', via: 'locate' }], 'an exact label is the nearest of all');
      const live = await g.recall({ locate: 'pricing rounding half-up again later', maxCost: 1, limit: 1, includeSeeds: true });
      assert.deepEqual(live.seeds, ['n:late']);
      const early = await g.recall({ locate: 'pricing rounding half-up again later', maxCost: 1, limit: 1, asOf: c.t - 1, includeSeeds: true });
      assert.equal(early.seeds.length, 1);
      assert.notEqual(early.seeds[0], 'n:late', 'before n:late existed it cannot seed; the next nearest does');
      assert.deepEqual(emb.calls.slice(-6).map((x) => x.length), [1, 1, 1, 1, 1, 1], 'each query text is embedded once');
    });

    test('reembed rebuilds under a changed rule: new text, removed vectors, kinds/since selection', async () => {
      const c = clock();
      const base = fakeEmbedder();
      const g = await h.open({ origin: 'rt', trusted: true, now: c.now, embedding: base });
      await g.put({ id: 'n:1', kind: 'note', label: 'one', attrs: { text: 'alpha' } });
      c.tick();
      await g.put({ id: 'n:2', kind: 'note', label: 'two', attrs: { text: 'beta' } });
      await g.put({ id: 'f:1', kind: 'file', label: 'f.ts' });
      assert.equal((await vectors(g)).length, 3);

      // The rule changes: notes embed label+text, files are out.
      const changed = fakeEmbedder();
      const g2 = g.as('rt', { embedding: { ...changed, kinds: ['note'], text: (n) => `${n.label}: ${String(n.attrs.text)}` } });
      const r = await g2.reembed();
      assert.deepEqual(r, { embedded: 2, cleared: 1, skipped: 0 });
      assert.deepEqual(changed.calls, [['one: alpha', 'two: beta']], 'one batched model call');
      assert.deepEqual((await vectors(g2)).map((v) => v.id), ['n:1', 'n:2']);

      const since = await g2.reembed({ since: c.t });
      assert.deepEqual(since, { embedded: 1, cleared: 0, skipped: 1 }, 'n:2 and f:1 were recorded at c.t; the file is excluded by the rule and had no vector left');
      const kinds = await g2.reembed({ kinds: ['file'] });
      assert.deepEqual(kinds, { embedded: 0, cleared: 0, skipped: 1 }, 'files are excluded by the rule and had no vector left');

      // A failing model DOES fail reembed — the caller asked for the rebuild.
      changed.fail = true;
      await assert.rejects(g2.reembed(), /model is down/);
      // Without an embedding configured there is nothing to rebuild with.
      const plain = await h.open({ origin: 'rt', trusted: true });
      await assert.rejects(plain.reembed(), /no embedding configured/);
    });

    test('vectors are derived: not in a dump, rebuilt by reembed on the copy', async () => {
      const emb = fakeEmbedder();
      const g = await h.open({ origin: 'rt', privileged: true, embedding: emb });
      await g.put({ id: 'n:1', kind: 'note', label: 'rounding' });
      const dump = await g.dump();
      assert.deepEqual(Object.keys(dump).sort(), ['access', 'edges', 'nodeVersions', 'nodes', 'schemaVersion']);
      const copy = await h.open({ origin: 'ops', privileged: true, embedding: fakeEmbedder() });
      await copy.load(dump);
      assert.deepEqual(await vectors(copy), [], 'load moved rows, not vectors');
      assert.deepEqual(await copy.reembed(), { embedded: 1, cleared: 0, skipped: 0 });
      assert.deepEqual((await copy.match({ semantic: 'rounding' })).map((n) => n.id), ['n:1']);
    });
  });
}
